// ⌘K 命令面板（M6 批6-1）：跳场次 / 镜号 / 命令（DESIGN §4.2）。
// 单点：场次取 state.scenes；镜头取当前视图 tr.shot（data-id + 格面文本）；
// 跳镜一律 filter.jumpToShotById（滚行+闪烁单点）；命令复用既有工具栏按钮（有则点，无则提示）。
import { el, toast } from './ui.js';
import { exportUrl, downloadUrl } from './api.js';
import { state } from './state.js';
import { sceneNo, hashOf } from './route.js';
import { jumpToShotById } from './filter.js';

let wrap = null, inputEl = null, listEl = null;
let items = [], sel = 0, isOpen = false;

const CMDS = [
  { key: 'film', label: '全片总览', alias: 'quanpian film 所有场次 总览', hint: '跳转', run: () => { location.hash = '#/'; } },
  { key: 'group', label: '切换到分组视图', alias: 'fenzu group 分组', hint: '视图', run: () => clickToolbar('分组') },
  { key: 'flat', label: '切换到平铺视图', alias: 'pingpu flat 平铺', hint: '视图', run: () => clickToolbar('平铺') },
  { key: 'script', label: '打开本场台本', alias: 'taiben script 台本 剧本', hint: '工具', run: () => clickToolbar('台本') },
  { key: 'audit', label: '跑审计（本场）', alias: 'shenji audit 审计 检查', hint: '工具', run: () => clickToolbar('审计') },
  { key: 'export-page', label: '导出本场 · 静态页', alias: 'daochu export 导出 分享 存档', hint: '导出', run: () => exportScene('page') },
  { key: 'export-print', label: '导出本场 · A4 打印版', alias: 'daochu export a4 打印 dayin 导出', hint: '导出', run: () => exportScene('print') },
];

function clickToolbar(text) {
  const btns = Array.from(document.querySelectorAll('#view .tool-btn, #view .seg-b'));
  const b = btns.find((x) => x.textContent.trim() === text);
  if (b && !b.disabled) { b.click(); return; }
  toast('当前视图没有「' + text + '」入口');
}

function exportScene(fmt) {
  const no = sceneNo();
  if (!no) { toast('先进入一个场，再导出'); return; }
  downloadUrl(exportUrl(no, fmt));   // 单点（F1-P7）：与场务菜单同口径
  toast(fmt === 'print' ? '正在导出 A4 打印版…' : '正在导出静态页…');
}

function rank(text, q) {
  const t = String(text == null ? '' : text).toLowerCase();
  if (!q) return 0;
  if (t === q) return 1;
  if (t.indexOf(q) === 0) return 2;
  if (t.indexOf(q) > 0) return 3;
  return 0;
}

function cellText(tr, key, firstLine) {
  const td = tr.querySelector('td[data-field="' + key + '"]');
  if (!td) return '';
  let t = (td.innerText || td.textContent || '').trim();
  if (firstLine) t = (t.split('\n')[0] || '').trim();
  return t;
}

function collect(q) {
  const ql = q.trim().toLowerCase();
  const cmds = [], scn = [], sht = [];
  for (const c of CMDS) {
    const r = ql ? Math.max(rank(c.label, ql), rank(c.alias, ql), rank(c.key, ql)) : 4;
    if (r) cmds.push({ group: '命令', label: c.label, hint: c.hint, run: c.run });
  }
  if (ql) {
    for (const sc of state.scenes || []) {
      const label = sc.scene_no + (sc.title ? ' ' + sc.title : '');
      const r = Math.max(rank(sc.scene_no, ql), rank(label, ql), rank(sc.title, ql));
      if (r) scn.push({ group: '场次', label, hint: '跳转', run: () => { location.hash = hashOf(sc.scene_no); } });
    }
    let n = 0;
    for (const tr of document.querySelectorAll('tr.shot[data-id]')) {
      const no = cellText(tr, 'shot_no');
      if (!no) continue;
      const short = no.replace(/^0+(?=\d)/, '');
      const r = Math.max(rank(no, ql), rank(short, ql), rank('镜' + short, ql));
      if (!r) continue;
      const size = cellText(tr, 'shot_size', true);
      const dur = cellText(tr, 'duration');
      const id = Number(tr.dataset.id);
      sht.push({
        group: '镜头',
        label: '镜 ' + no + (size ? ' · ' + size : '') + (dur ? ' · ' + dur : ''),
        hint: '跳镜',
        run: () => { if (!jumpToShotById(id)) toast('该镜不在当前视图（可能被筛选隐藏）'); },
      });
      if (++n >= 8) break;
    }
  }
  // 纯数字＝镜号意图：镜头排在场次前（防「03」被 s030 抢第一格）
  return /^\d{1,3}$/.test(ql) ? cmds.concat(sht, scn) : cmds.concat(scn, sht);
}

function render() {
  listEl.textContent = '';
  if (!items.length) {
    listEl.appendChild(el('div', 'cmdk-empty', inputEl.value.trim() ? '没有匹配项' : '输入可搜：场次 / 镜号 / 命令'));
    return;
  }
  let g = null;
  items.forEach((it, i) => {
    if (it.group !== g) { g = it.group; listEl.appendChild(el('div', 'cmdk-group', g)); }
    const row = el('div', 'cmdk-item' + (i === sel ? ' on' : ''));
    row.appendChild(el('span', 'cmdk-label', it.label));
    if (it.hint) row.appendChild(el('span', 'cmdk-hint', it.hint));
    row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; paint(); } });
    row.addEventListener('click', () => runAt(i));
    listEl.appendChild(row);
  });
}

function paint() {
  const rows = listEl.querySelectorAll('.cmdk-item');
  rows.forEach((r, i) => r.classList.toggle('on', i === sel));
  const on = rows[sel];
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

function move(d) {
  if (!items.length) return;
  sel = (sel + d + items.length) % items.length;
  paint();
}

function runAt(i) {
  const it = items[i];
  if (!it) return;
  closePalette();
  try { it.run(); } catch (err) { toast('执行失败：' + err.message, 'err'); }
}

function refresh() {
  items = collect(inputEl.value);
  sel = 0;
  render();
}

function ensure() {
  if (wrap) return;
  wrap = el('div', 'cmdk-mask');
  wrap.hidden = true;
  const card = el('div', 'cmdk');
  inputEl = document.createElement('input');
  inputEl.className = 'cmdk-input';
  inputEl.placeholder = '跳场次 / 镜号 / 命令…';
  inputEl.autocomplete = 'off';
  inputEl.addEventListener('input', refresh);
  listEl = el('div', 'cmdk-list');
  const foot = el('div', 'cmdk-foot', '↑↓ 选择 · Enter 执行 · Esc 关闭');
  card.appendChild(inputEl);
  card.appendChild(listEl);
  card.appendChild(foot);
  wrap.appendChild(card);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closePalette(); });
  document.body.appendChild(wrap);
}

export function openCmdK() {
  ensure();
  isOpen = true;
  wrap.hidden = false;
  inputEl.value = '';
  refresh();
  inputEl.focus();
}

export function closePalette() {
  if (!isOpen) return;
  isOpen = false;
  wrap.hidden = true;
}

export function bindCmdK() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) closePalette(); else openCmdK();
      return;
    }
    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runAt(sel); }
  }, true);
  const chip = document.querySelector('.cmdk-open');
  if (chip) chip.addEventListener('click', () => { if (isOpen) closePalette(); else openCmdK(); });
}
