// 工程库（M8 刀B）：标题位＝当前工程名（点击弹层）；弹层＝工程管理（切换 / 自由关 / 新建·复制 / 归档 / 删除）。
// 依赖：api / state / ui / float / menu（均为事件回调期取用，无顶层互触）；剪贴板独立在 clip.js（selbar 引用它）。
import { api } from './api.js';
import { state } from './state.js';
import { el, toast, placeNear, onOutsideClose, lsGet, lsSet, fmtStamp } from './ui.js';
import { floatEnter, floatLeave } from './float.js';
import { openMenu, menuOpen } from './menu.js';

const LS_CUR = 'studio.film';            // 启动自动打开上次的工程
const LS_STATE = 'studio.filmstate.';    // 每工程「当前场」记忆
const SS_OPENED = 'studio.opened';       // 会话内「已打开」集（多开工作区）

let hooks = null;          // { onSwitch(fid) }——main.js 注入
let titleName = null;      // 标题按钮内文本
let titleBtn = null;       // 标题按钮
let pop = null;            // 弹层（挂 .float-card）
let popCleanup = null;     // 弹层关闭清理
let opening = false;       // 弹层在飞守卫（防连点叠层；M8 清理刀）
let renameAbort = null;    // 编辑中「关层即弃」钩子（closePop 调用；防 Esc/点外经移除-blur 误提交；M8 清理刀 fix）
let newOpen = false;       // 新建表单展开态
let archOpen = false;      // 归档区展开态
let filmsCache = [];       // 最近一次工程列表（弹层渲染用）

// ── 工程记忆单点（M8 清理刀）：键与读写的唯一出处（main.js 经此，不再手拼字面量） ──
export function readLastFilm() { const v = lsGet(LS_CUR, null); return Number(v) || null; }
export function writeLastFilm(fid) { lsSet(LS_CUR, fid == null ? null : Number(fid)); }
export function rememberScene(fid, no) { if (fid != null) lsSet(LS_STATE + fid, no || ''); }
export function recallScene(fid) { return lsGet(LS_STATE + fid, '') || ''; }

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
  const fid = readLastFilm();
  if (films.some((f) => f.id === fid)) return fid;
  const f = films.find((x) => !x.archived) || films[0];
  return f ? f.id : null;
}

// ── 标题位 ──
function renderTitle() {
  if (titleName) titleName.textContent = (state.film && state.film.title) || '测试列表';
}

// main.js 切换 / 改名后调用：关弹层 + 重渲标题
export function filmsChanged() {
  closePop();
  renderTitle();
}

export function initFilmLib(h) {
  hooks = h;
  titleBtn = document.getElementById('film-title');
  titleName = document.getElementById('film-title-name');
  renderTitle();
  titleBtn.addEventListener('click', () => { if (pop) closePop(); else openPop(); });
}

// ── 弹层 ──
function closePop() {
  if (!pop) return;
  if (renameAbort) renameAbort();           // 关层即弃编辑：不提交（防 Esc/点外经移除-blur 误提交；M8 清理刀 fix）
  const p = pop;
  pop = null;
  if (popCleanup) { popCleanup(); popCleanup = null; }
  floatLeave('film', closePop);
  p.remove();
}

async function openPop() {
  if (pop || opening) return;               // 在飞守卫：请求窗口内连点不叠层（M8 清理刀）
  opening = true;
  try {
    let films = [];
    try { films = (await api.films()).films || []; }
    catch (e) { toast('工程列表读取失败：' + e.message, 'err'); return; }
    filmsCache = films;
    newOpen = false;                        // 弹层态归零：重开不带上次的展开态（M8 清理刀）
    archOpen = false;
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
    placeNear(titleBtn, pop);               // 定位单点（F4-W24：下贴 / 翻上 / 夹取；M8 清理刀）

    floatEnter('film', closePop);
    popCleanup = onOutsideClose(pop, closePop, {    // 点外 / Esc / 滚动 / resize（F2-W23 单点；M8 清理刀）
      onEsc: () => menuOpen(),              // 菜单优先让位（edit.js 同款）
      floatExempt: true,                    // 浮卡 / 菜单不关（连续操作）
      closeOnScroll: true,
      closeOnResize: true,
      exempt: titleBtn,                     // 按钮自负 toggle
    });
  } finally { opening = false; }
}

function itemRow(f, isCur, opened) {
  const isOpen = opened.indexOf(f.id) > -1;
  const it = el('div', 'fp-item' + (isCur ? ' cur' : '') + (!isCur && isOpen ? ' opened' : ''));
  it.dataset.fid = f.id;
  it.appendChild(el('span', 'fp-dot', isCur ? '●' : (isOpen ? '○' : '')));
  it.appendChild(el('span', 'fp-name', f.title));
  const when = f.last_edit ? fmtStamp(f.last_edit, 'md-hm') : '';   // 时间戳单点（M8 清理刀）
  it.appendChild(el('span', 'fp-meta', f.scene_count + ' 场 · ' + f.shot_count + ' 镜' + (when ? ' · ' + when : '')));

  const ops = el('span', 'fp-ops');
  if (isOpen) {                             // 当前工程也可关：关 → 自动切下一个（M8 清理刀补入口）
    const x = el('button', 'tool-btn small', '关');
    x.title = isCur ? '关闭该工作区并切到下一个已打开工程' : '从工作区关闭（数据不动）';
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
    if (it.querySelector('.fp-name-inp')) return;      // 本行编辑中：点击只归编辑面（M8 清理刀）
    if (f.id === state.filmId) { closePop(); return; }
    openedMark(f.id);
    closePop();
    hooks.onSwitch(f.id);
  });
  return it;
}

function captureFormState(body) {
  const n = body.querySelector('.fp-new-name');
  if (!n) return null;
  const s = body.querySelector('.fp-new-src');
  return { name: n.value, src: s ? s.value : '' };
}

function renderPop() {
  if (!pop) return;
  const body = pop.querySelector('.fp-body');
  const st = body.scrollTop;                          // 滚动位先存后还（M8 清理刀）
  const keep = captureFormState(body);                // 新建表单值保留（M8 清理刀）
  body.textContent = '';
  if (newOpen) body.appendChild(buildNewForm(keep));

  const cur = state.filmId;
  const curFilm = filmsCache.find((f) => f.id === cur) || null;
  const opened = openedSet();
  const active = filmsCache.filter((f) => !f.archived && f.id !== cur);
  active.sort((a, b) => ((opened.indexOf(b.id) > -1) - (opened.indexOf(a.id) > -1)) || (a.id - b.id));
  if (curFilm) body.appendChild(itemRow(curFilm, true, opened));
  for (const f of active) body.appendChild(itemRow(f, false, opened));

  const arch = filmsCache.filter((f) => f.archived && f.id !== cur);
  if (arch.length) {
    const a = el('div', 'fp-arch', '已归档（' + arch.length + '）' + (archOpen ? ' ▾' : ' ▸'));
    a.addEventListener('click', () => { archOpen = !archOpen; renderPop(); });
    body.appendChild(a);
    if (archOpen) for (const f of arch) body.appendChild(itemRow(f, false, opened));
  }
  if (!filmsCache.length) body.appendChild(el('div', 'fp-empty', '还没有工程——点右上「＋ 新建工程…」'));
  body.scrollTop = st;
}

function buildNewForm(keep) {
  const f = el('div', 'fp-new');
  const inp = document.createElement('input');
  inp.className = 'fp-new-name';
  inp.placeholder = '工程名';
  if (keep) inp.value = keep.name;
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
  if (keep) sel.value = keep.src;
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
  const ex = it.querySelector('.fp-name-inp');
  if (ex) { ex.focus(); ex.select(); return; }         // 已在编辑：聚焦即可（M8 清理刀）
  const nameEl = it.querySelector('.fp-name');
  const inp = document.createElement('input');
  inp.className = 'fp-name-inp';
  inp.value = f.title;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  let settled = false;
  const restore = () => inp.replaceWith(el('span', 'fp-name', f.title));   // 原位还原（不整表重建；M8 清理刀）
  const abort = () => {                        // 关层弃编辑（closePop 钩子；M8 清理刀 fix）
    renameAbort = null;
    if (!settled) { settled = true; restore(); }
  };
  renameAbort = abort;
  const done = async (save) => {
    if (settled) return;
    settled = true;
    renameAbort = null;                        // 本编辑收束（提交/取消均清钩子）
    const t = inp.value.trim();
    if (!save || !t || t === f.title) { restore(); return; }
    try {
      const res = await api.filmRename(f.id, t);
      f.title = res.film.title;
      if (res.films) filmsCache = res.films;             // 信封就地套用（F3-L4；M8 清理刀）
      toast('已重命名为：' + f.title);
      if (f.id === state.filmId) {
        state.film = Object.assign({}, state.film, { title: f.title });   // 就地换题（省一轮 reloadFilm；M8 清理刀）
        renderTitle();
      }
      restore();
      const nf = filmsCache.find((x) => x.id === f.id);
      const m = it.querySelector('.fp-meta');
      if (nf && m) {
        const when = nf.last_edit ? fmtStamp(nf.last_edit, 'md-hm') : '';
        m.textContent = nf.scene_count + ' 场 · ' + nf.shot_count + ' 镜' + (when ? ' · ' + when : '');
      }
    } catch (e) { toast('重命名失败：' + e.message, 'err'); restore(); }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  inp.addEventListener('blur', () => { if (inp.isConnected) done(true); });   // 弹层级关闭（capture Esc / 点外）解除连接 → 不提交（M8 清理刀）
}

function closeFilm(fid) {
  openedUnmark(fid);
  if (fid !== state.filmId) { renderPop(); return; }
  // 关的是当前：工作区切到下一个已打开 → 非归档 → 任意（M8 清理刀：具名变量重构）
  const rest = filmsCache.filter((x) => x.id !== fid);
  const altOpened = openedSet().map((id) => rest.find((f) => f.id === id)).find(Boolean) || null;
  const alt = altOpened || rest.find((f) => !f.archived) || rest[0] || null;
  if (!alt) { openedMark(fid); toast('只剩这一个工程，先新建再关它'); return; }
  openedMark(alt.id);
  closePop();
  hooks.onSwitch(alt.id);
}

async function doArchive(f) {
  try {
    const res = await api.filmArchive(f.id, !f.archived);
    if (res.films) filmsCache = res.films;               // 信封就地套用（M8 清理刀）
    toast(res.film.archived ? '已归档：' + f.title : '已取消归档：' + f.title);
    renderPop();
  } catch (e) { toast('归档失败：' + e.message, 'err'); }
}

async function doDelete(f) {
  if (!confirm('删除工程「' + f.title + '」（' + f.scene_count + ' 场 · ' + f.shot_count + ' 镜）？\n删除前会自动留底快照。')) return;
  if (!confirm('再次确认：删除后该工程从列表消失（留底可在 data/snapshots/films/ 找回）。确定删除？')) return;
  try {
    const res = await api.filmDelete(f.id);
    filmsCache = res.films || filmsCache.filter((x) => x.id !== f.id);   // 信封就地套用（M8 清理刀）
    toast('已删除：' + f.title + '（已自动留底）');
    openedUnmark(f.id);
    if (f.id === state.filmId) {
      const alt = filmsCache.find((x) => !x.archived) || filmsCache[0] || null;
      closePop();
      if (alt) hooks.onSwitch(alt.id);
      else { toast('已无工程——点左上标题位新建', 'err'); hooks.onSwitch(null); }   // 空态收口（M8 清理刀）
    } else {
      renderPop();
    }
  } catch (e) { toast('删除失败：' + e.message, 'err'); }
}
