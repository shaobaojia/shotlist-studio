// 表格模块：列构建 / 单元格渲染 / 就地编辑绑定 / 节拍区 / 详情区。
// 显示规格 = cells.js（老库移植）；编辑引擎 = edit.js；页面组装在 scene.js。
import { state } from './state.js';
import { el, fmt, toast } from './ui.js';
import { cellContent } from './cells.js';
import { attachEditable, attachCamEditor, parseCam, recordUndo } from './edit.js';
import { api } from './api.js';
import { buildPromptBox, toggleComposer } from './hotbox.js';

const MULTILINE_TYPES = new Set(['spatial', 'dialogue', 'audio', 'notes', 'camera']);
const MULTILINE_KEYS = new Set(['blocking']);

function isMultiline(f) {
  return MULTILINE_TYPES.has(f.type) || MULTILINE_KEYS.has(f.key);
}

const tableCols = new WeakMap();   // table 元素 → 列定义（列宽跨表同步用）

function allShotTables() {
  return Array.from(document.querySelectorAll('table.shots'));
}

function applyColWidth(key, w) {
  for (const t of allShotTables()) {
    const cols = tableCols.get(t);
    const cg = t.querySelector('colgroup');
    if (!cols || !cg) continue;
    const idx = cols.findIndex((c) => c.key === key);
    if (idx === -1 || !cg.children[idx]) continue;
    cg.children[idx].style.width = w + 'px';
    let sum = 0;
    for (const cc of cg.children) sum += parseFloat(cc.style.width) || 0;
    t.style.minWidth = sum + 'px';
  }
}

function startColResize(e, f, opts) {
  const prefs = opts.prefs || {};
  if (!prefs.widths) prefs.widths = {};
  const startX = e.clientX;
  const startW = prefs.widths[f.key] || f.w;
  let last = startW;
  document.body.classList.add('col-resizing');
  const onMove = (ev) => {
    last = Math.max(36, Math.min(620, startW + ev.clientX - startX));
    applyColWidth(f.key, last);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.body.classList.remove('col-resizing');
    prefs.widths[f.key] = Math.round(last);
    if (opts.savePrefs) opts.savePrefs();
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

function tableColumns(beatCol, prefs) {
  const fields = state.meta.shot_fields.filter((f) => f.in_table && !(prefs.hidden && prefs.hidden[f.key]));
  const cols = [{ key: '__toggle', label: '', type: 'toggle', w: 26 }].concat(fields);
  if (beatCol) {
    const i = cols.findIndex((c) => c.key === 'shot_no');
    cols.splice(i + 1, 0, { key: '__beat', label: '节拍', type: 'beat', w: 110 });
  }
  return cols;
}

export function buildTable(shots, opts) {
  const data = opts.data;
  const cols = tableColumns(!!opts.beatCol, opts.prefs);
  const groups = {};
  for (const g of data.prompt_groups) groups[g.id] = g;

  const wrap = el('div', 'table-wrap');
  const t = el('table', 'shots');
  const cg = document.createElement('colgroup');
  let sum = 0;
  const widths = (opts.prefs && opts.prefs.widths) || {};
  for (const f of cols) {
    const c = document.createElement('col');
    c.style.width = (widths[f.key] || f.w) + 'px';
    cg.appendChild(c);
    sum += parseFloat(c.style.width) || f.w;
  }
  tableCols.set(t, cols);
  t.appendChild(cg);
  t.style.minWidth = sum + 'px';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const f of cols) {
    const th = el('th', null, f.label);
    if (opts.sortable && f.key !== '__beat' && f.key !== '__toggle' && f.type !== 'prompt') {
      th.classList.add('sortable');
      if (opts.sortState && opts.sortState.key === f.key) {
        th.classList.add(opts.sortState.dir === 1 ? 'asc' : 'desc');
        th.appendChild(el('span', 'arrow', opts.sortState.dir === 1 ? '▲' : '▼'));
      }
      th.addEventListener('click', () => opts.onSort(f.key));
    }
    if (f.key !== '__toggle') {
      th.classList.add('col-resizable');
      const grip = document.createElement('div');
      grip.className = 'col-resize';
      grip.title = '拖动调列宽 · 双击恢复默认';
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startColResize(e, f, opts);
      });
      grip.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
      grip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (opts.prefs && opts.prefs.widths) delete opts.prefs.widths[f.key];
        if (opts.savePrefs) opts.savePrefs();
        applyColWidth(f.key, f.w);
      });
      th.appendChild(grip);
    }
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  t.appendChild(thead);

  const tb = document.createElement('tbody');
  for (const s of shots) tb.appendChild(shotRows(s, cols, groups, data));
  t.appendChild(tb);
  wrap.appendChild(t);
  return wrap;
}

function shotRows(s, cols, groups, data) {
  const tr = el('tr', 'shot');
  tr.dataset.id = s.id;
  tr.dataset.beatId = s.beat_id;
  for (const f of cols) tr.appendChild(shotCell(s, f, groups, data));
  const det = el('tr', 'detail');
  det.hidden = true;
  det.dataset.for = s.id;
  const dtd = document.createElement('td');
  dtd.colSpan = cols.length;
  dtd.appendChild(detailBox(s, groups, data));
  det.appendChild(dtd);

  const flip = () => {
    det.hidden = !det.hidden;
    tr.classList.toggle('open', !det.hidden);
  };
  const tc = tr.querySelector('.cell-toggle');
  if (tc) tc.addEventListener('click', (e) => { e.stopPropagation(); flip(); });
  const pc = tr.querySelector('.cell-prompt');
  if (pc) pc.addEventListener('click', (e) => { e.stopPropagation(); toggleComposer(det, s); });

  const frag = document.createDocumentFragment();
  frag.appendChild(tr);
  frag.appendChild(det);
  return frag;
}

function shotCell(s, f, groups, data) {
  const td = document.createElement('td');

  if (f.type === 'toggle') {
    td.className = 'cell-toggle';
    td.appendChild(el('span', 'chev', '▸'));
    const d = document.createElement('span');
    d.className = 'drag-dots';
    d.textContent = '⠿';
    d.draggable = true;
    d.title = '拖动重排';
    d.addEventListener('click', (e) => e.stopPropagation());
    td.appendChild(d);
    return td;
  }

  td.className = 'cell-' + (f.key === '__beat' ? 'beatref' : f.key);
  if (f.key === '__beat') {
    const b = data.beats.find((x) => x.id === s.beat_id);
    td.textContent = b
      ? ((/^\d+$/.test(String(b.beat_no)) ? b.beat_no + ' · ' : '') + (b.name || ''))
      : '—';
    return td;
  }
  if (f.type === 'prompt') {
    const g = s.prompt_group_id != null ? groups[s.prompt_group_id] : null;
    td.classList.add('prompt-cell');
    td.textContent = g ? g.member_shots.join(' / ') : '—';
    if (g) td.title = '提示词组：' + g.member_shots.join(' / ') + '（点击展开）';
    return td;
  }

  renderShotField(td, s, f);
  td.dataset.field = f.key;

  if (f.type === 'camera') {
    attachCamEditor(td, {
      id: s.id,
      getCam: () => ({ raw: s.shot_size, focal: s.focal, dof: s.dof }),
      setCam: (k, v) => { s[k] = v; },
      renderCell: () => {
        renderShotField(td, s, f);
        refreshDetailValue(s, 'shot_size');
        refreshDetailValue(s, 'focal');
        refreshDetailValue(s, 'dof');
      },
      refreshSiblings: () => {
        refreshDetailValue(s, 'shot_size');
        refreshDetailValue(s, 'focal');
        refreshDetailValue(s, 'dof');
      },
      camOptions: camOptions,
    });
    return td;
  }

  attachEditable(td, {
    table: 'shots', id: s.id, field: f.key, label: f.label,
    multiline: isMultiline(f),
    select: f.options || undefined,
    getValue: () => s[f.key],
    onLocal: (v) => { s[f.key] = v; },
    renderCell: () => { renderShotField(td, s, f); refreshDetailValue(s, f.key); },
    walk: (dir) => walkCell(td, dir),
  });
  return td;
}

export function renderShotField(td, s, f) {
  td.textContent = '';
  td.appendChild(cellContent(f.type, s[f.key], f.type === 'camera' ? { focal: s.focal } : null));
}

export function refreshDetailValue(s, key) {
  document.querySelectorAll('tr.detail[data-for="' + s.id + '"] .kv-value[data-field="' + key + '"]')
    .forEach((v) => { v.textContent = fmt(s[key]); });
}

function refreshTableValue(s, key) {
  const f = state.meta.shot_fields.find((x) => x.key === key);
  if (!f) return;
  document.querySelectorAll('tr.shot[data-id="' + s.id + '"] td[data-field="' + key + '"]')
    .forEach((td) => { renderShotField(td, s, f); });
}

function camOptions() {
  const sz = state.meta.shot_fields.find((x) => x.key === 'shot_size');
  const fo = state.meta.shot_fields.find((x) => x.key === 'focal');
  return { tiers: (sz && sz.options) || [], lens: (fo && fo.options) || [] };
}

function detailCamCfg(s, v) {
  return {
    id: s.id,
    getCam: () => ({ raw: s.shot_size, focal: s.focal, dof: s.dof }),
    setCam: (k, val) => { s[k] = val; },
    renderCell: () => {
      v.textContent = fmt(s.shot_size);
      refreshTableValue(s, 'shot_size');
      refreshDetailValue(s, 'shot_size');
      refreshDetailValue(s, 'focal');
      refreshDetailValue(s, 'dof');
    },
    refreshSiblings: () => {
      refreshTableValue(s, 'shot_size');
      refreshDetailValue(s, 'focal');
      refreshDetailValue(s, 'dof');
    },
    camOptions: camOptions,
  };
}

// 焦段编辑归一化：写 focal；若旧串内嵌焦段 → 顺带把串重写为纯景别（一份来源）
function lensSave(s, refresh) {
  return async (oldV, newV) => {
    const p = parseCam(s.shot_size);
    const oldValues = { shot_size: s.shot_size, focal: s.focal };
    const writes = [['focal', newV]];
    if (p.lens) writes.push(['shot_size', p.t1 + (p.t2 ? ' ↓ ' + p.t2 : '')]);
    for (const w of writes) s[w[0]] = w[1];
    refresh();
    try {
      for (const w of writes) await api.update('shots', s.id, w[0], w[1]);
      recordUndo({
        type: 'custom', label: '焦段',
        undo: async () => {
          await api.update('shots', s.id, 'shot_size', oldValues.shot_size == null ? '' : oldValues.shot_size);
          await api.update('shots', s.id, 'focal', oldValues.focal == null ? '' : oldValues.focal);
        },
      });
    } catch (err) {
      s.shot_size = oldValues.shot_size;
      s.focal = oldValues.focal;
      refresh();
      throw err;
    }
  };
}

function detailBox(s, groups, data) {
  const box = el('div', 'detail-grid');
  for (const f of state.meta.shot_fields) {
    if (f.type === 'prompt') continue;
    const item = el('div', 'kv-item');
    item.dataset.field = f.key;
    item.appendChild(el('div', 'kv-label', f.label));
    const v = el('div', 'kv-value', fmt(s[f.key]));
    v.dataset.field = f.key;
    if (f.key === 'shot_size') {
      attachCamEditor(v, detailCamCfg(s, v));
    } else if (f.key === 'focal') {
      attachEditable(v, {
        table: 'shots', id: s.id, field: 'focal', label: f.label,
        select: f.options || undefined,
        getValue: () => s.focal,
        onLocal: (val) => { s.focal = val; },
        renderCell: () => { v.textContent = fmt(s.focal); },
        save: lensSave(s, () => {
          v.textContent = fmt(s.focal);
          refreshTableValue(s, 'shot_size');
          refreshDetailValue(s, 'shot_size');
        }),
      });
    } else {
      attachEditable(v, {
        table: 'shots', id: s.id, field: f.key, label: f.label,
        multiline: isMultiline(f),
        select: f.options || undefined,
        getValue: () => s[f.key],
        onLocal: (val) => { s[f.key] = val; },
        renderCell: () => { v.textContent = fmt(s[f.key]); refreshTableValue(s, f.key); },
      });
    }
    item.appendChild(v);
    box.appendChild(item);
  }
  box.appendChild(buildPromptBox(s, groups, data));
  return box;
}

export function beatSection(b, data, opts) {
  const sec = el('section', 'beat');
  if (b.id != null) sec.dataset.beatId = b.id;
  const numeric = b.beat_no != null && /^\d+/.test(String(b.beat_no));
  if (numeric) {
    const head = el('div', 'beat-head');
    head.draggable = true;
    head.title = '点名称改字 · 拖动整节拍重排';
    if (b.kind) {
      const lab = el('span', 'beat-label beat-dot', String(b.kind));
      attachEditable(lab, {
        table: 'beats', id: b.id, field: 'kind', label: '节拍类型',
        select: state.meta.beat_kinds || [],
        getValue: () => b.kind,
        onLocal: (v) => { b.kind = v; },
        renderCell: () => { lab.textContent = fmt(b.kind); },
      });
      head.appendChild(lab);
    }
    const title = el('span', 'beat-title', beatTitle(b));
    attachEditable(title, {
      table: 'beats', id: b.id, field: 'name', label: '节拍名称',
      getValue: () => b.name,
      onLocal: (v) => { b.name = v; },
      renderCell: () => { title.textContent = beatTitle(b); },
    });
    head.appendChild(title);
    sec.appendChild(head);
  } else {
    sec.appendChild(el('div', 'space-label', '▸ ' + (b.name || '未归节拍') + ' (' + b.shots.length + ' 镜)'));
  }
  if (b.id != null) {
    const act = el('div', 'beat-action');
    if (!b.beat_action) act.classList.add('empty');
    renderBeatAction(act, b);
    attachEditable(act, {
      table: 'beats', id: b.id, field: 'beat_action', label: '节拍概述', multiline: true,
      getValue: () => b.beat_action,
      onLocal: (v) => { b.beat_action = v; },
      renderCell: () => {
        act.classList.toggle('empty', !b.beat_action);
        renderBeatAction(act, b);
      },
    });
    sec.appendChild(act);
  } else if (b.beat_action) {
    const act = el('div', 'beat-action');
    renderBeatAction(act, b);
    sec.appendChild(act);
  }
  if (b.shots.length) {
    sec.appendChild(buildTable(b.shots, {
      data: data, prefs: opts.prefs, sortable: true,
      sortState: opts.sortState, onSort: opts.onSort, savePrefs: opts.savePrefs,
    }));
  } else {
    sec.appendChild(el('div', 'empty small', '（暂无镜头）'));
  }
  sec.appendChild(addShotBar(b, data, opts));
  return sec;
}

// 节拍末尾「＋ 镜头」：空节拍/空场的创作入口（编号服务端自动）
function addShotBar(b, data, opts) {
  const bar = el('div', 'add-shot-bar');
  const btn = el('button', 'link-btn', '＋ 镜头');
  btn.title = '在末尾添加空行，随后直接开写';
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try {
      const idx = beatInsertIndex(data, b);
      const res = await api.create({
        kind: 'shot', scene_id: data.scene.id,
        beat_id: b.id == null ? null : b.id, index: idx,
      });
      const ns = res.shot || {};
      toast('已添加' + (ns.shot_no ? '：' + ns.shot_no : ''));
      recordUndo({
        type: 'custom', label: '添加镜头',
        undo: async () => { await api.del({ table: 'shots', ids: [ns.id] }); },
      });
      if (opts.refresh) await opts.refresh();
      const ntr = document.querySelector('tr.shot[data-id="' + ns.id + '"]');
      if (ntr) {
        ntr.scrollIntoView({ block: 'nearest' });
        ntr.classList.add('flash');
        setTimeout(() => ntr.classList.remove('flash'), 1600);
      }
    } catch (err) {
      toast('添加失败：' + err.message, 'err');
    }
  });
  bar.appendChild(btn);
  return bar;
}

// 空节拍里「第一颗镜头」的插入位：前序节拍镜头之后（全空则 0）
function beatInsertIndex(data, b) {
  if (b.shots && b.shots.length) return Number(b.shots[b.shots.length - 1].position) + 1;
  const beats = data.beats || [];
  const total = beats.reduce((n, x) => n + ((x.shots && x.shots.length) || 0), 0)
    + ((data.orphan_shots && data.orphan_shots.length) || 0);
  const i = (b.id != null) ? beats.findIndex((x) => x.id === b.id) : -1;
  if (i === -1) return total;
  let idx = null;
  for (let j = 0; j < i; j++) {
    const sh = beats[j].shots;
    if (sh && sh.length) idx = Math.max(idx == null ? 0 : idx, Number(sh[sh.length - 1].position) + 1);
  }
  if (idx == null) {
    for (let j = i + 1; j < beats.length; j++) {
      const sh = beats[j].shots;
      if (sh && sh.length) { idx = Number(sh[0].position); break; }
    }
  }
  return idx == null ? total : idx;
}

function beatTitle(b) {
  return 'beat ' + b.beat_no + '：' + (b.name || '') + ' (' + b.shots.length + ' 镜)';
}

function renderBeatAction(act, b) {
  act.textContent = '';
  const text = String(b.beat_action || '');
  if (!text.trim()) {
    act.appendChild(el('span', 'beat-action-hint', '＋ 填写节拍概述（外界动作 / 人物反应 / 闭环…）'));
    return;
  }
  text.split('\n').forEach((line, i) => {
    if (i) act.appendChild(document.createElement('br'));
    act.appendChild(document.createTextNode(line));
  });
}

// 单元格走格（Tab/Enter）：找同表相邻格并直接开编辑（合成点击 → 复用各控件开启路径）
export function walkCell(td, dir) {
  const tr = td.closest('tr.shot');
  if (!tr) return;
  const table = tr.closest('table');
  if (!table) return;
  if (dir === 'down' || dir === 'up') {
    const rows = visibleRows(table);
    const ti = rows.indexOf(tr);
    const nt = rows[ti + (dir === 'down' ? 1 : -1)];
    if (!nt) return;
    const ntd = nt.querySelector('td[data-field="' + td.dataset.field + '"]');
    if (ntd) ntd.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  } else {
    const tds = Array.from(tr.querySelectorAll('td[data-field]'));
    const i = tds.indexOf(td);
    const ntd = tds[i + dir];
    if (ntd) ntd.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
}

export function visibleRows(table) {
  return Array.from(table.querySelectorAll('tbody tr.shot')).filter((tr) => tr.style.display !== 'none');
}

// 单格重画 + 详情区同步（批量/清空/粘贴共用）
export function refreshShotCell(s, key) {
  if (!s) return;
  const f = state.meta.shot_fields.find((x) => x.key === key);
  if (!f) return;
  document.querySelectorAll('tr.shot[data-id="' + s.id + '"] td[data-field="' + key + '"]')
    .forEach((td) => { renderShotField(td, s, f); });
  refreshDetailValue(s, key);
}
