/* r2share 前端 —— 原生 JS，无框架
 *
 * 数据流：
 *   1. 启动时 fetch 一次 files.json（R2 公开直链，不经过 Worker）
 *   2. 由扁平路径列表在前端构建目录树
 *   3. 下载链接直接指向 R2 公开桶，零 Worker 消耗
 */

const CFG = window.__CFG__ || { dlDomain: '', isLogin: false };

const state = {
  index: [],
  cur: '',
  view: 'list',
  q: '',
  searchMode: false,
  /** 批量选择：已勾选的文件路径集合（仅文件，不含目录占位） */
  sel: new Set(),
};

const $ = (id) => document.getElementById(id);

/* ---------------- 工具 ---------------- */

/** 所有插入 HTML 的动态内容必须先转义（原 PHP 版的文件名 XSS 就栽在这里） */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtSize(b) {
  // 只有「无值」才显示占位符；0 字节是合法大小，应显示 "0 B"
  if (b === undefined || b === null) return '-';
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v < 10 ? 2 : 1) + ' ' + u[i];
}

function fmtTime(ms) {
  const n = Number(ms);
  // 时间戳缺失/非法时回退为占位符，避免渲染出 "NaN-NaN-NaN NaN:NaN"
  if (!Number.isFinite(n) || n <= 0) return '-';
  const d = new Date(n);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const EXT_KIND = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'],
  video: ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv'],
  audio: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a'],
  zip: ['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'tgz', 'xz'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'mobi'],
  code: ['js', 'ts', 'json', 'html', 'css', 'sh', 'py', 'go', 'java', 'c', 'cpp', 'md', 'txt', 'yml', 'yaml'],
};

/**
 * 扩展名 → 分类的反向索引（模块加载时建一次）。
 * kindOf 在渲染时每行要调好几次（图标、徽章、预览判定），原来的写法每次都要
 * 遍历 7 个分类做 includes，上千行的目录会退化成几万次线性比较。
 */
const KIND_BY_EXT = new Map();
for (const kind in EXT_KIND) {
  for (const ext of EXT_KIND[kind]) if (!KIND_BY_EXT.has(ext)) KIND_BY_EXT.set(ext, kind);
}

function kindOf(name, isDir) {
  if (isDir) return 'dir';
  const ext = name.split('.').pop().toLowerCase();
  return KIND_BY_EXT.get(ext) || 'file';
}

const ICONS = {
  dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/>',
  video: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  zip: '<path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6l2 2h6a2 2 0 0 1 2 2z"/><path d="M12 11v4"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
};

function icon(name, isDir) {
  const kind = kindOf(name, isDir);
  const filled = kind === 'dir' ? 'currentColor' : 'none';
  return `<svg class="icon k-${kind}" viewBox="0 0 24 24" width="17" height="17"
    fill="${filled}" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] || ICONS.file}</svg>`;
}

/** 图标徽章（带底色圆角块） */
function badge(name, isDir, size = 17) {
  const kind = kindOf(name, isDir);
  return `<span class="ic ic-${kind}">${icon(name, isDir).replace('width="17" height="17"', `width="${size}" height="${size}"`)}</span>`;
}

const KIND_LABEL = {
  dir: '目录',
  image: '图片',
  video: '视频',
  audio: '音频',
  zip: '压缩包',
  doc: '文档',
  code: '代码',
  file: '文件',
};

/** 网格视图里超过这个大小的图片不再加载真实缩略图（否则一个照片目录能瞬间拉掉几百 MB） */
const THUMB_MAX = 300 * 1024;

/* ---------------- 目录模型 ---------------- */

/** 统一样式弹窗：confirm 模式返回 true/null，输入模式返回字符串/null */
function dialog(opts) {
  return new Promise((resolve) => {
    const box = $('dlg');
    $('dlg-title').textContent = opts.title || '';
    $('dlg-body').innerHTML = opts.input
      ? `<input id="dlg-input" type="${opts.inputType === 'text' ? 'text' : 'password'}" placeholder="${esc(opts.placeholder || '')}"${opts.inputType === 'text' ? '' : ' autocomplete="current-password"'}>`
      : esc(opts.body || '');
    const ok = $('dlg-ok');
    const cancel = $('dlg-cancel');
    ok.textContent = opts.okText || '确定';
    ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    box.classList.remove('hidden');

    const inp = $('dlg-input');
    if (inp) inp.focus();

    const onDlgKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && opts.input && inp.value) ok.click();
    };
    const close = (val) => {
      box.classList.add('hidden');
      ok.onclick = cancel.onclick = $('dlg-mask').onclick = null;
      document.removeEventListener('keydown', onDlgKey);
      resolve(val);
    };
    ok.onclick = () => close(opts.input ? inp.value : true);
    cancel.onclick = () => close(null);
    $('dlg-mask').onclick = () => close(null);
    document.addEventListener('keydown', onDlgKey);
  });
}

/** 顶部轻提示，2 秒后自动消失 */
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 2200);
}


/** 从扁平路径列表里取出某个目录下的直接子项 */
function listDir(path) {
  const prefix = path ? path + '/' : '';
  const dirs = new Set();
  const files = [];
  for (const f of state.index) {
    if (prefix && !f.p.startsWith(prefix)) continue;
    const rest = f.p.slice(prefix.length);
    if (!rest) continue;
    const i = rest.indexOf('/');
    if (i >= 0) dirs.add(rest.slice(0, i));
    else files.push({ ...f, name: rest });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { dirs: [...dirs].sort((a, b) => a.localeCompare(b, 'zh')), files };
}

/* ---------------- 渲染 ---------------- */

function renderCrumb() {
  const box = $('crumb');
  if (state.searchMode) {
    box.innerHTML = `<span class="cur">搜索 “${esc(state.q)}”</span>
      <span class="sep">·</span><a href="#" id="exit-search">返回目录</a>`;
    $('exit-search').onclick = (e) => {
      e.preventDefault();
      state.searchMode = false;
      state.q = '';
      $('q').value = '';
      resetSel();
      render();
    };
    return;
  }

  const parts = state.cur ? state.cur.split('/') : [];
  const chev = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let html = `<a href="#" data-p=""><span class="home"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m3 11 9-7 9 7v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>全部文件</span></a>`;
  let acc = '';
  parts.forEach((p, i) => {
    acc = acc ? acc + '/' + p : p;
    const last = i === parts.length - 1;
    html += `<span class="sep">${chev}</span>`;
    html += last
      ? `<span class="cur">${esc(p)}</span>`
      : `<a href="#" data-p="${esc(acc)}">${esc(p)}</a>`;
  });
  box.innerHTML = html;
  box.querySelectorAll('a[data-p]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      state.cur = a.dataset.p;
      resetSel();
      render();
    };
  });
}

/** 代理模式（未配公开桶下载域 DL_DOMAIN）时改走 Worker 代理，否则直连公开桶 */
function dlUrl(path) {
  if (CFG.proxyMode) return '/api/local-get?key=' + encodeURIComponent(path);
  // 生产但未配置下载域：直链不可用，返回 #（点击无操作），
  // 避免拼出 "undefined/xxx" 的坏链接误导用户以为下载坏了
  if (!CFG.dlDomain) return '#';
  return CFG.dlDomain + '/' + path.split('/').map(encodeURIComponent).join('/');
}

function idxUrl() {
  if (CFG.proxyMode) return '/api/local-index';
  // 未配置下载域时索引也无法获取；返回空让 loadIndex 走容灾分支
  return CFG.dlDomain ? CFG.dlDomain + '/files.json' : '';
}

/* ---------------- 预览 ----------------
 * 图片/视频/音频：浏览器原生标签；
 * PDF：iframe 交给浏览器内置阅读器（零依赖，支持目录/缩放/查找）；
 * 文本/代码/Markdown：拉取内容前端渲染（限 2MB，渲染时再截断一次）；
 * Office：浏览器无法原生渲染，给出在线查看 + 下载入口。
 */

/** 超过该大小不提供文本预览（避免拉取巨型文件） */
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
/** 实际渲染的字符上限：超过就截断，防止超大/单行文件把浏览器布局卡死 */
const TEXT_RENDER_LIMIT = 400 * 1024;

/** 可按纯文本渲染的扩展名（补齐 EXT_KIND.code 之外的常见文本/代码） */
const TEXT_EXT = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'ini', 'toml', 'conf', 'cfg', 'env',
  'properties', 'sql', 'xml', 'xhtml', 'htm', 'vue', 'svelte', 'jsx', 'tsx',
  'mjs', 'cjs', 'scss', 'less', 'sass', 'rs', 'php', 'rb', 'pl', 'lua', 'r',
  'cs', 'kt', 'swift', 'scala', 'dart', 'm', 'mm', 'h', 'hpp', 'cc', 'bat',
  'cmd', 'ps1', 'pyw', 'gradle', 'cmake', 'dockerfile', 'gitignore',
  'gitattributes', 'editorconfig', 'license', 'readme', 'nfo', 'diff', 'patch',
]);

/** Office 系列：浏览器无法原生渲染 */
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

/** 判断文件是否可按纯文本读取：MIME 属文本族、属 code 分类，或扩展名命中白名单 */
function isTextLike(name, ctype) {
  if (ctype) {
    if (/^text\//i.test(ctype)) return true;
    if (/\b(json|xml|javascript|x-shellscript|yaml|xhtml)/i.test(ctype)) return true;
  }
  // code 分类（js/ts/py/go/md/txt…）本身就是文本，TEXT_EXT 只负责补齐它之外的
  if (kindOf(name, false) === 'code') return true;
  return TEXT_EXT.has(String(name).split('.').pop().toLowerCase());
}

/**
 * 返回文件的预览方式：
 *   image / video / audio —— 浏览器原生标签
 *   pdf    —— iframe（浏览器内置 PDF 阅读器）
 *   text   —— fetch + textContent
 *   office —— 浏览器无法原生渲染，给出在线查看 / 下载入口
 *   null   —— 不支持预览（压缩包、epub 等）
 */
function previewKind(f) {
  const name = f.name || String(f.p || '').split('/').pop();
  const kind = kindOf(name, false);
  if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
  const ext = String(name).split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (isTextLike(name, f.c) && (f.s || 0) <= TEXT_PREVIEW_LIMIT) return 'text';
  return null;
}

function previewable(f) {
  return !!previewKind(f);
}

function openPreview(f) {
  // 索引对象没有 name 字段，从路径补齐（列表行对象已带 name）
  const name = f.name || f.p.split('/').pop();
  const kind = previewKind(f) || 'text';
  const url = dlUrl(f.p);
  const box = $('pv');
  const body = $('pv-body');

  $('pv-title').textContent = name;
  const dl = $('pv-dl');
  dl.href = url;
  dl.setAttribute('download', name);
  box.classList.remove('hidden');
  // PDF / Office 需要更大的展示空间
  box.classList.toggle('wide', kind === 'pdf' || kind === 'office');
  document.body.style.overflow = 'hidden';

  // 用 addEventListener 而非直接覆盖 document.onkeydown：
  // 否则预览与登录/删除弹窗会互相顶掉对方的键盘监听
  const onPvKey = (e) => {
    if (e.key === 'Escape' && !box.classList.contains('hidden')) clear();
  };
  const clear = () => {
    // 作废在途的文本预览响应：否则弹层关闭后它仍会把内容写回来
    pvSeq++;
    body.innerHTML = '';
    box.classList.add('hidden');
    box.classList.remove('wide');
    $('pv-title').textContent = '';
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onPvKey);
  };
  document.addEventListener('keydown', onPvKey);

  if (kind === 'image') {
    body.innerHTML = `<img src="${esc(url)}" alt="${esc(name)}">`;
  } else if (kind === 'video') {
    body.innerHTML = `<video src="${esc(url)}" controls autoplay></video>`;
  } else if (kind === 'audio') {
    body.innerHTML = `<audio src="${esc(url)}" controls autoplay></audio>`;
  } else if (kind === 'pdf') {
    // PDF 交给浏览器内置阅读器：零依赖，Ctrl+F 查找、缩放、目录都是原生的。
    // 能否内联渲染取决于对象里存的 Content-Type，若不是 application/pdf，
    // 浏览器会改成下载——此时提示用「重建索引」让 guessType 修正 MIME。
    body.innerHTML = `<iframe class="pv-pdf" src="${esc(url)}" title="${esc(name)}"></iframe>`;
    if (f.c && !/application\/pdf/i.test(f.c)) {
      const tip = document.createElement('div');
      tip.className = 'pv-note';
      tip.textContent = `该文件存储的 MIME 是 ${f.c}，浏览器可能会直接下载而不预览；可点工具栏「重建索引」修正。`;
      body.appendChild(tip);
    }
  } else if (kind === 'office') {
    renderOfficePreview(body, name, url);
  } else {
    renderTextPreview(body, name, url, f.s);
  }

  $('pv-close').onclick = clear;
  $('pv-mask').onclick = clear;
}

/**
 * 预览渲染令牌：快速切换预览对象时，先发出的旧响应不能盖住新的内容。
 * 每次进入渲染就自增一次；响应回来时令牌已被推过，说明用户已经切走/关掉，直接丢弃。
 */
let pvSeq = 0;

/** 文本 / markdown：拉取后以 textContent 注入，杜绝文件内容转 HTML */
function renderTextPreview(body, name, url, size) {
  // 必须在任何 await 之前取号：取号晚于 await 就等于没取
  const seq = ++pvSeq;
  body.innerHTML = `<div class="pv-err">加载中…</div>`;
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then((text) => {
      // 等待期间已经打开别的文件（或关闭了弹层）→ 丢弃本次结果
      if (seq !== pvSeq) return;
      // 截断保护：超大文本只渲染前一段，尾部标注真实大小
      if (text.length > TEXT_RENDER_LIMIT) {
        text =
          text.slice(0, TEXT_RENDER_LIMIT) +
          `\n\n… 文件过大，已截断显示前 ${fmtSize(TEXT_RENDER_LIMIT)}` +
          (size ? `（完整 ${fmtSize(size)}，请下载查看）` : '（请下载查看）');
      }
      if (/\.(md|markdown)$/i.test(name)) {
        body.innerHTML = `<div class="pv-md md">${md(text)}</div>`;
      } else {
        // textContent 安全注入，杜绝任何文件内容转 HTML
        const pre = document.createElement('pre');
        pre.className = 'pv-text';
        pre.textContent = text;
        body.innerHTML = '';
        body.appendChild(pre);
      }
    })
    .catch((err) => {
      // 失败的若是已被切走的那个请求，提示同样不该盖到新内容上
      if (seq !== pvSeq) return;
      body.innerHTML = `<div class="pv-err">加载失败：${esc(err.message || '网络错误')}</div>`;
    });
}

/** Office 系列：浏览器无法原生渲染，给出在线查看 / 下载入口 */
function renderOfficePreview(body, name, url) {
  const ext = String(name).split('.').pop().toLowerCase();
  const label =
    { doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', ppt: 'PowerPoint', pptx: 'PowerPoint' }[ext] ||
    'Office';
  // 在线查看要求文件能被公网访问：Worker 代理地址（/api/local-get?...）不行
  const canOnline = !CFG.proxyMode && /^https?:\/\//i.test(url);

  body.innerHTML = `<div class="pv-office">
    <div class="of-ic">${icon(name, false)}</div>
    <p class="of-t">${esc(label)} 文档无法直接在浏览器打开</p>
    <p class="of-s">${
      canOnline
        ? '可用微软 Office 在线查看（文件需可被公网访问），或下载到本地用 Office / WPS 打开'
        : '请下载到本地用 Office / WPS 打开'
    }</p>
    <div class="of-btns">
      ${canOnline ? '<button class="btn btn-primary" id="pv-of-view">Office 在线查看</button>' : ''}
      <a class="btn${canOnline ? '' : ' btn-primary'}" href="${esc(url)}" download="${esc(name)}">下载文件</a>
    </div>
  </div>`;

  const view = $('pv-of-view');
  if (view) {
    view.onclick = () => {
      const src = 'https://view.officeapps.live.com/op/view.aspx?src=' + encodeURIComponent(url);
      body.innerHTML = `<iframe class="pv-pdf" src="${esc(src)}" title="${esc(name)}"></iframe>`;
    };
  }
}

/** 批量选择复选框：仅登录态显示（列表/网格共用） */
function selCb(p) {
  return CFG.isLogin
    ? `<input type="checkbox" class="sel" data-sel="${esc(p)}" ${state.sel.has(p) ? 'checked' : ''} title="选择" aria-label="选择">`
    : '';
}

function renderList(items) {
  const dirRows = items.dirs.map((d) => {
    const full = state.cur ? state.cur + '/' + d : d;
    return `<div class="row">
      <div class="name">
        <a href="#" data-dir="${esc(full)}">${badge(d, true)}<span class="txt">${esc(d)}</span></a>
      </div>
      <div class="size">-</div>
      <div class="time">-</div>
      <div class="act">
        ${CFG.isLogin ? `<button class="mini danger" data-deldir="${esc(full)}">删除</button>` : ''}
      </div>
    </div>`;
  });

  const fileRows = items.files.map((f) => {
    const canPreview = previewable(f);
    const nameHtml = canPreview
      ? `<a href="#" data-prev="${esc(f.p)}" title="${esc(f.name)}">${esc(f.name)}</a>`
      : `<a href="${esc(dlUrl(f.p))}" title="${esc(f.name)}">${esc(f.name)}</a>`;
    return `<div class="row">
      <div class="name">
        ${selCb(f.p)}
        ${badge(f.name, false)}
        <span class="txt">${nameHtml}</span>
      </div>
      <div class="size">${fmtSize(f.s)}</div>
      <div class="time">${fmtTime(f.t)}</div>
      <div class="act">
        <button class="mini" data-copy="${esc(dlUrl(f.p))}">复制链接</button>
        <a class="mini dl" href="${esc(dlUrl(f.p))}">下载</a>
        ${CFG.isLogin ? `<button class="mini danger" data-del="${esc(f.p)}">删除</button>` : ''}
      </div>
    </div>`;
  });

  $('list').innerHTML = dirRows.join('') + fileRows.join('');
}

function renderGrid(items) {
  const dirCells = items.dirs.map((d) => {
    const full = state.cur ? state.cur + '/' + d : d;
    return `<div class="cell" data-dir="${esc(full)}">
      <div class="thumb t-dir">
        <span class="tag">目录</span>
        ${badge(d, true, 30)}
      </div>
      <div class="body">
        <div class="nm" title="${esc(d)}">${esc(d)}</div>
        <div class="mt">文件夹</div>
      </div>
      <div class="cell-actions">
        ${CFG.isLogin ? `<button class="mini danger" data-deldir="${esc(full)}">删除</button>` : ''}
      </div>
    </div>`;
  });

  const fileCells = items.files.map((f) => {
    const kind = kindOf(f.name, false);
    // 大图不在网格里拿原图当缩略图：一个 50 张照片的目录能瞬间吃掉几百 MB。
    // 超过 THUMB_MAX 的退回类型图标，点开预览时才真正拉原图。
    const thumb = kind === 'image' && (f.s || 0) <= THUMB_MAX
      ? `<div class="thumb"><img loading="lazy" src="${esc(dlUrl(f.p))}" alt=""><span class="tag">图片</span></div>`
      : `<div class="thumb t-${kind}"><span class="tag">${KIND_LABEL[kind] || '文件'}</span>${badge(f.name, false, 32)}</div>`;
    return `<div class="cell" data-cell="${esc(f.p)}">
      ${thumb}
      ${selCb(f.p)}
      <div class="body">
        <div class="nm" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="mt">${fmtSize(f.s)} · ${fmtTime(f.t)}</div>
      </div>
      <div class="cell-actions">
        <button class="mini" data-copy="${esc(dlUrl(f.p))}">复制链接</button>
        <a class="mini dl" href="${esc(dlUrl(f.p))}">下载</a>
        ${CFG.isLogin ? `<button class="mini danger" data-del="${esc(f.p)}">删除</button>` : ''}
      </div>
    </div>`;
  });

  $('grid').innerHTML = dirCells.join('') + fileCells.join('');
}

/** 批量操作条：根据当前选中集合更新显示，并同步所有复选框勾选态 */
function updateBatch() {
  const bar = $('batchbar');
  if (!bar) return;
  const n = state.sel.size;
  $('bc-count').textContent = n;
  bar.classList.toggle('hidden', !CFG.isLogin || n === 0);
  // 同步页面上所有已渲染的复选框（含全选后的反显）
  document.querySelectorAll('.sel[data-sel]').forEach((cb) => {
    cb.checked = state.sel.has(cb.dataset.sel);
  });
}

/**
 * 清空批量选择。
 * 切换目录/切换搜索视图时必须调用：选择集是按完整路径存的，跨视图会留下
 * 当前看不见的条目——在 A 目录勾了几项、走进 B 目录再点批量删除，
 * A 目录那些文件会被一起删掉。
 */
function resetSel() {
  if (!state.sel.size) return;
  state.sel.clear();
  updateBatch();
}

/**
 * 行/单元格操作事件委托。
 * 列表与网格共用：只在初始化时绑定一次，通过 data-* 属性分发，
 * 避免每次渲染重复遍历绑定。
 */
function bindRowEvents() {
  const root = document.body;

  /* ---- 点击操作（复制 / 预览 / 删除 → 目录进入 → 单元格） ---- */
  root.addEventListener('click', (e) => {
    // 复选框交给 change 事件，不触发单元格操作
    if (e.target.closest('.sel')) return;
    // ⚠️ 判断顺序有讲究：操作类分支必须排在 [data-dir] 之前。
    // 网格视图里 [data-dir] 挂在整个 .cell 上，删除按钮是它的后代；
    // 若先判 [data-dir]，点删除会命中祖先 .cell，被当成「进入目录」而直接 return，
    // 下面的 [data-deldir] 分支就永远不可达 —— 网格视图下将无法删除任何目录。
    const copyEl = e.target.closest('[data-copy]');
    if (copyEl) {
      navigator.clipboard
        .writeText(copyEl.dataset.copy)
        .then(() => toast('链接已复制'))
        .catch(() => toast('复制失败，请检查浏览器权限', 'err'));
      return;
    }

    const prevEl = e.target.closest('[data-prev]');
    if (prevEl) {
      e.preventDefault();
      const f = state.index.find((x) => x.p === prevEl.dataset.prev);
      if (f) openPreview(f);
      return;
    }

    const delEl = e.target.closest('[data-del]');
    if (delEl) {
      deleteOne(delEl.dataset.del);
      return;
    }

    const delDirEl = e.target.closest('[data-deldir]');
    if (delDirEl) {
      deleteDir(delDirEl.dataset.deldir);
      return;
    }

    // 目录进入：必须是操作类分支之后的兜底判断（顺序说明见本监听器开头）
    const dirEl = e.target.closest('[data-dir]');
    if (dirEl) {
      e.preventDefault();
      state.cur = dirEl.dataset.dir;
      resetSel();
      render();
      return;
    }

    // 网格单元格的「下载」链接：在 .cell-actions 内、无 data-*，
    // 点击应直接触发浏览器下载，不应再被 cell 捕获
    if (e.target.closest('.cell-actions')) return;

    const cellEl = e.target.closest('[data-cell]');
    if (cellEl) {
      // 点击网格单元格空白区：可预览则弹层，否则新窗口打开
      const f = state.index.find((x) => x.p === cellEl.dataset.cell);
      if (f && previewable(f)) {
        openPreview(f);
      } else {
        // dlUrl 在「生产但未配下载域」时回退成 '#'；直接打开 '#' 会多出一个空白标签页，
        // 还会往当前页地址里塞个 #，所以拦住并说清原因。
        const url = dlUrl(cellEl.dataset.cell);
        if (url && url !== '#') window.open(url, '_blank');
        else toast('未配置下载域名，无法直接打开', 'err');
      }
    }
  });

  /* ---- 批量选择复选框 ---- */
  root.addEventListener('change', (e) => {
    const sel = e.target.closest('.sel[data-sel]');
    if (!sel) return;
    if (sel.checked) state.sel.add(sel.dataset.sel);
    else state.sel.delete(sel.dataset.sel);
    updateBatch();
  });
}

/**
 * 删除请求（单个文件/目录共用）：返回 { res, data }。
 * 网络异常（断网、请求被中断）时返回 res: null 而不抛出 —— 两个调用处都在 await 之后
 * 直接读 res.ok，异常冒出去就成了没有任何提示的 unhandled rejection。
 */
async function apiDel(path, isDir) {
  try {
    const res = await fetch(isDir ? '/api/dir' : '/api/file', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return { res, data: await res.json().catch(() => ({})) };
  } catch {
    return { res: null, data: {} };
  }
}

/** 删除单个文件 */
async function deleteOne(path) {
  const sure = await dialog({
    title: '删除文件',
    body: '确定删除「' + path.split('/').pop() + '」？此操作不可撤销。',
    okText: '删除',
    danger: true,
  });
  if (!sure) return;
  const { res, data } = await apiDel(path);
  if (!res) return toast('网络错误，删除未完成', 'err');
  if (res.ok) {
    state.sel.delete(path);
    updateBatch();
    toast('已删除');
    dropIndexPaths([path]);
  } else {
    toast(data.error || '删除失败', 'err');
  }
}

/** 删除目录（递归） */
async function deleteDir(path) {
  const sure = await dialog({
    title: '删除目录',
    body: '确定删除目录「' + path + '」及其中的所有文件？此操作不可撤销。',
    okText: '删除',
    danger: true,
  });
  if (!sure) return;
  const { res, data } = await apiDel(path, true);
  if (!res) return toast('网络错误，删除未完成', 'err');
  if (res.ok) {
    // 移出可能被选中的该目录下所有文件
    for (const p of state.sel) if (p === path || p.startsWith(path + '/')) state.sel.delete(p);
    updateBatch();
    toast(data.removed ? `已删除（含 ${data.removed} 个文件）` : '已删除');
    dropIndexPaths([path]);
  } else {
    toast(data.error || '删除失败', 'err');
  }
}

/* ---------------- 批量操作 ---------------- */

/** 当前视图下的真实文件列表（不含目录占位），用于全选与搜索渲染 */
function currentVisibleFiles() {
  if (state.searchMode) {
    const q = state.q.toLowerCase();
    return state.index
      // 跳过目录占位条目（<dir>/ 0 字节对象），只搜真实文件
      .filter((f) => !f.p.endsWith('/') && f.p.toLowerCase().includes(q))
      .map((f) => ({ ...f, name: f.p }));
  }
  return listDir(state.cur).files;
}

function selectAllToggle() {
  const files = currentVisibleFiles();
  if (!files.length) return;
  // 当前视图全部选中则反选，否则全选
  const allSel = files.every((f) => state.sel.has(f.p));
  if (allSel) files.forEach((f) => state.sel.delete(f.p));
  else files.forEach((f) => state.sel.add(f.p));
  // updateBatch 内会同步所有复选框的勾选态
  updateBatch();
}

async function batchCopy() {
  // 与 batchDownload 同口径：未配置下载域时 dlUrl 会回退成 '#'，直接剔掉 ——
  // 否则会往剪贴板塞一堆 '#'，还提示「已复制 N 个链接」。
  const urls = [...state.sel].map((p) => dlUrl(p)).filter((u) => !!u && u !== '#');
  if (!urls.length) {
    toast('没有可复制的链接（未配置下载域名）', 'err');
    return;
  }
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    toast(`已复制 ${urls.length} 个链接`);
  } catch {
    toast('复制失败，请检查浏览器权限', 'err');
  }
}

function batchDownload() {
  // 未配置下载域时 dlUrl 会回退成 '#'，直接剔掉：否则「批量下载」会去下载当前页面
  const paths = [...state.sel].filter((p) => {
    const u = dlUrl(p);
    return !!u && u !== '#';
  });
  if (!paths.length) {
    toast('没有可下载的链接（未配置下载域名）', 'err');
    return;
  }
  // 弹窗拦截器只放行用户手势里的第一个 window.open，循环调用会被吞掉，
  // 表现就是「批量下载明明选了 N 个却只下了一个」。改成依次触发 <a download>，
  // 同一个用户手势内的程序化点击不会触发拦截，间隔留一点让浏览器排队。
  if (paths.length > 5) {
    toast(`开始下载 ${paths.length} 个文件，浏览器可能提示「是否允许下载多个文件」`);
  }
  paths.forEach((p, i) => {
    setTimeout(() => {
      const url = dlUrl(p);
      const a = document.createElement('a');
      a.href = url;
      // a.download 对**跨域**直链会被浏览器忽略，文件名改由 URL 末段决定。
      // 生产环境 URL 末段就是真实文件名，所以看着「生效」了，其实这行没起作用；
      // 只有同源地址（代理模式的 /api/local-get?key=…）才真认它。
      // 因此只在同源时设置，别留一个看着有用、实则无效的赋值误导后来人。
      if (url.startsWith('/')) a.download = p.split('/').pop() || 'file';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400);
  });
}

async function batchDelete() {
  const n = state.sel.size;
  if (!n) return;
  const sure = await dialog({
    title: '批量删除',
    body: `确定删除选中的 ${n} 个文件？此操作不可撤销。`,
    okText: '删除',
    danger: true,
  });
  if (!sure) return;
  // 分批请求：不逐个调用 /api/file（那会变成 N 次 Worker 请求 + N 次索引读改写），
  // 服务端的 /api/files 把每批合并成一次批量对象删除 + 一次索引写。
  // 分批而不是一次发完，是因为服务端对单次删除有条数上限（MAX_DELETE_BATCH）：
  // 一个目录里上千个文件全选后整批发过去会被 413 拒掉，一个都删不成。
  const paths = [...state.sel];
  const failed = [];
  // 同一原因的失败只提示一次：整批失败（会话过期 401、断网）时 N 个批次会给出 N 条
  // 一模一样的 toast，把后面那条汇总信息淹没掉。toast 是追加不是替换，所以必须在
  // 这里去重；不同原因仍各自可见。
  const notifiedErrors = new Set();
  let removed = 0;
  for (const part of chunk(paths, DELETE_CHUNK)) {
    try {
      const res = await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: part }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '删除失败');
      // 成功一批就立刻反映一批：后面的批次失败也不影响前面已删的显示
      removed += data.removed || 0;
      for (const p of part) state.sel.delete(p);
      dropIndexPaths(part);
    } catch (err) {
      failed.push(...part);
      const msg = err.message || '删除失败';
      if (!notifiedErrors.has(msg)) {
        notifiedErrors.add(msg);
        toast(msg, 'err');
      }
    }
  }
  updateBatch();
  if (failed.length) {
    // 失败路径保留其选择：清空会让用户以为「这批已经处理完了」，想重试还得重新勾。
    toast(`已删除 ${removed}/${n}，${failed.length} 个失败（选择已保留）`, 'err');
  } else {
    toast(`已删除 ${removed}/${n}`);
  }
}

function render() {
  renderCrumb();

  const hint = $('dz-hint');
  if (hint && CFG.isLogin) {
    hint.textContent = `文件上传到当前目录${state.cur ? '：' + state.cur : '（根目录）'}`;
  }

  let items;
  if (state.searchMode) {
    items = { dirs: [], files: currentVisibleFiles() };
  } else {
    items = listDir(state.cur);
  }

  renderStats(items);

  const empty = $('empty');
  const has = items.dirs.length + items.files.length > 0;
  empty.classList.toggle('hidden', has);
  if (!has) {
    $('empty-title').textContent = state.searchMode
      ? `没有找到匹配「${state.q}」的文件`
      : '这个目录是空的';
    $('empty-sub').textContent = state.searchMode ? '换个关键词试试' : '把文件拖进来，或点击下方按钮上传';
  }
  const emptyUp = $('empty-up');
  if (emptyUp) emptyUp.classList.toggle('hidden', !CFG.isLogin || state.searchMode);
  // 搜索模式强制用列表视图，此时表头必须跟着 list 一起显示
  $('file-head').classList.toggle('hidden', state.view !== 'list' && !state.searchMode);
  $('list').classList.toggle('hidden', state.view !== 'list' || state.searchMode);
  $('grid').classList.toggle('hidden', state.view !== 'grid' || state.searchMode);
  if (state.searchMode) $('list').classList.remove('hidden');

  if (state.view === 'grid' && !state.searchMode) renderGrid(items);
  else renderList(items);

  renderReadme(items);
}

/* ---------------- 统计栏 ---------------- */

function renderStats(items) {
  const box = $('stats');
  if (!box) return;
  const nd = items.dirs.length;
  const nf = items.files.length;
  if (!nd && !nf) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const total = items.files.reduce((s, f) => s + (f.s || 0), 0);
  const parts = [];
  if (state.searchMode) {
    parts.push(`找到 <b>${nf}</b> 个匹配文件`);
  } else {
    if (nd) parts.push(`<b>${nd}</b> 个文件夹`);
    parts.push(`<b>${nf}</b> 个文件`);
  }
  parts.push(`共 ${fmtSize(total)}`);
  box.innerHTML = parts.join('<span class="sp">·</span>');
  box.classList.remove('hidden');
}

/* ---------------- README ---------------- */

/** README 渲染令牌：快速切目录时，先发出的旧响应不能盖住新目录的内容 */
let readmeSeq = 0;

async function renderReadme(items) {
  const box = $('readme');
  if (!box) return;
  // 令牌必须在「本次进入」时就推进：切到**没有** README 的目录同样要作废在途的旧请求。
  // 原实现把自增放在下面的 return 之后，于是「无 README 分支」既不推进令牌、也不清空
  // 在途结果 —— 上一个目录的 README 会被渲染进当前目录，与下方 seq 校验的语义正好相反。
  const seq = ++readmeSeq;
  const hit = items.files.find((f) => /^readme\.md$/i.test(f.name));
  if (!hit) {
    box.classList.add('hidden');
    return;
  }
  try {
    const res = await fetch(dlUrl(hit.p));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    // 等待期间已经渲染过别的目录 → 丢弃本次结果
    if (seq !== readmeSeq) return;
    box.innerHTML = `<div class="hd"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>README.md</div><div class="bd md">${md(text)}</div>`;
    box.classList.remove('hidden');
  } catch {
    if (seq === readmeSeq) box.classList.add('hidden');
  }
}

/** 链接协议白名单：只允许 http(s)/相对路径，拒绝 javascript: 等危险协议 */
function safeUrl(u) {
  u = String(u || '').trim();
  // 拒绝协议相对 URL（//evil.com），它会被浏览器补全为外站，构成开放重定向
  if (u.startsWith('//')) return '#';
  return /^(https?:\/\/|\/|#|\.{1,2}\/)/i.test(u) ? u : '#';
}

/** 极简 markdown 子集渲染（先转义，再做标记替换） */
function md(src) {
  let s = esc(src).replace(/\x00/g, '');

  // 代码块与行内代码先占位隔离：否则其中的 #、-、*、| 等会被
  // 后续的标题/列表/hr/表格等行级替换误伤（如代码里的 "# 注释" 变 <h1>）
  const stash = [];
  const keep = (html) => `\x00${stash.push(html) - 1}\x00`;
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (m, code) => keep(`<pre><code>${code}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code>${code}</code>`));

  s = s.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
       .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
       .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
       .replace(/^### (.*)$/gm, '<h3>$1</h3>')
       .replace(/^## (.*)$/gm, '<h2>$1</h2>')
       .replace(/^# (.*)$/gm, '<h1>$1</h1>');
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => `<img alt="${alt}" src="${safeUrl(url)}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${txt}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^---$/gm, '<hr>');
  // 表格：| a | b | 表头 + |---|---| 分隔行 + 数据行
  s = s.replace(/(^\|.+\|[^\n]*\n\|[ :|-]+\|[^\n]*\n(?:\|[^\n]*\n?)*)/gm, (m, tbl) => {
    const rows = tbl.trim().split('\n')
      .map((r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
    const head = rows[0];
    const body = rows.slice(2);
    return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
      body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`;
  });
  s = s.replace(/^\s*[-*+] \[ \] (.*)$/gm, '<div><input type="checkbox" disabled> $1</div>');
  s = s.replace(/^\s*[-*+] \[x\] (.*)$/gm, '<div><input type="checkbox" checked disabled> $1</div>');
  s = s.replace(/^\s*[-*+] (.*)$/gm, '<li>$1</li>');
  // 只把「连续相邻」的 li 归为一个 ul，避免贪婪匹配把中间的段落吞进列表
  s = s.replace(/(?:<li>[\s\S]*?<\/li>)(?:\s*<li>[\s\S]*?<\/li>)*/g, (m) => `<ul>${m}</ul>`);
  // 让块级元素各自独立成块，否则「段落 + 紧随的列表」会被当成一个段落整体包进 <p>
  s = s.replace(
    /(<ul>[\s\S]*?<\/ul>|<table>[\s\S]*?<\/table>|<blockquote>[\s\S]*?<\/blockquote>|<h[1-6]>[\s\S]*?<\/h[1-6]>|<hr>)/g,
    '\n\n$1\n\n'
  );
  s = s
    .split(/\n{2,}/)
    .map((blk) => blk.trim())
    .filter(Boolean)
    .map((blk) =>
      /^<(h[1-6]|ul|pre|blockquote|hr|div|li|table)/.test(blk)
        ? blk
        : `<p>${blk.replace(/\n/g, '<br>')}</p>`
    )
    .join('');
  // 回填代码：块级代码若被段落包装（<p>\x00N\x00</p>）则连包装一起还原
  s = s.replace(/<p>\x00(\d+)\x00<\/p>/g, (m, i) => stash[+i]);
  return s.replace(/\x00(\d+)\x00/g, (m, i) => stash[+i]);
}

/* ---------------- 数据加载 ----------------
 * 索引在本地维护：上传/删除/新建目录成功后直接就地增量更新（applyIndexEntries /
 * dropIndexPaths），只有首次加载、点「重建索引」和点站点标题回首页才真的去下载
 * 整份 files.json。这样日常操作不必每次都拉一遍完整索引。
 */

/**
 * 把若干条目并进本地索引（同路径替换，新路径追加）并重绘。
 * 服务端写入索引后会把这些条目回传，前端直接采用，省掉一次全量拉取。
 */
function applyIndexEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const pos = new Map();
  state.index.forEach((f, i) => {
    if (!pos.has(f.p)) pos.set(f.p, i);
  });
  for (const e of entries) {
    if (!e || typeof e.p !== 'string') continue;
    const i = pos.get(e.p);
    if (i === undefined) {
      pos.set(e.p, state.index.length);
      state.index.push(e);
    } else {
      state.index[i] = e;
    }
  }
  render();
}

/**
 * 从本地索引移除若干路径（目录按前缀一并移除）并重绘。
 *
 * 命中判定不能写成「对每个索引条目遍历一遍 paths」（相当于
 * `paths.some((p) => f.p.startsWith(p + '/'))`）：批量删 1000 个文件时那是 O(N×M)，
 * 上百万次字符串比较，页面会卡住。改成先把待删目录收成集合，再沿 '/' 逐级
 * 回退查祖先 —— O(N × 路径深度)。两种写法语义完全一致：
 * 精确命中、或任一层祖先目录命中，都算要移除。
 */
function dropIndexPaths(paths) {
  if (!paths || !paths.length) return;
  const exact = new Set(paths);
  const dirs = new Set();
  for (const p of paths) dirs.add(p + '/');
  state.index = state.index.filter((f) => {
    if (exact.has(f.p)) return false;
    for (let i = f.p.lastIndexOf('/'); i >= 0; i = f.p.lastIndexOf('/', i - 1)) {
      if (dirs.has(f.p.slice(0, i + 1))) return false;
    }
    return true;
  });
  render();
}

async function loadIndex() {
  // 非本地模式且未配置下载域：索引无法获取，跳过 fetch('') 直接按空索引渲染
  const url = idxUrl();
  if (!url) {
    state.index = [];
    render();
    return;
  }
  try {
    // cache:'no-store' 只让**浏览器**不吃本地缓存；files.json 对象本身带
    // Cache-Control: public, max-age=10（store.ts 的 INDEX_META），CDN 层最多再缓存 10 秒。
    // 日常上传/删除靠本地增量更新立即可见，这里只在「首次加载 / 重建索引 / 回首页」才拉整份。
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    state.index = Array.isArray(data.files) ? data.files : [];
    const up = $('idx-updated');
    if (up && data.updated) up.textContent = '索引更新于 ' + fmtTime(data.updated);
  } catch {
    // 拉取失败时保留上一次的索引，避免网络抖动把页面清空成「目录是空的」。
    // 首次加载就失败时 index 为空，若静默处理，页面会显示「这个目录是空的」，
    // 用户会误以为文件丢了——两种情形都必须给出反馈。
    toast(
      state.index.length
        ? '索引加载失败，当前显示的是上次结果'
        : '索引加载失败，请刷新重试',
      'err'
    );
  }
  render();
}

/* ---------------- 上传 ---------------- */

function putFile(url, file, onProgress, ctype) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    // ctype 由 uploadFiles 传入（已在签名时小写化），与 SigV4 签名契约保持一致；
    // 独立调用时取 file.type 的小写，避免大小写不匹配导致 R2 403。
    xhr.setRequestHeader('Content-Type', ctype || (file.type || 'application/octet-stream').toLowerCase());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error('HTTP ' + xhr.status));
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

/** 简易并发池：一次拖入上千文件时逐个排队，避免瞬间打满请求把浏览器拖死 */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/**
 * 上传一批文件。入参元素支持两种形态：
 *   File            —— 平铺上传到当前目录
 *   { file, path }  —— 按 path（相对当前目录）上传，用于文件夹拖拽时保留目录结构
 *
 * 链路：一次批量签名 → 并发 PUT → 一次批量提交索引。
 * 逐文件发三次请求时，拖入几百个文件会放大成几百次 Worker 调用和几百次
 * 索引读改写；批量后只剩「N 次 PUT + 2 次控制请求」，索引读写压到 1 次。
 */
async function uploadFiles(list) {
  const items = [...list].map((it) => (it instanceof File ? { file: it, path: it.name } : it));
  if (!items.length) return;

  const box = $('uploading');
  box.classList.remove('hidden');
  if (items.length > 20) toast(`正在上传 ${items.length} 个文件…`);

  // 目标目录在整批上传期间固定：pool 是排队执行的，若上传途中切了目录，
  // 后调度的文件会读到新的 state.cur，从而落到别的目录去
  const baseDir = state.cur;

  // 每个文件一行独立进度，失败行保留并给出重试按钮
  const jobs = items.map((it) => {
    const rel = it.path || it.file.name;
    return {
      file: it.file,
      rel,
      path: baseDir ? baseDir + '/' + rel : rel,
      row: addUpRow(box, rel),
      url: '',
      ctype: '',
      ok: false,
    };
  });

  await runBatchUpload(jobs);

  // 成功的行会在 1.2 秒后自行移除，此时容器可能已经空了。空容器有 1px 边框，
  // 会在页面上留一条细线，所以收干净；只有存在失败行（带重试按钮）时才继续显示。
  if (!box.children.length) box.classList.add('hidden');
}

/** 在进度区追加一行，返回该行元素 */
function addUpRow(box, rel) {
  const row = document.createElement('div');
  row.className = 'up-item';
  row.innerHTML = `<span class="up-name" title="${esc(rel)}">${esc(rel)}</span>
    <span class="up-bar"><i></i></span>
    <span class="up-st">等待中</span>`;
  box.appendChild(row);
  return row;
}

/** 行状态：写入完成，稍后自动消失（顺带把空的上传容器收起来） */
function markDone(j) {
  const st = j.row.querySelector('.up-st');
  st.textContent = '完成';
  st.className = 'up-st ok';
  setTimeout(() => {
    j.row.remove();
    const box = $('uploading');
    if (box && !box.children.length) box.classList.add('hidden');
  }, 1200);
}

/** 行状态：失败，附「重试」按钮（重试走单文件链路，不依赖整批的签名结果） */
function markFail(j, msg) {
  const st = j.row.querySelector('.up-st');
  st.textContent = msg;
  st.className = 'up-st err';
  const old = j.row.querySelector('.up-retry');
  if (old) old.remove();
  const btn = document.createElement('button');
  btn.className = 'mini up-retry';
  btn.textContent = '重试';
  btn.onclick = () => retryOne(j);
  j.row.appendChild(btn);
}

/**
 * 单次批量请求（签名 / 提交索引）的条目上限。
 *
 * 必须与服务端 src/index.ts 的 MAX_COMMIT_BATCH 对齐，理由那边写得很细：
 * /api/commit 每一条都要一次 R2 head，再加索引的读 + 写，N 条就是 N+2 个子请求，
 * 而平台对「内部服务子请求」有 1000 次/请求的硬上限。前端只负责把大批判小，
 * 真正的守门人仍是服务端常量（超了会返回 413）。
 * test-frontend.mjs 有一条断言钉住「前端分批 ≤ 服务端 MAX_COMMIT_BATCH」。
 */
const UPLOAD_CHUNK = 400;

/**
 * 单次批量「删除」的条目上限。
 *
 * 必须与服务端 src/index.ts 的 MAX_DELETE_BATCH 对齐。删除不像 commit 那样每条
 * 一个 head（只是 N 个 key 一次 bucket.delete + 索引读写），所以服务端给的是 1000。
 * 但上限就是上限：一个目录里有 1001 个文件时「全选 → 批量删除」会整批被 413 拒掉，
 * 一个都删不了——所以前端同样必须分批。
 * test-frontend.mjs 有一条断言钉住「前端分批 ≤ 服务端 MAX_DELETE_BATCH」。
 */
const DELETE_CHUNK = 1000;

/** 把数组切成每块不超过 size 的若干块（size 非正数时原样返回一块） */
function chunk(arr, size) {
  if (!(size > 0)) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 批量上传：分批签名 → 并发 PUT → 分批提交索引。
 * 两个控制步骤都按「整批」合并，只有真正的数据传输（PUT）按并发池展开；
 * 整批超过 UPLOAD_CHUNK 时才拆成多次——一次拖入上千个文件必须在这里拆开，
 * 否则服务端按上限整批 413，连签名都拿不到。
 */
async function runBatchUpload(jobs) {
  // 1) 分批签名（每批把 N 次请求压成 1 次）
  try {
    for (const part of chunk(jobs, UPLOAD_CHUNK)) {
      const res = await fetch('/api/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: part.map((j) => ({
            path: j.path,
            size: j.file.size,
            // 统一小写：SigV4 签名会对 Content-Type 做 toLowerCase（sigv4.ts），
            // 大小写不一致会让 R2 判签名不匹配返回 403
            type: (j.file.type || 'application/octet-stream').toLowerCase(),
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '签名失败');
      const signed = Array.isArray(data.items) ? data.items : [];
      if (signed.length !== part.length) throw new Error('签名结果数量不匹配');
      part.forEach((j, i) => {
        j.url = signed[i].url;
        // 优先用服务端回传的 ctype：它按扩展名归一（浏览器给不出 7z/dmg/apk 的 MIME），
        // 且 presigned 模式下就是签名用的值，必须与 PUT 头完全一致否则 403
        j.ctype = signed[i].ctype || (j.file.type || 'application/octet-stream').toLowerCase();
      });
    }
  } catch (err) {
    for (const j of jobs) markFail(j, err.message || '签名失败');
    return;
  }

  // 2) 并发 PUT（只有这一步在传数据）
  await pool(jobs, 4, (j) => putJob(j));

  // 3) 分批提交索引：只提交 PUT 成功的。每批独立 try/catch，
  //    某一批索引写入失败不会把已经成功的其他批也标红（旧版是整批一起标红）。
  const done = jobs.filter((j) => j.ok);
  if (!done.length) return;
  for (const part of chunk(done, UPLOAD_CHUNK)) {
    try {
      const res = await fetch('/api/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: part.map((j) => ({ path: j.path, type: j.ctype })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '索引写入失败');
      const missing = new Set(Array.isArray(data.missing) ? data.missing : []);
      for (const j of part) {
        if (missing.has(j.path)) markFail(j, '对象未落盘');
        else markDone(j);
      }
      // 索引就地增量更新，不再为一次上传重新下载整份 files.json
      applyIndexEntries(data.entries);
    } catch (err) {
      for (const j of part) markFail(j, err.message || '索引写入失败');
    }
  }
}

/** 单个文件的 PUT，带进度条 */
function putJob(j) {
  const bar = j.row.querySelector('.up-bar i');
  const st = j.row.querySelector('.up-st');
  st.className = 'up-st';
  st.textContent = '上传中';
  bar.style.width = '0%';
  return putFile(
    j.url,
    j.file,
    (p) => {
      bar.style.width = Math.round(p * 100) + '%';
      st.textContent = Math.round(p * 100) + '%';
    },
    j.ctype
  )
    .then(() => {
      j.ok = true;
      st.textContent = '写入索引';
    })
    .catch((err) => {
      j.ok = false;
      markFail(j, err.message || '上传失败');
    });
}

/** 失败行的重试：走完整的单文件链路（sign → PUT → commit） */
async function retryOne(j) {
  const btn = j.row.querySelector('.up-retry');
  if (btn) btn.remove();
  const st = j.row.querySelector('.up-st');
  const bar = j.row.querySelector('.up-bar i');
  st.className = 'up-st';
  st.textContent = '重试中';
  bar.style.width = '0%';
  try {
    const type = (j.file.type || 'application/octet-stream').toLowerCase();
    const signRes = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: j.path, size: j.file.size, type }),
    });
    const sign = await signRes.json().catch(() => ({}));
    if (!signRes.ok) throw new Error(sign.error || '签名失败');
    const ctype = sign.ctype || type;

    st.textContent = '上传中';
    await putFile(
      sign.url,
      j.file,
      (p) => {
        bar.style.width = Math.round(p * 100) + '%';
        st.textContent = Math.round(p * 100) + '%';
      },
      ctype
    );

    st.textContent = '写入索引';
    const commit = await fetch('/api/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: j.path, type: ctype }),
    });
    const data = await commit.json().catch(() => ({}));
    if (!commit.ok) throw new Error(data.error || '索引写入失败');
    markDone(j);
    applyIndexEntries(data.entries);
  } catch (err) {
    markFail(j, err.message || '失败');
  }
}

/* ---------------- 上传入口：拖放 + 粘贴 ---------------- */

/**
 * 从 DataTransfer 读出全部文件（含文件夹递归），返回 [{ file, path }]。
 * 浏览器不支持 webkitGetAsEntry 时退化为平铺文件列表。
 */
async function filesFromDataTransfer(dt) {
  const items = dt.items ? [...dt.items].filter((it) => it.kind === 'file') : [];
  const entries = [];
  for (const it of items) {
    const en = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
    if (en) entries.push(en);
  }
  if (!entries.length) return dt.files && dt.files.length ? [...dt.files] : [];

  const out = [];
  for (const en of entries) await walkEntry(en, '', out);
  return out;
}

/** 递归展开 entry：文件直接收，目录逐层下钻，path 保留相对目录结构 */
function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (f) => {
          out.push({ file: f, path: prefix + f.name });
          resolve();
        },
        () => resolve() // 单个文件读取失败不应中断整批
      );
      return;
    }
    if (!entry.isDirectory) return resolve();

    // 坑：readEntries 每次最多返回 100 项，必须反复调用直到返回空数组才算读完
    const reader = entry.createReader();
    const children = [];
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            Promise.all(children.map((c) => walkEntry(c, prefix + entry.name + '/', out))).then(
              () => resolve()
            );
            return;
          }
          children.push(...batch);
          readBatch();
        },
        () => resolve()
      );
    };
    readBatch();
  });
}

/** 整页拖放：拖文件到页面任意位置即可上传，文件夹保留目录结构 */
function bindDrop() {
  const dz = $('dropzone');
  const mask = $('drop-mask');
  const hint = $('dm-hint');
  // 拖过子元素会反复触发 dragleave，用深度计数判定是否真的离开了页面
  let depth = 0;

  const hasFiles = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && [...types].includes('Files');
  };
  const show = (on) => {
    if (mask) mask.classList.toggle('hidden', !on);
    if (dz) dz.classList.toggle('over', on);
    if (on && hint) {
      hint.textContent =
        '上传到：' + (state.cur || '根目录') + (CFG.isLogin ? '' : '（未登录，无法上传）');
    }
  };

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show(true);
  });

  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // 不阻止默认行为，浏览器会直接打开文件、把页面顶掉
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', () => {
    // 这里不能判断 hasFiles：部分浏览器在 dragleave 时 dataTransfer.types 已清空，
    // 一旦提前 return，depth 就只增不减 → 全屏遮罩永久卡住。
    // 统一按「离开一次减一层」，drop 里再重置，保证一定能收干净。
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });

  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    if (!CFG.isLogin) {
      toast('请先登录再上传', 'err');
      return;
    }
    const list = await filesFromDataTransfer(e.dataTransfer);
    if (list.length) uploadFiles(list);
  });
}

/** 粘贴上传：截图后 Ctrl+V 直接传，当图床用 */
function bindPaste() {
  document.addEventListener('paste', (e) => {
    if (!CFG.isLogin) return;
    // 焦点在输入框里时，粘贴的是文本而非文件，不该触发上传
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    const files = [];
    for (const it of [...items]) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    if (!files.length) return;

    e.preventDefault();
    uploadFiles(files.map(renamePasted));
  });
}

/** 截图粘贴出来的文件默认叫 image.png，连传几次就互相覆盖，改成时间戳命名 */
function renamePasted(file) {
  if (!/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;
  const ext = file.name.split('.').pop();
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return new File([file], `截图-${stamp}.${ext}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  const input = $('file-input');
  const dz = $('dropzone');
  const emptyUp = $('empty-up');

  // 左上角标题点击返回首页：回根目录 + 清空搜索
  const siteTitle = document.querySelector('.site-title');
  if (siteTitle) {
    siteTitle.onclick = () => {
      state.cur = '';
      state.q = '';
      state.searchMode = false;
      const q = $('q');
      if (q) q.value = '';
      resetSel();
      loadIndex();
    };
  }

  dz.onclick = () => input.click();
  if (emptyUp) emptyUp.onclick = () => input.click();
  input.onchange = () => {
    if (input.files.length) uploadFiles([...input.files]);
    input.value = '';
  };

  $('v-list').onclick = () => {
    state.view = 'list';
    $('v-list').classList.add('active');
    $('v-grid').classList.remove('active');
    render();
  };
  $('v-grid').onclick = () => {
    state.view = 'grid';
    $('v-grid').classList.add('active');
    $('v-list').classList.remove('active');
    render();
  };

  let timer;
  $('q').oninput = (e) => {
    clearTimeout(timer);
    const v = e.target.value.trim();
    timer = setTimeout(() => {
      state.q = v;
      state.searchMode = !!v;
      resetSel();
      render();
    }, 200);
  };

  const btnLogin = $('btn-login');
  if (btnLogin) {
    btnLogin.onclick = async () => {
      const password = await dialog({
        title: '管理登录',
        input: true,
        okText: '登录',
        placeholder: '请输入管理口令',
      });
      if (!password) return;
      let res;
      try {
        res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        });
      } catch {
        toast('网络错误，登录请求未送达', 'err');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) location.reload();
      else toast(data.error || '登录失败', 'err');
    };
  }

  const btnLogout = $('btn-logout');
  if (btnLogout) {
    btnLogout.onclick = async () => {
      try {
        await fetch('/api/logout', { method: 'POST' });
      } catch {
        // 请求没送达时刷新没有意义（cookie 还在），直接提示
        toast('网络错误，退出登录未完成', 'err');
        return;
      }
      location.reload();
    };
  }

  const btnRefresh = $('btn-refresh');
  if (btnRefresh) {
    btnRefresh.onclick = async () => {
      if (btnRefresh.disabled) return;
      btnRefresh.disabled = true;
      const old = btnRefresh.textContent;
      btnRefresh.textContent = '重建中…';
      try {
        const res = await fetch('/api/refresh', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          btnRefresh.textContent = `已重建（${data.files} 个文件）`;
          await loadIndex();
        } else {
          btnRefresh.textContent = data.error || '失败';
        }
      } catch {
        btnRefresh.textContent = '网络错误';
      }
      setTimeout(() => {
        btnRefresh.textContent = old;
        btnRefresh.disabled = false;
      }, 2500);
    };
  }

  const btnMkdir = $('btn-mkdir');
  if (btnMkdir) {
    btnMkdir.onclick = async () => {
      const name = await dialog({
        title: '新建目录',
        input: true,
        inputType: 'text',
        okText: '创建',
        placeholder: state.cur
          ? `目录名（创建在 ${state.cur} 下）`
          : '目录名（支持嵌套，如 文档/图片）',
      });
      if (!name) return;
      const dir = name
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      if (!dir) {
        toast('目录名不能为空', 'err');
        return;
      }
      if (dir.split('/').some((s) => !s || s === '.' || s === '..')) {
        toast('目录名非法', 'err');
        return;
      }
      const path = state.cur ? state.cur + '/' + dir : dir;
      let res;
      try {
        res = await fetch('/api/mkdir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        });
      } catch {
        toast('网络错误，目录未创建', 'err');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast('目录已创建');
        // 目录占位条目：与 /api/mkdir 写进索引的内容保持一致
        applyIndexEntries([{ p: path + '/', s: 0, t: Date.now(), c: 'application/octet-stream' }]);
      } else {
        toast(data.error || '创建失败', 'err');
      }
    };
  }

  /* ---- 批量操作条 ---- */
  const bcAll = $('bc-all');
  if (bcAll) bcAll.onclick = selectAllToggle;
  const bcCopy = $('bc-copy');
  if (bcCopy) bcCopy.onclick = batchCopy;
  const bcDl = $('bc-dl');
  if (bcDl) bcDl.onclick = batchDownload;
  const bcDel = $('bc-del');
  if (bcDel) bcDel.onclick = batchDelete;
  const bcClear = $('bc-clear');
  if (bcClear) bcClear.onclick = () => {
    state.sel.clear();
    updateBatch();
  };
}

/* ---------------- 启动 ---------------- */

bindEvents();
// 行/单元格操作事件委托只需初始化一次（内部用 closest 分发）
bindRowEvents();
bindDrop();
bindPaste();
updateBatch();
loadIndex();
