// 表底选区条（M2-4）：选区出现时浮出——计数 / 批量设值（枚举走菜单、文本走输入）/ 复制 / 清空。
// F2-W15 域单点：每域＝字段清单（服务端 batch 能力位派生，W14）+ 落值函数 + 菜单前缀 + 计数文案。
// F2-W13：字段变更才重建；值变更走局部同步（输入框焦点不再被重建吞掉）。
import { state, fieldOf, fieldsOf } from './state.js';
import { el } from './ui.js';
import { openMenu, optItems } from './menu.js';
import { onChange, current, clearSel, rectOf, copySelection, clearSelectionCells, applyFieldValue, applyBeatFieldValue, applySceneFieldValue, selBeatIds, selRowIds } from './selection.js';
import { deleteSelectedRows } from './cellmenu.js';
import { mergeShotsByIds, detachShotsByIds } from './hotbox.js';
import { runCmdbarFromSel } from './aiwrite.js';

const CLEAR = '（清空）';

// 域单点（F2-W15）
const DOMAINS = {
  shots: {
    table: 'shots', prefix: '', fbtn: '',
    count: () => { const rc = rectOf(); return (rc ? rc.r2 - rc.r1 + 1 : 0) + ' 镜'; },
    apply: (k, v, label) => applyFieldValue(k, v, label),
  },
  beats: {
    table: 'beats', prefix: 'b:', fbtn: '节拍·',
    count: () => selBeatIds().length + ' 个节拍',
    apply: (k, v, label) => applyBeatFieldValue(k, v, label),
  },
  scenes: {
    table: 'scenes', prefix: 's:', fbtn: '场景·',
    count: () => '本场',
    apply: (k, v, label) => applySceneFieldValue(k, v, label),
  },
};

// 可批量设值字段清单（F2-W14）：服务端 batch 能力位派生，不再前端手抄
function batchItems(dom) {
  return fieldsOf(dom.table).filter((f) => f.batch)
    .map((f) => ({ key: dom.prefix + f.key, label: f.label }));
}

let bar = null;
let countEl = null;
let delBtn = null;
let mergeBtn = null;
let vbtnRef = null;      // 值按钮（枚举域）
let vinRef = null;       // 值输入框（文本域）
let builtField = null;   // 已构建的字段（含域前缀）——值变化只做局部同步
let pick = { field: null, value: null };
let aiDraft = '';
let lastCount = null;    // 计数缓存（W13：同值不重写）
let lastMergeOff = null;

export function initSelBar() {
  onChange(onSel);
}

function onSel(s) {
  if (!s) {
    if (bar) bar.style.display = 'none';
    pick = { field: null, value: null };
    builtField = null;
    vbtnRef = null;
    vinRef = null;
    lastCount = null;
    lastMergeOff = null;
    return;
  }
  if (!bar || builtField !== pick.field) build();
  else syncValue();
  updateCount(s);
  bar.style.display = 'flex';
}

// 值变化局部同步（W13）：按钮文本 / 输入框值就地更新，不重建（编辑中焦点不丢）
function syncValue() {
  if (vbtnRef) {
    const t = pick.value == null ? '值…' : (pick.value === '' ? CLEAR : pick.value);
    if (vbtnRef.textContent !== t) vbtnRef.textContent = t;
  }
  if (vinRef && document.activeElement !== vinRef) {
    const t = pick.value == null ? '' : pick.value;
    if (vinRef.value !== t) vinRef.value = t;
  }
}

function updateCount(s) {
  if (!countEl) return;
  const rc = rectOf();
  if (!rc) return;
  const m = rc.r2 - rc.r1 + 1;
  const colsN = rc.c2 - rc.c1 + 1;
  let txt;
  if (colsN === 1) {
    const f = fieldOf(s.cols[rc.c1]);
    txt = '已选 ' + m + ' 镜 · ' + (f ? f.label : s.cols[rc.c1]);
  } else {
    txt = '已选 ' + (m * colsN) + ' 格 · ' + m + ' 镜 · ' + colsN + ' 列';
  }
  if (txt !== lastCount) {
    countEl.textContent = txt;
    lastCount = txt;
  }
  if (delBtn) {
    const dt = '删除行（' + m + '）';
    if (delBtn.textContent !== dt) delBtn.textContent = dt;
  }
  if (mergeBtn && lastMergeOff !== (m < 2)) {
    const off = m < 2;
    lastMergeOff = off;
    mergeBtn.disabled = off;
    mergeBtn.title = off ? '至少选 2 镜才能并为一组' : '把选中的镜头合并为一个提示词组（保留首组文本，可 Ctrl+Z）';
  }
}

function build() {
  if (!bar) {
    bar = el('div');
    bar.id = 'sel-bar';
    bar.style.display = 'none';
    document.body.appendChild(bar);
  }
  builtField = pick.field;
  lastCount = null;
  lastMergeOff = null;
  bar.textContent = '';
  countEl = el('span', 'sbar-count');
  bar.appendChild(countEl);

  const mid = el('span', 'sbar-mid');
  bar.appendChild(mid);
  const pf = pickField();
  const f = pf ? pf.f : null;
  const optsList = (pf && pf.dom.table === 'beats' && pf.key === 'kind')
    ? ((state.meta && state.meta.beat_kinds) || [])
    : (f && f.options && f.options.length ? f.options : null);

  const fbtn = el('button', 'tool-btn',
    f ? pf.dom.fbtn + f.label : '设值…');
  fbtn.title = '选择要批量设置的字段（镜头 / 节拍 / 场景）';
  fbtn.addEventListener('click', () => {
    const items = optItems(batchItems(DOMAINS.shots), pick.field);
    items.push({ sep: true }, { label: '— 节拍字段（套到所选行所在节拍）—', disabled: true });
    items.push.apply(items, optItems(batchItems(DOMAINS.beats), pick.field));
    items.push({ sep: true }, { label: '— 场景字段（套到本场）—', disabled: true });
    items.push.apply(items, optItems(batchItems(DOMAINS.scenes), pick.field));
    openMenu(fbtn, items, (k) => {
      pick = { field: k, value: null };
      build();
    });
  });
  mid.appendChild(fbtn);

  vbtnRef = null;
  vinRef = null;
  if (f) {
    if (optsList && optsList.length) {
      const vbtn = el('button', 'tool-btn', pick.value == null ? '值…' : (pick.value === '' ? CLEAR : pick.value));
      vbtnRef = vbtn;
      vbtn.title = '选值（拾取即套用）';
      vbtn.addEventListener('click', () => {
        const items = optItems(optsList, pick.value)
          .concat([{ sep: true }, { key: '', label: CLEAR, current: pick.value === '' }]);
        openMenu(vbtn, items, (v) => {
          pick.value = v;
          syncValue();
          applyPicked(pf, v, f);
        });
      });
      mid.appendChild(vbtn);
    } else {
      const inp = document.createElement('input');
      inp.className = 'sbar-input';
      inp.placeholder = '值…（回车' + (pf.dom === DOMAINS.scenes ? '套到本场' : '套到 ' + applyTargetText(pf)) + '）';
      inp.value = pick.value == null ? '' : pick.value;
      vinRef = inp;
      inp.addEventListener('input', () => { pick.value = inp.value; });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          pick.value = inp.value;
          applyPicked(pf, pick.value, f);     // W13：sig 手动补写退役（builtField 已就位）
        }
      });
      mid.appendChild(inp);
      mid.appendChild(el('span', 'sbar-hint', '回车套用'));
    }
  } else {
    mid.appendChild(el('span', 'sbar-hint', '先选字段，再设值'));
  }

  const gm = el('button', 'tool-btn', '并为一组');
  gm.addEventListener('click', () => mergeShotsByIds(selRowIds()));
  mergeBtn = gm;
  bar.appendChild(gm);
  const gh = el('button', 'tool-btn', '独立成组');
  gh.title = '选中的镜头各自拆成独立的提示词组（可 Ctrl+Z）';
  gh.addEventListener('click', () => detachShotsByIds(selRowIds()));
  bar.appendChild(gh);

  const cp = el('button', 'tool-btn', '复制');
  cp.title = '复制选区（TSV，可直接贴进 Excel）';
  cp.addEventListener('click', () => copySelection());
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

// —— 批量设值·域选择（M5 批2c / F2-W15 域化）：'b:' 节拍 / 's:' 场景 / 裸键=镜头 ——
function pickField() {
  if (!pick.field) return null;
  if (pick.field.indexOf('b:') === 0) { const k = pick.field.slice(2); return { dom: DOMAINS.beats, key: k, f: fieldOf(k, 'beats') }; }
  if (pick.field.indexOf('s:') === 0) { const k = pick.field.slice(2); return { dom: DOMAINS.scenes, key: k, f: fieldOf(k, 'scenes') }; }
  return { dom: DOMAINS.shots, key: pick.field, f: fieldOf(pick.field) };
}

function applyTargetText(pf) {
  return pf.dom.count(pf);
}

function applyPicked(pf, v, f) {
  const label = '批量设值 · ' + f.label;
  pf.dom.apply(pf.key, v, label);
}
