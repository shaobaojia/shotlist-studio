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

// 一次性装配（F1-W21 单点）：同一 key 只执行一次（监听绑定/初始化）
const ONCE = {};
export function once(key, fn) {
  if (ONCE[key]) return false;
  ONCE[key] = true;
  fn();
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
const FLOAT_SEL = '.float-card, .menu, .drawer, .bcard, #block-manager, #draft-card, #hist-panel, #sel-bar, .ai-diff, [id^="ai-"]';
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
      if (!t.closest('.drawer, .bcard, .menu, .float-card, #hist-panel')) return;
      let n = t;
      while (n && n !== document.documentElement) {
        if (wheelCanConsume(n, ev.deltaY)) return;     // 有可消费的内层 → 放行
        n = n.parentElement;
      }
      ev.preventDefault();                             // 无处可滚 → 吞掉，防穿到分镜表
    }, { passive: false, capture: true });
  });
}
