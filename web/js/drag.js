// 行拖动（HTML5 DnD，事件委托）：镜头行换序 / 跨节拍搬运；节拍头拖 = 整节拍重排。
// 规格（DESIGN §4.3）：把手在镜号格；拖动不改镜号；松手落库。
import { DND_DROP } from './ui.js';

export function bindDrag(container, ctx) {
  // ctx: { data(), enabled(), onMoveShot(shotId, beatId, index), onMoveBeat(beatId, index) }
  let payload = null;

  // F5-P7③：已标元素记账（O(1) 清理，原全容器 5 类扫描）；F5-W29：类清单单点＝ui.DND_DROP
  let marked = [], draggedNs = [];
  const addDrop = (n, cls) => { n.classList.add(cls); marked.push(n); };
  const addDragging = (n) => { n.classList.add('dragging'); draggedNs.push(n); };
  const clearDrop = () => {
    for (const n of marked) { for (const c of DND_DROP) n.classList.remove(c); }
    marked = [];
  };
  const clearAll = () => {
    clearDrop();
    for (const n of draggedNs) n.classList.remove('dragging');
    draggedNs = [];
  };
  const halfOf = (r, y) => (y - r.top) < r.height / 2;   // F5-W28：上下半单点（一次 rect 消费）

  // 整组拖拽 ghost：整行克隆 + 「搬家 N 行」角标（一次性，setDragImage 后即撤）
  const makeGhost = (tr, n) => {
    const ghost = tr.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('dragging');
    const pill = document.createElement('span');
    pill.className = 'drag-count';
    pill.textContent = '搬家 ' + n + ' 行';
    ghost.appendChild(pill);
    document.body.appendChild(ghost);
    setTimeout(() => { ghost.remove(); }, 0);
    return ghost;
  };

  const rowOf = (t) => {
    if (!t || !t.closest) return null;
    const tr = t.closest('tr.shot');
    if (tr) return tr;
    const det = t.closest('tr.detail');
    const prev = det ? det.previousElementSibling : null;
    return prev && prev.classList && prev.classList.contains('shot') ? prev : null;
  };

  const beatById = (id) => {
    const d = ctx.data();
    if (!d) return null;
    return d.beats.find((b) => b.id === id) || null;
  };

  container.addEventListener('dragstart', (e) => {
    const dots = e.target.closest ? e.target.closest('.drag-dots') : null;
    const sec = e.target.closest ? e.target.closest('section.beat') : null;
    const beatHead = !!(e.target.closest && e.target.closest('.beat-head') && sec && sec.dataset.beatId);
    if (!dots && !beatHead) return;   // 非行拖动系统（拼装台积木块 / 热盒条等）：放行，不干预、不连坐取消
    if (!ctx.enabled()) { e.preventDefault(); return; }
    if (dots) {
      const tr = dots.closest('tr.shot');
      const groupIds = ctx.rowGroup ? ctx.rowGroup(tr) : null;   // 多选整组搬家（M5 批2）
      payload = { kind: 'shot', id: Number(tr.dataset.id), ids: groupIds && groupIds.length > 1 ? groupIds : null };
      if (payload.ids) {
        container.querySelectorAll('tr.shot').forEach((row) => {
          if (payload.ids.indexOf(Number(row.dataset.id)) !== -1) addDragging(row);
        });
        try { e.dataTransfer.setDragImage(makeGhost(tr, payload.ids.length), 24, 12); } catch (err) { /* ignore */ }
      } else {
        addDragging(tr);
        try { e.dataTransfer.setDragImage(tr, 24, 12); } catch (err) { /* ignore */ }
      }
    } else {
      payload = { kind: 'beat', id: Number(sec.dataset.beatId) };
      addDragging(sec);
    }
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(payload.id)); } catch (err) { /* ignore */ }
  });

  container.addEventListener('dragover', (e) => {
    if (!payload) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const t = e.target;
    if (payload.kind === 'shot') {
      const tr = rowOf(t);
      clearDrop();
      if (tr) {
        const rid = Number(tr.dataset.id);
        if (payload.ids ? payload.ids.indexOf(rid) !== -1 : rid === payload.id) return; // 悬在自身/组内：不显示落点
        const r = tr.getBoundingClientRect();
        const before = halfOf(r, e.clientY);
        addDrop(tr, before ? 'drop-before' : 'drop-after');
        payload.hover = { el: tr, before: before };   // F5-W28：drop 复用此判别（省一次 gBCR）
        return;
      }
      const sec = t.closest ? t.closest('section.beat') : null;
      if (sec) addDrop(sec, 'drop-end');
    } else {
      const sec = t.closest ? t.closest('section.beat') : null;
      clearDrop();
      if (sec) {
        if (sec.dataset.beatId && Number(sec.dataset.beatId) === payload.id) return; // 悬在自己节拍上：不显示
        const r = sec.getBoundingClientRect();
        const before = halfOf(r, e.clientY);
        addDrop(sec, before ? 'beat-drop-before' : 'beat-drop-after');
        payload.hover = { el: sec, before: before };
      }
    }
  });

  container.addEventListener('drop', (e) => {
    if (!payload) return;
    e.preventDefault();
    const pl = payload;
    payload = null;
    clearAll();
    const t = e.target;
    if (pl.kind === 'shot') {
      const ids = pl.ids && pl.ids.length ? pl.ids : [pl.id];
      const tr = rowOf(t);
      if (tr) {
        const rid = Number(tr.dataset.id);
        if (ids.indexOf(rid) !== -1) return; // 放回自身/组内 = 原地不动
        const h = pl.hover && pl.hover.el === tr ? pl.hover : null;   // F5-W28：复用 dragover 判别（省一次 gBCR）
        const before = h ? h.before : halfOf(tr.getBoundingClientRect(), e.clientY);
        const beatId = Number(tr.dataset.beatId);
        if (!beatId) return;
        const beat = beatById(beatId);
        const arr = (beat ? beat.shots : []).filter((x) => ids.indexOf(x.id) === -1);
        const ti = arr.findIndex((x) => x.id === rid);
        const index = ti === -1 ? arr.length : (before ? ti : ti + 1);
        ctx.onMoveShot(pl.id, beatId, index, pl.ids || null);
      } else {
        const sec = t.closest ? t.closest('section.beat') : null;
        if (!sec || !sec.dataset.beatId) return;
        const beatId = Number(sec.dataset.beatId);
        const beat = beatById(beatId);
        const arr = (beat ? beat.shots : []).filter((x) => ids.indexOf(x.id) === -1);
        ctx.onMoveShot(pl.id, beatId, arr.length, pl.ids || null);
      }
    } else {
      const sec = t.closest ? t.closest('section.beat') : null;
      if (!sec || !sec.dataset.beatId) return;
      const targetBeatId = Number(sec.dataset.beatId);
      if (targetBeatId === pl.id) return; // 放回自己节拍 = 原地不动
      const h = pl.hover && pl.hover.el === sec ? pl.hover : null;   // F5-W28：复用 dragover 判别
      const before = h ? h.before : halfOf(sec.getBoundingClientRect(), e.clientY);
      const beats = (ctx.data() && ctx.data().beats) || [];
      const others = beats.filter((b) => b.id !== pl.id);
      let idx = others.findIndex((b) => b.id === targetBeatId);
      if (idx === -1) idx = others.length;
      if (!before) idx += 1;
      ctx.onMoveBeat(pl.id, idx);
    }
  });

  container.addEventListener('dragend', () => {
    payload = null;
    clearAll();
  });
}
