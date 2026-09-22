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
          if (payload.ids.indexOf(Number(row.dataset.id)) !== -1) row.classList.add('dragging');
        });
        try { e.dataTransfer.setDragImage(makeGhost(tr, payload.ids.length), 24, 12); } catch (err) { /* ignore */ }
      } else {
        tr.classList.add('dragging');
        try { e.dataTransfer.setDragImage(tr, 24, 12); } catch (err) { /* ignore */ }
      }
    } else {
      payload = { kind: 'beat', id: Number(sec.dataset.beatId) };
      sec.classList.add('dragging');
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
        tr.classList.add((e.clientY - r.top) < r.height / 2 ? 'drop-before' : 'drop-after');
        return;
      }
      const sec = t.closest ? t.closest('section.beat') : null;
      if (sec) sec.classList.add('drop-end');
    } else {
      const sec = t.closest ? t.closest('section.beat') : null;
      clearDrop();
      if (sec) {
        if (sec.dataset.beatId && Number(sec.dataset.beatId) === payload.id) return; // 悬在自己节拍上：不显示
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
      const ids = pl.ids && pl.ids.length ? pl.ids : [pl.id];
      const tr = rowOf(t);
      if (tr) {
        const rid = Number(tr.dataset.id);
        if (ids.indexOf(rid) !== -1) return; // 放回自身/组内 = 原地不动
        const r = tr.getBoundingClientRect();
        const before = (e.clientY - r.top) < r.height / 2;
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
