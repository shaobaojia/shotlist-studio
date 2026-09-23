// 块库卡·整理态渲染（M5e）：段头（✎ ↑ ↓ ＋块 ✕）＋ 块行（点文本即编 / ⋮⋮ 拖拽 / ☆ / ✕）＋ 底栏。
// 操作族在 bc-ops.js（单向依赖：本模块 -> bc-ops，反向不引）。
import { el, toast } from './ui.js';
import { recordUndo } from './edit.js';
import {
  blocksData, blockOp, moveBlockTo, siblingList, togglePin, deleteBlockWithUndo,
} from './blocks.js';
import {
  inlineCommit, attachSecMenu, attachRowMenu, renameCatInline, draftBlockInline, catMove, deleteCat,
  newBlockUncat, newCatInline,
} from './bc-ops.js';

const PALETTE = ['#b8563e', '#c08a2e', '#7a8b3f', '#4e7f6a', '#5d7fa3', '#8a6aa8', '#a05f74', '#8b6b4a'];
function catColor(cid) {
  if (cid == null) return '#9a9182';
  const d = blocksData();
  const idx = d ? d.categories.findIndex((c) => c.id === cid) : -1;
  return PALETTE[(idx < 0 ? PALETTE.length - 1 : idx) % PALETTE.length];
}

// ── 拖拽（移植自旧管理器）：换类 + 行间定位；指示元素 O(1) 清除 ──
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
  grip.title = '拖动到其它分类 / 位置（松手即生效，可 Ctrl+Z）';
  grip.draggable = true;
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
    if (src) moveBlockTo(src, catId, list.length);
  });
}

// ── 行内编辑（点文本换 textarea；Ctrl+Enter / 点外存 · Esc 弃；失败留字）──
function editOrgRow(ctx, row, b, txtEl) {
  if (row.querySelector('.bco-edit')) return;
  const ta = document.createElement('textarea');
  ta.className = 'bco-edit';
  ta.value = String(b.text == null ? '' : b.text);
  ta.rows = 2;
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

function orgRow(ctx, b, catId) {
  const row = el('div', 'bco-row');
  row.dataset.id = b.id;
  row.appendChild(gripOf(row, b));
  const star = el('span', 'bco-star' + (b.pinned ? ' on' : ''), b.pinned ? '★' : '☆');
  star.title = b.pinned ? '取消置顶' : '置顶（排最前）';
  star.addEventListener('click', () => togglePin(b));
  row.appendChild(star);
  const txt = el('div', 'bco-text', String(b.text == null ? '' : b.text));
  txt.title = '点击编辑（Ctrl+Enter 存 · Esc 弃）';
  txt.addEventListener('click', () => editOrgRow(ctx, row, b, txt));
  row.appendChild(txt);
  const x = el('span', 'bco-x', '✕');
  x.title = '删除块（可 Ctrl+Z）';
  x.addEventListener('click', () => deleteBlockWithUndo(b));
  row.appendChild(x);
  bindRowDrop(row, b, catId);
  attachRowMenu(ctx, row, b);                        // 整理态行右键与日常态同款菜单
  return row;
}

function orgSection(ctx, cat, items, forceOpen) {
  const key = cat ? 'c' + cat.id : 'none';
  const sec = el('div', 'bco-sec');
  sec.dataset.catkey = cat ? String(cat.id) : 'none';
  const closed = !forceOpen && ctx.folded.has(key);
  const sh = el('div', 'bc-sechead');
  sh.appendChild(el('span', 'bc-secarrow', closed ? '▸' : '▾'));
  const dot = el('span', 'bc-secdot');
  dot.style.setProperty('--bc-cat', catColor(cat ? cat.id : null));
  sh.appendChild(dot);
  sh.appendChild(el('span', 'bc-secname', cat ? cat.name : '未分类'));
  sh.appendChild(el('span', 'bc-seccount', String(items.length)));
  const ops = el('span', 'bco-ops');
  const addFlow = () => {
    if (closed) {
      ctx.folded.delete(key);
      ctx.foldSave();
      ctx.refresh();
      requestAnimationFrame(() => {
        const s2 = ctx.list.querySelector('.bco-sec[data-catkey="' + sec.dataset.catkey + '"]');
        if (s2) draftBlockInline(ctx, s2, cat);
      });
    } else draftBlockInline(ctx, sec, cat);
  };
  const mkOp = (label, tip, fn) => {
    const o = el('span', 'bco-op', label);
    o.title = tip;
    o.addEventListener('mousedown', (e) => e.preventDefault());
    o.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    ops.appendChild(o);
  };
  if (cat) {
    mkOp('✎', '重命名分类', () => renameCatInline(ctx, sh.querySelector('.bc-secname'), cat));
    mkOp('↑', '分类上移', () => catMove(ctx, cat, -1));
    mkOp('↓', '分类下移', () => catMove(ctx, cat, 1));
    mkOp('＋块', '在本类加一个新块', addFlow);
    mkOp('✕', '删除分类（其下块落「未分类」，块不丢）', () => deleteCat(ctx, cat));
  } else {
    mkOp('＋块', '在未分类加一个新块', addFlow);
  }
  sh.appendChild(ops);
  attachSecMenu(ctx, sh, cat ? cat.id : null);
  sh.addEventListener('mousedown', (e) => e.preventDefault());
  sh.addEventListener('click', () => {
    if (forceOpen) return;
    if (closed) ctx.folded.delete(key); else ctx.folded.add(key);
    ctx.foldSave();
    ctx.refresh();
  });
  sec.appendChild(sh);
  const rows = el('div', 'bco-rows');
  if (!closed) for (const b of items) rows.appendChild(orgRow(ctx, b, cat ? cat.id : null));
  bindRowsDrop(rows, cat ? cat.id : null);
  sec.appendChild(rows);
  return sec;
}

// 整理态入口：分组渲染（含空类，供新建/拖放）＋ 底栏
export function renderOrg(ctx, listEl, arr, opts) {
  const showEmpty = !!(opts && opts.showEmpty);
  const forceOpen = !!(opts && opts.forceOpen);
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
    listEl.appendChild(orgSection(ctx, c, items, forceOpen));
  }
  const uncat = buckets.get('none') || [];
  if (uncat.length || showEmpty) listEl.appendChild(orgSection(ctx, null, uncat, forceOpen));
  const foot = el('div', 'bco-foot');
  const nb = el('span', 'bco-fbtn primary', '＋ 新建块');
  nb.title = '在「未分类」加一个新块';
  nb.addEventListener('mousedown', (e) => e.preventDefault());
  nb.addEventListener('click', () => newBlockUncat(ctx));
  const nc = el('span', 'bco-fbtn', '＋ 新分类');
  nc.addEventListener('mousedown', (e) => e.preventDefault());
  nc.addEventListener('click', () => newCatInline(ctx, listEl));
  foot.appendChild(nb);
  foot.appendChild(nc);
  foot.appendChild(el('span', 'bco-hint', '拖 ⋮⋮ 排序 / 换类'));
  listEl.appendChild(foot);
}
