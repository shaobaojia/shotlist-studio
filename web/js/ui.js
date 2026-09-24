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


// 浮层单点判定（批4/L1）：浮卡根统一挂 .float-card；点外监听一律走这里
export function isFloatTarget(t) {
  return !!(t && t.closest && t.closest('.float-card, .menu'));
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
