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

// 卡运行时状态单点（F3-L4/W16：原 13 个模块级散变量收拢进一个对象——引用一律 card.*）
const card = {
  dr: null, root: null, innerEl: null, listRefresh: null, insertCb: null,   // 抽屉引用 / 根 / 内层 / 列表重绘 / 插入回调
  active: false, upMode: false, pendShow: false, tAppear: null,             // 激活 / 上贴模式 / 待浮现 / 浮现定时器
  mem: { w: DEF_W, h: DEF_H, open: false },                                 // 尺寸与开合（落盘）
  pinnedOnly: false, query: '', loadErr: null,                              // 置顶筛选（W16 已收窄布尔）/ 搜索词 / 载入失败（B5 可上屏重试）
};

function lsLoad() { return lsGet(LS_KEY, {}) || {}; }
function lsSave() { lsSet(LS_KEY, card.mem); }

// 面板几何与贴紧标记：一律走抽屉几何契约（F3-L1）——card.dr.geom() 只读几何（免疫动画期 rect 漂）、
// card.dr.setUnder() 写贴紧类（镜像抑制在抽屉侧）。原先的样式反解（edgeValue/frameRect，含 5 处
// parseFloat）与 applyUnder 直写类均已退役。

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
    tSearch = setTimeout(() => { tSearch = null; card.query = search.value.trim().toLowerCase(); draw(); }, 120);
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
    insert: (t, b) => { if (card.insertCb) card.insertCb(t, b); },
    isFolded: (key) => folded.has(key),                                     // F3-L4/W11：折叠状态与落盘捆绑——消费者不再直持 Set
    toggleFold: (key) => { if (folded.has(key)) folded.delete(key); else folded.add(key); foldSave(); },
    foldAll: (open) => {
      if (!blocksData()) return;
      // 只改 folded（F3-W19①）：键从分段规格取，重绘统一交给 draw
      for (const s of sectionsOf(visibleBlocks({ pinnedOnly: card.pinnedOnly, query: card.query }))) {
        if (open) folded.delete(s.key); else folded.add(s.key);
      }
      foldSave();
      draw();
    },
  };
  attachBlankMenu(ctx, list);                          // 列表空白右键：新建块 / 新分类 / 全部收起展开

  function mkChip(key, label) {
    const c = el('span', 'bc-fchip' + ((key === 'pin') === card.pinnedOnly ? ' on' : ''), label);
    c.addEventListener('mousedown', (e) => e.preventDefault());
    c.addEventListener('click', () => { card.pinnedOnly = (key === 'pin'); draw(); });
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
      if (card.loadErr) {
        const box = el('div', 'bc-empty', '块库加载失败：' + card.loadErr);
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
    const arr = visibleBlocks({ pinnedOnly: card.pinnedOnly, query: card.query });
    if (card.query) {                                       // 搜索态＝平铺（平铺下不适用拖拽）
      if (!arr.length) list.appendChild(el('div', 'bc-empty', '没有匹配的块'));
      renderList(ctx, list, arr, { mode: 'flat' });
      return;
    }
    addFoldAll(sectionsOf(arr));
    if (!d.blocks.length) list.appendChild(el('div', 'bc-empty', '块库为空 —— 底栏「＋新建块」或右键新建'));
    renderList(ctx, list, arr, { mode: 'sectioned', draggable: !card.pinnedOnly });
  }

  function retryLoad() {
    card.loadErr = null;
    draw();
    ensureBlocks(true).then(() => draw()).catch((err) => {
      card.loadErr = err.message || String(err);
      silent(err, 'blockcard-load');
      draw();
    });
  }

  return draw;
}

// 几何五连写单点（F3-W21②）：宽高 + 落点 + 轴向位移
function place(w, h, left, top, tf) {
  card.root.style.width = w + 'px';
  card.root.style.height = h + 'px';
  card.root.style.left = left + 'px';
  card.root.style.top = top + 'px';
  card.root.style.transform = tf;
}

// ── 布局同步（随抽屉几何/贴附/开合；靠 onGeom 订阅跟拖拽与贴附，F3-L1）──
function layout() {
  if (!card.root) return;
  const g = (card.dr && card.dr.geom) ? card.dr.geom() : null;
  if (!card.active || !g || !g.open) {
    card.root.hidden = true;
    if (g) card.dr.setUnder('none');
    return;
  }
  // 面板入场动画进行中：先藏（否则「块库先于面板出现」）；入场完成事件（onGeom）会再触发本函数
  if (g.entering) { card.root.hidden = true; card.pendShow = true; card.dr.setUnder('none'); return; }
  const r = g;
  const up = (g.dock === 'bottom');
  const switched = (up !== card.upMode);
  card.upMode = up;
  card.root.hidden = false;
  card.root.classList.toggle('bc-clps', !card.mem.open);   // 收起态：露边盖干净「纸口」
  card.root.classList.toggle('bc-up', up);            // 上贴模式位（标签/拉手转上缘的 CSS 依赖它——重写时勿丢！）
  card.dr.setUnder(up ? 'up' : 'left');
  if (card.pendShow) {
    card.pendShow = false;
    clearTimeout(card.tAppear);
    card.tAppear = flashClass(card.root, 'bc-appear', 280);   // F3-W25 单点
  }
  if (switched) card.root.classList.add('bc-noanim');
  if (!up) {
    card.mem.w = clamp(Math.round(card.mem.w) || DEF_W, MIN_W, MAX_W);
    const W = card.mem.w;
    const H = Math.max(MIN_H, Math.round(r.height - INSET * 2));
    place(W, H, Math.round(r.left - W + OVERLAP), Math.round(r.top + INSET),
      card.mem.open ? 'translateX(0)' : 'translateX(' + (W - OVERLAP - SLIVER) + 'px)');
  } else {
    card.mem.h = clamp(Math.round(card.mem.h) || DEF_H, MIN_H, MAX_H);
    const H = card.mem.h;
    const W = Math.max(MIN_W, Math.round(r.width - INSET * 2));
    place(W, H, Math.round(r.left + INSET), Math.round(r.top + OVERLAP - H),
      card.mem.open ? 'translateY(0)' : 'translateY(' + (H - OVERLAP - SLIVER) + 'px)');
  }
  if (switched) { void card.root.offsetWidth; card.root.classList.remove('bc-noanim'); }
}

function toggleOpen() {
  card.mem.open = !card.mem.open;
  lsSave();
  layout();
}

// 拉缘调宽 / 调高：左模式拖左缘（往左＝加宽）；上模式拖上缘（往上＝加高）
function startResize(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const up = card.upMode;
  const sx = e.clientX, sy = e.clientY;
  const sw = card.mem.w, sh = card.mem.h;
  card.root.classList.add('bc-noanim');
  trackDrag((ev) => {                              // F3-W27①：三件套单点
    if (!up) card.mem.w = clamp(Math.round(sw + (sx - ev.clientX)), MIN_W, MAX_W);
    else card.mem.h = clamp(Math.round(sh + (sy - ev.clientY)), MIN_H, MAX_H);
    layout();
  }, () => {
    card.root.classList.remove('bc-noanim');
    lsSave();
  });
}

// ── 对外 ──
export function initBlockCard(drawer) {
  if (card.root) return;
  card.dr = drawer;
  Object.assign(card.mem, lsLoad());
  if (!Number.isFinite(card.mem.w)) card.mem.w = DEF_W;
  if (!Number.isFinite(card.mem.h)) card.mem.h = DEF_H;
  if (typeof card.mem.open !== 'boolean') card.mem.open = false;

  card.root = el('div', 'bcard float-card');   // F3-W28：挂基类
  card.root.hidden = true;
  card.innerEl = el('div', 'bc-inner');
  card.root.appendChild(card.innerEl);
  const tab = el('div', 'bc-tab');
  tab.title = '块库　点按抽出 / 收回';
  tab.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  tab.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(); });
  card.root.appendChild(tab);
  const rz = el('div', 'bc-rz');
  rz.title = '拖拽调宽（左模式）/ 调高（上模式）';
  rz.addEventListener('mousedown', startResize);
  card.root.appendChild(rz);
  document.body.appendChild(card.root);

  card.listRefresh = buildList(card.innerEl);
  card.listRefresh();
  onBlocksChange(() => { if (card.listRefresh) card.listRefresh(); });
  ensureBlocks().then(() => { if (card.listRefresh) card.listRefresh(); }).catch((err) => {   // F3-B5：失败可观察可重试
    card.loadErr = err.message || String(err);
    silent(err, 'blockcard-load');
    if (card.listRefresh) card.listRefresh();
  });

  // 跟面板（F3-L1 几何契约）：抽屉几何/贴附/开合/入场完成 → onGeom 订阅（订阅侧已按帧合并）；
  // 原先「全属性观察者 + 样式反解」退役
  card.dr.onGeom(() => layout());
  onResizeCoalesced(layout);                       // F3-W27③：与抽屉共用一帧一次
  layout();
}

export function cardSetActive(on) {
  card.active = !!on;
  layout();
}

export function cardSetInsert(fn) {
  card.insertCb = fn;
}

