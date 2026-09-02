#!/usr/bin/env node
/**
 * 用本地私有配置填充 wrangler.toml 里的占位符，再调用 wrangler。
 *
 * 为什么需要它：wrangler.toml 是进仓库的，里面不能写 KV namespace id 这类账户资源
 * 标识；但 wrangler 又不接受命令行覆盖 KV 绑定（只有 --var / --define 能覆盖变量）。
 * 所以真实值放在被 .gitignore 排除的 .deploy.local.json，本脚本在运行时临时生成一份
 * 填好真实值的配置再交给 wrangler，用完立即删除。
 *
 * 用法：
 *   node scripts/with-config.mjs dev            # = wrangler dev
 *   node scripts/with-config.mjs deploy         # = wrangler deploy
 *   node scripts/with-config.mjs deploy -- --dry-run --outdir dist
 *                                               # -- 之后的参数原样透传给 wrangler
 *
 * 真实值来源优先级：环境变量 KV_ID > .deploy.local.json 的 kvId。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PLACEHOLDER, LOCAL_CFG, loadLocalCfg } from './local-config.mjs';

const TMP_CONFIG = '.wrangler.local.toml';

const mode = process.argv[2];
const passthrough = process.argv.slice(3).filter((a) => a !== '--');

if (!['dev', 'deploy'].includes(mode)) {
  console.error('用法：node scripts/with-config.mjs <dev|deploy> [-- <wrangler 额外参数>]');
  process.exit(1);
}

let toml;
try {
  toml = readFileSync('wrangler.toml', 'utf8');
} catch {
  console.error('✗ 找不到 wrangler.toml，请在项目根目录执行');
  process.exit(1);
}

const { kvId } = loadLocalCfg();

if (toml.includes(PLACEHOLDER)) {
  if (!kvId || kvId.includes('在这里填')) {
    console.error(`✗ wrangler.toml 里的 KV id 仍是占位符 ${PLACEHOLDER}，但没找到真实值。`);
    console.error('  修复：cp .deploy.local.example.json .deploy.local.json，然后填入');
    console.error('        npx wrangler kv namespace create r2share_kv 返回的 id');
    console.error('  CI 场景可用环境变量代替文件：KV_ID=<id> npm run deploy');
    process.exit(1);
  }
  toml = toml.split(PLACEHOLDER).join(kvId);
  console.log(`  · KV namespace id 已从本地私有配置注入（${kvId.slice(0, 8)}…），仓库内保持占位符`);
}

// 直接用 node 跑本地 wrangler 二进制，避免 npx 在 Windows 上的 .cmd 解析问题
const wranglerBin = 'node_modules/wrangler/bin/wrangler.js';
const useBin = existsSync(wranglerBin);
const cmd = useBin ? process.execPath : 'npx';
const args = useBin
  ? [wranglerBin, mode, '--config', TMP_CONFIG, ...passthrough]
  : ['wrangler', mode, '--config', TMP_CONFIG, ...passthrough];

let exitCode = 1;
try {
  writeFileSync(TMP_CONFIG, toml);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  exitCode = r.status ?? 1;
} finally {
  try {
    unlinkSync(TMP_CONFIG);
  } catch {
    /* 临时文件本就不存在，忽略 */
  }
}
process.exit(exitCode);
