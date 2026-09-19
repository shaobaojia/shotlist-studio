import { api } from './api.js';
import { state } from './state.js';
import { el } from './ui.js';
import { renderFilm } from './film.js';
import { renderScene, refreshCurrentView } from './scene.js';
import { undo } from './edit.js';

function buildNav() {
  const nav = document.getElementById('scene-nav');
  nav.textContent = '';
  const all = el('a', 'chip', '全片');
  all.href = '#/';
  nav.appendChild(all);
  for (const sc of state.scenes) {
    const a = el('a', 'chip', sc.scene_no + (sc.title ? ' ' + sc.title : ''));
    a.href = '#/' + sc.scene_no;
    nav.appendChild(a);
  }
}

function currentHash() {
  return location.hash === '' ? '#/' : location.hash;
}

function route() {
  const cur = currentHash();
  document.querySelectorAll('#scene-nav .chip').forEach(chip => {
    chip.classList.toggle('on', chip.getAttribute('href') === cur);
  });
  const view = document.getElementById('view');
  const m = cur.match(/^#\/(s\d+)$/);
  if (m) renderScene(view, m[1]);
  else renderFilm(view);
}

async function boot() {
  const view = document.getElementById('view');
  try {
    const [meta, filmData] = await Promise.all([api.meta(), api.film()]);
    state.meta = meta;
    state.film = filmData.film;
    state.scenes = filmData.scenes || [];
    buildNav();
    window.addEventListener('hashchange', route);
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
  if (ok) await refreshCurrentView();
});

boot();
