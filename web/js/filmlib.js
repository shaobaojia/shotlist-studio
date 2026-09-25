// 工程库（M8 刀B）：标题位＝当前工程名（点击弹层）；弹层＝工程管理（切换 / 自由关 / 新建·复制 / 归档 / 删除）；
// 剪贴板条＝跨工程复制粘贴（会话级内存——切工程 / 关源工程不丢）。
// 依赖方向：本模块单向依赖 api/state/ui/float/menu/route/scene；main.js 经 initFilmLib 注入回调。
import { api } from './api.js';
import { state, sceneLabel } from './state.js';
import { el, toast, isFloatTarget } from './ui.js';
import { floatEnter, floatLeave } from './float.js';
import { openMenu, menuOpen } from './menu.js';
import { sceneNo, hashOf } from './route.js';
import { refreshCurrentView } from './scene.js';

const LS_CUR = 'studio.film';            // 启动自动打开上次的工程
const LS_STATE = 'studio.filmstate.';    // 每工程「当前场」记忆
const SS_OPENED = 'studio.opened';       // 会话内「已打开」集（多开工作区）

let hooks = null;          // { onSwitch(fid), onReload() }——main.js 注入
let titleName = null;      // 标题按钮内文本
let titleBtn = null;       // 标题按钮
let pop = null;            // 弹层（挂 .float-card）
let popCleanup = null;     // 弹层关闭清理
let newOpen = false;       // 新建表单展开态
let archOpen = false;      // 归档区展开态
let filmsCache = [];       // 最近一次工程列表（弹层渲染用）
let clip = null;           // 剪贴板 {filmId, filmTitle, ids, count}（会话内内存）
let clipBar = null;        // 剪贴板条

// ── 已打开集（会话级；多开工作区语义） ──
function openedSet() {
  try {
    const a = JSON.parse(sessionStorage.getItem(SS_OPENED) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function openedSave(a) {
  try { sessionStorage.setItem(SS_OPENED, JSON.stringify(a)); } catch (e) { /* ignore */ }
}
function openedMark(fid) {
  const a = openedSet();
  if (a.indexOf(fid) === -1) { a.push(fid); openedSave(a); }
}
function openedUnmark(fid) {
  openedSave(openedSet().filter((x) => x !== fid));
}

// ── 启动解析：localStorage 记忆 → 第一个非归档 → 第一个 ──
export function resolveCurrentFilm(films) {
  let fid = null;
  try { fid = Number(localStorage.getItem(LS_CUR)) || null; } catch (e) { /* ignore */ }
  if (films.some((f) => f.id === fid)) return fid;
  const f = films.find((x) => !x.archived) || films[0];
  return f ? f.id : null;
}

// ── 标题位 ──
function renderTitle() {
  if (titleName) titleName.textContent = (state.film && state.film.title) || '测试列表';
}

// main.js 切换 / 改名后调用：关弹层 + 重渲标题 + 刷剪贴板条
export function filmsChanged() {
  closePop();
  renderTitle();
  renderClipBar();
}

export function initFilmLib(h) {
  hooks = h;
  titleBtn = document.getElementById('film-title');
  titleName = document.getElementById('film-title-name');
  renderTitle();
  titleBtn.addEventListener('click', () => { if (pop) closePop(); else openPop(); });
  renderClipBar();
}

// ── 弹层 ──
function closePop() {
  if (!pop) return;
  const p = pop;
  pop = null;
  if (popCleanup) { popCleanup(); popCleanup = null; }
  floatLeave('film', closePop);
  p.remove();
}

async function openPop() {
  let films = [];
  try { films = (await api.films()).films || []; } catch (e) { toast('工程列表读取失败：' + e.message, 'err'); return; }
  filmsCache = films;
  const cur = state.filmId;
  if (cur != null) openedMark(cur);

  pop = el('div', 'float-card film-pop');
  const head = el('div', 'fp-head');
  head.appendChild(el('b', null, '工程'));
  const nw = el('button', 'tool-btn small', '＋ 新建工程…');
  nw.title = '新建空白工程，或从现有工程复制';
  nw.addEventListener('click', () => { newOpen = !newOpen; renderPop(); });
  head.appendChild(nw);
  pop.appendChild(head);
  pop.appendChild(el('div', 'fp-body'));
  renderPop();

  document.body.appendChild(pop);
  const r = titleBtn.getBoundingClientRect();
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';

  floatEnter('film', closePop);
  // 点外 / Esc / 滚动 / resize 关闭（自管：标题按钮与浮层豁免——菜单优先让位）
  const onDown = (e) => {
    if (!pop) return;
    if (pop.contains(e.target)) return;
    if (titleBtn.contains(e.target)) return;          // 按钮自负 toggle
    if (isFloatTarget(e.target)) return;              // 浮卡 / 菜单不关（连续操作）
    closePop();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || !pop) return;
    if (menuOpen()) return;                           // 菜单优先
    e.stopPropagation();
    closePop();
  };
  const onScroll = (e) => { if (pop && !pop.contains(e.target)) closePop(); };
  const onResize = () => { if (pop) closePop(); };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  popCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };
}

function itemRow(f, isCur) {
  const opened = openedSet();
  const isOpen = opened.indexOf(f.id) > -1;
  const it = el('div', 'fp-item' + (isCur ? ' cur' : '') + (!isCur && isOpen ? ' opened' : ''));
  it.dataset.fid = f.id;
  it.appendChild(el('span', 'fp-dot', isCur ? '●' : (isOpen ? '○' : '')));
  it.appendChild(el('span', 'fp-name', f.title));
  const when = (f.last_edit || '').slice(5, 16);
  it.appendChild(el('span', 'fp-meta', f.scene_count + ' 场 · ' + f.shot_count + ' 镜' + (when ? ' · ' + when : '')));

  const ops = el('span', 'fp-ops');
  if (!isCur && isOpen) {
    const x = el('button', 'tool-btn small', '关');
    x.title = '从工作区关闭（数据不动）';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeFilm(f.id); });
    ops.appendChild(x);
  }
  const ed = el('button', 'tool-btn small', '✎');
  ed.title = '重命名';
  ed.addEventListener('click', (e) => { e.stopPropagation(); renameInline(it, f); });
  ops.appendChild(ed);
  const more = el('button', 'tool-btn small', '⋯');
  more.title = '更多（归档 / 删除）';
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(more, [
      { key: 'arch', label: f.archived ? '取消归档' : '归档' },
      { sep: true },
      { key: 'del', label: '删除工程…' },
    ], (k) => {
      if (k === 'arch') doArchive(f);
      else if (k === 'del') doDelete(f);
    });
  });
  ops.appendChild(more);
  it.appendChild(ops);

  it.addEventListener('click', () => {
    if (f.id === state.filmId) { closePop(); return; }
    openedMark(f.id);
    closePop();
    hooks.onSwitch(f.id);
  });
  return it;
}

function renderPop() {
  if (!pop) return;
  const body = pop.querySelector('.fp-body');
  body.textContent = '';
  if (newOpen) body.appendChild(buildNewForm());

  const cur = state.filmId;
  const curFilm = filmsCache.find((f) => f.id === cur) || null;
  const opened = openedSet();
  const active = filmsCache.filter((f) => !f.archived && f.id !== cur);
  active.sort((a, b) => ((opened.indexOf(b.id) > -1) - (opened.indexOf(a.id) > -1)) || (a.id - b.id));
  if (curFilm) body.appendChild(itemRow(curFilm, true));
  for (const f of active) body.appendChild(itemRow(f, false));

  const arch = filmsCache.filter((f) => f.archived && f.id !== cur);
  if (arch.length) {
    const a = el('div', 'fp-arch', '已归档（' + arch.length + '）' + (archOpen ? ' ▾' : ' ▸'));
    a.addEventListener('click', () => { archOpen = !archOpen; renderPop(); });
    body.appendChild(a);
    if (archOpen) for (const f of arch) body.appendChild(itemRow(f, false));
  }
  if (!filmsCache.length) body.appendChild(el('div', 'fp-empty', '还没有工程——点右上「＋ 新建工程…」'));
}

function buildNewForm() {
  const f = el('div', 'fp-new');
  const inp = document.createElement('input');
  inp.className = 'fp-new-name';
  inp.placeholder = '工程名';
  const sel = document.createElement('select');
  sel.className = 'fp-new-src';
  const o0 = document.createElement('option');
  o0.value = '';
  o0.textContent = '空白工程';
  sel.appendChild(o0);
  for (const s of filmsCache) {
    const o = document.createElement('option');
    o.value = String(s.id);
    o.textContent = '复制自：' + s.title + (s.archived ? '（已归档）' : '');
    sel.appendChild(o);
  }
  const ok = el('button', 'tool-btn', '创建');
  ok.addEventListener('click', async () => {
    const t = inp.value.trim();
    if (!t) { toast('请填工程名', 'err'); inp.focus(); return; }
    try {
      const src = sel.value ? Number(sel.value) : null;
      const res = await api.filmCreate(t, src);
      const nf = res.film;
      toast('已创建：' + nf.title + (src ? '（复制自现有工程）' : ''));
      newOpen = false;
      openedMark(nf.id);
      closePop();
      hooks.onSwitch(nf.id);
    } catch (e) { toast('创建失败：' + e.message, 'err'); }
  });
  const cancel = el('button', 'tool-btn', '取消');
  cancel.addEventListener('click', () => { newOpen = false; renderPop(); });
  f.appendChild(inp);
  f.appendChild(sel);
  f.appendChild(ok);
  f.appendChild(cancel);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
  });
  return f;
}

function renameInline(it, f) {
  const nameEl = it.querySelector('.fp-name');
  const inp = document.createElement('input');
  inp.className = 'fp-name-inp';
  inp.value = f.title;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  let settled = false;
  const done = async (save) => {
    if (settled) return;
    settled = true;
    const t = inp.value.trim();
    if (!save || !t || t === f.title) { renderPop(); return; }
    try {
      const res = await api.filmRename(f.id, t);
      f.title = res.film.title;
      toast('已重命名为：' + f.title);
      if (f.id === state.filmId) {
        await hooks.onReload();
        renderTitle();
      }
      await refreshList();
    } catch (e) { toast('重命名失败：' + e.message, 'err'); renderPop(); }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  inp.addEventListener('blur', () => done(true));
}

function closeFilm(fid) {
  openedUnmark(fid);
  if (fid !== state.filmId) { renderPop(); return; }
  const opened = openedSet().filter((x) => x !== fid && filmsCache.some((f) => f.id === x));
  const alt = opened[0] || (filmsCache.find((f) => f.id !== fid && !f.archived) || filmsCache.find((f) => f.id !== fid) || {}).id;
  if (alt == null) { openedMark(fid); toast('只剩这一个工程，先新建再关它'); return; }
  openedMark(alt);
  closePop();
  hooks.onSwitch(alt);
}

async function doArchive(f) {
  try {
    const res = await api.filmArchive(f.id, !f.archived);
    f.archived = res.film.archived;
    toast(res.film.archived ? '已归档：' + f.title : '已取消归档：' + f.title);
    await refreshList();
  } catch (e) { toast('归档失败：' + e.message, 'err'); }
}

async function doDelete(f) {
  if (!confirm('删除工程「' + f.title + '」（' + f.scene_count + ' 场 · ' + f.shot_count + ' 镜）？\n删除前会自动留底快照。')) return;
  if (!confirm('再次确认：删除后该工程从列表消失（留底可在 data/snapshots/films/ 找回）。确定删除？')) return;
  try {
    await api.filmDelete(f.id);
    toast('已删除：' + f.title + '（已自动留底）');
    openedUnmark(f.id);
    if (f.id === state.filmId) {
      const rest = filmsCache.filter((x) => x.id !== f.id);
      const alt = rest.find((x) => !x.archived) || rest[0];
      closePop();
      if (alt) hooks.onSwitch(alt.id);
      else toast('已无工程——刷新后可点标题新建', 'err');
    } else {
      await refreshList();
    }
  } catch (e) { toast('删除失败：' + e.message, 'err'); }
}

async function refreshList() {
  try {
    filmsCache = (await api.films()).films || [];
    if (pop) renderPop();
  } catch (e) { /* silent */ }
}

// ── 剪贴板（跨工程；会话级内存） ──
export function setClip(ids) {
  if (!ids || !ids.length) { toast('先选中镜头行', 'err'); return; }
  clip = {
    filmId: state.filmId,
    filmTitle: (state.film && state.film.title) || '',
    ids: ids.slice(),
    count: ids.length,
  };
  renderClipBar();
  toast('已复制 ' + clip.count + ' 镜——切换工程后可粘贴');
}

function renderClipBar() {
  if (!clipBar) {
    clipBar = el('div');
    clipBar.id = 'clip-bar';
    document.body.appendChild(clipBar);
  }
  if (!clip || !clip.count) { clipBar.style.display = 'none'; return; }
  clipBar.style.display = 'flex';
  clipBar.textContent = '';
  clipBar.appendChild(el('span', 'cb-txt', '📋 已复制 ' + clip.count + ' 镜'));
  clipBar.appendChild(el('span', 'cb-src', '来自「' + clip.filmTitle + '」'));
  const paste = el('button', 'tool-btn', '粘贴到本场');
  paste.title = '把剪贴板中的镜头追加到当前打开场次的末尾';
  paste.addEventListener('click', doPaste);
  clipBar.appendChild(paste);
  const x = el('button', 'tool-btn small', '✕');
  x.title = '清空剪贴板';
  x.addEventListener('click', () => { clip = null; renderClipBar(); });
  clipBar.appendChild(x);
}

async function doPaste() {
  if (!clip || !clip.ids.length) return;
  const curNo = sceneNo();
  if (!curNo) { toast('先打开一个场，再粘贴到本场', 'err'); return; }
  const sc = state.scenes.find((x) => x.scene_no === curNo);
  if (!sc) { toast('当前场不存在', 'err'); return; }
  try {
    const res = await api.paste(sc.id, clip.ids);
    toast('已粘贴 ' + res.shots.length + ' 镜到 ' + sceneLabel(sc));
    await refreshCurrentView();
  } catch (e) { toast('粘贴失败：' + e.message, 'err'); }
}
