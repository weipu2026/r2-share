/**
 * 本地私有部署配置的读取（供 check-deploy.mjs / with-config.mjs 共用）。
 *
 * 仓库里的 wrangler.toml 只放占位符，真实值在这里：
 *   环境变量 KV_ID  >  .deploy.local.json 的 kvId
 * .deploy.local.json 已被 .gitignore 排除，不会进仓库。
 */
import { readFileSync, existsSync } from 'node:fs';

export const PLACEHOLDER = 'r2share_kv_placeholder';
export const LOCAL_CFG = '.deploy.local.json';

/** @returns {{ kvId?: string }} */
export function loadLocalCfg() {
  const cfg = {};
  if (existsSync(LOCAL_CFG)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(LOCAL_CFG, 'utf8')));
    } catch (e) {
      console.error(`✗ ${LOCAL_CFG} 不是合法 JSON：${e.message}`);
      process.exit(1);
    }
  }
  if (process.env.KV_ID) cfg.kvId = process.env.KV_ID;
  return cfg;
}

/**
 * 解析出真正会生效的 KV id。
 * 占位符 + 本地私有配置有真实值 → 返回真实值（仓库保持干净，部署时注入）
 * @returns {string|null}
 */
export function resolveKvId(tomlText) {
  const m = tomlText.match(/id\s*=\s*"([^"]+)"/);
  if (!m) return null;
  if (m[1] !== PLACEHOLDER) return m[1];
  const { kvId } = loadLocalCfg();
  return kvId && !kvId.includes('在这里填') ? kvId : null;
}
