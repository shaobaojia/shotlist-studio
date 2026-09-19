export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function fmt(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

export function kindChip(kind) {
  const s = String(kind).trim();
  let cls = 'gray';
  if (s.startsWith('\u{1F534}')) cls = 'red';
  else if (s.startsWith('\u{1F7E1}')) cls = 'yellow';
  const text = s.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim() || s;
  return el('span', 'chip ' + cls, text);
}
