// 浮层抽屉基件（M5 批3「右缘抽屉体系」）
// 形态基准 = 旧版提示词面板：浮动卡片 + 标题栏拖拽 + 八向缩放 + 贴附（右/下）+ 钉住 + 位置尺寸记忆。
// 按钮行由使用方按序装配（panel-btn 统一样式：红底白字 11px 中文全词）。
import { el } from './ui.js';

const MIN_W = 320, MIN_H = 200;
const LS = (id) => 'studio.drawer.' + id;

function lsGet(id) {
  try { return JSON.parse(localStorage.getItem(LS(id)) || 'null'); } catch (e) { return null; }
}
function lsSet(id, v) {
  try { localStorage.setItem(LS(id), JSON.stringify(v)); } catch (e) { /* ignore */ }
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 吸顶区上界：顶栏高度（右贴附/默认打开的顶界用）
function headTop() {
  const tb = document.querySelector('.topbar');
  return Math.max(48, tb ? tb.offsetHeight : 48) + 6;
}

export function createDrawer(opts) {
  const id = opts.id;
  const frame = el('div', 'drawer');
  frame.hidden = true;
  const head = el('div', 'drawer-head');
  const title = el('div', 'drawer-title');
  const btns = el('div', 'drawer-btns');
  head.appendChild(title);
  head.appendChild(btns);
  const body = el('div', 'drawer-body');
  frame.appendChild(head);
  frame.appendChild(body);

  const st = { open: false, pinned: false, dock: null };
  let tIn = null, tBn = null;

  // ── 八向缩放手柄 ──
  const DIRS = [['n', 0, -1], ['s', 0, 1], ['e', 1, 0], ['w', -1, 0],
                ['ne', 1, -1], ['nw', -1, -1], ['se', 1, 1], ['sw', -1, 1]];
  for (const d of DIRS) {
    const h = el('div', 'rz rz-' + d[0]);
    h.addEventListener('mousedown', (e) => startResize(e, d[1], d[2]));
    frame.appendChild(h);
  }
  document.body.appendChild(frame);

  // ── 记忆 ──
  function saveState() {
    if (frame.hidden) return;
    const r = frame.getBoundingClientRect();
    lsSet(id, {
      dock: st.dock,
      left: Math.round(r.left), top: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    });
  }

  function applyRect() {
    const m = lsGet(id) || {};
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = clamp(Number(m.width) || opts.width || 500, MIN_W, Math.round(vw * 0.9));
    const h = clamp(Number(m.height) || opts.height || Math.round(vh * 0.72), MIN_H, Math.round(vh * 0.9));
    if (m.dock === 'right' || m.dock === 'bottom') { st.dock = m.dock; applyDock(m.dock, true); return; }
    st.dock = null;
    let left = Number.isFinite(m.left) ? m.left : (vw - w - 18);
    let top = Number.isFinite(m.top) ? m.top : headTop() + 44;
    left = clamp(left, 120 - w, vw - 120);
    top = clamp(top, 0, Math.max(0, vh - 60));
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.left = Math.round(left) + 'px';
    frame.style.top = Math.round(top) + 'px';
    frame.style.right = 'auto';
    frame.style.bottom = 'auto';
  }

  // side: 'right' 全高贴右缘（宽 500）· 'bottom' 全宽贴底（高 45vh）
  function applyDock(side, silent) {
    const vh = window.innerHeight;
    st.dock = side;
    if (side === 'right') {
      const top = headTop();
      frame.style.left = 'auto'; frame.style.right = '8px';
      frame.style.top = top + 'px'; frame.style.bottom = 'auto';
      frame.style.width = '500px';
      frame.style.height = Math.max(MIN_H, vh - top - 12) + 'px';
    } else {
      frame.style.left = '40px'; frame.style.right = '40px';
      frame.style.top = 'auto'; frame.style.bottom = '8px';
      frame.style.width = 'auto';
      frame.style.height = Math.round(vh * 0.45) + 'px';
    }
    if (!silent) { saveState(); bounce(); }
  }

  // 入场动画：一次性 .enter（播完即摘——常驻会导致回弹类摘除时动画重播=「多闪一次」）
  function playIn() {
    frame.classList.remove('enter', 'snap-bounce');
    void frame.offsetWidth;
    frame.classList.add('enter');
    clearTimeout(tIn);
    tIn = setTimeout(() => frame.classList.remove('enter'), 400);
  }

  function bounce() {
    frame.classList.remove('enter', 'snap-bounce');   // 先清入场类：回弹结束摘类时无动画可回退，防重播
    void frame.offsetWidth;
    frame.classList.add('snap-bounce');
    clearTimeout(tBn);
    tBn = setTimeout(() => frame.classList.remove('snap-bounce'), 360);
  }

  // ── 拖拽（标题栏；按钮不触发）──
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('button')) return;
    e.preventDefault();
    const r = frame.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    frame.style.width = Math.round(r.width) + 'px';
    frame.style.height = Math.round(r.height) + 'px';
    st.dock = null;
    frame.classList.add('dragging');
    const move = (ev) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = clamp(ev.clientX - ox, 120 - r.width, vw - 120);
      const top = clamp(ev.clientY - oy, 0, vh - 60);
      frame.style.left = Math.round(left) + 'px';
      frame.style.top = Math.round(top) + 'px';
      frame.style.right = 'auto';
      frame.style.bottom = 'auto';
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      frame.classList.remove('dragging');
      saveState();
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  });

  // ── 缩放 ──
  function startResize(e, dx, dy) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = frame.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    st.dock = null;
    frame.classList.add('dragging');
    const move = (ev) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = clamp(r.width + dx * (ev.clientX - sx), MIN_W, Math.round(vw * 0.9));
      const h = clamp(r.height + dy * (ev.clientY - sy), MIN_H, Math.round(vh * 0.9));
      let left = r.left, top = r.top;
      if (dx < 0) left = r.left + (r.width - w);
      if (dy < 0) top = r.top + (r.height - h);
      frame.style.width = Math.round(w) + 'px';
      frame.style.height = Math.round(h) + 'px';
      frame.style.left = Math.round(left) + 'px';
      frame.style.top = Math.round(top) + 'px';
      frame.style.right = 'auto';
      frame.style.bottom = 'auto';
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      frame.classList.remove('dragging');
      saveState();
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }

  // ── 按钮装配 ──
  function addButton(label, cfg) {
    cfg = cfg || {};
    const b = el('button', 'panel-btn' + (cfg.cls ? ' ' + cfg.cls : ''), label);
    if (cfg.title) b.title = cfg.title;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cfg.onClick) cfg.onClick(b);
    });
    btns.appendChild(b);
    return b;
  }

  let pinBtn = null;
  function addPinButton() {
    pinBtn = addButton('钉住', {
      title: '钉住：点其他内容不关闭（切镜跟随）',
      onClick: () => {
        st.pinned = !st.pinned;
        pinBtn.classList.toggle('pinned', st.pinned);
      },
    });
    return pinBtn;
  }

  function addDockButton(side) {
    return addButton(side === 'right' ? '右贴附' : '下贴附', {
      title: side === 'right' ? '贴靠页面右缘（全高）' : '贴靠页面底部（全宽）',
      onClick: () => applyDock(side),
    });
  }

  function addCloseButton(fn) {
    return addButton('✕', {
      cls: 'btn-close',
      title: '关闭',
      onClick: () => { if (fn) fn(); else close(); },
    });
  }

  // ── 打开 / 关闭 ──
  const onDoc = (e) => {
    if (!st.open) return;
    if (frame.contains(e.target)) return;
    if (opts.onOutside) opts.onOutside(e);
  };

  function open() {
    if (st.open) return;
    st.open = true;
    frame.hidden = false;
    applyRect();
    frame.classList.add('open');
    playIn();
    document.addEventListener('mousedown', onDoc, true);
    if (opts.onOpen) opts.onOpen();
  }

  function close() {
    if (!st.open) return;
    saveState();
    st.open = false;
    st.pinned = false;
    if (pinBtn) pinBtn.classList.remove('pinned');
    frame.classList.remove('open', 'enter', 'snap-bounce');
    frame.hidden = true;
    document.removeEventListener('mousedown', onDoc, true);
    if (opts.onClose) opts.onClose();
  }

  // 视口变化：贴附的重新贴，浮动的拉回屏内
  window.addEventListener('resize', () => {
    if (!st.open) return;
    if (st.dock) { applyDock(st.dock, true); return; }
    const r = frame.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    frame.style.left = Math.round(clamp(r.left, 120 - r.width, vw - 120)) + 'px';
    frame.style.top = Math.round(clamp(r.top, 0, Math.max(0, vh - 60))) + 'px';
  });

  return {
    el: frame, bodyEl: body, headEl: head, titleEl: title, btnsEl: btns,
    open, close,
    isOpen: () => st.open,
    isPinned: () => st.pinned,
    setTitle: (t) => { title.textContent = t; title.title = t; },
    addButton, addPinButton, addDockButton, addCloseButton,
    dockRight: () => applyDock('right'),
    dockBottom: () => applyDock('bottom'),
    saveState,
  };
}
