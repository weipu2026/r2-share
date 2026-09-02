#!/usr/bin/env bash
#
# 同步本地已跟踪文件到 GitHub 仓库。
#
# 为什么不用 git push：本沙箱代理只放行 api.github.com，拦截 github.com，
# git 协议永远超时。故改走 GitHub Contents API 逐文件 PUT。
#
# 用法：
#   export GH_TOKEN="ghp_xxx"        # 需要 repo scope
#   bash scripts/push-gh.sh          # 同步全部已跟踪文件
#   bash scripts/push-gh.sh src/index.ts public/app.js   # 只同步指定文件
#
# 说明：
#   - 自动 upsert：文件已存在时先取 sha 再更新，不存在则新建
#   - 只同步 git 已跟踪的文件，.gitignore 排除的（.dev.vars / .deploy.local.json）天然不会上传
#   - 大文件走 body 文件而非命令行参数，规避 "Argument list too long"
#
set -u
cd "$(dirname "$0")/.."

REPO="${GH_REPO:-weipu2026/r2-share}"
BRANCH="${GH_BRANCH:-main}"
AUTHOR_NAME="r2share-deploy"
AUTHOR_EMAIL="r2share@users.noreply.github.com"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "✗ 请先设置环境变量 GH_TOKEN（GitHub PAT，需 repo scope）"
  exit 1
fi

# 列出待同步文件：有参数用参数，否则用 git ls-files
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=()
  while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(git ls-files)
fi

ok=0 fail=0 skip=0
for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "SKIP  $f (文件不存在)"
    skip=$((skip + 1)); continue
  fi
  if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    echo "SKIP  $f (未被 git 跟踪，拒绝上传以防误传私有文件)"
    skip=$((skip + 1)); continue
  fi

  # 已存在的文件必须先带 sha，否则 PUT 返回 422
  sha=""
  meta=$(curl -s -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" -H "User-Agent: r2share-push" \
    "https://api.github.com/repos/${REPO}/contents/${f}?ref=${BRANCH}")
  if printf '%s' "$meta" | grep -q '"sha"'; then
    sha=$(printf '%s' "$meta" | tr ',' '\n' | grep '"sha"' | head -1 \
      | sed 's/.*"sha" *: *"\(.*\)"/\1/')
  fi

  # base64 输出仅含 A-Za-z0-9+/=，无需 JSON 转义
  b64=$(base64 -w 0 "$f" 2>/dev/null || base64 "$f" | tr -d '\n')
  if [ -n "$sha" ]; then
    body=$(printf '{"message":"chore: update %s","branch":"%s","sha":"%s","content":"%s","author":{"name":"%s","email":"%s"}}' \
      "$f" "$BRANCH" "$sha" "$b64" "$AUTHOR_NAME" "$AUTHOR_EMAIL")
  else
    body=$(printf '{"message":"feat: add %s","branch":"%s","content":"%s","author":{"name":"%s","email":"%s"}}' \
      "$f" "$BRANCH" "$b64" "$AUTHOR_NAME" "$AUTHOR_EMAIL")
  fi
  printf '%s' "$body" > ./.push_body.json

  code=$(curl -s -o ./.push_resp.json -w "%{http_code}" -X PUT \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: r2share-push" \
    -H "Content-Type: application/json" \
    --data-binary @./.push_body.json \
    "https://api.github.com/repos/${REPO}/contents/${f}")

  case "$code" in
    200|201) echo "OK    $f (HTTP $code)"; ok=$((ok + 1));;
    *)       echo "FAIL  $f (HTTP $code)"; head -c 300 ./.push_resp.json; echo; fail=$((fail + 1));;
  esac
done

rm -f ./.push_body.json ./.push_resp.json
echo "-----------------------------"
echo "成功 $ok · 失败 $fail · 跳过 $skip"
[ "$fail" -eq 0 ]
