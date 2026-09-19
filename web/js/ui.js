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

let _toastTimer = null;

export function toast(msg, kind) {
  let box = document.getElementById('toast');
  if (!box) {
    box = el('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.className = 'show' + (kind === 'err' ? ' err' : '');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    box.className = '';
  }, kind === 'err' ? 3200 : 1800);
}

export function kindChip(kind) {
  const s = String(kind).trim();
  let cls = 'gray';
  if (s.startsWith('\u{1F534}')) cls = 'red';
  else if (s.startsWith('\u{1F7E1}')) cls = 'yellow';
  const text = s.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim() || s;
  return el('span', 'chip ' + cls, text);
}
