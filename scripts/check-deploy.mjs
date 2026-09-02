#!/usr/bin/env node
/**
 * 部署前自检：抓 wrangler.toml / .dev.vars / cors.json 里的常见配置坑。
 * 不替代 wrangler deploy 自身的校验，但能提前挡住下面这些 90% 会踩的失误：
 *   - KV namespace id 还是占位符
 *   - R2 CORS AllowedOrigins 还有未替换的占位符
 *   - 管理口令 / 会话密钥是示例值
 *
 * 用法：npm run check
 * 退出码：0 通过；1 有必须先修的项
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { PLACEHOLDER, LOCAL_CFG, resolveKvId } from './local-config.mjs';

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

// 2. wrangler.toml
section('2. wrangler.toml');
const toml = await readFile('wrangler.toml', 'utf8');

// 仓库里保持占位符，真实值来自本地私有配置（.deploy.local.json / 环境变量 KV_ID）
const kvId = resolveKvId(toml);
if (!toml.match(/id\s*=\s*"([^"]+)"/)) {
  err('wrangler.toml 找不到 [[kv_namespaces]] 的 id 配置');
} else if (!kvId) {
  err(
    `KV namespace id 还是占位符 ${PLACEHOLDER}，且本地私有配置里没有真实值\n` +
      `     修复：cp .deploy.local.example.json .deploy.local.json，填入\n` +
      `           npx wrangler kv namespace create r2share_kv 返回的 id\n` +
      `     CI 场景可改用环境变量：KV_ID=<id> npm run deploy`
  );
} else if (/^[a-f0-9]{20,}$/.test(kvId)) {
  ok('KV namespace id 就绪：' + kvId.slice(0, 8) + '…（真实值存于本地私有配置，仓库内保持占位符）');
} else {
  warn('KV namespace id 格式异常（' + kvId + '），应为 32 位十六进制，请人工确认');
}

// 隐私护栏：确认本地私有配置不会被提交进仓库
if (existsSync(LOCAL_CFG)) {
  let ignored = false;
  try {
    execSync(`git check-ignore -q ${LOCAL_CFG}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    ignored = true;
  } catch {
    /* 非 git 仓库或未被忽略 */
  }
  if (ignored) ok(`${LOCAL_CFG} 已被 git 忽略，不会进入仓库`);
  else err(`${LOCAL_CFG} 没有被 .gitignore 排除——真实 KV id 会被提交，请先加进 .gitignore`);
}

const bucketMatch = toml.match(/bucket_name\s*=\s*"([^"]+)"/);
if (bucketMatch) ok('R2 bucket_name = ' + bucketMatch[1]);
else err('wrangler.toml 缺少 R2 bucket_name');

if (/DL_DOMAIN\s*=\s*"https?:\/\/[^"]+"/.test(toml)) {
  const dl = toml.match(/DL_DOMAIN\s*=\s*"([^"]+)"/)[1];
  ok('DL_DOMAIN = ' + dl);
} else {
  err('DL_DOMAIN 未设置或格式异常（应形如 https://dl.114448.xyz）');
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
    err('SESSION_SECRET 未设置');
  } else if (['change-me', 'random-long-string-please-change', 'local-dev-secret-please-change', ''].includes(secMatch[1].trim())) {
    warn('SESSION_SECRET 是示例值，生产前请用 `openssl rand -hex 32` 重新生成');
  } else if (secMatch[1].trim().length < 32) {
    warn('SESSION_SECRET 长度 < 32，建议 32 字节以上随机串');
  } else {
    ok('SESSION_SECRET 已设置（长度 ' + secMatch[1].trim().length + '）');
  }

  // 生产 secrets 提醒
  const hasR2 = /^R2_ACCESS_KEY_ID\s*=/.test(dev) && /^R2_SECRET_ACCESS_KEY\s*=/.test(dev);
  if (hasR2) {
    ok('R2 S3 API 凭证已配置——本地 dev 会使用真实 R2（不再是回退模式）');
  } else {
    ok('R2 S3 API 凭证未配置——本地 dev 自动走回退模式（适合纯前端调试）');
  }
}

// 4. cors.json
section('4. cors.json');
let cors;
try {
  cors = JSON.parse(await readFile('cors.json', 'utf8'));
} catch (e) {
  err('cors.json 不是合法 JSON：' + e.message);
}

if (cors) {
  // 支持 R2 API 嵌套格式：{ "rules": [{ "allowed": { "origins": [...], "methods": [...] } }] }
  const rule = Array.isArray(cors) ? cors[0] : cors.rules?.[0];
  const origins = rule?.allowed?.origins;
  const methods = rule?.allowed?.methods ?? rule?.AllowedMethods;
  if (!Array.isArray(origins)) {
    err('cors.json 结构异常：缺少 rules[].allowed.origins 数组（R2 API 格式见 https://developers.cloudflare.com/r2/buckets/cors/）');
  } else {
    const placeholders = origins.filter((o) => /<[^>]+>|TODO|FIXME|pan\.114448/.test(o));
    if (placeholders.length) {
      err('cors.json 仍有未替换的占位符 origin：' + placeholders.join(', ') + '\n     流程：首次 wrangler deploy → 拿到 Worker 实际 URL → 替换 cors.json → wrangler r2 bucket cors set r2share --file cors.json');
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