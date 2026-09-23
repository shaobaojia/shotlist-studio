// 块库卡·列表（M5f 直操版）：一个视图装下所有事——
// 段头：大三角折叠 · 右键（＋块 / 改名 / 上移 / 下移 / 删类）· 拖块到头上＝进该组末尾；
// 块行：⋮⋮ 拖拽（排序 / 换类）· ☆ 置顶 · 点击插入 · ✕ 删除 · 右键「编辑块…」就地编辑；
// 底栏：＋新建块 / ＋新分类。「整理模式」已拆除——编辑与拖拽全部发生在平时这一屏里。
// 操作族在 bc-ops.js（单向依赖：本模块 -> bc-ops，反向不引）。
import { el, toast } from './ui.js';
import { recordUndo } from './edit.js';
import {
  blocksData, blockOp, moveBlockTo, siblingList, togglePin, deleteBlockWithUndo,
} from './blocks.js';
import {
  inlineCommit, attachSecMenu, attachRowMenu, newBlockUncat, newCatInline,
} from './bc-ops.js';

const PALETTE = ['#b8563e', '#c08a2e', '#7a8b3f', '#4e7f6a', '#5d7fa3', '#8a6aa8', '#a05f74', '#8b6b4a'];
function catColor(cid) {
  if (cid == null) return '#9a9182';
  const d = blocksData();
  const idx = d ? d.categories.findIndex((c) => c.id === cid) : -1;
  return PALETTE[(idx < 0 ? PALETTE.length - 1 : idx) % PALETTE.length];
}

// ── 拖拽：排序 / 换类 / 拖到段头＝进该组末尾；指示元素 O(1) 清除 ──
let dragging = null;
let markedEl = null;
function clearDropMarks() { if (markedEl) { markedEl.classList.remove('drop-above', 'drop-below', 'drop-end'); markedEl = null; } }
function setDropMark(el0, cls) { clearDropMarks(); markedEl = el0; el0.classList.add(cls); }
function draggedBlock() {
  const d = blocksData();
  return d && d.blocks ? d.blocks.find((x) => x.id === dragging.id) : null;
}

function gripOf(row, b) {
  const grip = el('span', 'bco-grip', '⋮⋮');
  grip.title = '拖动：排序 / 换类（也可放到别组头上；松手即生效，可 Ctrl+Z）';
  grip.draggable = true;
  grip.addEventListener('click', (e) => e.stopPropagation());     // 点抓手下坠不触发「插入」
  grip.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/plain', 'bco:' + b.id);
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setDragImage(row, 14, 14); } catch (err) { /* ignore */ }
    row.classList.add('bco-dragging');
    dragging = { id: b.id };
  });
  grip.addEventListener('dragend', () => {
    row.classList.remove('bco-dragging');
    dragging = null;
    clearDropMarks();
  });
  return grip;
}

function bindRowDrop(row, b, catId) {
  row.addEventListener('dragover', (ev) => {
    if (!dragging || dragging.id === b.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = row.getBoundingClientRect();
    setDropMark(row, ev.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
  });
  row.addEventListener('dragleave', () => {
    if (markedEl === row) { row.classList.remove('drop-above', 'drop-below'); markedEl = null; }
  });
  row.addEventListener('drop', (ev) => {
    if (!dragging || dragging.id === b.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = row.getBoundingClientRect();
    const below = ev.clientY >= r.top + r.height / 2;
    const src = draggedBlock();
    const list = siblingList(catId).filter((x) => x.id !== dragging.id);
    let idx = list.findIndex((x) => x.id === b.id);
    if (idx === -1) idx = list.length; else if (below) idx += 1;
    clearDropMarks();
    if (src) moveBlockTo(src, catId, idx);
  });
}

function bindRowsDrop(rowsEl, catId) {
  rowsEl.addEventListener('dragover', (ev) => {
    if (!dragging || ev.target !== rowsEl) return;
    ev.preventDefault();
    setDropMark(rowsEl, 'drop-end');
  });
  rowsEl.addEventListener('dragleave', (ev) => {
    if (ev.target === rowsEl && markedEl === rowsEl) { rowsEl.classList.remove('drop-end'); markedEl = null; }
  });
  rowsEl.addEventListener('drop', (ev) => {
    if (!dragging || ev.target !== rowsEl) return;
    ev.preventDefault();
    const src = draggedBlock();
    const list = siblingList(catId).filter((x) => x.id !== dragging.id);
    clearDropMarks();
    if (src) moveBlockTo(src, catId, list.length);   // 空区＝放到本组末尾
  });
}

function bindHeadDrop(sh, catId) {
  sh.addEventListener('dragover', (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    setDropMark(sh, 'drop-end');
  });
  sh.addEventListener('dragleave', () => {
    if (markedEl === sh) { sh.classList.remove('drop-end'); markedEl = null; }
  });
  sh.addEventListener('drop', (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    const src = draggedBlock();
    const list = siblingList(catId).filter((x) => x.id !== dragging.id);
    clearDropMarks();
    if (src) moveBlockTo(src, catId, list.length);   // 拖到组头上＝进该组末尾
  });
}

// ── 就地编辑（右键「编辑块…」进入）：Ctrl+Enter / 点外存 · Esc 弃 · 失败留字 ──
function editRowInline(ctx, row, b, txtEl) {
  if (row.querySelector('.bco-edit')) return;
  const ta = document.createElement('textarea');
  ta.className = 'bco-edit';
  ta.value = String(b.text == null ? '' : b.text);
  ta.rows = 3;
  txtEl.replaceWith(ta);
  ta.focus();
  inlineCommit(ta, {
    multiline: true,
    onCancel: () => ctx.refresh(),
    onCommit: (v, unlock) => {
      if (v === String(b.text)) { ctx.refresh(); return; }
      const oldText = String(b.text);
      blockOp({ action: 'update', id: b.id, text: v }).then(() => {
        recordUndo({ type: 'custom', label: '改块',
          undo: async () => { await blockOp({ action: 'update', id: b.id, text: oldText }); } });
      }).catch((err) => { unlock(); ta.focus(); toast('保存失败：' + err.message + '（内容还在）', 'err'); });
    },
  });
}

// ── 块行：白卡 + 左缘分类色条；点击＝插入；右键更多；⋮⋮ 可拖 ──
function blockRow(ctx, b, opts) {
  const drag = !opts || opts.drag !== false;
  const row = el('div', 'bco-row');
  row.dataset.id = b.id;
  row.style.setProperty('--bc-cat', catColor(b.category_id));
  if (drag) row.appendChild(gripOf(row, b));
  const star = el('span', 'bco-star' + (b.pinned ? ' on' : ''), b.pinned ? '★' : '☆');
  star.title = b.pinned ? '取消置顶' : '置顶（排最前）';
  star.addEventListener('click', (e) => { e.stopPropagation(); togglePin(b); });
  row.appendChild(star);
  const full = String(b.text == null ? '' : b.text);
  const txt = el('div', 'bco-text', full || '（空）');
  txt.title = full.slice(0, 240) + (full.length > 240 ? '…' : '') + '\n（点击插入；右键可编辑 / 移动 / 删除）';
  row.appendChild(txt);
  const x = el('span', 'bco-x', '✕');
  x.title = '删除块（可 Ctrl+Z）';
  x.addEventListener('click', (e) => { e.stopPropagation(); deleteBlockWithUndo(b); });
  row.appendChild(x);
  row.title = '点击插入到光标处';
  row.addEventListener('click', () => ctx.insert(full, b));
  row._startEdit = () => { row.scrollIntoView({ block: 'center' }); editRowInline(ctx, row, b, txt); };
  if (drag) bindRowDrop(row, b, b.category_id);
  attachRowMenu(ctx, row, b);
  return row;
}

// ── 段头 + 段 ──
function listSection(ctx, cat, items, dragOn) {
  const key = cat ? 'c' + cat.id : 'none';
  const sec = el('div', 'bco-sec');
  sec.dataset.catkey = cat ? String(cat.id) : 'none';
  const closed = ctx.folded.has(key);
  const sh = el('div', 'bc-sechead');
  sh.appendChild(el('span', 'bc-secarrow', closed ? '▸' : '▾'));
  const dot = el('span', 'bc-secdot');
  dot.style.setProperty('--bc-cat', catColor(cat ? cat.id : null));
  sh.appendChild(dot);
  sh.appendChild(el('span', 'bc-secname', cat ? cat.name : '未分类'));
  sh.appendChild(el('span', 'bc-seccount', String(items.length)));
  attachSecMenu(ctx, sh, cat ? cat.id : null);       // 右键：＋块 / 改名 / 上移 / 下移 / 删类
  sh.addEventListener('mousedown', (e) => e.preventDefault());
  sh.addEventListener('click', () => {
    if (closed) ctx.folded.delete(key); else ctx.folded.add(key);
    ctx.foldSave();
    ctx.refresh();
  });
  sec.appendChild(sh);
  const rows = el('div', 'bco-rows');
  if (!closed) for (const b of items) rows.appendChild(blockRow(ctx, b, { drag: dragOn }));
  bindRowsDrop(rows, cat ? cat.id : null);
  bindHeadDrop(sh, cat ? cat.id : null);
  sec.appendChild(rows);
  return sec;
}

// ── 列表总渲染：flat＝搜索平铺（不可拖）；否则全部分类（含空类，供拖放/新建）＋ 未分类 ＋ 底栏 ──
export function renderList(ctx, listEl, arr, opts) {
  opts = opts || {};
  const dragOn = opts.drag !== false;
  if (opts.flat) {
    for (const b of arr) listEl.appendChild(blockRow(ctx, b, { drag: false }));
    return;
  }
  const showEmpty = opts.showEmpty !== false;
  const d = blocksData() || { categories: [], blocks: [] };
  const buckets = new Map();
  for (const b of arr) {
    const k = b.category_id == null ? 'none' : String(b.category_id);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(b);
  }
  for (const c of d.categories) {
    const items = buckets.get(String(c.id)) || [];
    if (!items.length && !showEmpty) continue;
    listEl.appendChild(listSection(ctx, c, items, dragOn));
  }
  const uncat = buckets.get('none') || [];
  if (uncat.length || showEmpty) listEl.appendChild(listSection(ctx, null, uncat, dragOn));
  const foot = el('div', 'bco-foot');
  const nb = el('span', 'bco-fbtn primary', '＋ 新建块');
  nb.title = '在「未分类」加一个新块';
  nb.addEventListener('mousedown', (e) => e.preventDefault());
  nb.addEventListener('click', () => newBlockUncat(ctx));
  const nc = el('span', 'bco-fbtn', '＋ 新分类');
  nc.title = '建一个新的分类组';
  nc.addEventListener('mousedown', (e) => e.preventDefault());
  nc.addEventListener('click', () => newCatInline(ctx, listEl));
  foot.appendChild(nb);
  foot.appendChild(nc);
  foot.appendChild(el('span', 'bco-hint', '拖 ⋮⋮ 排序 / 换类'));
  listEl.appendChild(foot);
}
