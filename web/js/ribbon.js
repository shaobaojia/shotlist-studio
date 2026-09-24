// 挂件带 v2.1（M5k-2）——底部冻结通栏 + 向上浮层。
// 一条条带三种读法：①竖向高/色＝景别 ②横向宽＝时长（横轴＝时间刻度尺）③情绪曲线叠加（平滑曲线+数据点）。
// 交互：上沿拖拽＝面板高矮（窗口式）；滚轮＝横向缩放（时间轴式，光标锚定）；中键拖拽＝平移；shift+滚轮＝横滚。
import { el, toast, durTick } from './ui.js';
import { jumpToShotById } from './filter.js';

const KEY = 'studio.dock';
// 档位：按前缀匹配（长词在前，防「中近/中景」互截）
const TIER_SEQ = ['全景', '中全', '中景', '中近', '近景', '特写', '极特'];
const TIER_MATCH = ['极特', '特写', '近景', '中近', '中景', '中全', '全景'];
const TIER_H = [10, 14, 18, 22, 26, 30, 34];   // 基准高度（44 高铁带内）
const H_FLAT = 16;
const BASE_V = 44;                              // 条带基准高（ST.h 以此为 1）
const PXS = 8, MINW = 6, MAXW = 160, GAP_IDX = 4, GAP_TIME = 1, SLOT = 22;
const ZMIN = 0.35, ZMAX = 4;

let ST = { open: false, size: true, rhythm: false, mood: false, h: 44, zoom: 1 };
let _bt = 0, _sv = 0;

// ── 悬浮提示（300ms 延时；取代原生 title——原生延时不可控且 ~1s）──
let _tipEl = null, _tipT = 0;
function tipHide() {
  if (_tipT) { clearTimeout(_tipT); _tipT = 0; }
  if (_tipEl) _tipEl.hidden = true;
}
function tipShow(tgt) {
  if (!tgt.isConnected) return;
  const txt = tgt.dataset.tip || '';
  if (!txt) return;
  if (!_tipEl) { _tipEl = el('div', 'dk-tip'); _tipEl.hidden = true; document.body.appendChild(_tipEl); }
  _tipEl.textContent = txt;
  _tipEl.hidden = false;
  const r = tgt.getBoundingClientRect();
  const w = _tipEl.offsetWidth, vw = document.documentElement.clientWidth;
  _tipEl.style.left = Math.round(Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8)) + 'px';
  _tipEl.style.bottom = Math.round(window.innerHeight - r.top + 9) + 'px';
}
function bindTip(node) {
  node.addEventListener('mouseenter', () => { if (_tipT) clearTimeout(_tipT); _tipT = setTimeout(() => tipShow(node), 300); });
  node.addEventListener('mouseleave', tipHide);
  node.addEventListener('click', tipHide);
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return;
    ST.open = !!o.open;
    if ('size' in o) ST.size = !!o.size;
    if ('rhythm' in o) ST.rhythm = !!o.rhythm;
    if ('mood' in o) ST.mood = !!o.mood;
    if (typeof o.h === 'number') ST.h = clamp(Math.round(o.h), 40, 380);
    if (typeof o.zoom === 'number') ST.zoom = clamp(o.zoom, ZMIN, ZMAX);
  } catch (e) { /* ignore */ }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch (e) { /* ignore */ }
}

function tierOf(str) {
  const v = String(str == null ? '' : str);
  for (const t of TIER_MATCH) if (v.indexOf(t) === 0) return t;
  return null;
}
export function numOf(v) {
  const m = String(v == null ? '' : v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function jump(id) {
  if (!jumpToShotById(id)) toast('该镜不在当前视图（可能被筛选隐藏）');
}

// Catmull-Rom → 三次贝塞尔（平滑曲线）
function smoothPath(pts) {
  if (!pts.length) return '';
  const r = (v) => Math.round(v * 10) / 10;
  if (pts.length === 1) return 'M' + r(pts[0].x) + ' ' + r(pts[0].y) + ' L' + r(pts[0].x + 8) + ' ' + r(pts[0].y);
  let d = 'M' + r(pts[0].x) + ' ' + r(pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ' C' + r(c1x) + ' ' + r(c1y) + ' ' + r(c2x) + ' ' + r(c2y) + ' ' + r(p2.x) + ' ' + r(p2.y);
  }
  return d;
}

// ── 入口：底部挂件带（无镜头返回 null）──
export function buildRibbon(data, shots) {
  if (!shots || !shots.length) return null;
  load();
  const NS = 'http://www.w3.org/2000/svg';
  const root = el('div', 'dock');
  root.dataset.open = ST.open ? '1' : '0';

  // ── 浮层 ──
  const panel = el('div', 'dk-panel');
  const rz = el('div', 'dk-rz');                    // 上沿：窗口式拖拽缩放
  rz.appendChild(el('span', 'dk-grip'));
  panel.appendChild(rz);
  const scroll = el('div', 'dk-scroll');
  const inner = el('div', 'dk-inner');
  const strip = el('div', 'dk-strip');
  const axis = el('div', 'dk-axis');
  inner.appendChild(strip);
  inner.appendChild(axis);
  scroll.appendChild(inner);
  panel.appendChild(scroll);
  const moodHint = el('div', 'dk-mood-empty', '情绪温度未填写——点节拍头上的「温度」芯片填（0–10），或用选区条「设值…」套到节拍');
  panel.appendChild(moodHint);

  // 条条
  const bars = [];
  for (const s of shots) {
    const b = el('button', 'dk-b');
    b.type = 'button';
    b.dataset.tip = '镜 ' + (s.shot_no || '') + ' · ' + (s.shot_size || '未填景别') + (s.duration ? ' · ' + s.duration + 's' : '') + ' · 点击跳镜';
    b.setAttribute('aria-label', b.dataset.tip);
    bindTip(b);
    b.addEventListener('click', () => jump(s.id));
    strip.appendChild(b);
    bars.push(b);
  }
  // 索引模式轴标
  const labels = [];
  for (let i = 0; i < shots.length; i++) {
    const l = el('span', 'dk-lab');
    axis.appendChild(l);
    labels.push(l);
  }

  // ── 情绪数据点（按节拍；平滑曲线叠加）──
  const segs = [];
  (data.beats || []).forEach((b) => {
    const arr = b.shots || [];
    if (!arr.length) return;
    const i0 = shots.indexOf(arr[0]), i1 = shots.indexOf(arr[arr.length - 1]);
    if (i0 < 0 || i1 < 0) return;
    segs.push({ i0, i1, v: numOf(b.mood_temp), firstId: arr[0].id, name: b.name || ('节拍' + b.beat_no) });
  });
  const hasMood = segs.some((t) => t.v != null);
  if (hasMood && !ST.mood) { ST.mood = true; save(); }   // 有数据＝自动显示（切场即出）
  const mx = Math.max(10, ...segs.map((t) => (t.v == null ? 0 : t.v)));
  let svg = null, pHalo = null, pMain = null;
  if (hasMood) {
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'dk-mood');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(ST.h));
    pHalo = document.createElementNS(NS, 'path');
    pHalo.setAttribute('class', 'dk-mph');
    pMain = document.createElementNS(NS, 'path');
    pMain.setAttribute('class', 'dk-mp');
    svg.appendChild(pHalo);
    svg.appendChild(pMain);
    for (const t of segs) {
      if (t.v == null) continue;
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '3');
      dot.setAttribute('class', 'dk-mdot');
      dot.style.pointerEvents = 'auto';
      dot.style.cursor = 'pointer';
      dot.dataset.tip = t.name + ' · 温度 ' + t.v;
      bindTip(dot);
      const fid = t.firstId;
      dot.addEventListener('click', () => jump(fid));
      svg.appendChild(dot);
      t._dot = dot;
    }
    strip.appendChild(svg);
  }
  function drawCurve() {
    if (!svg) return;
    const vh = ST.h / BASE_V;
    const Y = (v) => (40 - (v / mx) * 32) * vh;
    const pts = [];
    for (const t of segs) {
      if (t.v == null) continue;
      const x0 = parseFloat(bars[t.i0].style.left) || 0;
      const xEnd = (parseFloat(bars[t.i1].style.left) || 0) + (parseFloat(bars[t.i1].style.width) || 0);
      pts.push({ x: (x0 + xEnd) / 2, y: Y(t.v), t });
    }
    if (!pts.length) return;
    const fb = pts[0].t, lb = pts[pts.length - 1].t;
    const lx = parseFloat(bars[fb.i0].style.left) || 0;
    const rx = (parseFloat(bars[lb.i1].style.left) || 0) + (parseFloat(bars[lb.i1].style.width) || 0);
    const full = [{ x: lx, y: pts[0].y }].concat(pts).concat([{ x: rx, y: pts[pts.length - 1].y }]);
    const d = smoothPath(full);
    pHalo.setAttribute('d', d);
    pMain.setAttribute('d', d);
    for (const p of pts) {
      const dot = p.t._dot;
      if (dot) { dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); }
    }
    svg.setAttribute('height', String(ST.h));   // 宽度走 CSS 100%（build 时 offsetWidth=0，数值覆盖会致 1px 宽→曲线被裁）
    if (!svg.style.width) svg.style.width = '100%';
  }

  // ── 布局 ──
  function layout(animate) {
    tipHide();
    const z = ST.zoom, vh = ST.h / BASE_V;
    inner.style.height = (ST.h + 18) + 'px';
    strip.style.height = ST.h + 'px';
    const timeMode = ST.rhythm;
    const xs = [], ws = [];
    let acc = 0;
    for (let i = 0; i < shots.length; i++) {
      let w, gap;
      if (timeMode) {
        const d = numOf(shots[i].duration) || 0;
        w = clamp(Math.round(d * PXS * z), Math.max(4, Math.round(MINW * z)), Math.round(MAXW * z));
        gap = GAP_TIME;
      } else {
        w = Math.round(SLOT * z);
        gap = Math.max(2, Math.round(GAP_IDX * z));
      }
      xs.push(acc); ws.push(w); acc += w + gap;
    }
    const lastGap = timeMode ? GAP_TIME : Math.max(2, Math.round(GAP_IDX * z));
    inner.style.width = Math.max(acc - lastGap, 40) + 'px';
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], s = shots[i];
      b.style.left = xs[i] + 'px';
      b.style.width = ws[i] + 'px';
      if (ST.size) {
        const t = tierOf(s.shot_size);
        const lv = t ? TIER_SEQ.indexOf(t) + 1 : 0;
        b.dataset.lv = String(lv);
        b.style.height = Math.round((t ? TIER_H[lv - 1] : 14) * vh) + 'px';
      } else {
        b.dataset.lv = '';
        b.style.height = Math.round(H_FLAT * vh) + 'px';
      }
    }
    unitEl.textContent = timeMode ? '轴·时长' : '轴·镜号';
    legendEl.textContent = ST.size ? '红＝近/特写 · 点击跳镜' : '点击跳镜';
    renderAxis(animate);
    if (svg) {
      if (animate && ST.mood) {                     // 换轴：曲线淡出→重定位→淡入
        svg.style.opacity = '0';
        clearTimeout(svg._t);
        svg._t = setTimeout(() => { drawCurve(); if (ST.mood) svg.style.opacity = ''; }, 210);
      } else {
        drawCurve();
      }
      svg.style.display = ST.mood ? '' : 'none';
    }
    syncMoodHint();
  }

  // 横轴：节奏开＝时间刻度尺；关＝每格镜号
  function renderAxis(fade) {
    const draw = () => {
      axis.textContent = '';
      if (ST.rhythm) {
        const pps = PXS * ST.zoom;
        let totalSec = 0;
        for (const s of shots) totalSec += (numOf(s.duration) || 0);
        const steps = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600];
        const step = steps.find((s) => s * pps >= 64) || 600;
        for (let t = 0; t <= totalSec + 0.001; t += step) {
          const tk = el('span', 'dk-tick');
          tk.style.left = Math.round(t * pps) + 'px';
          tk.textContent = durTick(t, { compact: true });
          axis.appendChild(tk);
        }
      } else {
        for (let i = 0; i < labels.length; i++) {
          const b = bars[i];
          const w = parseFloat(b.style.width) || 0;
          labels[i].style.left = (parseFloat(b.style.left) || 0) + 'px';
          labels[i].style.width = w + 'px';
          labels[i].textContent = w >= 14 ? (shots[i].shot_no || String(i + 1)) : '';
          axis.appendChild(labels[i]);
        }
      }
    };
    if (fade) {
      axis.classList.add('dk-faded');
      setTimeout(() => { draw(); axis.classList.remove('dk-faded'); }, 160);
    } else draw();
  }

  function syncMoodHint() {
    moodHint.style.display = (ST.mood && ST.open && !hasMood) ? '' : 'none';
  }

  function noanimBurst() {
    root.classList.add('dk-noanim');
    clearTimeout(_bt);
    _bt = setTimeout(() => root.classList.remove('dk-noanim'), 240);
  }

  // ── 缩放（滚轮，光标锚定）／平移（中键）／窗口拖拽（上沿）──
  panel.addEventListener('wheel', (e) => {          // 面板区域＝条条视口：滚轮缩放
    e.preventDefault();
    if (e.shiftKey) { scroll.scrollLeft += (e.deltaY || e.deltaX || 0); return; }
    const rect = scroll.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const oldTotal = inner.offsetWidth || 1;
    const ratio = (scroll.scrollLeft + cx) / oldTotal;
    const nz = clamp(ST.zoom * Math.exp(-e.deltaY * 0.0012), ZMIN, ZMAX);
    if (Math.abs(nz - ST.zoom) < 0.002) return;
    ST.zoom = nz;
    noanimBurst();
    layout(false);
    const newTotal = inner.offsetWidth || 1;
    scroll.scrollLeft = Math.max(0, ratio * newTotal - cx);
    clearTimeout(_sv);
    _sv = setTimeout(save, 320);
  }, { passive: false });

  panel.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;                       // 中键＝平移
    e.preventDefault();
    const sx = e.clientX, sl = scroll.scrollLeft;
    root.classList.add('dk-panning');
    const mv = (ev) => { scroll.scrollLeft = sl - (ev.clientX - sx); };
    const up = () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      root.classList.remove('dk-panning');
      save();
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });

  rz.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;                       // 上沿＝窗口式缩放
    e.preventDefault();
    e.stopPropagation();
    const sy = e.clientY, sv = ST.h;
    root.classList.add('dk-noanim');
    const mv = (ev) => {
      ST.h = clamp(Math.round(sv - (ev.clientY - sy)), 40, 380);
      layout(false);
    };
    const up = () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      noanimBurst();
      save();
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });

  // ── 底栏（三开关居中对齐、折叠态隐藏）──
  const bar = el('div', 'dk-bar');
  const caret = el('span', 'dk-caret', ST.open ? '▴' : '▾');
  bar.appendChild(caret);
  bar.appendChild(el('span', 'dk-label', '挂件带'));
  const unitEl = el('span', 'dk-unit', '轴·镜号');
  bar.appendChild(unitEl);
  const tgs = el('span', 'dk-tgs');
  const mkTg = (k, label, titleTxt) => {
    const b = el('button', 'dk-tg' + (ST[k] ? ' on' : ''), label);
    b.type = 'button';
    b.title = titleTxt;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      ST[k] = !ST[k];
      b.classList.toggle('on', ST[k]);
      save();
      layout(true);
    });
    tgs.appendChild(b);
  };
  mkTg('size', '景别序列', '竖向高度/色＝景别档（渐紧渐松一眼见）');
  mkTg('rhythm', '节奏视窗', '横向宽＝时长（横轴变时间刻度尺）');
  mkTg('mood', '情绪曲线', '情绪温度平滑曲线叠加在条条上（按节拍）');
  bar.appendChild(tgs);
  const legendEl = el('span', 'dk-legend', '');
  bar.appendChild(legendEl);
  bar.addEventListener('click', () => {
    ST.open = !ST.open;
    root.dataset.open = ST.open ? '1' : '0';
    caret.textContent = ST.open ? '▴' : '▾';
    save();
    syncMoodHint();
  });

  root.appendChild(panel);
  root.appendChild(bar);
  root.addEventListener('mouseleave', tipHide);
  root.classList.add('dk-noanim');
  layout(false);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('dk-noanim')));
  return root;
}
