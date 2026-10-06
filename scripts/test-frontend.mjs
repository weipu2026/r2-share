/**
 * 前端状态逻辑单测（不依赖浏览器）
 *
 * 用法：node scripts/test-frontend.mjs
 *
 * 做法与 test-preview.mjs 一致：读 public/app.js 原文，截掉末尾需要真实 DOM
 * 的启动代码，在 Node 里求值，再喂一个最小 DOM 替身来驱动状态逻辑。
 *
 * 覆盖三类：
 *   1. 行为 —— resetSel / applyIndexEntries / dropIndexPaths / kindOf
 *   2. 契约 —— 关键链路的调用方式（防回归：改回旧写法会翻红）
 *   3. 路由 —— wrangler.toml 的首页必须显式走 Worker
 *
 * 第 2 类是「源码契约」而非行为测试：它拦的是「有人不小心把修复改回去」，
 * 不保证这些代码在浏览器里真的跑得对（那部分靠人工与冒烟覆盖）。
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// 末尾的 bindEvents()/loadIndex() 需要真实 DOM，截断即可
const body = src.replace(/^bindEvents\(\);[\s\S]*$/m, '');

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      期望 ${e} / 实际 ${a}`);
  }
}
const group = (t) => console.log(`\n[${t}]`);

/* ---------------- 最小 DOM 替身 ---------------- */

function makeEl() {
  const cls = new Set();
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    dataset: {},
    style: {},
    children: [],
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !cls.has(c) : !!on;
        if (want) cls.add(c);
        else cls.delete(c);
        return want;
      },
    },
    appendChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/** getElementById 对任意 id 都返回一个元素：render() 会摸到很多节点 */
function makeDocument() {
  const els = new Map();
  // 记录 body 上注册的监听器：便于直接驱动 bindRowEvents 做分支判定
  const listeners = { click: [], change: [] };
  const body = makeEl();
  body.addEventListener = (type, fn) => {
    (listeners[type] || (listeners[type] = [])).push(fn);
  };
  return {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl());
      return els.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
    body,
    __listeners: listeners,
  };
}

/** 每个用例加载一份全新的模块实例，互不串状态 */
function load() {
  const fn = new Function(
    'window',
    'document',
    `${body}
return { state, resetSel, applyIndexEntries, dropIndexPaths, kindOf, updateBatch, chunk, UPLOAD_CHUNK, DELETE_CHUNK, bindRowEvents, __doc: document };`
  );
  return fn(
    { __CFG__: { dlDomain: 'https://dl.example.com', isLogin: true } },
    makeDocument()
  );
}

const entry = (p, s = 1) => ({ p, s, t: 1, c: 'text/plain' });

/* ---------------- 行为 ---------------- */

group('批量选择：切换视图时必须清空');
{
  const api = load();
  api.state.sel.add('a.txt');
  api.state.sel.add('b.txt');
  eq('选择集先有 2 项', api.state.sel.size, 2);
  api.resetSel();
  eq('resetSel 清空已选集合', api.state.sel.size, 0);
  api.resetSel();
  eq('选择集为空时调用是安全的', api.state.sel.size, 0);
}

group('本地索引：增量追加与替换');
{
  const api = load();
  api.state.index = [entry('a.txt'), entry('d/'), entry('d/x.txt')];
  api.applyIndexEntries([entry('b.txt')]);
  eq('新路径追加进索引', api.state.index.length, 4);
  api.applyIndexEntries([{ p: 'a.txt', s: 99, t: 9, c: 'text/plain' }]);
  eq('同路径是替换不是追加', api.state.index.length, 4);
  eq('替换后的值生效', api.state.index.find((f) => f.p === 'a.txt').s, 99);
  api.applyIndexEntries([null, { x: 1 }, 'junk', 42]);
  eq('脏数据被忽略而不是写坏索引', api.state.index.length, 4);
  api.applyIndexEntries([]);
  eq('空数组是安全的', api.state.index.length, 4);
}

group('本地索引：删除时按路径与前缀移除');
{
  const api = load();
  api.state.index = [entry('a.txt'), entry('d/'), entry('d/x.txt'), entry('d/sub/y.txt'), entry('e.txt')];
  api.dropIndexPaths(['a.txt']);
  eq('删除文件只移除该条', api.state.index.some((f) => f.p === 'a.txt'), false);
  eq('其他条目不受影响', api.state.index.length, 4);
  api.dropIndexPaths(['d']);
  eq('删除目录按前缀一并清空', api.state.index.length, 1);
  eq('保留目录外的条目', api.state.index[0].p, 'e.txt');
  api.dropIndexPaths([]);
  eq('空路径数组是安全的', api.state.index.length, 1);
}

group('本地索引：删除多级目录与深层祖先');
{
  const api = load();
  api.state.index = [
    entry('a.txt'),
    entry('d/'),
    entry('d/x.txt'),
    entry('dd.txt'),
    entry('d/sub/'),
    entry('d/sub/y.txt'),
    entry('d/sub/deep/z.txt'),
    entry('e.txt'),
  ];
  // 关键回归：'dd.txt' 不能被当成 'd' 的前缀命中（拼 p + '/' 才天然避开）
  api.dropIndexPaths(['d/sub']);
  eq('多级路径只删该子树', api.state.index.map((f) => f.p), [
    'a.txt',
    'd/',
    'd/x.txt',
    'dd.txt',
    'e.txt',
  ]);
  eq('更深的条目也被祖先前缀命中', api.state.index.some((f) => f.p.startsWith('d/sub/')), false);

  // 祖先在列表里、子孙在更深处：删中间层要连带整棵子树
  const api2 = load();
  api2.state.index = [
    entry('x/'),
    entry('x/a/'),
    entry('x/a/b/'),
    entry('x/a/b/c.txt'),
    entry('y.txt'),
  ];
  api2.dropIndexPaths(['x/a']);
  eq('删中间层目录连带整棵子树', api2.state.index.map((f) => f.p), ['x/', 'y.txt']);

  // 不存在的路径：不该动任何东西
  api2.dropIndexPaths(['nope/deep']);
  eq('删除不存在的路径是安全的', api2.state.index.map((f) => f.p), ['x/', 'y.txt']);
}

group('chunk：分批切片的边界');
{
  const api = load();
  eq('空数组切成 0 块', api.chunk([], 2).length, 0);
  eq('正好整除', api.chunk([1, 2, 3, 4], 2).map((a) => a.length), [2, 2]);
  eq('有余数时最后一块较短', api.chunk([1, 2, 3], 2).map((a) => a.length), [2, 1]);
  eq('不足一块时只切一块', api.chunk([1], 400).length, 1);
  eq('size 非正数时原样返回一块', api.chunk([1, 2, 3], 0).map((a) => a.length), [3]);
  eq('切片顺序与内容不变', api.chunk([1, 2, 3], 2), [[1, 2], [3]]);
}

group('kindOf：走查表后行为不变');
{
  const api = load();
  eq('图片', api.kindOf('a.png', false), 'image');
  eq('压缩包', api.kindOf('a.zip', false), 'zip');
  eq('目录优先于扩展名', api.kindOf('a.png', true), 'dir');
  eq('大写扩展名同样识别', api.kindOf('A.PNG', false), 'image');
  eq('带目录的名字取最后一段扩展名', api.kindOf('a.b/c.zip', false), 'zip');
  eq('无扩展名回退为 file', api.kindOf('Makefile', false), 'file');
  eq('未收录的扩展名回退为 file', api.kindOf('a.zzz', false), 'file');
}

/* ---------------- 事件委托：网格视图的删除按钮 ---------------- */

/**
 * 极简 DOM 节点替身：只实现事件委托用到的 closest / dataset / classList。
 * 用 parent 串出祖先链，用来复现「data-dir 挂在整个 .cell 上、删除按钮是其后代」
 * 这一网格视图结构（列表视图里两者是兄弟节点，不会踩到）。
 */
function fakeNode({ classes = [], data = {}, parent = null } = {}) {
  const node = {
    classes,
    dataset: { ...data },
    parent,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  node.closest = (sel) => {
    let n = node;
    while (n) {
      if (matchesSel(n, sel)) return n;
      n = n.parent;
    }
    return null;
  };
  return node;
}

/** 只支持测试里用到的那几种选择器：.cls、[data-x]、.cls[data-x] */
function matchesSel(node, sel) {
  const m = sel.match(/^(\.[\w-]+)?(\[data-[\w-]+\])?$/);
  if (!m || (!m[1] && !m[2])) return false;
  if (m[1] && !node.classes.includes(m[1].slice(1))) return false;
  if (m[2]) {
    const key = m[2].slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in node.dataset)) return false;
  }
  return true;
}

group('事件委托：网格视图点「删除目录」不能误进该目录');
{
  const api = load();
  api.state.cur = '';
  api.state.index = [];
  api.bindRowEvents();
  const onClick = api.__doc.__listeners.click[0];
  eq('click 监听器已注册', typeof onClick, 'function');

  // .cell[data-dir] > .cell-actions > button[data-deldir]
  const cell = fakeNode({ classes: ['cell'], data: { dir: 'docs' } });
  const actions = fakeNode({ classes: ['cell-actions'], parent: cell });
  const btn = fakeNode({ data: { deldir: 'docs' }, parent: actions });

  onClick({ target: btn, preventDefault() {} });

  // 反向：不能把祖先 .cell 的 data-dir 当成「进入目录」
  eq('点击删除按钮后仍停留在原目录', api.state.cur, '');
  // 正向：必须真的走到了删除分支（否则「什么都不做」也能让上一行为真）
  eq('确实弹出了「删除目录」确认框', api.__doc.getElementById('dlg-title').textContent, '删除目录');
}

/* ---------------- 源码契约（防回归） ---------------- */

group('源码契约：关键链路的调用方式');
const has = (re) => re.test(src);
/**
 * 取出某个函数的函数体。
 * 匹配不到就抛错 —— 返回空串会让「不含某字符串」这类**负向断言恒真**（假绿）：
 * 函数一旦改名、改成箭头函数、或换一种书写风格，断言会静默失效而不是失败。
 */
const fnBody = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`fnBody：在 app.js 里找不到 function ${name}（相关断言已失效，请同步测试）`);
  return m[0];
};

eq('点目录时重置批量选择', has(/state\.cur = dirEl\.dataset\.dir;\s*\r?\n\s*resetSel\(\);/), true);
eq('面包屑切目录时重置批量选择', has(/state\.cur = a\.dataset\.p;\s*\r?\n\s*resetSel\(\);/), true);
eq('切换搜索时重置批量选择', has(/state\.searchMode = !!v;\s*\r?\n\s*resetSel\(\);/), true);
eq('上传批次内固定目标目录（快照 baseDir）', has(/const baseDir = state\.cur;/), true);
eq('批量下载不再用 window.open（会被弹窗拦截）', fnBody('batchDownload').replace(/\/\/[^\n]*/g, '').includes('window.open'), false);
eq('批量下载改触发 <a download>', fnBody('batchDownload').includes('a.download'), true);
eq('网格缩略图受 THUMB_MAX 约束', has(/kind === 'image' && \(f\.s \|\| 0\) <= THUMB_MAX/), true);
eq('上传走分批批量签名', has(/for \(const part of chunk\(jobs, UPLOAD_CHUNK\)\)/), true);
eq('上传走分批批量提交索引', has(/for \(const part of chunk\(done, UPLOAD_CHUNK\)\)/), true);
eq('每批的 entries 由 part 组装（不再是整批 jobs/done）', has(/entries: part\.map\(/), true);
{
  // 前后端必须成对改：只改服务端不改前端 → 大批判上传必被 413；
  // 只改前端不改服务端 → 白分片。这里直接读 src/index.ts 的常量交叉校验。
  const idxSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const m = idxSrc.match(/const MAX_COMMIT_BATCH = (\d+);/);
  const limit = m ? Number(m[1]) : NaN;
  const apiC = load();
  eq('能从 src/index.ts 读到 MAX_COMMIT_BATCH', Number.isFinite(limit), true);
  eq('前端 UPLOAD_CHUNK 不超过服务端 MAX_COMMIT_BATCH', apiC.UPLOAD_CHUNK <= limit, true);
  eq('服务端为「N 条 head + 索引读 + 索引写」留了子请求余量', limit + 2 <= 1000, true);
}
eq('上传后不再整份重拉索引', fnBody('runBatchUpload').includes('loadIndex'), false);
eq('批量删除走 /api/files 合并成批', has(/fetch\('\/api\/files'/), true);
eq('批量删除按 DELETE_CHUNK 分批', has(/for \(const part of chunk\(paths, DELETE_CHUNK\)\)/), true);
eq('批量删除不再整批发一次（body 用 part，不是 paths）', fnBody('batchDelete').includes('JSON.stringify({ paths })'), false);
{
  // 与上传同一套交叉校验：服务端 MAX_DELETE_BATCH 是硬上限，前端分批必须不大于它。
  // 只改服务端不改前端 → 上千个文件全选后整批发过去被 413 拒掉，一个都删不掉。
  const idxSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const m = idxSrc.match(/const MAX_DELETE_BATCH = (\d+);/);
  const limit = m ? Number(m[1]) : NaN;
  const apiC = load();
  eq('能从 src/index.ts 读到 MAX_DELETE_BATCH', Number.isFinite(limit), true);
  eq('前端 DELETE_CHUNK 不超过服务端 MAX_DELETE_BATCH', apiC.DELETE_CHUNK <= limit, true);
}
eq('单个删除改为本地增量', fnBody('deleteOne').includes('dropIndexPaths'), true);
eq('未登录仍不渲染选择框', has(/CFG\.isLogin\s*\?[\s\S]{0,80}class="sel"/), true);
eq('dropIndexPaths 不再对每个条目遍历一遍 paths（O(N×M)）', /\.some\(/.test(fnBody('dropIndexPaths')), false);
eq('dropIndexPaths 改用祖先集合 + 逐级回退', fnBody('dropIndexPaths').includes('lastIndexOf'), true);
eq('批量下载保留 <a download> 触发方式', fnBody('batchDownload').includes('a.download'), true);
eq('批量下载先剔掉无效链接（#）', fnBody('batchDownload').includes("u !== '#'"), true);
eq('网格点击不再无条件打开链接', has(/if \(url && url !== '#'\) window\.open\(url, '_blank'\);/), true);
eq('批量删除失败时不清空选择（旧写法已移除）', has(/state\.sel\.clear\(\);\s*updateBatch\(\);\s*if \(res\.ok\)/), false);
eq('批量删除只在成功批次里移出选中项', fnBody('batchDelete').includes('for (const p of part) state.sel.delete(p);'), true);
eq('批量删除对同一原因的失败只提示一次（避免 N 条相同 toast）',
  fnBody('batchDelete').includes('if (!notifiedErrors.has(msg))'), true);
eq('批量删除的失败去重是按错误信息、不是按批次（不同原因仍各自可见）',
  fnBody('batchDelete').includes('notifiedErrors.add(msg);'), true);

group('部署配置：首页必须显式走 Worker');
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
eq(
  'run_worker_first 显式包含 "/"',
  /run_worker_first\s*=\s*\[[^\]]*"\/"/.test(toml),
  true
);
eq('wrangler.toml 不再绑定 KV', /\[\[kv_namespaces\]\]/.test(toml), false);

group('CI：部署前必须跑测试');
{
  const wf = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  eq('deploy.yml 里有一条 npm test 步骤', /^\s*run:\s*npm test\s*$/m.test(wf), true);
  const iTest = wf.indexOf('run: npm test');
  const iDeploy = wf.indexOf('run: npm run deploy');
  eq('测试步骤落在 Deploy 之前（失败即中止，不会部署）', iTest > -1 && iDeploy > -1 && iTest < iDeploy, true);

  // secrets 只能经 env: 传入，绝不能直插 run: 脚本体：
  // 口令含 " 会让引号不配对（部署中止），含 $(...) / 反引号则在 runner 上执行任意命令，
  // 而 runner 的 env 里就有 CLOUDFLARE_API_TOKEN。
  eq(
    'secrets 不再直插 run: 脚本（need/put 的参数已改为 env 变量）',
    /(?:need|put)\s+\w+\s+"\$\{\{\s*secrets\./.test(wf),
    false
  );
  eq('Sync secrets 步骤经 env 传入 ADMIN_PASSWORD', /^\s*ADMIN_PASSWORD: \$\{\{ secrets\.ADMIN_PASSWORD \}\}$/m.test(wf), true);
}

/* ---------------- 本轮修复的行为契约（防回归） ---------------- */

group('README / 预览的请求令牌');
{
  const fb = fnBody('renderReadme');
  const iSeq = fb.indexOf('++readmeSeq');
  // 参照点用「if (!hit) {」而不是「第一个 return;」——函数开头的 `if (!box) return;`
  // 也在令牌之前，拿它当参照这条断言永远为真，就失去了判别力。
  const iHit = fb.indexOf('if (!hit) {');
  // 令牌若落在「无 README 直接 return」之后，切到没有 README 的目录时令牌不推进，
  // 上一个目录的 README 就会被渲染进当前目录。
  eq('README 令牌在「无 README 提前 return」之前推进', iSeq > -1 && iHit > -1 && iSeq < iHit, true);
  eq('README 响应回来时校验令牌', fb.includes('seq !== readmeSeq'), true);
}
{
  const fb = fnBody('renderTextPreview');
  eq('文本预览在发起请求前先取号', fb.includes('++pvSeq'), true);
  eq('文本预览的成功分支校验令牌（过期响应丢弃）', fb.includes('seq !== pvSeq'), true);
  eq('文本预览的失败分支同样校验令牌（不覆盖新内容）',
    fb.split('seq !== pvSeq').length - 1 >= 2, true);
}

group('网络异常不再变成 unhandled rejection');
{
  const fb = fnBody('apiDel');
  eq('apiDel 内部捕获网络异常并返回 res: null', fb.includes('res: null'), true);
  eq('deleteOne 对网络失败给出提示', fnBody('deleteOne').includes('if (!res) return toast('), true);
  eq('deleteDir 对网络失败给出提示', fnBody('deleteDir').includes('if (!res) return toast('), true);
  eq('登录请求包了 try/catch', /try \{\s*\r?\n\s*res = await fetch\('\/api\/login'/.test(src), true);
  eq('登出请求包了 try/catch', /try \{\s*\r?\n\s*await fetch\('\/api\/logout'/.test(src), true);
  eq('新建目录请求包了 try/catch', /try \{\s*\r?\n\s*res = await fetch\('\/api\/mkdir'/.test(src), true);
}

group('批量复制链接');
{
  const fb = fnBody('batchCopy');
  eq("批量复制先剔掉未配置域时的 '#'（与批量下载同口径）", fb.includes("u !== '#'"), true);
  eq('批量复制按过滤后的条数提示', fb.includes('urls.length'), true);
}

group('测试工具自身：fnBody 不再静默失效');
{
  let threw = false;
  try { fnBody('thisFunctionNameDoesNotExist'); } catch { threw = true; }
  eq('fnBody 对不存在的函数抛错（而非返回空串让负向断言恒真）', threw, true);
}

group('部署脚本与视图');
{
  const cd = readFileSync(new URL('./check-deploy.mjs', import.meta.url), 'utf8');
  eq('MAX_UPLOAD 检查锚定行首（与其它键同口径，不会读到注释行）', /toml\.match\(\/\^MAX_UPLOAD/.test(cd), true);
  eq('CORS 占位符告警不再自称「不阻断」（文案与 err() 行为一致）', cd.includes('所以这里不阻断'), false);

  const gc = readFileSync(new URL('./gen-config.mjs', import.meta.url), 'utf8');
  const seg = (gc.match(/let bucketName = [\s\S]*?\n\}/) || [''])[0];
  eq('桶名非法时不再静默回退（改走 err 中止）', seg.includes('err('), true);
  eq('桶名非法时不再把 bucketName 覆盖成默认值', /bucketName = 'r2share'/.test(seg), false);

  const sm = readFileSync(new URL('./smoke.mjs', import.meta.url), 'utf8');
  // ⚠️ 不能写成 sm.includes('--allow-remote')：文件的注释与错误提示里都有这个词，
  //    守卫被删掉断言照样为真（实测踩到）。必须落在「谁决定 ALLOW_REMOTE」这个赋值上。
  eq(
    '冒烟测试有 host 守卫（非本机地址需显式 --allow-remote）',
    /ALLOW_REMOTE = ARGS\.includes\('--allow-remote'\);/.test(sm),
    true
  );
  eq('冒烟测试优先从 .dev.vars 取口令（与 gen-config 同源）', sm.includes("'../.dev.vars'"), true);
  eq('冒烟测试的清理抽成函数并在 finally 兜底', sm.includes('cleanupSmokeFiles()') && /\.finally\(/.test(sm), true);
  eq('冒烟测试不再拿索引长度当重建基线', sm.includes('rb.files === baseline'), false);

  const sig = readFileSync(new URL('../src/sigv4.ts', import.meta.url), 'utf8');
  const block = (sig.match(/const canonicalType = [\s\S]*?;/) || [''])[0];
  eq('SigV4 的 canonical Content-Type 不对值做 toLowerCase', block.includes('toLowerCase'), false);
  eq('SigV4 仍折叠空白并 trim', block.includes("replace(/\\s+/g, ' ')") && block.includes('.trim()'), true);

  const views = readFileSync(new URL('../src/views.ts', import.meta.url), 'utf8');
  eq('首页脚本标签带 defer', /<script src="\/app\.js" defer><\/script>/.test(views), true);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
