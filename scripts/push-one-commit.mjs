#!/usr/bin/env node
/**
 * 一次推送多个文件到 GitHub（单 commit，Git Data API）
 *
 * 为什么需要它：push-gh.sh 走 GitHub Contents API 逐文件 PUT，
 * 每个文件 = 一个 commit = 触发一次 CI workflow。本脚本改用
 * Git Data API（blobs → trees → commits → refs），把多个文件合并成
 * 【一个 commit】更新 main 分支 ref，CI 只触发一次。
 *
 * 用法：
 *   export GH_TOKEN="ghp_xxx"        # 需要 repo scope
 *   node scripts/push-one-commit.mjs public/app.js public/style.css src/views.ts
 *
 * 说明：
 *   - 只推送列出的文件；未列出的远程文件通过 base_tree 自动继承，不会丢失
 *   - 只处理 git 已跟踪的文件（防误传私有文件）
 *   - 若某文件在远程不存在也会正常工作（blob 建好后进 tree 即可）
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = process.env.GH_REPO || 'weipu2026/r2-share';
const BRANCH = process.env.GH_BRANCH || 'main';
const TOKEN = process.env.GH_TOKEN;
const AUTHOR = { name: 'r2share-deploy', email: 'r2share@users.noreply.github.com' };

if (!TOKEN) {
  console.error('✗ 请先设置环境变量 GH_TOKEN（GitHub PAT，需 repo scope）');
  process.exit(1);
}
const files = process.argv.slice(2);
if (!files.length) {
  console.error('✗ 用法：node scripts/push-one-commit.mjs <file1> [file2 ...]');
  process.exit(1);
}

const api = `https://api.github.com/repos/${REPO}`;
async function gh(path, opts = {}) {
  const res = await fetch(api + path, {
    ...opts,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'r2share-push',
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// 校验文件被 git 跟踪，防止误传私有文件
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const valid = [];
for (const f of files) {
  if (!tracked.includes(f)) { console.log(`SKIP ${f}（未被 git 跟踪，拒绝上传）`); continue; }
  valid.push(f);
}
if (!valid.length) {
  console.error('没有可推送的文件');
  process.exit(1);
}

// 1) 为每个文件创建 blob
// GitHub blob API 的 content 为 base64 时，必须显式声明 encoding: "base64"，
// 否则 GitHub 会把 base64 字符串当 utf-8 文本原样存入（文件损坏成 base64 文本）。
const blobs = [];
for (const f of valid) {
  const content = readFileSync(f).toString('base64');
  const b = await gh('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'base64' }),
  });
  blobs.push({ path: f, sha: b.sha });
  console.log(`  · blob ${f} -> ${b.sha.slice(0, 7)}…`);
}

// 2) 读取当前 HEAD 的 commit 与 tree（base_tree 用）
const ref = await gh(`/git/ref/heads/${BRANCH}`);
const commit = await gh(`/git/commits/${ref.object.sha}`);
console.log(`当前 HEAD：${ref.object.sha.slice(0, 10)}…`);

// 3) 构造新 tree（base_tree 继承未改动的文件）
const tree = await gh('/git/trees', {
  method: 'POST',
  body: JSON.stringify({
    base_tree: commit.tree.sha,
    tree: blobs.map(({ path, sha }) => ({ path, mode: '100644', type: 'blob', sha })),
  }),
});

// 4) 创建 commit（parent = 当前 HEAD）
const newCommit = await gh('/git/commits', {
  method: 'POST',
  body: JSON.stringify({
    message: `chore: update ${valid.join(', ')}`,
    tree: tree.sha,
    parents: [ref.object.sha],
    author: AUTHOR,
  }),
});

// 5) 更新分支 ref（只触发一次 push 事件 → 一次 CI run）
await gh(`/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: newCommit.sha, force: false }),
});

console.log('-----------------------------');
console.log(`成功推送 ${valid.length} 个文件（${blobs.length} 个 blob），单 commit：${newCommit.sha.slice(0, 10)}…`);
console.log(`CI 将只触发 1 次`);
