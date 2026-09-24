// 块库卡（M5d）：「下层卡纸 + 索引标签拉手」。
// 形态：提示词面板＝上层硬卡纸；本卡＝压在下面的另一张小一圈的卡纸——
// 平时只露一条边（12px），边上贴一枚小索引标签作拉手（点按抽 / 收）。
// 方向随贴附：浮窗、右贴附＝从左边抽（标签在左缘）；下贴附＝从上边抽（标签在上缘）。
// 只在编辑态出现；宽度 / 高度沿卡缘拖拽可调并记忆；内容＝块库（分类筛选 + 搜索 + 点击插入）。
// M5d-4：随面板入场后再浮现（防「块库先于面板」）；贴紧时面板去左/上投影（bc-under）。
import { el, lsGet, lsSet, clamp, silent, trackDrag, flashClass, onResizeCoalesced } from './ui.js';
import {
  ensureBlocks, blocksData, onBlocksChange, visibleBlocks, sectionsOf,
} from './blocks.js';
import { renderList } from './bc-list.js';
import { attachBlankMenu } from './bc-ops.js';

const SLIVER = 12;                     // 收起时露出的边宽（左缘 / 上缘）
const OVERLAP = 30;                    // 常态压在面板底下的进深
const INSET = 10;                      // 「小一圈」内缩：左模式＝上下；上模式＝左右
const MIN_W = 180, MAX_W = 360, DEF_W = 236;
const MIN_H = 130, MAX_H = 380, DEF_H = 190;
const LS_KEY = 'studio.blockcard';

let dr = null;
let root = null;
let innerEl = null;
let listRefresh = null;
let obs = null;
let insertCb = null;
let active = false;
let upMode = false;
let pendShow = false;                  // 面板入场动画未毕，卡先藏（入场完再浮现）
let tAppear = null;
let underApplied = null;               // 镜像：'none' | 'left' | 'up'（对照后再写，杜绝观察者回路）
const mem = { w: DEF_W, h: DEF_H, open: false };
let pinnedOnly = false;        // 置顶筛选（F3-W16：原先 'all'|'pin'，判定收窄为布尔）
let query = '';
let loadErr = null;            // 载入失败信息（F3-B5：可上屏可重试）

function lsLoad() { return lsGet(LS_KEY, {}) || {}; }
function lsSave() { lsSet(LS_KEY, mem); }

// 面板「贴紧」类：只有镜像状态真的变化才写 DOM——本环境 classList 幂等操作也会
// 虚假触发 attribute mutation，直接写会与观察者形成无限回路（M5d-4 实测死机根因）
function applyUnder(mode) {
  if (mode === underApplied || !dr || !dr.el) return;
  underApplied = mode;
  try {
    dr.el.classList.toggle('bc-under', mode !== 'none');
    dr.el.classList.toggle('bc-under-up', mode === 'up');
  } catch (e) { /* ignore */ }
}

// 面板几何：优先取内联样式坐标（开合/回弹动画期间 rect 会漂，样式值恒定）
// 单轴边值解析（F3-W21①）：先取直写轴；缺则用对侧轴反算；仍缺回 null
function edgeValue(style, a, b, size, extent) {
  const v = parseFloat(style[a]);
  if (Number.isFinite(v)) return v;
  const w = parseFloat(style[b]);
  return Number.isFinite(w) ? extent - w - size : null;
}

function frameRect() {
  const fe = dr.el;
  const s = fe.style;
  const w = parseFloat(s.width), h = parseFloat(s.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return fe.getBoundingClientRect();
  const de = document.documentElement;
  const left = edgeValue(s, 'left', 'right', w, de.clientWidth);
  const top = edgeValue(s, 'top', 'bottom', h, de.clientHeight);
  if (left == null || top == null) return fe.getBoundingClientRect();
  return { left: left, top: top, width: w, height: h };
}

// ── 内容：块库列表（A3 分段标题 + 搜索 + 行点插；含全部收起/展开）──
const LS_FOLD = 'studio.blockcard.fold';
function buildList(host) {
  host.textContent = '';
  const head = el('div', 'bc-head');
  head.appendChild(el('span', 'bc-title', '块库'));
  const count = el('span', 'bc-count', '');
  head.appendChild(count);
  host.appendChild(head);

  const filters = el('div', 'bc-filters');
  host.appendChild(filters);

  const search = document.createElement('input');
  search.className = 'bc-search';
  search.placeholder = '搜索块…';
  search.addEventListener('mousedown', (e) => e.stopPropagation());
  let tSearch = null;                                  // 防抖（F3-W18）：每键整卡重建 → 停 120ms 后一次
  search.addEventListener('input', () => {
    if (tSearch) clearTimeout(tSearch);
    tSearch = setTimeout(() => { tSearch = null; query = search.value.trim().toLowerCase(); draw(); }, 120);
  });
  host.appendChild(search);

  const list = el('div', 'bc-list');
  host.appendChild(list);

  let folded = foldLoad();   // 折叠集：'c<id>' / 'none'
  function foldLoad() {
    const v = lsGet(LS_FOLD, []);
    return new Set(Array.isArray(v) ? v : []);
  }
  function foldSave() { lsSet(LS_FOLD, Array.from(folded)); }

  // 卡片 API（列表 / 菜单共用）：refresh=重绘；insert=插入到编辑面；foldAll=全收/全展
  const ctx = {
    refresh: () => draw(),
    insert: (t, b) => { if (insertCb) insertCb(t, b); },
    folded: folded,
    foldSave: foldSave,
    list: list,
    foldAll: (open) => {
      if (!blocksData()) return;
      // 只改 folded（F3-W19①）：键从分段规格取，重绘统一交给 draw
      for (const s of sectionsOf(visibleBlocks({ pinnedOnly: pinnedOnly, query: query }))) {
        if (open) folded.delete(s.key); else folded.add(s.key);
      }
      foldSave();
      draw();
    },
  };
  attachBlankMenu(ctx, list);                          // 列表空白右键：新建块 / 新分类 / 全部收起展开

  function mkChip(key, label) {
    const c = el('span', 'bc-fchip' + ((key === 'pin') === pinnedOnly ? ' on' : ''), label);
    c.addEventListener('mousedown', (e) => e.preventDefault());
    c.addEventListener('click', () => { pinnedOnly = (key === 'pin'); draw(); });
    return c;
  }

  // 「全部收起/展开」小控件
  function addFoldAll(secs) {
    const anyOpen = secs.some((s) => !folded.has(s.key));
    const fa = el('span', 'bc-foldall', anyOpen ? '收起全部' : '展开全部');
    fa.title = anyOpen ? '把所有分类折起来' : '把所有分类展开';
    fa.addEventListener('mousedown', (e) => e.preventDefault());
    fa.addEventListener('click', () => {
      if (anyOpen) { for (const s of secs) folded.add(s.key); } else { for (const s of secs) folded.delete(s.key); }
      foldSave(); draw();
    });
    filters.appendChild(fa);
  }

  function draw() {
    filters.textContent = '';
    filters.appendChild(mkChip('all', '全部'));
    filters.appendChild(mkChip('pin', '★'));
    const d = blocksData();
    list.textContent = '';
    if (!d) {                                          // 载入中 / 失败可重试（F3-B5：失败不再静默）
      if (loadErr) {
        const box = el('div', 'bc-empty', '块库加载失败：' + loadErr);
        const rt = el('span', 'bc-retry', '重试');
        rt.addEventListener('click', () => retryLoad());
        box.appendChild(rt);
        list.appendChild(box);
      } else {
        list.appendChild(el('div', 'bc-empty', '块库加载中…'));
      }
      count.textContent = '';
      return;
    }
    count.textContent = d.blocks.length + ' 个';
    const arr = visibleBlocks({ pinnedOnly: pinnedOnly, query: query });
    if (query) {                                       // 搜索态＝平铺（平铺下不适用拖拽）
      if (!arr.length) list.appendChild(el('div', 'bc-empty', '没有匹配的块'));
      renderList(ctx, list, arr, { mode: 'flat' });
      return;
    }
    addFoldAll(sectionsOf(arr));
    if (!d.blocks.length) list.appendChild(el('div', 'bc-empty', '块库为空 —— 底栏「＋新建块」或右键新建'));
    renderList(ctx, list, arr, { mode: 'sectioned', draggable: !pinnedOnly });
  }

  function retryLoad() {
    loadErr = null;
    draw();
    ensureBlocks(true).then(() => draw()).catch((err) => {
      loadErr = err.message || String(err);
      silent(err, 'blockcard-load');
      draw();
    });
  }

  return draw;
}

// 几何五连写单点（F3-W21②）：宽高 + 落点 + 轴向位移
function place(w, h, left, top, tf) {
  root.style.width = w + 'px';
  root.style.height = h + 'px';
  root.style.left = left + 'px';
  root.style.top = top + 'px';
  root.style.transform = tf;
}

// 布局 rAF 合并（F3-W20）：观察者 / 窗口 resize 每帧至多触发一次（抽屉拖拽期每 mousemove 触发观察者，直调即每事件一次同步布局）
let layoutRaf = 0;
function scheduleLayout() {
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); });
}

// ── 布局同步（随抽屉几何/贴附/开合；靠 MutationObserver 跟拖拽与贴附）──
function layout() {
  if (!root) return;
  if (!active || !dr || !dr.isOpen()) {
    root.hidden = true;
    applyUnder('none');
    return;
  }
  // 面板入场动画进行中：先藏（否则「块库先于面板出现」）；入场类摘除时观察者会再触发本函数
  if (dr.el.classList.contains('enter')) { root.hidden = true; pendShow = true; applyUnder('none'); return; }
  const r = frameRect();
  const dock = dr.getDock ? dr.getDock() : null;
  const up = (dock === 'bottom');
  const switched = (up !== upMode);
  upMode = up;
  root.hidden = false;
  root.classList.toggle('bc-clps', !mem.open);   // 收起态：露边盖干净「纸口」
  root.classList.toggle('bc-up', up);            // 上贴模式位（标签/拉手转上缘的 CSS 依赖它——重写时勿丢！）
  applyUnder(up ? 'up' : 'left');
  if (pendShow) {
    pendShow = false;
    clearTimeout(tAppear);
    tAppear = flashClass(root, 'bc-appear', 280);   // F3-W25 单点
  }
  if (switched) root.classList.add('bc-noanim');
  if (!up) {
    mem.w = clamp(Math.round(mem.w) || DEF_W, MIN_W, MAX_W);
    const W = mem.w;
    const H = Math.max(MIN_H, Math.round(r.height - INSET * 2));
    place(W, H, Math.round(r.left - W + OVERLAP), Math.round(r.top + INSET),
      mem.open ? 'translateX(0)' : 'translateX(' + (W - OVERLAP - SLIVER) + 'px)');
  } else {
    mem.h = clamp(Math.round(mem.h) || DEF_H, MIN_H, MAX_H);
    const H = mem.h;
    const W = Math.max(MIN_W, Math.round(r.width - INSET * 2));
    place(W, H, Math.round(r.left + INSET), Math.round(r.top + OVERLAP - H),
      mem.open ? 'translateY(0)' : 'translateY(' + (H - OVERLAP - SLIVER) + 'px)');
  }
  if (switched) { void root.offsetWidth; root.classList.remove('bc-noanim'); }
}

function toggleOpen() {
  mem.open = !mem.open;
  lsSave();
  layout();
}

// 拉缘调宽 / 调高：左模式拖左缘（往左＝加宽）；上模式拖上缘（往上＝加高）
function startResize(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const up = upMode;
  const sx = e.clientX, sy = e.clientY;
  const sw = mem.w, sh = mem.h;
  root.classList.add('bc-noanim');
  trackDrag((ev) => {                              // F3-W27①：三件套单点
    if (!up) mem.w = clamp(Math.round(sw + (sx - ev.clientX)), MIN_W, MAX_W);
    else mem.h = clamp(Math.round(sh + (sy - ev.clientY)), MIN_H, MAX_H);
    layout();
  }, () => {
    root.classList.remove('bc-noanim');
    lsSave();
  });
}

// ── 对外 ──
export function initBlockCard(drawer) {
  if (root) return;
  dr = drawer;
  Object.assign(mem, lsLoad());
  if (!Number.isFinite(mem.w)) mem.w = DEF_W;
  if (!Number.isFinite(mem.h)) mem.h = DEF_H;
  if (typeof mem.open !== 'boolean') mem.open = false;

  root = el('div', 'bcard');
  root.hidden = true;
  innerEl = el('div', 'bc-inner');
  root.appendChild(innerEl);
  const tab = el('div', 'bc-tab');
  tab.title = '块库　点按抽出 / 收回';
  tab.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  tab.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(); });
  root.appendChild(tab);
  const rz = el('div', 'bc-rz');
  rz.title = '拖拽调宽（左模式）/ 调高（上模式）';
  rz.addEventListener('mousedown', startResize);
  root.appendChild(rz);
  document.body.appendChild(root);

  listRefresh = buildList(innerEl);
  listRefresh();
  onBlocksChange(() => { if (listRefresh) listRefresh(); });
  ensureBlocks().then(() => { if (listRefresh) listRefresh(); }).catch((err) => {   // F3-B5：失败可观察可重试
    loadErr = err.message || String(err);
    silent(err, 'blockcard-load');
    if (listRefresh) listRefresh();
  });

  // 跟面板：style / class / hidden 变动即重排（拖拽 / 贴附 / 开合全覆盖）；
  // 观察者回调 rAF 合并（F3-W20）：每帧至多一次重排
  obs = new MutationObserver(() => scheduleLayout());
  obs.observe(dr.el, { attributes: true });
  onResizeCoalesced(layout);                       // F3-W27③：与抽屉共用一帧一次
  layout();
}

export function cardSetActive(on) {
  active = !!on;
  layout();
}

export function cardSetInsert(fn) {
  insertCb = fn;
}

