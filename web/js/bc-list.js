// 块库卡·列表（M5f 直操版）：一个视图装下所有事——
// 段头：大三角折叠 · 右键（＋块 / 改名 / 上移 / 下移 / 删类）· 拖块到头上＝进该组末尾；
// 块行：⋮⋮ 拖拽（排序 / 换类）· ☆ 置顶 · 点击插入 · ✕ 删除 · 右键「编辑块…」就地编辑；
// 段语义（F3-L2 (a)）：置顶段恒在普通段之前（服务端 pin 拨位固化进 position）；拖放全放开——
// 落点由服务端段感知归位（非置顶不进置顶段＝夹取；置顶落到普通段＝自动取消置顶，可 Ctrl+Z）。
// 底栏：＋新建块 / ＋新分类。「整理模式」已拆除——编辑与拖拽全部发生在平时这一屏里。
// 操作族在 bc-ops.js（单向依赖：本模块 -> bc-ops，反向不引）。
import { el } from './ui.js';
import {
  blockUndo, blockOp, findBlock, moveBlockTo, togglePin, deleteBlockWithUndo,
  sectionsOf, dropIndex, catColorOf, foldKeyOf, catKeyOf,
} from './blocks.js';
import {
  openInline, failRestore, attachSecMenu, attachRowMenu, newBlockUncat, newCatInline,
} from './bc-ops.js';

// ── 拖拽：排序 / 换类 / 拖到段头＝进该组末尾；指示元素 O(1) 清除 ──
let dragging = null;
let markedEl = null;
function clearDropMarks() { if (markedEl) { markedEl.classList.remove('drop-above', 'drop-below', 'drop-end'); markedEl = null; } }
function setDropMark(el0, cls) { clearDropMarks(); markedEl = el0; el0.classList.add(cls); }
function draggedBlock() {
  return findBlock(dragging.id);   // F3-W2：块查找单点
}

function gripOf(row, b) {
  const grip = el('span', 'bco-grip', '⋮⋮');
  grip.title = '拖动：排序 / 换类（也可放到别组头上；松手即生效，可 Ctrl+Z）';
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
    const idx = dropIndex(catId, dragging.id, b.id, below);
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
    const idx = dropIndex(catId, dragging.id, null);
    clearDropMarks();
    if (src) moveBlockTo(src, catId, idx);   // 空区＝放到本组末尾
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
    const idx = dropIndex(catId, dragging.id, null);
    clearDropMarks();
    if (src) moveBlockTo(src, catId, idx);   // 拖到组头上＝进该组末尾
  });
}

// ── 就地编辑（右键「编辑块…」进入）：Ctrl+Enter / 点外存 · Esc 弃 · 失败留字 ──
function editRowInline(ctx, row, b, txtEl) {
  if (row.querySelector('.bco-edit')) return;
  openInline({
    tag: 'textarea', cls: 'bco-edit', value: String(b.text == null ? '' : b.text), rows: 3,
    multiline: true, mount: { kind: 'replace', target: txtEl },
    onCancel: () => ctx.refresh(),
    onCommit: (v, unlock, el0) => {
      if (v === String(b.text)) { ctx.refresh(); return; }
      const oldText = String(b.text);
      blockOp({ action: 'update', id: b.id, text: v }).then(() => {
        blockUndo('改块', () => ({ action: 'update', id: b.id, text: oldText }));
      }).catch((err) => failRestore(err, unlock, el0, '保存'));
    },
  });
}

// ── 块行：白卡 + 左缘分类色条；点击＝插入；右键更多；⋮⋮ 可拖 ──
function blockRow(ctx, b, opts) {
  const drag = !opts || opts.drag !== false;
  const row = el('div', 'bco-row');
  row.dataset.id = b.id;
  row.style.setProperty('--bc-cat', catColorOf(b.category_id));
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
  row.addEventListener('click', () => {
    if (row.querySelector('.bco-edit')) return;          // 本行编辑中：点击只归编辑面（点外＝blur 提交），不触发插入
    ctx.insert(full, b);
  });
  row._startEdit = () => { row.scrollIntoView({ block: 'center' }); editRowInline(ctx, row, b, txt); };
  if (drag) bindRowDrop(row, b, b.category_id);
  attachRowMenu(ctx, row, b);
  return row;
}

// ── 段头 + 段 ──
function listSection(ctx, spec, dragOn) {
  const key = spec.key;
  const secEl = el('div', 'bco-sec');
  secEl.dataset.catkey = catKeyOf(spec.cid);   // F3-W4：属性键单点
  const closed = ctx.folded.has(key);
  const sh = el('div', 'bc-sechead');
  sh.appendChild(el('span', 'bc-secarrow', closed ? '▸' : '▾'));
  const dot = el('span', 'bc-secdot');
  dot.style.setProperty('--bc-cat', catColorOf(spec.cid));
  sh.appendChild(dot);
  const nameEl = el('span', 'bc-secname', spec.name);
  sh.appendChild(nameEl);
  sh.appendChild(el('span', 'bc-seccount', '（' + spec.items.length + '）'));   // 计数贴组名：骨架（1）
  attachSecMenu(ctx, sh, spec.cid, nameEl);          // 右键：＋块 / 改名 / 上移 / 下移 / 删类（nameEl 由本模块给出，操作族不再自拼选择器）
  sh.addEventListener('mousedown', (e) => e.preventDefault());
  sh.addEventListener('click', () => {
    if (closed) ctx.folded.delete(key); else ctx.folded.add(key);
    ctx.foldSave();
    ctx.refresh();
  });
  secEl.appendChild(sh);
  const rows = el('div', 'bco-rows');
  if (!closed) for (const b of spec.items) rows.appendChild(blockRow(ctx, b, { drag: dragOn }));
  bindRowsDrop(rows, spec.cid);
  bindHeadDrop(sh, spec.cid);
  secEl.appendChild(rows);
  return secEl;
}

// ── 列表总渲染：flat＝搜索平铺（不可拖）；否则全部分类（含空类，供拖放/新建）＋ 未分类 ＋ 底栏 ──
export function renderList(ctx, listEl, arr, opts) {
  opts = opts || {};
  // 模块边界适配器（F3-W10）：操作族经 ctx 访问本模块 DOM，不再自拼选择器串
  ctx.sectionEl = (cid) => listEl.querySelector('.bco-sec[data-catkey="' + catKeyOf(cid) + '"]');
  ctx.revealSection = (cid) => {
    const key = foldKeyOf(cid);
    if (ctx.folded.has(key)) { ctx.folded.delete(key); ctx.foldSave(); ctx.refresh(); return true; }
    return false;
  };
  ctx.editRow = (id) => {
    requestAnimationFrame(() => {
      const row = listEl.querySelector('.bco-row[data-id="' + id + '"]');
      if (row && row._startEdit) row._startEdit();
    });
  };
  const dragOn = opts.draggable !== false;
  if (opts.mode === 'flat') {
    for (const b of arr) listEl.appendChild(blockRow(ctx, b, { drag: false }));
    return;
  }
  for (const spec of sectionsOf(arr, { showEmpty: true })) listEl.appendChild(listSection(ctx, spec, dragOn));
  const foot = el('div', 'bco-foot');
  const nb = el('span', 'bco-fbtn primary', '＋ 新建块');
  nb.title = '在「未分类」加一个新块';
  nb.addEventListener('mousedown', (e) => e.preventDefault());
  nb.addEventListener('click', () => newBlockUncat(ctx));
  const nc = el('span', 'bco-fbtn', '＋ 新分类');
  nc.title = '建一个新的分类组';
  nc.addEventListener('mousedown', (e) => e.preventDefault());
  nc.addEventListener('click', () => newCatInline(listEl));
  foot.appendChild(nb);
  foot.appendChild(nc);
  foot.appendChild(el('span', 'bco-hint', '拖 ⋮⋮ 排序 / 换类'));
  listEl.appendChild(foot);
}
