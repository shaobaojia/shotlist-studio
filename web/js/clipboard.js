// 剪贴板（M2-3）：复制（execCommand 兜底——局域网 http 下 navigator.clipboard 不可用）
// + TSV 解析/序列化 + Excel 式块粘贴（1×1 写单格；N×M 从锚格向右下铺）。
import { api } from './api.js';
import { toast } from './ui.js';
import { isRowVisible } from './filter.js';
import { refreshShotCell } from './table.js';
import { batchWrite } from './selection.js';   // P1③：运行时调用；与 selection→clipboard 的复制方向互引，无顶层求值，ESM 安全

export function writeClipboard(text) {
  return new Promise((resolve) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => resolve(true),
        () => resolve(fallbackCopy(text)));
    } else {
      resolve(fallbackCopy(text));
    }
  });
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

// TSV 解析：支持 "..." 引号包裹（内可含 \t \n，"" 转义）
export function parseTSV(text) {
  let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (!s) return [];
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQ = false;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { inQ = true; i++; continue; }
    if (c === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

export function toTSV(rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(esc).join('\t')).join('\n');
}

// 当前表（当前表头顺序）的可写字段 key 清单（WYSIWYG）
export function tableFieldKeys(table) {
  const tr = table.querySelector('tbody tr.shot');
  if (!tr) return [];
  const keys = [];
  tr.querySelectorAll('td').forEach((td) => {
    const m = /(?:^|\s)cell-([A-Za-z0-9_]+)(?:\s|$)/.exec(td.className || '');
    if (!m) return;
    const k = m[1];
    if (k === 'toggle' || k === 'beatref' || k === 'prompt') return;
    keys.push(k);
  });
  return keys;
}

// Excel 式块粘贴（F2-P1③）：写路径收编 selection.batchWrite（一步撤销 + 本地落定 + 活体广播 + 上限口径单点）。
// 「失败即停」经 opts.write 注入顺序写口保留。ctx: { getShot(id) }
// 循环引用说明：selection → clipboard（复制）为既有方向；本函数反向用 batchWrite，均为运行时调用、无顶层求值，ESM 安全。
export async function pasteBlock(anchor, text, ctx) {
  const block = parseTSV(text);
  if (!block.length) { toast('剪贴板没有内容'); return; }
  const table = anchor.td.closest('table');
  if (!table) return;
  const keys = tableFieldKeys(table);
  const col0 = keys.indexOf(anchor.field);
  if (col0 === -1) { toast('这个格子不支持粘贴'); return; }
  const trs = Array.from(table.querySelectorAll('tbody tr.shot')).filter(isRowVisible);
  const row0 = trs.indexOf(anchor.tr);
  if (row0 === -1) { toast('找不到粘贴起点'); return; }
  const jobs = [];
  const maxR = Math.min(block.length, trs.length - row0);
  for (let r = 0; r < maxR; r++) {
    for (let c = 0; c < block[r].length; c++) {
      const ki = col0 + c;
      if (ki >= keys.length) break;
      jobs.push({ id: Number(trs[row0 + r].dataset.id), field: keys[ki], value: block[r][c] });
    }
  }
  if (!jobs.length) { toast('没有可写入的格子'); return; }
  if (jobs.length > 400) { toast('一次最多粘贴 400 格（本次 ' + jobs.length + '）'); return; }
  const smap = new Map();                          // 一次建映射（P1⑤）：避免逐格线性查找
  for (const j of jobs) if (!smap.has(j.id)) smap.set(j.id, ctx.getShot(j.id));
  await batchWrite(jobs, '粘贴 ' + jobs.length + ' 格', {
    write: async (items) => {                      // 保留原「失败即停」语义
      const results = [];
      for (const o of items) {
        try {
          await api.update('shots', o.id, o.field, o.value);
          results.push({ id: o.id, field: o.field, changed: true });
        } catch (err) {
          results.push({ id: o.id, field: o.field, error: err.message });
          break;
        }
      }
      return { results: results };
    },
    domain: {
      resolve: (o) => smap.get(o.id) || null,
      refresh: (s, o) => refreshShotCell(s, o.field, table),   // 表作用域（P1⑤）
      verb: '粘贴', noun: '格',
    },
  });
}
