# r2share

基于 Cloudflare Worker + R2 的零费用个人仓库（我的仓库）。

单文件 < 100MB、总量 < 10GB、全部公开、以分享下载为主的场景下，**月成本严格为 $0**。

---

## 界面预览

未登录列表视图（默认）：
![home](.ui-home.png)

未登录网格视图：
![grid](.ui-grid.png)

登录后顶部多出「重建索引 / 上传 / 退出」三个按钮，文件行 hover 出现删除按钮：
![login](.ui-login.png)

README.md 预览弹层（标题右侧「下载」按钮直链下载）：
![preview](.ui-preview.png)

搜索无结果时的空态（与「目录为空」文案分开）：
![search-empty](.ui-search-empty.png)

---

## 架构

```
浏览器
 ├─ 打开目录页   ──→ Worker 渲染 HTML（1 次请求；style.css/app.js 由 CF 边缘直接服务，0 次 Worker）
 │                      └─ fetch R2 上的 files.json（1 次 Class B 读）
 ├─ 下载文件     ──→ R2 公开桶直链 dl.114448.xyz（出口永远免费，不经过 Worker）
 └─ 上传文件     ──→ Worker 签名（1 次请求）→ 浏览器 presigned PUT 直传 R2
                                          → Worker 写索引（1 次请求）
```

三条通道里，**下载完全不经过 Worker**；浏览只有首页 HTML 消耗 1 次 Worker 请求
（静态资源由 CF 边缘直接服务，免费且无上限）。这是能做到零费用且抗刷的关键。

### 请求消耗

| 动作 | Workers 请求 | R2 操作 | 费用 |
| --- | --- | --- | --- |
| 浏览目录页 | 1（渲染 HTML） | 1 × Class B（读 files.json） | $0 |
| 下载文件 | 0（公开桶直链） | 1 × Class B | $0 |
| 上传 1 个文件 | 2（签名 + 写索引） | 2 × Class A + 2 × Class B（见下） | $0 |

> 上传明细：presigned PUT 文件（1 Class A）+ commit 校验 head（1 Class B）
> + 读 files.json（1 Class B）+ 写 files.json（1 Class A）。删除文件时对象删除免费。

### 免费额度边界（超出才收费）

| 额度 | 免费上限 | 超出单价 |
| --- | --- | --- |
| R2 存储 | 10 GB | $0.015/GB-月 |
| Workers 请求 | 10 万/天 | 需升级 $5/月套餐 |
| R2 Class A（写 / list） | 100 万/月 | $4.50/百万 |
| R2 Class B（读） | 1000 万/月 | $0.36/百万 |
| 出口流量 | **永久免费** | — |

---

## 部署步骤

### 0. 部署前自检（强烈推荐）

```bash
npx wrangler login   # 浏览器授权（或用 CLOUDFLARE_API_TOKEN 环境变量）
npm run check
```

这个脚本会扫描 `wrangler.toml` / `.deploy.local.json` / `.dev.vars` / `cors.json` 的常见
占位符和弱口令，有问题直接退出码 1 并告诉你怎么修。`npm run deploy` 内部会自动跑这一步。

它还会校验 `.deploy.local.json` 确实被 git 忽略——防止真实 KV id 被误提交进仓库。

### 1. 创建 R2 桶

```bash
npx wrangler r2 bucket create r2share
```

### 2. 开启公开访问并绑定自定义域

在 Cloudflare 控制台 → R2 → 你的桶 → Settings：

- **Public access** 选 `Allow`，会得到一个 `r2.dev` 域名
- 在 **Custom Domains** 里绑定 `dl.114448.xyz`

> ⚠️ 必须用自定义域。`r2.dev` 官方明确限流、不推荐生产使用。

### 3. 创建 KV 命名空间

```bash
npx wrangler kv namespace create r2share_kv
```

把返回的 id 填进**本地私有配置**，不要写进 `wrangler.toml`：

```bash
cp .deploy.local.example.json .deploy.local.json
# 编辑 .deploy.local.json，把 kvId 换成上面命令返回的 id（32 位十六进制）
```

> **为什么绕这一层**：KV namespace id 属于账户资源标识，写进 `wrangler.toml` 会随公开
> 仓库一起泄露。所以仓库里只保留占位符 `r2share_kv_placeholder`，真实值放在被
> `.gitignore` 排除的 `.deploy.local.json`；`npm run dev` / `npm run deploy` 会由
> `scripts/with-config.mjs` 在运行时把占位符替换成真实值——临时生成
> `.wrangler.local.toml` 交给 wrangler，跑完立即删除。
>
> 由此两条纪律：
> 1. **不要直接执行 `wrangler deploy`**——读到占位符会失败。统一用 `npm run deploy`。
> 2. CI 等不方便落文件的场景，用环境变量代替：`KV_ID=<id> npm run deploy`。

### 配置与隐私边界

| 内容 | 放哪 | 是否进仓库 |
| --- | --- | --- |
| KV namespace id（账户资源标识） | `.deploy.local.json` 的 `kvId` / 环境变量 `KV_ID` | ❌ 仓库里只有占位符 |
| 管理口令、会话密钥、R2 API 密钥 | `wrangler secret`（生产）/ `.dev.vars`（本地） | ❌ |
| 桶名、下载域名、站点名、路由域名 | `wrangler.toml` 的 `[vars]` / `[[routes]]` | ✅ 这些本就是公开信息 |

### 4. 设置密钥

```bash
npx wrangler secret put ADMIN_PASSWORD      # 管理口令
npx wrangler secret put SESSION_SECRET      # openssl rand -hex 32 生成
npx wrangler secret put R2_ACCESS_KEY_ID    # R2 → S3 API 令牌
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_ACCOUNT_ID
```

R2 的 S3 API 令牌在控制台 R2 概览页右侧「Manage R2 API Tokens」创建，权限选 Object Read & Write。

### 5. 修改配置

编辑 `wrangler.toml`：

```toml
[vars]
BUCKET_NAME = "r2share"
DL_DOMAIN   = "https://dl.114448.xyz"   # 第 2 步绑定的域名
SITE_NAME   = "我的仓库"
```

### 6. 首次部署

```bash
npm run deploy
```

> 第一次 deploy 后 Cloudflare 会分配一个 Worker URL，形如
> `r2share.<account-subdomain>.workers.dev`，**记下这个 URL**——下一步 CORS 需要。

### 7. 配置 CORS（首次 deploy 之后才能填对）

浏览器直传是跨域 PUT，必须在桶上放行。**第一次 deploy 之后**，把 Worker URL
填进 `cors.json` 的 `allowed.origins`（替换 `<your-worker-domain>`），然后：

```bash
npx wrangler r2 bucket cors set r2share --file cors.json
```

> ⚠️ `cors.json` 必须用**新版嵌套格式**：`{"rules":[{"allowed":{"origins":[],"methods":[],"headers":[]}}]}`。
> 允许的请求头字段是 `allowed` 对象内的 **`headers`**（不是外层 `allowedHeaders`——
> 字段名/层级错误会被 R2 API 静默忽略，导致浏览器跨域预检失败、上传卡死）。
> 其余字段驼峰命名（`exposeHeaders` / `maxAgeSeconds`）。
> 旧版裸数组 / PascalCase 格式（`AllowedOrigins`）会让 R2 API 报 `code 10040 "JSON not well formed"`。
> 参考 `cors.json` 仓库内已有内容。

> 为什么不在 deploy 前填？因为 Worker URL 在 deploy 后才存在。
> 部署前 `npm run check` 会主动提示这一项未就绪。

### 8. 绑定 Worker 自定义域（推荐，无需手动配 DNS）

如果想用自定义域名（如 `file.114448.xyz`），在 `wrangler.toml` 里用
`custom_domain = true`（而不是 `zone_name`）——Cloudflare 会自动创建 DNS 记录与证书：

```toml
[[routes]]
pattern = "file.114448.xyz"
custom_domain = true
```

> ⚠️ 不要用 `zone_name` 传统路由 + 手动 A 记录的方式：在 assets 模式下，
> 传统路由会被当作 assets 路径匹配（部署时警告 "Will match assets: public\<pattern>"），
> 且手动添加的 A 记录会因回源超时导致 **522 Connection timed out**。
> `custom_domain = true` 部署后，所有路径直达 Worker，无需在 DNS 控制台做任何操作。

加完后回到第 7 步，把 `cors.json` 的 `<your-worker-domain>` 改成这个新域名再应用。

---

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars             # 按需改口令
cp .deploy.local.example.json .deploy.local.json   # 填真实 KV id（见第 3 步）
npm run dev                      # http://127.0.0.1:8787
node scripts/seed.mjs            # 灌入演示数据
node scripts/smoke.mjs           # 跑全流程冒烟测试（32 项）
node scripts/test-crypto.mjs     # AWS SigV4 签名 vs 官方向量对拍
npm run check                    # 部署前自检
```

生产浏览器 E2E（真实 Edge 登录→上传→渲染→dl 下载→删除，9 项断言）：

```bash
NODE_PATH="<playwright-core 所在 node_modules 目录>" node e2e-prod.mjs
```

脚本内 `BASE` / `PASS` 按生产环境修改；依赖外部 playwright-core（不在本项目 package.json）。

本地没有 R2 的 S3 凭证时，程序会自动进入**回退模式**：上传下载改走 Worker 代理
（`/api/local-put`、`/api/local-get`、`/api/local-index`）。一旦配上凭证，这些路由自动拒绝服务。

---

## 日常使用

- **上传**：登录后在网页上拖拽，或 `npx wrangler r2 object put r2share/路径/文件 -f ./文件`
- **批量同步**：用 rclone 挂 S3 端点操作
- **删除**：网页端登录后可删，或 rclone
- **重建索引**：凡是绕过网页上传的写操作（rclone / 后台 / API），文件列表都会和
  `files.json` 对不上。**登录后点页面右上角的「重建索引」按钮**即可对齐（或调接口）：

  ```bash
  curl -X POST https://你的域名/api/refresh \
    -H "cookie: r2share_session=<登录后拿到的值>"
  ```

  实现为游标分页遍历全桶（每页 1000 个对象），list 的等待时间不计入 CPU，
  数千个文件内免费版 10ms 限制够用。日常网页上传不需要它——那是增量提交。

### 在线预览

图片、视频、音频走浏览器原生能力；文本/代码（≤2MB）和 Markdown 在弹窗内渲染，
Markdown 支持标题 / 列表 / 表格 / 代码块 / 引用 / 任务清单。其余类型直接下载。

### 备份到 Backblaze B2（零成本双活）

B2 同样有 10GB 免费额度，且与 Cloudflare 是带宽联盟、互传流量免费：

```bash
rclone sync r2:r2share b2:你的桶 --progress
```

建议每月跑一次。

---

## 设计约束（改动代码前请先看）

1. **URL 必须是真实文件路径**，不能改成 `/api/file?id=123` 这类依赖程序路由的形式。
   这样将来换到任何 S3 服务商，只需改域名前缀，已分享出去的链接结构不变。
2. **下载不能经过 Worker**。一旦改成 Worker 中转，就会撞上 10 万请求/天的天花板。
3. **索引更新默认走增量**（`upsertFile`）；`/api/refresh` 全量重建只用于对账，
   不要在常规流程里频繁调用——免费版 CPU 只有 10ms。
4. 所有插入 HTML 的动态内容必须过 `esc()`；文本预览必须用 `textContent` 注入。
5. **账户标识不进仓库**：KV namespace id 这类账户资源标识只写进 `.deploy.local.json`
   或环境变量，`wrangler.toml` 保持占位符。新增任何带账户 id 的绑定时，同步更新
   `scripts/local-config.mjs` 的解析逻辑和 `scripts/with-config.mjs` 的注入逻辑。

## 已知限制

- 没有网页端的文件重命名 / 移动 / 打包下载（R2 无 rename，目录移动是 O(n) 操作），需要时用 rclone
- 目录页不是严格实时：`files.json` 缓存 10 秒
- 上传接口有登录保护，但文件本身是公开的（这是设计选择）
- presigned PUT URL 只绑定路径和 1 小时有效期，**不绑定文件大小**：`/api/sign`
  的 size 上限校验是业务约束（默认 100MB），拿到签名 URL 后实际可传更大文件。
  上传需登录 + 签名 URL 仅 1 小时有效，对个人站可接受；若担心存储超限，
  可在 R2 桶生命周期规则里设对象大小上限或定期清理
