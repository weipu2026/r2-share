#!/usr/bin/env node
/**
 * 部署前自检：抓 wrangler.toml / .dev.vars / cors.json 里的常见配置坑。
 * 不替代 wrangler deploy 自身的校验，但能提前挡住下面这些 90% 会踩的失误：
 *   - 首页路由没显式交给 Worker（依赖「public/ 里没有 index.html」这个隐式前提）
 *   - R2 CORS AllowedOrigins 还有未替换的占位符
 *   - 管理口令 / 会话密钥是示例值
 *
 * 用法：npm run check
 * 退出码：0 通过；1 有必须先修的项
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

let fail = 0;
const ok = (msg) => console.log('  \x1b[32m✓\x1b[0m ' + msg);
const warn = (msg) => console.log('  \x1b[33m⚠\x1b[0m ' + msg);
const err = (msg) => { console.log('  \x1b[31m✗\x1b[0m ' + msg); fail++; };
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

// 1. wrangler CLI 是否可用
section('1. wrangler CLI');
try {
  const v = execSync('npx wrangler --version', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim().split('\n').pop();
  ok('wrangler ' + v);
} catch {
  err('wrangler 不可用，请先 npm install');
  process.exit(1);
}

// 2. 部署配置 —— 优先校验 gen-config 的生成物（含真实域名），否则退回模板
section('2. 部署配置');
const hasDeployCfg = existsSync('wrangler.deploy.toml');
const cfgPath = hasDeployCfg ? 'wrangler.deploy.toml' : 'wrangler.toml';
const toml = await readFile(cfgPath, 'utf8');
if (hasDeployCfg) {
  ok(`读取生成后的配置 ${cfgPath}`);
} else {
  // 模板只给合法默认值（保证 wrangler dev 能直接跑），真实域名/桶名全靠 gen-config 注入。
  // 所以「没生成 deploy 配置」必须阻断：否则会拿默认桶名与空域名去部署。
  err(
    '未找到 wrangler.deploy.toml（部署配置尚未生成）——本次只能校验模板，域名/路由无法确认\n' +
      '     先运行 `npm run gen-config`（需配置 WORKER_DOMAIN / DL_DOMAIN）再部署'
  );
}

// 兜底：生成物里若仍残留 __TOKEN__，说明模板被改回占位符、而 gen-config 没同步跟上
if (hasDeployCfg) {
  const leftover = toml.match(/__(?:BUCKET_NAME|DL_DOMAIN|SITE_NAME|WORKER_DOMAIN)__/g);
  if (leftover) err(`${cfgPath} 仍有未替换的占位符：${[...new Set(leftover)].join(', ')}`);
}

// 自定义域路由：必须存在，且是 custom_domain（zone_name 传统路由在 assets 模式下易 522）。
// 模板里没有路由（由 gen-config 注入），所以只在生成物上判定。
if (hasDeployCfg) {
  const routeMatch = toml.match(/\[\[routes\]\][\s\S]*?pattern\s*=\s*"([^"]+)"/);
  if (!routeMatch) {
    err('缺少 [[routes]] pattern：Worker 未绑定自定义域（只会有 workers.dev 子域）');
  } else if (!/custom_domain\s*=\s*true/.test(toml)) {
    warn('[[routes]] 未使用 custom_domain = true：zone_name 传统路由在 assets 模式下易触发 522 回源超时');
  } else {
    ok(`Worker 自定义域 = ${routeMatch[1]}`);
  }
}

// 锚定行首：bucket_name 与 BUCKET_NAME 是两个不同的 TOML 键，不能互相误伤
const bucketMatch = toml.match(/^bucket_name\s*=\s*"([^"]+)"/m);
if (bucketMatch) ok('R2 bucket_name = ' + bucketMatch[1]);
else err(`${cfgPath} 缺少 R2 bucket_name`);

// 两处桶名必须一致：[[r2_buckets]] bucket_name 决定 Worker 绑定的桶，
// [vars] BUCKET_NAME 是 presigned 签名用的桶名（src/index.ts 的 S3 凭证）。
// 不一致 = 上传签到另一个桶，且在线上下载正常、只有上传默默写错地方。
const varsBucket = toml.match(/^BUCKET_NAME\s*=\s*"([^"]*)"/m);
if (!bucketMatch) {
  // 上面已报「缺少 bucket_name」，这里不重复报
} else if (!varsBucket) {
  warn('未设置 [vars] BUCKET_NAME：presigned 直传会拿不到桶名（走 Worker 中转时无影响）');
} else if (varsBucket[1] !== bucketMatch[1]) {
  err(
    `两处桶名不一致：[[r2_buckets]] bucket_name="${bucketMatch[1]}"，[vars] BUCKET_NAME="${varsBucket[1]}"\n` +
      '     BUCKET_NAME 用于 presigned 签名，不一致会把文件签到另一个桶'
  );
} else {
  ok(`两处桶名一致 = ${bucketMatch[1]}`);
}

// DL_DOMAIN：模板里是空串（本地/代理模式），只有生成物才要求是合法 URL
if (hasDeployCfg) {
  if (/^DL_DOMAIN\s*=\s*"https?:\/\/[^"]+"/m.test(toml)) {
    const dl = toml.match(/^DL_DOMAIN\s*=\s*"([^"]+)"/m)[1];
    ok('DL_DOMAIN = ' + dl);
  } else {
    err('DL_DOMAIN 未设置或格式异常（应形如 https://dl.example.com）');
  }
}

// 首页必须显式走 Worker：否则请求会先找同名静态文件，一旦 public/ 出现 index.html，
// 首页就绕过了 Worker —— 登录态注入与 window.__CFG__ 会静默失效。
if (/run_worker_first\s*=\s*\[[^\]]*"\//.test(toml)) {
  ok('run_worker_first 已显式包含 "/"（首页不依赖隐式回落）');
} else {
  warn('run_worker_first 未显式包含 "/"：首页会先查静态文件，public/ 一旦出现 index.html 就会绕过 Worker');
}

// 上传上限与 Workers 请求体上限的关系：顶格设置会让「通过本站校验」的文件被 CF 拦下。
// 锚定行首（与上面的 bucket_name / BUCKET_NAME / DL_DOMAIN 同口径）：不锚定会读到注释行里
// 的示例值，把「注释里写的数字」当成实际配置。
const maxMatch = toml.match(/^MAX_UPLOAD\s*=\s*"(\d+)"/m);
if (maxMatch) {
  const max = parseInt(maxMatch[1], 10);
  if (max === 0) ok('MAX_UPLOAD = 0（沿用 Workers 请求体上限）');
  else if (max >= 100_000_000) warn(`MAX_UPLOAD = ${max} 顶到 CF 账户请求体上限，建议留余量（如 99614720）`);
  else ok(`MAX_UPLOAD = ${(max / 1048576).toFixed(1)} MiB（在上限之内，留有余量）`);
} else {
  warn('wrangler.toml 未显式设置 MAX_UPLOAD（默认沿用 Workers 请求体上限）');
}

// KV 已移除：登录失败计数改为 Worker 内存 Map，绑定了反而说明配置没跟上
if (/\[\[kv_namespaces\]\]/.test(toml)) {
  warn('wrangler.toml 仍保留 [[kv_namespaces]]，但代码已改用内存限流——可以删掉这个绑定');
}

// 上传模式与凭证的匹配关系：
//   UPLOAD_VIA_WORKER=1 → 走 Worker 中转，完全不碰 S3，无需任何 R2 凭证；
//   UPLOAD_VIA_WORKER=0 → 浏览器直传 R2，必须配齐 S3 凭证，否则上传在签名阶段就 500。
const upw = toml.match(/UPLOAD_VIA_WORKER\s*=\s*"([^"]*)"/);
if (upw?.[1] === '1') {
  ok('UPLOAD_VIA_WORKER = 1（上传走 Worker 中转，无需 R2 S3 凭证）');
} else if (upw) {
  warn('UPLOAD_VIA_WORKER 未开启：上传走 presigned 直传，必须配好 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / 账户 id，否则上传必然失败');
} else {
  warn('未设置 UPLOAD_VIA_WORKER：将走 presigned 直传，需自行确保 R2 S3 凭证齐备且端点可达');
}

// 3. .dev.vars（本地开发）
section('3. .dev.vars');
if (!existsSync('.dev.vars')) {
  warn('.dev.vars 不存在——本地开发会用 npm run dev 默认行为，生产部署不受影响');
} else {
  const dev = await readFile('.dev.vars', 'utf8');

  const pwMatch = dev.match(/^ADMIN_PASSWORD\s*=\s*(.+)$/m);
  if (!pwMatch) {
    err('ADMIN_PASSWORD 未设置');
  } else if (['change-me', 'dev123456', 'password', 'admin', ''].includes(pwMatch[1].trim())) {
    warn('ADMIN_PASSWORD 是已知示例/弱口令：' + pwMatch[1]);
  } else if (pwMatch[1].trim().length < 8) {
    warn('ADMIN_PASSWORD 长度 < 8，强度偏弱');
  } else {
    ok('ADMIN_PASSWORD 已设置');
  }

  const secMatch = dev.match(/^SESSION_SECRET\s*=\s*(.+)$/m);
  if (!secMatch) {
    // 未配置不再是错误：运行时从 ADMIN_PASSWORD 确定性派生（见 src/mode.ts sessionSecretOf）
    ok('SESSION_SECRET 未设置——将自动从 ADMIN_PASSWORD 派生（换口令会失效所有旧会话）');
  } else if (['change-me', 'random-long-string-please-change', 'local-dev-secret-please-change', ''].includes(secMatch[1].trim())) {
    warn('SESSION_SECRET 是示例值，生产前请用 `openssl rand -hex 32` 重新生成');
  } else if (secMatch[1].trim().length < 32) {
    warn('SESSION_SECRET 长度 < 32，建议 32 字节以上随机串');
  } else {
    ok('SESSION_SECRET 已设置（长度 ' + secMatch[1].trim().length + '）');
  }

  // R2 S3 凭证是选填项：只有关闭 Worker 中转（UPLOAD_VIA_WORKER=0）走 presigned 直传才需要
  const hasR2 = /^R2_ACCESS_KEY_ID\s*=/.test(dev) && /^R2_SECRET_ACCESS_KEY\s*=/.test(dev);
  if (hasR2) {
    ok('R2 S3 API 凭证已配置——可用于 presigned 直传');
  } else {
    ok('R2 S3 API 凭证未配置——上传走 Worker 中转（默认模式），无需配置');
  }
}

// 4. cors（优先校验生成的 cors.deploy.json，否则退回模板 cors.json）
const corsPath = existsSync('cors.deploy.json') ? 'cors.deploy.json' : 'cors.json';
section('4. ' + corsPath);
let cors;
try {
  cors = JSON.parse(await readFile(corsPath, 'utf8'));
} catch (e) {
  err(corsPath + ' 不是合法 JSON：' + e.message);
}

if (cors) {
  // 支持 R2 API 嵌套格式：{ "rules": [{ "allowed": { "origins": [...], "methods": [...] } }] }
  const rule = Array.isArray(cors) ? cors[0] : cors.rules?.[0];
  const origins = rule?.allowed?.origins;
  const methods = rule?.allowed?.methods ?? rule?.AllowedMethods;
  if (!Array.isArray(origins)) {
    err('cors.json 结构异常：缺少 rules[].allowed.origins 数组（R2 API 格式见 https://developers.cloudflare.com/r2/buckets/cors/）');
  } else {
    const placeholders = origins.filter((o) =>
      /<[^>]+>|__[A-Z_]+__|TODO|FIXME/i.test(o)
    );
    if (placeholders.length) {
      // 命中即代表「gen-config 没跑过、或模板缺 __WORKER_ORIGIN__ 导致它跳过生成」——
      // 两种情况都是 CORS 确实没配好，走 err() 阻断是对的。
      // （原提示末尾额外声明了这个检查不阻断，与这里的 err() 自相矛盾，已把那句删掉；
      //   本注释刻意不复述原句，否则测试里的负向断言会被注释喂成假红。）
      err(
        `${corsPath} 仍有未替换的占位符 origin：${placeholders.join(', ')}\n` +
          '     先运行 `npm run gen-config` 生成 cors.deploy.json（会按 WORKER_DOMAIN 填好 origin），再执行：\n' +
          '     npx wrangler r2 bucket cors set <BUCKET_NAME> --file cors.deploy.json'
      );
    } else if (origins.length === 0) {
      err('cors.json allowed.origins 为空，浏览器无法上传');
    } else if (origins.includes('*')) {
      warn('allowed.origins 含 *，浏览器仍能 PUT 但推荐生产时改成具体域名');
    } else {
      ok('allowed.origins 已就绪：' + origins.join(', '));
    }

    if (!methods?.includes('PUT')) {
      err('allowed.methods 缺少 PUT，浏览器直传会被拒');
    } else {
      ok('allowed.methods 含 PUT/GET/HEAD');
    }
  }
}

// 5. 收尾
section(fail === 0 ? '\x1b[32m✅ 全部通过，可以部署\x1b[0m' : '\x1b[31m❌ 有 ' + fail + ' 项必须先修\x1b[0m');
if (fail > 0) {
  console.log('\n提示：上面所有 ✗ 项都是阻断性的，先修完再 wrangler deploy');
}
process.exit(fail > 0 ? 1 : 0);
