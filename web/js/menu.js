// 浮动菜单组件（M2-3）：单选下拉 / 右键菜单共用。
// 不依赖原生 select：一次点击即出列表；拾取后由回调处理（表单不因弹层交互被误关）。
// 交互：↑↓ 移动高亮 / Enter 拾取 / Esc 关闭 / 点外关闭 / 滚动或 resize 关闭。
import { placeFlip, onOutsideClose } from './ui.js';
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
  document.removeEventListener('keydown', c.onKey, true);
  c.cleanup();
  c.el.remove();
  if (c.onClosed) c.onClosed();
}

// 条目适配单点（F2-P5）：string[] 或 {key,label}[] → 菜单条目（current 标记；captions 补标签）
export function optItems(list, curKey, opts) {
  const captions = (opts && opts.captions) || null;
  return list.map((it) => {
    const o = typeof it === 'string' ? { key: it } : it;
    const label = o.label != null ? o.label : (captions ? captions(o.key) : o.key);
    return { key: o.key, label: label, current: o.key === curKey };
  });
}

// anchor: Element | {x, y}；items: [{key,label,current?,disabled?} | {sep:true}]
// onPick(key, item)；opts: { onClosed }
export function openMenu(anchor, items, onPick, opts) {
  closeMenu();
  const o = opts || {};
  const root = document.createElement('div');   // 本函数内命名 root（F2-P6：与 ui.el 去歧义）
  root.className = 'menu';
  root.style.visibility = 'hidden';
  const entries = [];
  for (const it of items) {
    if (it.sep) {
      const sp = document.createElement('div');
      sp.className = 'menu-sep';
      root.appendChild(sp);
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
    root.appendChild(d);
  }
  document.body.appendChild(root);

  const nav = entries.filter((d) => !d.classList.contains('disabled'));
  let hi = -1;
  const setHl = (i) => {
    if (hi >= 0 && nav[hi]) nav[hi].classList.remove('hl');
    hi = i;
    if (hi >= 0 && nav[hi]) nav[hi].classList.add('hl');
  };
  const curIdx = nav.findIndex((d) => d.classList.contains('current'));
  if (curIdx !== -1) setHl(curIdx);

  // 定位（F2-P5 单点）：锚点下方，越界翻转 / 夹取在视口内
  const mw = root.offsetWidth;
  const mh = root.offsetHeight;
  let pos;
  if (anchor && anchor.nodeType === 1) {
    pos = placeFlip(anchor.getBoundingClientRect(), mw, mh);
  } else {
    const px = (anchor && anchor.x) || 0;
    const py = (anchor && anchor.y) || 0;
    pos = placeFlip({ left: px, right: px, top: py, bottom: py }, mw, mh, { gapBelow: 0, gapAbove: 6 });
  }
  root.style.left = pos.x + 'px';
  root.style.top = pos.y + 'px';
  root.style.visibility = '';

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

  // 点外关闭 + Esc 由单点托管（F2-W23）；本处仅剩键盘导航
  const onKey = (e) => {
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
  const cleanup = onOutsideClose(root, closeMenu, { keepFocus: true, closeOnScroll: true, closeOnResize: true });
  document.addEventListener('keydown', onKey, true);
  cur = { el: root, onKey, cleanup, onClosed: o.onClosed };
}
