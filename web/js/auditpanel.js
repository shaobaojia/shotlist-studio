// 问题清单浮卡（M4a-2）：状态分组 / 搜索 / 跑审计 / 进度 / 设置入口。做派对「痕迹回看」。
// 数据源：audit.js 的缓存状态（经 'shotlist:audit-changed' 事件同步刷新）。
import { el } from './ui.js';
import * as audit from './audit.js';
import { openAuditSettings } from './auditset.js';

let panel = null, listEl = null, statsEl = null, inputEl = null, runBtn = null, errEl = null;
let btn = null;   // 工具排「审计」按钮

export function bindAuditBtn(b) { btn = b; renderBtn(); }

export function toggleAuditPanel() {
  if (panel && !panel.hidden) { panel.hidden = true; return; }
  openPanel();
}
export function closeAuditPanel() { if (panel) panel.hidden = true; }

function openPanel() {
  if (!panel) build();
  panel.hidden = false;
  render();
}

window.addEventListener('shotlist:audit-changed', () => {
  renderBtn();
  if (panel && !panel.hidden) render();
});

function build() {
  panel = el('div');
  panel.id = 'audit-panel';
  panel.hidden = true;

  const head = el('div', 'ap-head');
  head.appendChild(el('b', null, '审计问题'));
  inputEl = document.createElement('input');
  inputEl.className = 'ap-search';
  inputEl.placeholder = '搜索规则 / 内容 / 位置…';
  inputEl.addEventListener('input', render);
  head.appendChild(inputEl);
  runBtn = el('button', 'tool-btn small ap-run', '跑审计');
  runBtn.title = '按审计设置跑全部启用规则（后台执行，可继续编辑）';
  runBtn.addEventListener('click', () => audit.runAudit());
  head.appendChild(runBtn);
  const set = el('button', 'tool-btn small', '⚙');
  set.title = '审计设置（规则开关 / 参数 / AI 通道）';
  set.addEventListener('click', openAuditSettings);
  head.appendChild(set);
  const x = el('button', 'tool-btn small', '✕');
  x.addEventListener('click', closeAuditPanel);
  head.appendChild(x);
  panel.appendChild(head);

  statsEl = el('div', 'ap-stat');
  panel.appendChild(statsEl);
  errEl = el('div', 'ap-err');
  errEl.hidden = true;
  panel.appendChild(errEl);
  listEl = el('div', 'ap-list');
  panel.appendChild(listEl);
  document.body.appendChild(panel);
}

function doneCount(job) { return job.rules.filter((r) => r.state === 'done' || r.state === 'error').length; }

function renderBtn() {
  if (!btn) return;
  const st = audit.getState();
  const job = st && st.job;
  if (job && job.running) {
    btn.textContent = '审计中 ' + doneCount(job) + '/' + job.rules.length;
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

  if (job && job.running) {
    const running = job.rules.filter((r) => r.state === 'running').map((r) => r.title).join('、');
    statsEl.textContent = '审计中 ' + doneCount(job) + '/' + job.rules.length + (running ? '（' + running + '）' : '');
    statsEl.classList.add('busy');
    runBtn.disabled = true;
    runBtn.textContent = '审计中…';
  } else {
    const c = (st && st.counts) || { open: 0, fixed: 0, waived: 0 };
    statsEl.textContent = '未处理 ' + c.open + ' · 已修 ' + c.fixed + ' · 豁免 ' + c.waived;
    statsEl.classList.remove('busy');
    runBtn.disabled = false;
    runBtn.textContent = '跑审计';
  }

  const errs = job ? job.rules.filter((r) => r.state === 'error') : [];
  errEl.hidden = !errs.length;
  if (errs.length) errEl.textContent = '⚠ ' + errs.map((r) => r.title + '：' + (r.error || '失败')).join('；');

  listEl.textContent = '';
  if (!st) { listEl.appendChild(el('div', 'ap-empty', '加载中…')); return; }
  const issues = st.issues || [];
  const q = (inputEl.value || '').trim();
  const shown = issues.filter((i) => {
    if (!q) return true;
    const hay = i.rule_title + ' ' + (i.message || '') + ' ' +
      audit.carrierText(i.carrier, i.target_id, data) + ' ' + (i.waive_note || '');
    return hay.indexOf(q) !== -1;
  });
  if (!shown.length) {
    listEl.appendChild(el('div', 'ap-empty', q ? '（没有匹配的问题）' : '暂无问题——点「跑审计」开跑'));
    return;
  }
  listEl.appendChild(el('div', 'ap-hint', '点条目 → 跳到该处并展开问题卡（去改 · 重检 · 豁免）'));
  const groups = [['open', '未处理'], ['fixed', '已修'], ['waived', '豁免']];
  for (const pair of groups) {
    const items = shown.filter((i) => i.status === pair[0]);
    if (!items.length) continue;
    listEl.appendChild(el('div', 'ap-grp', pair[1] + ' · ' + items.length));
    for (const i of items) listEl.appendChild(item(i, data));
  }
}

function item(i, data) {
  const d = el('div', 'ap-item' + (i.status !== 'open' ? ' done' : ''));
  d.dataset.issueId = i.id;
  d.appendChild(el('span', 'ap-dot' + (i.kind === 'llm' ? ' llm' : '')));
  d.appendChild(el('span', 'ap-tag', audit.carrierText(i.carrier, i.target_id, data)));
  const t = el('div', 'ap-t');
  t.appendChild(el('b', 'ap-rule', i.rule_title));
  t.appendChild(document.createTextNode('　' + (i.message || '')));
  if (i.status === 'waived' && i.waive_note) t.appendChild(el('span', 'ap-note', '豁免理由：' + i.waive_note));
  d.appendChild(t);
  d.appendChild(el('span', 'ap-time', String(i.updated_at || '').slice(5, 16)));
  d.title = '点击跳到该处并展开问题卡';
  d.addEventListener('click', () => {
    const res = audit.jumpToIssue(i, {});
    if (!res) return;
    listEl.querySelectorAll('.ap-item.active').forEach((n) => n.classList.remove('active'));
    d.classList.add('active');
  });
  return d;
}
