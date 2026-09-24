export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function fmt(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

// 一次性装配（F1-W21 单点）：同一 key 只执行一次。
// 用法一：once('k', () => {...}) —— 首见即执行；
// 用法二：if (!once('k')) return; —— 纯守卫标记（函数体自行续写，fn 可省）。
const ONCE = {};
export function once(key, fn) {
  if (ONCE[key]) return false;
  ONCE[key] = true;
  if (fn) fn();
  return true;
}

// 吞错单点（F1-W23）：后台刷新失败留痕不改现状（勿再空 catch 全静音）
export function silent(e, tag) {
  try { console.warn('[shotlist]' + (tag ? ' ' + tag : ''), e); } catch (err) { /* ignore */ }
}

// localStorage 存取单点（F1-W19）：解析失败 / 存量 null 一律回落 fallback
export function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
export function lsSet(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignore */ }
}

// 数值夹取单点（F1-W19）
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 一次性动画类单点（F3-W25）：默认「摘类 → 强制回流 → 挂类 → 定时摘」重启动画（防叠加/防重播）；
// opts.clear＝先清旁类；opts.keepOn＝已在树上时只续定时器（连发不重启、不强制回流）
export function flashClass(el0, cls, ms, opts) {
  const o = opts || {};
  if (o.clear) for (const c of o.clear) el0.classList.remove(c);
  if (!(o.keepOn && el0.classList.contains(cls))) {
    el0.classList.remove(cls);
    void el0.offsetWidth;
    el0.classList.add(cls);
  }
  return setTimeout(() => {
    el0.classList.remove(cls);
    if (o.onEnd) o.onEnd();
  }, ms);
}

// 指针拖拽三件套单点（F3-W27①）：capture 绑定 + 收尾卸绑 + 松键护栏（窗口外松开后裸移自动收工）
export function trackDrag(onMove, onEnd) {
  const done = () => {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('mouseup', done, true);
    if (onEnd) onEnd();
  };
  const move = (ev) => {
    if (!ev.buttons) { done(); return; }
    onMove(ev);
  };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseup', done, true);
}

// 视口 resize rAF 合并单点（F3-W27③）：多个监听者共用，一帧至多一次
const __resizeCbs = [];
export function onResizeCoalesced(fn) {
  __resizeCbs.push(fn);
  once('resize-coalesced', () => {
    let raf = 0;
    window.addEventListener('resize', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        for (const f of __resizeCbs.slice()) { try { f(); } catch (e) { silent(e, 'resize'); } }
      });
    });
  });
}

// CSS 变量像素单点（F1-W20）：写＝实测高度回写；读＝取计算值（无则 null）
export function setVarPx(name, elem) {
  document.documentElement.style.setProperty(name, elem ? Math.round(elem.getBoundingClientRect().height) + 'px' : '0px');
}
export function readVarPx(name) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : null;
}

// 场级数据变更广播单点（F1-W1）：导航重载等订阅方只听这一个事件
export const FILM_CHANGED = 'shotlist:film-changed';
export function filmChanged() { window.dispatchEvent(new CustomEvent(FILM_CHANGED)); }

let _toastTimer = null;

export function toast(msg, kind) {
  let box = document.getElementById('toast');
  if (!box) {
    box = el('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.className = 'show' + (kind === 'err' ? ' err' : '');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    box.className = '';
  }, kind === 'err' ? 3200 : 1800);
}

// textarea 自增长（rAF 合并，避免每次按键强制回流）；min = 最小高度 px
export function growTextarea(ta, min) {
  if (ta.__grow) return;
  ta.__grow = true;
  requestAnimationFrame(() => {
    ta.__grow = false;
    if (!ta.isConnected) return;
    // 高度塌缩（'auto' 那一瞬）会把祖先滚动容器的 scrollTop 挤回顶部——先存后还；
    // 否则长文打字时面板「跳顶」、光标看不到（M5d-4 实测根因）
    const scrollers = [];
    for (let p = ta.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
        scrollers.push([p, p.scrollTop]);
      }
    }
    ta.style.height = 'auto';
    ta.style.height = Math.max(min || 0, ta.scrollHeight) + 'px';
    ta.scrollTop = 0;                                   // 生长后内容全展，内部无须滚动
    for (const pair of scrollers) {
      pair[0].scrollTop = Math.max(0, Math.min(pair[1], pair[0].scrollHeight - pair[0].clientHeight));
    }
  });
}

// 时长显示口径（单点）：纯数字 → 取整加 s；带单位（s/秒）→ 原样；空 → ''
export function durText(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/[a-z秒sS]$/.test(s)) return s;
  const n = parseFloat(s);
  return isNaN(n) ? s : Math.round(n) + 's';
}

// 时长刻度显示单点（F1-P6）：先 floor 再出分秒（与导出/场头总时长同口径）；compact＝不足 60″ 只给秒
export function durTick(sec, opts) {
  const t = Math.max(0, Math.floor(sec || 0));
  if (opts && opts.compact && t < 60) return t + '\u2033';
  return Math.floor(t / 60) + '\u2032' + String(t % 60).padStart(2, '0') + '\u2033';
}

// 滚动到位并闪烁（跳镜/定位共用单点；1600ms 单一常量）
export function flashIntoView(node, opts) {
  if (!node) return false;
  try { node.scrollIntoView({ block: (opts && opts.block) || 'nearest' }); } catch (e) { /* ignore */ }
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
  return true;
}


// 浮层豁免单点（批4/L1 + F1-B5）：结构浮层根名单；点外监听一律走这里，勿再手抄。
// .scene-freeze（吸顶场头）是在流页面元素、不挂 .float-card：天然不算浮层（F1-B5）。
// opts.prompt：附加「提示词预览 / 提示词列」（抽屉点外判定用）。
const FLOAT_SEL = '.float-card, .menu, #draft-card, #hist-panel, #sel-bar, .ai-diff, [id^="ai-"], .cmdk-mask, .audit-card-tr, .audit-card';   // F3-W28 收敛；F5-P1：⌘K 模态层 + 审计行内卡（退浮层类，改走名单）入豁免
const FLOAT_SEL_PROMPT = FLOAT_SEL + ', .prompt-box, .cell-prompt';
export function isFloatTarget(t, opts) {
  if (!t || !t.closest) return false;
  return !!t.closest((opts && opts.prompt) ? FLOAT_SEL_PROMPT : FLOAT_SEL);
}

// 「是否输入中」单点（F1-P9）：编辑面/输入框内不劫持全局键；opts.select＝把 SELECT 也算输入中
export function isTypingTarget(t, opts) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return true;
  return tag === 'SELECT' && !!(opts && opts.select);
}

// 浮层翻转定位单点（F2-P5）：优先锚点下方，越界翻上方；返回 {x, y, flipped}。
// gapBelow/gapAbove＝下/上间距；maxBottom＝夹取下边界（默认视口底）；pad 边缘留白。
// 就近浮层定位单点（F4-W24）：anchor 元素 | {x,y} | 矩形 → 下方贴放、放不下翻上、夹回视口；
// rAF 合并（F4-W18④）：每卡每帧只算一次（滚动跟随高频触发时不抖）。
const PLACE_FALLBACK = { left: 24, right: 24, top: 80, bottom: 80 };
export function placeNear(anchor, card) {
  if (card.__placeNear) return;
  card.__placeNear = true;
  requestAnimationFrame(() => {
    card.__placeNear = false;
    let a;
    if (anchor && anchor.nodeType === 1) a = anchor.getBoundingClientRect();
    else if (anchor && anchor.x != null) a = { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    else a = anchor || PLACE_FALLBACK;
    const w = card.offsetWidth, h = card.offsetHeight;
    let y = a.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, a.top - h - 8);
    const x = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  });
}

export function placeFlip(anchorRect, boxW, boxH, opts) {
  const o = opts || {};
  const gapBelow = o.gapBelow == null ? 4 : o.gapBelow;
  const gapAbove = o.gapAbove == null ? 4 : o.gapAbove;
  const pad = o.pad == null ? 8 : o.pad;
  const vw = o.vw || window.innerWidth;
  const vh = o.vh || window.innerHeight;
  const maxBottom = o.maxBottom == null ? vh : o.maxBottom;
  const padX = o.padX == null ? pad : o.padX;
  let x = anchorRect.left;
  let y = anchorRect.bottom + gapBelow;
  let flipped = false;
  if (y + boxH > maxBottom - pad) {
    y = Math.max(pad, anchorRect.top - boxH - gapAbove);
    flipped = true;
  }
  x = Math.max(padX, Math.min(x, vw - boxW - padX));
  return { x: x, y: y, flipped: flipped };
}

// 点外关闭 + Esc 单点（F2-W23）：浮层根 el；返回 cleanup。
// opts：onEsc 返回 true 则让位（如「菜单优先」优先级）；keepFocus＝内部 mousedown preventDefault；
// closeOnScroll / closeOnResize＝附加收起条件；floatExempt＝浮层内点击不算点外；stopProp 默认 true。
export function onOutsideClose(el, onClose, opts) {
  const o = opts || {};
  const onDown = (e) => {
    if (el.contains(e.target)) {
      if (o.keepFocus) e.preventDefault();
      return;
    }
    if (o.floatExempt && isFloatTarget(e.target)) return;
    onClose('down');
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (o.onEsc && o.onEsc()) return;      // 让位（菜单优先等规则随单点）
    e.preventDefault();
    if (o.stopProp !== false) e.stopPropagation();
    onClose('esc');
  };
  const onScroll = o.closeOnScroll ? ((e) => { if (!el.contains(e.target)) onClose('scroll'); }) : null;
  const onResize = o.closeOnResize ? (() => onClose('resize')) : null;
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  if (onScroll) document.addEventListener('scroll', onScroll, true);
  if (onResize) window.addEventListener('resize', onResize);
  return function cleanup() {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (onScroll) document.removeEventListener('scroll', onScroll, true);
    if (onResize) window.removeEventListener('resize', onResize);
  };
}


// 稳定帧复绘单点（F2-L3 上提；M5 批1·N2 实测）：交互同步窗口内量到的 rect 可能是
// 重排前值（分组模式首绘偏 ~6.9px、不自愈）——「首绘 + 下一帧补绘」两步：
// 调用方先同步首绘，再调本件排一次补绘；连发高频自行合并（key 范式同 selection.paintSoon）。
export function stableRepaint(draw) {
  return requestAnimationFrame(draw);
}


// ── M5f：滚轮护栏 —— 面板 / 块库 / 菜单范围内，光标下没有任何「可消费本方向滚轮」的
//    滚动层时吞掉滚轮事件，防止滚动链穿透到分镜表（实测三种泄漏：非滚动区链滚 /
//    滚动到边界继续滚 / 块库边缘链滚）。内层能滚的场合一律放行，浏览器自己滚它。
function wheelCanConsume(el0, dy) {
  const oy = getComputedStyle(el0).overflowY;
  if (oy !== 'auto' && oy !== 'scroll') return false;
  const max = el0.scrollHeight - el0.clientHeight;
  if (max <= 0) return false;
  return dy < 0 ? el0.scrollTop > 0 : el0.scrollTop < max - 1;
}
// 装点＝boot()（F1-B4：原先只在提示词抽屉首开时安装，此前窗口没有护栏）；
// 名单＝全部浮层滚动根（scene-freeze 已不挂 .float-card，天然不匹配）
export function installWheelGuards() {
  once('wheel-guards', () => {
    document.addEventListener('wheel', (ev) => {
      const t = ev.target;
      if (!(t instanceof Element) || !ev.deltaY) return;
      if (!t.closest('.menu, .float-card, #hist-panel, .cmdk-mask')) return;   // F5-P1：⌘K 入护栏名单
      let n = t;
      while (n && n !== document.documentElement) {
        if (wheelCanConsume(n, ev.deltaY)) return;     // 有可消费的内层 → 放行
        n = n.parentElement;
      }
      ev.preventDefault();                             // 无处可滚 → 吞掉，防穿到分镜表
    }, { passive: false, capture: true });
  });
}

// ── F5 底座小件 ──

// 失败 toast 单点（F5-D9）：机制统一（前缀 + 错误消息）；前缀词各站自定
export function failToast(prefix, err) {
  toast(prefix + '：' + (err && err.message ? err.message : String(err == null ? '' : err)), 'err');
}

// 时间戳显示单点（F5-P8③）：'hms'＝时:分:秒；'md-hm'＝月-日 时:分；数字入参＝epoch 毫秒
export function fmtStamp(s, mode) {
  if (typeof s === 'number') {
    const d = new Date(s);
    const p = (n) => String(n).padStart(2, '0');
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (mode === 'hms') return hm + ':' + p(d.getSeconds());
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm;
  }
  const t = String(s == null ? '' : s);
  return mode === 'hms' ? t.slice(11, 19) : t.slice(5, 16);
}

// 拖放指示类清单（F5-W29）：同族指示类单点（以 drag.js 原「单次选择器清单」为模板）
export const DND_DROP = ['drop-before', 'drop-after', 'drop-end', 'beat-drop-before', 'beat-drop-after'];
export const DND_MARKS = DND_DROP.concat(['dragging']);
export function clearDndMarks(root, names) {
  const list = names || DND_MARKS;
  const scope = root || document;
  scope.querySelectorAll('.' + list.join(', .')).forEach((n) => { for (const c of list) n.classList.remove(c); });
}

// 面板占位单点（F5-W22）：「加载中…／加载失败：」两态 + 错误色类（F5-W20）
export function stageText(el0, kind, err) {
  if (kind === 'loading') { el0.textContent = '加载中…'; el0.classList.remove('err-note'); return; }
  el0.textContent = '加载失败：' + (err && err.message ? err.message : String(err == null ? '' : err));
  el0.classList.add('err-note');
}

// 按钮忙碌模板（F5-W16）：禁用 → 跑 → finally 恢复（失败 toast 由任务自理）
export async function busy(btn, task) {
  if (btn) btn.disabled = true;
  try { return await task(); } finally { if (btn) btn.disabled = false; }
}
