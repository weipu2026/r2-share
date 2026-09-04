/**
 * 首页 HTML 模板
 *
 * 注意：所有注入到 HTML 的变量一律先过 esc() 转义。
 * 原 PHP 版正是把文件名直接拼进 onclick="..." 才留下了 XSS 隐患。
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderOptions {
  siteName: string;
  dlDomain: string;
  isLogin: boolean;
  /** 本地开发标记：未配置 R2 凭证时，读写改走 Worker 代理 */
  local: boolean;
}

export function renderIndex(opts: RenderOptions): string {
  const { siteName, dlDomain, isLogin, local } = opts;
  const safeName = esc(siteName);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName}</title>
<meta name="description" content="${safeName} — 文件下载">
<meta name="theme-color" content="#393d49">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='4' fill='%23393d49'/%3E%3Cpath d='M8 23V11a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2Z' fill='%23fff'/%3E%3Cpath d='M10 13h12' stroke='%23393d49' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/style.css">
</head>
<body class="${isLogin ? 'login' : ''}">
<div id="app">
  <header class="site-header">
    <div class="wrap header-inner">
      <h1 class="site-title">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </span>
        ${safeName}
      </h1>
      <div class="tools">
        <div class="search-box">
          <input id="q" type="search" placeholder="搜索文件…" autocomplete="off">
        </div>
        <div class="view-switch">
          <button id="v-list" class="vs active" title="列表视图" aria-label="列表视图">
            <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
          </button>
          <button id="v-grid" class="vs" title="网格视图" aria-label="网格视图">
            <svg viewBox="0 0 16 16" width="16" height="16"><rect x="2" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
          </button>
        </div>
        ${
          isLogin
            ? `<button id="btn-refresh" class="btn btn-ghost" title="遍历整个桶，把目录索引对齐到真实内容（rclone 同步后用）">重建索引</button>
               <button id="btn-mkdir" class="btn btn-ghost" title="在当前目录下新建文件夹">新建目录</button>
               <button id="btn-upload" class="btn btn-primary">上传</button>
               <button id="btn-logout" class="btn btn-ghost" title="退出登录">退出</button>`
            : `<button id="btn-login" class="btn btn-ghost" title="管理登录">登录</button>`
        }
      </div>
    </div>
  </header>

  <main class="wrap">
    <nav class="crumb" id="crumb"></nav>
    <div class="stats" id="stats"></div>

    <div id="dropzone" class="dropzone${isLogin ? '' : ' hidden'}">
      <div class="dz-inner">
        <div class="dz-ic">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <p>拖拽文件到这里上传，或 <span class="link">点击选择</span></p>
        <p class="dz-hint" id="dz-hint"></p>
      </div>
      <input type="file" id="file-input" multiple hidden>
    </div>

    <div id="uploading" class="uploading hidden"></div>

    <div class="file-head" id="file-head">
      <span class="col-name">文件名</span>
      <span class="col-size">大小</span>
      <span class="col-time">上传时间</span>
      <span class="col-act">操作</span>
    </div>

    <div id="list" class="file-list"></div>
    <div id="grid" class="file-grid hidden"></div>

    <div id="empty" class="empty hidden">
      <div class="empty-ic">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 20V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2Z"/></svg>
      </div>
      <p id="empty-title">这个目录是空的</p>
      <p class="sub" id="empty-sub">把文件拖进来，或点击下方按钮上传</p>
      <button id="empty-up" class="btn btn-primary hidden">上传文件</button>
    </div>

    <div id="readme" class="readme hidden"></div>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <span>数据托管于 Cloudflare R2</span>
      <span class="dot">·</span>
      <a class="foot-link" href="https://wonse.info/" target="_blank" rel="noopener">我的博客</a>
      <span class="dot">·</span>
      <a class="foot-link" href="https://github.com/weipu2026/r2-share" target="_blank" rel="noopener">网站源码</a>
      <span class="dot">·</span>
      <span id="idx-updated"></span>
    </div>
  </footer>

  <div id="pv" class="pv hidden" aria-modal="true" role="dialog">
    <div class="pv-mask" id="pv-mask"></div>
    <div class="pv-box">
      <div class="pv-hd">
        <span class="pv-title" id="pv-title"></span>
        <a class="mini pv-dl" id="pv-dl" href="#" download>下载</a>
        <button class="pv-x" id="pv-close" title="关闭" aria-label="关闭">
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="pv-bd" id="pv-body"></div>
    </div>
  </div>

  <div id="dlg" class="dlg hidden" aria-modal="true" role="dialog">
    <div class="dlg-mask" id="dlg-mask"></div>
    <div class="dlg-box">
      <div class="dlg-title" id="dlg-title"></div>
      <div class="dlg-body" id="dlg-body"></div>
      <div class="dlg-foot">
        <button class="btn" id="dlg-cancel">取消</button>
        <button class="btn btn-primary" id="dlg-ok">确定</button>
      </div>
    </div>
  </div>

  <div id="toasts" aria-live="polite"></div>

  <div id="batchbar" class="batchbar hidden" aria-live="polite">
    <span class="bc-info">已选 <b id="bc-count">0</b> 项</span>
    <button class="mini" id="bc-all">全选</button>
    <button class="mini" id="bc-copy">复制链接</button>
    <button class="mini" id="bc-dl">下载</button>
    <button class="mini danger" id="bc-del">删除</button>
    <button class="mini" id="bc-clear">取消</button>
  </div>
</div>

<script>
  window.__CFG__ = ${JSON.stringify({
    siteName,
    dlDomain,
    isLogin,
    local,
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')};
</script>
<script src="/app.js"></script>
</body>
</html>`;
}
