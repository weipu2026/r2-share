#!/usr/bin/env node
/**
 * 部署前配置生成器 —— 把「因人而异」的域名/桶名/站名从环境变量注入模板，
 * 产出真正的部署配置。
 *
 *   模板 wrangler.toml  +  环境变量/Secrets  →  wrangler.deploy.toml
 *   模板 cors.json      +  WORKER_DOMAIN      →  cors.deploy.json
 *
 * 为什么需要这一步：wrangler 不支持在 wrangler.toml 里插值环境变量，
 * custom_domain 路由更是结构化字段，只能由脚本拼出来。有了它，
 * 「域名放进 GitHub Secrets、必填、不填就部署失败」才落得了地，
 * 同时仓库里不会残留任何人的真实域名（fork-safe）。
 *
 * 取值优先级：process.env（CI 注入 Secrets）→ .dev.vars（本地开发）
 *
 * 必填：WORKER_DOMAIN   Worker 站点入口域，如 file.example.com（不带协议头）
 *       DL_DOMAIN       R2 下载直链域，如 dl.example.com 或 <id>.r2.dev
 * 选填：BUCKET_NAME     R2 桶名，默认 r2share
 *       SITE_NAME       站点名，默认 我的仓库
 *
 * 任一必填项缺失/非法 → 打印原因并 exit 1（CI 会因此中断，符合「必填」语义）。
 *
 * 用法：
 *   node scripts/gen-config.mjs                    # CI / 本地部署，读环境变量
 *   WORKER_DOMAIN=file.x.com DL_DOMAIN=dl.x.com node scripts/gen-config.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

const TMPL_TOML = 'wrangler.toml';
const OUT_TOML = 'wrangler.deploy.toml';
const TMPL_CORS = 'cors.json';
const OUT_CORS = 'cors.deploy.json';

const errors = [];
const err = (m) => errors.push(m);
const info = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const warn = (m) => console.log('  \x1b[33m⚠\x1b[0m ' + m);

/* ---------------- 取值：env 优先，其次 .dev.vars ---------------- */

/** 解析 .dev.vars（KEY=VALUE，支持去掉成对引号；忽略注释与空行） */
function loadDevVars() {
  if (!existsSync('.dev.vars')) return {};
  const out = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const devVars = loadDevVars();
const get = (name) => {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = devVars[name];
  return fromFile !== undefined && fromFile !== '' ? fromFile : undefined;
};

/* ---------------- 校验 ---------------- */

// 合法主机名（允许多级子域）；不含协议、不含路径
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// 明显的占位/示例值（含模板自带的 __TOKEN__）
const PLACEHOLDER_RE =
  /__|<[^>]*>|example\.(com|org|net)$|your-?domain|yourdomain|changeme|placeholder|^todo$/i;

/** 去掉协议头、路径、端口前的空白，统一小写 */
function normHost(raw) {
  return String(raw)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function requireHost(label, envName) {
  const raw = get(envName);
  if (!raw) {
    err(`${envName} 未设置（${label}）。在 GitHub 仓库 Settings → Secrets and variables → Actions 的 Variables（或 Secrets）里添加；本地开发可写进 .dev.vars`);
    return null;
  }
  const host = normHost(raw);
  if (PLACEHOLDER_RE.test(host)) {
    err(`${envName} 仍是占位/示例值：${host}。请填入你自己的真实域名`);
    return null;
  }
  if (!HOST_RE.test(host)) {
    err(`${envName} 不是合法域名：${raw}（应形如 file.example.com，不带 http:// 前缀与路径）`);
    return null;
  }
  return host;
}

/* ---------------- 主流程 ---------------- */

console.log('\n\x1b[1m生成部署配置\x1b[0m');

const workerDomain = requireHost('Worker 站点入口域', 'WORKER_DOMAIN');
const dlHost = requireHost('R2 下载直链域', 'DL_DOMAIN');

// 选填项：留空即取默认桶名；但**填错不回退** ——
// 静默回退会把文件写进另一个桶，而且 bucket_name 与 BUCKET_NAME 会一起被改成同一个默认值，
// 于是 check-deploy 的「两处桶名一致」检查依然通过，属最难排查的一类失误。填错就停下让人改。
let bucketName = get('BUCKET_NAME') || 'r2share';
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)) {
  err(`BUCKET_NAME「${bucketName}」不符合 R2 命名规则（3–63 位小写字母/数字/连字符）`);
}

let siteName = get('SITE_NAME') || '我的仓库';
// 注入 TOML 双引号字符串，需转义反斜杠与引号；顺带压掉换行
siteName = siteName.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

if (errors.length) {
  console.log('\n\x1b[31m✗ 缺失/非法的必填配置：\x1b[0m');
  for (const e of errors) console.log('    · ' + e);
  console.log(
    '\n  这是 GitHub 一键部署的硬性必填项（缺一不可）：' +
      '\n    WORKER_DOMAIN   Worker 站点入口域，如 file.<你的域名>' +
      '\n    DL_DOMAIN       R2 下载直链域，如 dl.<你的域名> 或 <id>.r2.dev' +
      '\n  两项都是「配置」不是「密钥」，建议放在仓库 Settings → Secrets and variables →' +
      '\n  Actions 的 **Variables** 页（明文可见、随时可改），放 Secrets 页也支持。' +
      '\n  本地开发可把这两项写进 .dev.vars。\n'
  );
  process.exit(1);
}

/* ---- wrangler.deploy.toml ---- */

const tmpl = await readFile(TMPL_TOML, 'utf8');
if (!/^#\s*gen:routes\s*$/m.test(tmpl)) {
  err(`${TMPL_TOML} 缺少注入点 "# gen:routes"，无法写入自定义域路由`);
}
// 路由块必须在 [assets] 表之后、[[r2_buckets]] 之前，替换注入点即可满足
const routesBlock = `[[routes]]\npattern = "${workerDomain}"\ncustom_domain = true`;
let toml = tmpl.replace(/^#\s*gen:routes\s*$/m, routesBlock);

/**
 * 按 TOML 键名覆盖引号字符串值（只动那一行，注释与其它行原样保留）。
 *
 * 为什么不用「__TOKEN__ 字符串替换」：模板里的值必须保持**合法**——wrangler 会校验
 * 字段格式（桶名必须 3-63 位小写字母/数字/连字符），非法占位符会让 `wrangler dev`
 * 在**配置解析阶段**直接退出，程序根本没机会运行本地模式。
 * 按键名覆盖对「合法默认值」与「旧式 token」两种模板都成立，也更抗模板微调。
 */
function setKey(src, key, value) {
  // 锚定行首：bucket_name 与 BUCKET_NAME 是 TOML 里两个不同的键，不能互相误伤
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'm');
  if (!re.test(src)) return null;
  return src.replace(re, (_m, indent) => `${indent}"${value}"`);
}

for (const [key, value, label] of [
  ['bucket_name', bucketName, 'R2 桶名（[[r2_buckets]]）'],
  ['BUCKET_NAME', bucketName, 'R2 桶名（[vars]，须与上者一致）'],
  ['DL_DOMAIN', `https://${dlHost}`, '下载直链域'],
  ['SITE_NAME', siteName, '站点名'],
]) {
  const next = setKey(toml, key, value);
  if (next === null) err(`${TMPL_TOML} 找不到可覆盖的键 ${key}（${label}）`);
  else toml = next;
}

// 兜底：生成物里不该再有 __TOKEN__（防模板被改回占位符、而本脚本没同步跟上）
const leftover = toml.match(/__(?:BUCKET_NAME|DL_DOMAIN|SITE_NAME|WORKER_DOMAIN)__/g);
if (leftover) err(`生成的配置仍残留占位符：${[...new Set(leftover)].join(', ')}`);

if (errors.length) {
  console.log('\n\x1b[31m✗ 模板结构异常：\x1b[0m');
  for (const e of errors) console.log('    · ' + e);
  console.log('');
  process.exit(1);
}

await writeFile(OUT_TOML, toml, 'utf8');
info(`已生成 ${OUT_TOML}`);
info(`  Worker 入口域 = ${workerDomain}（custom_domain）`);
info(`  下载直链域   = https://${dlHost}`);
info(`  R2 桶名      = ${bucketName}`);
info(`  站点名       = ${siteName}`);

/* ---- cors.deploy.json（让浏览器上传的跨域预检能过） ---- */

if (existsSync(TMPL_CORS)) {
  const corsTmpl = await readFile(TMPL_CORS, 'utf8');
  if (!corsTmpl.includes('__WORKER_ORIGIN__')) {
    warn(`${TMPL_CORS} 缺少占位符 __WORKER_ORIGIN__，跳过 CORS 生成`);
  } else {
    const cors = corsTmpl.split('__WORKER_ORIGIN__').join(`https://${workerDomain}`);
    JSON.parse(cors); // 结构不合法就让 JSON.parse 抛错，避免写出坏文件
    await writeFile(OUT_CORS, cors, 'utf8');
    info(`已生成 ${OUT_CORS}（origin 含 https://${workerDomain}）`);
  }
}

console.log('\n\x1b[32m✅ 配置生成完成，可以部署\x1b[0m\n');
