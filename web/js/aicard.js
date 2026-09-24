// 任务卡原语（L5）：单格/批量/场次草稿/组级初稿 四卡共用。
// ① pollJob —— 任务轮询单点（间隔/上限/取消/错误契约一处）；
// ② cardLife —— 卡生命周期（closed 标记 + onClose 清理钩子 + alive 给轮询）；
// ③ taskShell / spinHead / renderFail / cancelBtn —— 任务卡壳与小件（类名注入，视觉零变化）。
import { el, toast } from './ui.js';
import { api } from './api.js';
import { panelShell } from './float.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询单点：fn: async () => job | null（null = 任务已丢失）。
// opts: interval 间隔（默认 700ms）｜limit 上限（默认 420 拍）
//       alive() 假 → {st:'abort'}（卡已关：停轮询，不打扰已付费的结果）
//       tolerant 网络抖动宽容（下轮再试；否则 {st:'error', err}）
//       onTick(job) 运行中每拍回调（草稿卡更新阶段文案）
// 终态：{st:'done', job} | {st:'gone'} | {st:'timeout'} | {st:'abort'} | {st:'error', err}
export async function pollJob(fn, opts) {
  opts = opts || {};
  const interval = opts.interval || 700;
  const limit = opts.limit || 420;
  for (let i = 0; i < limit; i++) {
    if (opts.alive && !opts.alive()) return { st: 'abort' };
    let job;
    try {
      job = await fn();
    } catch (err) {
      if (!opts.tolerant) return { st: 'error', err: err };
      if (opts.onRetry) opts.onRetry(i + 1);   // F4-P5：持续失败上报重试次数（长静默可辨慢/坏）
      await sleep(interval);
      continue;
    }
    if (!job) return { st: 'gone' };
    if (!job.running) return { st: 'done', job: job };
    if (opts.onTick) opts.onTick(job);
    await sleep(interval);
  }
  return { st: 'timeout' };
}

// 卡生命周期：closed 一次置位；清理钩子按注册序执行一次
export function cardLife() {
  let closed = false;
  const hooks = [];
  return {
    alive: () => !closed,
    isClosed: () => closed,
    onClose(fn) { hooks.push(fn); },
    close() {
      if (closed) return false;
      closed = true;
      for (const fn of hooks) { try { fn(); } catch (e) { /* 清理异常不影响关闭结果 */ } }
      return true;
    },
  };
}

// 任务卡壳：头/体/脚三段 + 挂载 + 点外防误触（保住编辑面焦点）。类名注入，视觉零变化。
// F4-W25：两套壳收敛——taskShell 内调 panelShell（无 ✕ + 点外防误触 = 任务卡族）。
export function taskShell(spec) {
  const sh = panelShell({
    cls: spec.cls,
    id: spec.id,
    headCls: spec.headCls,
    bodyCls: spec.bodyCls == null ? '' : spec.bodyCls,   // null＝体无类名（原口径），不再与 panelShell 的「不建体」撞义
    footCls: spec.footCls,
    noX: true,
    mousedownGuard: true,
  });
  document.body.appendChild(sh.card);   // panelShell 契约＝调用方挂载（原 taskShell 自带）
  return sh;
}

// 生成中头部：✦ 标题 · 生成中…
export function spinHead(head, text) {
  head.textContent = '';
  head.appendChild(el('span', 'ai-spin'));
  head.appendChild(document.createTextNode(' ' + text));
}

// 取消按钮（生成中态）
export function cancelBtn(onClick) {
  const b = el('button', 'aid-btn', '取消');
  b.addEventListener('click', () => onClick());
  return b;
}

// 失败态：错误块 + 脚部（重试? / 关闭）
export function renderFail(head, body, foot, title, msg, opts) {
  opts = opts || {};
  head.textContent = '✦ ' + title + ' · 失败';
  body.textContent = '';
  body.appendChild(el('div', 'aid-err', msg));
  foot.textContent = '';
  if (opts.retry) {
    const b1 = el('button', 'aid-btn primary', '重试');
    b1.addEventListener('click', (e) => { e.preventDefault(); opts.retry(); });
    foot.appendChild(b1);
  }
  const b2 = el('button', 'aid-btn', '关闭');
  b2.addEventListener('click', (e) => { e.preventDefault(); opts.close(); });
  foot.appendChild(b2);
}

// ── 轮询节奏与终态文案单点（F4-W26/P5/P8：原先四卡各写一份 interval/limit/文案）──
export const POLL = { fast: 650, slow: 1200 };
const POLL_LIMIT = 420;                        // 默认上限拍数（pollJob 单点默认）

// 超时文案由 interval × limit 派生（原文案「约 4 分钟」≠ 实际 4.6 / 8.4 分钟）
export function timeoutText(interval) {
  const mins = Math.round((interval * POLL_LIMIT / 60000) * 10) / 10;
  return '超时（约 ' + mins + ' 分钟未完成）';
}

// 终态文案表（F4-P8）：gone / timeout / err 三态单点（AI 卡 ×2 / 草稿卡 ×2 共用）
export function failText(r, interval) {
  if (r.st === 'gone') return '任务已丢失（服务可能重启过）——请重试';
  if (r.st === 'timeout') return timeoutText(interval || POLL.fast);
  return r.err ? r.err.message : '生成失败';
}

// joined 文案表（F4-W20）：服务端同一件事（job.joined），前端三语境三套文案 → 收敛一处
const JOINED_TEXT = {
  ai: '本场已有生成任务在跑——已并入，出稿一起看',
  draft: '本场已有草稿任务在跑——已并入',
  pdraft: '这个镜头的初稿正在生成——已并入',
};
export function joinedToast(kind) { toast(JOINED_TEXT[kind] || JOINED_TEXT.ai); }

// AI 应用薄封装（F4-W23）：单格与批量同调，返回 {results(逐项带 i), skipped}
export async function aiApplyItems(jobId, ids) {
  const out = await api.aiApply(jobId, ids);
  return { results: out.results || [], skipped: out.skipped || [] };
}
