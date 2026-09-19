// 右键菜单（M2-3）：复制本格 / 复制整行 / 粘贴（Excel 式块粘贴）/ 清空本格。
// 挂在 #view 上（事件委托）；复制走 execCommand 兜底（局域 http 下无 clipboard API）。
import { api } from './api.js';
import { toast } from './ui.js';
import { openMenu } from './menu.js';
import { recordUndo } from './edit.js';
import { writeClipboard, pasteBlock, toTSV, tableFieldKeys } from './clipboard.js';
import { refreshShotCell } from './table.js';
import { current as selCurrent, inCell, copySelectionTSV, clearSelectionCells, tlCell, rectOf } from './selection.js';

let shotsOf = null;

// ctx: { allShots() -> 当前场全部镜头模型 }
export function bindCellMenu(view, ctx) {
  shotsOf = ctx.allShots;
  if (view.dataset.menuBound === '1') return;
  view.dataset.menuBound = '1';
  view.addEventListener('contextmenu', (e) => {
    const td = e.target.closest ? e.target.closest('td[data-field]') : null;
    const tr = e.target.closest ? e.target.closest('tr.shot') : null;
    if (!td || !tr || !td.dataset.field) return;
    if (td.querySelector('.cell-editor, .cam-editor')) return; // 编辑中：保留原生菜单
    e.preventDefault();
    if (inCell(td)) openSelMenu(td, tr, e);
    else openCellMenu(td, tr, e);
  });
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
    { key: 'clear', label: '清空本格' },
  ];
  openMenu({ x: e.clientX, y: e.clientY }, items, (k) => onCellMenuPick(k, td, tr, s, key, table));
}

// 选区内的右键菜单（多一套选区动作）
function openSelMenu(td, tr, e) {
  if (!selCurrent()) { openCellMenu(td, tr, e); return; }
  const rc = rectOf();
  const n = (rc.r2 - rc.r1 + 1) * (rc.c2 - rc.c1 + 1);
  const items = [
    { key: 'copySel', label: '复制选区（' + n + ' 格）' },
    { key: 'copyCell', label: '复制本格' },
    { key: 'copyRow', label: '复制整行（本表列）' },
    { key: 'paste', label: '粘贴（从选区左上起）' },
    { sep: true },
    { key: 'clearSel', label: '清空选区' },
    { key: 'clear', label: '清空本格' },
  ];
  openMenu({ x: e.clientX, y: e.clientY }, items, (k) => {
    if (k === 'copySel') { copySelectionTSV(); return; }
    if (k === 'clearSel') { clearSelectionCells(); return; }
    if (k === 'paste') {
      const tlc = tlCell();
      if (tlc) armPaste({ td: tlc.td, tr: tlc.tr, field: tlc.field });
      return;
    }
    onCellMenuPick(k, td, tr, findShot(Number(tr.dataset.id)), td.dataset.field, td.closest('table'));
  });
}

async function onCellMenuPick(k, td, tr, s, key, table) {
  if (k === 'copyCell') {
    const ok = await writeClipboard(s[key] == null ? '' : String(s[key]));
    toast(ok ? '已复制本格' : '复制失败：浏览器限制', ok ? '' : 'err');
  } else if (k === 'copyRow') {
    const keys = tableFieldKeys(table);
    const ok = await writeClipboard(toTSV([keys.map((x) => (s[x] == null ? '' : String(s[x])))]));
    toast(ok ? '已复制整行' : '复制失败：浏览器限制', ok ? '' : 'err');
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

// 粘贴待命：菜单点了「粘贴」后，等用户 Ctrl+V（局域 http 下无法程序化读取剪贴板）
let pasteArmed = null;

function armPaste(anchor) {
  if (pasteArmed) pasteArmed();
  toast('粘贴就绪：按 Ctrl+V（Esc 取消）');
  const onPaste = (e) => {
    e.preventDefault();
    e.stopPropagation();
    disarm();
    const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    pasteBlock(anchor, t, pasteCtx);
  };
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
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(tmr);
    pasteArmed = null;
  }
  pasteArmed = disarm;
  document.addEventListener('paste', onPaste, true);
  document.addEventListener('keydown', onKey, true);
}

const pasteCtx = {
  getShot: findShot,
  refreshCell: function (id, key) {
    const s = findShot(id);
    if (s) refreshShotCell(s, key);
  },
};
