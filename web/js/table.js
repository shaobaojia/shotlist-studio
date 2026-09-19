// 表格模块：列构建 / 单元格渲染 / 就地编辑绑定 / 节拍区 / 详情区。
// 显示规格 = cells.js（老库移植）；编辑引擎 = edit.js；页面组装在 scene.js。
import { state } from './state.js';
import { el, fmt } from './ui.js';
import { cellContent } from './cells.js';
import { attachEditable } from './edit.js';

const MULTILINE_TYPES = new Set(['spatial', 'dialogue', 'audio', 'notes', 'camera']);
const MULTILINE_KEYS = new Set(['blocking']);

function isMultiline(f) {
  return MULTILINE_TYPES.has(f.type) || MULTILINE_KEYS.has(f.key);
}

function tableColumns(beatCol, prefs) {
  const fields = state.meta.shot_fields.filter(f => f.in_table && (f.type !== 'prompt' || prefs.prompt));
  const cols = [{ key: '__toggle', label: '', type: 'toggle', w: 26 }].concat(fields);
  if (beatCol) {
    const i = cols.findIndex(c => c.key === 'shot_no');
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
  for (const f of cols) {
    const c = document.createElement('col');
    c.style.width = f.w + 'px';
    cg.appendChild(c);
    sum += f.w;
  }
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
  for (const f of cols) tr.appendChild(shotCell(s, f, groups, data));
  const det = el('tr', 'detail');
  det.hidden = true;
  det.dataset.for = s.id;
  const dtd = document.createElement('td');
  dtd.colSpan = cols.length;
  dtd.appendChild(detailBox(s, groups));
  det.appendChild(dtd);

  const flip = () => {
    det.hidden = !det.hidden;
    tr.classList.toggle('open', !det.hidden);
  };
  const tc = tr.querySelector('.cell-toggle');
  if (tc) tc.addEventListener('click', (e) => { e.stopPropagation(); flip(); });
  const pc = tr.querySelector('.cell-prompt');
  if (pc) pc.addEventListener('click', (e) => { e.stopPropagation(); flip(); });

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
    return td;
  }

  td.className = 'cell-' + (f.key === '__beat' ? 'beatref' : f.key);
  if (f.key === '__beat') {
    const b = data.beats.find(x => x.id === s.beat_id);
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
  attachEditable(td, {
    table: 'shots', id: s.id, field: f.key, label: f.label,
    multiline: isMultiline(f),
    getValue: () => s[f.key],
    onLocal: (v) => { s[f.key] = v; },
    renderCell: () => { renderShotField(td, s, f); refreshDetailValue(s, f.key); },
  });
  return td;
}

export function renderShotField(td, s, f) {
  td.textContent = '';
  td.appendChild(cellContent(f.type, s[f.key]));
}

function refreshDetailValue(s, key) {
  document.querySelectorAll('tr.detail[data-for="' + s.id + '"] .kv-value[data-field="' + key + '"]')
    .forEach((v) => { v.textContent = fmt(s[key]); });
}

function refreshTableValue(s, key) {
  const f = state.meta.shot_fields.find(x => x.key === key);
  if (!f) return;
  document.querySelectorAll('tr.shot[data-id="' + s.id + '"] td[data-field="' + key + '"]')
    .forEach((td) => { renderShotField(td, s, f); });
}

function detailBox(s, groups) {
  const box = el('div', 'detail-grid');
  for (const f of state.meta.shot_fields) {
    if (f.type === 'prompt') continue;
    const item = el('div', 'kv-item');
    item.dataset.field = f.key;
    item.appendChild(el('div', 'kv-label', f.label));
    const v = el('div', 'kv-value', fmt(s[f.key]));
    v.dataset.field = f.key;
    attachEditable(v, {
      table: 'shots', id: s.id, field: f.key, label: f.label,
      multiline: isMultiline(f),
      getValue: () => s[f.key],
      onLocal: (val) => { s[f.key] = val; },
      renderCell: () => { v.textContent = fmt(s[f.key]); refreshTableValue(s, f.key); },
    });
    item.appendChild(v);
    box.appendChild(item);
  }
  const g = s.prompt_group_id != null ? groups[s.prompt_group_id] : null;
  const pb = el('div', 'prompt-box');
  pb.appendChild(el('div', 'kv-label',
    g ? ('提示词（本组 ' + g.member_shots.length + ' 镜：' + g.member_shots.join(' / ') + '）') : '提示词'));
  pb.appendChild(el('pre', 'prompt-text', g ? g.text : '（未写提示词）'));
  box.appendChild(pb);
  return box;
}

export function beatSection(b, data, opts) {
  const sec = el('section', 'beat');
  const numeric = b.beat_no != null && /^\d+$/.test(String(b.beat_no));
  if (numeric) {
    const head = el('div', 'beat-head');
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
    sec.appendChild(el('div', 'space-label', '▸ ' + (b.name || '未归节拍') + '镜 (' + b.shots.length + ' 镜)'));
  }
  if (b.beat_action) {
    const act = el('div', 'beat-action');
    renderBeatAction(act, b);
    attachEditable(act, {
      table: 'beats', id: b.id, field: 'beat_action', label: '节拍动作', multiline: true,
      getValue: () => b.beat_action,
      onLocal: (v) => { b.beat_action = v; },
      renderCell: () => renderBeatAction(act, b),
    });
    sec.appendChild(act);
  }
  if (b.shots.length) {
    sec.appendChild(buildTable(b.shots, {
      data: data, prefs: opts.prefs, sortable: true,
      sortState: opts.sortState, onSort: opts.onSort,
    }));
  } else {
    sec.appendChild(el('div', 'empty small', '（暂无镜头）'));
  }
  return sec;
}

function beatTitle(b) {
  return 'beat ' + b.beat_no + '：' + (b.name || '') + ' (' + b.shots.length + ' 镜)';
}

function renderBeatAction(act, b) {
  act.textContent = '';
  String(b.beat_action || '').split('\n').forEach((line, i) => {
    if (i) act.appendChild(document.createElement('br'));
    act.appendChild(document.createTextNode(line));
  });
}
