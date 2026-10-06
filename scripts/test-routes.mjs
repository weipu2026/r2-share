/**
 * Worker 路由级离线单测（不依赖网络，可在 CI 跑）
 *
 * 做法：直接 import src/index.ts 导出的 Hono app，用 app.request() 打请求；
 * BUCKET 用内存替身、ASSETS 用假 Fetcher，因此整条链路（路由 → 鉴权 → store → R2 调用）
 * 都能在 Node 里跑。
 *
 * 补的是审计时点出的覆盖盲区：/api/mkdir、/api/dir、/api/refresh、/api/logout、
 * /api/local-put（含 413 与「上传代理未启用」两个分支、以及生产流式分支）。
 *
 * 用法：node scripts/test-routes.mjs
 */

import app from '../src/index.ts';

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
const group = (t) => console.log(`\n[${t}]`);

/* ================= 替身 ================= */

/**
 * 内存版 R2 桶。
 * - put 记录每次调用的键与 body 形态（用于断言「走了哪个分支」，判据落在我发出的请求上）
 * - get/head 回传 uploaded，mkdir 的「幂等沿用真实上传时间」依赖它
 */
class FakeBucket {
  constructor() {
    this.map = new Map(); // key -> { body, etag, uploaded, meta }
    this.seq = 0;
    this.putLog = [];
  }
  _etag() {
    return 'etag-' + ++this.seq;
  }
  async get(key) {
    const o = this.map.get(key);
    if (!o) return null;
    return {
      key,
      etag: o.etag,
      size: o.body.length,
      uploaded: o.uploaded,
      httpMetadata: o.meta,
      body: o.body,
      json: async () => JSON.parse(o.body),
      text: async () => o.body,
    };
  }
  async head(key) {
    const o = this.map.get(key);
    if (!o) return null;
    return { key, size: o.body.length, etag: o.etag, uploaded: o.uploaded, httpMetadata: o.meta };
  }
  async _read(body) {
    if (typeof body === 'string') return body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    if (body && typeof body.getReader === 'function') {
      return new TextDecoder().decode(new Uint8Array(await new Response(body).arrayBuffer()));
    }
    return String(body);
  }
  async put(key, body, opts) {
    const bodyKind =
      typeof body === 'string'
        ? 'string'
        : body instanceof ArrayBuffer
          ? 'arraybuffer'
          : body instanceof Uint8Array
            ? 'uint8array'
            : body && typeof body.getReader === 'function'
              ? 'stream'
              : typeof body;
    const text = await this._read(body);
    this.putLog.push({ key, onlyIf: opts && opts.onlyIf, bodyKind });

    const cur = this.map.get(key);
    const cond = opts && opts.onlyIf;
    if (cond) {
      if (cond.etagMatches !== undefined && (!cur || cur.etag !== cond.etagMatches)) return null;
      if (cond.etagDoesNotMatch === '*' && cur) return null;
    }
    const etag = this._etag();
    this.map.set(key, {
      body: text,
      etag,
      // 覆盖写时沿用原 uploaded：与真实 R2 一致，mkdir 的幂等分支靠它
      uploaded: cur ? cur.uploaded : new Date(),
      meta: opts && opts.httpMetadata,
    });
    return { key, size: text.length, etag };
  }
  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k);
  }
  async list(opts = {}) {
    const prefix = opts.prefix || '';
    const objects = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((k) => ({ key: k, size: this.map.get(k).body.length, uploaded: this.map.get(k).uploaded }));
    return { objects, truncated: false, delimitedPrefixes: [] };
  }
}

const ADMIN_PW = 'test-password-1234';
const jsonHeaders = (cookie) => ({
  'content-type': 'application/json',
  ...(cookie ? { cookie } : {}),
});

function makeEnv(over = {}) {
  return {
    BUCKET: new FakeBucket(),
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    DL_DOMAIN: '',
    SITE_NAME: '测试仓库',
    SESSION_DAYS: '30',
    MAX_UPLOAD: '1024',
    BUCKET_NAME: 'r2share',
    UPLOAD_VIA_WORKER: '1',
    LOCAL_MODE: '1',
    ADMIN_PASSWORD: ADMIN_PW,
    SESSION_SECRET: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_ACCOUNT_ID: '',
    CLOUDFLARE_ACCOUNT_ID: '',
    ...over,
  };
}

async function login(env) {
  const res = await app.request(
    '/api/login',
    { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ password: env.ADMIN_PASSWORD }) },
    env
  );
  const sc = res.headers.get('set-cookie') || '';
  return { status: res.status, cookie: sc.split(';')[0] };
}

const idxOf = (env) => JSON.parse(env.BUCKET.map.get('files.json').body);
const countPut = (env, key) => env.BUCKET.putLog.filter((p) => p.key === key).length;

/* ================= 鉴权 ================= */

group('/api/login 与 /api/logout');
{
  const env = makeEnv();
  const good = await login(env);
  ok('正确口令登录返回 200', good.status === 200, `实际 ${good.status}`);
  ok('下发会话 cookie', good.cookie.includes('r2share_session='), good.cookie);

  const bad = await app.request(
    '/api/login',
    { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ password: 'wrong-password' }) },
    env
  );
  ok('错误口令返回 401', bad.status === 401, `实际 ${bad.status}`);

  const noPw = makeEnv({ ADMIN_PASSWORD: '' });
  const r1 = await login(noPw);
  ok('未配置 ADMIN_PASSWORD 时登录一律被拒（不会误判已登录）', r1.status === 401, `实际 ${r1.status}`);
  const guard = await app.request('/api/mkdir', {
    method: 'POST',
    headers: jsonHeaders('r2share_session=whatever'),
    body: JSON.stringify({ path: 'x' }),
  }, noPw);
  ok('无口令来源时带任意 cookie 也判未登录', guard.status === 401, `实际 ${guard.status}`);

  const lo = await app.request('/api/logout', { method: 'POST', headers: { cookie: good.cookie } }, env);
  const sc = lo.headers.get('set-cookie') || '';
  ok('登出返回 200', lo.status === 200, `实际 ${lo.status}`);
  ok('登出清空会话 cookie', /r2share_session=;/.test(sc) && /Max-Age=0/i.test(sc), sc);
}

/* ================= /api/mkdir ================= */

group('/api/mkdir');
{
  const env = makeEnv();
  const { cookie } = await login(env);

  const noAuth = await app.request('/api/mkdir', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ path: 'docs' }),
  }, env);
  ok('未登录返回 401', noAuth.status === 401, `实际 ${noAuth.status}`);

  const badPath = await app.request('/api/mkdir', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: '../escape' }),
  }, env);
  ok('非法路径返回 400', badPath.status === 400, `实际 ${badPath.status}`);

  const mk = await app.request('/api/mkdir', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: '文档/子目录' }),
  }, env);
  ok('新建目录返回 200', mk.status === 200, `实际 ${mk.status}`);
  ok('写入了 0 字节占位对象（末尾带斜杠）', env.BUCKET.map.has('文档/子目录/'));
  ok('占位对象是 0 字节', env.BUCKET.map.get('文档/子目录/').body === '');
  ok(
    '索引里出现目录占位条目（s=0）',
    idxOf(env).files.some((f) => f.p === '文档/子目录/' && f.s === 0),
    JSON.stringify(idxOf(env).files)
  );

  // 幂等：重复新建同一目录不该再写一次索引（t 沿用占位对象的 uploaded 才做得到）
  const before = countPut(env, 'files.json');
  const again = await app.request('/api/mkdir', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: '文档/子目录' }),
  }, env);
  ok('重复新建返回 200（幂等）', again.status === 200, `实际 ${again.status}`);
  ok('幂等时不再重写索引', countPut(env, 'files.json') === before, `之前 ${before}，之后 ${countPut(env, 'files.json')}`);

  // 「占位对象在、索引条目丢失」时再点一次，必须把条目补回来
  const lost = makeEnv();
  const c2 = (await login(lost)).cookie;
  lost.BUCKET.map.set('孤儿目录/', { body: '', etag: 'e1', uploaded: new Date(0), meta: {} });
  await app.request('/api/mkdir', {
    method: 'POST',
    headers: jsonHeaders(c2),
    body: JSON.stringify({ path: '孤儿目录' }),
  }, lost);
  ok('占位对象已存在但索引缺条目时，会补写条目', idxOf(lost).files.some((f) => f.p === '孤儿目录/'));
}

/* ================= /api/dir ================= */

group('/api/dir（递归删除目录）');
{
  const env = makeEnv();
  const { cookie } = await login(env);
  await app.request('/api/mkdir', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: 'gone' }),
  }, env);
  // 放进两个真实文件，并同步索引
  for (const p of ['gone/a.txt', 'gone/b.txt']) {
    env.BUCKET.map.set(p, { body: 'x', etag: 'e-' + p, uploaded: new Date(0), meta: {} });
  }
  const idx = idxOf(env);
  idx.files.push(
    { p: 'gone/a.txt', s: 1, t: Date.now(), c: 'text/plain' },
    { p: 'gone/b.txt', s: 1, t: Date.now(), c: 'text/plain' }
  );
  env.BUCKET.map.set('files.json', { body: JSON.stringify(idx), etag: 'idx-2', uploaded: new Date(), meta: {} });

  const noAuth = await app.request('/api/dir', {
    method: 'DELETE',
    headers: jsonHeaders(),
    body: JSON.stringify({ path: 'gone' }),
  }, env);
  ok('未登录返回 401', noAuth.status === 401, `实际 ${noAuth.status}`);

  const del = await app.request('/api/dir', {
    method: 'DELETE',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: 'gone' }),
  }, env);
  const data = await del.json();
  ok('删除目录返回 200', del.status === 200, `实际 ${del.status}`);
  ok('回传删除条数', Number.isFinite(data.removed) && data.removed >= 2, JSON.stringify(data));
  ok('目录下的对象已从桶里删除', !env.BUCKET.map.has('gone/a.txt') && !env.BUCKET.map.has('gone/b.txt'));
  ok(
    '索引里不再有该目录下的条目',
    !idxOf(env).files.some((f) => f.p.startsWith('gone/')),
    JSON.stringify(idxOf(env).files.map((f) => f.p))
  );

  const badPath = await app.request('/api/dir', {
    method: 'DELETE',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: '/abs' }),
  }, env);
  ok('非法路径返回 400', badPath.status === 400, `实际 ${badPath.status}`);
}

/* ================= /api/refresh ================= */

group('/api/refresh（重建索引）');
{
  const env = makeEnv();
  const { cookie } = await login(env);
  // 桶里直接放对象（模拟 rclone 同步进来的、索引里没有的文件）
  env.BUCKET.map.set('synced/one.zip', { body: 'zip', etag: 'z1', uploaded: new Date(0), meta: {} });
  env.BUCKET.map.set('synced/two.zip', { body: 'zip', etag: 'z2', uploaded: new Date(0), meta: {} });

  const noAuth = await app.request('/api/refresh', { method: 'POST', headers: jsonHeaders() }, env);
  ok('未登录返回 401', noAuth.status === 401, `实际 ${noAuth.status}`);

  const rf = await app.request('/api/refresh', { method: 'POST', headers: jsonHeaders(cookie) }, env);
  const rb = await rf.json();
  ok('重建返回 200', rf.status === 200, `实际 ${rf.status}`);
  ok('回传重算后的文件数（数字）', Number.isFinite(rb.files), JSON.stringify(rb));
  ok(
    '桶里此前不在索引里的对象被纳入索引',
    idxOf(env).files.some((f) => f.p === 'synced/one.zip') && idxOf(env).files.some((f) => f.p === 'synced/two.zip'),
    JSON.stringify(idxOf(env).files.map((f) => f.p))
  );
  ok('重建不会重算成 0 条', rb.files >= 2, `实际 ${rb.files}`);
}

/* ================= /api/local-put ================= */

group('/api/local-put（生产上传主路径）');
{
  // 代理模式：读进内存（miniflare 里流式落盘会变 0 字节）
  const envP = makeEnv({ LOCAL_MODE: '1' });
  const cP = (await login(envP)).cookie;
  const put1 = await app.request(
    '/api/local-put?key=' + encodeURIComponent('笔记/你好.txt'),
    { method: 'PUT', headers: { 'content-type': 'text/plain', cookie: cP }, body: 'hello' },
    envP
  );
  const d1 = await put1.json();
  ok('代理模式写入返回 200', put1.status === 200, `实际 ${put1.status}`);
  ok('回传写入字节数', d1.size === 5, JSON.stringify(d1));
  ok('对象内容正确落盘', envP.BUCKET.map.get('笔记/你好.txt')?.body === 'hello');
  ok('代理模式走内存缓冲分支（不是流式）', envP.BUCKET.putLog.at(-1).bodyKind === 'arraybuffer', envP.BUCKET.putLog.at(-1).bodyKind);

  // 生产模式：流式透传 c.req.raw.body，不占 Worker 内存
  const envS = makeEnv({ LOCAL_MODE: '0', UPLOAD_VIA_WORKER: '1' });
  const cS = (await login(envS)).cookie;
  const put2 = await app.request(
    '/api/local-put?key=' + encodeURIComponent('big.bin'),
    { method: 'PUT', headers: { 'content-type': 'application/octet-stream', cookie: cS }, body: 'streamed-body' },
    envS
  );
  ok('生产模式写入返回 200', put2.status === 200, `实际 ${put2.status}`);
  ok('生产模式走流式分支（body 是 ReadableStream）', envS.BUCKET.putLog.at(-1).bodyKind === 'stream', envS.BUCKET.putLog.at(-1).bodyKind);
  ok('流式分支内容完整落盘', envS.BUCKET.map.get('big.bin')?.body === 'streamed-body');

  // 超过 MAX_UPLOAD：在入口就拒（按 content-length 兜一道，不依赖前端申报的 size）
  const envM = makeEnv({ MAX_UPLOAD: '4' });
  const cM = (await login(envM)).cookie;
  // ⚠️ content-length 必须手动给：真实 CF 边缘会替请求补齐这个头，而 Node 的 Request 不会
  // （fetch 规范里它是 forbidden header，只有显式设置才会保留）。少了它，服务端读到的长度是 0，
  // 这条断言会假绿。
  const put3 = await app.request(
    '/api/local-put?key=too-big.txt',
    {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'content-length': '10', cookie: cM },
      body: '0123456789',
    },
    envM
  );
  ok('超过 MAX_UPLOAD 返回 413', put3.status === 413, `实际 ${put3.status}`);
  ok('413 时不写入桶', !envM.BUCKET.map.has('too-big.txt'));

  // 未启用上传代理（直传模式）：本路由必须拒绝，避免把文件悄悄写进桶
  const envD = makeEnv({ LOCAL_MODE: '0', UPLOAD_VIA_WORKER: '0' });
  const cD = (await login(envD)).cookie;
  const put4 = await app.request(
    '/api/local-put?key=nope.txt',
    { method: 'PUT', headers: { 'content-type': 'text/plain', cookie: cD }, body: 'x' },
    envD
  );
  ok('未启用上传代理时返回 400', put4.status === 400, `实际 ${put4.status}`);
  ok('未启用上传代理时不写入桶', !envD.BUCKET.map.has('nope.txt'));

  const noKey = await app.request(
    '/api/local-put',
    { method: 'PUT', headers: { 'content-type': 'text/plain', cookie: cP }, body: 'x' },
    envP
  );
  ok('缺少 key 返回 400', noKey.status === 400, `实际 ${noKey.status}`);

  const noAuth = await app.request(
    '/api/local-put?key=x.txt',
    { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x' },
    envP
  );
  ok('未登录返回 401', noAuth.status === 401, `实际 ${noAuth.status}`);
}

/* ================= /api/commit 的索引保护 ================= */

group('/api/commit');
{
  const env = makeEnv();
  const { cookie } = await login(env);
  env.BUCKET.map.set('real.txt', { body: 'hi', etag: 'r1', uploaded: new Date(), meta: {} });

  const okRes = await app.request('/api/commit', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: 'real.txt', type: 'text/plain' }),
  }, env);
  ok('提交真实存在的对象返回 200', okRes.status === 200, `实际 ${okRes.status}`);
  ok('索引里写入了该条目', idxOf(env).files.some((f) => f.p === 'real.txt'));

  const idxTarget = await app.request('/api/commit', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: 'files.json' }),
  }, env);
  ok('把索引文件本身当提交目标被拒（400）', idxTarget.status === 400, `实际 ${idxTarget.status}`);

  // /api/commit 对「对象不存在」是**部分成功**语义：不当作 HTTP 错误（仍 200），
  // 而是用 ok:false + missing[] 告知前端。真正的不变量是「绝不凭一次 commit 凭空造出索引条目」
  // —— 这正是前端据此提示「文件可能未真正上传成功」的依据。
  const missing = await app.request('/api/commit', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ path: 'never-uploaded.txt' }),
  }, env);
  const md = await missing.json();
  ok('提交不存在的对象：HTTP 200 但 ok=false', missing.status === 200 && md.ok === false, `实际 ${missing.status} ${JSON.stringify(md)}`);
  ok('缺失路径经 missing[] 回传', Array.isArray(md.missing) && md.missing.includes('never-uploaded.txt'), JSON.stringify(md.missing));
  ok('缺失对象不会被写进索引（不凭空造条目）', !idxOf(env).files.some((f) => f.p === 'never-uploaded.txt'));

  // 混合批次：存在的如实写入、缺失的如实回传，一批里两种都要能反映出来
  const mix = await app.request('/api/commit', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ entries: [{ path: 'real.txt' }, { path: 'ghost.txt' }] }),
  }, env);
  const mixd = await mix.json();
  ok('混合批次：count 只算实际存在的', mixd.count === 1, JSON.stringify(mixd));
  ok('混合批次：missing 如实回传缺失项', mixd.missing.length === 1 && mixd.missing[0] === 'ghost.txt', JSON.stringify(mixd.missing));
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);
