// 入口：导航（场次标签：切换 / 拖动排序 / 右键副本·删除 / 末尾＋加场）、路由、全局快捷键。
import { api } from './api.js';
import { state } from './state.js';
import { el, toast, once, installWheelGuards, isTypingTarget, filmChanged, silent, setVarPx } from './ui.js';
import { parseHash, sceneNo, hashOf } from './route.js';
import { renderFilm } from './film.js';
import { renderScene, refreshCurrentView } from './scene.js';
import { undo, recordUndo } from './edit.js';
import { openMenu } from './menu.js';
import { bindSettingsBtn } from './settings.js';
import { bindCmdK } from './cmdk.js';
import { closeAuditPanel } from './auditpanel.js';

let dragChip = null;

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
  if (!once('scene-nav')) return;

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
    await sceneOp('场次排序',
      () => api.move('scenes', draggedId, { index: idx }),
      () => api.move('scenes', draggedId, { index: oldIndex }),
      { onlyIf: (res) => res.moved && res.moved.changed, errLabel: '移动失败' });
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

// 场次级操作统一收尾（F1-W1）：调接口 → toast → 撤销登记（自动带导航刷新） → 刷新导航 → 可选跳场
async function sceneOp(label, run, undo, opts) {
  opts = opts || {};
  try {
    const res = await run();
    if (opts.onlyIf && !opts.onlyIf(res)) return;
    if (opts.toast) toast(opts.toast(res));
    recordUndo({
      type: 'custom', label: label,
      undo: async () => {
        await undo(res);
        filmChanged();
        if (opts.undoHash) { const h = opts.undoHash(res); if (h) location.hash = h; }
      },
    });
    await reloadFilm();
    if (opts.hash) { const h = opts.hash(res); if (h) location.hash = h; }
  } catch (err) {
    toast((opts.errLabel || '操作失败') + '：' + err.message, 'err');
  }
}

async function onSceneMenuPick(k, sc) {
  if (k === 'dup') {
    await sceneOp('创建场次副本',
      () => api.duplicate('scenes', sc.id),
      async (res) => { const ns = res.scene || {}; await api.del({ table: 'scenes', id: ns.id }); location.hash = hashOf(sc.scene_no); },
      { toast: (res) => '已创建场次副本：' + ((res.scene && res.scene.scene_no) || ''),
        hash: (res) => (res.scene && res.scene.scene_no) ? hashOf(res.scene.scene_no) : null });
  } else if (k === 'del') {
    await sceneOp('删除场次',
      () => api.del({ table: 'scenes', id: sc.id }),
      async (res) => { await api.restore({ kind: 'scene', payload: res.deleted || {} }); },
      { toast: () => '已删除场次 ' + sc.scene_no + '（Ctrl+Z 可撤销）',
        undoHash: (res) => (res.deleted && res.deleted.scene && res.deleted.scene.scene_no) ? hashOf(res.deleted.scene.scene_no) : null });
  }
}

async function addScene() {
  await sceneOp('添加场次',
    () => api.create({ kind: 'scene' }),
    async (res) => { await api.del({ table: 'scenes', id: res.scene.id }); },
    { toast: (res) => '已添加场次：' + ((res.scene && res.scene.scene_no) || ''),
      hash: (res) => (res.scene && res.scene.scene_no) ? hashOf(res.scene.scene_no) : null,
      errLabel: '添加失败' });
}

// 场级数据落库单点（F1-W2）：boot 与 reloadFilm 共用；badgesP 可预取（省一次串行往返）
function applyFilm(fd, badgesP) {
  state.film = fd.film;
  state.scenes = fd.scenes || [];
  buildNav();
  refreshNavBadges(badgesP);
}

async function reloadFilm() {
  try {
    applyFilm(await api.film());
    applyNavOn();   // 重建后重打高亮（拖动排序/删场触发；hash 未变无 hashchange）（P0·F1-B7）
    const curNo = sceneNo();
    if (curNo && !state.scenes.some((x) => x.scene_no === curNo)) {
      location.hash = '#/';
      return;
    }
    if (!curNo) renderFilm(document.getElementById('view'));
  } catch (err) { silent(err, 'reloadFilm'); }
}

// 按当前 hash 重打导航高亮（nav 重建后调用；不触发视图重绘）（P0·F1-B7）
function applyNavOn() {
  const cur = parseHash();
  document.querySelectorAll('#scene-nav .chip').forEach((chip) => {
    chip.classList.toggle('on', parseHash(chip.getAttribute('href') || '') === cur);
  });
  const onChip = document.querySelector('#scene-nav .chip.on');
  if (onChip && onChip.scrollIntoView) onChip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function route() {
  applyNavOn();
  const curNo = sceneNo();
  const view = document.getElementById('view');
  if (curNo) renderScene(view, curNo);
  else { closeAuditPanel(); renderFilm(view); }   // 离场去「全片」：清单不留浮（M4）
}

function syncTopbarVar() {
  const tb = document.getElementById('topbar');
  if (!tb) return;
  setVarPx('--topbar-h', tb);
}

async function boot() {
  const view = document.getElementById('view');
  try {
    const [meta, filmData] = await Promise.all([api.meta(), api.film()]);
    state.meta = meta;
    applyFilm(filmData, api.auditSummary());   // 徽标预取并联（W2：省一次串行往返）
    syncTopbarVar();
    bindSettingsBtn(document.getElementById('settings-btn'));
    bindCmdK();
    installWheelGuards();   // 滚轮护栏：起手即装（F1-B4：曾只在提示词抽屉首开时装）
    if (window.ResizeObserver) { try { new ResizeObserver(syncTopbarVar).observe(document.getElementById('topbar')); } catch (e) { /* ignore */ } }
    window.addEventListener('hashchange', route);
    window.addEventListener(FILM_CHANGED, () => { reloadFilm(); });
    route();
  } catch (err) {
    view.textContent = '';
    view.appendChild(el('div', 'empty err', '加载失败：' + err.message));
  }
}

// 场次徽标同步记数（审计未处理数；事件节流）
let navbTimer = null;
function scheduleNavBadges() {
  if (navbTimer) clearTimeout(navbTimer);
  navbTimer = setTimeout(() => { navbTimer = null; refreshNavBadges(); }, 900);
}
async function refreshNavBadges(pre) {
  try {
    const res = await (pre || api.auditSummary());
    const map = res.open_by_scene || {};
    document.querySelectorAll('#scene-nav .chip[data-scene-id]').forEach((chip) => {
      const n = map[String(chip.dataset.sceneId)] || 0;
      let b = chip.querySelector('.nb');
      if (!n) { if (b) b.remove(); return; }
      if (!b) { b = el('span', 'nb'); chip.appendChild(b); }
      b.textContent = String(n);
    });
  } catch (err) { silent(err, 'navBadges'); }
}
window.addEventListener('shotlist:audit-changed', scheduleNavBadges);

document.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'z') return;
  if (e.shiftKey || e.altKey) return;   // 重做等组合不归全局撤销管（P0·F1-B2）
  if (isTypingTarget(document.activeElement, { select: true })) return;
  e.preventDefault();
  const ok = await undo();
  if (ok) { await refreshCurrentView(); }
});

boot();
