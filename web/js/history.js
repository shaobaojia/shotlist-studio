// 痕迹回看面板（M2-7）：当前场全操作留痕（旧值 → 新值），可搜索、可刷新。
// 数据源 /api/history（倒序，最近在前）；面板固定右侧，页面刷新后自动跟新（refreshHistoryIfOpen）。
import { api } from './api.js';
import { state } from './state.js';
import { el } from './ui.js';

const ENTITY_LABEL = { shots: '镜头', beats: '节拍', scenes: '场次' };
const SPECIAL_FIELD = { create: '新增', delete: '删除', drag: '拖动', locked: '锁定' };

let panel = null;
let listEl = null;
let inputEl = null;
let sceneId = null;
let rows = [];

export function toggleHistory(scene) {
  if (!scene) return;
  if (panel && !panel.hidden && panel.dataset.sceneId === String(scene.id)) {
    closeHistory();
    return;
  }
  openHistory(scene);
}

export function closeHistory() {
  if (panel) panel.hidden = true;
}

export function refreshHistoryIfOpen() {
  if (panel && !panel.hidden) load();
}

async function openHistory(scene) {
  sceneId = scene.id;
  if (!panel) build();
  panel.dataset.sceneId = String(scene.id);
  panel.hidden = false;
  inputEl.value = '';
  await load();
}

function build() {
  panel = el('div');
  panel.id = 'hist-panel';
  panel.hidden = true;

  const head = el('div', 'hist-head');
  head.appendChild(el('b', null, '痕迹回看'));
  inputEl = document.createElement('input');
  inputEl.className = 'hist-search';
  inputEl.placeholder = '搜索字段 / 值…';
  inputEl.addEventListener('input', render);
  head.appendChild(inputEl);
  const rf = el('button', 'tool-btn small', '刷新');
  rf.addEventListener('click', load);
  head.appendChild(rf);
  const x = el('button', 'tool-btn small', '✕');
  x.addEventListener('click', closeHistory);
  head.appendChild(x);
  panel.appendChild(head);

  listEl = el('div', 'hist-list');
  panel.appendChild(listEl);
  document.body.appendChild(panel);
}

async function load() {
  if (!listEl) return;
  listEl.textContent = '加载中…';
  try {
    const res = await api.history(sceneId, 200);
    rows = res.history || [];
    render();
  } catch (err) {
    listEl.textContent = '加载失败：' + err.message;
  }
}

function fieldLabel(r) {
  if (SPECIAL_FIELD[r.field]) return SPECIAL_FIELD[r.field];
  try {
    const pools = { shots: state.meta.shot_fields, beats: state.meta.beat_fields, scenes: state.meta.scene_fields };
    const f = (pools[r.entity] || []).find((x) => x.key === r.field);
    if (f && f.label) return f.label;
  } catch (e) { /* ignore */ }
  return r.field || '';
}

function fmtVal(v) {
  if (v == null || v === '') return '∅';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 46 ? s.slice(0, 46) + '…' : s;
}

function render() {
  if (!listEl) return;
  const q = (inputEl.value || '').trim();
  listEl.textContent = '';
  const shown = rows.filter((r) => {
    if (!q) return true;
    return (fieldLabel(r) + ' ' + (r.old_value || '') + ' ' + (r.new_value || '') + ' ' + (r.source || '')).indexOf(q) !== -1;
  });
  if (!shown.length) {
    listEl.appendChild(el('div', 'hist-empty', q ? '（没有匹配的痕迹）' : '（暂无痕迹）'));
    return;
  }
  for (const r of shown) {
    const d = el('div', 'hist-row');
    d.title = (r.at || '') + '  #' + (r.entity_id != null ? r.entity_id : '') + '  [' + (r.source || '') + ']';
    d.appendChild(el('span', 'hist-time', String(r.at || '').slice(11, 19)));
    d.appendChild(el('span', 'hist-entity', ENTITY_LABEL[r.entity] || r.entity));
    d.appendChild(el('span', 'hist-field', fieldLabel(r)));
    const v = el('span', 'hist-val');
    v.appendChild(el('span', 'hist-old', fmtVal(r.old_value)));
    v.appendChild(document.createTextNode(' → '));
    v.appendChild(el('span', 'hist-new', fmtVal(r.new_value)));
    d.appendChild(v);
    listEl.appendChild(d);
  }
}
