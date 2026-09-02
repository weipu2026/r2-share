/**
 * AWS Signature Version 4 —— presigned URL 签名（零依赖，基于 Web Crypto）
 *
 * 用途：给浏览器签发一个有时效的 PUT URL，让文件数据直传 R2，
 * 不经过 Worker，因此不消耗 CPU、不占用带宽、不受 100MB 请求体限制。
 *
 * R2 的 S3 端点：https://<account_id>.r2.cloudflarestorage.com
 * R2 的 region 固定为 "auto"
 */

const encoder = new TextEncoder();

/** AWS 要求 RFC3986 编码：空格必须是 %20 而不是 +，部分字符不转义 */
function uriEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(
  key: Uint8Array | ArrayBuffer,
  msg: string
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(msg));
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return toHex(digest);
}

/** 生成形如 20260901T120000Z 的时间戳 */
function amzTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export interface PresignOptions {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucket: string;
}

/**
 * 签发一个 presigned PUT URL。
 *
 * 签名覆盖 host + content-type 两个头 —— R2 要求请求携带的每个头都必须在
 * SignedHeaders 中（与 AWS S3 不同，AWS 允许未签名的 Content-Type）。
 * 前端 PUT 时必须携带与签名时完全相同的 Content-Type。
 *
 * @param now 签名时间，生产环境省略即可；测试传入固定值以获得确定性输出
 * @param contentType PUT 请求将携带的 Content-Type（参与签名）
 */
export async function presignPut(
  opts: PresignOptions,
  key: string,
  expiresIn = 3600,
  now: Date = new Date(),
  contentType = 'application/octet-stream'
): Promise<string> {
  const { accessKeyId, secretAccessKey, accountId, bucket } = opts;
  const region = 'auto';
  const service = 's3';
  const host = `${accountId}.r2.cloudflarestorage.com`;

  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // key 要逐段编码，但保留 / 作为分隔符
  const canonicalUri = `/${bucket}/${key.split('/').map(uriEncode).join('/')}`;

  // SigV4 规范：头值折叠空白（连续空格→1 个）、首尾 trim、小写
  const canonicalType = contentType
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'content-type;host',
  };

  const canonicalQueryString = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&');

  // SigV4 规范：canonical headers 必须按头名 ASCII 排序（content-type < host）
  const signedHeaders = 'content-type;host';
  const canonicalHeaders = `content-type:${canonicalType}\nhost:${host}\n`;

  // 直传场景无法预知完整 body 哈希，S3 约定使用 UNSIGNED-PAYLOAD
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // 派生签名密钥
  let signingKey: Uint8Array = encoder.encode('AWS4' + secretAccessKey);
  for (const part of [dateStamp, region, service, 'aws4_request']) {
    signingKey = new Uint8Array(await hmacSha256(signingKey, part));
  }

  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}
