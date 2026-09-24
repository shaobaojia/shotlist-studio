import { el } from './ui.js';

// 表格骨架通用件（F1-L1）：colgroup 构建 + minWidth 同步单点。
// 来源：table.js 建表 / table.js 改宽重算 / film.js 自建 三处同构收一。
// 口径：sum = Σ(条目最终宽度)；调用方负责 widths[key]||f.w 之类的取值决策。

export function buildGrid(entries) {
  const cg = document.createElement('colgroup');
  let sum = 0;
  for (const e of entries) {
    const c = document.createElement('col');
    c.style.width = e.w + 'px';
    cg.appendChild(c);
    sum += e.w;
  }
  return { cg, sum };
}

export function syncMinWidth(t) {
  const cg = t.querySelector('colgroup');
  if (!cg) return;
  let sum = 0;
  for (const cc of cg.children) sum += parseFloat(cc.style.width) || 0;
  t.style.minWidth = sum + 'px';
}

export function applyColWidthTo(t, cols, key, w) {
  const cg = t.querySelector('colgroup');
  if (!cols || !cg) return;
  const idx = cols.findIndex((c) => c.key === key);
  if (idx === -1 || !cg.children[idx]) return;
  cg.children[idx].style.width = w + 'px';
  syncMinWidth(t);
}
