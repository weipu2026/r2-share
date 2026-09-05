/**
 * 灌入演示数据，方便本地查看页面效果
 * 用法：node scripts/seed.mjs [base_url]
 *
 * 演示素材是脚本现场生成的真实文件：
 * - PNG：内置编码器画一张渐变图（可真实预览）
 * - WAV：PCM 正弦波（可真实播放）
 * - 其余为占位内容
 */

import zlib from 'node:zlib';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PASSWORD = process.env.TEST_PASSWORD || 'dev123456';

let cookie = '';

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res;
}

const json = (p, body) =>
  req(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function upload(path, content, type) {
  const size = Buffer.byteLength(content);
  // 与前端契约一致：sign 需带 type，否则 presigned 直传会因签名不含 content-type 而 403
  const r = await json('/api/sign', { path, size, type });
  if (!r.ok) return console.log(`  签名失败 ${path}`);
  const { url } = await r.json();
  const put = await req(url, {
    method: 'PUT',
    headers: { 'content-type': type },
    body: content,
  });
  if (!put.ok) return console.log(`  上传失败 ${path}`);
  const c = await json('/api/commit', { path, size, type });
  console.log(c.ok ? `  ✓ ${path}` : `  ✗ 索引失败 ${path}`);
}

async function remove(path) {
  const r = await req('/api/file', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  console.log(r.ok ? `  ✓ 已删除旧文件 ${path}` : `  - 跳过 ${path}`);
}

/* ---------------- PNG 生成（真图片，可预览） ---------------- */

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** 生成一张 RGB 渐变 PNG（pixelFn 返回 [r,g,b]） */
function makePng(w, h, pixelFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩 RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- WAV 生成（真音频，可播放） ---------------- */

function makeWav(seconds = 1.5, freq = 523, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++)
    data[i] = 128 + Math.round(80 * Math.sin((2 * Math.PI * freq * i) / rate));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + n, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // 单声道
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36);
  h.writeUInt32LE(n, 40);
  return Buffer.concat([h, data]);
}

/* ---------------- 演示数据 ---------------- */

const README = `# 我的仓库

这是一个跑在 Cloudflare R2 上的轻量个人仓库，用于验证
\`Pages 静态 + R2 公开直链 + Worker 仅签名\` 这套零费用架构。

## 设计要点

- 下载走 R2 公开桶直链，**不经过 Worker**，出口流量免费
- 目录页是静态的，请求数无上限，被刷也不花钱
- 上传走 presigned 直传，文件数据不过 Worker

## 目录说明

| 目录 | 内容 |
| --- | --- |
| \`docs/\` | 文档与示例数据 |
| \`软件/\` | 安装包 |
| \`素材/\` | 图片音视频（真实可预览） |

> 所有文件的 URL 都是真实路径，将来换任何 S3 服务只改域名前缀即可。

- [x] 目录浏览
- [x] 前端搜索
- [x] 在线预览
- [ ] 网页端重命名
`;

const files = [
  ['README.md', README, 'text/markdown'],
  ['docs/readme.md', '# 文档目录\n\n这里放文档资料。\n\n- 项目一\n- 项目二\n', 'text/markdown'],
  ['docs/配置说明.json', JSON.stringify({ version: '1.0', r2: true, cdn: 'cloudflare' }, null, 2), 'application/json'],
  ['软件/安装包示例.exe', Buffer.from('MZ\x90\x00 fake executable bytes '.repeat(120)), 'application/vnd.microsoft.portable-executable'],
  ['软件/更新日志.txt', 'v1.0.0 首发\nv1.0.1 修复下载\nv1.1.0 新增搜索\nv1.2.0 新增预览\n', 'text/plain'],
  // 真实可预览的图片与音频
  ['素材/背景图.png', makePng(360, 220, (x, y) => [
    Math.round((x / 360) * 255),
    Math.round((y / 220) * 255),
    150,
  ]), 'image/png'],
  ['素材/色块.png', makePng(120, 120, (x, y) => [
    (x * y) % 256,
    (x + y) % 256,
    (x ^ y) % 256,
  ]), 'image/png'],
  ['素材/背景音乐.wav', makeWav(1.5, 523), 'audio/wav'],
  ['素材/打包下载.zip', Buffer.from('ZIP fake archive '.repeat(600)), 'application/zip'],
];

async function main() {
  const login = await json('/api/login', { password: PASSWORD });
  if (!login.ok) {
    console.error('登录失败，请检查 .dev.vars 里的 ADMIN_PASSWORD');
    process.exit(1);
  }
  console.log('登录成功。');

  console.log('\n清理历史版本遗留文件：');
  await remove('素材/背景音乐.mp3'); // 旧版 seed 用的是假 mp3

  console.log('\n灌入演示数据：');
  for (const [p, c, t] of files) await upload(p, c, t);
  console.log('\n完成，访问 ' + BASE + ' 查看效果');
}

main();
