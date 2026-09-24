// 块库卡·操作族 + 三处右键菜单（M5e）：「管理面板」退役后，一切整理动作收进卡片。
// 写操作一律走 blocks.js（blockOp / moveBlockTo / togglePin / deleteBlockWithUndo），撤销与提示统一在那里。
// 单向依赖（F3-W15②更新）：bc-list.js（列表渲染）从本模块引操作；本模块不依赖 bc-list。
import { el, toast } from './ui.js';
import { openMenu } from './menu.js';
import {
  blockOp, blockUndo, blockOpToast, catOf, findBlock, moveMenu, togglePin, deleteBlockWithUndo,
} from './blocks.js';
import { copyText } from './clipboard.js';

// ── 行内提交协议（与旧管理器同款）：Enter（单行）/ Ctrl+Enter（多行）提交 · Esc 取消 · 点外提交；
//    提交失败调 unlock() 保留输入可重试 ──
export function inlineCommit(el0, opts) {
  let done = false;
  opts = opts || {};
  const commit = (ok) => {
    if (done) return;
    if (!ok) { done = true; if (opts.onCancel) opts.onCancel(); return; }
    const v = el0.value.trim();
    if (!v) { done = true; if (opts.onCancel) opts.onCancel(); return; }   // 空＝取消（F3-W12：旗标全库从无他值，退役）
    done = true;
    opts.onCommit(v, () => { done = false; });
  };
  el0.addEventListener('keydown', (e) => {
    const enter = e.key === 'Enter' && (opts.multiline ? (e.ctrlKey || e.metaKey) : true);
    if (enter) { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  el0.addEventListener('blur', () => {
    if (!el0.isConnected) return;                  // 已脱离：直接不提交
    // 被动失焦（F3-B6）：实测 .remove() 触发 blur 时 isConnected 仍为 true（派发早于落地）——
    // 延迟一个 tick 复核连接性：真·点外（仍在树上）才提交；被重绘拆走则不写。
    setTimeout(() => { if (el0.isConnected) commit(true); }, 0);
  });
}

// 行内输入面单点（F3-W9②）：建面（input/textarea）→ 挂载（replace / prepend+wrap / append+wrap）→ 聚焦（可选选词）→ 接统一提交协议
export function openInline(opts) {
  const o = opts || {};
  const el0 = document.createElement(o.tag || 'input');
  if (o.cls) el0.className = o.cls;
  if (o.value != null) el0.value = o.value;
  if (o.placeholder) el0.placeholder = o.placeholder;
  if (o.rows) el0.rows = o.rows;
  let wrap = el0;
  if (o.wrapClass) { wrap = el('div', o.wrapClass); wrap.appendChild(el0); }
  const m = o.mount || {};
  if (m.kind === 'replace') m.target.replaceWith(el0);
  else if (m.kind === 'prepend') m.host.insertBefore(wrap, m.host.firstChild);
  else m.host.appendChild(wrap);
  el0.focus();
  if (o.select) el0.select();
  inlineCommit(el0, {
    multiline: o.multiline,
    onCancel: () => { if (o.onCancel) o.onCancel(el0, wrap); },
    onCommit: (v, unlock) => o.onCommit(v, unlock, el0, wrap),
  });
  return { el0: el0, wrap: wrap };
}

// 提交失败收尾单点（F3-W9④）：解锁 + 归还焦点 + 提示（内容还在可重试）
export function failRestore(err, unlock, el0, label) {
  unlock();
  try { el0.focus(); } catch (e) { /* ignore */ }
  toast(label + '失败：' + err.message + '（内容还在，可重试）', 'err');
}

// ── 分类操作 ──
export async function deleteCat(cat) {
  const res = await blockOpToast({ action: 'cat_delete', id: cat.id }, '删除分类');
  if (res) toast('分类已删（块落「未分类」）');
}

export async function catMove(cat, dir) {
  const res = await blockOpToast({ action: 'cat_move', id: cat.id, dir }, '分类调整');
  if (!res) return;
  if (res.moved === false) { toast(dir === -1 ? '已经在最上面了' : '已经在最下面了'); return; }
  blockUndo(dir === -1 ? '分类上移' : '分类下移', () => ({ action: 'cat_move', id: cat.id, dir: -dir }));
}

export function renameCatInline(ctx, nameEl, cat) {
  if (!nameEl || !cat) return;
  openInline({
    cls: 'bco-input', value: cat.name, select: true,
    mount: { kind: 'replace', target: nameEl },
    onCancel: () => ctx.refresh(),
    onCommit: (v, unlock, el0) => {
      if (v === cat.name) { ctx.refresh(); return; }
      const oldName = cat.name;
      blockOp({ action: 'cat_update', id: cat.id, name: v }).then(() => {
        blockUndo('改分类名', () => ({ action: 'cat_update', id: cat.id, name: oldName }));
      }).catch((err) => failRestore(err, unlock, el0, '改名'));
    },
  });
}

let newCatInput = null;   // 在开的新分类输入面（F3-W10：跟踪引用，不再查选择器）
export function newCatInline(listEl) {
  if (newCatInput && newCatInput.isConnected) { newCatInput.focus(); return; }
  const { el0 } = openInline({
    placeholder: '新分类名…（Enter 建 · Esc 弃）',
    wrapClass: 'bco-newcat', mount: { kind: 'prepend', host: listEl },
    onCancel: (el0b, wrap) => { newCatInput = null; wrap.remove(); },
    onCommit: (v, unlock, el0b, wrap) => {
      blockOp({ action: 'cat_create', name: v }).then((res) => {
        if (!res || !res.category) { failRestore({ message: '响应异常' }, unlock, el0b, '建分类'); return; }
        newCatInput = null;
        wrap.remove();
        const cid = res.category.id;
        blockUndo('新分类', () => ({ action: 'cat_delete', id: cid }));
      }).catch((err) => failRestore(err, unlock, el0b, '建分类'));
    },
  });
  newCatInput = el0;
}

// ── 块草稿行：保存后才入库（空＝弃；失败留字可重试）──
let draftArea = null;   // 在开的新块草稿面（F3-W10：跟踪引用，不再查选择器）
export function draftBlockInline(sec, cat) {
  const rows = sec.querySelector('.bco-rows');
  if (!rows) return;
  if (draftArea && draftArea.isConnected) { draftArea.focus(); return; }
  const { el0 } = openInline({
    tag: 'textarea', cls: 'bco-edit', placeholder: '新块内容…（Ctrl+Enter 存 · Esc 弃）', rows: 2,
    wrapClass: 'bco-row bco-draft', multiline: true, mount: { kind: 'append', host: rows },
    onCancel: (el0b, wrap) => { draftArea = null; wrap.remove(); },
    onCommit: (v, unlock, el0b, wrap) => {
      blockOp({ action: 'create', text: v, category_id: cat ? cat.id : null }).then((res) => {
        draftArea = null;
        wrap.remove();
        if (res && res.block) {
          const bid = res.block.id;
          blockUndo('添加块', () => ({ action: 'delete', id: bid }));
        }
      }).catch((err) => failRestore(err, unlock, el0b, '创建'));
    },
  });
  draftArea = el0;
}

// 入口：在目标分类里开草稿行（供段头右键 / 底栏「＋新建块」）——不切任何模式
export function newBlockInCat(ctx, cat) {
  if (ctx.revealSection) ctx.revealSection(cat ? cat.id : null);   // 展开+重绘（F3-W10 适配器）
  requestAnimationFrame(() => {
    const sec = ctx.sectionEl ? ctx.sectionEl(cat ? cat.id : null) : null;
    if (sec) { sec.scrollIntoView({ block: 'nearest' }); draftBlockInline(sec, cat); }
  });
}

export function newBlockUncat(ctx) { newBlockInCat(ctx, null); }

// 入口：就地打开某块的编辑器（供「编辑块…」）——不切任何模式
export function startEditBlock(ctx, id) {
  const b = findBlock(id);   // F3-W2：块查找单点
  if (b && ctx.revealSection) ctx.revealSection(b.category_id);   // 展开+重绘（F3-W10 适配器）
  if (ctx.editRow) ctx.editRow(id);                               // 滚达 + 进入编辑（滚动由 _startEdit 一处负责）
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
        copyText(String(b.text == null ? '' : b.text), '已复制块文本');
      }
      else if (k === 'pin') togglePin(b);
      else if (k === 'move') moveMenu(pt, b);
      else if (k === 'edit') startEditBlock(ctx, b.id);
      else if (k === 'del') deleteBlockWithUndo(b);
    });
  });
}

export function attachSecMenu(ctx, headEl, cid, nameEl) {
  const cat = catOf(cid);   // F3-W2：分类查找口径单点
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
      else if (k === 'ren') renameCatInline(ctx, nameEl, cat);
      else if (k === 'up') catMove(cat, -1);
      else if (k === 'dn') catMove(cat, 1);
      else if (k === 'del') deleteCat(cat);
    });
  });
}

export function attachBlankMenu(ctx, listEl) {
  listEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.bco-sec, .bco-foot, .bco-newcat, input, textarea')) return;   // F3-W13：占位判定收口（.bc-row 死类退役）
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
      else if (k === 'nc') newCatInline(listEl);
      else if (k === 'collapse') ctx.foldAll(false);
      else if (k === 'expand') ctx.foldAll(true);
    });
  });
}
