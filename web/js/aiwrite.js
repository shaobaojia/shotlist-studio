// AI 创作面（M4b-2）：就地 ✦ + 指挥条 —— 出稿零写入；接受/应用才落库（source=ai）。
// 单格 = 就近 diff 卡（接受/拒绝/再来一版）；多格 = 右下预览浮卡（逐条勾选 → 应用 = 一步撤销）。
// 服务端通道（M4b-1）：POST /api/ai/preview → GET /api/ai/job → POST /api/ai/apply。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { openMenu } from './menu.js';
import { commitField } from './edit.js';
import { refreshShotCell } from './table.js';
import { state, fieldOf } from './state.js';
import { current as selCurrent, rectOf, batchWrite } from './selection.js';

const AIS_FALLBACK = ['blocking', 'dialogue', 'director_note', 'beat_action'];   // /api/meta 未载入前兜底（批4/P8）
const ACTIONS = [
  { key: 'rewrite', label: '改写 · 换更准更顺的说法' },
  { key: 'concretize', label: '具象化 · 模糊动作钉成可见细节' },
  { key: 'strengthen', label: '强化 · 冲突 / 张力加一档' },
  { key: 'expand', label: '扩写 · 一句话扩成拍得出的一拍' },
];
const ACTION_CN = { rewrite: '改写', concretize: '具象化', strengthen: '强化', expand: '扩写' };
const maxTargets = () => ((state.meta && state.meta.ai_max_targets) || 30);   // 上限单点：/api/meta（批4/P8）

let ctx = { getShot: () => null, sceneId: () => null };
export function initAiWrite(c) { ctx = Object.assign(ctx, c); }

export function isAiField(key) {
  const m = state.meta;
  const list = (m && m.ai_fields) || AIS_FALLBACK;   // 单源：/api/meta（批4/P8）
  return list.indexOf(key) !== -1;
}

function fieldLabel(key) {
  const f = fieldOf(key);
  return f ? f.label : key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let curSingle = null;   // 当前单格卡：关闭函数
let curBatch = null;    // 当前批量卡：关闭函数

// 重绘/换场前收起（scene.js paintScene 调用）
export function closeAiCards() {
  if (curSingle) { curSingle(); curSingle = null; }
  if (curBatch) { curBatch(); curBatch = null; }
}

async function pollJob(jobId, isAlive) {
  for (let i = 0; i < 420; i++) {
    if (isAlive && !isAlive()) return null;     // 卡片已关：停轮询（不打扰已付费的结果）
    const res = await api.aiJob(jobId);
    const j = res.job;
    if (!j) throw new Error('任务已丢失（服务可能重启过）——请重试');
    if (!j.running) return j;
    await sleep(650);
  }
  throw new Error('超时（约 4 分钟未完成）');
}

// ════════ 入口 ════════

// 选区 → 目标清单（仅 AI 可改字段；shots 行序 × 列序）
export function targetsFromSel() {
  const s = selCurrent();
  const rc = rectOf();
  if (!s || !rc) return [];
  const out = [];
  for (let r = rc.r1; r <= rc.r2; r++) {
    const tr = s.rows[r];
    if (!tr) continue;
    const id = Number(tr.dataset.id);
    for (let c = rc.c1; c <= rc.c2; c++) {
      if (isAiField(s.cols[c])) out.push({ table: 'shots', id: id, field: s.cols[c] });
    }
  }
  return out;
}

// A. 右键（格子 / 选区）：单格 → 近处卡；多格 → 批量卡
export function aiMenu(anchor, targets) {
  if (!targets.length) { toast('这里没有可改写的字段'); return; }
  if (targets.length > maxTargets()) { toast('一次最多 ' + maxTargets() + ' 格（本次 ' + targets.length + '）——请分批', 'err'); return; }
  openActionMenu(anchor, targets, {});
}

// B. 节拍概述（节拍头右键）
export function aiMenuForBeat(anchor, b, renderCell) {
  openActionMenu(anchor, [{ table: 'beats', id: b.id, field: 'beat_action' }], {
    ac: {
      table: 'beats', id: b.id, field: 'beat_action', label: '节拍概述',
      onLocal: (v) => { b.beat_action = v; },
      renderCell: renderCell || (() => {}),
    },
  });
}

// C. 拼装台选中段（文本目标：只出稿，接受后由调用方就地替换）
export function aiTextMenu(pt, text, context, onAccept) {
  openActionMenu(pt, [{ kind: 'text', text: text, context: context, label: '提示词选段' }],
    { textAccept: onAccept });
}

// D. 编辑态格角 ✦（edit.js cfg.aiOpen 回调）
export function aiOpenFor(cfg, ed, anchor) {
  openActionMenu(anchor, [{ table: cfg.table, id: cfg.id, field: cfg.field }], {
    ac: {
      table: cfg.table, id: cfg.id, field: cfg.field, label: cfg.label,
      onLocal: cfg.onLocal, renderCell: cfg.renderCell, ed: ed,
    },
  });
}

// E. 选区条「预览」（指挥条：人话指令）
export function runCmdbarFromSel(instruction) {
  if (!instruction) { toast('先写一句指令（比如：都具象化）'); return; }
  const targets = targetsFromSel();
  if (!targets.length) { toast('选区内没有可改写的字段（支持：动作调度 / 台词 / 导演备注）', 'err'); return; }
  if (targets.length > maxTargets()) { toast('一次最多 ' + maxTargets() + ' 格（本次 ' + targets.length + '）——请分批', 'err'); return; }
  startBatchCard({ instruction: instruction, targets: targets });
}

function openActionMenu(anchor, targets, opts) {
  const o = opts || {};
  o.anchor = anchor;
  openMenu(anchor, ACTIONS.map((a) => ({ key: a.key, label: '✦ ' + a.label })), (k) => {
    runPreview(k, targets, o);
  });
}

function runPreview(action, targets, o) {
  const t0 = targets[0] || {};
  if (t0.kind === 'text') { startSingleCard(action, t0, o); return; }
  if (targets.length === 1) {
    let ac = o.ac || null;
    if (!ac && t0.table === 'shots') {
      const s = ctx.getShot(t0.id);
      if (s) {
        ac = {
          table: 'shots', id: t0.id, field: t0.field, label: fieldLabel(t0.field),
          onLocal: (v) => { s[t0.field] = v; },
          renderCell: () => refreshShotCell(s, t0.field),
        };
      }
    }
    if (!ac) { toast('找不到目标模型——刷新后重试', 'err'); return; }
    o.ac = ac;
    startSingleCard(action, t0, o);
    return;
  }
  startBatchCard({ action: action, targets: targets });
}

// ════════ 单格 diff 卡（就近浮层 · 不占版） ════════

function startSingleCard(action, target, o) {
  if (curSingle) curSingle();
  const card = el('div', 'ai-diff float-card');
  const head = el('div', 'aid-head');
  const body = el('div');
  const foot = el('div', 'aid-foot');
  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(foot);
  card.addEventListener('mousedown', (e) => e.preventDefault());   // 保住编辑器焦点
  document.body.appendChild(card);

  let jobId = null;
  let closed = false;
  let aborted = false;

  let lastAnchorRect = (o.anchor && o.anchor.nodeType === 1 && o.anchor.isConnected)
    ? o.anchor.getBoundingClientRect() : null;
  const place = () => {
    let a;
    if (o.anchor && o.anchor.nodeType === 1) {
      if (o.anchor.isConnected) lastAnchorRect = o.anchor.getBoundingClientRect();
      a = lastAnchorRect;                        // 锚点被重绘销毁：用最后一次矩形，不跳左上角（L8）
      if (!a) a = { left: 24, right: 24, top: 80, bottom: 80 };
    } else {
      a = { left: (o.anchor && o.anchor.x) || 24, right: (o.anchor && o.anchor.x) || 24,
            top: (o.anchor && o.anchor.y) || 80, bottom: (o.anchor && o.anchor.y) || 80 };
    }
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let x = a.left;
    let y = a.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, a.top - h - 8);
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  };
  const onScroll = () => { if (!closed) place(); };

  const close = () => {
    if (closed) return;
    closed = true;
    aborted = true;
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    card.remove();
    if (curSingle === close) curSingle = null;
  };
  curSingle = close;

  const setLoading = () => {
    head.textContent = '';
    head.appendChild(el('span', 'ai-spin'));
    head.appendChild(document.createTextNode(' ✦ ' + ACTION_CN[action] + ' · 生成中…'));
    body.textContent = '';
    foot.textContent = '';
    const b = el('button', 'aid-btn', '取消');
    b.addEventListener('click', () => close());
    foot.appendChild(b);
    place();
  };

  const setError = (msg) => {
    head.textContent = '✦ ' + ACTION_CN[action] + ' · 失败';
    body.textContent = '';
    body.appendChild(el('div', 'aid-err', msg));
    foot.textContent = '';
    const b1 = el('button', 'aid-btn primary', '重试');
    b1.addEventListener('click', (e) => { e.preventDefault(); start(); });
    const b2 = el('button', 'aid-btn', '关闭');
    b2.addEventListener('click', (e) => { e.preventDefault(); close(); });
    foot.appendChild(b1);
    foot.appendChild(b2);
    place();
  };

  const accept = async (it) => {
    try {
      if (o.textAccept) {
        o.textAccept(it.after);
        close();
        return;
      }
      const res = await api.aiApply(jobId, [it.i]);
      const skip = (res.skipped || []).find((s) => s.i === it.i);
      if (skip) { setError('未应用：' + skip.reason); return; }   // 终态卡，不再只 toast（P9）
      // 落定三件（模型 / 编辑面基线 / 撤销）走单点：edit.commitField（L7）
      commitField(Object.assign({}, o.ac, { label: 'AI ' + ACTION_CN[action] }), it.before, it.after);
      toast('已应用（Ctrl+Z 可撤）');
      close();
    } catch (err) {
      toast('应用失败：' + err.message, 'err');
    }
  };

  const setDone = (job) => {
    const items = job.items || [];
    const it = items.find((x) => x.kind === 'db' && x.table === target.table
                              && x.id === target.id && x.field === target.field)
            || items.find((x) => x.kind === 'text' && x.before === (target.text || ''))
            || items[0] || {};   // 并入任务时按目标定位，不再写死 [0]（P9）
    if (it.error || !it.after) { setError(it.error || '模型未返回内容'); return; }
    head.textContent = '✦ ' + ACTION_CN[action] + ' · 一版就绪';
    body.textContent = '';
    const r1 = el('div', 'aid-row');
    r1.appendChild(el('span', 'aid-lbl', '原文'));
    r1.appendChild(el('span', 'aid-old', it.before));
    const r2 = el('div', 'aid-row');
    r2.appendChild(el('span', 'aid-lbl', '改写'));
    r2.appendChild(el('span', 'aid-new', it.after));
    body.appendChild(r1);
    body.appendChild(r2);
    foot.textContent = '';
    const ok = el('button', 'aid-btn primary', '接受');
    ok.addEventListener('click', (e) => {
      e.preventDefault();
      ok.disabled = true;                       // 防双击双提交（P9）
      accept(it).finally(() => { ok.disabled = false; });
    });
    const no = el('button', 'aid-btn', '拒绝');
    no.addEventListener('click', (e) => { e.preventDefault(); close(); });
    const again = el('button', 'aid-btn', '再来一版');
    again.addEventListener('click', (e) => { e.preventDefault(); start(); });
    foot.appendChild(ok);
    foot.appendChild(no);
    foot.appendChild(again);
    foot.appendChild(el('span', 'aid-meta', '耗时 ' + ((job.ms || 0) / 1000).toFixed(1) + 's'));
    place();
  };

  const start = async () => {
    if (aborted) return;
    setLoading();
    const sid = ctx.sceneId ? ctx.sceneId() : null;
    if (!sid) { setError('找不到当前场次'); return; }
    try {
      const res = await api.aiPreview({ scene_id: sid, action: action, targets: [target] });
      jobId = res.job.id;
      if (res.job.joined) toast('本场已有生成任务在跑——已并入，出稿一起看');
      const job = await pollJob(jobId, () => !closed && !aborted);
      if (!job) return;
      if (closed || aborted) return;
      setDone(job);
    } catch (err) {
      if (!closed) setError(err.message);
    }
  };

  start();
}

// ════════ 批量预览卡（指挥条 / 多格动作） ════════

function startBatchCard(opts) {
  if (curBatch) curBatch();
  const isCmd = !!opts.instruction;
  const titleBase = isCmd ? '指挥条' : (ACTION_CN[opts.action] || '改写');
  const card = el('div', 'float-card');
  card.id = 'ai-cmd';
  const head = el('div', 'aic-head');
  const htitle = el('span');
  const sumEl = el('span', 'aic-sum');
  const x = el('span', 'aic-x', '✕');
  x.title = '丢弃预览（零写入）';
  head.appendChild(htitle);
  head.appendChild(sumEl);
  head.appendChild(x);
  const list = el('div', 'aic-list');
  const foot = el('div', 'aic-foot');
  card.appendChild(head);
  card.appendChild(list);
  card.appendChild(foot);
  card.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(card);

  let job = null;
  let jobId = null;
  let closed = false;
  let aborted = false;
  const checked = {};
  let applyBtn = null;
  let allBtn = null;

  const close = () => {
    if (closed) return;
    closed = true;
    aborted = true;
    card.remove();
    if (curBatch === close) curBatch = null;
  };
  curBatch = close;
  x.addEventListener('click', () => close());

  const okItems = () => (job ? (job.items || []).filter((it) => !it.error) : []);
  const checkedIds = () => (job ? (job.items || []).filter((it) => checked[it.i]).map((it) => it.i) : []);

  const updateSum = () => {
    if (!job) return;
    sumEl.textContent = (job.items || []).length + ' 条改动 · ' + checkedIds().length + ' 条已勾';
  };
  const updateFoot = () => {
    if (!job) return;
    if (applyBtn) {
      applyBtn.textContent = '应用选中（' + checkedIds().length + '）';
      applyBtn.disabled = !checkedIds().length;
    }
    if (allBtn) {
      allBtn.textContent = '全收（' + okItems().length + '）';
      allBtn.disabled = !okItems().length;
    }
  };

  const setLoading = () => {
    htitle.textContent = '';
    htitle.appendChild(el('span', 'ai-spin'));
    htitle.appendChild(document.createTextNode(' ✦ ' + titleBase + ' · 生成中…'));
    sumEl.textContent = '';
    list.textContent = '';
    foot.textContent = '';
    const b = el('button', 'aid-btn', '取消');
    b.addEventListener('click', () => close());
    foot.appendChild(b);
  };

  const applyIds = async (ids) => {
    if (!ids.length) { toast('没有勾选任何条目'); return; }
    const byI = {};
    for (const it of (job.items || [])) byI[it.i] = it;
    const ops = [];
    for (const i of ids) {
      const it = byI[i];
      if (it && it.kind === 'db') {
        ops.push({ i: i, table: it.table, id: it.id, field: it.field, value: it.after, restore: it.before });
      }
    }
    if (!ops.length) { close(); return; }
    if (applyBtn) applyBtn.disabled = true;
    if (allBtn) allBtn.disabled = true;
    // 落库 + 本地落定 + 一步撤销：走 selection.batchWrite 泛化口（L7），写口接入 aiApply
    await batchWrite(ops, 'AI ' + (isCmd ? '指挥条' : titleBase), {
      write: async (items) => {
        const out = await api.aiApply(jobId, items.map((o) => o.i));
        const map = {};
        for (const o of items) map[o.i] = o;
        const results = [];
        for (const r of (out.results || [])) {
          const o = map[r.i];
          if (o) results.push({ id: o.id, field: o.field, changed: r.changed, error: r.error, restore: o.restore });
        }
        return { results: results, skipped: out.skipped || [] };
      },
      done: (n, errs, ret) => {
        const skipped = (ret && ret.skipped) || [];
        const skipTxt = skipped.length ? ('；' + skipped.length + ' 条未应用：' + skipped[0].reason) : '';
        toast('已应用 ' + n + ' 处' + skipTxt + '（Ctrl+Z 可撤）');
        close();
      },
      fail: (err) => {
        toast('应用失败：' + err.message, 'err');
        updateFoot();
      },
    });
  };

  const setDone = (jb) => {
    job = jb;
    htitle.textContent = '✦ ' + (isCmd ? '指挥条预览' : (titleBase + ' · 批量预览'));
    for (const it of (job.items || [])) checked[it.i] = !it.error;
    list.textContent = '';
    for (const it of (job.items || [])) {
      const row = el('label', 'aic-item');
      const ck = document.createElement('input');
      ck.type = 'checkbox';
      ck.checked = !!checked[it.i];
      ck.disabled = !!it.error;
      ck.addEventListener('change', () => {
        checked[it.i] = ck.checked;
        updateSum();
        updateFoot();
      });
      row.appendChild(ck);
      row.appendChild(el('span', 'aic-tag', it.label));
      const t = el('span', 'aic-t');
      if (it.error) {
        t.appendChild(el('span', 'aic-err', it.error));
      } else {
        t.appendChild(el('span', 'aic-old', it.before));
        t.appendChild(document.createTextNode(' → '));
        t.appendChild(el('span', 'aic-new', it.after));
      }
      row.appendChild(t);
      list.appendChild(row);
    }
    foot.textContent = '';
    applyBtn = el('button', 'aid-btn primary', '应用选中');
    applyBtn.addEventListener('click', (e) => { e.preventDefault(); applyIds(checkedIds()); });
    allBtn = el('button', 'aid-btn', '全收');
    allBtn.addEventListener('click', (e) => { e.preventDefault(); applyIds(okItems().map((it) => it.i)); });
    const dis = el('button', 'aid-btn', '丢弃');
    dis.addEventListener('click', (e) => { e.preventDefault(); close(); });
    foot.appendChild(applyBtn);
    foot.appendChild(allBtn);
    foot.appendChild(dis);
    foot.appendChild(el('span', 'aic-hint', '应用 = 一步撤销'));
    updateSum();
    updateFoot();
  };

  const start = async () => {
    if (aborted) return;
    setLoading();
    const sid = ctx.sceneId ? ctx.sceneId() : null;
    if (!sid) { setLoadingErr('找不到当前场次'); return; }
    function setLoadingErr(msg) {
      htitle.textContent = '✦ ' + titleBase + ' · 失败';
      list.textContent = '';
      list.appendChild(el('div', 'aid-err', msg));
      foot.textContent = '';
      const b = el('button', 'aid-btn', '关闭');
      b.addEventListener('click', () => close());
      foot.appendChild(b);
    }
    try {
      const payload = { scene_id: sid, targets: opts.targets };
      if (isCmd) payload.instruction = opts.instruction;
      else payload.action = opts.action;
      const res = await api.aiPreview(payload);
      jobId = res.job.id;
      if (res.job.joined) toast('本场已有生成任务在跑——已并入，出稿一起看');
      const jb = await pollJob(jobId, () => !closed && !aborted);
      if (!jb) return;
      if (closed || aborted) return;
      setDone(jb);
    } catch (err) {
      if (!closed) setLoadingErr(err.message);
    }
  };

  start();
}
