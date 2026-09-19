// 入口：导航（场次标签：切换 / 拖动排序 / 右键副本·删除 / 末尾＋加场）、路由、全局快捷键。
import { api } from './api.js';
import { state } from './state.js';
import { el, toast } from './ui.js';
import { renderFilm } from './film.js';
import { renderScene, refreshCurrentView } from './scene.js';
import { undo, recordUndo } from './edit.js';
import { openMenu } from './menu.js';

let navBound = false;
let dragChip = null;

function decHash(h) {
  try { return decodeURIComponent(h || ''); } catch (e) { return h || ''; }
}

function currentHash() {
  return location.hash === '' ? '#/' : location.hash;
}

function buildNav() {
  const nav = document.getElementById('scene-nav');
  nav.textContent = '';
  const all = el('a', 'chip', '全片');
  all.href = '#/';
  nav.appendChild(all);
  for (const sc of state.scenes) {
    const a = el('a', 'chip', sc.scene_no + (sc.title ? ' ' + sc.title : ''));
    a.href = '#/' + sc.scene_no;
    a.dataset.sceneId = sc.id;
    a.draggable = true;
    nav.appendChild(a);
  }
  const add = el('a', 'chip add-scene', '＋');
  add.href = '#';
  add.title = '添加场次（追加到末尾）';
  add.addEventListener('click', (e) => { e.preventDefault(); addScene(); });
  nav.appendChild(add);
  bindNavOnce(nav);
}

function bindNavOnce(nav) {
  if (navBound) return;
  navBound = true;

  nav.addEventListener('contextmenu', (e) => {
    const chip = e.target.closest ? e.target.closest('.chip') : null;
    if (!chip || !chip.dataset.sceneId) return;
    e.preventDefault();
    openSceneMenu(chip, e);
  });

  nav.addEventListener('dragstart', (e) => {
    const chip = e.target.closest ? e.target.closest('.chip') : null;
    if (!chip || !chip.dataset.sceneId) { e.preventDefault(); return; }
    dragChip = chip;
    clearChipHints();
    chip.classList.add('dragging');
    try {
      e.dataTransfer.setData('text/plain', String(chip.dataset.sceneId));
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { /* ignore */ }
  });

  nav.addEventListener('dragover', (e) => {
    if (!dragChip) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
    const over = e.target.closest ? e.target.closest('.chip') : null;
    document.querySelectorAll('#scene-nav .chip.drop-l, #scene-nav .chip.drop-r').forEach((c) => {
      if (c !== over) c.classList.remove('drop-l', 'drop-r');
    });
    if (!over || over === dragChip || !over.dataset.sceneId) return;
    const r = over.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    over.classList.toggle('drop-l', before);
    over.classList.toggle('drop-r', !before);
  });

  nav.addEventListener('drop', async (e) => {
    if (!dragChip) return;
    e.preventDefault();
    const chip = dragChip;
    dragChip = null;
    chip.classList.remove('dragging');
    clearChipHints();
    const over = e.target.closest ? e.target.closest('.chip') : null;
    if (over === chip) return;
    const draggedId = Number(chip.dataset.sceneId);
    const oldIndex = state.scenes.findIndex((x) => x.id === draggedId);
    if (oldIndex === -1) return;
    const others = state.scenes.filter((x) => x.id !== draggedId);
    let idx = others.length;
    if (over && over.dataset.sceneId) {
      const ti = others.findIndex((x) => x.id === Number(over.dataset.sceneId));
      const r = over.getBoundingClientRect();
      idx = (e.clientX < r.left + r.width / 2) ? ti : ti + 1;
    }
    if (idx === oldIndex) return;
    try {
      const res = await api.move('scenes', draggedId, { index: idx });
      if (res.moved && res.moved.changed) {
        recordUndo({
          type: 'custom', label: '场次排序',
          undo: async () => {
            await api.move('scenes', draggedId, { index: oldIndex });
            window.dispatchEvent(new CustomEvent('shotlist:film-changed'));
          },
        });
        await reloadFilm();
      }
    } catch (err) {
      toast('移动失败：' + err.message, 'err');
    }
  });

  nav.addEventListener('dragend', () => {
    if (dragChip) dragChip.classList.remove('dragging');
    dragChip = null;
    clearChipHints();
  });
}

function clearChipHints() {
  document.querySelectorAll('#scene-nav .chip.drop-l, #scene-nav .chip.drop-r')
    .forEach((c) => c.classList.remove('drop-l', 'drop-r'));
}

function openSceneMenu(chip, e) {
  const id = Number(chip.dataset.sceneId);
  const sc = state.scenes.find((x) => x.id === id);
  if (!sc) return;
  const n = sc.shot_count || 0;
  const items = [
    { key: 'dup', label: '创建场次副本' },
    { sep: true },
    { key: 'del', label: n > 0 ? ('删除场次（含 ' + n + ' 镜）') : '删除场次' },
  ];
  openMenu({ x: e.clientX, y: e.clientY }, items, (k) => onSceneMenuPick(k, sc));
}

async function onSceneMenuPick(k, sc) {
  try {
    if (k === 'dup') {
      const res = await api.duplicate('scenes', sc.id);
      const ns = res.scene || {};
      toast('已创建场次副本：' + (ns.scene_no || ''));
      recordUndo({
        type: 'custom', label: '创建场次副本',
        undo: async () => {
          await api.del({ table: 'scenes', id: ns.id });
          location.hash = '#/' + sc.scene_no;
          window.dispatchEvent(new CustomEvent('shotlist:film-changed'));
        },
      });
      await reloadFilm();
      if (ns.scene_no) location.hash = '#/' + ns.scene_no;
    } else if (k === 'del') {
      const res = await api.del({ table: 'scenes', id: sc.id });
      const d = res.deleted || {};
      toast('已删除场次 ' + sc.scene_no + '（Ctrl+Z 可撤销）');
      recordUndo({
        type: 'custom', label: '删除场次',
        undo: async () => {
          await api.restore({ kind: 'scene', payload: d });
          window.dispatchEvent(new CustomEvent('shotlist:film-changed'));
          if (d.scene && d.scene.scene_no) location.hash = '#/' + d.scene.scene_no;
        },
      });
      await reloadFilm();
      if (currentHash() === '#/' + sc.scene_no) location.hash = '#/';
    }
  } catch (err) {
    toast('操作失败：' + err.message, 'err');
  }
}

async function addScene() {
  try {
    const res = await api.create({ kind: 'scene' });
    const sc = res.scene || {};
    toast('已添加场次：' + (sc.scene_no || ''));
    recordUndo({
      type: 'custom', label: '添加场次',
      undo: async () => {
        await api.del({ table: 'scenes', id: sc.id });
        window.dispatchEvent(new CustomEvent('shotlist:film-changed'));
      },
    });
    await reloadFilm();
    if (sc.scene_no) location.hash = '#/' + sc.scene_no;
  } catch (err) {
    toast('添加失败：' + err.message, 'err');
  }
}

async function reloadFilm() {
  try {
    const fd = await api.film();
    state.film = fd.film;
    state.scenes = fd.scenes || [];
    buildNav();
    const cur = decHash(currentHash());
    const m = cur.match(/^#\/(.+)$/);
    if (m && !state.scenes.some((x) => x.scene_no === m[1])) {
      location.hash = '#/';
      return;
    }
    if (!m) renderFilm(document.getElementById('view'));
  } catch (err) { /* 保留现状 */ }
}

function route() {
  const cur = decHash(currentHash());
  document.querySelectorAll('#scene-nav .chip').forEach((chip) => {
    chip.classList.toggle('on', decHash(chip.getAttribute('href') || '') === cur);
  });
  const view = document.getElementById('view');
  const m = cur.match(/^#\/(.+)$/);
  if (m) renderScene(view, m[1]);
  else renderFilm(view);
}

function syncTopbarVar() {
  const tb = document.getElementById('topbar');
  if (!tb) return;
  document.documentElement.style.setProperty('--topbar-h', Math.round(tb.getBoundingClientRect().height) + 'px');
}

async function boot() {
  const view = document.getElementById('view');
  try {
    const [meta, filmData] = await Promise.all([api.meta(), api.film()]);
    state.meta = meta;
    state.film = filmData.film;
    state.scenes = filmData.scenes || [];
    buildNav();
    syncTopbarVar();
    if (window.ResizeObserver) { try { new ResizeObserver(syncTopbarVar).observe(document.getElementById('topbar')); } catch (e) { /* ignore */ } }
    window.addEventListener('hashchange', route);
    window.addEventListener('shotlist:film-changed', () => { reloadFilm(); });
    route();
  } catch (err) {
    view.textContent = '';
    view.appendChild(el('div', 'empty err', '加载失败：' + err.message));
  }
}

document.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'z') return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
  e.preventDefault();
  const ok = await undo();
  if (ok) { await refreshCurrentView(); }
});

boot();
