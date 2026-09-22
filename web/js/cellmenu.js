// 右键菜单（M2-3；M2-5 行副本；M2-6 结构操作）：镜头行（插入/删除/副本/清空）+ 节拍头（副本/删除）+ 选区变体。
// 挂在 #view 上（事件委托）；复制走 execCommand 兜底（局域 http 下无 clipboard API）。
import { api } from './api.js';
import { toast } from './ui.js';
import { openMenu, menuOpen } from './menu.js';
import { recordUndo } from './edit.js';
import { writeClipboard, pasteBlock, toTSV, tableFieldKeys } from './clipboard.js';
import { refreshShotCell, refreshBeatAction } from './table.js';
import { isAiField, aiMenu, aiMenuForBeat, targetsFromSel } from './aiwrite.js';
import { joinPrevGroup, canJoinPrev } from './hotbox.js';
import { current as selCurrent, inCell, copySelectionTSV, clearSelectionCells, tlCell, rectOf } from './selection.js';

let shotsOf = null;
let beatsOf = null;
let sceneIdOf = null;
let refreshView = null;

// ctx: { allShots() -> 当前场全部镜头模型, beats() -> 节拍, sceneId() -> 场 id }
export function bindCellMenu(view, ctx) {
  shotsOf = ctx.allShots;
  beatsOf = ctx.beats || null;
  sceneIdOf = ctx.sceneId || null;
  refreshView = ctx.refresh || null;
  if (view.dataset.menuBound === '1') return;
  view.dataset.menuBound = '1';
  view.addEventListener('contextmenu', (e) => {
    const td = e.target.closest ? e.target.closest('td[data-field]') : null;
    const tr = e.target.closest ? e.target.closest('tr.shot') : null;
    if (td && tr && td.dataset.field) {
      if (td.querySelector('.cell-editor, .cam-editor')) return; // 编辑中：保留原生菜单
      e.preventDefault();
      if (inCell(td)) openSelMenu(td, tr, e);
      else openCellMenu(td, tr, e);
      return;
    }
    const sec = e.target.closest ? e.target.closest('section.beat') : null;
    if (sec && sec.dataset.beatId) {
      e.preventDefault();
      openBeatMenu(sec, e);
    }
  });

  // 直接粘贴（M5 批2）：选区就位时 Ctrl+V 即贴（菜单待命锚点优先）；编辑态/浮层内不劫持。
  document.addEventListener('paste', (e) => {
    if (menuOpen()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('.cell-editor, .cam-editor')) return;
    const anchor = pasteAnchor || (selCurrent() ? tlCell() : null);
    if (!anchor) return;
    e.preventDefault();
    e.stopPropagation();
    if (pasteArmed) pasteArmed();
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    pasteBlock(anchor, text, pasteCtx);
  }, true);
}

function findShot(id) {
  const arr = shotsOf ? shotsOf() : [];
  return arr.find((x) => x.id === id) || null;
}

function openCellMenu(td, tr, e) {
  const s = findShot(Number(tr.dataset.id));
  if (!s) return;
  const key = td.dataset.field;
  const table = td.closest('table');
  const items = [
    { key: 'copyCell', label: '复制本格' },
    { key: 'copyRow', label: '复制整行（本表列）' },
    { key: 'paste', label: '粘贴（从此格起）' },
    { sep: true },
    { key: 'joinPrev', label: '并入上一组', disabled: !canJoinPrev(s.id) },
    { sep: true },
    { key: 'ai', label: isAiField(key) ? '✦ AI 改写…' : '✦ AI 改写…（本列不支持）', disabled: !isAiField(key) },
    { sep: true },
    { key: 'duplicate', label: '创建行副本' },
    { key: 'insertAbove', label: '上方插入空行' },
    { key: 'insertBelow', label: '下方插入空行' },
    { sep: true },
    { key: 'clear', label: '清空本格' },
    { key: 'deleteRow', label: '删除本行' },
  ];
  openMenu({ x: e.clientX, y: e.clientY }, items, (k) => onCellMenuPick(k, td, tr, s, key, table, e));
}

// 选区内的右键菜单（多一套选区动作）
function openSelMenu(td, tr, e) {
  if (!selCurrent()) { openCellMenu(td, tr, e); return; }
  const rc = rectOf();
  const n = (rc.r2 - rc.r1 + 1) * (rc.c2 - rc.c1 + 1);
  const mrows = rc.r2 - rc.r1 + 1;
  const aiT = targetsFromSel();   // 单点：选区→AI 目标（批4/D 尾，删内联双循环）
  const items = [
    { key: 'copySel', label: '复制选区（' + n + ' 格）' },
    { key: 'copyCell', label: '复制本格' },
    { key: 'copyRow', label: '复制整行（本表列）' },
    { key: 'paste', label: '粘贴（从选区左上起）' },
    { sep: true },
    { key: 'ai', label: aiT.length ? (aiT.length > 1 ? ('✦ AI 改写…（选中 ' + aiT.length + ' 格）') : '✦ AI 改写…') : '✦ AI 改写…（选区无可改字段）', disabled: !aiT.length },
    { sep: true },
    { key: 'duplicate', label: '创建行副本' },
    { key: 'insertAbove', label: '上方插入空行' },
    { key: 'insertBelow', label: '下方插入空行' },
    { sep: true },
    { key: 'clearSel', label: '清空选区' },
    { key: 'clear', label: '清空本格' },
    { key: 'deleteRows', label: '删除选中行（' + mrows + '）' },
  ];
  openMenu({ x: e.clientX, y: e.clientY }, items, (k) => {
    if (k === 'ai') { aiMenu({ x: e.clientX, y: e.clientY }, aiT); return; }
    if (k === 'copySel') { copySelectionTSV(); return; }
    if (k === 'clearSel') { clearSelectionCells(); return; }
    if (k === 'deleteRows') { deleteSelectedRows(); return; }
    if (k === 'insertAbove' || k === 'insertBelow') {
      insertBlank(findShot(Number(tr.dataset.id)), k === 'insertAbove' ? 'above' : 'below');
      return;
    }
    if (k === 'paste') {
      const tlc = tlCell();
      if (tlc) armPaste({ td: tlc.td, tr: tlc.tr, field: tlc.field });
      return;
    }
    onCellMenuPick(k, td, tr, findShot(Number(tr.dataset.id)), td.dataset.field, td.closest('table'), e);
  });
}

async function onCellMenuPick(k, td, tr, s, key, table, e) {
  if (k === 'ai') {
    aiMenu({ x: e.clientX, y: e.clientY }, [{ table: 'shots', id: s.id, field: key }]);
    return;
  }
  if (k === 'copyCell') {
    const ok = await writeClipboard(s[key] == null ? '' : String(s[key]));
    toast(ok ? '已复制本格' : '复制失败：浏览器限制', ok ? '' : 'err');
  } else if (k === 'copyRow') {
    const keys = tableFieldKeys(table);
    const ok = await writeClipboard(toTSV([keys.map((x) => (s[x] == null ? '' : String(s[x])))]));
    toast(ok ? '已复制整行' : '复制失败：浏览器限制', ok ? '' : 'err');
  } else if (k === 'duplicate') {
    await duplicateRow(s);
  } else if (k === 'insertAbove') {
    await insertBlank(s, 'above');
  } else if (k === 'insertBelow') {
    await insertBlank(s, 'below');
  } else if (k === 'deleteRow') {
    await removeRow(s);
  } else if (k === 'joinPrev') {
    await joinPrevGroup(s.id);
  } else if (k === 'paste') {
    armPaste({ td, tr, field: key });
  } else if (k === 'clear') {
    const old = s[key] == null ? '' : s[key];
    if (String(old) === '') { toast('本来就是空的'); return; }
    s[key] = '';
    refreshShotCell(s, key);
    try {
      await api.update('shots', s.id, key, '');
      recordUndo({ type: 'field', table: 'shots', id: s.id, field: key, restore: old, label: '清空' });
      toast('已清空');
    } catch (err) {
      s[key] = old;
      refreshShotCell(s, key);
      toast('清空失败：' + err.message, 'err');
    }
  }
}

// 创建行副本：服务端插入 → 刷新视图 → 新行闪烁定位；撤销 = 删除新行
async function duplicateRow(s) {
  if (!s) return;
  try {
    const res = await api.duplicate('shots', s.id);
    const ns = res.shot || {};
    toast('已创建副本' + (ns.shot_no ? '：' + ns.shot_no : ''));
    recordUndo({
      type: 'custom', label: '创建行副本',
      undo: async () => { await api.del({ table: 'shots', ids: [ns.id] }); },
    });
    if (refreshView) await refreshView();
    flashEl('tr.shot[data-id="' + ns.id + '"]');
  } catch (err) {
    toast('创建副本失败：' + err.message, 'err');
  }
}

// 粘贴待命（菜单发起）：登记锚点，等用户 Ctrl+V 时由直连监听取用；
// 直连路径（M5 批2）锚点未登记时取选区左上——选区就位直接 Ctrl+V 即贴。
let pasteArmed = null;    // disarm 回调
let pasteAnchor = null;   // 菜单登记的待命锚点

function armPaste(anchor) {
  if (pasteArmed) pasteArmed();
  pasteAnchor = anchor;
  toast('粘贴就绪：按 Ctrl+V（Esc 取消）');
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      disarm();
      toast('已取消粘贴');
    }
  };
  const tmr = setTimeout(() => { disarm(); }, 6000);
  function disarm() {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(tmr);
    pasteArmed = null;
    pasteAnchor = null;
  }
  pasteArmed = disarm;
  document.addEventListener('keydown', onKey, true);
}

const pasteCtx = {
  getShot: findShot,
  refreshCell: function (id, key) {
    const s = findShot(id);
    if (s) refreshShotCell(s, key);
  },
};

// ── M2-6 结构操作 ──

function flashEl(sel) {
  const n = document.querySelector(sel);
  if (!n) return;
  n.scrollIntoView({ block: 'nearest' });
  n.classList.add('flash');
  setTimeout(() => n.classList.remove('flash'), 1600);
}

// 上方/下方插入空行（编号规则在服务端：中插=前邻字母后缀；追尾=数字顺延）
async function insertBlank(s, dir) {
  if (!s) return;
  const sceneId = sceneIdOf ? sceneIdOf() : null;
  if (!sceneId) return;
  try {
    const idx = (Number(s.position) || 0) + (dir === 'below' ? 1 : 0);
    const res = await api.create({
      kind: 'shot', scene_id: sceneId,
      beat_id: s.beat_id == null ? null : s.beat_id, index: idx,
    });
    const ns = res.shot || {};
    toast('已插入空行' + (ns.shot_no ? '：' + ns.shot_no : ''));
    recordUndo({
      type: 'custom', label: '插入空行',
      undo: async () => { await api.del({ table: 'shots', ids: [ns.id] }); },
    });
    if (refreshView) await refreshView();
    flashEl('tr.shot[data-id="' + ns.id + '"]');
  } catch (err) {
    toast('插入失败：' + err.message, 'err');
  }
}

// 删除本行（即时删 + Ctrl+Z 完整还原）
async function removeRow(s) {
  if (!s) return;
  try {
    const res = await api.del({ table: 'shots', ids: [s.id] });
    const rows = (res.deleted && res.deleted.rows) || [];
    toast('已删除' + (s.shot_no ? ' ' + s.shot_no : '') + '（Ctrl+Z 可撤销）');
    recordUndo({
      type: 'custom', label: '删除行',
      undo: async () => { await api.restore({ kind: 'shots', rows: rows }); },
    });
    if (refreshView) await refreshView();
  } catch (err) {
    toast('删除失败：' + err.message, 'err');
  }
}

// 删除选中行（N 行一次删；撤销=整组回插）
export async function deleteSelectedRows() {
  const s = selCurrent();
  const rc = rectOf();
  if (!s || !rc) return;
  const ids = [];
  for (let r = rc.r1; r <= rc.r2; r++) {
    const tr = s.rows[r];
    if (tr) ids.push(Number(tr.dataset.id));
  }
  if (!ids.length) return;
  try {
    const res = await api.del({ table: 'shots', ids: ids });
    const rows = (res.deleted && res.deleted.rows) || [];
    toast('已删除 ' + rows.length + ' 行（Ctrl+Z 可撤销）');
    recordUndo({
      type: 'custom', label: '删除行',
      undo: async () => { await api.restore({ kind: 'shots', rows: rows }); },
    });
    if (refreshView) await refreshView();
  } catch (err) {
    toast('删除失败：' + err.message, 'err');
  }
}

// 节拍头右键：副本（连镜头深拷）/ 删除（镜头落未归节拍）
function openBeatMenu(sec, e) {
  const bid = Number(sec.dataset.beatId);
  const b = beatsOf ? beatsOf().find((x) => x.id === bid) : null;
  if (!b) return;
  const n = (b.shots || []).length;
  const items = [
    { key: 'dupBeat', label: '创建节拍副本（含 ' + n + ' 镜）' },
    { sep: true },
    { key: 'ai', label: '✦ AI 改写…（节拍概述）' },
    { sep: true },
    { key: 'delBeat', label: '删除节拍' },
  ];
  openMenu({ x: e.clientX, y: e.clientY }, items, (k) => onBeatMenuPick(k, b, e));
}

async function onBeatMenuPick(k, b, e) {
  if (k === 'ai') { aiMenuForBeat({ x: e.clientX, y: e.clientY }, b, () => refreshBeatAction(b)); return; }
  try {
    if (k === 'dupBeat') {
      const res = await api.duplicate('beats', b.id);
      const nb = res.beat || {};
      toast('已创建节拍副本：beat ' + (nb.beat_no || ''));
      recordUndo({
        type: 'custom', label: '创建节拍副本',
        undo: async () => { await api.del({ table: 'beats', id: nb.id, with_shots: true }); },
      });
      if (refreshView) await refreshView();
      flashEl('section.beat[data-beat-id="' + nb.id + '"]');
    } else if (k === 'delBeat') {
      const res = await api.del({ table: 'beats', id: b.id });
      const d = res.deleted || {};
      toast('已删除节拍（其下镜头落「未归节拍」，Ctrl+Z 可撤销）');
      recordUndo({
        type: 'custom', label: '删除节拍',
        undo: async () => { await api.restore({ kind: 'beat', beat: d.beat, shot_ids: d.shot_ids || [] }); },
      });
      if (refreshView) await refreshView();
    }
  } catch (err) {
    toast('操作失败：' + err.message, 'err');
  }
}
