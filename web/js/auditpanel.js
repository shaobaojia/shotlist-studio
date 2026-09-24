// 问题清单浮卡（M4a-2）：状态分组 / 搜索 / 跑审计 / 进度 / 设置入口。做派对「痕迹回看」。
// 数据源：audit.js 的缓存状态（经 'shotlist:audit-changed' 事件同步刷新）。
import { el, stageText, fmtStamp } from './ui.js';
import * as audit from './audit.js';
import { openAuditSettings } from './auditset.js';
import { panelShell, floatEnter, floatLeave } from './float.js';

let panel = null, listEl = null, statsEl = null, inputEl = null, runBtn = null, errEl = null;
let btn = null;   // 工具排「审计」按钮

export function bindAuditBtn(b) { btn = b; renderBtn(); }

export function toggleAuditPanel() {
  if (panel && !panel.hidden) { panel.hidden = true; return; }
  openPanel();
}
export function closeAuditPanel() { if (panel) panel.hidden = true; floatLeave('panel', closeAuditPanel); }

function openPanel() {
  if (!panel) build();
  floatEnter('panel', closeAuditPanel);   // F5-P1③：入互斥注册表（原漏挂——设置卡 z=47 会盖 z=42 的清单）
  panel.hidden = false;
  render();
}

window.addEventListener('shotlist:audit-changed', () => {
  renderBtn();
  if (panel && !panel.hidden) render();
});

function build() {
  inputEl = document.createElement('input');
  inputEl.className = 'ap-search';
  inputEl.placeholder = '搜索规则 / 内容 / 位置…';
  inputEl.addEventListener('input', renderSoon);
  runBtn = el('button', 'tool-btn small ap-run', '跑审计');
  runBtn.title = '按审计设置跑全部启用规则（后台执行，可继续编辑）';
  runBtn.addEventListener('click', () => audit.runAudit());
  const set = el('button', 'tool-btn small', '⚙');
  set.title = '审计设置（规则开关 / 参数）';
  set.addEventListener('click', openAuditSettings);

  // 外壳基类（L6）：.float-card 补齐点外豁免（此前漏挂＝点面板清选区/收编辑面/关相机表单）
  const sh = panelShell({
    id: 'audit-panel', headCls: 'ap-head', title: '审计问题', noBody: true, onClose: closeAuditPanel,   // F4-W25：不建体显式化（原 bodyCls:null 双关）
    fillHead: (h) => { h.appendChild(inputEl); h.appendChild(runBtn); h.appendChild(set); },
  });
  panel = sh.card;
  panel.hidden = true;

  statsEl = el('div', 'ap-stat');
  panel.appendChild(statsEl);
  errEl = el('div', 'ap-err');
  errEl.hidden = true;
  panel.appendChild(errEl);
  listEl = el('div', 'ap-list');
  panel.appendChild(listEl);
  document.body.appendChild(panel);
}

// F5-W18：一次算完（done/running/errors/skipped——原三处各扫一遍）
function jobStats(job) {
  const out = { done: 0, total: 0, running: [], errors: [], skipped: [] };
  if (!job || !job.rules) return out;
  out.total = job.rules.length;
  for (const r of job.rules) {
    if (r.state === audit.STATE_DONE || r.state === audit.STATE_ERROR || r.state === audit.STATE_SKIPPED) out.done++;
    if (r.state === audit.STATE_RUNNING) out.running.push(r.title);
    if (r.state === audit.STATE_ERROR) out.errors.push(r);
    if (r.state === audit.STATE_SKIPPED) out.skipped.push(r.title);
  }
  return out;
}

function skipNote(s) {
  return s.skipped.length ? '跳过（无候选）：' + s.skipped.join('、') : '';
}

let _renT = 0;
function renderSoon() { clearTimeout(_renT); _renT = setTimeout(render, 120); }   // F5-P5③：搜索防抖

// F5-L4：清「本轮未复用」的 .ap-item（筛选隐藏/已消失——原全量重建天然清理）
function sweepItems(used) {
  for (const n of [...listEl.children]) {
    if (n.classList.contains('ap-item') && !used.has(n)) n.remove();
  }
}

function renderBtn() {
  if (!btn) return;
  const st = audit.getState();
  const job = st && st.job;
  if (job && job.running) {
    const s = jobStats(job);
    btn.textContent = '审计中 ' + s.done + '/' + s.total;
    btn.classList.add('busy');
    return;
  }
  btn.classList.remove('busy');
  btn.textContent = '';
  btn.appendChild(document.createTextNode('审计'));
  const open = st && st.counts ? st.counts.open : 0;
  if (open > 0) btn.appendChild(el('span', 'ab-num', String(open)));
}

function render() {
  if (!panel || panel.hidden) return;
  const st = audit.getState();
  const data = audit.getData();
  const job = st && st.job;

  const s = jobStats(job);
  if (job && job.running) {
    const sk = skipNote(s);
    statsEl.textContent = '审计中 ' + s.done + '/' + s.total + (s.running.length ? '（' + s.running.join('、') + '）' : '') + (sk ? ' · ' + sk : '');
    statsEl.classList.add('busy');
    runBtn.disabled = true;
    runBtn.textContent = '审计中…';
  } else {
    const c = (st && st.counts) || audit.EMPTY_COUNTS;
    const sk = skipNote(s);
    const orph = (st && st.orphan) ? ' · 孤儿 ' + st.orphan : '';   // P0·S2-W11：孤儿可观测（低调）
    statsEl.textContent = '未处理 ' + c.open + ' · 已修 ' + c.fixed + ' · 豁免 ' + c.waived + orph + (sk ? ' · ' + sk : '');
    statsEl.classList.remove('busy');
    runBtn.disabled = false;
    runBtn.textContent = '跑审计';
  }

  const errs = s.errors;
  errEl.hidden = !errs.length;
  if (errs.length) errEl.textContent = '⚠ ' + errs.map((r) => r.title + '：' + (r.error || '失败')).join('；');

  // F5-L4：清单按 issueId 差量——同 id 条目复用（sig 变才重建单条），仅序/组重排
  const pool = new Map();
  for (const n of listEl.querySelectorAll('.ap-item[data-issue-id]')) pool.set(String(n.dataset.issueId), n);
  for (const n of [...listEl.children]) if (!n.classList.contains('ap-item')) n.remove();
  const used = new Set();
  if (!st) { sweepItems(used); const d0 = el('div', 'ap-empty'); stageText(d0, 'loading'); listEl.appendChild(d0); return; }
  const issues = st.issues || [];
  const q = (inputEl.value || '').trim();
  const shown = issues.filter((i) => {
    if (!q) return true;
    const hay = i.rule_title + ' ' + (i.message || '') + ' ' +
      audit.carrierText(i.carrier, i.target_id, data) + ' ' + (i.waive_note || '');
    return hay.indexOf(q) !== -1;
  });
  if (!shown.length) {
    sweepItems(used);
    listEl.appendChild(el('div', 'ap-empty', q ? '（没有匹配的问题）' : '暂无问题——点「跑审计」开跑'));
    return;
  }
  listEl.appendChild(el('div', 'ap-hint', '点条目 → 跳到该处并展开问题卡（去改 · 重检 · 豁免）'));
  const bucket = { open: [], fixed: [], waived: [] };   // F5-P5③：一次分桶（原三趟 filter）
  for (const i of shown) { const b = bucket[i.status]; if (b) b.push(i); }
  const groups = [[audit.STATUS_OPEN, '未处理'], [audit.STATUS_FIXED, '已修'], [audit.STATUS_WAIVED, '豁免']];
  for (const pair of groups) {
    const items = bucket[pair[0]];
    if (!items.length) continue;
    listEl.appendChild(el('div', 'ap-grp', pair[1] + ' · ' + items.length));
    for (const i of items) {                         // F5-L4：池复用在位（appendChild 只做移动）
      const old = pool.get(String(i.id));
      const node = old ? updItem(old, i, data) : item(i, data);
      used.add(node);
      listEl.appendChild(node);
    }
  }
  sweepItems(used);
}

function sigOf(i, data) {   // F5-L4：条目签名（任一可显示面变即重建该条）
  return i.status + '|' + (i.updated_at || '') + '|' + (i.waive_note || '') + '|' + (i.message || '') + '|' + audit.carrierText(i.carrier, i.target_id, data);
}
function updItem(n, i, data) {
  const sig = sigOf(i, data);
  if (n.dataset.sig === sig) return n;               // 无变化：原节点（appendChild 仅移动）
  const fresh = item(i, data);
  n.replaceWith(fresh);
  return fresh;
}
function item(i, data) {
  const d = el('div', 'ap-item' + (i.status !== audit.STATUS_OPEN ? ' done' : ''));
  d.dataset.issueId = i.id;
  d.dataset.sig = sigOf(i, data);
  d.appendChild(el('span', audit.issueKindCls(i.kind, 'ap-dot')));   // F5-W17：种类类名单点
  d.appendChild(el('span', 'ap-tag', audit.carrierText(i.carrier, i.target_id, data)));
  const t = el('div', 'ap-t');
  t.appendChild(el('b', 'ap-rule', i.rule_title));
  t.appendChild(document.createTextNode('　' + (i.message || '')));
  if (i.status === audit.STATUS_WAIVED && i.waive_note) t.appendChild(el('span', 'ap-note', audit.waiveText(i)));   // F5-W17：文案单点
  d.appendChild(t);
  d.appendChild(el('span', 'ap-time', fmtStamp(i.updated_at, 'md-hm')));
  d.title = '点击跳到该处并展开问题卡';
  d.addEventListener('click', () => {
    const res = audit.jumpToIssue(i, {});
    if (!res) return;
    listEl.querySelectorAll('.ap-item.active').forEach((n) => n.classList.remove('active'));
    d.classList.add('active');
  });
  return d;
}
