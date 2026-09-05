/**
 * 前端纯函数单测：预览分类 / 文本判定 / 粘贴重命名
 *
 * 做法：读 public/app.js 原文，截掉末尾依赖真实 DOM 的启动代码，
 * 在 Node 里求值后取出纯函数断言——不为测试改动任何浏览器代码。
 * 用法：node scripts/test-preview.mjs
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// 末尾的 bindEvents()/loadIndex() 需要真实 DOM，截断即可
const body = src.replace(/^bindEvents\(\);[\s\S]*$/m, '');

const noop = new Proxy({}, { get: () => () => {} });
const load = new Function(
  'window',
  'document',
  `${body}\nreturn { previewKind, previewable, isTextLike, kindOf, renamePasted, walkEntry, fmtSize };`
);
const { previewKind, previewable, renamePasted, walkEntry } = load(
  { __CFG__: { dlDomain: 'https://dl.example.com', isLogin: true } },
  noop
);

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}  实际 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);
  }
}
function group(t) {
  console.log(`\n[${t}]`);
}

/** 构造一个索引条目：p 路径、s 大小、c MIME */
const f = (name, size = 1024, ctype = '') => ({ p: name, name, s: size, c: ctype });

group('预览分类 —— 多媒体');
eq('JPG → image', previewKind(f('a.jpg')), 'image');
eq('PNG → image', previewKind(f('a.png')), 'image');
eq('MP4 → video', previewKind(f('a.mp4')), 'video');
eq('MP3 → audio', previewKind(f('a.mp3')), 'audio');

group('预览分类 —— PDF');
eq('PDF → pdf', previewKind(f('手册.pdf')), 'pdf');
eq('PDF 大写扩展名 → pdf', previewKind(f('A.PDF')), 'pdf');
eq('PDF 超大仍可预览（iframe 不占前端内存）', previewKind(f('big.pdf', 90 * 1024 * 1024)), 'pdf');

group('预览分类 —— 代码与文本');
eq('JS → text', previewKind(f('a.js')), 'text');
eq('TS → text', previewKind(f('a.ts')), 'text');
eq('JSON → text', previewKind(f('a.json')), 'text');
eq('HTML → text', previewKind(f('a.html')), 'text');
eq('CSS → text', previewKind(f('a.css')), 'text');
eq('PY → text', previewKind(f('a.py')), 'text');
eq('GO → text', previewKind(f('a.go')), 'text');
eq('JAVA → text', previewKind(f('a.java')), 'text');
eq('YAML → text', previewKind(f('a.yml')), 'text');
eq('MD → text', previewKind(f('a.md')), 'text');
eq('TXT → text', previewKind(f('a.txt')), 'text');
eq('LOG → text（code 之外，靠白名单）', previewKind(f('a.log')), 'text');
eq('CSV → text', previewKind(f('a.csv')), 'text');
eq('SQL → text', previewKind(f('a.sql')), 'text');
eq('无扩展名 + text/plain MIME → text', previewKind(f('DATA', 100, 'text/plain')), 'text');
eq('无扩展名 + 二进制 MIME → null', previewKind(f('DATA', 100, 'application/octet-stream')), null);
eq('文本超 2MB → null（改为下载）', previewKind(f('big.txt', 3 * 1024 * 1024)), null);
eq('文本 1MB → text', previewKind(f('ok.txt', 1024 * 1024)), 'text');

group('预览分类 —— Office 与不可预览');
eq('DOCX → office', previewKind(f('a.docx')), 'office');
eq('DOC → office', previewKind(f('a.doc')), 'office');
eq('XLSX → office', previewKind(f('a.xlsx')), 'office');
eq('PPTX → office', previewKind(f('a.pptx')), 'office');
eq('ZIP → null', previewKind(f('a.zip')), null);
eq('RAR → null', previewKind(f('a.rar')), null);
eq('EPUB → null（浏览器无原生渲染）', previewKind(f('a.epub')), null);
eq('MOBI → null', previewKind(f('a.mobi')), null);
eq('未知扩展名 → null', previewKind(f('a.abcdefg')), null);

group('previewable 开关');
eq('可预览文件返回 true', previewable(f('a.pdf')), true);
eq('不可预览文件返回 false', previewable(f('a.zip')), false);

group('粘贴重命名');
const shot = new File(['x'], 'image.png', { type: 'image/png' });
eq('截图默认名改为时间戳', /^截图-\d{8}-\d{6}\.png$/.test(renamePasted(shot).name), true);
eq('截图保留 MIME', renamePasted(shot).type, 'image/png');
eq('真实文件名不改', renamePasted(new File(['x'], 'report.pdf')).name, 'report.pdf');
eq('image.png 之外的名字不改', renamePasted(new File(['x'], 'photo.png')).name, 'photo.png');

/* ---- 文件夹拖拽：递归展开 ----
 * 浏览器真实 API 是 FileSystemEntry，这里按契约 mock 一个最小实现：
 * 重点覆盖 readEntries「每次最多返回 100 项」这个经典坑。 */

function mkEntry(name, isDir, children = []) {
  return {
    name,
    isFile: !isDir,
    isDirectory: isDir,
    file(cb) {
      cb(new File(['x'], name));
    },
    createReader() {
      let sent = 0;
      return {
        readEntries(cb) {
          const batch = children.slice(sent, sent + 100);
          sent += batch.length;
          cb(batch); // 读完时返回空数组，与浏览器一致
        },
      };
    },
  };
}

async function collect(entry) {
  const out = [];
  await walkEntry(entry, '', out);
  return out.map((x) => x.path);
}

group('文件夹递归 —— walkEntry');
eq('单个文件', (await collect(mkEntry('a.txt', false))).join(), 'a.txt');

const tree = mkEntry('照片', true, [
  mkEntry('2026', true, [mkEntry('1.jpg', false), mkEntry('2.jpg', false)]),
  mkEntry('readme.txt', false),
]);
eq(
  '嵌套目录保留层级',
  (await collect(tree)).join(),
  '照片/2026/1.jpg,照片/2026/2.jpg,照片/readme.txt'
);

const many = Array.from({ length: 250 }, (_, i) => mkEntry(`f${i}.txt`, false));
const bigPaths = await collect(mkEntry('big', true, many));
eq('readEntries 分批：250 个文件全部读完', bigPaths.length, 250);
eq('分批读取顺序正确（首项）', bigPaths[0], 'big/f0.txt');
eq('分批读取顺序正确（末项）', bigPaths[249], 'big/f249.txt');

const deep = mkEntry('a', true, [mkEntry('b', true, [mkEntry('c', true, [mkEntry('d.txt', false)])])]);
eq('三层深目录', (await collect(deep)).join(), 'a/b/c/d.txt');
eq('空目录返回空', (await collect(mkEntry('empty', true, []))).length, 0);

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
