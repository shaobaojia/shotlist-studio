// 挂件带 v2（M5k）——底部冻结通栏：收起＝一条吸底细带；展开＝向上浮层（不挤镜头）。
// 一条条带三种读法：①竖向高/色＝景别（渐紧渐松）②横向宽＝时长（横轴单位随之 镜号⇄时长）
// ③情绪曲线叠加共存。状态切换带 morph 动画（条条 left/width/height/背景 + 曲线淡入出 + 轴标换字）。
import { el, toast } from './ui.js';
import { jumpToShotById } from './filter.js';

const KEY = 'studio.dock';
// 档位：按前缀匹配（长词在前，防「中近/中景」互截）
const TIER_SEQ = ['全景', '中全', '中景', '中近', '近景', '特写', '极特'];
const TIER_MATCH = ['极特', '特写', '近景', '中近', '中景', '中全', '全景'];
const TIER_H = [10, 14, 18, 22, 26, 30, 34];   // 档位 1..7 高度（底对齐）
const H_FLAT = 16;                              // 景别关：等高中条
const PXS = 8, MINW = 12, MAXW = 160;           // 时长→px
const GAP_IDX = 4, GAP_TIME = 1, SLOT = 22;     // 索引槽 / 时间缝
const STRIP_H = 44;

let ST = { open: false, size: true, rhythm: false, mood: false };

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
function numOf(v) {
  const m = String(v == null ? '' : v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function fmtSec(d) {
  return String(d).replace(/\.0+$/, '') + '″';
}
function jump(id) {
  if (!jumpToShotById(id)) toast('该镜不在当前视图（可能被筛选隐藏）');
}

// ── 入口：底部挂件带（无镜头返回 null）──
export function buildRibbon(data, shots) {
  if (!shots || !shots.length) return null;
  load();
  const NS = 'http://www.w3.org/2000/svg';
  const root = el('div', 'dock');
  root.dataset.open = ST.open ? '1' : '0';

  // ── 浮层：条条带 + 横轴 ──
  const panel = el('div', 'dk-panel');
  const scroll = el('div', 'dk-scroll');
  const inner = el('div', 'dk-inner');
  const strip = el('div', 'dk-strip');
  const axis = el('div', 'dk-axis');
  inner.appendChild(strip);
  inner.appendChild(axis);
  scroll.appendChild(inner);
  panel.appendChild(scroll);
  const moodHint = el('div', 'dk-mood-empty', '情绪温度未填写——节拍行填「情绪温度」（如 7）后这里出曲线');
  panel.appendChild(moodHint);

  // 条条（绝对定位；left/width/height/背景全走 CSS 过渡）
  const bars = [];
  for (const s of shots) {
    const b = el('button', 'dk-b');
    b.type = 'button';
    b.title = '镜 ' + (s.shot_no || '') + ' · ' + (s.shot_size || '未填景别') + (s.duration ? ' · ' + s.duration + 's' : '') + ' · 点击跳镜';
    b.addEventListener('click', () => jump(s.id));
    strip.appendChild(b);
    bars.push(b);
  }
  // 轴标
  const labels = [];
  for (let i = 0; i < shots.length; i++) {
    const l = el('span', 'dk-lab');
    axis.appendChild(l);
    labels.push(l);
  }

  // ── 情绪曲线（按节拍跨段；叠加在条条上）──
  const segs = [];
  (data.beats || []).forEach((b) => {
    const arr = b.shots || [];
    if (!arr.length) return;
    const i0 = shots.indexOf(arr[0]), i1 = shots.indexOf(arr[arr.length - 1]);
    if (i0 < 0 || i1 < 0) return;
    segs.push({ i0, i1, v: numOf(b.mood_temp), firstId: arr[0].id, name: b.name || ('节拍' + b.beat_no) });
  });
  const hasMood = segs.some((t) => t.v != null);
  let svg = null;
  if (hasMood) {
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'dk-mood');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(STRIP_H));
    const mx = Math.max(10, ...segs.map((t) => (t.v == null ? 0 : t.v)));
    const Y = (v) => 40 - (v / mx) * 32;
    for (const t of segs) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('class', t.v == null ? 'dk-mp dk-mp-empty' : 'dk-mp');
      p.style.pointerEvents = 'auto';
      p.style.cursor = 'pointer';
      const ti = document.createElementNS(NS, 'title');
      ti.textContent = t.name + (t.v == null ? ' · 未填' : ' · 温度 ' + t.v);
      p.appendChild(ti);
      const fid = t.firstId;
      p.addEventListener('click', () => jump(fid));
      svg.appendChild(p);
      t._el = p;
      t._y = t.v == null ? 24 : Y(t.v);
    }
    // 节拍间连接线
    for (let k = 0; k < segs.length - 1; k++) {
      const ln = document.createElementNS(NS, 'line');
      ln.setAttribute('class', 'dk-mlk');
      svg.appendChild(ln);
      segs[k]._ln = ln;
    }
    strip.appendChild(svg);
  }
  function drawCurve() {
    if (!svg) return;
    for (let k = 0; k < segs.length; k++) {
      const t = segs[k];
      const x0 = parseFloat(bars[t.i0].style.left) || 0;
      const xEnd = (parseFloat(bars[t.i1].style.left) || 0) + (parseFloat(bars[t.i1].style.width) || 0);
      t._el.setAttribute('d', 'M' + x0 + ' ' + t._y + ' L' + Math.max(xEnd - 1, x0) + ' ' + t._y);
      if (t._ln) {
        const nxt = segs[k + 1];
        const xb = parseFloat(bars[nxt.i0].style.left) || 0;
        t._ln.setAttribute('x1', xEnd); t._ln.setAttribute('y1', t._y);
        t._ln.setAttribute('x2', xb); t._ln.setAttribute('y2', nxt._y);
      }
    }
  }

  // ── 布局：把状态写进条条（CSS 过渡负责 morph）──
  function layout(animate) {
    const timeMode = ST.rhythm;
    const xs = [], ws = [];
    let acc = 0;
    for (let i = 0; i < shots.length; i++) {
      let w, gap;
      if (timeMode) {
        const d = numOf(shots[i].duration) || 0;
        w = Math.max(MINW, Math.min(MAXW, Math.round(d * PXS)));
        gap = GAP_TIME;
      } else { w = SLOT; gap = GAP_IDX; }
      xs.push(acc); ws.push(w); acc += w + gap;
    }
    const total = Math.max(acc - (timeMode ? GAP_TIME : GAP_IDX), 40);
    inner.style.width = total + 'px';
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], s = shots[i];
      b.style.left = xs[i] + 'px';
      b.style.width = ws[i] + 'px';
      if (ST.size) {
        const t = tierOf(s.shot_size);
        const lv = t ? TIER_SEQ.indexOf(t) + 1 : 0;
        b.dataset.lv = String(lv);
        b.style.height = (t ? TIER_H[lv - 1] : 14) + 'px';
      } else {
        b.dataset.lv = '';
        b.style.height = H_FLAT + 'px';
      }
      const l = labels[i];
      l.style.left = xs[i] + 'px';
      l.style.width = ws[i] + 'px';
    }
    unitEl.textContent = timeMode ? '轴·时长' : '轴·镜号';
    legendEl.textContent = ST.size ? '红＝近/特写 · 点击跳镜' : '点击跳镜';
    relabel(animate);
    if (svg) {
      if (animate && ST.mood) {                       // 换轴时曲线淡出→重定位→淡入
        svg.style.opacity = '0';
        clearTimeout(svg._t);
        svg._t = setTimeout(() => {
          drawCurve();
          if (ST.mood) svg.style.opacity = '';
        }, 210);
      } else {
        drawCurve();
      }
      svg.style.display = ST.mood ? '' : 'none';
    }
    syncMoodHint();
  }

  function relabel(fade) {
    const apply = () => {
      const timeMode = ST.rhythm;
      for (let i = 0; i < labels.length; i++) {
        const w = parseFloat(bars[i].style.width) || 0;
        if (timeMode) {
          const d = numOf(shots[i].duration);
          labels[i].textContent = (d != null && w >= 22) ? fmtSec(d) : '';
        } else {
          labels[i].textContent = w >= 16 ? (shots[i].shot_no || String(i + 1)) : '';
        }
      }
    };
    if (fade) {
      axis.classList.add('dk-faded');
      setTimeout(() => { apply(); axis.classList.remove('dk-faded'); }, 160);
    } else apply();
  }

  function syncMoodHint() {
    moodHint.style.display = (ST.mood && ST.open && !hasMood) ? '' : 'none';
  }

  // ── 底栏 ──
  const bar = el('div', 'dk-bar');
  const caret = el('span', 'dk-caret', ST.open ? '▾' : '▴');
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
      if (!ST.open) { ST.open = true; root.dataset.open = '1'; caret.textContent = '▾'; }
      save();
      layout(true);
    });
    tgs.appendChild(b);
  };
  mkTg('size', '景别序列', '竖向高度/色＝景别档（渐紧渐松一眼见）');
  mkTg('rhythm', '节奏视窗', '横向宽＝时长（横轴单位随之在镜号⇄时长之间切换）');
  mkTg('mood', '情绪曲线', '情绪温度曲线叠加在条条上（按节拍）');
  bar.appendChild(tgs);
  const legendEl = el('span', 'dk-legend', '');
  bar.appendChild(legendEl);
  bar.addEventListener('click', () => {
    ST.open = !ST.open;
    root.dataset.open = ST.open ? '1' : '0';
    caret.textContent = ST.open ? '▾' : '▴';
    save();
    syncMoodHint();
  });

  root.appendChild(panel);
  root.appendChild(bar);
  root.classList.add('dk-noanim');
  layout(false);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('dk-noanim')));
  return root;
}
