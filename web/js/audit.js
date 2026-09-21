// 审计（M4a-2）：状态拉取 / 轮询 / 灯 / 问题卡 / 动作（去改·重检·豁免）。
// 面板在 auditpanel.js，设置在 auditset.js。约定：灯只锚「未处理」；重绘后 decorate 幂等重建。
// 灯：绝对定位钉在载体左缘（镜头行 / 节拍头 / 场签 / 行接缝），不占列、不改列宽、不参与排序框选。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { refreshHistoryIfOpen } from './history.js';

const FIELD_HINT = { '景别完整': 'shot_size', '声音完整性': 'audio',
  '动作具象化': 'blocking', '空间一致性': 'spatial', '机位一致性': 'camera_pos' };

let ctx = null;        // { getData, refresh }
let cur = null;        // { sceneId, issues, counts, job }
let fetchedAt = 0;
let pollTimer = null;
let openKey = null;    // 'carrier:target' 当前展开的问题卡
let seq = 0;           // 读序号：在飞读取遇更新的读/本地写即作废（M5 乱序覆盖）
let inFlight = false;  // 轮询单飞（上一拍未回不叠发）
let lastKey = '';      // 状态指纹：无变化不 notify（省徽标/清单重刷）

export function initAudit(c) { ctx = c; }
export function getState() { return cur; }
export function getData() { return ctx && ctx.getData(); }

export function onPainted(data) {
  if (!data || !data.scene) return;
  const changed = !cur || cur.sceneId !== data.scene.id;
  if (changed) { cur = null; openKey = null; lastKey = ''; stopPoll(); }   // 换场即停旧轮询
  decorate(data);
  fetchState(data.scene.id, changed);   // 换场强制重拉（限流闸门不得吃掉换场那一次）
}

function fetchState(sid, force) {
  const now = Date.now();
  if (!force && now - fetchedAt < 2500) return Promise.resolve();
  fetchedAt = now;
  const my = ++seq;
  return api.audit(sid).then((res) => {
    if (my !== seq) return;                       // 已有更新的读/本地写：本包作废
    const d = ctx && ctx.getData();
    if (!d || d.scene.id !== sid) return;
    const st = applyRead(res, sid);
    decorate(d);
    if (st.changed) notify();
    if (cur.job && cur.job.running) startPoll();
  }).catch(() => {});
}

function notify() { window.dispatchEvent(new CustomEvent('shotlist:audit-changed')); }

// 读取落地（fetchState/tick 共用）：返回 { changed, wasRunning }
function applyRead(res, sid) {
  const wasRunning = !!(cur && cur.job && cur.job.running);
  cur = { sceneId: sid, issues: res.issues || [], counts: res.counts || { open: 0, fixed: 0, waived: 0 },
          job: res.job || null };
  const key = stateKey();
  const changed = key !== lastKey;
  lastKey = key;
  return { changed: changed, wasRunning: wasRunning };
}

function stateKey() {
  if (!cur) return '';
  const j = cur.job;
  const jk = j ? [j.running ? 1 : 0, (j.rules || []).map((r) => r.title + '.' + r.state).join(',')].join('|') : '';
  const ik = cur.issues.map((i) => [i.id, i.status, i.updated_at || '', i.waive_note || ''].join('.')).join(';');
  const c = cur.counts || {};
  return jk + '##' + ik + '##' + [c.open, c.fixed, c.waived].join('/');
}

// ── 灯 ──
function splitKey(k) { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; }
function shotIdOf(carrier, target) { return carrier === 'seam' ? String(target).split('>')[0] : String(target); }

// 载体解析（单点）：灯 / 卡 / 清单跳转 / 去改 全走这里——平铺视图节拍回退「首镜行」（G4）
function resolveCarrier(carrier, target, data) {
  if (carrier === 'scene') {
    const node = document.querySelector('.scene-freeze .scene-head') || document.querySelector('.scene-head');
    return node ? { node: node, lamp: node, head: node, row: null, sec: null } : null;
  }
  if (carrier === 'beat') {
    const sec = document.querySelector('section.beat[data-beat-id="' + target + '"]');
    if (sec) {
      const head = sec.querySelector('.beat-head');
      return { node: sec, lamp: head || sec, head: head, row: null, sec: sec };
    }
    const b = ((data && data.beats) || []).find((x) => String(x.id) === String(target));
    const first = b && b.shots && b.shots[0];
    const row = first && document.querySelector('tr.shot[data-id="' + first.id + '"]');
    if (!row) return null;
    return { node: row, lamp: row.querySelector('td.cell-toggle') || row, head: null, row: row, sec: null,
             hidden: row.style.display === 'none' };
  }
  const row = document.querySelector('tr.shot[data-id="' + shotIdOf(carrier, target) + '"]');
  if (!row) return null;
  return { node: row, lamp: row.querySelector('td.cell-toggle') || row, head: null, row: row, sec: null,
           hidden: row.style.display === 'none' };
}

function decorate(data) {
  document.querySelectorAll('.audit-lamp').forEach((n) => n.remove());
  clearCards();
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
    const r = resolveCarrier(carrier, target, data);
    if (!r) continue;
    r.lamp.appendChild(buildLamp(k, by[k].length, by[k][0].message || ''));
    if (r.row) r.row.classList.add('has-lamp');
  }
  if (openKey && openCard(openKey, data, true) === 'gone') openKey = null;   // 暂时隐藏（筛选）不清 openKey
}

function buildLamp(key, count, msg) {
  const [carrier] = splitKey(key);
  const lamp = el('span', 'audit-lamp' + (carrier === 'seam' ? ' seam' : ''));
  lamp.dataset.key = key;
  lamp.title = msg || '审计问题（点击查看）';
  if (count > 1) lamp.appendChild(el('i', 'lamp-n', String(count)));
  const stop = (e) => e.stopPropagation();
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
function clearCards() {
  document.querySelectorAll('tr.audit-card-tr').forEach((n) => n.remove());
  document.querySelectorAll('.audit-card').forEach((n) => n.remove());
}

function closeCard() {
  clearCards();
  openKey = null;
  window.dispatchEvent(new Event('resize'));   // 场级卡收起：吸顶区高度重算（M3）
  notify();
}

function openCard(key, data, silent) {
  clearCards();
  const [carrier, target] = splitKey(key);
  const list = (cur ? cur.issues : []).filter(
    (i) => i.carrier === carrier && String(i.target_id) === String(target));
  if (!list.length) { openKey = null; return 'gone'; }
  const r = resolveCarrier(carrier, target, data);
  if (!r) { openKey = null; return 'gone'; }
  if (r.hidden) {   // 行被筛选隐藏：暂时态——静默重绘不弹 toast（L7）
    if (!silent) toast('该行被筛选隐藏了');
    return 'hidden';
  }
  const card = buildCard(carrier, target, list, data);
  let host = null;
  if (carrier === 'scene') {
    r.node.parentNode.insertBefore(card, r.node.nextSibling);
    host = card;
  } else if (carrier === 'beat' && r.sec) {
    const ref = r.head || r.sec.querySelector('.space-label');
    if (ref) r.sec.insertBefore(card, ref.nextSibling);
    else r.sec.insertBefore(card, r.sec.firstChild);
    host = card;
  } else {   // 平铺节拍 / 镜 / 接缝：行下卡
    host = insertCardTr(r.row, card);
  }
  if (!host) { openKey = null; return 'gone'; }
  openKey = key;
  if (carrier === 'scene') window.dispatchEvent(new Event('resize'));   // 吸顶区高度重算
  if (!silent) notify();
  return true;
}

function insertCardTr(row, card) {
  const tr = el('tr', 'audit-card-tr float-card');
  tr.dataset.for = String(row.dataset.id);   // 同行标记（筛选隐藏联动，M6）
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
  const card = el('div', 'audit-card float-card');
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
    if (i.carrier === 'shot' || i.carrier === 'beat') acts.appendChild(qb('去改', () => goEdit(i, data)));
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
  const r = resolveCarrier(carrier, target, data);
  if (!r) { toast('未找到该问题对应位置——可能已被删除或不在当前视图'); return null; }
  if (r.hidden) { toast('该处被筛选隐藏了'); return null; }
  flash(r.node);
  if (!(opts && opts.noCard)) openCard(key, data);
  if (r.node.scrollIntoView) r.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return { carrier, target, row: r.row };
}

function flash(node) {
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
}

function goEdit(i, data) {
  const res = jumpToIssue(i, { noCard: true });
  closeCard();
  if (!res) return;
  if (res.carrier === 'shot') {
    const field = FIELD_HINT[i.rule_title];
    if (!field) return;   // 无对应列：已定位并闪烁，交由手动修改
    setTimeout(() => {
      const td = document.querySelector('tr.shot[data-id="' + res.target + '"] td[data-field="' + field + '"]');
      if (td) td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      else toast('该列已隐藏——「场务 → 列设置」打开后可直接点格编辑');
    }, 320);
  } else if (res.carrier === 'beat') {
    setTimeout(() => {
      const act = document.querySelector('section.beat[data-beat-id="' + res.target + '"] .beat-action');
      if (act) act.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      else toast('平铺视图下不能直接改节拍栏——切回「分组」视图再改');
    }, 320);
  }
}

export async function runAudit() {
  const data = getData();
  if (!data) return;
  try {
    const res = await api.auditRun(data.scene.id);
    seq++;                       // 本地权威写：作废在飞旧读
    if (cur && cur.sceneId === data.scene.id) cur.job = res.job;
    else cur = { sceneId: data.scene.id, issues: [], counts: { open: 0, fixed: 0, waived: 0 }, job: res.job };
    notify();
    startPoll();
    toast(res.job && res.job.joined ? '审计正在进行——本轮先等它跑完（完成即出结果）' : '审计已开始（按设置跑）');
  } catch (err) { toast('启动失败：' + err.message, 'err'); }
}

export async function recheckIssue(i) {
  try {
    const res = await api.auditIssue({ id: i.id, action: 'recheck' });
    seq++;                       // 本地权威写：作废在飞旧读
    if (cur && res.job) cur.job = res.job;
    notify();
    startPoll();
    if (res.joined) {
      toast('本场审计正在跑——重检未单独排上，请等本轮完成后再点一次', 'err');
    } else {
      toast('重检中：' + i.rule_title + ' …');
    }
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
  seq++;                       // 本地权威写：作废在飞旧读（防旧快照复活）
  cur.issues = res.issues || [];
  cur.counts = res.counts || cur.counts;
  const data = ctx && ctx.getData();
  if (data) decorate(data);
  notify();
  refreshHistoryIfOpen();
}

// ── 轮询（M5：单飞 + 序号防乱序；换场停；页面隐藏不拉）──
function startPoll() { if (!pollTimer) { pollTimer = setInterval(tick, 2000); tick(); } }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function tick() {
  if (!cur) return stopPoll();
  const data = ctx && ctx.getData();
  if (!data || data.scene.id !== cur.sceneId) return stopPoll();
  if (document.hidden) return;                 // 后台页不拉；回前台立即补一拍
  if (inFlight) return;                        // 单飞：上一拍未回不叠发
  inFlight = true;
  const sid = cur.sceneId;
  const my = ++seq;
  try {
    const res = await api.audit(sid);
    if (my !== seq) return;                    // 期间有更新的读/本地写：旧快照作废（防复活一拍）
    if (!cur || cur.sceneId !== sid) return stopPoll();
    const st = applyRead(res, sid);
    const d = ctx && ctx.getData();
    if (!d || d.scene.id !== sid) return stopPoll();
    if (cur.job && cur.job.running) {
      if (st.changed) notify();
    } else {
      stopPoll();
      decorate(d);
      notify();
      if (st.wasRunning) onDone(cur.job);
    }
  } catch (err) { /* 网络抖动：下一拍再试 */ }
  finally { inFlight = false; }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollTimer) tick();   // 回前台补一拍（隐藏期间不耗请求）
});

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
