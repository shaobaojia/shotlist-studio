// 浮动菜单组件（M2-3）：单选下拉 / 右键菜单共用。
// 不依赖原生 select：一次点击即出列表；拾取后由回调处理（表单不因弹层交互被误关）。
// 交互：↑↓ 移动高亮 / Enter 拾取 / Esc 关闭 / 点外关闭 / 滚动或 resize 关闭。
let cur = null;

export function menuOpen() {
  return !!cur;
}

export function menuEl() {
  return cur ? cur.el : null;
}

export function closeMenu() {
  if (!cur) return;
  const c = cur;
  cur = null;
  document.removeEventListener('mousedown', c.onDoc, true);
  document.removeEventListener('keydown', c.onKey, true);
  document.removeEventListener('scroll', c.onScroll, true);
  window.removeEventListener('resize', c.onResize);
  c.el.remove();
  if (c.onClosed) c.onClosed();
}

// anchor: Element | {x, y}；items: [{key,label,current?,disabled?} | {sep:true}]
// onPick(key, item)；opts: { onClosed }
export function openMenu(anchor, items, onPick, opts) {
  closeMenu();
  const o = opts || {};
  const el = document.createElement('div');
  el.className = 'menu';
  el.style.visibility = 'hidden';
  const entries = [];
  for (const it of items) {
    if (it.sep) {
      const sp = document.createElement('div');
      sp.className = 'menu-sep';
      el.appendChild(sp);
      continue;
    }
    const d = document.createElement('div');
    d.className = 'menu-item' + (it.current ? ' current' : '') + (it.disabled ? ' disabled' : '');
    const ck = document.createElement('span');
    ck.className = 'menu-check';
    ck.textContent = '✓';
    const lb = document.createElement('span');
    lb.className = 'menu-label';
    lb.textContent = it.label;
    d.appendChild(ck);
    d.appendChild(lb);
    d._key = it.key;
    d._item = it;
    entries.push(d);
    el.appendChild(d);
  }
  document.body.appendChild(el);

  const nav = entries.filter((d) => !d.classList.contains('disabled'));
  let hi = -1;
  const setHl = (i) => {
    if (hi >= 0 && nav[hi]) nav[hi].classList.remove('hl');
    hi = i;
    if (hi >= 0 && nav[hi]) nav[hi].classList.add('hl');
  };
  const curIdx = nav.findIndex((d) => d.classList.contains('current'));
  if (curIdx !== -1) setHl(curIdx);

  // 定位：锚点下方，越界翻转 / 夹取在视口内
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let x;
  let y;
  if (anchor && anchor.nodeType === 1) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  } else {
    x = (anchor && anchor.x) || 0;
    y = (anchor && anchor.y) || 0;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, y - mh - 6);
  }
  x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.visibility = '';

  const pick = (d) => {
    const cb = onPick;
    closeMenu();
    if (d && cb) cb(d._key, d._item);
  };
  for (const d of entries) {
    if (d.classList.contains('disabled')) continue;
    d.addEventListener('click', () => pick(d));
    d.addEventListener('mouseenter', () => {
      const i = nav.indexOf(d);
      if (i !== -1) setHl(i);
    });
  }

  const onDoc = (e) => {
    if (el.contains(e.target)) {
      e.preventDefault(); // 保住焦点：编辑器不失焦、表单不因焦点变化被关
      return;
    }
    closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      return;
    }
    if (!nav.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setHl(hi === -1 ? (dir === 1 ? 0 : nav.length - 1) : (hi + dir + nav.length) % nav.length);
    } else if (e.key === 'Enter' && hi >= 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(nav[hi]);
    }
  };
  const onScroll = (e) => {
    if (!el.contains(e.target)) closeMenu();
  };
  const onResize = () => closeMenu();

  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  cur = { el, onDoc, onKey, onScroll, onResize, onClosed: o.onClosed };
}
