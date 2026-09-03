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
  if (!b) return '-';
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

function kindOf(name, isDir) {
  if (isDir) return 'dir';
  const ext = name.split('.').pop().toLowerCase();
  for (const kind in EXT_KIND) {
    if (EXT_KIND[kind].includes(ext)) return kind;
  }
  return 'file';
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
      render();
    };
  });
}

/** 本地开发（未配 R2 凭证）时改走 Worker 代理，生产环境直连公开桶 */
function dlUrl(path) {
  if (CFG.local) return '/api/local-get?key=' + encodeURIComponent(path);
  // 生产但未配置下载域：直链不可用，返回 #（点击无操作），
  // 避免拼出 "undefined/xxx" 的坏链接误导用户以为下载坏了
  if (!CFG.dlDomain) return '#';
  return CFG.dlDomain + '/' + path.split('/').map(encodeURIComponent).join('/');
}

function idxUrl() {
  if (CFG.local) return '/api/local-index';
  // 未配置下载域时索引也无法获取；返回空让 loadIndex 走容灾分支
  return CFG.dlDomain ? CFG.dlDomain + '/files.json' : '';
}

/* ---------------- 预览 ----------------
 * 图片/视频/音频直接走浏览器原生能力；
 * 文本/Markdown 拉取内容在前端渲染（限 2MB，超出直接提示下载）；
 * 其余类型不弹窗，直接下载。
 */

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

function previewable(name, size) {
  const kind = kindOf(name, false);
  if (kind === 'image' || kind === 'video' || kind === 'audio') return true;
  if (kind === 'code' && (size || 0) <= TEXT_PREVIEW_LIMIT) return true;
  return false;
}

function openPreview(f) {
  // 索引对象没有 name 字段，从路径补齐（列表行对象已带 name）
  const name = f.name || f.p.split('/').pop();
  const kind = kindOf(name, false);
  const url = dlUrl(f.p);
  const box = $('pv');
  const body = $('pv-body');

  $('pv-title').textContent = name;
  const dl = $('pv-dl');
  dl.href = url;
  dl.setAttribute('download', name);
  box.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // 用 addEventListener 而非直接覆盖 document.onkeydown：
  // 否则预览与登录/删除弹窗会互相顶掉对方的键盘监听
  const onPvKey = (e) => {
    if (e.key === 'Escape' && !box.classList.contains('hidden')) clear();
  };
  const clear = () => {
    body.innerHTML = '';
    box.classList.add('hidden');
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
  } else {
    // 文本 / markdown：拉取后渲染
    body.innerHTML = `<div class="pv-err">加载中…</div>`;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then((text) => {
        if (/\.md$/i.test(name)) {
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
        body.innerHTML = `<div class="pv-err">加载失败：${esc(err.message || '网络错误')}</div>`;
      });
  }

  $('pv-close').onclick = clear;
  $('pv-mask').onclick = clear;
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
    const canPreview = previewable(f.name, f.s);
    const nameHtml = canPreview
      ? `<a href="#" data-prev="${esc(f.p)}" title="${esc(f.name)}">${esc(f.name)}</a>`
      : `<a href="${esc(dlUrl(f.p))}" title="${esc(f.name)}">${esc(f.name)}</a>`;
    return `<div class="row">
      <div class="name">
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
  bindRowEvents();
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
    </div>`;
  });

  const fileCells = items.files.map((f) => {
    const kind = kindOf(f.name, false);
    const thumb = kind === 'image'
      ? `<div class="thumb"><img loading="lazy" src="${esc(dlUrl(f.p))}" alt=""><span class="tag">图片</span></div>`
      : `<div class="thumb t-${kind}"><span class="tag">${KIND_LABEL[kind] || '文件'}</span>${badge(f.name, false, 32)}</div>`;
    return `<div class="cell" data-cell="${esc(f.p)}">
      ${thumb}
      <div class="body">
        <div class="nm" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="mt">${fmtSize(f.s)} · ${fmtTime(f.t)}</div>
      </div>
    </div>`;
  });

  $('grid').innerHTML = dirCells.join('') + fileCells.join('');

  $('grid').querySelectorAll('[data-dir]').forEach((el) => {
    el.onclick = () => {
      state.cur = el.dataset.dir;
      render();
    };
  });
  $('grid').querySelectorAll('[data-cell]').forEach((el) => {
    el.onclick = () => {
      const f = state.index.find((x) => x.p === el.dataset.cell);
      if (f && previewable(f.name, f.s)) openPreview(f);
      else window.open(dlUrl(el.dataset.cell), '_blank');
    };
  });
}

function bindRowEvents() {
  document.querySelectorAll('#list [data-dir]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      state.cur = a.dataset.dir;
      render();
    };
  });
  document.querySelectorAll('#list [data-copy]').forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('链接已复制');
      } catch {
        toast('复制失败，请检查浏览器权限', 'err');
      }
    };
  });
  document.querySelectorAll('#list [data-prev]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const f = state.index.find((x) => x.p === a.dataset.prev);
      if (f) openPreview(f);
    };
  });
  document.querySelectorAll('#list [data-del]').forEach((b) => {
    b.onclick = async () => {
      const sure = await dialog({
        title: '删除文件',
        body: '确定删除「' + b.dataset.del.split('/').pop() + '」？此操作不可撤销。',
        okText: '删除',
        danger: true,
      });
      if (!sure) return;
      const res = await fetch('/api/file', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: b.dataset.del }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast('已删除');
        await loadIndex();
      } else {
        toast(data.error || '删除失败', 'err');
      }
    };
  });
  document.querySelectorAll('#list [data-deldir]').forEach((b) => {
    b.onclick = async () => {
      const sure = await dialog({
        title: '删除目录',
        body: '确定删除目录「' + b.dataset.deldir + '」及其中的所有文件？此操作不可撤销。',
        okText: '删除',
        danger: true,
      });
      if (!sure) return;
      const res = await fetch('/api/dir', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: b.dataset.deldir }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(data.removed ? `已删除（含 ${data.removed} 个文件）` : '已删除');
        await loadIndex();
      } else {
        toast(data.error || '删除失败', 'err');
      }
    };
  });
}

function render() {
  renderCrumb();

  const hint = $('dz-hint');
  if (hint && CFG.isLogin) {
    hint.textContent = `文件上传到当前目录${state.cur ? '：' + state.cur : '（根目录）'}`;
  }

  let items;
  if (state.searchMode) {
    const q = state.q.toLowerCase();
    items = {
      dirs: [],
      files: state.index
        // 跳过目录占位条目（<dir>/ 0 字节对象），只搜真实文件
        .filter((f) => !f.p.endsWith('/') && f.p.toLowerCase().includes(q))
        .map((f) => ({ ...f, name: f.p })),
    };
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

async function renderReadme(items) {
  const box = $('readme');
  if (!box) return;
  const hit = items.files.find((f) => /^readme\.md$/i.test(f.name));
  if (!hit) {
    box.classList.add('hidden');
    return;
  }
  try {
    const res = await fetch(dlUrl(hit.p));
    const text = await res.text();
    box.innerHTML = `<div class="hd"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>README.md</div><div class="bd md">${md(text)}</div>`;
    box.classList.remove('hidden');
  } catch {
    box.classList.add('hidden');
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
  let s = esc(src);
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (m, code) => `<pre><code>${code}</code></pre>`);
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
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
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
    /(<ul>[\s\S]*?<\/ul>|<table>[\s\S]*?<\/table>|<pre>[\s\S]*?<\/pre>|<blockquote>[\s\S]*?<\/blockquote>|<h[1-6]>[\s\S]*?<\/h[1-6]>|<hr>)/g,
    '\n\n$1\n\n'
  );
  return s
    .split(/\n{2,}/)
    .map((blk) => blk.trim())
    .filter(Boolean)
    .map((blk) =>
      /^<(h[1-6]|ul|pre|blockquote|hr|div|li|table)/.test(blk)
        ? blk
        : `<p>${blk.replace(/\n/g, '<br>')}</p>`
    )
    .join('');
}

/* ---------------- 数据加载 ---------------- */

async function loadIndex() {
  try {
    const res = await fetch(idxUrl(), { cache: 'no-store' });
    const data = await res.json();
    state.index = Array.isArray(data.files) ? data.files : [];
    const up = $('idx-updated');
    if (up && data.updated) up.textContent = '索引更新于 ' + fmtTime(data.updated);
  } catch {
    // 拉取失败时保留上一次的索引，避免网络抖动把页面清空成「目录是空的」
    if (state.index.length) toast('索引加载失败，当前显示的是上次结果', 'err');
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

async function uploadFiles(fileList) {
  const box = $('uploading');
  box.classList.remove('hidden');

  for (const file of fileList) {
    const path = state.cur ? state.cur + '/' + file.name : file.name;
    const row = document.createElement('div');
    row.className = 'up-item';
    row.innerHTML = `<span class="up-name">${esc(file.name)}</span>
      <span class="up-bar"><i></i></span>
      <span class="up-st">等待中</span>`;
    box.appendChild(row);
    const bar = row.querySelector('.up-bar i');
    const st = row.querySelector('.up-st');

    // 统一小写化 MIME：SigV4 签名会对 Content-Type 做 toLowerCase（sigv4.ts），
    // 若这里用浏览器原始大小写（如 Text/Plain）而签名基于小写，R2 会判签名不匹配返回 403。
    // 因此 sign / PUT / commit 三处共用同一小写值，保证与签名契约完全一致。
    const type = (file.type || 'application/octet-stream').toLowerCase();
    try {
      const signRes = await fetch('/api/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, size: file.size, type }),
      });
      const sign = await signRes.json();
      if (!signRes.ok) throw new Error(sign.error || '签名失败');

      st.textContent = '上传中';
      await putFile(sign.url, file, (p) => {
        bar.style.width = Math.round(p * 100) + '%';
        st.textContent = Math.round(p * 100) + '%';
      }, type);

      st.textContent = '写入索引';
      const commit = await fetch('/api/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, size: file.size, type }),
      });
      if (!commit.ok) throw new Error('索引写入失败');

      st.textContent = '完成';
      st.className = 'up-st ok';
      setTimeout(() => row.remove(), 1200);
    } catch (err) {
      st.textContent = err.message || '失败';
      st.className = 'up-st err';
      // 失败行也要清理，否则会一直堆积在进度区
      setTimeout(() => row.remove(), 3000);
    }
  }

  await loadIndex();
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
      loadIndex();
    };
  }

  dz.onclick = () => input.click();
  if (emptyUp) emptyUp.onclick = () => input.click();
  input.onchange = () => {
    if (input.files.length) uploadFiles([...input.files]);
    input.value = '';
  };

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('over');
    })
  );
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
  });

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
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) location.reload();
      else toast(data.error || '登录失败', 'err');
    };
  }

  const btnLogout = $('btn-logout');
  if (btnLogout) {
    btnLogout.onclick = async () => {
      await fetch('/api/logout', { method: 'POST' });
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
      const res = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast('目录已创建');
        await loadIndex();
      } else {
        toast(data.error || '创建失败', 'err');
      }
    };
  }
}

/* ---------------- 启动 ---------------- */

bindEvents();
loadIndex();
