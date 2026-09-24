// AI 创作面（M4b-2）：就地 ✦ + 指挥条 —— 出稿零写入；接受/应用才落库（source=ai）。
// 单格 = 就近 diff 卡（接受/拒绝/再来一版）；多格 = 右下预览浮卡（逐条勾选 → 应用 = 一步撤销）。
// 服务端通道（M4b-1）：POST /api/ai/preview → GET /api/ai/job → POST /api/ai/apply。
import { api } from './api.js';
import { el, toast, placeNear } from './ui.js';
import { openMenu } from './menu.js';
import { commitField } from './edit.js';
import { refreshShotCell } from './table.js';
import { state, fieldOf, fieldLabel } from './state.js';
import { eachSelCell, batchWrite } from './selection.js';
import { cardLife, taskShell, spinHead, cancelBtn, renderFail, POLL, aiApplyItems, runTaskCard } from './aicard.js';
import { floatEnter, floatLeave, floatClose } from './float.js';

// 动作表单点（F4-W22）：菜单 label 与中文名同源（原 ACTIONS / ACTION_CN 两张同键表）
const ACTIONS = [
  { key: 'rewrite', cn: '改写', hint: '换更准更顺的说法' },
  { key: 'concretize', cn: '具象化', hint: '模糊动作钉成可见细节' },
  { key: 'strengthen', cn: '强化', hint: '冲突 / 张力加一档' },
  { key: 'expand', cn: '扩写', hint: '一句话扩成拍得出的一拍' },
];
const ACTION_CN = {};
for (const a of ACTIONS) ACTION_CN[a.key] = a.cn;
const actionLabel = (a) => '✦ ' + a.cn + ' · ' + a.hint;
const maxTargets = () => (state.meta && state.meta.ai_max_targets) || 0;   // F4-W27：0＝未知（meta 未载入）→ 不设限

let ctx = { getShot: () => null, sceneId: () => null };
export function initAiWrite(c) { ctx = Object.assign(ctx, c); }

export function isAiField(key) {
  const list = state.meta && state.meta.ai_fields;
  if (!list) return false;   // F4-W27：meta 未载入＝禁用 AI 入口，不再手抄兜底子集（fields.py 明令勿前端手抄）
  return list.indexOf(key) !== -1;
}

// AI 字段文案单点（F4-W27）：从服务端 meta 标签派生（原文案手抄 3 键，单源是 4 键已分叉）
function aiFieldLabels() {
  const list = (state.meta && state.meta.ai_fields) || [];
  return list.map((k) => fieldLabel(k)).filter(Boolean).join(' / ');
}

// 「一次最多 N 格」守卫单点（F4-W21）：超限即 toast 并拒绝
function guardTargets(targets) {
  if (maxTargets() && targets.length > maxTargets()) {
    toast('一次最多 ' + maxTargets() + ' 格（本次 ' + targets.length + '）——请分批', 'err');
    return false;
  }
  return true;
}

// 重绘/换场前收起（scene.js paintScene 调用）：同层（'ai'）全量闭合（L6 注册表）
export function closeAiCards() {
  floatClose('ai');
}

// ════════ 入口 ════════

// 选区 → 目标清单（仅 AI 可改字段；shots 行序 × 列序）
export function targetsFromSel() {
  const out = [];
  const cap = maxTargets();
  eachSelCell((shot, key) => {                       // F2-P2：选区遍历原语（行序 × 列序同旧）
    if (isAiField(key)) {
      if (!cap || out.length <= cap) out.push({ table: 'shots', id: shot.id, field: key });   // F4-W28①：超限即停收
    }
  });
  return out;
}

// A. 右键（格子 / 选区）：单格 → 近处卡；多格 → 批量卡
export function aiMenu(anchor, targets) {
  if (!targets.length) { toast('这里没有可改写的字段'); return; }
  if (!guardTargets(targets)) return;
  openActionMenu(anchor, targets, {});
}

// B. 节拍概述（节拍头右键）
export function aiMenuForBeat(anchor, b, renderCell) {
  openActionMenu(anchor, [{ table: 'beats', id: b.id, field: 'beat_action' }], {
    ac: {
      table: 'beats', id: b.id, field: 'beat_action', label: fieldLabel('beat_action', 'beats'),   // F4-B5：与字段字典一致（原手写「节拍概述」）
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
  if (!targets.length) { toast('选区内没有可改写的字段（支持：' + aiFieldLabels() + '）', 'err'); return; }
  if (!guardTargets(targets)) return;
  startBatchCard({ instruction: instruction, targets: targets });
}

function openActionMenu(anchor, targets, opts) {
  const o = opts || {};
  o.anchor = anchor;
  openMenu(anchor, ACTIONS.map((a) => ({ key: a.key, label: actionLabel(a) })), (k) => {
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
  const sh = taskShell({ cls: 'ai-diff', headCls: 'aid-head', bodyCls: null, footCls: 'aid-foot' });
  const card = sh.card, head = sh.head, body = sh.body, foot = sh.foot;

  const life = cardLife();
  let jobId = null;

  let lastAnchorRect = (o.anchor && o.anchor.nodeType === 1 && o.anchor.isConnected)
    ? o.anchor.getBoundingClientRect() : null;
  const place = () => {                          // F4-W24：越界翻上 + 夹回视口并入 ui.placeNear（第 4 份手抄退役）
    if (o.anchor && o.anchor.nodeType === 1) {
      if (o.anchor.isConnected) lastAnchorRect = o.anchor.getBoundingClientRect();
      placeNear(lastAnchorRect || o.anchor, card);   // 锚点被重绘销毁：用最后一次矩形，不跳左上角（L8）
    } else {
      placeNear(o.anchor, card);
    }
  };
  const onScroll = () => { if (!life.isClosed()) place(); };

  life.onClose(() => {
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    card.remove();
    floatLeave('ai', life.close);
  });
  floatEnter('ai', life.close);   // 互斥：AI 卡同层开新关旧（L6）
  document.addEventListener('scroll', onScroll, true);   // 跟随锚点（与 onClose 的 remove 严格对齐）（P0·F4-B3）
  window.addEventListener('resize', onScroll);

  const setLoading = () => {
    spinHead(head, '✦ ' + ACTION_CN[action] + ' · 生成中…');
    body.textContent = '';
    foot.textContent = '';
    foot.appendChild(cancelBtn(life.close));
    place();
  };

  const setError = (msg) => {
    renderFail(head, body, foot, ACTION_CN[action], msg, { retry: start, close: life.close });
    place();
  };

  const accept = async (it) => {
    try {
      if (o.textAccept) {
        o.textAccept(it.after);
        life.close();
        return;
      }
      const { results, skipped } = await aiApplyItems(jobId, [it.i]);   // F4-W23：薄封装单点
      const skip = skipped.find((s) => s.i === it.i);
      if (skip) { setError('未应用：' + skip.reason); return; }   // 终态卡，不再只 toast（P9）
      // 落定三件（模型 / 编辑面基线 / 撤销）走单点：edit.commitField（L7）
      commitField(Object.assign({}, o.ac, { label: 'AI ' + ACTION_CN[action] }), it.before, it.after);
      toast('已应用（Ctrl+Z 可撤）');
      life.close();
    } catch (err) {
      toast('应用失败：' + err.message, 'err');
    }
  };

  const setDone = (job) => {
    const items = job.items || [];
    const it = items.find((x) => x.kind === 'db' && x.table === target.table
                              && x.id === target.id && x.field === target.field)
            || items.find((x) => x.kind === 'text' && x.before === (target.text || ''));
    if (!it) { setError('并入任务未能定位本格结果——请重试'); return; }   // F4-B7：定位失败即报错（items[0] 兜底会把别人那条的值套到本格）
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
    no.addEventListener('click', (e) => { e.preventDefault(); life.close(); });
    const again = el('button', 'aid-btn', '再来一版');
    again.addEventListener('click', (e) => { e.preventDefault(); start(); });
    foot.appendChild(ok);
    foot.appendChild(no);
    foot.appendChild(again);
    foot.appendChild(el('span', 'aid-meta', '耗时 ' + ((job.ms || 0) / 1000).toFixed(1) + 's'));
    place();
  };

  const start = async () => {
    if (life.isClosed()) return;
    setLoading();
    await runTaskCard({                              // F4-L2：编排单点（原逐段手写退役）
      life: life,
      sceneId: ctx.sceneId ? ctx.sceneId() : null,
      interval: POLL.fast,
      joined: 'ai',
      start: (sid) => api.aiPreview({ scene_id: sid, action: action, targets: [target] }),
      poll: (jid) => api.aiJob(jid).then((x) => x.job),
      onRetry: (n) => { head.textContent = '✦ ' + ACTION_CN[action] + ' · 网络重试 ' + n + ' 次…'; },
      onLaunched: (jid) => { jobId = jid; },
      onDone: (job) => setDone(job),
      onFail: (msg) => setError(msg),
    });
  };

  start();
}

// ════════ 批量预览卡（指挥条 / 多格动作） ════════

function startBatchCard(opts) {
  const isCmd = !!opts.instruction;
  const titleBase = isCmd ? '指挥条' : (ACTION_CN[opts.action] || '改写');
  const sh = taskShell({ id: 'ai-cmd', headCls: 'aic-head', bodyCls: 'aic-list', footCls: 'aic-foot' });
  const card = sh.card, head = sh.head, list = sh.body, foot = sh.foot;
  const htitle = el('span');
  const sumEl = el('span', 'aic-sum');
  const x = el('span', 'aic-x', '✕');
  x.title = '丢弃预览（零写入）';
  head.appendChild(htitle);
  head.appendChild(sumEl);
  head.appendChild(x);

  const life = cardLife();
  let job = null;
  let jobId = null;
  const checked = {};
  let applyBtn = null;
  let allBtn = null;

  life.onClose(() => { card.remove(); floatLeave('ai', life.close); });
  floatEnter('ai', life.close);   // 互斥：AI 卡同层开新关旧（L6）
  x.addEventListener('click', () => life.close());

  const okItems = () => (job ? (job.items || []).filter((it) => !it.error) : []);
  const checkedIds = () => (job ? (job.items || []).filter((it) => checked[it.i]).map((it) => it.i) : []);

  const updateSum = () => {
    if (!job) return;
    sumEl.textContent = (job.items || []).length + ' 条改动 · ' + checkedIds().length + ' 条已勾';
  };
  const updateFoot = () => {
    if (!job) return;
    const nChecked = checkedIds().length;   // F4-W28②：一次算，不再每钮各 filter 一遍
    if (applyBtn) {
      applyBtn.textContent = '应用选中（' + nChecked + '）';
      applyBtn.disabled = !nChecked;
    }
    if (allBtn) {
      allBtn.textContent = '全收（' + okItems().length + '）';
      allBtn.disabled = !okItems().length;
    }
  };

  const setLoading = () => {
    spinHead(htitle, '✦ ' + titleBase + ' · 生成中…');
    sumEl.textContent = '';
    list.textContent = '';
    foot.textContent = '';
    foot.appendChild(cancelBtn(life.close));
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
    if (!ops.length) { life.close(); return; }
    if (applyBtn) applyBtn.disabled = true;
    if (allBtn) allBtn.disabled = true;
    // 落库 + 本地落定 + 一步撤销：走 selection.batchWrite 泛化口（L7），写口接入 aiApply
    await batchWrite(ops, 'AI ' + (isCmd ? '指挥条' : titleBase), {
      write: async (items) => {
        const out = await aiApplyItems(jobId, items.map((o) => o.i));   // F4-W23：薄封装单点
        const map = {};
        for (const o of items) map[o.i] = o;
        const results = [];
        for (const r of out.results) {
          const o = map[r.i];
          if (o) results.push({ id: o.id, field: o.field, changed: r.changed, error: r.error, restore: o.restore });
        }
        return { results: results, skipped: out.skipped };
      },
      done: (n, errs, ret) => {
        const skipped = (ret && ret.skipped) || [];
        const skipTxt = skipped.length ? ('；' + skipped.length + ' 条未应用：' + skipped[0].reason) : '';
        toast('已应用 ' + n + ' 处' + skipTxt + '（Ctrl+Z 可撤）');
        life.close();
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
    dis.addEventListener('click', (e) => { e.preventDefault(); life.close(); });
    foot.appendChild(applyBtn);
    foot.appendChild(allBtn);
    foot.appendChild(dis);
    foot.appendChild(el('span', 'aic-hint', '应用 = 一步撤销'));
    updateSum();
    updateFoot();
  };

  const start = async () => {
    if (life.isClosed()) return;
    setLoading();
    await runTaskCard({                              // F4-L2：编排单点（setLoadingErr 打洞句随编排归位）
      life: life,
      sceneId: ctx.sceneId ? ctx.sceneId() : null,
      interval: POLL.fast,
      joined: 'ai',
      start: (sid) => {
        const payload = { scene_id: sid, targets: opts.targets };
        if (isCmd) payload.instruction = opts.instruction;
        else payload.action = opts.action;
        return api.aiPreview(payload);
      },
      poll: (jid) => api.aiJob(jid).then((x) => x.job),
      onRetry: (n) => { htitle.textContent = '✦ ' + titleBase + ' · 网络重试 ' + n + ' 次…'; },
      onLaunched: (jid) => { jobId = jid; },
      onDone: (job) => setDone(job),
      onFail: (msg) => renderFail(htitle, list, foot, titleBase, msg, { close: life.close }),
    });
  };

  start();
}
