// 块库管理器（M3）：分类与积木块的组织面板（增 / 改 / 删 / 序 / 置顶 / 换分类）。
// 浮动面板挂 body（不随场次页重绘）；所有写操作走 blocks.js 的 blockOp（缓存与订阅统一在那里）。
import { el, toast } from './ui.js';
import { openMenu } from './menu.js';
import { recordUndo } from './edit.js';
import { ensureBlocks, blocksData, blockOp, onBlocksChange } from './blocks.js';

let panel = null;
let bodyEl = null;
let headEl = null;
let pendingFocus = null;
let offChange = null;

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
  for (const c of cats) {
    bodyEl.appendChild(catSection(c, d.blocks.filter((b) => b.category_id === c.id)));
  }
  const uncat = d.blocks.filter((b) => b.category_id == null);
  bodyEl.appendChild(catSection(null, uncat));

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
    up.addEventListener('click', () => catOp({ action: 'cat_move', id: cat.id, dir: -1 }));
    const dn = el('button', 'tool-btn small', '↓');
    dn.title = '分类下移';
    dn.addEventListener('click', () => catOp({ action: 'cat_move', id: cat.id, dir: 1 }));
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
  sec.appendChild(rows);
  return sec;
}

function blockRow(b, sec, cat) {
  const row = el('div', 'bm-row');
  row.dataset.id = b.id;
  const star = el('span', 'bm-star' + (b.pinned ? ' on' : ''), b.pinned ? '★' : '☆');
  star.title = b.pinned ? '取消置顶' : '置顶（热盒里排最前）';
  star.addEventListener('click', () => blockOp({ action: 'pin', id: b.id, pinned: !b.pinned }).catch((err) => toast('失败：' + err.message, 'err')));
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
  mk('↑', '上移', () => blockOp({ action: 'move', id: b.id, dir: -1 }).catch((err) => toast(err.message, 'err')));
  mk('↓', '下移', () => blockOp({ action: 'move', id: b.id, dir: 1 }).catch((err) => toast(err.message, 'err')));
  mk('⇄', '换分类', () => moveMenuTo(ops, b));
  mk('✕', '删除块（可 Ctrl+Z）', () => deleteBlock(b));
  row.appendChild(ops);
  return row;
}

function moveMenuTo(anchor, b) {
  const d = blocksData() || { categories: [] };
  const items = d.categories.map((c) => ({ key: String(c.id), label: c.name, current: b.category_id === c.id }));
  items.push({ sep: true }, { key: 'none', label: '（未分类）', current: b.category_id == null });
  openMenu(anchor, items, (k) => {
    blockOp({ action: 'update', id: b.id, category_id: k === 'none' ? null : Number(k) })
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
    await blockOp(payload);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function deleteCat(cat) {
  catOp({ action: 'cat_delete', id: cat.id }).then(() => toast('分类已删（块落「未分类」）'));
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
      catOp({ action: 'cat_update', id: cat.id, name: v });
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
    if (ok && v) catOp({ action: 'cat_create', name: v });
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
      blockOp({ action: 'update', id: b.id, text: v }).catch((err) => toast('保存失败：' + err.message, 'err'));
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
