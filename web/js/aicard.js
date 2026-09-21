// 任务卡原语（L5）：单格/批量/场次草稿/组级初稿 四卡共用。
// ① pollJob —— 任务轮询单点（间隔/上限/取消/错误契约一处）；
// ② cardLife —— 卡生命周期（closed 标记 + onClose 清理钩子 + alive 给轮询）；
// ③ taskShell / spinHead / renderFail / cancelBtn —— 任务卡壳与小件（类名注入，视觉零变化）。
import { el } from './ui.js';

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
export function taskShell(spec) {
  const card = el('div', 'float-card' + (spec.cls ? ' ' + spec.cls : ''));
  if (spec.id) card.id = spec.id;
  const head = el('div', spec.headCls);
  const body = el('div', spec.bodyCls || null);
  const foot = el('div', spec.footCls);
  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(foot);
  card.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(card);
  return { card: card, head: head, body: body, foot: foot };
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
