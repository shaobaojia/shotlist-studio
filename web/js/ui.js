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


// textarea 自增长（rAF 合并，避免每次按键强制回流）；min = 最小高度 px
export function growTextarea(ta, min) {
  if (ta.__grow) return;
  ta.__grow = true;
  requestAnimationFrame(() => {
    ta.__grow = false;
    if (!ta.isConnected) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(min || 0, ta.scrollHeight) + 'px';
  });
}

// 时长显示口径（单点）：纯数字 → 取整加 s；带单位（s/秒）→ 原样；空 → ''
export function durText(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/[a-z秒sS]$/.test(s)) return s;
  const n = parseFloat(s);
  return isNaN(n) ? s : Math.round(n) + 's';
}
