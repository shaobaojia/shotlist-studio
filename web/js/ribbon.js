// 挂件带（M5 批5 · 形态 B）——表头上方一条细带：默认收起、点开展示（低频件，不抢主体）。
// ① 景别序列条：一格一镜——高度/色阶＝档位（渐紧渐松一眼见）、同档相连（连续同景别现形）；点击跳镜。
// ② 节奏视窗：条长＝时长（时间轴）× 情绪温度曲线（按节拍读 mood_temp）；点击跳镜。
import { el, toast } from './ui.js';
import { jumpToShotById } from './filter.js';

const KEY = 'studio.ribbon';

// 档位：按前缀匹配（长词在前，防「中近/中景」互截）
const TIER_SEQ = ['全景', '中全', '中景', '中近', '近景', '特写', '极特'];
const TIER_MATCH = ['极特', '特写', '近景', '中近', '中景', '中全', '全景'];

function tierOf(str) {
  const v = String(str == null ? '' : str);
  for (const t of TIER_MATCH) if (v.indexOf(t) === 0) return t;
  return null;
}

function numOf(v) {
  const m = String(v == null ? '' : v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function isOpen() {
  try { return localStorage.getItem(KEY) === 'open'; } catch (e) { return false; }   // 默认收起
}
function setOpen(v) {
  try { localStorage.setItem(KEY, v ? 'open' : 'closed'); } catch (e) { /* ignore */ }
}

function jump(id) {
  if (!jumpToShotById(id)) toast('该镜不在当前视图（可能被筛选隐藏）');
}

// ── 入口：构建挂件带（无镜头返回 null）──
export function buildRibbon(data, shots) {
  if (!shots || !shots.length) return null;
  const root = el('div', 'ribbon');
  let open = isOpen();
  root.classList.toggle('open', open);

  const bar = el('div', 'rb-bar');
  const caret = el('span', 'rb-caret', open ? '▾' : '▸');
  bar.appendChild(caret);
  bar.appendChild(el('span', 'rb-label', '挂件带'));
  bar.appendChild(el('span', 'rb-hint', '景别序列 · 节奏视窗'));
  bar.appendChild(el('span', 'rb-legend', '红＝近/特写 · 点击跳镜'));
  bar.addEventListener('click', () => {
    open = !open;
    setOpen(open);
    root.classList.toggle('open', open);
    caret.textContent = open ? '▾' : '▸';
  });

  const body = el('div', 'rb-body');
  body.appendChild(widgetSeq(shots));
  body.appendChild(widgetRhythm(data, shots));
  root.appendChild(bar);
  root.appendChild(body);
  return root;
}

// ① 景别序列条
function widgetSeq(shots) {
  const w = el('div', 'rb-w');
  const head = el('div', 'rb-wh');
  head.appendChild(el('span', 'rb-wt', '景别序列条'));
  head.appendChild(el('span', 'rb-wnote', '一格一镜 · 相连＝连续同景别'));
  const track = el('div', 'rb-track rb-seq');
  const tiers = shots.map((s) => tierOf(s.shot_size));
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const t = tiers[i];
    const c = el('button', 'rb-cell');
    c.dataset.lv = t ? String(TIER_SEQ.indexOf(t) + 1) : '0';
    if (i > 0 && t && tiers[i - 1] === t) c.classList.add('rb-bl');
    if (i < shots.length - 1 && t && tiers[i + 1] === t) c.classList.add('rb-br');
    c.title = '镜 ' + s.shot_no + ' · ' + (s.shot_size || '未填景别') + (s.duration ? ' · ' + s.duration + 's' : '') + ' · 点击跳镜';
    c.addEventListener('click', () => jump(s.id));
    track.appendChild(c);
  }
  w.appendChild(head);
  w.appendChild(track);
  return w;
}

// ② 节奏视窗：条长＝时长 ＋ 情绪温度曲线（按节拍步进）
function widgetRhythm(data, shots) {
  const w = el('div', 'rb-w');
  const head = el('div', 'rb-wh');
  head.appendChild(el('span', 'rb-wt', '节奏视窗'));
  head.appendChild(el('span', 'rb-wnote', '条长＝时长 · 曲线＝情绪温度（按节拍）'));

  const PXS = 8, MINW = 10, GAP = 2;
  const xs = [], ws = [];
  let acc = 0;
  for (const s of shots) {
    const d = numOf(s.duration) || 0;
    const px = Math.max(MINW, Math.round(d * PXS));
    xs.push(acc); ws.push(px); acc += px + GAP;
  }
  const totalW = Math.max(acc, 60);
  const time = el('div', 'rb-time');
  time.style.width = totalW + 'px';

  // 镜 → 节拍序（底纹交替）
  const beatIdx = new Map();
  (data.beats || []).forEach((b, bi) => (b.shots || []).forEach((sh) => beatIdx.set(sh.id, bi)));

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const b = el('button', 'rb-block');
    b.style.left = xs[i] + 'px';
    b.style.width = ws[i] + 'px';
    const bi = beatIdx.get(s.id);
    b.classList.add(bi == null ? 'rb-orphan' : (bi % 2 ? 'rb-t1' : 'rb-t0'));
    b.title = '镜 ' + s.shot_no + ' · ' + (numOf(s.duration) == null ? '未填时长' : numOf(s.duration) + 's') + ' · 点击跳镜';
    b.addEventListener('click', () => jump(s.id));
    time.appendChild(b);
  }

  // 情绪温度曲线（按节拍；空值＝虚线占位；全空＝提示）
  const H = 34;
  const segs = [];
  (data.beats || []).forEach((b, bi) => {
    const arr = b.shots || [];
    if (!arr.length) return;
    const i0 = shots.indexOf(arr[0]), i1 = shots.indexOf(arr[arr.length - 1]);
    if (i0 < 0 || i1 < 0) return;
    segs.push({
      x0: xs[i0], x1: xs[i1] + ws[i1],
      v: numOf(b.mood_temp), bi,
      name: b.name || ('节拍' + b.beat_no),
      firstId: arr[0].id,
    });
  });
  const hasAny = segs.some((t) => t.v != null);
  if (!hasAny) {
    time.appendChild(el('div', 'rb-mood-empty', '情绪温度未填写——节拍行填「情绪温度」（如 7）后，这里出曲线'));
  } else {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'rb-svg');
    svg.setAttribute('width', String(totalW));
    svg.setAttribute('height', String(H));
    const maxV = Math.max(10, ...segs.map((t) => (t.v == null ? 0 : t.v)));
    const Y = (v) => H - 4 - (v / maxV) * (H - 10);
    let prevX = null, prevY = null;
    for (const t of segs) {
      const y = t.v == null ? H - 10 : Y(t.v);
      if (prevX != null && t.x0 > prevX) {
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('x1', prevX); ln.setAttribute('y1', prevY);
        ln.setAttribute('x2', t.x0); ln.setAttribute('y2', y);
        ln.setAttribute('class', 'rb-lk');
        svg.appendChild(ln);
      }
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M' + t.x0 + ' ' + y + ' L' + Math.max(t.x1 - 1, t.x0) + ' ' + y);
      p.setAttribute('class', t.v == null ? 'rb-ps rb-ps-empty' : 'rb-ps');
      p.style.cursor = 'pointer';
      const ti = document.createElementNS(NS, 'title');
      ti.textContent = t.name + (t.v == null ? ' · 未填' : ' · 温度 ' + t.v);
      p.appendChild(ti);
      const fid = t.firstId;
      p.addEventListener('click', () => jump(fid));
      svg.appendChild(p);
      prevX = t.x1; prevY = y;
    }
    time.appendChild(svg);
  }

  const scroll = el('div', 'rb-scroll');
  scroll.appendChild(time);
  w.appendChild(head);
  w.appendChild(scroll);
  return w;
}
