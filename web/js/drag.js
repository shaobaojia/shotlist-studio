// 行拖动（HTML5 DnD，事件委托）：镜头行换序 / 跨节拍搬运；节拍头拖 = 整节拍重排。
// 规格（DESIGN §4.3）：把手在镜号格；拖动不改镜号；松手落库。
export function bindDrag(container, ctx) {
  // ctx: { data(), enabled(), onMoveShot(shotId, beatId, index), onMoveBeat(beatId, index) }
  let payload = null;

  const clearDrop = () => {
    container.querySelectorAll('.drop-before, .drop-after, .drop-end, .beat-drop-before, .beat-drop-after')
      .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-end', 'beat-drop-before', 'beat-drop-after'));
  };
  const clearAll = () => {
    clearDrop();
    container.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
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
    if (!ctx.enabled()) { e.preventDefault(); return; }
    const dots = e.target.closest ? e.target.closest('.drag-dots') : null;
    const sec = e.target.closest ? e.target.closest('section.beat') : null;
    if (dots) {
      const tr = dots.closest('tr.shot');
      payload = { kind: 'shot', id: Number(tr.dataset.id) };
      tr.classList.add('dragging');
      try { e.dataTransfer.setDragImage(tr, 24, 12); } catch (err) { /* ignore */ }
    } else if (e.target.closest && e.target.closest('.beat-head') && sec && sec.dataset.beatId) {
      payload = { kind: 'beat', id: Number(sec.dataset.beatId) };
      sec.classList.add('dragging');
    } else {
      e.preventDefault();
      return;
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
        const r = tr.getBoundingClientRect();
        tr.classList.add((e.clientY - r.top) < r.height / 2 ? 'drop-before' : 'drop-after');
        return;
      }
      const sec = t.closest ? t.closest('section.beat') : null;
      if (sec) sec.classList.add('drop-end');
    } else {
      const sec = t.closest ? t.closest('section.beat') : null;
      clearDrop();
      if (sec) {
        const r = sec.getBoundingClientRect();
        sec.classList.add((e.clientY - r.top) < r.height / 2 ? 'beat-drop-before' : 'beat-drop-after');
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
      const tr = rowOf(t);
      if (tr) {
        const r = tr.getBoundingClientRect();
        const before = (e.clientY - r.top) < r.height / 2;
        const beatId = Number(tr.dataset.beatId);
        if (!beatId) return;
        const beat = beatById(beatId);
        const arr = (beat ? beat.shots : []).filter((x) => x.id !== pl.id);
        const ti = arr.findIndex((x) => x.id === Number(tr.dataset.id));
        const index = ti === -1 ? arr.length : (before ? ti : ti + 1);
        ctx.onMoveShot(pl.id, beatId, index);
      } else {
        const sec = t.closest ? t.closest('section.beat') : null;
        if (!sec || !sec.dataset.beatId) return;
        const beatId = Number(sec.dataset.beatId);
        const beat = beatById(beatId);
        const arr = (beat ? beat.shots : []).filter((x) => x.id !== pl.id);
        ctx.onMoveShot(pl.id, beatId, arr.length);
      }
    } else {
      const sec = t.closest ? t.closest('section.beat') : null;
      if (!sec || !sec.dataset.beatId) return;
      const targetBeatId = Number(sec.dataset.beatId);
      const r = sec.getBoundingClientRect();
      const before = (e.clientY - r.top) < r.height / 2;
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
