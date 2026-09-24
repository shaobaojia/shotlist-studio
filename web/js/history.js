// 痕迹回看面板（M2-7）：当前场全操作留痕（旧值 → 新值），可搜索、可刷新。
// 数据源 /api/history（倒序，最近在前）；面板固定右侧，页面刷新后自动跟新（refreshHistoryIfOpen）。
import { api } from './api.js';
import { fieldsOf } from './state.js';
import { el, stageText, fmtStamp } from './ui.js';
import { panelShell, floatEnter, floatLeave } from './float.js';

const ENTITY_LABEL = { shots: '镜头', beats: '节拍', scenes: '场次', prompt_groups: '提示词组', audit: '审计' };
const SPECIAL_FIELD = { create: '新增', delete: '删除', drag: '拖动', locked: '锁定',
  text: '正文', merge: '并组', merge_in: '并入', split: '拆组', detach: '独立成组', restore: '还原',
  status: '状态' };

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
  floatLeave('panel', closeHistory);
}

let _loadT = 0;
export function refreshHistoryIfOpen() {
  if (!panel || panel.hidden) return;
  clearTimeout(_loadT);
  _loadT = setTimeout(load, 300);   // F5-P5④：重绘链防抖（原每帧一拉）
}

async function openHistory(scene) {
  sceneId = scene.id;
  if (!panel) build();
  panel.dataset.sceneId = String(scene.id);
  floatEnter('panel', closeHistory);   // F5-P1②：入互斥注册表（与审计清单/设置/审计设置同层）
  panel.hidden = false;
  inputEl.value = '';
  await load();
}

function build() {
  inputEl = document.createElement('input');
  inputEl.className = 'hist-search';
  inputEl.placeholder = '搜索字段 / 值…';
  inputEl.addEventListener('input', renderSoon);

  // F5-P1②：外壳走 panelShell + 互斥登记（原手搓头未挂注册表——与审计清单/设置卡同占右上角叠卡）
  const sh = panelShell({
    id: 'hist-panel', headCls: 'hist-head', title: '痕迹回看', noBody: true, onClose: closeHistory,
    fillHead: (h) => {
      h.appendChild(inputEl);
      const rf = el('button', 'tool-btn small', '刷新');
      rf.addEventListener('click', load);
      h.appendChild(rf);
    },
  });
  panel = sh.card;
  panel.hidden = true;
  listEl = el('div', 'hist-list');
  panel.appendChild(listEl);
  document.body.appendChild(panel);
}

async function load() {
  if (!listEl) return;
  stageText(listEl, 'loading');
  try {
    const res = await api.history(sceneId, 200);
    rows = res.history || [];
    render();
  } catch (err) {
    stageText(listEl, 'error', err);
  }
}

let _renT = 0;
function renderSoon() { clearTimeout(_renT); _renT = setTimeout(render, 120); }   // F5-P5④：搜索防抖

let _flMap = null;
function fieldLabel(r) {
  if (SPECIAL_FIELD[r.field]) return SPECIAL_FIELD[r.field];
  try {
    if (!_flMap) {   // F5-P5④：字段字典索引一次建（原每条 find 三池）
      _flMap = {};
      for (const ent of ['shots', 'beats', 'scenes']) {
        for (const f of fieldsOf(ent)) _flMap[ent + '.' + f.key] = f.label;
      }
    }
    const lab = _flMap[r.entity + '.' + r.field];
    if (lab) return lab;
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
    d.appendChild(el('span', 'hist-time', fmtStamp(r.at, 'hms')));
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
