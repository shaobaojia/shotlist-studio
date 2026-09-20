// 块库（M3）：积木块数据缓存 / 热盒（块库条：搜索·分类筛选·chips·套件暂存）。
// 关键口径「插入即固化」：插入的是文字副本，之后改库不影响已写入的提示词。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { openMenu } from './menu.js';
import { recordUndo } from './edit.js';

let cache = null;              // { categories:[], blocks:[] }
const listeners = [];
let shelfDragId = null;        // 热盒条拖拽中的块 id（块↔块换位）

export async function ensureBlocks(force) {
  if (cache && !force) return cache;
  const res = await api.blocks();
  cache = { categories: res.categories || [], blocks: res.blocks || [] };
  return cache;
}

export function blocksData() { return cache; }

export function catName(catId) {
  if (catId == null) return '未分类';
  const c = (cache ? cache.categories : []).find((x) => x.id === catId);
  return c ? c.name : '未分类';
}

// ── 块移动（管理器 / 热盒条共用）：换类 + 定位 → 后端 position 支持 ──
export function siblingList(catId) {
  const d = blocksData() || { blocks: [] };
  const list = d.blocks.filter((b) => (catId == null ? b.category_id == null : b.category_id === catId));
  list.sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id);
  return list;
}

export async function moveBlockTo(target, catId, idx) {
  const d = blocksData() || { blocks: [] };
  const b = d.blocks.find((x) => x.id === target.id);
  if (!b) return;
  const oldCid = b.category_id;
  const oldPos = b.position || 0;
  if (oldCid === catId && oldPos === idx) return;
  try {
    await blockOp({ action: 'update', id: b.id, category_id: catId, position: idx });
    toast('已移到「' + (catId == null ? '未分类' : catName(catId)) + '」（Ctrl+Z 可撤）');
    recordUndo({
      type: 'custom', label: '块移动',
      undo: async () => { await blockOp({ action: 'update', id: b.id, category_id: oldCid, position: oldPos }); },
    });
  } catch (err) {
    toast('移动失败：' + err.message, 'err');
  }
}

// 数据变化订阅；返回退订函数
export function onBlocksChange(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export async function blockOp(payload) {
  const res = await api.blockOp(payload);
  await ensureBlocks(true);
  for (const fn of listeners.slice()) { try { fn(); } catch (e) { /* ignore */ } }
  return res;
}

// 展示序：置顶最前 → 分类序 → 块序
function sortedBlocks() {
  const cats = cache ? cache.categories : [];
  const order = {};
  cats.forEach((c, i) => { order[c.id] = i; });
  const arr = (cache ? cache.blocks : []).slice();
  arr.sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb2 = b.pinned ? 1 : 0;
    if (pa !== pb2) return pb2 - pa;
    const oa = a.category_id == null ? 9999 : order[a.category_id];
    const ob = b.category_id == null ? 9999 : order[b.category_id];
    if (oa !== ob) return oa - ob;
    return (a.position || 0) - (b.position || 0) || a.id - b.id;
  });
  return arr;
}

function chipLabel(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > 18 ? t.slice(0, 18) + '…' : (t || '（空）');
}

function findBlock(id) {
  return (cache ? cache.blocks : []).find((b) => b.id === id) || null;
}

// ── 热盒（块库条）：host 里渲染 [搜索 | 分类筛选 | 管理] + [套件条] + [块 chips] ──
// opts: { onInsert(text, block) —— 由拼装台做占位符代入与光标插入;
//         openManager(focusBlockId?) }
export function buildShelf(host, opts) {
  opts = opts || {};
  let filter = 'all';         // 'all' | 'pin' | 'none' | <category id>
  let query = '';
  const staged = [];          // 套件暂存（块 id 列表）

  const bar = el('div', 'shelf-bar');
  const search = document.createElement('input');
  search.className = 'shelf-search';
  search.placeholder = '搜块…';
  search.addEventListener('mousedown', (e) => e.stopPropagation());
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); drawChips(); });
  const catsWrap = el('span', 'shelf-cats');
  const mng = el('button', 'tool-btn small', '管理块库');
  mng.title = '整理积木块与分类（增 / 改 / 删 / 序 / 置顶）';
  mng.addEventListener('mousedown', (e) => e.preventDefault());
  mng.addEventListener('click', () => { if (opts.openManager) opts.openManager(); });
  bar.appendChild(search);
  bar.appendChild(catsWrap);
  bar.appendChild(mng);

  const stageWrap = el('div', 'shelf-stage');
  stageWrap.hidden = true;
  const chipsWrap = el('div', 'shelf-chips');
  host.appendChild(bar);
  host.appendChild(stageWrap);
  host.appendChild(chipsWrap);

  function drawCats() {
    catsWrap.textContent = '';
    const mk = (key, label, cur) => {
      const c = el('span', 'sc' + (cur ? ' on' : ''), label);
      c.addEventListener('mousedown', (e) => e.preventDefault());
      c.addEventListener('click', () => { filter = key; drawCats(); drawChips(); });
      if (key !== 'all' && key !== 'pin') {          // 分类芯片：块的拖放目标
        c.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          c.classList.add('drop-hover');
        });
        c.addEventListener('dragleave', () => c.classList.remove('drop-hover'));
        c.addEventListener('drop', (ev) => {
          ev.preventDefault();
          c.classList.remove('drop-hover');
          const raw = ev.dataTransfer.getData('text/plain') || '';
          if (raw.indexOf('blk:') !== 0) return;
          const blk = findBlock(Number(raw.slice(4)));
          if (!blk) return;
          const cid = key === 'none' ? null : key;
          if (blk.category_id === cid) return;
          moveBlockTo(blk, cid, siblingList(cid).filter((x) => x.id !== blk.id).length);   // 落到分类末尾
        });
      }
      return c;
    };
    catsWrap.appendChild(mk('all', '全部', filter === 'all'));
    catsWrap.appendChild(mk('pin', '★ 置顶', filter === 'pin'));
    for (const c of (cache ? cache.categories : [])) {
      catsWrap.appendChild(mk(c.id, c.name, filter === c.id));
    }
    if (cache && cache.blocks.some((b) => b.category_id == null)) {
      catsWrap.appendChild(mk('none', '未分类', filter === 'none'));
    }
  }

  function drawChips() {
    chipsWrap.textContent = '';
    if (!cache) {
      chipsWrap.appendChild(el('span', 'shelf-empty', '块库加载中…'));
      return;
    }
    let list = sortedBlocks();
    if (filter === 'pin') list = list.filter((b) => b.pinned);
    else if (filter === 'none') list = list.filter((b) => b.category_id == null);
    else if (filter !== 'all') list = list.filter((b) => b.category_id === filter);
    if (query) list = list.filter((b) => (String(b.text) + ' ' + catName(b.category_id)).toLowerCase().indexOf(query) !== -1);
    if (!list.length) {
      chipsWrap.appendChild(el('span', 'shelf-empty',
        cache.blocks.length ? '没有匹配的块' : '块库为空 —— 点「管理块库」添加常用的积木块'));
      return;
    }
    for (const b of list) chipsWrap.appendChild(blockChip(b));
  }

  function blockChip(b) {
    const c = el('span', 'block-chip'
      + (b.pinned ? ' pinned' : '')
      + (staged.indexOf(b.id) !== -1 ? ' staged' : ''));
    c.appendChild(el('span', 'bc-label', chipLabel(b.text)));
    c.title = catName(b.category_id) + '\n' + String(b.text).slice(0, 240)
      + (String(b.text).length > 240 ? '…' : '')
      + '\n\n点击插入 · Shift+点击 攒套件 · 右键更多 · 拖到别的块上换位 · 拖到上方分类芯片换类';
    // 拖拽源：不用 mousedown preventDefault（它会掐断原生拖拽）；tabindex 让按下时焦点落在 chip 自己身上，
    // 拼装台「失焦且新焦点在 .hotbox 内 → 不收起」的守卫因此天然放行（光标保护由拼装台守卫兜底）
    c.draggable = true;
    c.tabIndex = -1;

    c.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', 'blk:' + b.id);
      ev.dataTransfer.effectAllowed = 'move';
      c.classList.add('dragging');
      shelfDragId = b.id;
    });
    c.addEventListener('dragend', () => {
      c.classList.remove('dragging');
      shelfDragId = null;
      c.classList.remove('drop-before', 'drop-after');
      document.querySelectorAll('.sc.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
      document.querySelectorAll('.block-chip.drop-before, .block-chip.drop-after')
        .forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      backToEditor();                       // 拖完把焦点还给编辑面（Esc 随手可用）
    });
    // 块↔块：拖到另一个块上 → 插到它前/后（同分类=换位；跨分类=连类一起搬）
    c.addEventListener('dragover', (ev) => {
      if (shelfDragId == null || shelfDragId === b.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const r = c.getBoundingClientRect();
      const before = ev.clientX < r.left + r.width / 2;
      c.classList.toggle('drop-before', before);
      c.classList.toggle('drop-after', !before);
    });
    c.addEventListener('dragleave', () => c.classList.remove('drop-before', 'drop-after'));
    c.addEventListener('drop', (ev) => {
      if (shelfDragId == null || shelfDragId === b.id) return;
      ev.preventDefault();
      const r = c.getBoundingClientRect();
      const before = ev.clientX < r.left + r.width / 2;
      c.classList.remove('drop-before', 'drop-after');
      const src = findBlock(shelfDragId);
      if (!src) return;
      const cid = b.category_id;
      const list = siblingList(cid).filter((x) => x.id !== src.id);
      let idx = list.findIndex((x) => x.id === b.id);
      if (idx === -1) idx = list.length;
      else if (!before) idx += 1;
      moveBlockTo(src, cid, idx);
    });
    c.addEventListener('click', (ev) => {
      if (ev.shiftKey) {
        const i = staged.indexOf(b.id);
        if (i === -1) staged.push(b.id); else staged.splice(i, 1);
        drawStage();
        drawChips();
        backToEditor();                     // 重绘后把焦点还给编辑面
        return;
      }
      if (opts.onInsert) opts.onInsert(String(b.text), b);
    });
    c.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      chipMenu(c, b);
    });
    return c;
  }

  function drawStage() {
    stageWrap.textContent = '';
    stageWrap.hidden = !staged.length;
    if (!staged.length) return;
    stageWrap.appendChild(el('span', 'stage-label', '套件（' + staged.length + '）：'));
    stageWrap.appendChild(el('span', 'stage-list',
      staged.map((id) => { const b = findBlock(id); return b ? chipLabel(b.text) : ''; }).filter(Boolean).join(' · ')));
    const b1 = el('button', 'tool-btn small', '插入全部');
    b1.title = '按攒入顺序，一次都插到光标处';
    b1.addEventListener('mousedown', (e) => e.preventDefault());
    b1.addEventListener('click', () => {
      const texts = staged.map((id) => { const b = findBlock(id); return b ? String(b.text) : ''; }).filter(Boolean);
      staged.length = 0;
      drawStage();
      drawChips();
      if (texts.length && opts.onInsert) opts.onInsert(texts.join('\n\n'), null);
    });
    const b2 = el('button', 'tool-btn small', '清空');
    b2.addEventListener('mousedown', (e) => e.preventDefault());
    b2.addEventListener('click', () => { staged.length = 0; drawStage(); drawChips(); });
    stageWrap.appendChild(b1);
    stageWrap.appendChild(b2);
  }

  function chipMenu(anchor, b) {
    const items = [
      { key: 'pin', label: b.pinned ? '取消置顶' : '置顶' },
      { key: 'stage', label: '攒入套件' },
      { sep: true },
      { key: 'edit', label: '编辑…' },
      { key: 'move', label: '换分类…' },
      { sep: true },
      { key: 'del', label: '删除块' },
    ];
    openMenu(anchor, items, (k) => {
      if (k === 'pin') doPin(b, !b.pinned);
      else if (k === 'stage') {
        if (staged.indexOf(b.id) === -1) { staged.push(b.id); drawStage(); drawChips(); }
      } else if (k === 'edit') {
        if (opts.openManager) opts.openManager(b.id);
      } else if (k === 'move') {
        moveMenu(anchor, b);
      } else if (k === 'del') {
        delBlock(b);
      }
    });
  }

  function moveMenu(anchor, b) {
    const items = (cache ? cache.categories : []).map((c) => (
      { key: String(c.id), label: c.name, current: b.category_id === c.id }));
    items.push({ sep: true }, { key: 'none', label: '（未分类）', current: b.category_id == null });
    openMenu(anchor, items, async (k) => {
      try {
        await blockOp({ action: 'update', id: b.id, category_id: k === 'none' ? null : Number(k) });
        toast('已移到「' + catName(k === 'none' ? null : Number(k)) + '」');
      } catch (err) {
        toast('移动失败：' + err.message, 'err');
      }
    });
  }

  async function doPin(b, pinned) {
    try {
      await blockOp({ action: 'pin', id: b.id, pinned });
    } catch (err) {
      toast('操作失败：' + err.message, 'err');
    }
    drawChips();
  }

  async function delBlock(b) {
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
      const i = staged.indexOf(b.id);
      if (i !== -1) staged.splice(i, 1);
      drawChips();
      drawStage();
    } catch (err) {
      toast('删除失败：' + err.message, 'err');
    }
  }

  const off = onBlocksChange(() => { drawCats(); drawChips(); });
  ensureBlocks()
    .then(() => { drawCats(); drawChips(); })
    .catch((err) => {
      chipsWrap.textContent = '';
      chipsWrap.appendChild(el('span', 'shelf-empty', '块库加载失败：' + err.message));
    });
  drawCats();

  return { off: off };
}

// 「存为块」：把一段文字存进块库（选分类）
export async function storeAsBlock(anchor, text) {
  try {
    await ensureBlocks();
  } catch (err) {
    toast('块库加载失败：' + err.message, 'err');
    return;
  }
  const items = (cache.categories || []).map((c) => ({ key: String(c.id), label: c.name }));
  items.push({ sep: true }, { key: 'none', label: '（未分类）' });
  openMenu(anchor, items, async (k) => {
    try {
      const res = await blockOp({ action: 'create', text: text, category_id: k === 'none' ? null : Number(k) });
      toast('已添加到提示词块' + (k === 'none' ? '' : '（' + catName(Number(k)) + '）') + '· Ctrl+Z 可撤');
      if (res && res.block) {
        const bid = res.block.id;
        recordUndo({
          type: 'custom', label: '添加块',
          undo: async () => { await blockOp({ action: 'delete', id: bid }); },
        });
      }
    } catch (err) {
      toast('存块失败：' + err.message, 'err');
    }
  });
}

// 把焦点还给拼装台编辑面（无则不动；不滚动视口）
function backToEditor() {
  const ta = document.querySelector('.hotbox-editor');
  if (!ta || ta.offsetParent === null) return;
  try { ta.focus({ preventScroll: true }); } catch (err) { ta.focus(); }
}
