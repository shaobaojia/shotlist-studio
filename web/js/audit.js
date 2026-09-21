// 审计（M4a-2）：状态拉取 / 轮询 / 灯 / 问题卡 / 动作（去改·重检·豁免）。
// 面板在 auditpanel.js，设置在 auditset.js。约定：灯只锚「未处理」；重绘后 decorate 幂等重建。
// 灯：绝对定位钉在载体左缘（镜头行 / 节拍头 / 场签 / 行接缝），不占列、不改列宽、不参与排序框选。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { refreshHistoryIfOpen } from './history.js';

const FIELD_HINT = { '景别完整': 'shot_size', '声音完整性': 'audio',
  '动作具象化': 'blocking', '空间一致性': 'spatial', '机位一致性': 'camera_pos' };

let ctx = null;        // { getData, refresh }
let cur = null;        // { sceneId, issues, counts, job, rules }
let fetchedAt = 0;
let pollTimer = null;
let openKey = null;    // 'carrier:target' 当前展开的问题卡

export function initAudit(c) { ctx = c; }
export function getState() { return cur; }
export function getData() { return ctx && ctx.getData(); }

export function onPainted(data) {
  if (!data || !data.scene) return;
  const changed = !cur || cur.sceneId !== data.scene.id;
  if (changed) { cur = null; openKey = null; }
  decorate(data);
  fetchState(data.scene.id, changed);   // 换场强制重拉（限流闸门不得吃掉换场那一次）
}

function fetchState(sid, force) {
  const now = Date.now();
  if (!force && now - fetchedAt < 2500) return Promise.resolve();
  fetchedAt = now;
  return api.audit(sid).then((res) => {
    const d = ctx && ctx.getData();
    if (!d || d.scene.id !== sid) return;
    cur = { sceneId: sid, issues: res.issues || [], counts: res.counts || { open: 0, fixed: 0, waived: 0 },
            job: res.job || null, rules: res.rules || [] };
    decorate(d);
    notify();
    if (cur.job && cur.job.running) startPoll();
  }).catch(() => {});
}

function notify() { window.dispatchEvent(new CustomEvent('shotlist:audit-changed')); }

// ── 灯 ──
function splitKey(k) { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; }
function shotIdOf(carrier, target) { return carrier === 'seam' ? String(target).split('>')[0] : String(target); }

function findAnchor(carrier, target, data) {
  if (carrier === 'scene') return document.querySelector('.scene-freeze .scene-head') || document.querySelector('.scene-head');
  if (carrier === 'beat') {
    const sec = document.querySelector('section.beat[data-beat-id="' + target + '"]');
    return sec ? sec.querySelector('.beat-head') : null;
  }
  const row = document.querySelector('tr.shot[data-id="' + shotIdOf(carrier, target) + '"]');
  return row ? row.querySelector('td.cell-toggle') : null;
}

function decorate(data) {
  document.querySelectorAll('.audit-lamp').forEach((n) => n.remove());
  document.querySelectorAll('tr.audit-card-tr').forEach((n) => n.remove());
  document.querySelectorAll('.audit-card').forEach((n) => n.remove());
  document.querySelectorAll('tr.shot.has-lamp').forEach((n) => n.classList.remove('has-lamp'));
  if (!cur || cur.sceneId !== data.scene.id) { openKey = null; return; }
  const by = {};
  for (const i of cur.issues) {
    if (i.status !== 'open') continue;
    const k = i.carrier + ':' + i.target_id;
    (by[k] = by[k] || []).push(i);
  }
  for (const k of Object.keys(by)) {
    const [carrier, target] = splitKey(k);
    const anchor = findAnchor(carrier, target, data);
    if (!anchor) continue;
    anchor.appendChild(buildLamp(k, by[k].length, by[k][0].message || ''));
    const tr = anchor.closest('tr.shot');
    if (tr) tr.classList.add('has-lamp');
  }
  if (openKey && !openCard(openKey, data, true)) openKey = null;
}

function buildLamp(key, count, msg) {
  const [carrier] = splitKey(key);
  const lamp = el('span', 'audit-lamp' + (carrier === 'seam' ? ' seam' : ''));
  lamp.dataset.key = key;
  lamp.title = msg || '审计问题（点击查看）';
  if (count > 1) lamp.appendChild(el('i', 'lamp-n', String(count)));
  const stop = (e) => e.stopPropagation();
  lamp.addEventListener('mousedown', stop);
  lamp.addEventListener('pointerdown', stop);
  lamp.addEventListener('dblclick', stop);
  lamp.addEventListener('click', (e) => {
    e.stopPropagation();
    const d = getData();
    if (!d) return;
    if (openKey === key) closeCard();
    else openCard(key, d);
  });
  return lamp;
}

// ── 问题卡（行下就地展开 / 节拍头下 / 场头下）──
export function closeCard() {
  document.querySelectorAll('tr.audit-card-tr').forEach((n) => n.remove());
  document.querySelectorAll('.audit-card').forEach((n) => n.remove());
  openKey = null;
  notify();
}

function openCard(key, data, silent) {
  document.querySelectorAll('tr.audit-card-tr').forEach((n) => n.remove());
  document.querySelectorAll('.audit-card').forEach((n) => n.remove());
  const [carrier, target] = splitKey(key);
  const list = (cur ? cur.issues : []).filter(
    (i) => i.carrier === carrier && String(i.target_id) === String(target));
  if (!list.length) { openKey = null; return false; }
  const card = buildCard(carrier, target, list, data);
  let host = null;
  if (carrier === 'scene') {
    const head = findAnchor(carrier, target, data);
    if (head) { head.parentNode.insertBefore(card, head.nextSibling); host = card; }
  } else if (carrier === 'beat') {
    const head = findAnchor(carrier, target, data);
    const sec = head && head.closest('section.beat');
    if (head && sec) { sec.insertBefore(card, head.nextSibling); host = card; }
    else {   // 平铺视图：挂在该节拍第一镜行下
      const b = (data.beats || []).find((x) => String(x.id) === String(target));
      const first = b && b.shots && b.shots[0];
      const row = first && document.querySelector('tr.shot[data-id="' + first.id + '"]');
      if (row) host = insertCardTr(row, card);
    }
  } else {
    const row = document.querySelector('tr.shot[data-id="' + shotIdOf(carrier, target) + '"]');
    if (row && row.style.display === 'none') { toast('该行被筛选隐藏了'); return false; }
    if (row) host = insertCardTr(row, card);
  }
  if (!host) { openKey = null; return false; }
  openKey = key;
  if (carrier === 'scene') window.dispatchEvent(new Event('resize'));   // 吸顶区高度重算
  if (!silent) notify();
  return true;
}

function insertCardTr(row, card) {
  const tr = el('tr', 'audit-card-tr');
  const td = document.createElement('td');
  const table = row.closest('table');
  td.colSpan = table ? table.querySelectorAll('colgroup col').length : 99;
  td.appendChild(card);
  tr.appendChild(td);
  let anchorRow = row;
  const nxt = row.nextElementSibling;
  if (nxt && nxt.classList && nxt.classList.contains('detail')) anchorRow = nxt;
  anchorRow.parentNode.insertBefore(tr, anchorRow.nextSibling);
  return tr;
}

function buildCard(carrier, target, list, data) {
  const card = el('div', 'audit-card');
  const head = el('div', 'ac-head');
  head.appendChild(el('b', null, '审计 · ' + carrierText(carrier, target, data)));
  head.appendChild(el('span', 'sp'));
  const x = el('button', 'qbtn', '✕');
  x.title = '收起';
  x.addEventListener('click', (e) => { e.stopPropagation(); closeCard(); });
  head.appendChild(x);
  card.appendChild(head);
  for (const i of list) card.appendChild(issueRow(i, data));
  card.appendChild(el('div', 'ac-foot', '灯＝待处理：修好或豁免后自动熄灭，记录留在清单'));
  return card;
}

function issueRow(i, data) {
  const row = el('div', 'ac-item' + (i.status === 'fixed' ? ' done' : '') + (i.status === 'waived' ? ' waived' : ''));
  row.appendChild(el('span', 'rule-chip' + (i.kind === 'llm' ? ' llm' : ''), i.rule_title));
  const txt = el('div', 'ac-txt');
  txt.appendChild(document.createTextNode(i.message || ''));
  if (i.status === 'waived') txt.appendChild(el('span', 'ac-note', '（已豁免' + (i.waive_note ? '：' + i.waive_note : '') + '）'));
  if (i.status === 'fixed') txt.appendChild(el('span', 'ac-note', '（已修 · 重跑若再现会重新点亮）'));
  row.appendChild(txt);
  const acts = el('div', 'ac-acts');
  if (i.status === 'open') {
    acts.appendChild(qb('去改', () => goEdit(i, data)));
    acts.appendChild(qb('重检', () => recheckIssue(i)));
    acts.appendChild(qb('豁免', () => doWaive(i)));
  } else if (i.status === 'waived') {
    acts.appendChild(qb('取消豁免', () => doUnwaive(i)));
    acts.appendChild(qb(i.waive_note ? '改理由' : '加理由', () => editWaiveNote(i, row)));
  }
  row.appendChild(acts);
  return row;
}

function qb(label, fn, primary) {
  const b = el('button', 'qbtn' + (primary ? ' primary' : ''), label);
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

// ── 动作 ──
export function jumpToIssue(issue, opts) {
  const data = getData();
  if (!data) return null;
  const key = issue.carrier + ':' + issue.target_id;
  const [carrier, target] = splitKey(key);
  let node = null, row = null;
  if (carrier === 'scene') {
    node = document.querySelector('.scene-freeze .scene-head') || document.querySelector('.scene-head');
  } else if (carrier === 'beat') {
    node = document.querySelector('section.beat[data-beat-id="' + target + '"]');
    if (!node) {
      const b = (data.beats || []).find((x) => String(x.id) === String(target));
      const first = b && b.shots && b.shots[0];
      row = first && document.querySelector('tr.shot[data-id="' + first.id + '"]');
      node = row;
    }
  } else {
    row = document.querySelector('tr.shot[data-id="' + shotIdOf(carrier, target) + '"]');
    if (row && row.style.display === 'none') { toast('该处被筛选隐藏了'); return null; }
    node = row;
  }
  if (node) flash(node);
  if (!(opts && opts.noCard)) openCard(key, data);
  if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return { carrier, target, row };
}

function flash(node) {
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
}

function goEdit(i, data) {
  const res = jumpToIssue(i, { noCard: true });
  closeCard();
  if (!res) return;
  const field = FIELD_HINT[i.rule_title];
  if (res.carrier === 'shot' && field) {
    setTimeout(() => {
      const td = document.querySelector('tr.shot[data-id="' + res.target + '"] td[data-field="' + field + '"]');
      if (td) td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      else toast('该列已隐藏——「场务 → 列设置」打开后可直接点格编辑');
    }, 320);
  } else if (res.carrier === 'beat') {
    setTimeout(() => {
      const act = document.querySelector('section.beat[data-beat-id="' + res.target + '"] .beat-action');
      if (act) act.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }, 320);
  }
}

export async function runAudit() {
  const data = getData();
  if (!data) return;
  try {
    const res = await api.auditRun(data.scene.id);
    if (cur && cur.sceneId === data.scene.id) cur.job = res.job;
    else cur = { sceneId: data.scene.id, issues: [], counts: { open: 0, fixed: 0, waived: 0 }, job: res.job, rules: [] };
    notify();
    startPoll();
    toast('审计已开始（按设置跑）');
  } catch (err) { toast('启动失败：' + err.message, 'err'); }
}

export async function recheckIssue(i) {
  try {
    const res = await api.auditIssue({ id: i.id, action: 'recheck' });
    if (cur && res.job) cur.job = res.job;
    notify();
    startPoll();
    toast('重检中：' + i.rule_title + ' …');
  } catch (err) { toast('重检失败：' + err.message, 'err'); }
}

async function doWaive(i) {
  try {
    const res = await api.auditIssue({ id: i.id, action: 'waive' });
    applyIssues(res);
    toast('已豁免（灯已熄灭）');
  } catch (err) { toast('豁免失败：' + err.message, 'err'); }
}

async function doUnwaive(i) {
  try {
    const res = await api.auditIssue({ id: i.id, action: 'unwaive' });
    applyIssues(res);
    toast('已取消豁免');
  } catch (err) { toast('操作失败：' + err.message, 'err'); }
}

function editWaiveNote(i, rowEl) {
  const acts = rowEl.querySelector('.ac-acts');
  acts.textContent = '';
  const inp = document.createElement('input');
  inp.className = 'ac-note-inp';
  inp.placeholder = '豁免理由（选填）';
  inp.value = i.waive_note || '';
  const cancel = () => {
    const d = getData();
    if (d && openKey) openCard(openKey, d, true);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
  acts.appendChild(inp);
  const ok = qb('确认', async () => {
    if (!inp.value.trim()) { cancel(); return; }
    try {
      const res = await api.auditIssue({ id: i.id, action: 'waive', note: inp.value });
      applyIssues(res);
      toast('理由已留痕');
    } catch (err) { toast('保存失败：' + err.message, 'err'); }
  });
  acts.appendChild(ok);
  acts.appendChild(qb('✕', cancel));
  inp.focus();
}

function applyIssues(res) {
  if (!cur) return;
  cur.issues = res.issues || [];
  cur.counts = res.counts || cur.counts;
  const data = ctx && ctx.getData();
  if (data) decorate(data);
  notify();
  refreshHistoryIfOpen();
}

// ── 轮询 ──
function startPoll() { if (!pollTimer) { pollTimer = setInterval(tick, 2000); tick(); } }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function tick() {
  if (!cur) return stopPoll();
  const data = ctx && ctx.getData();
  if (!data || data.scene.id !== cur.sceneId) return stopPoll();
  const sid = cur.sceneId;
  try {
    const res = await api.audit(sid);
    if (!cur || cur.sceneId !== sid) return stopPoll();
    const wasRunning = !!(cur.job && cur.job.running);
    cur.job = res.job || null;
    cur.issues = res.issues || [];
    cur.counts = res.counts || cur.counts;
    cur.rules = res.rules || cur.rules;
    const d = ctx && ctx.getData();
    if (!d || d.scene.id !== sid) return stopPoll();
    if (cur.job && cur.job.running) {
      notify();
    } else {
      stopPoll();
      decorate(d);
      notify();
      if (wasRunning) onDone(cur.job);
    }
  } catch (err) { /* 网络抖动：下一拍再试 */ }
}

function onDone(job) {
  if (job && job.error) { toast('审计失败：' + job.error, 'err'); return; }
  const n = (cur && cur.counts && cur.counts.open) || 0;
  toast(n > 0 ? ('审计完成：' + n + ' 处问题已亮灯（点灯处理）') : '审计完成：没有未处理的问题');
}

// ── 共用小工具 ──
export function carrierText(carrier, target, data) {
  if (carrier === 'scene') return '本场';
  if (carrier === 'beat') {
    const b = ((data && data.beats) || []).find((x) => String(x.id) === String(target));
    return '节拍' + (b && b.beat_no != null ? ' ' + b.beat_no : '');
  }
  const m = {};
  if (data) {
    for (const b of data.beats || []) for (const s of b.shots || []) m[s.id] = s.shot_no;
    for (const s of data.orphan_shots || []) m[s.id] = s.shot_no;
  }
  const [a, b2] = String(target).split('>');
  if (carrier === 'seam') return '镜 ' + (m[a] || a) + ' → ' + (m[b2] || b2);
  return '镜 ' + (m[target] || target);
}
