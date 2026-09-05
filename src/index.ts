/**
 * r2share —— 零费用的 R2 我的仓库
 *
 * 请求消耗模型（核心设计）：
 *   浏览目录页 : 0 次 Worker（静态资源免费无限）+ 1 次 R2 读 files.json
 *   下载文件   : 0 次 Worker（R2 公开桶直链，出口免费）
 *   上传文件   : 2 次 Worker（签名 + 提交索引），数据不过 Worker
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { renderIndex } from './views';
import { presignPut } from './sigv4';
import {
  createSession,
  verifySession,
  checkPassword,
  SESSION_COOKIE,
} from './auth';
import {
  sanitizePath,
  upsertFile,
  removeFile,
  removeDir,
  rebuildIndex,
  readIndex,
  guessType,
} from './store';

export interface Env {
  BUCKET: R2Bucket;
  KV: KVNamespace;
  ASSETS: Fetcher;
  DL_DOMAIN: string;
  SITE_NAME: string;
  SESSION_DAYS: string;
  MAX_UPLOAD: string;
  BUCKET_NAME: string;
  /** '1' 时生产环境上传改走 Worker 代理（绕开被墙的 r2.cloudflarestorage.com 直传） */
  UPLOAD_VIA_WORKER: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
}

const app = new Hono<{ Bindings: Env }>();

/** 判断当前请求是否已登录 */
async function isLogin(c: any): Promise<boolean> {
  const secret = c.env.SESSION_SECRET;
  if (!secret) return false;
  return verifySession(secret, getCookie(c, SESSION_COOKIE));
}

/** 登录失败计数：15 分钟内超过 10 次则临时锁定 */
async function failCount(c: any, ip: string, reset = false): Promise<number> {
  const key = `login_fail:${ip}`;
  if (reset) {
    await c.env.KV.delete(key);
    return 0;
  }
  const cur = parseInt((await c.env.KV.get(key)) ?? '0', 10) || 0;
  const next = cur + 1;
  await c.env.KV.put(key, String(next), { expirationTtl: 900 });
  return next;
}

function clientIP(c: any): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    'unknown'
  );
}

/* ---------------- 页面 ---------------- */

/**
 * 是否为本地开发模式：没有配置 R2 的 S3 凭证时，
 * presigned 直传与公开桶直链都不可用，自动回退到 Worker 代理。
 * 该标记同时传给前端（CFG.local），控制下载/索引走本地代理路由。
 */
function isLocal(c: any): boolean {
  return !c.env.R2_ACCESS_KEY_ID || !c.env.R2_ACCOUNT_ID;
}

/**
 * 上传是否走 Worker 代理：
 * - 本地开发（unconfigured R2）或
 * - 生产显式设置 UPLOAD_VIA_WORKER='1'
 * 区别于 isLocal：此标记只决定「上传」走 Worker 中转（env.BUCKET.put），
 * 下载仍走公开桶直链，避免 r2.cloudflarestorage.com 被墙时上传不可用。
 */
function isUploadProxy(c: any): boolean {
  return isLocal(c) || c.env.UPLOAD_VIA_WORKER === '1';
}

app.get('/', async (c) => {
  const login = await isLogin(c);
  return c.html(
    renderIndex({
      siteName: c.env.SITE_NAME || '我的仓库',
      dlDomain: c.env.DL_DOMAIN || '',
      isLogin: login,
      local: isLocal(c),
    })
  );
});

/* ---------------- 本地开发回退路由 ----------------
 * /api/local-index 与 /api/local-get 仅当未配置 R2 S3 凭证时可用（wrangler dev 本地验证）；
 * /api/local-put 例外：生产开启 UPLOAD_VIA_WORKER=1 时作为上传主路径（见 isUploadProxy）。
 * 生产环境的下载与索引始终走 R2 公开桶直链（DL_DOMAIN），不经过这里。
 */

app.get('/api/local-index', async (c) => {
  if (!isLocal(c)) return c.text('生产环境请直接读取公开桶的 files.json', 400);
  // 复用 readIndex 的容灾语义：索引不存在或损坏时返回空索引，可用 /api/refresh 重建
  const idx = await readIndex(c.env.BUCKET);
  return c.json(idx);
});

app.get('/api/local-get', async (c) => {
  if (!isLocal(c)) return c.text('生产环境请走 R2 公开桶直链', 400);
  const key = sanitizePath(c.req.query('key'));
  if (!key) return c.text('缺少 key', 400);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.text('文件不存在', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
});

app.put('/api/local-put', async (c) => {
  if (!isUploadProxy(c)) {
    return c.text('上传代理未启用，请配置 UPLOAD_VIA_WORKER=1 或使用 presigned 直传', 400);
  }
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);
  const key = sanitizePath(c.req.query('key'));
  if (!key) return c.text('缺少 key', 400);

  const ctype = c.req.header('content-type') || 'application/octet-stream';

  if (isLocal(c)) {
    // 本地 miniflare：流式 put 会落盘为 0 字节，只能读进内存再写
    const body = await c.req.arrayBuffer();
    await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: ctype } });
    return c.json({ ok: true, key, size: body.byteLength });
  }

  // 生产代理模式：流式透传 request body 到 R2，不占 Worker 内存
  // （限制同 Workers 请求体上限，与 MAX_UPLOAD 对齐）
  // 注意用 c.req.raw.body（原生 Request.body）而非 c.req.body，Hono 的类型不接受后者
  const body = c.req.raw.body;
  if (!body) return c.text('缺少请求体', 400);
  const obj = await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: ctype },
  });
  return c.json({ ok: true, key, size: obj.size });
});

/* ---------------- 鉴权 ---------------- */

app.post('/api/login', async (c) => {
  const ip = clientIP(c);
  const used = parseInt((await c.env.KV.get(`login_fail:${ip}`)) ?? '0', 10) || 0;
  if (used >= 10) {
    return c.json({ ok: false, error: '尝试次数过多，请 15 分钟后再试' }, 429);
  }

  let password: string | undefined;
  try {
    ({ password } = (await c.req.json()) as { password?: string });
  } catch {
    /* 忽略解析失败，下面按空口令处理 */
  }

  const expected = c.env.ADMIN_PASSWORD;
  if (!expected || !(await checkPassword(password ?? '', expected))) {
    await failCount(c, ip);
    return c.json({ ok: false, error: '口令错误' }, 401);
  }

  await failCount(c, ip, true);
  const days = parseInt(c.env.SESSION_DAYS || '30', 10) || 30;
  const token = await createSession(c.env.SESSION_SECRET, days);
  const secure = new URL(c.req.url).protocol === 'https:';

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: days * 86400,
  });
  return c.json({ ok: true });
});

app.post('/api/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/* ---------------- 上传：签名 + 提交 ---------------- */

/** 第一步：签发 presigned PUT URL，浏览器拿到后直传 R2 */
app.post('/api/sign', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string; size?: number; type?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  // 防注入：content-type 只参与签名，不允许换行/控制字符
  const ctype = String(body.type || 'application/octet-stream')
    .replace(/[\r\n]/g, '')
    .slice(0, 200);

  const max = parseInt(c.env.MAX_UPLOAD || '0', 10);
  if (max > 0 && (body.size ?? 0) > max) {
    return c.json({ error: '文件超过大小上限' }, 413);
  }

  // 上传走 Worker 代理：本地开发或生产开启 UPLOAD_VIA_WORKER=1。
  // 生产场景为避免 r2.cloudflarestorage.com 被墙（ERR_ADDRESS_UNREACHABLE），
  // 上传目标改为本 Worker 的同源 /api/local-put（浏览器无需 CORS、不依赖被墙端点）。
  if (isUploadProxy(c)) {
    return c.json({
      ok: true,
      url: `/api/local-put?key=${encodeURIComponent(path)}`,
      key: path,
      local: true,
    });
  }

  const url = await presignPut(
    {
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
      accountId: c.env.R2_ACCOUNT_ID,
      bucket: c.env.BUCKET_NAME,
    },
    path,
    3600,
    new Date(),
    ctype
  );

  return c.json({ ok: true, url, key: path });
});

/** 第二步：上传成功后，把文件信息增量写入 files.json */
app.post('/api/commit', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string; size?: number; type?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  // 校验对象真实存在，以桶里的实际大小为准（防止伪造 commit 污染索引）
  const obj = await c.env.BUCKET.head(path);
  if (!obj) return c.json({ error: '对象不存在，请先上传' }, 404);

  await upsertFile(c.env.BUCKET, {
    p: path,
    s: obj.size,
    t: Date.now(),
    c: body.type || guessType(path),
  });

  return c.json({ ok: true });
});

/** 删除文件：删对象 + 从索引移除 */
app.delete('/api/file', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  await c.env.BUCKET.delete(path);
  await removeFile(c.env.BUCKET, path);
  return c.json({ ok: true });
});

/* ---------------- 目录：新建 + 删除 ---------------- */

/**
 * 新建目录：创建 <path>/ 的 0 字节占位对象并写入索引。
 * R2 没有原生目录，前端 listDir 靠路径推导；占位对象保证
 * 空目录在索引里可见，且 rebuildIndex 后依然存在。
 * 幂等：目录已存在时直接返回 ok。
 */
app.post('/api/mkdir', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  const prefix = path + '/';
  const obj = await c.env.BUCKET.head(prefix);
  if (obj) return c.json({ ok: true }); // 已存在，幂等

  await c.env.BUCKET.put(prefix, new Uint8Array(0), {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  await upsertFile(c.env.BUCKET, {
    p: prefix,
    s: 0,
    t: Date.now(),
    c: 'application/octet-stream',
  });
  return c.json({ ok: true });
});

/** 删除目录（递归）：删掉该前缀下所有对象 + 占位对象，并清理索引 */
app.delete('/api/dir', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  const n = await removeDir(c.env.BUCKET, path);
  return c.json({ ok: true, removed: n });
});

/** 全量重建索引：rclone / 后台直传文件后，把 files.json 对齐到桶的真实内容 */
app.post('/api/refresh', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);
  const r = await rebuildIndex(c.env.BUCKET);
  return c.json({ ok: true, files: r.files });
});

/* ---------------- 静态资源兜底 ---------------- */

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
