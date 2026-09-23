// 块库卡·操作族 + 三处右键菜单（M5e）：「管理面板」退役后，一切整理动作收进卡片。
// 写操作一律走 blocks.js（blockOp / moveBlockTo / togglePin / deleteBlockWithUndo），撤销与提示统一在那里。
// 单向依赖：bc-org.js（整理态渲染）从本模块引操作；本模块不依赖 bc-org。
import { el, toast } from './ui.js';
import { recordUndo } from './edit.js';
import { openMenu } from './menu.js';
import {
  blocksData, blockOp, moveMenu, togglePin, deleteBlockWithUndo,
} from './blocks.js';
import { writeClipboard } from './clipboard.js';

// ── 行内提交协议（与旧管理器同款）：Enter（单行）/ Ctrl+Enter（多行）提交 · Esc 取消 · 点外提交；
//    提交失败调 unlock() 保留输入可重试 ──
export function inlineCommit(el0, opts) {
  let done = false;
  opts = opts || {};
  const commit = (ok) => {
    if (done) return;
    if (!ok) { done = true; if (opts.onCancel) opts.onCancel(); return; }
    const v = el0.value.trim();
    if (!v && opts.emptyAsCancel !== false) { done = true; if (opts.onCancel) opts.onCancel(); return; }
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

// ── 分类操作 ──
export function deleteCat(ctx, cat) {
  blockOp({ action: 'cat_delete', id: cat.id })
    .then((res) => { if (res) toast('分类已删（块落「未分类」）'); })
    .catch((err) => toast(err.message, 'err'));
}

export function catMove(ctx, cat, dir) {
  blockOp({ action: 'cat_move', id: cat.id, dir }).then((res) => {
    if (!res) return;
    if (res.moved === false) { toast(dir === -1 ? '已经在最上面了' : '已经在最下面了'); return; }
    recordUndo({ type: 'custom', label: dir === -1 ? '分类上移' : '分类下移',
      undo: async () => { await blockOp({ action: 'cat_move', id: cat.id, dir: -dir }); } });
  }).catch((err) => toast(err.message, 'err'));
}

export function renameCatInline(ctx, nameEl, cat) {
  if (!nameEl || !cat) return;
  const inp = document.createElement('input');
  inp.className = 'bco-input';
  inp.value = cat.name;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  inlineCommit(inp, {
    onCancel: () => ctx.refresh(),
    onCommit: (v, unlock) => {
      if (v === cat.name) { ctx.refresh(); return; }
      const oldName = cat.name;
      blockOp({ action: 'cat_update', id: cat.id, name: v }).then((res) => {
        if (res) {
          recordUndo({ type: 'custom', label: '改分类名',
            undo: async () => { await blockOp({ action: 'cat_update', id: cat.id, name: oldName }); } });
        } else { unlock(); inp.focus(); }
      }).catch((err) => { unlock(); inp.focus(); toast('改名失败：' + err.message + '（可重试）', 'err'); });
    },
  });
}

export function newCatInline(ctx, listEl) {
  const ex = listEl.querySelector('.bco-newcat input');
  if (ex) { ex.focus(); return; }
  const wrap = el('div', 'bco-newcat');
  const inp = document.createElement('input');
  inp.placeholder = '新分类名…（Enter 建 · Esc 弃）';
  wrap.appendChild(inp);
  listEl.insertBefore(wrap, listEl.firstChild);
  inp.focus();
  inlineCommit(inp, {
    onCancel: () => wrap.remove(),
    onCommit: (v, unlock) => {
      blockOp({ action: 'cat_create', name: v }).then((res) => {
        if (res && res.category) {
          wrap.remove();
          const cid = res.category.id;
          recordUndo({ type: 'custom', label: '新分类',
            undo: async () => { await blockOp({ action: 'cat_delete', id: cid }); } });
        } else { unlock(); inp.focus(); }
      }).catch((err) => { unlock(); inp.focus(); toast('建分类失败：' + err.message + '（可重试）', 'err'); });
    },
  });
}

// ── 块草稿行：保存后才入库（空＝弃；失败留字可重试）──
export function draftBlockInline(ctx, sec, cat) {
  const rows = sec.querySelector('.bco-rows');
  if (!rows) return;
  const ex = rows.querySelector('.bco-draft textarea');
  if (ex) { ex.focus(); return; }
  const row = el('div', 'bco-row bco-draft');
  const ta = document.createElement('textarea');
  ta.className = 'bco-edit';
  ta.placeholder = '新块内容…（Ctrl+Enter 存 · Esc 弃）';
  ta.rows = 2;
  row.appendChild(ta);
  rows.appendChild(row);
  ta.focus();
  inlineCommit(ta, {
    multiline: true,
    onCancel: () => { row.remove(); },
    onCommit: (v, unlock) => {
      blockOp({ action: 'create', text: v, category_id: cat ? cat.id : null }).then((res) => {
        row.remove();
        if (res && res.block) {
          const bid = res.block.id;
          recordUndo({ type: 'custom', label: '添加块',
            undo: async () => { await blockOp({ action: 'delete', id: bid }); } });
        }
      }).catch((err) => { unlock(); ta.focus(); toast('创建失败：' + err.message + '（内容还在）', 'err'); });
    },
  });
}

// 入口：在目标分类里开草稿行（供段头右键 / 底栏「＋新建块」）——不切任何模式
export function newBlockInCat(ctx, cat) {
  const key = cat ? 'c' + cat.id : 'none';
  if (ctx.folded.has(key)) { ctx.folded.delete(key); ctx.foldSave(); ctx.refresh(); }
  requestAnimationFrame(() => {
    const sec = ctx.list.querySelector('.bco-sec[data-catkey="' + (cat ? cat.id : 'none') + '"]');
    if (sec) { sec.scrollIntoView({ block: 'nearest' }); draftBlockInline(ctx, sec, cat); }
  });
}

export function newBlockUncat(ctx) { newBlockInCat(ctx, null); }

// 入口：就地打开某块的编辑器（供「编辑块…」）——不切任何模式
export function startEditBlock(ctx, id) {
  const d = blocksData();
  const b = d && d.blocks ? d.blocks.find((x) => x.id === id) : null;
  if (b) {
    const key = b.category_id == null ? 'none' : 'c' + b.category_id;
    if (ctx.folded.has(key)) { ctx.folded.delete(key); ctx.foldSave(); ctx.refresh(); }
  }
  requestAnimationFrame(() => {
    const row = ctx.list.querySelector('.bco-row[data-id="' + id + '"]');
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    if (row._startEdit) row._startEdit();
  });
}

// ── 三处右键菜单 ──
export function attachRowMenu(ctx, rowEl, b) {
  rowEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pt = { x: e.clientX, y: e.clientY };
    openMenu(pt, [
      { key: 'ins', label: '插入到光标' },
      { key: 'copy', label: '复制文本' },
      { sep: true },
      { key: 'pin', label: b.pinned ? '取消置顶' : '置顶' },
      { key: 'move', label: '移动到分类…' },
      { sep: true },
      { key: 'edit', label: '编辑块…' },
      { key: 'del', label: '删除块' },
    ], (k) => {
      if (k === 'ins') ctx.insert(String(b.text == null ? '' : b.text), b);
      else if (k === 'copy') {
        writeClipboard(String(b.text == null ? '' : b.text)).then((ok) => toast(ok ? '已复制块文本' : '复制失败：浏览器限制'));
      }
      else if (k === 'pin') togglePin(b);
      else if (k === 'move') moveMenu(pt, b);
      else if (k === 'edit') startEditBlock(ctx, b.id);
      else if (k === 'del') deleteBlockWithUndo(b);
    });
  });
}

export function attachSecMenu(ctx, headEl, cid) {
  const cat = cid == null ? null : (((blocksData() || { categories: [] }).categories.find((c) => c.id === cid)) || null);
  headEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pt = { x: e.clientX, y: e.clientY };
    const items = [{ key: 'add', label: '＋ 在本类加块' }];
    if (cat) {
      items.push({ sep: true },
        { key: 'ren', label: '重命名分类…' },
        { key: 'up', label: '上移分类' },
        { key: 'dn', label: '下移分类' },
        { sep: true },
        { key: 'del', label: '删除分类' });
    }
    openMenu(pt, items, (k) => {
      if (k === 'add') newBlockInCat(ctx, cat);
      else if (k === 'ren') renameCatInline(ctx, headEl.querySelector('.bc-secname'), cat);
      else if (k === 'up') catMove(ctx, cat, -1);
      else if (k === 'dn') catMove(ctx, cat, 1);
      else if (k === 'del') deleteCat(ctx, cat);
    });
  });
}

export function attachBlankMenu(ctx, listEl) {
  listEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.bc-row, .bco-row, .bc-sechead, .bco-newcat, input, textarea')) return;
    e.preventDefault();
    const pt = { x: e.clientX, y: e.clientY };
    openMenu(pt, [
      { key: 'nb', label: '＋ 新建块…' },
      { key: 'nc', label: '＋ 新分类…' },
      { sep: true },
      { key: 'collapse', label: '全部收起' },
      { key: 'expand', label: '全部展开' },
    ], (k) => {
      if (k === 'nb') newBlockUncat(ctx);
      else if (k === 'nc') newCatInline(ctx, listEl);
      else if (k === 'collapse') ctx.foldAll(false);
      else if (k === 'expand') ctx.foldAll(true);
    });
  });
}
