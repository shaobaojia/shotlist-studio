// 单元格选区（M2-4）：框选（拖拽）/ Shift 点选 / 键盘走格（方向键·Tab·Enter）
// + 批量操作（设值 / 清空 / 复制 TSV）。选区限定在单张表内；点击即编不受影响（拖出格才算框选）。
// 设计对齐：设计稿 §4「Tab / 方向键走格；多选（Shift / 框选）→ 表底选区条批量改」。
import { api } from './api.js';
import { toast, isFloatTarget, isTypingTarget } from './ui.js';
import { recordUndo, notifyRowsChanged, editorHandleAt } from './edit.js';
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
  view.addEventListener('mousedown', onSelDown);
  document.addEventListener('mousemove', onSelMove);
  document.addEventListener('mouseup', onSelUp);
  view.addEventListener('click', onSelClick, true);
  document.addEventListener('mousedown', onSelOutside, true);
  document.addEventListener('keydown', onSelKey);
  // B3 兜底：窗口失焦 / 触控取消也要收拖拽态（防 no-select 与 drag 永久滞留）
  window.addEventListener('blur', onSelBlur);
  document.addEventListener('pointercancel', onSelBlur, true);
}

// 原生选区清除单点（F2-W2）
function clearNativeSelection() {
  const s = window.getSelection && window.getSelection();
  if (s && s.removeAllRanges && s.rangeCount) s.removeAllRanges();
}

function onSelDown(e) {
  if (e.button !== 0) return;
  const t = e.target;
  if (t.closest && t.closest('.cell-editor, .cam-editor')) return;
  const td = t.closest ? t.closest('td[data-field]') : null;
  const tr = td && td.closest('tr.shot');
  if (!td || !tr) return;
  const table = tr.closest('table');
  if (!table) return;
  if (e.shiftKey) {
    // Shift 点选：拦掉浏览器原生文字选择（蓝斑），并清掉存量原生选区
    e.preventDefault();
    clearNativeSelection();
  }
  const shift = !!(e.shiftKey && sel && sel.table === table);
  if (!shift) clearSel();
  const rc = cellsOf(table);
  // 坐标系一次取齐（F2-P3/E1）：拖拽期间复用；视图重绘后在 move 里补取一次
  drag = { table: table, rc: rc, ar: rc.rows.indexOf(tr), ac: rc.cols.indexOf(td.dataset.field), shift: shift, moved: false };
}

function onSelMove(e) {
  if (!drag) return;
  if (e.buttons !== 1) { endDrag(); return; }          // F2-B3：窗口外/系统层松键不补发 mouseup → 按按钮态自愈
  const td = e.target && e.target.closest ? e.target.closest('td[data-field]') : null;
  const tr = td && td.closest('tr.shot');
  if (!td || !tr || tr.closest('table') !== drag.table) return;
  let fr = drag.rc.rows.indexOf(tr);
  let fc = drag.rc.cols.indexOf(td.dataset.field);
  if (fr === -1 || fc === -1) {
    drag.rc = cellsOf(drag.table);
    fr = drag.rc.rows.indexOf(tr);
    fc = drag.rc.cols.indexOf(td.dataset.field);
    if (fr === -1 || fc === -1) return;
  }
  if (!drag.moved) {
    if (fr === drag.ar && fc === drag.ac) return; // 还在本格：不算框选（点击即编不受影响）
    drag.moved = true;
    suppressClick = true;
    document.body.classList.add('no-select');
    clearNativeSelection();
  }
  if (!sel || sel.table !== drag.table) {
    sel = { table: drag.table, rows: drag.rc.rows, cols: drag.rc.cols, ar: drag.ar, ac: drag.ac, fr: fr, fc: fc };
  } else {
    sel.fr = fr; sel.fc = fc;
  }
  paintSoon();                                          // F2-E2：连发帧合并（每帧最多绘一次）
  emit();
}

// 拖拽状态收尾单点（F2-B3）：mouseup / 按钮态自愈 / 窗口失焦共用；幂等
function endDrag() {
  if (!drag) return null;
  const d = drag;
  drag = null;
  document.body.classList.remove('no-select');
  setTimeout(() => { suppressClick = false; }, 0);      // 兜底复位（正常路径由 click 消费，F2-W4）
  return d;
}

function onSelUp(e) {
  const d = endDrag();
  if (!d) return;
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
}

function onSelBlur() {
  endDrag();                                            // F2-B3 兜底
}

// 框选/扩选收尾那一下的 click 不算「点开编辑」；在消费点复位（F2-W4）
function onSelClick(e) {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}

// 点选区外（非单元格区域）→ 取消选区
function onSelOutside(e) {
  if (!sel) return;
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('td[data-field]') || t.closest('#sel-bar')
      || t.closest('.cell-editor, .cam-editor') || isFloatTarget(t)) return;
  clearSel();
}

// 键盘：方向键走格 / Shift 扩选 / Tab 右移 / Enter·F2 开编 / Esc 取消
// + Excel 对齐（M5 批2）：Delete 清格 / Home·End / Ctrl+C·X·A·D / 打字即编
function onSelKey(e) {
  if (!sel) return;
  const t = e.target;
  if (isTypingTarget(t)) return;
  if (document.querySelector('.cell-editor, .cam-editor')) return;
  if (menuOpen()) return;
  if (e.key === 'Escape') { clearSel(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    const k = String(e.key).toLowerCase();
    if (k === 'c') { e.preventDefault(); copySelection(); return; }
    if (k === 'x') { e.preventDefault(); cutSelection(); return; }
    if (k === 'a') { e.preventDefault(); selectAllCells(); return; }
    if (k === 'd') { e.preventDefault(); fillDown(); return; }
    // 其余 Ctrl 组合维持原行为（不拦截；Ctrl+V 交给 document 'paste' 直连）
  }
  const mv = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
  if (mv) { e.preventDefault(); moveFocus(mv[0], mv[1], e.shiftKey); return; }
  if (e.key === 'Tab') { e.preventDefault(); moveFocus(0, e.shiftKey ? -1 : 1, false); return; }
  if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); openFocus(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSelectionCells(); return; }
  if (e.key === 'Home') { e.preventDefault(); moveFocusAbs(sel.fr, 0, e.shiftKey); return; }
  if (e.key === 'End') { e.preventDefault(); moveFocusAbs(sel.fr, sel.cols.length - 1, e.shiftKey); return; }
  if (e.key === 'Process' || e.keyCode === 229) { tryTypeEdit(''); return; }   // IME 首键开编（编辑器未开时 IME 无落点，保留）
  if (!mod && !e.altKey && e.key && e.key.length === 1) {
    if (tryTypeEdit(e.key)) e.preventDefault();   // 打字即编（可编辑格才吞按键）
  }
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

// 画框 + 稳定帧复绘（M5 批1·N2）：点击同步窗口内首绘可能吃到重排前坐标
// （分组模式复现：框偏左 ~6.9px，平铺平态不复现），下一帧按定稿布局补绘一次统一归位。
let stabilizeQueued = false;
function queueStabilize() {
  if (stabilizeQueued) return;
  stabilizeQueued = true;
  requestAnimationFrame(() => {
    stabilizeQueued = false;
    if (sel) paint(false);
  });
}

// 连发帧合并（F2-E2）：拖拽期高频 move 每帧最多绘一次（范式同 ui.growTextarea）
let paintQueued = false;
function paintSoon() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paint(); });
}

function paint(stabilize) {
  if (sel) {
    const wrap = sel.table.closest('.table-wrap');
    const rc = wrap ? rectOf() : null;
    const tl = rc ? cellTd(rc.r1, rc.c1) : null;
    const br = rc ? cellTd(rc.r2, rc.c2) : null;
    if (wrap && tl && br) {
      if (!box) box = document.createElement('div');
      box.className = 'sel-box';
      if (box.parentNode !== wrap) wrap.appendChild(box);
      const wr = wrap.getBoundingClientRect();
      const a = tl.getBoundingClientRect();
      const b = br.getBoundingClientRect();
      // 边框半宽外扩（F2-W3）：口径取自 .sel-box 实测边框（原硬编码 -1/+1 是 2px 边框的隐式补偿）
      const bw = parseFloat(getComputedStyle(box).borderTopWidth) || 0;
      box.style.left = (a.left - wr.left + wrap.scrollLeft - bw / 2) + 'px';
      box.style.top = (a.top - wr.top - bw / 2) + 'px';
      box.style.width = (b.right - a.left + bw / 2) + 'px';
      box.style.height = (b.bottom - a.top + bw / 2) + 'px';
    }
  }
  if (stabilize !== false) queueStabilize();
}

function emit() {
  for (const f of subs) { try { f(sel); } catch (err) { console.warn('[sel] subscriber failed', err); } }
}

export function clearSel() {
  if (box) { box.remove(); box = null; }
  if (sel) { sel = null; emit(); }
}

// ── 选区遍历原语（F2-P2）──
// 空行跳过 / id 解析 / 行序单点；r1/r2 可收窄（默认整区）。

export function eachSelRow(cb, r1, r2) {
  if (!sel) return;
  const rc = rectOf();
  const a = Math.max(rc.r1, r1 == null ? rc.r1 : r1);
  const b = Math.min(rc.r2, r2 == null ? rc.r2 : r2);
  for (let r = a; r <= b; r++) {
    const tr = sel.rows[r];
    const s = tr ? shotById(Number(tr.dataset.id)) : null;
    if (!s) continue;
    cb(s, tr, r);
  }
}

export function eachSelCell(cb) {
  if (!sel) return;
  const rc = rectOf();
  eachSelRow((s, tr, r) => {
    for (let c = rc.c1; c <= rc.c2; c++) cb(s, sel.cols[c], r, c);
  });
}

export function selRowIds() {
  const ids = [];
  eachSelRow((s) => ids.push(s.id));
  return ids;
}

// 单格塌缩选区（F2-W18 粘贴直连路径）：把选区收缩到该格并重绘
export function selectCell(td) {
  const tr = td && td.closest ? td.closest('tr.shot') : null;
  const table = tr && tr.closest('table');
  if (!tr || !table) return false;
  const rc = cellsOf(table);
  const fr = rc.rows.indexOf(tr);
  const fc = rc.cols.indexOf(td.dataset.field);
  if (fr === -1 || fc === -1) return false;
  sel = { table: table, rows: rc.rows, cols: rc.cols, ar: fr, ac: fc, fr: fr, fc: fc };
  paint(); emit();
  return true;
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
  moveFocusAbs(sel.fr + dr, sel.fc + dc, extend);
}

function moveFocusAbs(r, c, extend) {
  if (!sel) return;
  const nr = Math.max(0, Math.min(sel.rows.length - 1, r));
  const nc = Math.max(0, Math.min(sel.cols.length - 1, c));
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

// 打字即编（M5 批2）：可编辑格 → 编辑句柄开编（首字替换态；F2-W11 去 DOM expando）。
// 死守卫退役（F2-P6）：提示词伪列无 data-field，进不了选区。
function tryTypeEdit(ch) {
  if (!sel) return false;
  const td = cellTd(sel.fr, sel.fc);
  if (!td || !td.classList.contains('editable')) return false;
  const h = editorHandleAt(td);
  if (!h) return false;
  sel.ar = sel.fr; sel.ac = sel.fc;
  paint();
  emit();
  h.openSeed(ch);
  return true;
}

function shotById(id) {
  return ctx && ctx.getShot ? ctx.getShot(id) : null;
}

export function copySelection() {
  if (!sel) return Promise.resolve(false);
  const rc = rectOf();
  const vals = [];
  eachSelRow((s) => {
    const row = [];
    for (let c = rc.c1; c <= rc.c2; c++) {
      const k = sel.cols[c];
      row.push(s[k] != null ? String(s[k]) : '');
    }
    vals.push(row);
  });
  return writeClipboard(toTSV(vals)).then((ok) => {
    toast(ok ? ('已复制 ' + vals.length + ' 行 × ' + (rc.c2 - rc.c1 + 1) + ' 列') : '复制失败：浏览器限制', ok ? '' : 'err');
    return ok;
  });
}

export function copySelectionTSV() { copySelection(); }

// 剪切（M5 批2）：复制成功才清格（防丢数据）；清空走既有批量写（一步撤销）
export async function cutSelection() {
  if (!sel) return;
  const ok = await copySelection();
  if (!ok) return;
  clearSelectionCells();
}

// 批量写（L7 泛化）：一个写口、一步撤销；默认 shots 域（ctx.getShot + refreshShotCell）。
// ops: [{id, field, value, table?, …}]（额外键透传给 write）；opts.write 注入写口（默认 api.batch，返回
// {results:[{id, field, changed, error, restore?}]}）；opts.domain {table, resolve, refresh, verb, noun, place}
// 换域与文案（W1）；opts.done / opts.fail 定制收尾（默认文案照旧）。
export async function batchWrite(ops, label, opts) {
  if (!ops.length) return 0;
  opts = opts || {};
  const dom = opts.domain || {};
  const table = dom.table || 'shots';
  const resolve = dom.resolve || ((o) => shotById(o.id));
  const refresh = dom.refresh || ((s, o) => refreshShotCell(s, o.field));
  const write = opts.write || ((items) => api.batch(items.map((o) => ({
    table: o.table || table, id: o.id, field: o.field, value: o.value }))));
  const vmap = {};
  for (const o of ops) vmap[o.id + '|' + o.field] = o.value;
  let ret;
  try {
    ret = (await write(ops)) || {};
  } catch (err) {
    (opts.fail || ((e) => toast('批量失败：' + e.message, 'err')))(err);
    return 0;
  }
  const results = ret.results || [];
  const errs = results.filter((r) => r.error);
  const back = [];
  const tmap = {};
  for (const o of ops) tmap[o.id + '|' + o.field] = o.table || table;   // 逐项写入表回读（P0·F2-B1）
  for (const r of results.filter((x) => x.changed)) {
    const s = resolve(r);
    if (!s) continue;
    back.push({ table: tmap[r.id + '|' + r.field] || table, id: r.id, field: r.field,
                value: (r.restore != null) ? r.restore : (s[r.field] == null ? '' : String(s[r.field])) });
    s[r.field] = vmap[r.id + '|' + r.field];
    refresh(s, r);
  }
  if (back.length) {
    recordUndo({
      type: 'custom', label: label || '批量',
      undo: async () => {
        const r2 = await api.batch(back.map((o) => ({ table: o.table, id: o.id, field: o.field, value: o.value })));
        const e2 = ((r2 || {}).results || []).filter((x) => x.error);
        if (e2.length) throw new Error(e2.length + ' 项被拒绝');   // W1：撤销失败不再被吞
        for (const o of back) {
          const s = resolve(o);
          if (s) { s[o.field] = o.value; refresh(s, o); }
        }
      },
    });
    const fs = {};
    for (const o of back) fs[o.field] = 1;
    for (const f in fs) notifyRowsChanged(table, f, null);
  }
  if (opts.done) {
    opts.done(back.length, errs, ret);
  } else {
    if (back.length) toast('已' + (dom.verb || '改') + (dom.place != null ? dom.place + ' ' : ' ') + back.length + ' ' + (dom.noun || '处') + '（Ctrl+Z 可撤）');
    else toast('没有变化');
    if (errs.length) toast(errs.length + ' 项被拒绝', 'err');
  }
  return back.length;
}

export function clearSelectionCells() {
  if (!sel) return;
  const ops = [];
  eachSelCell((s, k) => {
    const cur = s[k] == null ? '' : String(s[k]);
    if (cur !== '') ops.push({ id: s.id, field: k, value: '' });
  });
  if (!ops.length) { toast('选中的格子本来就是空的'); return; }
  if (ops.length > 400) { toast('一次最多 400 格（本次 ' + ops.length + '）', 'err'); return; }
  batchWrite(ops, '清空选区');
}

// Ctrl+A 全选本表（M5 批2）
function selectAllCells() {
  if (!sel) return;
  sel.ar = 0; sel.ac = 0;
  sel.fr = sel.rows.length - 1; sel.fc = sel.cols.length - 1;
  paint();
  emit();
}

// Ctrl+D 向下填充（M5 批2）：多行选区=首行铺满下方；单格=取上方值填入
function fillDown() {
  if (!sel) return;
  const rc = rectOf();
  let src = rc.r1;
  let from = rc.r1 + 1;
  if (rc.r1 === rc.r2) {
    if (rc.r1 === 0) { toast('上方没有可引用的行'); return; }
    src = rc.r1 - 1;
    from = rc.r1;
  }
  const str = sel.rows[src];
  const sSrc = str ? shotById(Number(str.dataset.id)) : null;
  if (!sSrc) return;
  const ops = [];
  eachSelRow((s) => {
    for (let c = rc.c1; c <= rc.c2; c++) {
      const k = sel.cols[c];   // 死守卫退役（F2-P6）：伪列无 data-field，进不了选区
      const nv = sSrc[k] == null ? '' : String(sSrc[k]);
      const cur = s[k] == null ? '' : String(s[k]);
      if (nv === cur) continue;
      ops.push({ id: s.id, field: k, value: nv });
    }
  }, from, rc.r2);
  if (!ops.length) { toast('没有需要填充的变化'); return; }
  if (ops.length > 400) { toast('一次最多 400 格（本次 ' + ops.length + '）', 'err'); return; }
  batchWrite(ops, '向下填充');
}

export function applyFieldValue(field, value, label) {
  if (!sel) return;
  const ops = [];
  const nv = value == null ? '' : String(value);
  eachSelRow((s) => {
    const cur = s[field] == null ? '' : String(s[field]);
    if (cur !== nv) ops.push({ id: s.id, field: field, value: nv });
  });
  if (!ops.length) { toast('选中的镜头本来就是这个值'); return; }
  if (ops.length > 400) { toast('一次最多 400 行', 'err'); return; }
  batchWrite(ops, label || '批量设值');
}

// 选区命中的节拍（M5 批2c）：所选行去重后的节拍 id（表序；平铺跨节拍时为多个）
export function selBeatIds() {
  const ids = [];
  eachSelRow((s) => {
    if (s.beat_id == null) return;
    if (ids.indexOf(s.beat_id) === -1) ids.push(s.beat_id);
  });
  return ids;
}

// 批量设值·节拍字段（M5 批2c）：套到所选行所在节拍；一步撤销；完成后合并重绘
export function applyBeatFieldValue(field, value, label) {
  const ids = selBeatIds();
  if (!ids.length) { toast('选中的镜头不在任何节拍内'); return; }
  const ops = [];
  for (const bid of ids) {
    const b = ctx && ctx.getBeat ? ctx.getBeat(bid) : null;
    if (!b) continue;
    const cur = b[field] == null ? '' : String(b[field]);
    const nv = value == null ? '' : String(value);
    if (cur === nv) continue;
    ops.push({ id: bid, field: field, value: nv });
  }
  if (!ops.length) { toast('选中的节拍本来就是这个值'); return; }
  batchWrite(ops, (label || '批量设值') + ' · 节拍', {
    domain: {
      table: 'beats',
      resolve: (o) => (ctx && ctx.getBeat ? ctx.getBeat(o.id) : null),
      refresh: () => { if (ctx && ctx.refreshScene) ctx.refreshScene(); },
      noun: '个节拍',
    },
  });
}

// 批量设值·场景字段（M5 批2c）：套到本场；一步撤销
export function applySceneFieldValue(field, value, label) {
  const sc = ctx && ctx.getScene ? ctx.getScene() : null;
  if (!sc) { toast('当前没有场'); return; }
  const cur = sc[field] == null ? '' : String(sc[field]);
  const nv = value == null ? '' : String(value);
  if (cur === nv) { toast('本场本来就是这个值'); return; }
  batchWrite([{ id: sc.id, field: field, value: nv }], (label || '批量设值') + ' · 场景', {
    domain: {
      table: 'scenes',
      resolve: () => (ctx && ctx.getScene ? ctx.getScene() : null),
      refresh: () => { if (ctx && ctx.refreshScene) ctx.refreshScene(); },
      place: '本场', noun: '处',
    },
  });
}
