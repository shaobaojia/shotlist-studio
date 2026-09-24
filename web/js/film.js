import { state, fieldsOf } from './state.js';
import { hashOf } from './route.js';
import { el, fmt } from './ui.js';
import { buildGrid } from './grid.js';

// 列定义由字段字典派生（F1-L3：scene_fields 单源）；arc/size 为派生列（计算列，值由渲染特判）。
// 列序规则：字典 in_table 序 + 「弧线」紧随「价值」+ 「规模」置尾——与老 COLS 串一一对应。
let COLS = null;
function colsOf() {
  if (COLS) return COLS;
  const base = fieldsOf('scenes').filter((f) => f.in_table).map((f) => [f.key, f.label, f.w]);
  const out = [];
  for (const c of base) {
    out.push(c);
    if (c[0] === 'value') out.push(['arc', '弧线', 170]);
  }
  out.push(['size', '规模', 110]);
  COLS = out;
  return COLS;
}

export function renderFilm(view) {
  view.textContent = '';
  const head = el('div', 'scene-head');
  head.appendChild(el('h1', 'scene-title', '全片价值弧线'));
  head.appendChild(el('div', 'scene-meta hint', '点击场次进入场级分镜表；空场为已登记、待创作。'));
  view.appendChild(head);

  const wrap = el('div', 'table-wrap');
  const t = el('table', 'shots scenes');
  const cols = colsOf();
  const { cg, sum } = buildGrid(cols.map(([, , w]) => ({ w })));   // F1-L1：骨架单点
  t.appendChild(cg);
  t.style.minWidth = sum + 'px';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const [, label] of cols) htr.appendChild(el('th', null, label));
  thead.appendChild(htr);
  t.appendChild(thead);

  const tb = document.createElement('tbody');
  for (const sc of state.scenes) {
    const tr = el('tr', 'link');
    if (!sc.shot_count) tr.classList.add('dim');
    // 按键取值（F1-W18：键即契约；弧线/规模为派生列；COLS 完全派生随 L3）
    for (const [key] of cols) {
      const td = el('td');
      const v = key === 'arc' ? [sc.pole_start, sc.pole_end].filter(Boolean).join(' → ')
        : key === 'size' ? ((sc.shot_count || 0) + ' 镜 / ' + (sc.beat_count || 0) + ' 节拍')
        : sc[key];
      td.textContent = fmt(v);
      td.title = td.textContent;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => { location.hash = hashOf(sc.scene_no); });
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  view.appendChild(wrap);
}
