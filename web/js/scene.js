// 场级页——老库表视图移植版。
// 规格来源：storyboard-shotlist（buildRow / formatKongjian / info-bar / beat-section 的忠实搬运）。
// 移植项：列序与聚合列、自动换行开关、显示提示词开关、表头排序（视图级，自动平铺）。
import { api } from './api.js';
import { state } from './state.js';
import { el, fmt } from './ui.js';
import { cellContent, JIWEI_LEGEND } from './cells.js';

const PREFS_KEY = 'shotlist_prefs_v1';
let prefs = loadPrefs();   // { wrap: true, prompt: true }
let sortState = null;      // { key, dir: 1|-1 } | null —— 仅视图，不改行序
let currentData = null;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { wrap: p.wrap !== false, prompt: p.prompt !== false };
  } catch (e) {
    return { wrap: true, prompt: true };
  }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
}

export async function renderScene(view, sceneNo) {
  view.textContent = '';
  view.appendChild(el('div', 'empty', '加载中…'));
  let data;
  try {
    data = await api.scene(sceneNo);
  } catch (err) {
    view.textContent = '';
    view.appendChild(el('div', 'empty err', '加载失败：' + err.message));
    return;
  }
  if (location.hash !== '' && location.hash !== '#/' + sceneNo) return;
  sortState = null;
  currentData = data;
  paintScene(view);
}

function paintScene(view) {
  const data = currentData;
  if (!data) return;
  view.textContent = '';
  view.classList.toggle('wrap-off', !prefs.wrap);

  view.appendChild(sceneHead(data.scene, data));
  const shots = allShots(data);
  if (!shots.length) {
    view.appendChild(el('div', 'empty', '本场暂无镜头——价值弧线已登记，等待创作填入。'));
    return;
  }
  view.appendChild(viewTools());
  if (sortState) {
    view.appendChild(buildTable(sortedShots(shots), { beatCol: true, sortable: true, data: data }));
  } else {
    for (const b of data.beats) view.appendChild(beatSection(b, data));
    if (data.orphan_shots && data.orphan_shots.length) {
      view.appendChild(beatSection({ beat_no: null, name: '未归节拍', kind: null, beat_action: null, shots: data.orphan_shots }, data));
    }
  }
}

function allShots(data) {
  let shots = [];
  for (const b of data.beats) shots = shots.concat(b.shots);
  if (data.orphan_shots) shots = shots.concat(data.orphan_shots);
  return shots;
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + '\u2032' + String(s).padStart(2, '0') + '\u2033';
}

function sceneHead(sc, data) {
  const head = el('div', 'scene-head');
  head.appendChild(el('h1', 'scene-title', sc.scene_no + (sc.title ? ' · ' + sc.title : '')));
  const meta = el('div', 'scene-meta');
  const kv = (label, val) => {
    if (val == null || val === '') return;
    const s = el('span', 'kv');
    s.appendChild(el('b', null, label));
    s.appendChild(document.createTextNode(fmt(val)));
    meta.appendChild(s);
  };
  kv('价值', sc.value);
  kv('弧线', [sc.pole_start, sc.pole_end].filter(Boolean).join(' → '));
  kv('翻转', sc.turn);
  kv('视点', sc.pov);
  const shots = allShots(data);
  const total = shots.reduce((n, s) => n + (parseFloat(s.duration) || 0), 0);
  kv('规模', shots.length + ' 镜 / ' + data.beats.length + ' 节拍 / 总时长 ' + fmtDur(total));
  const legend = el('span', 'kv legend');
  legend.appendChild(el('b', null, '机位'));
  legend.appendChild(document.createTextNode(JIWEI_LEGEND.join(' ')));
  meta.appendChild(legend);
  head.appendChild(meta);
  return head;
}

function viewTools() {
  const bar = el('div', 'view-tools');
  const mkBox = (labelText, checked, onChange) => {
    const lab = el('label', 'tool');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', onChange);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + labelText));
    return lab;
  };
  bar.appendChild(mkBox('自动换行', prefs.wrap, (e) => {
    prefs.wrap = e.target.checked;
    savePrefs();
    document.getElementById('view').classList.toggle('wrap-off', !prefs.wrap);
  }));
  bar.appendChild(mkBox('显示提示词', prefs.prompt, (e) => {
    prefs.prompt = e.target.checked;
    savePrefs();
    paintScene(document.getElementById('view'));
  }));
  if (sortState) {
    const f = state.meta.shot_fields.find(x => x.key === sortState.key);
    bar.appendChild(el('span', 'sort-info',
      '视图排序：' + (f ? f.label : sortState.key) + (sortState.dir === 1 ? ' ↑' : ' ↓') + '（仅视图）'));
    const btn = el('button', 'tool-btn', '清除排序');
    btn.addEventListener('click', () => {
      sortState = null;
      paintScene(document.getElementById('view'));
    });
    bar.appendChild(btn);
  }
  return bar;
}

function cycleSort(key) {
  if (!sortState || sortState.key !== key) sortState = { key: key, dir: 1 };
  else if (sortState.dir === 1) sortState = { key: key, dir: -1 };
  else sortState = null;
  paintScene(document.getElementById('view'));
}

function sortedShots(shots) {
  const arr = shots.slice();
  const key = sortState.key;
  const dir = sortState.dir;
  arr.sort((a, b) => cmpVal(a[key], b[key]) * dir);
  return arr;
}

function cmpVal(va, vb) {
  const sa = va == null ? '' : String(va).trim();
  const sb = vb == null ? '' : String(vb).trim();
  const na = parseFloat(sa);
  const nb = parseFloat(sb);
  if (sa !== '' && sb !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
  if (!sa && sb) return 1;
  if (sa && !sb) return -1;
  return sa.localeCompare(sb, 'zh');
}

function tableColumns(beatCol) {
  const fields = state.meta.shot_fields.filter(f => f.in_table && (f.type !== 'prompt' || prefs.prompt));
  if (!beatCol) return fields;
  const cols = fields.slice();
  cols.splice(1, 0, { key: '__beat', label: '节拍', type: 'beat', w: 110 });
  return cols;
}

function buildTable(shots, opts) {
  const data = opts.data || currentData;
  const cols = tableColumns(!!opts.beatCol);
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
    if (opts.sortable && f.type !== 'prompt' && f.key !== '__beat') {
      th.classList.add('sortable');
      if (sortState && sortState.key === f.key) {
        th.classList.add(sortState.dir === 1 ? 'asc' : 'desc');
        th.appendChild(el('span', 'arrow', sortState.dir === 1 ? '▲' : '▼'));
      }
      th.addEventListener('click', () => cycleSort(f.key));
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
  for (const f of cols) tr.appendChild(shotCell(s, f, groups, data));
  const det = el('tr', 'detail');
  det.hidden = true;
  const dtd = document.createElement('td');
  dtd.colSpan = cols.length;
  dtd.appendChild(detailBox(s, groups));
  det.appendChild(dtd);
  tr.addEventListener('click', () => {
    det.hidden = !det.hidden;
    tr.classList.toggle('open', !det.hidden);
  });
  const frag = document.createDocumentFragment();
  frag.appendChild(tr);
  frag.appendChild(det);
  return frag;
}

function shotCell(s, f, groups, data) {
  const td = document.createElement('td');
  td.className = 'cell-' + (f.key === '__beat' ? 'beatref' : f.key);
  if (f.key === '__beat') {
    const b = data.beats.find(x => x.id === s.beat_id);
    td.textContent = b
      ? ((/^\d+$/.test(String(b.beat_no)) ? b.beat_no + ' · ' : '') + (b.name || ''))
      : '—';
  } else if (f.type === 'prompt') {
    const g = s.prompt_group_id != null ? groups[s.prompt_group_id] : null;
    td.classList.add('prompt-cell');
    td.textContent = g ? g.member_shots.join(' / ') : '—';
    if (g) td.title = '提示词组：' + g.member_shots.join(' / ');
  } else {
    td.appendChild(cellContent(f.type, s[f.key]));
  }
  return td;
}

function beatSection(b, data) {
  const sec = el('section', 'beat');
  const numeric = b.beat_no != null && /^\d+$/.test(String(b.beat_no));
  if (numeric) {
    const head = el('div', 'beat-head');
    if (b.kind) head.appendChild(el('span', 'beat-label beat-dot', String(b.kind)));
    head.appendChild(el('span', 'beat-title', 'beat ' + b.beat_no + '：' + (b.name || '') + ' (' + b.shots.length + ' 镜)'));
    sec.appendChild(head);
  } else {
    sec.appendChild(el('div', 'space-label', '▸ ' + (b.name || '未归节拍') + '镜 (' + b.shots.length + ' 镜)'));
  }
  if (b.beat_action) {
    const act = el('div', 'beat-action');
    String(b.beat_action).split('\n').forEach((line, i) => {
      if (i) act.appendChild(document.createElement('br'));
      act.appendChild(document.createTextNode(line));
    });
    sec.appendChild(act);
  }
  if (b.shots.length) sec.appendChild(buildTable(b.shots, { data: data, sortable: true }));
  else sec.appendChild(el('div', 'empty small', '（暂无镜头）'));
  return sec;
}

function detailBox(s, groups) {
  const box = el('div', 'detail-grid');
  for (const f of state.meta.shot_fields) {
    if (f.type === 'prompt') continue;
    const item = el('div', 'kv-item');
    item.appendChild(el('div', 'kv-label', f.label));
    item.appendChild(el('div', 'kv-value', fmt(s[f.key])));
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
