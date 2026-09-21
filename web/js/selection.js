// 单元格选区（M2-4）：框选（拖拽）/ Shift 点选 / 键盘走格（方向键·Tab·Enter）
// + 批量操作（设值 / 清空 / 复制 TSV）。选区限定在单张表内；点击即编不受影响（拖出格才算框选）。
// 设计对齐：设计稿 §4「Tab / 方向键走格；多选（Shift / 框选）→ 表底选区条批量改」。
import { api } from './api.js';
import { toast } from './ui.js';
import { recordUndo } from './edit.js';
import { writeClipboard, toTSV } from './clipboard.js';
import { refreshShotCell, visibleRows } from './table.js';
import { menuOpen } from './menu.js';

let ctx = null;
const subs = [];
let sel = null;          // { table, rows:[tr], cols:[key], ar,ac(锚点), fr,fc(焦点) }
let drag = null;         // 按下待定：{ table, ar, ac, shift, moved }
let box = null;          // 覆盖层
let suppressClick = false;

export function onChange(cb) { subs.push(cb); }
export function current() { return sel; }

export function bindSelection(view, c) {
  ctx = c;
  if (view.dataset.selBound === '1') return;
  view.dataset.selBound = '1';

  view.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t.closest && t.closest('.cell-editor, .cam-editor')) return;
    const td = t.closest ? t.closest('td[data-field]') : null;
    const tr = td && td.closest('tr.shot');
    if (!td || !tr) return;
    const table = tr.closest('table');
    if (!table) return;
    const shift = !!(e.shiftKey && sel && sel.table === table);
    if (!shift) clearSel();
    const rc = cellsOf(table);
    drag = { table: table, ar: rc.rows.indexOf(tr), ac: rc.cols.indexOf(td.dataset.field), shift: shift, moved: false };
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const td = e.target && e.target.closest ? e.target.closest('td[data-field]') : null;
    const tr = td && td.closest('tr.shot');
    if (!td || !tr || tr.closest('table') !== drag.table) return;
    const rc = cellsOf(drag.table);
    const fr = rc.rows.indexOf(tr);
    const fc = rc.cols.indexOf(td.dataset.field);
    if (fr === -1 || fc === -1) return;
    if (!drag.moved) {
      if (fr === drag.ar && fc === drag.ac) return; // 还在本格：不算框选（点击即编不受影响）
      drag.moved = true;
      suppressClick = true;
      document.body.classList.add('no-select');
      const s = window.getSelection && window.getSelection();
      if (s && s.removeAllRanges) s.removeAllRanges();
    }
    if (!sel || sel.table !== drag.table) {
      sel = { table: drag.table, rows: rc.rows, cols: rc.cols, ar: drag.ar, ac: drag.ac, fr: fr, fc: fc };
    } else {
      sel.fr = fr; sel.fc = fc;
    }
    paint();
    emit();
  });

  document.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.body.classList.remove('no-select');
    if (!d.moved) {
      const td = e.target && e.target.closest ? e.target.closest('td[data-field]') : null;
      const tr = td && td.closest('tr.shot');
      if (td && tr && tr.closest('table') === d.table) {
        const rc = cellsOf(d.table);
        const fr = rc.rows.indexOf(tr);
        const fc = rc.cols.indexOf(td.dataset.field);
        if (fr !== -1 && fc !== -1) {
          if (d.shift && sel && sel.table === d.table) {
            sel.fr = fr; sel.fc = fc;   // Shift 点选：扩到该格（原行为）
          } else {
            sel = { table: d.table, rows: rc.rows, cols: rc.cols, ar: fr, ac: fc, fr: fr, fc: fc };  // 单击 = 选格（塌缩为单格选区）
          }
          paint(); emit();
        }
      }
      if (d.shift) suppressClick = true;
    }
    setTimeout(() => { suppressClick = false; }, 0);
  });

  // 框选/扩选收尾那一下的 click 不算「点开编辑」
  view.addEventListener('click', (e) => {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // 点选区外（非单元格区域）→ 取消选区
  document.addEventListener('mousedown', (e) => {
    if (!sel) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('td[data-field]') || t.closest('#sel-bar') || t.closest('.menu') || t.closest('.cell-editor, .cam-editor')
        || t.closest('.ai-diff') || t.closest('.ai-cmd')) return;
    clearSel();
  }, true);

  // 键盘：方向键走格 / Shift 扩选 / Tab 右移 / Enter 开编 / Esc 取消
  document.addEventListener('keydown', (e) => {
    if (!sel) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('.cell-editor, .cam-editor')) return;
    if (menuOpen()) return;
    if (e.key === 'Escape') { clearSel(); return; }
    const mv = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (mv) { e.preventDefault(); moveFocus(mv[0], mv[1], e.shiftKey); return; }
    if (e.key === 'Tab') { e.preventDefault(); moveFocus(0, e.shiftKey ? -1 : 1, false); return; }
    if (e.key === 'Enter') { e.preventDefault(); openFocus(); }
  });
}

function cellsOf(table) {
  const rows = visibleRows(table);
  let cols = [];
  if (rows[0]) cols = Array.from(rows[0].querySelectorAll('td[data-field]')).map((td) => td.dataset.field);
  return { rows: rows, cols: cols };
}

export function rectOf() {
  if (!sel) return null;
  return {
    r1: Math.min(sel.ar, sel.fr), r2: Math.max(sel.ar, sel.fr),
    c1: Math.min(sel.ac, sel.fc), c2: Math.max(sel.ac, sel.fc),
  };
}

function cellTd(r, c) {
  const tr = sel && sel.rows[r];
  if (!tr) return null;
  return tr.querySelector('td[data-field="' + sel.cols[c] + '"]');
}

export function tlCell() {
  const rc = rectOf();
  if (!rc) return null;
  const td = cellTd(rc.r1, rc.c1);
  return td ? { td: td, tr: td.closest('tr.shot'), field: td.dataset.field } : null;
}

function paint() {
  if (!sel) return;
  const wrap = sel.table.closest('.table-wrap');
  if (!wrap) return;
  const rc = rectOf();
  const tl = cellTd(rc.r1, rc.c1);
  const br = cellTd(rc.r2, rc.c2);
  if (!tl || !br) return;
  if (!box) box = document.createElement('div');
  box.className = 'sel-box';
  if (box.parentNode !== wrap) wrap.appendChild(box);
  const wr = wrap.getBoundingClientRect();
  const a = tl.getBoundingClientRect();
  const b = br.getBoundingClientRect();
  box.style.left = (a.left - wr.left + wrap.scrollLeft - 1) + 'px';
  box.style.top = (a.top - wr.top - 1) + 'px';
  box.style.width = (b.right - a.left + 1) + 'px';
  box.style.height = (b.bottom - a.top + 1) + 'px';
}

function emit() {
  for (const f of subs) { try { f(sel); } catch (err) { /* ignore */ } }
}

export function clearSel() {
  if (box) { box.remove(); box = null; }
  if (sel) { sel = null; emit(); }
}

export function inCell(td) {
  if (!sel || !td) return false;
  if (td.closest('table') !== sel.table) return false;
  const tr = td.closest('tr.shot');
  const r = sel.rows.indexOf(tr);
  const c = sel.cols.indexOf(td.dataset.field);
  if (r === -1 || c === -1) return false;
  const rc = rectOf();
  return r >= rc.r1 && r <= rc.r2 && c >= rc.c1 && c <= rc.c2;
}

function moveFocus(dr, dc, extend) {
  if (!sel) return;
  const nr = Math.max(0, Math.min(sel.rows.length - 1, sel.fr + dr));
  const nc = Math.max(0, Math.min(sel.cols.length - 1, sel.fc + dc));
  if (nr === sel.fr && nc === sel.fc) return;
  if (!extend) { sel.ar = nr; sel.ac = nc; }
  sel.fr = nr; sel.fc = nc;
  paint();
  emit();
  const td = cellTd(nr, nc);
  if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function openFocus() {
  const td = cellTd(sel.fr, sel.fc);
  if (!td) return;
  sel.ar = sel.fr; sel.ac = sel.fc;
  paint();
  emit();
  td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

function shotById(id) {
  return ctx && ctx.getShot ? ctx.getShot(id) : null;
}

export function copySelectionTSV() {
  if (!sel) return;
  const rc = rectOf();
  const vals = [];
  for (let r = rc.r1; r <= rc.r2; r++) {
    const s = shotById(Number(sel.rows[r].dataset.id));
    const row = [];
    for (let c = rc.c1; c <= rc.c2; c++) {
      const k = sel.cols[c];
      row.push(s && s[k] != null ? String(s[k]) : '');
    }
    vals.push(row);
  }
  writeClipboard(toTSV(vals)).then((ok) => {
    toast(ok ? ('已复制 ' + vals.length + ' 行 × ' + (rc.c2 - rc.c1 + 1) + ' 列') : '复制失败：浏览器限制', ok ? '' : 'err');
  });
}

// 批量写（一个请求、一次提交）：ops: [{id, field, value}]；含模型更新 + 撤销栈 + 单格重画
export async function batchWrite(ops, label) {
  if (!ops.length) return 0;
  const vmap = {};
  for (const o of ops) vmap[o.id + '|' + o.field] = o.value;
  let res;
  try {
    res = await api.batch(ops.map((o) => ({ table: 'shots', id: o.id, field: o.field, value: o.value })));
  } catch (err) {
    toast('批量失败：' + err.message, 'err');
    return 0;
  }
  const results = res.results || [];
  const errs = results.filter((r) => r.error);
  const changed = results.filter((r) => r.changed);
  const back = [];
  for (const r of changed) {
    const s = shotById(r.id);
    if (!s) continue;
    back.push({ id: r.id, field: r.field, value: s[r.field] == null ? '' : String(s[r.field]) });
    s[r.field] = vmap[r.id + '|' + r.field];
    refreshShotCell(s, r.field);
  }
  if (changed.length) {
    recordUndo({
      type: 'custom', label: label || '批量',
      undo: async () => {
        await api.batch(back.map((o) => ({ table: 'shots', id: o.id, field: o.field, value: o.value })));
        for (const o of back) {
          const s = shotById(o.id);
          if (s) { s[o.field] = o.value; refreshShotCell(s, o.field); }
        }
      },
    });
    toast('已改 ' + changed.length + ' 处（Ctrl+Z 可撤）');
  } else {
    toast('没有变化');
  }
  if (errs.length) toast(errs.length + ' 项被拒绝', 'err');
  return changed.length;
}

export function clearSelectionCells() {
  if (!sel) return;
  const rc = rectOf();
  const ops = [];
  for (let r = rc.r1; r <= rc.r2; r++) {
    const s = shotById(Number(sel.rows[r].dataset.id));
    if (!s) continue;
    for (let c = rc.c1; c <= rc.c2; c++) {
      const k = sel.cols[c];
      const cur = s[k] == null ? '' : String(s[k]);
      if (cur !== '') ops.push({ id: s.id, field: k, value: '' });
    }
  }
  if (!ops.length) { toast('选中的格子本来就是空的'); return; }
  if (ops.length > 400) { toast('一次最多 400 格（本次 ' + ops.length + '）', 'err'); return; }
  batchWrite(ops, '清空选区');
}

export function applyFieldValue(field, value, label) {
  if (!sel) return;
  const rc = rectOf();
  const ops = [];
  for (let r = rc.r1; r <= rc.r2; r++) {
    const tr = sel.rows[r];
    const s = tr ? shotById(Number(tr.dataset.id)) : null;
    if (!s) continue;
    const cur = s[field] == null ? '' : String(s[field]);
    const nv = value == null ? '' : String(value);
    if (cur === nv) continue;
    ops.push({ id: s.id, field: field, value: nv });
  }
  if (!ops.length) { toast('选中的镜头本来就是这个值'); return; }
  if (ops.length > 400) { toast('一次最多 400 行', 'err'); return; }
  batchWrite(ops, label || '批量设值');
}
