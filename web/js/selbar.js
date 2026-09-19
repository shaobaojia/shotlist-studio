// 表底选区条（M2-4）：选区出现时浮出——计数 / 批量设值（枚举走菜单、文本走输入）/ 复制 / 清空。
import { state } from './state.js';
import { el } from './ui.js';
import { openMenu } from './menu.js';
import { onChange, current, clearSel, rectOf, copySelectionTSV, clearSelectionCells, applyFieldValue } from './selection.js';
import { deleteSelectedRows } from './cellmenu.js';

// 可批量设值的字段（枚举优先排前；镜号/景深/虚拟列不进）
const BATCH_KEYS = ['camera_pos', 'shot_size', 'focal', 'shot_fn', 'camera_move', 'spatial', 'blocking', 'dialogue', 'duration', 'audio', 'director_note', 'pov'];
const CLEAR = '（清空）';

let bar = null;
let countEl = null;
let delBtn = null;
let pick = { field: null, value: null };
let sig = '';

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
    const f = state.meta.shot_fields.find((x) => x.key === s.cols[rc.c1]);
    countEl.textContent = '已选 ' + m + ' 镜 · ' + (f ? f.label : s.cols[rc.c1]);
  } else {
    countEl.textContent = '已选 ' + (m * colsN) + ' 格 · ' + m + ' 镜 · ' + colsN + ' 列';
  }
  if (delBtn) delBtn.textContent = '删除行（' + m + '）';
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
  const f = state.meta.shot_fields.find((x) => x.key === pick.field) || null;

  const fbtn = el('button', 'tool-btn', f ? f.label : '设值…');
  fbtn.title = '选择要批量设置的字段';
  fbtn.addEventListener('click', () => {
    const items = BATCH_KEYS.map((k) => {
      const ff = state.meta.shot_fields.find((x) => x.key === k);
      return ff ? { key: k, label: ff.label, current: k === pick.field } : null;
    }).filter(Boolean);
    openMenu(fbtn, items, (k) => {
      pick = { field: k, value: null };
      build();
    });
  });
  mid.appendChild(fbtn);

  if (f) {
    if (f.options && f.options.length) {
      const vbtn = el('button', 'tool-btn', pick.value == null ? '值…' : (pick.value === '' ? CLEAR : pick.value));
      vbtn.title = '选值（拾取即套用）';
      vbtn.addEventListener('click', () => {
        const items = f.options.map((o) => ({ key: o, label: o, current: o === pick.value }))
          .concat([{ sep: true }, { key: '', label: CLEAR, current: pick.value === '' }]);
        openMenu(vbtn, items, (v) => {
          pick.value = v;
          build();
          applyFieldValue(f.key, v, '批量设值 · ' + f.label);
        });
      });
      mid.appendChild(vbtn);
    } else {
      const rc0 = rectOf();
      const inp = document.createElement('input');
      inp.className = 'sbar-input';
      inp.placeholder = '值…（回车套到 ' + (rc0 ? rc0.r2 - rc0.r1 + 1 : 0) + ' 镜）';
      inp.value = pick.value == null ? '' : pick.value;
      inp.addEventListener('input', () => { pick.value = inp.value; });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          pick.value = inp.value;
          sig = JSON.stringify([pick.field, pick.value]);
          applyFieldValue(f.key, pick.value, '批量设值 · ' + f.label);
        }
      });
      mid.appendChild(inp);
      mid.appendChild(el('span', 'sbar-hint', '回车套用'));
    }
  } else {
    mid.appendChild(el('span', 'sbar-hint', '先选字段，再设值'));
  }

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
  const xx = el('button', 'tool-btn', '✕');
  xx.title = '取消选择（Esc）';
  xx.addEventListener('click', () => clearSel());
  bar.appendChild(xx);

  const s = current();
  if (s) updateCount(s);
}
