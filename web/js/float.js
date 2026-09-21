// 浮层治理（L6）：互斥注册表（同层开新关旧）+ 面板外壳（头 = 标题 + ✕ / 体）。
// 点外豁免单点在 ui.isFloatTarget()（批4/L1：浮卡根必挂 .float-card）；本模块只管互斥与外壳收敛。
import { el } from './ui.js';

// 层（同层互斥 = 同族浮卡，开新关旧）：
//   'panel' 设置卡 ↔ 审计设置 ｜ 'ai' AI 单格/批量卡 ｜ 'draft' 场次草稿 ↔ 组级初稿
const LIVE = {};   // layer -> close()

// 开卡登记：同层已有别的卡开着 → 先关旧再登记（关闭异常不阻断新卡）
export function floatEnter(layer, close) {
  const prev = LIVE[layer];
  if (prev && prev !== close) { try { prev(); } catch (e) { /* ignore */ } }
  LIVE[layer] = close;
}

// 卡自行关闭时退登记
export function floatLeave(layer, close) {
  if (LIVE[layer] === close) LIVE[layer] = null;
}

// 全量闭合该层（换场重绘等；无卡则无事）
export function floatClose(layer) {
  const cur = LIVE[layer];
  LIVE[layer] = null;
  if (cur) { try { cur(); } catch (e) { /* ignore */ } }
}

// 面板外壳（L6）：头（标题 + 可选填充 + ✕）/ 体。类名注入 → 视觉零变化。
// spec: { id?, headCls?, bodyCls?, title, onClose, fillHead?(head) }；bodyCls === null → 不建体（审计面板）
export function panelShell(spec) {
  const card = el('div', 'float-card');
  if (spec.id) card.id = spec.id;
  const head = el('div', spec.headCls || 'sc-head');
  head.appendChild(el('b', null, spec.title));
  if (spec.fillHead) spec.fillHead(head);
  const x = el('button', 'tool-btn small', '✕');
  x.addEventListener('click', () => spec.onClose());
  head.appendChild(x);
  card.appendChild(head);
  let body = null;
  if (spec.bodyCls !== null) {
    body = el('div', spec.bodyCls || 'sc-body');
    card.appendChild(body);
  }
  return { card: card, head: head, body: body };
}
