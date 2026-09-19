async function get(path) {
  const res = await fetch(path);
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
};
