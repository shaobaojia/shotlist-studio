// 块库管理器（M3）：分类与积木块的组织面板（增 / 改 / 删 / 序 / 置顶 / 换分类）。
// 浮动面板挂 body（不随场次页重绘）；所有写操作走 blocks.js 的 blockOp（缓存与订阅统一在那里）。
import { el, toast } from './ui.js';
import { openMenu } from './menu.js';
import { recordUndo } from './edit.js';
import {
  ensureBlocks, blocksData, blockOp, onBlocksChange, moveBlockTo, siblingList,
  byPosition, blockMatch, moveMenu, togglePin, deleteBlockWithUndo, PLACEHOLDERS,
} from './blocks.js';

let panel = null;
let bodyEl = null;
let headEl = null;
let pendingFocus = null;
let offChange = null;
let searchQ = '';
let searchTimer = null;   // 搜索防抖
let dragging = null;
let markedEl = null;      // 拖放指示当前标记的元素（O(1) 清除，替代每次 dragover 全文档扫描）

export function openManager(focusBlockId) {
  pendingFocus = focusBlockId || null;
  if (!panel) build();
  panel.hidden = false;
  ensureBlocks(true).then(() => render()).catch((err) => {
    bodyEl.textContent = '';
    bodyEl.appendChild(el('div', 'bm-note err', '块库加载失败：' + err.message));
  });
}

export function closeManager() {
  if (panel) panel.hidden = true;
}

function build() {
  panel = el('div');
  panel.id = 'block-manager';
  panel.hidden = true;

  headEl = el('div', 'bm-head');
  headEl.appendChild(el('b', null, '块库管理'));
  const qin = document.createElement('input');
  qin.className = 'bm-search';
  qin.placeholder = '搜块…';
  qin.addEventListener('input', () => {                 // 防抖：每键整面板重建 → 停止输入 120ms 后一次
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      searchQ = qin.value.trim().toLowerCase();
      render();
    }, 120);
  });
  headEl.appendChild(qin);
  const addCat = el('button', 'tool-btn small', '＋ 新分类');
  addCat.addEventListener('click', () => startNewCat());
  headEl.appendChild(addCat);
  const x = el('button', 'tool-btn small', '✕');
  x.title = '收起';
  x.addEventListener('click', closeManager);
  headEl.appendChild(x);
  panel.appendChild(headEl);

  bodyEl = el('div', 'bm-body');
  panel.appendChild(bodyEl);
  document.body.appendChild(panel);

  offChange = onBlocksChange(() => render());
}

function render() {
  if (!bodyEl || !panel || panel.hidden) return;
  const d = blocksData() || { categories: [], blocks: [] };
  bodyEl.textContent = '';
  bodyEl.appendChild(el('div', 'bm-note',
    '块 = 一段可直接插入提示词的积木文字。插入即固化（之后改库不影响已写入的）。'
    + '占位符插入时自动代入：' + PLACEHOLDERS.map((k) => '{' + k + '}').join(' ')));
  const cats = d.categories.slice().sort(byPosition);
  const buckets = new Map();                       // 单趟分桶（避免 分类数×块数 逐类扫描）
  for (const b of d.blocks) {
    const k = b.category_id;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(b);
  }
  const hit = (b) => blockMatch(b, searchQ);       // 搜索口径单点（正文 + 分类名）
  let total = 0;
  for (const c of cats) {
    const list = (buckets.get(c.id) || []).filter(hit);
    total += list.length;
    if (searchQ && !list.length) continue;
    bodyEl.appendChild(catSection(c, list));
  }
  const uncat = (buckets.get(null) || []).filter(hit);
  total += uncat.length;
  if (!searchQ || uncat.length) bodyEl.appendChild(catSection(null, uncat));
  if (searchQ && !total) bodyEl.appendChild(el('div', 'bm-note', '没有匹配的块'));

  if (pendingFocus) {
    const row = bodyEl.querySelector('.bm-row[data-id="' + pendingFocus + '"]');
    if (row) {
      row.scrollIntoView({ block: 'center' });
      const t = row.querySelector('.bm-text');
      if (t) t.click();
    }
    pendingFocus = null;
  }
}

function catSection(cat, blocks) {
  const sec = el('div', 'bm-cat');
  const head = el('div', 'bm-cat-head');
  const name = el('span', 'bm-cat-name', cat ? cat.name : '（未分类）');
  if (cat) {
    name.title = '点击改名';
    name.addEventListener('click', () => renameCat(name, cat));
  }
  head.appendChild(name);
  head.appendChild(el('span', 'bm-count', blocks.length + ' 块'));

  const addB = el('button', 'tool-btn small', '＋ 块');
  addB.title = '在本类末尾加一个新块';
  addB.addEventListener('click', () => startDraftBlock(sec, cat));
  head.appendChild(addB);
  if (cat) {
    const up = el('button', 'tool-btn small', '↑');
    up.title = '分类上移';
    up.addEventListener('click', () => catMoveBtn(cat, -1));
    const dn = el('button', 'tool-btn small', '↓');
    dn.title = '分类下移';
    dn.addEventListener('click', () => catMoveBtn(cat, 1));
    const del = el('button', 'tool-btn small', '删');
    del.title = '删除分类（其下块落「未分类」，块不丢）';
    del.addEventListener('click', () => deleteCat(cat));
    head.appendChild(up);
    head.appendChild(dn);
    head.appendChild(del);
  }
  sec.appendChild(head);

  const rows = el('div', 'bm-rows');
  blocks.sort(byPosition);
  for (const b of blocks) rows.appendChild(blockRow(b, sec, cat));
  rows.addEventListener('dragover', (ev) => {
    if (!dragging || ev.target !== rows) return;   // 行内指示由行自己管
    ev.preventDefault();
    setDropMark(rows, 'drop-end');
  });
  rows.addEventListener('drop', (ev) => {
    if (!dragging || ev.target !== rows) return;
    ev.preventDefault();
    clearDropMarks();
    const tgt = dragging;
    const catId = cat ? cat.id : null;
    const list = siblingList(catId).filter((x) => x.id !== tgt.id);
    moveBlockTo(tgt, catId, list.length);
  });
  sec.appendChild(rows);
  return sec;
}

function blockRow(b, sec, cat) {
  const row = el('div', 'bm-row');
  row.dataset.id = b.id;

  const grip = el('span', 'bm-grip', '⋮⋮');
  grip.title = '拖动到其它分类 / 位置（松手即生效，可 Ctrl+Z）';
  grip.draggable = true;
  grip.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/plain', 'bm:' + b.id);
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setDragImage(row, 14, 14); } catch (err) { /* ignore */ }
    row.classList.add('bm-dragging');
    dragging = { id: b.id };
  });
  grip.addEventListener('dragend', () => {
    row.classList.remove('bm-dragging');
    dragging = null;
    clearDropMarks();
    document.querySelectorAll('#block-manager .drop-above, #block-manager .drop-below, #block-manager .drop-end')
      .forEach((x) => x.classList.remove('drop-above', 'drop-below', 'drop-end'));   // 兜底全清（仅拖尾一次）
  });
  row.appendChild(grip);

  const star = el('span', 'bm-star' + (b.pinned ? ' on' : ''), b.pinned ? '★' : '☆');
  star.title = b.pinned ? '取消置顶' : '置顶（热盒里排最前）';
  star.addEventListener('click', () => togglePin(b));
  row.appendChild(star);

  const txt = el('span', 'bm-text', String(b.text));
  txt.title = '点击编辑';
  txt.addEventListener('click', () => editRow(row, b, txt));
  row.appendChild(txt);

  const ops = el('span', 'bm-ops');
  const mk = (label, tip, fn) => {
    const btn = el('span', 'bm-btn', label);
    btn.title = tip;
    btn.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    ops.appendChild(btn);
    return btn;
  };
  mk('↑', '上移', () => moveBtn(b, -1));
  mk('↓', '下移', () => moveBtn(b, 1));
  mk('⇄', '换分类', () => moveMenu(ops, b));
  mk('✕', '删除块（可 Ctrl+Z）', () => deleteBlockWithUndo(b));
  row.appendChild(ops);

  row.addEventListener('dragover', (ev) => {
    if (!dragging || dragging.id === b.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = row.getBoundingClientRect();
    setDropMark(row, ev.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-above', 'drop-below');
    if (markedEl === row) markedEl = null;
  });
  row.addEventListener('drop', (ev) => {
    if (!dragging || dragging.id === b.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = row.getBoundingClientRect();
    const below = ev.clientY >= r.top + r.height / 2;
    const tgt = dragging;
    const catId = cat ? cat.id : null;
    const list = siblingList(catId).filter((x) => x.id !== tgt.id);
    let idx = list.findIndex((x) => x.id === b.id);
    if (idx === -1) idx = list.length;
    else if (below) idx += 1;
    clearDropMarks();
    moveBlockTo(tgt, catId, idx);
  });

  return row;
}

async function catOp(payload) {
  try {
    return await blockOp(payload);
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

function deleteCat(cat) {
  catOp({ action: 'cat_delete', id: cat.id }).then((res) => { if (res) toast('分类已删（块落「未分类」）'); });
}

// 行内提交协议（改名 / 新分类 / 改块 / 新块草稿共一份）：
// Enter（单行）或 Ctrl+Enter（多行）提交 · Esc 取消 · 点外提交；
// 提交失败调 unlock() 解锁并保留输入（内容不丢，可重试——与拼装台「保存失败留字」口径一致）。
function inlineCommit(el0, opts) {
  let done = false;
  opts = opts || {};
  const commit = (ok) => {
    if (done) return;
    if (!ok) {
      done = true;
      if (opts.onCancel) opts.onCancel();
      return;
    }
    const v = el0.value.trim();
    if (!v && opts.emptyAsCancel !== false) {
      done = true;
      if (opts.onCancel) opts.onCancel();
      return;
    }
    done = true;
    opts.onCommit(v, () => { done = false; });
  };
  el0.addEventListener('keydown', (e) => {
    const enter = e.key === 'Enter' && (opts.multiline ? (e.ctrlKey || e.metaKey) : true);
    if (enter) { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  el0.addEventListener('blur', () => commit(true));
}

function renameCat(nameEl, cat) {
  const inp = document.createElement('input');
  inp.className = 'bm-input';
  inp.value = cat.name;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  inlineCommit(inp, {
    onCancel: () => render(),
    onCommit: (v, unlock) => {
      if (v === cat.name) { render(); return; }
      const oldName = cat.name;
      catOp({ action: 'cat_update', id: cat.id, name: v }).then((res) => {
        if (res) {
          recordUndo({
            type: 'custom', label: '改分类名',
            undo: async () => { await blockOp({ action: 'cat_update', id: cat.id, name: oldName }); },
          });
        } else {
          unlock();                        // 失败：输入保留可重试
          inp.focus();
        }
      });
    },
  });
}

function startNewCat() {
  const inp = document.createElement('input');
  inp.className = 'bm-input';
  inp.placeholder = '新分类名…（Enter 建 · Esc 弃）';
  headEl.insertBefore(inp, headEl.children[1] || null);
  inp.focus();
  inlineCommit(inp, {
    onCancel: () => inp.remove(),
    onCommit: (v, unlock) => {
      catOp({ action: 'cat_create', name: v }).then((res) => {
        if (res && res.category) {
          inp.remove();
          const cid = res.category.id;
          recordUndo({
            type: 'custom', label: '新分类',
            undo: async () => { await blockOp({ action: 'cat_delete', id: cid }); },
          });
        } else {
          unlock();                        // 失败：保留输入（分类名还在，可重试）
          inp.focus();
        }
      });
    },
  });
}

// 行内编辑：文本换 textarea；Ctrl+Enter / 点外保存 · Esc 取消；保存失败留字可重试
function editRow(row, b, txtEl) {
  if (row.querySelector('.bm-edit-area')) return;
  const ta = document.createElement('textarea');
  ta.className = 'bm-edit-area';
  ta.value = String(b.text);
  ta.rows = 3;
  txtEl.replaceWith(ta);
  ta.focus();
  inlineCommit(ta, {
    multiline: true,
    onCancel: () => render(),
    onCommit: (v, unlock) => {
      if (v === String(b.text)) { render(); return; }
      const oldText = String(b.text);
      blockOp({ action: 'update', id: b.id, text: v })
        .then(() => {
          recordUndo({
            type: 'custom', label: '改块',
            undo: async () => { await blockOp({ action: 'update', id: b.id, text: oldText }); },
          });
        })
        .catch((err) => {
          unlock();                        // 失败：草稿不删、文本不丢，可重试
          ta.focus();
          toast('保存失败：' + err.message + '（内容还在，可重试）', 'err');
        });
    },
  });
}

// 新块草稿行：保存后才入库（空=弃；失败留字可重试）
function startDraftBlock(sec, cat) {
  if (sec.querySelector('.bm-draft')) { sec.querySelector('.bm-draft textarea').focus(); return; }
  const row = el('div', 'bm-row bm-draft');
  const ta = document.createElement('textarea');
  ta.className = 'bm-edit-area';
  ta.placeholder = '新块内容…（Ctrl+Enter 存 · Esc 弃）';
  ta.rows = 3;
  row.appendChild(ta);
  const rowsWrap = sec.querySelector('.bm-rows');
  rowsWrap.appendChild(row);
  ta.focus();
  inlineCommit(ta, {
    multiline: true,
    onCancel: () => { row.remove(); render(); },
    onCommit: (v, unlock) => {
      blockOp({ action: 'create', text: v, category_id: cat ? cat.id : null })
        .then((res) => {
          row.remove();
          if (res && res.block) {
            const bid = res.block.id;
            recordUndo({
              type: 'custom', label: '添加块',
              undo: async () => { await blockOp({ action: 'delete', id: bid }); },
            });
          }
        })
        .catch((err) => {
          unlock();                        // 失败：草稿行与文本保留，可重试
          ta.focus();
          toast('创建失败：' + err.message + '（内容还在，可重试）', 'err');
        });
    },
  });
}

// ── 拖放指示（M3.5）：换类 + 行间定位；moveBlockTo / siblingList 收敛在 blocks.js（热盒条共用） ──
function clearDropMarks() {
  if (markedEl) {
    markedEl.classList.remove('drop-above', 'drop-below', 'drop-end');
    markedEl = null;
  }
}

function setDropMark(el0, cls) {
  clearDropMarks();
  markedEl = el0;
  el0.classList.add(cls);
}

async function moveBtn(b, dir) {
  try {
    const res = await blockOp({ action: 'move', id: b.id, dir });
    if (res && res.moved === false) {          // 到头：良性边界，不再是错误
      toast(dir === -1 ? '已经在最上面了' : '已经在最下面了');
      return;
    }
    const oldPos = b.position || 0;
    const oldCid = b.category_id;
    recordUndo({
      type: 'custom', label: dir === -1 ? '块上移' : '块下移',
      undo: async () => { await blockOp({ action: 'update', id: b.id, category_id: oldCid, position: oldPos }); },
    });
  } catch (err) {
    toast(err.message, 'err');
  }
}

function catMoveBtn(cat, dir) {
  catOp({ action: 'cat_move', id: cat.id, dir }).then((res) => {
    if (!res) return;
    if (res.moved === false) {
      toast(dir === -1 ? '已经在最上面了' : '已经在最下面了');
      return;
    }
    recordUndo({
      type: 'custom', label: dir === -1 ? '分类上移' : '分类下移',
      undo: async () => { await blockOp({ action: 'cat_move', id: cat.id, dir: -dir }); },
    });
  });
}
