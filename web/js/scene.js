// 场级页——页面组装：头部（可编）/ 工具条（整理镜号·开关·排序）/ 分组与平铺；
// 表格与节拍区在 table.js；编辑引擎在 edit.js。
import { api } from './api.js';
import { state } from './state.js';
import { el, fmt, toast } from './ui.js';
import { JIWEI_LEGEND } from './cells.js';
import { buildTable, beatSection } from './table.js';
import { attachEditable, recordUndo } from './edit.js';

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

export async function refreshCurrentView() {
  const view = document.getElementById('view');
  if (!currentData || !view) return;
  const no = currentData.scene.scene_no;
  try {
    currentData = await api.scene(no);
    paintScene(view);
  } catch (e) { /* 保留现状 */ }
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
  const topts = { prefs: prefs, sortState: sortState, onSort: cycleSort };
  if (sortState) {
    view.appendChild(buildTable(sortedShots(shots), {
      beatCol: true, sortable: true, data: data,
      prefs: topts.prefs, sortState: topts.sortState, onSort: topts.onSort,
    }));
  } else {
    for (const b of data.beats) view.appendChild(beatSection(b, data, topts));
    if (data.orphan_shots && data.orphan_shots.length) {
      view.appendChild(beatSection(
        { beat_no: null, name: '未归节拍', kind: null, beat_action: null, shots: data.orphan_shots },
        data, topts));
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
  const h1 = el('h1', 'scene-title');
  h1.appendChild(document.createTextNode(sc.scene_no + ' · '));
  const t = el('span', null, sc.title || '');
  attachEditable(t, {
    table: 'scenes', id: sc.id, field: 'title', label: '场景名',
    getValue: () => sc.title,
    onLocal: (v) => { sc.title = v; },
    renderCell: () => { t.textContent = sc.title || ''; },
  });
  h1.appendChild(t);
  head.appendChild(h1);

  const meta = el('div', 'scene-meta');
  const kvEdit = (label, field) => {
    if (sc[field] == null || sc[field] === '') return;
    const s = el('span', 'kv');
    s.appendChild(el('b', null, label));
    const v = el('span', 'kv-v', fmt(sc[field]));
    attachEditable(v, {
      table: 'scenes', id: sc.id, field: field, label: label,
      getValue: () => sc[field],
      onLocal: (x) => { sc[field] = x; },
      renderCell: () => { v.textContent = fmt(sc[field]); },
    });
    s.appendChild(v);
    meta.appendChild(s);
  };
  kvEdit('价值', 'value');
  if (sc.pole_start || sc.pole_end) {
    const s = el('span', 'kv');
    s.appendChild(el('b', null, '弧线'));
    s.appendChild(document.createTextNode([sc.pole_start, sc.pole_end].filter(Boolean).join(' → ')));
    meta.appendChild(s);
  }
  kvEdit('翻转', 'turn');
  kvEdit('视点', 'pov');

  const shots = allShots(data);
  const total = shots.reduce((n, s) => n + (parseFloat(s.duration) || 0), 0);
  const s1 = el('span', 'kv');
  s1.appendChild(el('b', null, '规模'));
  s1.appendChild(document.createTextNode(shots.length + ' 镜 / ' + data.beats.length + ' 节拍 / 总时长 ' + fmtDur(total)));
  meta.appendChild(s1);

  const legend = el('span', 'kv legend');
  legend.appendChild(el('b', null, '机位'));
  legend.appendChild(document.createTextNode(JIWEI_LEGEND.join(' ')));
  meta.appendChild(legend);
  head.appendChild(meta);
  return head;
}

function viewTools() {
  const bar = el('div', 'view-tools');

  const rn = el('button', 'tool-btn', '整理镜号');
  rn.title = '按当前顺序整场顺排（旧号入痕迹）；不点不排';
  rn.addEventListener('click', async () => {
    try {
      const res = await api.renumber(currentData.scene.scene_no);
      const changes = res.changes || [];
      if (changes.length) {
        const byId = {};
        for (const c of changes) byId[c.id] = c.new;
        for (const s of allShots(currentData)) {
          if (byId[s.id] != null) s.shot_no = byId[s.id];
        }
        recordUndo({ type: 'renumber', changes: changes });
        toast('已整理 ' + changes.length + ' 个镜号（旧号入痕迹）');
        paintScene(document.getElementById('view'));
      } else {
        toast('镜号已是连续，无需整理');
      }
    } catch (err) {
      toast('整理失败：' + err.message, 'err');
    }
  });
  bar.appendChild(rn);

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
