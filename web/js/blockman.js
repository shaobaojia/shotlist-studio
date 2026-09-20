// 块库管理器（M3）：分类与积木块的组织面板（增 / 改 / 删 / 序 / 置顶 / 换分类）。
// 浮动面板挂 body（不随场次页重绘）；所有写操作走 blocks.js 的 blockOp（缓存与订阅统一在那里）。
import { el, toast } from './ui.js';
import { openMenu } from './menu.js';
import { recordUndo } from './edit.js';
import { ensureBlocks, blocksData, blockOp, onBlocksChange, moveBlockTo, siblingList } from './blocks.js';

let panel = null;
let bodyEl = null;
let headEl = null;
let pendingFocus = null;
let offChange = null;
let searchQ = '';
let dragging = null;

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
  qin.addEventListener('input', () => { searchQ = qin.value.trim().toLowerCase(); render(); });
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
    + '占位符插入时自动代入：{镜号} {景别} {焦段} {运镜} {机位} {时长} {台词} {场景}'));
  const cats = d.categories.slice().sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id);
  const hit = (b) => !searchQ || String(b.text).toLowerCase().indexOf(searchQ) !== -1;
  let total = 0;
  for (const c of cats) {
    const list = d.blocks.filter((b) => b.category_id === c.id && hit(b));
    total += list.length;
    if (searchQ && !list.length) continue;
    bodyEl.appendChild(catSection(c, list));
  }
  const uncat = d.blocks.filter((b) => b.category_id == null && hit(b));
  total += uncat.length;
  if (!searchQ || uncat.length) bodyEl.appendChild(catSection(null, uncat));
  if (searchQ && !total) bodyEl.appendChild(el('div', 'bm-note', '没有匹配的块'));

  if (pendingFocus) {
    const row = bodyEl.querySelector('.bm-row[data-id="' + pendingFocus + '"]');
    if (row) {
      row.scrollIntoView({ block: 'center' });
      const t = row.querySelector('.bm-text');
      if (t) t.click();
      pendingFocus = null;
    } else {
      pendingFocus = null;
    }
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
  addB.addEventListener('click', () => startDraftBlock(sec, cat, null));
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
  blocks.sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id);
  for (const b of blocks) rows.appendChild(blockRow(b, sec, cat));
  rows.addEventListener('dragover', (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    if (ev.target === rows || ev.target.classList.contains('bm-rows')) {
      clearDropMarks();
      rows.classList.add('drop-end');
    }
  });
  rows.addEventListener('drop', (ev) => {
    if (!dragging) return;
    if (ev.target !== rows && !ev.target.classList.contains('bm-rows')) return;
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
  });
  row.appendChild(grip);

  const star = el('span', 'bm-star' + (b.pinned ? ' on' : ''), b.pinned ? '★' : '☆');
  star.title = b.pinned ? '取消置顶' : '置顶（热盒里排最前）';
  star.addEventListener('click', () => pinToggle(b));
  row.appendChild(star);

  const txt = el('span', 'bm-text', String(b.text));
  txt.title = '点击编辑';
  txt.addEventListener('click', () => editRow(row, b, txt, sec, cat));
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
  mk('⇄', '换分类', () => moveMenuTo(ops, b));
  mk('✕', '删除块（可 Ctrl+Z）', () => deleteBlock(b));
  row.appendChild(ops);

  row.addEventListener('dragover', (ev) => {
    if (!dragging || dragging.id === b.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = row.getBoundingClientRect();
    clearDropMarks();
    row.classList.add(ev.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-above', 'drop-below');
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

function moveMenuTo(anchor, b) {
  const d = blocksData() || { categories: [] };
  const items = d.categories.map((c) => ({ key: String(c.id), label: c.name, current: b.category_id === c.id }));
  items.push({ sep: true }, { key: 'none', label: '（未分类）', current: b.category_id == null });
  openMenu(anchor, items, (k) => {
    const cid = k === 'none' ? null : Number(k);
    const oldCid = b.category_id;
    const oldPos = b.position || 0;
    blockOp({ action: 'update', id: b.id, category_id: cid })
      .then(() => {
        recordUndo({
          type: 'custom', label: '块换分类',
          undo: async () => { await blockOp({ action: 'update', id: b.id, category_id: oldCid, position: oldPos }); },
        });
      })
      .catch((err) => toast('移动失败：' + err.message, 'err'));
  });
}

async function deleteBlock(b) {
  try {
    await blockOp({ action: 'delete', id: b.id });
    toast('已删除块（可 Ctrl+Z）');
    recordUndo({
      type: 'custom', label: '删除块',
      undo: async () => {
        const res = await blockOp({ action: 'create', text: b.text, category_id: b.category_id });
        if (b.pinned && res.block) await blockOp({ action: 'pin', id: res.block.id, pinned: true });
      },
    });
  } catch (err) {
    toast('删除失败：' + err.message, 'err');
  }
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

function renameCat(nameEl, cat) {
  const inp = document.createElement('input');
  inp.className = 'bm-input';
  inp.value = cat.name;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const commit = (ok) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (ok && v && v !== cat.name) {
      const oldName = cat.name;
      catOp({ action: 'cat_update', id: cat.id, name: v }).then((res) => {
        if (res) recordUndo({
          type: 'custom', label: '改分类名',
          undo: async () => { await blockOp({ action: 'cat_update', id: cat.id, name: oldName }); },
        });
      });
    } else {
      render();
    }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

function startNewCat() {
  const inp = document.createElement('input');
  inp.className = 'bm-input';
  inp.placeholder = '新分类名…（Enter 建 · Esc 弃）';
  headEl.insertBefore(inp, headEl.children[1] || null);
  inp.focus();
  let done = false;
  const commit = (ok) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    inp.remove();
    if (ok && v) {
      catOp({ action: 'cat_create', name: v }).then((res) => {
        if (res && res.category) {
          const cid = res.category.id;
          recordUndo({
            type: 'custom', label: '新分类',
            undo: async () => { await blockOp({ action: 'cat_delete', id: cid }); },
          });
        }
      });
    }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

// 行内编辑：文本换 textarea；Ctrl+Enter / 点外保存 · Esc 取消
function editRow(row, b, txtEl, sec, cat) {
  if (row.querySelector('.bm-edit-area')) return;
  const ta = document.createElement('textarea');
  ta.className = 'bm-edit-area';
  ta.value = String(b.text);
  ta.rows = 3;
  txtEl.replaceWith(ta);
  ta.focus();
  let done = false;
  const commit = (ok) => {
    if (done) return;
    done = true;
    const v = ta.value.trim();
    if (ok && v && v !== String(b.text)) {
      const oldText = String(b.text);
      blockOp({ action: 'update', id: b.id, text: v })
        .then(() => {
          recordUndo({
            type: 'custom', label: '改块',
            undo: async () => { await blockOp({ action: 'update', id: b.id, text: oldText }); },
          });
        })
        .catch((err) => toast('保存失败：' + err.message, 'err'));
    } else {
      render();
    }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  ta.addEventListener('blur', () => commit(true));
}

// 新块草稿行：保存后才入库（空=弃）
function startDraftBlock(sec, cat, afterId) {
  if (sec.querySelector('.bm-draft')) { sec.querySelector('.bm-draft textarea').focus(); return; }
  const row = el('div', 'bm-row bm-draft');
  const ta = document.createElement('textarea');
  ta.className = 'bm-edit-area';
  ta.placeholder = '新块内容…（Ctrl+Enter 存 · 点外空内容=弃）';
  ta.rows = 3;
  row.appendChild(ta);
  const rowsWrap = sec.querySelector('.bm-rows');
  rowsWrap.appendChild(row);
  ta.focus();
  let done = false;
  const commit = (ok) => {
    if (done) return;
    done = true;
    const v = ta.value.trim();
    row.remove();
    if (ok && v) {
      blockOp({ action: 'create', text: v, category_id: cat ? cat.id : null })
        .then((res) => {
          if (res && res.block) {
            const bid = res.block.id;
            recordUndo({
              type: 'custom', label: '添加块',
              undo: async () => { await blockOp({ action: 'delete', id: bid }); },
            });
          }
        })
        .catch((err) => toast('创建失败：' + err.message, 'err'));
    } else {
      render();
    }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  ta.addEventListener('blur', () => commit(true));
}

// ── 块拖动（M3.5）：换类 + 行间定位；moveBlockTo / siblingList 收敛在 blocks.js（热盒条共用） ──
function clearDropMarks() {
  document.querySelectorAll('#block-manager .drop-above, #block-manager .drop-below, #block-manager .drop-end')
    .forEach((x) => x.classList.remove('drop-above', 'drop-below', 'drop-end'));
}

async function pinToggle(b) {
  try {
    await blockOp({ action: 'pin', id: b.id, pinned: !b.pinned });
    recordUndo({
      type: 'custom', label: b.pinned ? '取消置顶' : '置顶',
      undo: async () => { await blockOp({ action: 'pin', id: b.id, pinned: !!b.pinned }); },
    });
  } catch (err) {
    toast('失败：' + err.message, 'err');
  }
}

async function moveBtn(b, dir) {
  try {
    await blockOp({ action: 'move', id: b.id, dir });
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
    if (res) {
      recordUndo({
        type: 'custom', label: dir === -1 ? '分类上移' : '分类下移',
        undo: async () => { await blockOp({ action: 'cat_move', id: cat.id, dir: -dir }); },
      });
    }
  });
}
