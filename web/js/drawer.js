// 浮层抽屉基件（M5 批3「右缘抽屉体系」）
// 形态基准 = 旧版提示词面板：浮动卡片 + 标题栏拖拽 + 八向缩放 + 贴附（右/下）+ 钉住 + 位置尺寸记忆。
// 按钮行由使用方按序装配（panel-btn 统一样式：红底白字 11px 中文全词）。
import { el, lsGet, lsSet, clamp, readVarPx, trackDrag, onResizeCoalesced, flashClass, isTypingTarget, isFloatTarget, silent } from './ui.js';

const MIN_W = 320, MIN_H = 200;
// 屏内夹取与停靠常量单点（F3-W23：原先六处手抄同一组数）
const EDGE = { left: 120, top: 0, bottom: 60, defGap: 18, defTop: 44 };
const MAX_RATIO = 0.9, DEF_H_RATIO = 0.72;
const DOCK = {
  right: { w: 500, gap: 8, bottomGap: 12 },
  bottom: { inset: 40, gap: 8, vhRatio: 0.45 },
};
function clampToScreen(left, top, w, h) {
  const vw = window.innerWidth, vh = window.innerHeight;
  return {
    left: clamp(left, EDGE.left - w, vw - EDGE.left),
    top: clamp(top, EDGE.top, Math.max(0, vh - EDGE.bottom)),
  };
}
const LS = (id) => 'studio.drawer.' + id;

// 吸顶区上界：顶栏高度读 CSS 变量（F1-B6：与顶栏实测同一来源；旧 .topbar 选择器已不存在）
function headTop() {
  const h = readVarPx('--topbar-h');
  return Math.max(48, h || 0) + 6;
}

// 活动抽屉栈：Esc 焦点在两抽屉之外时只让最后打开的抽屉接管（F4-W39）
const ACTIVE = [];

// Esc 优先级阶梯单点（F4-W39）：菜单自管 → 焦点在别家抽屉让给它 → 别处输入不介入 → 焦点在两家之外只顶层接管 → onEsc
export function bindDrawerEsc(dr, onEsc) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!dr.isOpen()) return;
    const t = e.target;
    if (t && t.closest && t.closest('.menu')) return;                        // 菜单自管优先
    const inDrawer = !!(t && dr.el.contains(t));
    if (!inDrawer && t && t.closest && t.closest('.drawer')) return;        // 焦点在别的抽屉：让它家处理
    if (!inDrawer && isTypingTarget(t)) return;                               // 别处编辑中：不介入
    if (!inDrawer && ACTIVE[ACTIVE.length - 1] !== dr) return;               // 焦点在两家之外：只让最后打开的抽屉接管
    onEsc();
  });
}

export function createDrawer(opts) {
  const id = opts.id;
  const frame = el('div', 'drawer float-card');   // F3-W28：挂基类（点名豁免名单随之收窄）
  if (opts.id) frame.dataset.drawer = opts.id;
  frame.hidden = true;
  const head = el('div', 'drawer-head');
  const title = el('div', 'drawer-title');
  const btns = el('div', 'drawer-btns');
  head.appendChild(title);
  head.appendChild(btns);
  const body = el('div', 'drawer-body');
  frame.appendChild(head);
  frame.appendChild(body);

  const st = { open: false, pinned: false, dock: null, entering: false };
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

  // 浮动落点四连写（F3-W23）：左/上 + 右/底解锁
  function freeRect(left, top) {
    frame.style.left = Math.round(left) + 'px';
    frame.style.top = Math.round(top) + 'px';
    frame.style.right = 'auto';
    frame.style.bottom = 'auto';
    emitGeom();                                    // F3-L1：几何契约通知（rAF 合并）
  }

  // ── 记忆 ──
  function saveState() {
    if (!st.open) return;                        // 落盘意图显式挂开合态（F3-W24②：原先藏在 frame.hidden 里）
    const r = frame.getBoundingClientRect();
    lsSet(LS(id), {
      dock: st.dock,
      left: Math.round(r.left), top: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    });
  }

  function applyRect() {
    const m = lsGet(LS(id), null) || {};
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = clamp(Number(m.width) || opts.width || 500, MIN_W, Math.round(vw * MAX_RATIO));
    const h = clamp(Number(m.height) || Math.round(vh * DEF_H_RATIO), MIN_H, Math.round(vh * MAX_RATIO));
    if (m.dock === 'right' || m.dock === 'bottom') { st.dock = m.dock; applyDockGeom(m.dock); return; }
    st.dock = null;
    const left = Number.isFinite(m.left) ? m.left : (vw - w - EDGE.defGap);
    const top = Number.isFinite(m.top) ? m.top : headTop() + EDGE.defTop;
    const p = clampToScreen(left, top, w, h);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    freeRect(p.left, p.top);
  }

  // side: 'right' 全高贴右缘 · 'bottom' 全宽贴底（数值见 DOCK 单点）
  function applyDockGeom(side) {                 // 纯几何（F3-W24①：副作用走 dockTo）
    const vh = window.innerHeight;
    if (side === 'right') {
      const top = headTop();
      frame.style.left = 'auto'; frame.style.right = DOCK.right.gap + 'px';
      frame.style.top = top + 'px'; frame.style.bottom = 'auto';
      frame.style.width = DOCK.right.w + 'px';
      frame.style.height = Math.max(MIN_H, vh - top - DOCK.right.bottomGap) + 'px';
    } else {
      frame.style.left = DOCK.bottom.inset + 'px'; frame.style.right = DOCK.bottom.inset + 'px';
      frame.style.top = 'auto'; frame.style.bottom = DOCK.bottom.gap + 'px';
      frame.style.width = 'auto';
      frame.style.height = Math.round(vh * DOCK.bottom.vhRatio) + 'px';
    }
    emitGeom();                                    // F3-L1：几何契约通知
  }
  function dockTo(side) {                        // 几何 + 落盘 + 回弹（按钮通道）
    st.dock = side;
    applyDockGeom(side);
    saveState();
    bounce();
  }

  // 入场动画：一次性 .enter（播完即摘——常驻会导致回弹类摘除时动画重播=「多闪一次」）
  // F3-L1：entering 状态单点（几何契约读它，不再由消费方嗅探 .enter 类）；播毕发几何通知
  function playIn() {
    clearTimeout(tIn);
    st.entering = true;
    tIn = flashClass(frame, 'enter', 400, {                    // F3-W25 单点
      clear: ['snap-bounce'],
      onEnd: () => { st.entering = false; if (st.open) emitGeom(); },
    });
  }

  function bounce() {
    // 先清入场类（flashClass 内）：回弹结束摘类时无动画可回退，防重播
    clearTimeout(tBn);
    st.entering = false;                                       // F3-L1：回弹接手入场（enter 随摘）
    tBn = flashClass(frame, 'snap-bounce', 360, { clear: ['enter'] });
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
    trackDrag((ev) => {                            // F3-W27①：三件套单点
      const p = clampToScreen(ev.clientX - ox, ev.clientY - oy, r.width, r.height);
      freeRect(p.left, p.top);
    }, () => {
      frame.classList.remove('dragging');
      saveState();
    });
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
    trackDrag((ev) => {                            // F3-W27①
      const w = clamp(r.width + dx * (ev.clientX - sx), MIN_W, Math.round(window.innerWidth * MAX_RATIO));
      const h = clamp(r.height + dy * (ev.clientY - sy), MIN_H, Math.round(window.innerHeight * MAX_RATIO));
      let left = r.left, top = r.top;
      if (dx < 0) left = r.left + (r.width - w);
      if (dy < 0) top = r.top + (r.height - h);
      frame.style.width = Math.round(w) + 'px';
      frame.style.height = Math.round(h) + 'px';
      freeRect(left, top);
    }, () => {
      frame.classList.remove('dragging');
      saveState();
    });
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
      onClick: () => dockTo(side),
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
  // 点外过滤链单点（F2-L3 收编）：浮卡/菜单豁免名单（floatPrompt 开则含提示词列）→ 钉住不触发 → 交 onOutside。
  // 各抽屉只写「真点外要做什么」；原先 scriptdrawer/hotbox 两处手抄同一链（逐字同构）已退役。
  const onDoc = (e) => {
    if (!st.open) return;
    if (frame.contains(e.target)) return;
    if (isFloatTarget(e.target, { prompt: !!opts.floatPrompt })) return;
    if (st.pinned) return;
    if (opts.onOutside) opts.onOutside(e);
  };

  function open() {
    if (st.open) return;
    st.open = true;
    ACTIVE.push(dr);                                  // F4-W39：Esc 归属
    frame.hidden = false;
    applyRect();
    frame.classList.add('open');
    playIn();
    document.addEventListener('mousedown', onDoc, true);
  }

  function close() {
    if (!st.open) return;
    saveState();
    st.open = false;
    st.pinned = false;
    if (pinBtn) pinBtn.classList.remove('pinned');
    frame.classList.remove('open', 'enter', 'snap-bounce');
    frame.hidden = true;
    st.entering = false;                             // F3-L1：关即中断入场
    clearTimeout(tIn);                               // F3-W25：关掉入场/回弹计时器（原先悬挂，当前无害）
    clearTimeout(tBn);
    emitGeom();                                      // F3-L1：关闭通知（订阅方据此隐藏）
    document.removeEventListener('mousedown', onDoc, true);
    const ai = ACTIVE.indexOf(dr);
    if (ai !== -1) ACTIVE.splice(ai, 1);
    if (opts.onClose) opts.onClose();
  }

  // 视口变化：贴附的重新贴，浮动的拉回屏内（rAF 合并单点：F3-W27③）
  onResizeCoalesced(() => {
    if (!st.open) return;
    if (st.dock) { applyDockGeom(st.dock); return; }
    const r = frame.getBoundingClientRect();
    const p = clampToScreen(r.left, r.top, r.width, r.height);
    freeRect(p.left, p.top);
  });

  // 标准钮组单点（F3-W31）：贴底 / 贴右 / 钉住 / 编辑 / 复制 / ✕（两条抽屉原先逐字两份）
  function addStandardButtons(so) {
    so = so || {};
    addDockButton('bottom');
    addDockButton('right');
    addPinButton();
    const tb = addButton('编辑', { title: so.toggleTitle || '编辑', onClick: so.onToggleMode });
    addButton('复制', { title: so.copyTitle || '复制', onClick: so.onCopy });
    addCloseButton(so.onClose);
    return tb;
  }

  // ── 几何契约（F3-L1）：对外只读几何 + 变更订阅 + 贴紧标记收编 ──
  // geom()：open/pinned/dock/entering + frame 四元组。offset* 不受 transform/动画影响
  // （免疫「动画期 rect 漂」）；drawer 恒为 fixed 浮层（body 直属），offsetLeft/Top 即视口坐标。
  // 注意：close 后 frame 隐藏，几何读数为 0（订阅方应以 open 判定先行）。
  function geom() {
    return {
      open: st.open, pinned: st.pinned, dock: st.dock, entering: st.entering,
      left: frame.offsetLeft, top: frame.offsetTop,
      width: frame.offsetWidth, height: frame.offsetHeight,
    };
  }
  // onGeom(cb)：几何/贴附/开合/入场完成变化时回调（rAF 合并——每帧至多一次）；返回退订。
  const geomSubs = new Set();
  let geomRaf = 0;
  function emitGeom() {
    if (!geomSubs.size || geomRaf) return;
    geomRaf = requestAnimationFrame(() => {
      geomRaf = 0;
      const g = geom();
      for (const cb of geomSubs) { try { cb(g); } catch (e) { silent(e, 'drawer-geom'); } }
    });
  }
  function onGeom(cb) {
    geomSubs.add(cb);
    return () => { geomSubs.delete(cb); };
  }
  // setUnder(mode)：贴紧标记（'none'|'left'|'up'）——往抽屉写类收编在此（含镜像抑制，
  // 防「写类→观察者回调」回路；F3-W22 原先由块库卡反向往抽屉写）。
  let underApplied = null;
  function setUnder(mode) {
    if (mode === underApplied) return;
    underApplied = mode;
    frame.classList.toggle('bc-under', mode !== 'none');
    frame.classList.toggle('bc-under-up', mode === 'up');
  }

  const dr = {
    el: frame, bodyEl: body, headEl: head, titleEl: title, btnsEl: btns,
    open, close,
    isOpen: () => st.open,
    isPinned: () => st.pinned,
    setTitle: (t) => { title.textContent = t; title.title = t; },
    addButton, addPinButton, addDockButton, addCloseButton, addStandardButtons,
    getDock: () => st.dock,
    geom, onGeom, setUnder,                          // F3-L1 几何契约
  };
  return dr;
}
