/**
 * 本地冒烟测试：验证登录、路径校验、上传、索引、批量接口、下载、删除全流程
 * 用法：node scripts/smoke.mjs [base_url] [--allow-remote]
 */

import { readFileSync } from 'node:fs';

const ARGS = process.argv.slice(2);
const ALLOW_REMOTE = ARGS.includes('--allow-remote');
const BASE = ARGS.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:8787';

/**
 * host 守卫：本脚本会调用 /api/refresh **全量重写索引**、并真的删除文件，
 * 因此默认只允许指向本机实例。误把生产 URL 传进来会直接改坏线上数据。
 */
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(BASE) && !ALLOW_REMOTE) {
  console.error(
    `\n拒绝执行：${BASE} 不是本机地址。\n` +
      '  本脚本会重建索引并删除文件，只应指向本地 wrangler dev 实例。\n' +
      '  确实要指向远程实例时，显式加 --allow-remote，并确认那是可以随便改的测试实例。\n'
  );
  process.exit(1);
}

/**
 * 口令解析顺序：环境变量 → .dev.vars → dev123456。
 * gen-config 是从 .dev.vars 取口令生成配置的；smoke 若不读同一个来源，直接跑
 * `npm run smoke` 会拿着与站点不同的口令，首个断言即 401、后续全线崩。
 */
function resolvePassword() {
  if (process.env.TEST_PASSWORD) return process.env.TEST_PASSWORD;
  try {
    const dev = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const m = dev.match(/^ADMIN_PASSWORD\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  } catch {
    /* 没有 .dev.vars 就用默认口令（对已部署实例可用 TEST_PASSWORD 覆盖） */
  }
  return 'dev123456';
}

const PASSWORD = resolvePassword();

let cookie = '';
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
  // 与前端 app.js 的契约一致：sign 必须带 type（SigV4 签名覆盖 content-type），
  // 否则 presigned 直传模式下 PUT 带真实 type 会与签名的 octet-stream 不匹配 → 403
  const signRes = await json('/api/sign', { path, size: content.length, type });
  if (!signRes.ok) return { ok: false, error: '签名失败 ' + signRes.status };
  const { url } = await signRes.json();

  const putRes = await req(url, {
    method: 'PUT',
    headers: { 'content-type': type },
    body: content,
  });
  if (!putRes.ok) return { ok: false, error: '上传失败 ' + putRes.status };

  const commitRes = await json('/api/commit', {
    path,
    size: content.length,
    type,
  });
  if (!commitRes.ok) return { ok: false, error: '索引写入失败 ' + commitRes.status };
  return { ok: true };
}

/** 测试写入的 4 个文件（路径 / 内容 / MIME），与批量路径一起构成本脚本的清理范围 */
const FILES = [
  ['_smoke/你好.txt', 'hello world', 'text/plain'],
  ['_smoke/说明.md', '# 标题\n\n这是 **粗体** 和 `代码`。\n\n- 项目一\n- 项目二\n', 'text/markdown'],
  ['_smoke/data.json', JSON.stringify({ a: 1, b: [1, 2, 3] }), 'application/json'],
  ['_smoke/文档.pdf', '%PDF-1.4 fake pdf content', 'application/pdf'],
];

/** 批量上传链路用到的 3 个路径 */
const BATCH_PATHS = ['_smoke/b1.txt', '_smoke/b2.txt', '_smoke/b3.txt'];

/** 本脚本会在桶里创建的**全部** key，供清理使用 */
const SMOKE_PATHS = [...FILES.map(([p]) => p), ...BATCH_PATHS];

/**
 * 清理测试残留。幂等：路径不存在时删除接口同样返回 200。
 * 抽成函数是为了让异常路径也能调用 —— 原先清理写在流程中间，中途抛异常就留下
 * _smoke/* 残留，污染下一次运行的基线。
 */
async function cleanupSmokeFiles() {
  let allOk = true;
  for (const p of SMOKE_PATHS) {
    try {
      const r = await req('/api/file', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (!r.ok) allOk = false;
    } catch {
      allOk = false;
    }
  }
  return allOk;
}

async function main() {
  console.log(`\n冒烟测试 → ${BASE}\n`);

  console.log('[鉴权]');
  const bad = await json('/api/login', { password: 'definitely-wrong' });
  ok('错误口令返回 401', bad.status === 401, `实际 ${bad.status}`);

  const good = await json('/api/login', { password: PASSWORD });
  ok('正确口令返回 200', good.status === 200, `实际 ${good.status}`);
  ok('下发会话 cookie', cookie.includes('r2share_session'));

  console.log('\n[路径安全]');
  for (const p of ['../etc/passwd', '/etc/shadow', 'a/../../b', 'foo//bar', '']) {
    const r = await json('/api/sign', { path: p, size: 1 });
    ok(`拒绝非法路径 ${JSON.stringify(p)}`, r.status === 400, `实际 ${r.status}`);
  }

  console.log('\n[索引保护]');
  // files.json 是索引自身：若能被用户上传/删除，一次误传同名文件就会冲掉整站目录列表
  const overwrite = await req('/api/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'files.json', size: 1, type: 'application/json' }),
  });
  ok('拒绝把索引文件当作上传目标', overwrite.status === 400, `实际 ${overwrite.status}`);

  const delIdx = await req('/api/file', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'files.json' }),
  });
  ok('拒绝删除索引文件', delIdx.status === 400, `实际 ${delIdx.status}`);

  const subIdx = await req('/api/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '_smoke/files.json', size: 1, type: 'application/json' }),
  });
  ok('子目录下的同名文件不受影响', subIdx.status === 200, `实际 ${subIdx.status}`);

  console.log('\n[上传]');
  // 全部用 _smoke/ 前缀：与演示数据隔离，测完清理，不残留（定义见文件顶部的 FILES）
  const files = FILES;

  // 先清掉历史运行可能残留的 _smoke 文件，再记录索引基线（兼容已有数据的实例）
  for (const [p] of files) {
    await req('/api/file', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
  }
  const baseline = (await (await req('/api/local-index')).json()).files.length || 0;

  for (const [p, content, type] of files) {
    const r = await upload(p, content, type);
    ok(`上传 ${p}`, r.ok, r.error || '');
  }

  console.log('\n[索引]');
  const idxRes = await req('/api/local-index');
  const idx = await idxRes.json();
  ok('索引可读', Array.isArray(idx.files));
  ok(`索引较测试前新增 ${files.length} 条`, idx.files.length === baseline + files.length, `实际 ${idx.files.length}`);
  ok('中文路径正确保存', idx.files.some((f) => f.p === '_smoke/你好.txt'));
  ok('文件大小已记录', idx.files.find((f) => f.p === '_smoke/data.json')?.s > 0);

  // 空转优化（P3⑩）：原样重复提交同一个文件，不该再产生一次索引写。
  // 证据用索引的 updated 时间戳 —— 只有真的写了 files.json，它才会变。
  const u1 = idx.updated;
  const recommit = await json('/api/commit', { path: '_smoke/你好.txt', type: 'text/plain' });
  ok('原样重复提交返回 200', recommit.status === 200, `实际 ${recommit.status}`);
  const u2 = (await (await req('/api/local-index')).json()).updated;
  ok('原样重复提交不再写索引（updated 未变）', u1 === u2, `实际 ${u1} → ${u2}`);

  console.log('\n[批量接口]');
  // 批量上传链路：一次签名 → N 次 PUT → 一次提交索引（前端拖入多个文件时的走法）
  const batchPaths = BATCH_PATHS;
  const signBatch = await json('/api/sign', {
    entries: batchPaths.map((p) => ({ path: p, size: 3, type: 'text/plain' })),
  });
  ok('批量签名返回 200', signBatch.status === 200, `实际 ${signBatch.status}`);
  const signData = await signBatch.json().catch(() => ({}));
  ok(
    '批量签名逐条回传地址',
    Array.isArray(signData.items) && signData.items.length === batchPaths.length,
    `实际 ${JSON.stringify(signData.items || null)}`
  );

  let putAll = true;
  for (const it of signData.items || []) {
    const r = await req(it.url, {
      method: 'PUT',
      headers: { 'content-type': it.ctype },
      body: 'abc',
    });
    if (!r.ok) putAll = false;
  }
  ok('批量上传的对象全部写入成功', putAll);

  const commitBatch = await json('/api/commit', {
    entries: batchPaths.map((p) => ({ path: p, type: 'text/plain' })),
  });
  ok('批量提交索引返回 200', commitBatch.status === 200, `实际 ${commitBatch.status}`);
  const commitData = await commitBatch.json().catch(() => ({}));
  ok('批量提交写入 3 条', commitData.count === 3, `实际 ${commitData.count}`);
  ok(
    '批量提交回传条目（供前端增量更新）',
    Array.isArray(commitData.entries) && commitData.entries.length === 3
  );
  const idxBatch = await (await req('/api/local-index')).json();
  ok(
    '批量上传的文件都进了索引',
    batchPaths.every((p) => idxBatch.files.some((f) => f.p === p))
  );

  const delBatch = await req('/api/files', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: batchPaths }),
  });
  ok('批量删除返回 200', delBatch.status === 200, `实际 ${delBatch.status}`);
  const delData = await delBatch.json().catch(() => ({}));
  ok('批量删除回传删除条数', delData.removed === 3, `实际 ${delData.removed}`);
  const idxBatch2 = await (await req('/api/local-index')).json();
  ok(
    '批量删除后索引中已无这些条目',
    !batchPaths.some((p) => idxBatch2.files.some((f) => f.p === p))
  );

  const badBatchDel = await req('/api/files', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['../etc/passwd'] }),
  });
  ok('批量删除拒绝非法路径', badBatchDel.status === 400, `实际 ${badBatchDel.status}`);
  const badBatchCommit = await json('/api/commit', { entries: [{ path: 'files.json' }] });
  ok('批量提交拒绝索引文件', badBatchCommit.status === 400, `实际 ${badBatchCommit.status}`);

  console.log('\n[下载]');
  const dl = await req('/api/local-get?key=' + encodeURIComponent('_smoke/你好.txt'));
  const text = await dl.text();
  ok('下载内容正确', text === 'hello world', `实际 "${text}"`);

  const miss = await req('/api/local-get?key=' + encodeURIComponent('不存在的文件.txt'));
  ok('不存在的文件返回 404', miss.status === 404, `实际 ${miss.status}`);

  // Range 透传：代理模式下大视频/音频要能拖进度条（不处理 Range 时每次 seek 整份重下）
  const KEY = '/api/local-get?key=' + encodeURIComponent('_smoke/你好.txt');
  const RANGE = (v) => req(KEY, { headers: { range: v } });

  const r1 = await RANGE('bytes=0-4');
  ok('Range 请求返回 206', r1.status === 206, `实际 ${r1.status}`);
  ok('Range 回传 content-range', r1.headers.get('content-range') === 'bytes 0-4/11', `实际 ${r1.headers.get('content-range')}`);
  ok('Range 回传正确切片', (await r1.text()) === 'hello', '正文不是 hello');
  ok('声明 accept-ranges', r1.headers.get('accept-ranges') === 'bytes', `实际 ${r1.headers.get('accept-ranges')}`);

  const r2 = await RANGE('bytes=6-');
  ok('开放式 Range（bytes=N-）切片正确', (await r2.text()) === 'world', '正文不是 world');
  ok('开放式 Range 的 content-range 到末尾', r2.headers.get('content-range') === 'bytes 6-10/11', `实际 ${r2.headers.get('content-range')}`);

  const r3 = await RANGE('bytes=-5');
  ok('后缀 Range（bytes=-N）切片正确', (await r3.text()) === 'world', '正文不是 world');
  ok('后缀 Range 的 content-range 正确', r3.headers.get('content-range') === 'bytes 6-10/11', `实际 ${r3.headers.get('content-range')}`);

  const r4 = await RANGE('bytes=0-1,5-6');
  ok(
    '多段 Range 被忽略、按整份返回（而不是 500）',
    r4.status === 200 && r4.headers.get('content-range') === null,
    `实际 status=${r4.status} content-range=${r4.headers.get('content-range')}`
  );
  ok('多段 Range 忽略时正文是完整内容', (await r4.text()) === 'hello world', '正文不完整');

  const r5 = await RANGE('bytes=abc-def');
  ok('非法 Range 被忽略、按整份返回', r5.status === 200, `实际 ${r5.status}`);

  // 越界区间：R2 会抛「不可满足」，必须退化成整份 200，而不是 500
  const r6 = await RANGE('bytes=100-200');
  ok('越界 Range 退化为整份返回、不变成 500', r6.status === 200, `实际 ${r6.status}`);
  ok('越界 Range 退化后正文是完整内容', (await r6.text()) === 'hello world', '正文不完整');

  console.log('\n[页面]');
  const home = await req('/');
  const html = await home.text();
  ok('首页返回 200', home.status === 200);
  ok('首页包含站点标题', html.includes('我的仓库'));
  ok('首页注入了配置', html.includes('__CFG__'));
  ok('首页包含预览弹层', html.includes('id="pv"'));
  const css = await req('/style.css');
  ok('样式表可访问', css.status === 200);
  const js = await req('/app.js');
  ok('脚本可访问', js.status === 200);
  ok('脚本含预览逻辑', (await js.text()).includes('openPreview'));

  console.log('\n[删除]');
  const del = await req('/api/file', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '_smoke/文档.pdf' }),
  });
  ok('删除返回 200', del.status === 200);

  const idx2 = await (await req('/api/local-index')).json();
  ok('索引中已移除', !idx2.files.some((f) => f.p === '_smoke/文档.pdf'));
  ok(`删除后回到测试前 + ${files.length - 1} 条`, idx2.files.length === baseline + files.length - 1);

  console.log('\n[清理]');
  const cleaned = await cleanupSmokeFiles();
  const idx3 = await (await req('/api/local-index')).json();
  ok('测试文件全部清理', cleaned && idx3.files.length === baseline, `实际 ${idx3.files.length}，基线 ${baseline}`);

  console.log('\n[重建索引]');
  const rf = await json('/api/refresh', {});
  ok('重建返回 200', rf.status === 200, `实际 ${rf.status}`);
  const rb = await rf.json().catch(() => ({}));
  // 不拿「索引长度 == 基线」当判据：桶与索引本就不同步时（正是 refresh 的适用场景）
  // 重算出来的条数本来就不等于旧索引长度，那是一条与功能无关的假红。
  // 真正要确认的是：它确实重算了，且刚清理掉的测试文件没有被「重算回来」。
  ok('重建回传了重算后的文件数', rb.ok === true && Number.isFinite(rb.files), `实际 ${JSON.stringify(rb)}`);
  const idx4 = await (await req('/api/local-index')).json();
  ok('重建后索引里仍无测试文件', !files.some(([p]) => idx4.files.some((f) => f.p === p)));
  // 未登录应被拒
  const saved = cookie;
  cookie = '';
  const rfNoAuth = await json('/api/refresh', {});
  ok('未登录重建返回 401', rfNoAuth.status === 401, `实际 ${rfNoAuth.status}`);
  cookie = saved;

  console.log('\n[登录限流]');
  // 用一个伪造 IP 触发限流，避免把本机 IP 锁掉影响重复运行。
  // 若运行环境会覆盖 x-forwarded-for，最后一条断言会翻红以暴露该问题。
  const TEST_IP = '203.0.113.9';
  const tryBadLogin = () =>
    req('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': TEST_IP },
      body: JSON.stringify({ password: 'definitely-not-the-password' }),
    });
  let limited = false;
  const codes = [];
  for (let i = 0; i < 12; i++) {
    const r = await tryBadLogin();
    codes.push(r.status);
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  ok('连续错误口令后被限流（429）', limited, `状态序列 ${codes.join(',')}`);

  // 限流只应针对触发它的那个 IP —— 顺带验证计数确实按 IP 隔离
  const stillOk = await json('/api/login', { password: PASSWORD });
  ok('限流不牵连其他 IP（本机仍可登录）', stillOk.status === 200, `实际 ${stillOk.status}`);

}

// 收尾统一放在 finally：异常路径同样要清理残留，并把「结果」与退出码一起给出
main()
  .catch((e) => {
    console.error('测试异常：', e);
    fail++;
  })
  .finally(async () => {
    // 正常路径里已清过一次，这里是幂等空转；异常路径靠它兜底
    await cleanupSmokeFiles().catch(() => {});
    console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
    process.exit(fail > 0 ? 1 : 0);
  });
