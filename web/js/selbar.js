// 表底选区条（M2-4）：选区出现时浮出——计数 / 批量设值（枚举走菜单、文本走输入）/ 复制 / 清空。
import { state, fieldOf } from './state.js';
import { el } from './ui.js';
import { openMenu } from './menu.js';
import { onChange, current, clearSel, rectOf, copySelectionTSV, clearSelectionCells, applyFieldValue, applyBeatFieldValue, applySceneFieldValue, selBeatIds } from './selection.js';
import { deleteSelectedRows } from './cellmenu.js';
import { mergeShotsByIds, detachShotsByIds } from './hotbox.js';
import { runCmdbarFromSel } from './aiwrite.js';

// 可批量设值的字段（枚举优先排前；镜号/景深/虚拟列不进）
const BATCH_KEYS = ['camera_pos', 'shot_size', 'focal', 'shot_fn', 'camera_move', 'spatial', 'blocking', 'dialogue', 'duration', 'audio', 'director_note', 'pov'];
// 节拍字段（M5 批2c；节拍序号不进——批量改名无意义）与场景字段（场号不进——唯一性/路由）
const BEAT_BATCH_KEYS = ['name', 'kind', 'beat_action', 'outside_action', 'reaction', 'closed_loop', 'rhythm_section', 'rhythm_note', 'mood_temp', 'shot_estimate', 'rhythm_density', 'beat_attr', 'note', 'pov'];
const SCENE_BATCH_KEYS = ['title', 'value', 'pole_start', 'pole_end', 'turn', 'pov'];
const CLEAR = '（清空）';

let bar = null;
let countEl = null;
let delBtn = null;
let mergeBtn = null;
let pick = { field: null, value: null };
let sig = '';
let aiDraft = '';

export function initSelBar() {
  onChange(onSel);
}

function onSel(s) {
  if (!s) {
    if (bar) bar.style.display = 'none';
    pick = { field: null, value: null };
    sig = '';
    return;
  }
  const want = JSON.stringify([pick.field, pick.value]);
  if (!bar || want !== sig) build();
  updateCount(s);
  bar.style.display = 'flex';
}

function updateCount(s) {
  if (!countEl) return;
  const rc = rectOf();
  if (!rc) return;
  const m = rc.r2 - rc.r1 + 1;
  const colsN = rc.c2 - rc.c1 + 1;
  if (colsN === 1) {
    const f = fieldOf(s.cols[rc.c1]);
    countEl.textContent = '已选 ' + m + ' 镜 · ' + (f ? f.label : s.cols[rc.c1]);
  } else {
    countEl.textContent = '已选 ' + (m * colsN) + ' 格 · ' + m + ' 镜 · ' + colsN + ' 列';
  }
  if (delBtn) delBtn.textContent = '删除行（' + m + '）';
  if (mergeBtn) {
    const off = m < 2;
    mergeBtn.disabled = off;
    mergeBtn.title = off ? '至少选 2 镜才能并为一组' : '把选中的镜头合并为一个提示词组（保留首组文本，可 Ctrl+Z）';
  }
}

function selectedRowIds() {
  const s = current();
  const rc = rectOf();
  if (!s || !rc) return [];
  const ids = [];
  for (let r = rc.r1; r <= rc.r2; r++) {
    const tr = s.rows[r];
    if (tr) ids.push(Number(tr.dataset.id));
  }
  return ids;
}

function build() {
  if (!bar) {
    bar = el('div');
    bar.id = 'sel-bar';
    bar.style.display = 'none';
    document.body.appendChild(bar);
  }
  sig = JSON.stringify([pick.field, pick.value]);
  bar.textContent = '';
  countEl = el('span', 'sbar-count');
  bar.appendChild(countEl);

  const mid = el('span', 'sbar-mid');
  bar.appendChild(mid);
  const pf = pickField();
  const f = pf ? pf.f : null;
  const optsList = (pf && pf.dom === 'beats' && pf.key === 'kind')
    ? ((state.meta && state.meta.beat_kinds) || [])
    : (f && f.options && f.options.length ? f.options : null);

  const fbtn = el('button', 'tool-btn',
    f ? (pf.dom === 'beats' ? '节拍·' : (pf.dom === 'scenes' ? '场景·' : '')) + f.label : '设值…');
  fbtn.title = '选择要批量设置的字段（镜头 / 节拍 / 场景）';
  fbtn.addEventListener('click', () => {
    const items = BATCH_KEYS.map((k) => {
      const ff = fieldOf(k);
      return ff ? { key: k, label: ff.label, current: k === pick.field } : null;
    }).filter(Boolean);
    items.push({ sep: true }, { label: '— 节拍字段（套到所选行所在节拍）—', disabled: true });
    BEAT_BATCH_KEYS.forEach((k) => {
      const ff = fieldOf(k, 'beats');
      if (ff) items.push({ key: 'b:' + k, label: ff.label, current: pick.field === 'b:' + k });
    });
    items.push({ sep: true }, { label: '— 场景字段（套到本场）—', disabled: true });
    SCENE_BATCH_KEYS.forEach((k) => {
      const ff = fieldOf(k, 'scenes');
      if (ff) items.push({ key: 's:' + k, label: ff.label, current: pick.field === 's:' + k });
    });
    openMenu(fbtn, items, (k) => {
      pick = { field: k, value: null };
      build();
    });
  });
  mid.appendChild(fbtn);

  if (f) {
    if (optsList && optsList.length) {
      const vbtn = el('button', 'tool-btn', pick.value == null ? '值…' : (pick.value === '' ? CLEAR : pick.value));
      vbtn.title = '选值（拾取即套用）';
      vbtn.addEventListener('click', () => {
        const items = optsList.map((o) => ({ key: o, label: o, current: o === pick.value }))
          .concat([{ sep: true }, { key: '', label: CLEAR, current: pick.value === '' }]);
        openMenu(vbtn, items, (v) => {
          pick.value = v;
          build();
          applyPicked(pf, v, f);
        });
      });
      mid.appendChild(vbtn);
    } else {
      const inp = document.createElement('input');
      inp.className = 'sbar-input';
      inp.placeholder = '值…（回车' + (pf.dom === 'scenes' ? '套到本场' : '套到 ' + applyTargetText(pf)) + '）';
      inp.value = pick.value == null ? '' : pick.value;
      inp.addEventListener('input', () => { pick.value = inp.value; });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          pick.value = inp.value;
          sig = JSON.stringify([pick.field, pick.value]);
          applyPicked(pf, pick.value, f);
        }
      });
      mid.appendChild(inp);
      mid.appendChild(el('span', 'sbar-hint', '回车套用'));
    }
  } else {
    mid.appendChild(el('span', 'sbar-hint', '先选字段，再设值'));
  }

  const gm = el('button', 'tool-btn', '并为一组');
  gm.addEventListener('click', () => mergeShotsByIds(selectedRowIds()));
  mergeBtn = gm;
  bar.appendChild(gm);
  const gh = el('button', 'tool-btn', '独立成组');
  gh.title = '选中的镜头各自拆成独立的提示词组（可 Ctrl+Z）';
  gh.addEventListener('click', () => detachShotsByIds(selectedRowIds()));
  bar.appendChild(gh);

  const cp = el('button', 'tool-btn', '复制');
  cp.title = '复制选区（TSV，可直接贴进 Excel）';
  cp.addEventListener('click', () => copySelectionTSV());
  bar.appendChild(cp);
  delBtn = el('button', 'tool-btn', '删除行');
  delBtn.title = '删除选中行（可撤销 · Ctrl+Z）';
  delBtn.addEventListener('click', () => deleteSelectedRows());
  bar.appendChild(delBtn);
  const cl = el('button', 'tool-btn', '清空');
  cl.title = '清空选中格（可撤销）';
  cl.addEventListener('click', () => clearSelectionCells());
  bar.appendChild(cl);
  const aiIn = document.createElement('input');
  aiIn.className = 'sbar-ai';
  aiIn.placeholder = '✦ 说一句人话（如：都具象化）';
  aiIn.value = aiDraft;
  aiIn.addEventListener('input', () => { aiDraft = aiIn.value; });
  aiIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runCmdbarFromSel(aiDraft.trim()); }
  });
  bar.appendChild(aiIn);
  const aiBtn = el('button', 'tool-btn', '预览');
  aiBtn.title = '按指令对选中格出改写预览（零写入 · 先过目再应用）';
  aiBtn.addEventListener('click', () => runCmdbarFromSel(aiDraft.trim()));
  bar.appendChild(aiBtn);
  const xx = el('button', 'tool-btn', '✕');
  xx.title = '取消选择（Esc）';
  xx.addEventListener('click', () => clearSel());
  bar.appendChild(xx);

  const s = current();
  if (s) updateCount(s);
}

// —— 批量设值·域选择（M5 批2c）：'b:' 节拍 / 's:' 场景 / 裸键=镜头 ——
function pickField() {
  if (!pick.field) return null;
  if (pick.field.indexOf('b:') === 0) { const k = pick.field.slice(2); return { dom: 'beats', key: k, f: fieldOf(k, 'beats') }; }
  if (pick.field.indexOf('s:') === 0) { const k = pick.field.slice(2); return { dom: 'scenes', key: k, f: fieldOf(k, 'scenes') }; }
  return { dom: 'shots', key: pick.field, f: fieldOf(pick.field) };
}

function applyTargetText(pf) {
  const rc0 = rectOf();
  if (pf.dom === 'beats') return selBeatIds().length + ' 个节拍';
  if (pf.dom === 'scenes') return '本场';
  return (rc0 ? rc0.r2 - rc0.r1 + 1 : 0) + ' 镜';
}

function applyPicked(pf, v, f) {
  const label = '批量设值 · ' + f.label;
  if (pf.dom === 'beats') applyBeatFieldValue(pf.key, v, label);
  else if (pf.dom === 'scenes') applySceneFieldValue(pf.key, v, label);
  else applyFieldValue(pf.key, v, label);
}
