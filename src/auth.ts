/**
 * 登录态：HMAC-SHA256 签名的无状态 cookie（零依赖，基于 Web Crypto）
 *
 * cookie 格式：<base64url(payload)>.<base64url(签名)>
 * payload 内含过期时间，服务端不需要存任何会话数据。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE = 'r2share_session';

function b64urlEncode(input: string | ArrayBuffer): string {
  let bin: string;
  if (typeof input === 'string') {
    const bytes = encoder.encode(input);
    bin = String.fromCharCode(...bytes);
  } else {
    bin = String.fromCharCode(...new Uint8Array(input));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToString(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return decoder.decode(bytes);
}

/** 常量时间字符串比较，避免通过响应时间侧信道猜测口令 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return b64urlEncode(sig);
}

/** 校验口令是否正确（常量时间比较） */
export async function checkPassword(
  input: string,
  expected: string
): Promise<boolean> {
  // 先各自算一次摘要再比较，避免长度差异泄漏信息
  const a = await sha256Hex(input);
  const b = await sha256Hex(expected);
  return timingSafeEqual(a, b);
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 签发一个会话 cookie 值 */
export async function createSession(
  secret: string,
  days: number
): Promise<string> {
  const payload = JSON.stringify({
    exp: Date.now() + days * 86400_000,
  });
  const body = b64urlEncode(payload);
  const sig = await sign(secret, body);
  return `${body}.${sig}`;
}

/** 校验会话 cookie 是否有效且未过期 */
export async function verifySession(
  secret: string,
  cookie: string | undefined
): Promise<boolean> {
  if (!cookie) return false;
  const dot = cookie.indexOf('.');
  if (dot < 1) return false;

  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = await sign(secret, body);
  if (!timingSafeEqual(sig, expected)) return false;

  try {
    const { exp } = JSON.parse(b64urlDecodeToString(body)) as { exp: number };
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}
