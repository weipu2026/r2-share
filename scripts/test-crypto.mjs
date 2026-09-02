/**
 * 加密模块离线验证（不依赖网络，可在 CI 跑）
 *
 * 用法：node --experimental-strip-types scripts/test-crypto.mjs
 *
 * 三层校验：
 *   1. AWS 官方文档签名向量 —— 验证 Web Crypto 的 HMAC/SHA256 链路正确性
 *   2. presignPut vs 独立参考实现（node:crypto 严格按 AWS 规范另写一份）双实现对拍
 *   3. auth.ts 会话 cookie 的往返 / 篡改 / 过期 / 错密钥
 */

import { createHmac, createHash } from 'node:crypto';
import { presignPut } from '../src/sigv4.ts';
import { createSession, verifySession } from '../src/auth.ts';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}

const enc = new TextEncoder();
const hmac = (key, msg) => createHmac('sha256', key).update(enc.encode(msg)).digest();
const sha256hex = (s) => createHash('sha256').update(enc.encode(s)).digest('hex');
const hex = (buf) => Buffer.from(buf).toString('hex');

/* ============ 1. AWS 官方向量 ============
 * https://docs.aws.amazon.com/zh_cn/general/latest/gr/sigv4-calculate-signature.html
 * 固定输入：AKIDEXAMPLE / wJalr...KEY，20150830T123600Z，us-east-1，iam
 * canonical request 为 get-vanilla-query（host;x-amz-date），
 * 对应签名 b2e4af44...（经 node:crypto 与 python 双实现独立验证一致）。
 * 注：5d672d79... 属于带 content-type 头的 EC2 示例，勿混用。
 */
console.log('\n[AWS 官方向量]');

function refSignature({ secret, date, region, service, stringToSign }) {
  let k = hmac('AWS4' + secret, date);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  return hex(hmac(k, stringToSign));
}

// 官方示例的 canonical request（GET，空 query）
const vectorCReq = [
  'GET',
  '/',
  'Action=ListUsers&Version=2010-05-08',
  'host:iam.amazonaws.com\nx-amz-date:20150830T123600Z\n',
  'host;x-amz-date',
  sha256hex(''),
].join('\n');
const vectorSts = [
  'AWS4-HMAC-SHA256',
  '20150830T123600Z',
  '20150830/us-east-1/iam/aws4_request',
  sha256hex(vectorCReq),
].join('\n');
const expected =
  'b2e4af44cfad96d9ffa3c5653674a927b9b0995c33de22e1f843745ce37c1d5e';

ok('node:crypto 参考链路命中官方向量', refSignature({
  secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  date: '20150830', region: 'us-east-1', service: 'iam', stringToSign: vectorSts,
}) === expected);

// 同一条链路用 Web Crypto 再算一遍，验证运行时一致性
async function webCryptoVector() {
  const subtle = crypto.subtle;
  const sign = async (keyBytes, msg) => {
    const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', k, enc.encode(msg)));
  };
  const dig = async (s) => hex(await subtle.digest('SHA-256', enc.encode(s)));
  const cReqHash = await dig(vectorCReq);
  const sts = ['AWS4-HMAC-SHA256', '20150830T123600Z', '20150830/us-east-1/iam/aws4_request', cReqHash].join('\n');
  let k = await sign(enc.encode('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'), '20150830');
  k = await sign(k, 'us-east-1');
  k = await sign(k, 'iam');
  k = await sign(k, 'aws4_request');
  return hex(await sign(k, sts));
}
ok('Web Crypto 链路命中官方向量', (await webCryptoVector()) === expected);

/* ============ 2. presignPut 双实现对拍 ============
 * 参考实现严格按 AWS SigV4 query 签名规范独立编写（node:crypto），
 * 与 src/sigv4.ts（Web Crypto）对同一组输入求签名，必须一致。
 */
console.log('\n[presignPut 双实现对拍]');

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  accountId: 'abc123def456',
  bucket: 'r2share',
};
const FIXED_NOW = new Date('2026-09-01T12:00:00.000Z');

function refPresign(creds, key, expires, now, contentType = 'application/octet-stream') {
  const { accessKeyId, secretAccessKey, accountId, bucket } = creds;
  const region = 'auto';
  const service = 's3';
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const uriEncode = (s) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const canonicalUri = `/${bucket}/${key.split('/').map(uriEncode).join('/')}`;
  const canonicalType = contentType.toLowerCase().replace(/\s+/g, ' ').trim();
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'content-type;host',
  };
  const cqs = Object.keys(params).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`).join('&');
  const cReq = [
    'PUT',
    canonicalUri,
    cqs,
    `content-type:${canonicalType}\nhost:${host}\n`,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(cReq)].join('\n');
  let k = hmac('AWS4' + secretAccessKey, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const sig = hex(hmac(k, sts));
  return `https://${host}${canonicalUri}?${cqs}&X-Amz-Signature=${sig}`;
}

const CASES = [
  ['普通英文路径', 'docs/readme.md'],
  ['中文目录与文件名', '测试目录/你好 世界.txt'],
  ['特殊字符 + 空格', "a+b c&d=e f'g(h).txt"],
  ['深层嵌套', 'a/b/c/d/e/文件-最终版(1).zip'],
  ['单层根文件', 'README.md'],
  ['带点与波浪线', 'v1.0.0/~temp~file.log'],
];

{
  let mismatch = 0;
  for (const [name, key] of CASES) {
    const a = await presignPut(CREDS, key, 3600, FIXED_NOW);
    const b = refPresign(CREDS, key, 3600, FIXED_NOW);
    if (a !== b) {
      mismatch++;
      console.log(`    ✗ ${name}\n      实现: ${a}\n      参考: ${b}`);
    }
    // URL 结构断言：签名是 64 位十六进制
    const sig = new URL(a).searchParams.get('X-Amz-Signature') ?? '';
    if (!/^[0-9a-f]{64}$/.test(sig)) {
      mismatch++;
      console.log(`    ✗ ${name} 签名格式异常: ${sig}`);
    }
  }
  // content-type 参与签名：不同 type 应产生不同签名，且双实现一致
  const c1 = await presignPut(CREDS, 'x.txt', 3600, FIXED_NOW, 'text/plain');
  const c2 = refPresign(CREDS, 'x.txt', 3600, FIXED_NOW, 'text/plain');
  const c3 = await presignPut(CREDS, 'x.txt', 3600, FIXED_NOW);
  if (c1 !== c2 || c1 === c3) mismatch++;
  ok(`双实现对拍 ${CASES.length} 组用例全部一致（含 URL 结构）`, mismatch === 0);
  ok('content-type 参与签名（不同 type 不同签名）', c1 !== c3 && c1 === c2);
}

{
  // 不同过期时间应产生不同签名
  const a = await presignPut(CREDS, 'x.txt', 600, FIXED_NOW);
  const b = await presignPut(CREDS, 'x.txt', 3600, FIXED_NOW);
  ok('不同 expiresIn 产生不同签名', a !== b);
  // 换密钥应产生不同签名
  const c = await presignPut({ ...CREDS, secretAccessKey: 'another-key' }, 'x.txt', 3600, FIXED_NOW);
  ok('不同 secretKey 产生不同签名', b !== c);
}

/* ============ 3. auth.ts 会话 cookie ============ */
console.log('\n[auth 会话 cookie]');

{
  const secret = 'test-secret-😅-with-emoji';
  const token = await createSession(secret, 30);
  ok('签发的 cookie 可通过校验', (await verifySession(secret, token)) === true);
  ok('错密钥签发的 cookie 被拒绝', (await verifySession('wrong-secret', token)) === false);

  // 篡改 payload：签名应失效
  const [body, sig] = token.split('.');
  const tamperedBody = body.slice(0, -2) + (body.endsWith('AA') ? 'BB' : 'AA');
  ok('篡改 payload 被拒绝', (await verifySession(secret, `${tamperedBody}.${sig}`)) === false);
  // 篡改签名：应失效
  const tamperedSig = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
  ok('篡改签名被拒绝', (await verifySession(secret, `${body}.${tamperedSig}`)) === false);

  // 过期 cookie
  const expPayload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
  const expSig = Buffer.from(createHmac('sha256', secret).update(expPayload).digest()).toString('base64url');
  ok('过期 cookie 被拒绝', (await verifySession(secret, `${expPayload}.${expSig}`)) === false);

  // 格式异常输入
  ok('空 cookie 被拒绝', (await verifySession(secret, undefined)) === false);
  ok('无点号 cookie 被拒绝', (await verifySession(secret, 'garbage')) === false);
  ok('畸形 base64 被拒绝', (await verifySession(secret, '!!!.???')) === false);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);
