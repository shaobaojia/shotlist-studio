async function get(path) {
  const res = await fetch(path);
  if (!res.ok) {
    let msg = String(res.status);
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    let msg = String(res.status);
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  meta: () => get('/api/meta'),
  film: () => get('/api/film'),
  scene: (no) => get('/api/scenes/' + encodeURIComponent(no)),
  update: (table, id, field, value) => post('/api/update', { table: table, id: id, field: field, value: value }),
  renumber: (no) => post('/api/scenes/' + encodeURIComponent(no) + '/renumber', {}),
  move: (table, id, payload) => post('/api/move', Object.assign({ table: table, id: id }, payload || {})),
  batch: (ops) => post('/api/batch', { ops: ops }),
  duplicate: (table, id) => post('/api/duplicate', { table: table, id: id }),
  del: (payload) => post('/api/delete', payload),
  create: (payload) => post('/api/create', payload),
  restore: (payload) => post('/api/restore', payload),
  lock: (id, lock) => post('/api/lock', { id: id, lock: lock }),
  history: (sceneId, limit) => get('/api/history?scene_id=' + sceneId + '&limit=' + (limit || 100)),
};
