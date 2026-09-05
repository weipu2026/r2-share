/**
 * 本地冒烟测试：验证登录、路径校验、上传、索引、下载、删除全流程
 * 用法：node scripts/smoke.mjs [base_url]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PASSWORD = process.env.TEST_PASSWORD || 'dev123456';

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

  console.log('\n[上传]');
  // 全部用 _smoke/ 前缀：与演示数据隔离，测完清理，不残留
  const files = [
    ['_smoke/你好.txt', 'hello world', 'text/plain'],
    ['_smoke/说明.md', '# 标题\n\n这是 **粗体** 和 `代码`。\n\n- 项目一\n- 项目二\n', 'text/markdown'],
    ['_smoke/data.json', JSON.stringify({ a: 1, b: [1, 2, 3] }), 'application/json'],
    ['_smoke/文档.pdf', '%PDF-1.4 fake pdf content', 'application/pdf'],
  ];

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

  console.log('\n[下载]');
  const dl = await req('/api/local-get?key=' + encodeURIComponent('_smoke/你好.txt'));
  const text = await dl.text();
  ok('下载内容正确', text === 'hello world', `实际 "${text}"`);

  const miss = await req('/api/local-get?key=' + encodeURIComponent('不存在的文件.txt'));
  ok('不存在的文件返回 404', miss.status === 404, `实际 ${miss.status}`);

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
  let cleaned = true;
  for (const [p] of files) {
    const r = await req('/api/file', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    if (!r.ok) cleaned = false;
  }
  const idx3 = await (await req('/api/local-index')).json();
  ok('测试文件全部清理', cleaned && idx3.files.length === baseline, `实际 ${idx3.files.length}，基线 ${baseline}`);

  console.log('\n[重建索引]');
  const rf = await json('/api/refresh', {});
  ok('重建返回 200', rf.status === 200, `实际 ${rf.status}`);
  const rb = await rf.json().catch(() => ({}));
  ok(`重建后索引回到基线 ${baseline}`, rb.ok && rb.files === baseline, `实际 ${rb.files}`);
  // 未登录应被拒
  const saved = cookie;
  cookie = '';
  const rfNoAuth = await json('/api/refresh', {});
  ok('未登录重建返回 401', rfNoAuth.status === 401, `实际 ${rfNoAuth.status}`);
  cookie = saved;

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
