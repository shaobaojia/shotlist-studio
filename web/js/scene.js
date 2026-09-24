// 场级页——页面组装：头部（可编）/ 工具条（整理镜号·开关·筛选·跳转）/ 分组与平铺；
// 表格与节拍区在 table.js；编辑引擎在 edit.js；拖动在 drag.js；筛选在 filter.js。
import { api } from './api.js';
import { state, fieldOf } from './state.js';
import { hashOf, isCurrentScene } from './route.js';
import { el, fmt, toast } from './ui.js';
import { JIWEI_LEGEND } from './cells.js';
import { buildTable, beatSection } from './table.js';
import { bindCellMenu } from './cellmenu.js';
import { bindSelection, clearSel, current as selCurrent, rectOf } from './selection.js';
import { initSelBar } from './selbar.js';
import { attachEditable, recordUndo } from './edit.js';
import { bindDrag } from './drag.js';
import { filterActive, resetFilter, buildFilterTools, applyFilter } from './filter.js';
import { openMenu } from './menu.js';
import { toggleHistory, closeHistory, refreshHistoryIfOpen } from './history.js';
import { initHotbox, releaseComposer } from './hotbox.js';
import { initAudit, onPainted as auditOnPainted } from './audit.js';
import { bindAuditBtn, toggleAuditPanel, closeAuditPanel } from './auditpanel.js';
import { initAiWrite, closeAiCards } from './aiwrite.js';
import { openSceneDraft, closeDraftCards } from './draft.js';
import { initScriptDrawer, openScriptDrawer, openScriptImport, scriptsOnRepaint } from './scriptdrawer.js';
import { buildRibbon } from './ribbon.js';

const PREFS_KEY = 'shotlist_prefs_v1';
let prefs = loadPrefs();   // { wrap, hidden:{key:true=隐藏}, widths:{key:px} }
let sortState = null;      // { key, dir: 1|-1 } | null —— 仅视图，不改行序
let currentData = null;
let promptGroupsMap = {};   // 本帧渲染共用的组映射（拼装台就地更新用；平铺/分组各表共此一份）

const fctx = {
  getData: () => currentData,
  allShots: () => (currentData ? allShots(currentData) : []),
  getView: () => document.getElementById('view'),
  repaint: () => paintScene(document.getElementById('view')),
  apply: () => { clearSel(); applyFilter(fctx); },
};

initSelBar();

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    const hidden = Object.assign({}, p.hidden || {});
    if (p.prompt === false && hidden.prompt == null) hidden.prompt = true; // 旧「显示提示词」开关迁移
    return { wrap: p.wrap !== false, hidden: hidden, widths: p.widths || {}, viewMode: p.viewMode === 'flat' ? 'flat' : 'group' };
  } catch (e) {
    return { wrap: true, hidden: {}, widths: {}, viewMode: 'group' };
  }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
}

export async function renderScene(view, sceneNo) {
  view.textContent = '';
  view.appendChild(el('div', 'empty', '加载中…'));
  let data;
  try {
    data = await api.scene(sceneNo);
  } catch (err) {
    view.textContent = '';
    view.appendChild(el('div', 'empty err', '加载失败：' + err.message));
    return;
  }
  if (!isCurrentScene(sceneNo)) return;
  _refreshSeq++;   // 本场渲染生效：作废切场前在飞的刷新回包（P0·F1-B1）
  sortState = null;
  resetFilter();
  closeHistory();
  closeAuditPanel();
  currentData = data;
  bindDragOnce(view);
  bindCellMenu(view, {
    allShots: () => (currentData ? allShots(currentData) : []),
    beats: () => (currentData ? currentData.beats : []),
    sceneId: () => (currentData ? currentData.scene.id : null),
    refresh: refreshCurrentView,
  });
  bindSelection(view, {
    getShot: (id) => (currentData ? allShots(currentData).find((s) => s.id === id) : null),
    getBeat: (id) => (currentData ? (currentData.beats || []).find((b) => b.id === id) : null),
    getScene: () => (currentData ? currentData.scene : null),
    refreshScene: refreshSceneSoon,
  });
  initHotbox({
    getData: () => currentData,
    refresh: refreshCurrentView,
    allShots: () => (currentData ? allShots(currentData) : []),
    groupsMap: () => promptGroupsMap,
    reapply: () => { clearSel(); applyFilter(fctx); },
  });
  initScriptDrawer({
    getScene: () => (currentData ? currentData.scene : null),
  });
  initAudit({ getData: () => currentData });
  initAiWrite({
    getShot: (id) => (currentData ? allShots(currentData).find((s) => s.id === id) : null),
    sceneId: () => (currentData ? currentData.scene.id : null),
  });
  paintScene(view);
}

// 批量改期节拍/场景字段后：合并到一帧重绘（apply 与撤销路径共用；重绘会清选区，符合重绘纪律）
let _sceneSoon = null;
export function refreshSceneSoon() {
  if (_sceneSoon) return;
  _sceneSoon = setTimeout(async () => {
    _sceneSoon = null;
    await refreshCurrentView();
  }, 30);
}

// 在飞刷新序号：陈旧回包守卫（P0·F1-B1）
let _refreshSeq = 0;
export async function refreshCurrentView() {
  const view = document.getElementById('view');
  if (!currentData || !view) return;
  const no = currentData.scene.scene_no;
  const seq = ++_refreshSeq;
  try {
    const next = await api.scene(no);
    if (seq !== _refreshSeq) return;                 // 更新一轮刷新在飞：本回包作废
    if (!isCurrentScene(no)) return;                 // 路由已切走：不回写
    if (!currentData || currentData.scene.scene_no !== no) return;   // 已切场：不回写
    currentData = next;
    paintScene(view);
  } catch (e) { /* 保留现状 */ }
}

// ── 拖动接线（事件委托，绑定一次） ──
function bindDragOnce(view) {
  if (view.dataset.dragBound === '1') return;
  view.dataset.dragBound = '1';
  bindDrag(view, {
    data: () => currentData,
    enabled: () => !sortState && !filterActive() && prefs.viewMode !== 'flat',
    // 多选整组（M5 批2）：拖的行在选区内（且选区跨≥2行、同表）→ 整组搬家
    rowGroup: (tr) => {
      const s = selCurrent();
      const rc = rectOf();
      if (!s || !rc || s.table !== tr.closest('table') || rc.r1 === rc.r2) return null;
      const ids = [];
      for (let r = rc.r1; r <= rc.r2; r++) {
        const row = s.rows[r];
        if (row) ids.push(Number(row.dataset.id));
      }
      if (ids.length < 2 || ids.indexOf(Number(tr.dataset.id)) === -1) return null;
      return ids;
    },
    onMoveShot: async (shotId, beatId, index, groupIds) => {
      const group = groupIds && groupIds.length > 1 ? groupIds : null;
      const info = group ? groupDragInfo(group) : shotDragInfo(shotId);
      try {
        const res = group
          ? await api.moveMany('shots', group, { beat_id: beatId, index: index })
          : await api.move('shots', shotId, { beat_id: beatId, index: index });
        if (res.moved && res.moved.changed) {
          if (info) {
            recordUndo({
              type: 'custom', label: group ? ('搬家 ' + group.length + ' 行') : '拖动',
              undo: async () => {
                if (group) await api.moveMany('shots', group, { beat_id: info.beatId, index: info.index });
                else await api.move('shots', shotId, { beat_id: info.beatId, index: info.index });
              },
            });
          }
          await refreshCurrentView();
        }
      } catch (err) {
        toast('拖动失败：' + err.message, 'err');
      }
    },
    onMoveBeat: async (beatId, index) => {
      const oldIndex = currentData ? currentData.beats.findIndex((b) => b.id === beatId) : 0;
      try {
        const res = await api.move('beats', beatId, { index: index });
        if (res.moved && res.moved.changed) {
          recordUndo({
            type: 'custom', label: '节拍拖动',
            undo: async () => { await api.move('beats', beatId, { index: oldIndex }); },
          });
          await refreshCurrentView();
        }
      } catch (err) {
        toast('拖动失败：' + err.message, 'err');
      }
    },
  });
}

function shotDragInfo(shotId) {
  if (!currentData) return null;
  for (const b of currentData.beats) {
    const i = b.shots.findIndex((x) => x.id === shotId);
    if (i !== -1) return { beatId: b.id, index: i };
  }
  return null;
}

// 整组原址（撤销用）：组按表序连续，起始位=搬回插入位。
function groupDragInfo(ids) {
  if (!currentData) return null;
  const first = ids[0];
  for (const b of currentData.beats) {
    const i = (b.shots || []).findIndex((x) => x.id === first);
    if (i !== -1) return { beatId: b.id, index: i };
  }
  return null;
}

function syncFreezeH() {
  const f = document.querySelector('.scene-freeze');
  if (!f) return;
  document.documentElement.style.setProperty('--freeze-h', f.getBoundingClientRect().height + 'px');
}
window.addEventListener('resize', () => { if (document.querySelector('.scene-freeze')) syncFreezeH(); });

function paintScene(view) {
  const data = currentData;
  if (!data) return;
  releaseComposer();               // 重绘前释放编辑面（防悬空 activeBox / 陈旧上下文写库；订阅与点外监听一并清）
  closeAiCards();                  // 重绘前收起 AI 预览卡（M4b-2）
  closeDraftCards();               // 重绘前收起草稿卡（M4b-4）
  scriptsOnRepaint(data.scene.id); // 剧本抽屉：同场不扰，切场未钉住即关 / 钉住跟场
  clearSel();
  view.textContent = '';
  view.classList.toggle('wrap-off', !prefs.wrap);
  document.documentElement.style.setProperty('--dock-h', '0px');

  const freeze = el('div', 'scene-freeze float-card');
  freeze.appendChild(sceneHead(data.scene, data));
  view.appendChild(freeze);
  const shots = allShots(data);
  if (!shots.length && !data.beats.length) {
    view.appendChild(el('div', 'empty', '本场暂无镜头——「＋ 添加节拍」搭骨架，或「✦ 从台本出草稿」贴一段台本先出初稿。'));
    view.appendChild(addBeatBar(true));
    syncFreezeH();
    return;
  }
  freeze.appendChild(viewTools());
  promptGroupsMap = {};
  for (const g of data.prompt_groups) promptGroupsMap[g.id] = g;
  const topts = { prefs: prefs, sortState: sortState, onSort: cycleSort, refresh: refreshCurrentView, savePrefs: savePrefs, groups: promptGroupsMap };
  const flat = !!sortState || prefs.viewMode === 'flat';
  if (flat) {
    if (shots.length) {
      const fwrap = buildTable(sortState ? sortedShots(shots) : shots, {
        beatCol: true, sortable: true, data: data,
        prefs: topts.prefs, sortState: topts.sortState, onSort: topts.onSort,
        savePrefs: topts.savePrefs, groups: promptGroupsMap,
      });
      fwrap.classList.add('holdhead');
      view.appendChild(fwrap);
    } else {
      // 平铺空场（有心跳但尚无镜头）：引导别白页（M5 批1·A1）
      view.appendChild(el('div', 'empty', '本场暂无镜头——切到「分组」视图可逐节拍添加镜头（＋ 镜头）；或「＋ 添加节拍」继续搭骨架。'));
      view.appendChild(addBeatBar());
    }
  } else {
    for (const b of data.beats) view.appendChild(beatSection(b, data, topts));
    if (data.orphan_shots && data.orphan_shots.length) {
      view.appendChild(beatSection(
        { beat_no: null, name: '未归节拍', kind: null, beat_action: null, shots: data.orphan_shots },
        data, topts));
    }
  }
  if (!flat) view.appendChild(addBeatBar());
  {                                                       // 挂件带 v2（M5k）：底部冻结通栏 + 向上浮层
    const dock = buildRibbon(data, shots);
    if (dock) view.appendChild(dock);
    document.documentElement.style.setProperty('--dock-h', dock ? dock.offsetHeight + 'px' : '0px');
  }
  applyFilter(fctx);
  scheduleWarm(view);
  refreshHistoryIfOpen();
  auditOnPainted(data);
  syncFreezeH();
}

function allShots(data) {
  const shots = [];                              // 单趟 push（镜头序单点；filter/cellmenu/hotbox 全走 ctx）
  for (const b of data.beats) for (const sh of b.shots) shots.push(sh);
  if (data.orphan_shots) for (const sh of data.orphan_shots) shots.push(sh);
  return shots;
}

// 活体件同步（M5j）：场景头「规模/总时长」＋挂件带——字段落定后就地刷新（不整页重绘）
window.addEventListener('shotlist:rows-changed', (ev) => {
  const d = (ev && ev.detail) || {};
  const hit = (d.table === 'shots' && (d.field === 'duration' || d.field === 'shot_size'))
           || (d.table === 'beats' && (d.field === 'mood_temp' || d.field === 'name'));
  if (hit) syncLive();
});

function syncLive() {
  const data = currentData;
  const view = document.getElementById('view');
  if (!data || !view) return;
  const st = view.querySelector('.scene-stats .ss-text');
  if (st) {
    const shs = allShots(data);
    const total = shs.reduce((n, s) => n + (parseFloat(s.duration) || 0), 0);
    st.textContent = shs.length + ' 镜 / ' + data.beats.length + ' 节拍 / 总时长 ' + fmtDur(total);
  }
  const old = view.querySelector('.dock');
  if (old) {
    const fresh = buildRibbon(data, allShots(data));
    if (fresh) old.replaceWith(fresh); else old.remove();
    document.documentElement.style.setProperty('--dock-h', fresh ? fresh.offsetHeight + 'px' : '0px');
  }
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + '\u2032' + String(s).padStart(2, '0') + '\u2033';
}

// 场次末尾「＋ 添加节拍」（空场也显示：搭骨架入口）
function addBeatBar(withDraft) {
  const bar = el('div', 'add-beat-bar');
  const btn = el('button', 'tool-btn add-beat', '＋ 添加节拍');
  btn.title = '在本场末尾添加节拍';
  btn.addEventListener('click', async () => {
    if (!currentData) return;
    try {
      const res = await api.create({ kind: 'beat', scene_id: currentData.scene.id });
      const nb = res.beat || {};
      toast('已添加节拍：beat ' + (nb.beat_no || ''));
      recordUndo({
        type: 'custom', label: '添加节拍',
        undo: async () => { await api.del({ table: 'beats', id: nb.id }); },
      });
      await refreshCurrentView();
      const nsec = document.querySelector('section.beat[data-beat-id="' + nb.id + '"]');
      if (nsec) {
        nsec.scrollIntoView({ block: 'nearest' });
        nsec.classList.add('flash');
        setTimeout(() => nsec.classList.remove('flash'), 1600);
      }
    } catch (err) {
      toast('添加失败：' + err.message, 'err');
    }
  });
  bar.appendChild(btn);
  if (withDraft) {
    const d = el('button', 'tool-btn add-beat dz-violet', '✦ 从台本出草稿…');
    d.title = '贴一段台本，AI 搭出节拍骨架 + 镜头行草稿（仅空场可用）';
    d.addEventListener('click', () => {
      if (currentData) openSceneDraft(currentData.scene.id, refreshCurrentView, currentData.scene.script || '');
    });
    bar.appendChild(d);
    const sb2 = el('button', 'tool-btn', '台本');
    sb2.title = '本场台本（浮动抽屉：查看 / 修订 / 复制）';
    sb2.addEventListener('click', () => openScriptDrawer());
    bar.appendChild(sb2);
    const imp2 = el('button', 'tool-btn', '导入台本…');
    imp2.title = '整本剧本切分导入（逐场勾选覆盖）';
    imp2.addEventListener('click', () => openScriptImport());
    bar.appendChild(imp2);
  }
  return bar;
}

function sceneHead(sc, data) {
  const head = el('div', 'scene-head');
  const h1 = el('h1', 'scene-title');
  const noSpan = el('span', 'scene-no', sc.scene_no);
  attachEditable(noSpan, {
    table: 'scenes', id: sc.id, field: 'scene_no', label: '场号',
    getValue: () => sc.scene_no,
    onLocal: (v) => { sc.scene_no = v; },
    renderCell: () => { noSpan.textContent = sc.scene_no; },
    save: async (oldV, newV) => {
      const v = String(newV == null ? '' : newV).trim();
      if (!v) throw new Error('场号不能为空');
      if (v === oldV) return;
      if (state.scenes.some((x) => x.id !== sc.id && x.scene_no === v)) {
        throw new Error('场号已存在：' + v);
      }
      await api.update('scenes', sc.id, 'scene_no', v);
      sc.scene_no = v;
      const st = state.scenes.find((x) => x.id === sc.id);
      if (st) st.scene_no = v;
      if (isCurrentScene(oldV)) location.hash = hashOf(v);
      window.dispatchEvent(new CustomEvent('shotlist:film-changed'));
      recordUndo({
        type: 'custom', label: '场号',
        undo: async () => {
          await api.update('scenes', sc.id, 'scene_no', oldV);
          sc.scene_no = oldV;
          const st2 = state.scenes.find((x) => x.id === sc.id);
          if (st2) st2.scene_no = oldV;
          if (isCurrentScene(v)) location.hash = hashOf(oldV);
          window.dispatchEvent(new CustomEvent('shotlist:film-changed'));
        },
      });
    },
  });
  h1.appendChild(noSpan);
  h1.appendChild(document.createTextNode(' · '));
  const t = el('span', null, sc.title || '');
  attachEditable(t, {
    table: 'scenes', id: sc.id, field: 'title', label: '场景名',
    getValue: () => sc.title,
    onLocal: (v) => { sc.title = v; },
    renderCell: () => { t.textContent = sc.title || ''; },
  });
  h1.appendChild(t);
  head.appendChild(h1);

  const meta = el('div', 'scene-meta');
  const kvEdit = (label, field) => {
    if (sc[field] == null || sc[field] === '') return;
    const s = el('span', 'kv');
    s.appendChild(el('b', null, label));
    const v = el('span', 'kv-v', fmt(sc[field]));
    attachEditable(v, {
      table: 'scenes', id: sc.id, field: field, label: label,
      getValue: () => sc[field],
      onLocal: (x) => { sc[field] = x; },
      renderCell: () => { v.textContent = fmt(sc[field]); },
    });
    s.appendChild(v);
    meta.appendChild(s);
  };
  kvEdit('价值', 'value');
  if (sc.pole_start || sc.pole_end) {
    const s = el('span', 'kv');
    s.appendChild(el('b', null, '弧线'));
    s.appendChild(document.createTextNode([sc.pole_start, sc.pole_end].filter(Boolean).join(' → ')));
    meta.appendChild(s);
  }
  kvEdit('翻转', 'turn');
  kvEdit('视点', 'pov');

  const shots = allShots(data);
  const total = shots.reduce((n, s) => n + (parseFloat(s.duration) || 0), 0);
  const s1 = el('span', 'kv scene-stats');
  s1.appendChild(el('b', null, '规模'));
  s1.appendChild(el('span', 'ss-text', shots.length + ' 镜 / ' + data.beats.length + ' 节拍 / 总时长 ' + fmtDur(total)));
  meta.appendChild(s1);
  if (sc.locked) {
    const lk = el('span', 'kv lock');
    lk.appendChild(el('b', null, '状态'));
    lk.appendChild(document.createTextNode('🔒 已锁定（版本快照留底）'));
    meta.appendChild(lk);
  }

  const legend = el('span', 'kv legend');
  legend.appendChild(el('b', null, '机位'));
  legend.appendChild(document.createTextNode(JIWEI_LEGEND.join(' ')));
  meta.appendChild(legend);
  head.appendChild(meta);
  return head;
}

function viewTools() {
  const bar = el('div', 'view-tools');

  // 视图形态（常驻）
  const effFlat = !!sortState || prefs.viewMode === 'flat';
  const seg = el('span', 'seg');
  seg.title = '视图：按节拍分组 / 平铺为一张表（本地记住）';
  [['group', '分组'], ['flat', '平铺']].forEach(function (pair) {
    const mode = pair[0];
    const b = el('button', 'seg-b' + (((mode === 'flat') === effFlat) ? ' on' : ''), pair[1]);
    b.addEventListener('click', () => {
      if (mode === 'group') sortState = null;
      prefs.viewMode = mode;
      savePrefs();
      paintScene(document.getElementById('view'));
    });
    seg.appendChild(b);
  });
  bar.appendChild(seg);

  // 查找与定位（常驻：筛选 → 镜号跳转 → 未写提示词 → 计数 → 清除）
  buildFilterTools(bar, fctx);

  if (sortState) {
    const f = fieldOf(sortState.key);
    bar.appendChild(el('span', 'sort-info',
      '视图排序：' + (f ? f.label : sortState.key) + (sortState.dir === 1 ? ' ↑' : ' ↓') + '（仅视图）'));
    const btn = el('button', 'tool-btn', '清除排序');
    btn.addEventListener('click', () => {
      sortState = null;
      paintScene(document.getElementById('view'));
    });
    bar.appendChild(btn);
  }

  // 场务（低频·吸右抽屉）：整理镜号 / 锁定本场 / 自动换行 / 列设置 / 痕迹
  const setWrap = (v) => {
    prefs.wrap = v;
    savePrefs();
    document.getElementById('view').classList.toggle('wrap-off', !v);
  };
  const doRenumber = async () => {
    try {
      const res = await api.renumber(currentData.scene.scene_no);
      const changes = res.changes || [];
      if (changes.length) {
        const byId = {};
        for (const c of changes) byId[c.id] = c.new;
        for (const s of allShots(currentData)) {
          if (byId[s.id] != null) s.shot_no = byId[s.id];
        }
        recordUndo({ type: 'renumber', changes: changes });
        toast('已整理 ' + changes.length + ' 个镜号（旧号入痕迹）');
        paintScene(document.getElementById('view'));
      } else {
        toast('镜号已是连续，无需整理');
      }
    } catch (err) {
      toast('整理失败：' + err.message, 'err');
    }
  };
  const doLockToggle = async () => {
    const want = !currentData.scene.locked;
    try {
      const res = await api.lock(currentData.scene.id, want);
      currentData.scene.locked = res.scene ? res.scene.locked : (want ? 1 : 0);
      if (want && res.snapshot) toast('已锁定并留底：' + res.snapshot.path);
      else toast(want ? '已锁定本场' : '已解锁本场');
      paintScene(document.getElementById('view'));
    } catch (err) {
      toast((want ? '锁定' : '解锁') + '失败：' + err.message, 'err');
    }
  };
  const openColsMenu = (anchor) => {
    const items = state.meta.shot_fields.filter((f) => f.in_table).map((f) => (
      { key: f.key, label: f.label || f.key, current: !prefs.hidden[f.key] }
    ));
    items.push({ sep: true }, { key: '__all', label: '全部显示' });
    openMenu(anchor, items, (k) => {
      if (k === '__all') prefs.hidden = {};
      else if (prefs.hidden[k]) delete prefs.hidden[k];
      else prefs.hidden[k] = true;
      savePrefs();
      paintScene(document.getElementById('view'));
    });
  };
  const sb = el('button', 'tool-btn', '台本');
  sb.title = '本场台本（浮动抽屉：查看 / 修订 / 复制）';
  sb.addEventListener('click', () => openScriptDrawer());
  bar.appendChild(sb);
  const ab = el('button', 'tool-btn audit-btn', '审计');
  ab.title = '审计问题清单（灯＝待处理；每次按设置跑）';
  ab.addEventListener('click', toggleAuditPanel);
  bindAuditBtn(ab);
  bar.appendChild(ab);

  const drawer = el('button', 'tool-btn vt-drawer', '场务 ⋯');
  drawer.title = '场务：整理镜号 / 锁定本场 / 自动换行 / 列设置 / 导入台本 / 导出 / 痕迹';
  drawer.addEventListener('click', () => {
    const locked = !!currentData.scene.locked;
    openMenu(drawer, [
      { key: 'renum', label: '整理镜号' },
      { key: 'lock', label: locked ? '解锁本场（当前已锁定）' : '锁定本场' },
      { sep: true },
      { key: 'wrap', label: '自动换行', current: !!prefs.wrap },
      { key: 'cols', label: '列设置' },
      { sep: true },
      { key: 'scriptImp', label: '导入台本…' },
      { sep: true },
      { key: 'expPage', label: '导出本场 · 静态页' },
      { key: 'expPrint', label: '导出本场 · A4 打印版' },
      { key: 'hist', label: '痕迹' },
    ], (k) => {
      if (k === 'renum') doRenumber();
      else if (k === 'lock') doLockToggle();
      else if (k === 'wrap') setWrap(!prefs.wrap);
      else if (k === 'cols') openColsMenu(drawer);
      else if (k === 'scriptImp') openScriptImport();
      else if (k === 'expPage') openExport('page');
      else if (k === 'expPrint') openExport('print');
      else if (k === 'hist') toggleHistory(currentData.scene);
    });
  });
  bar.appendChild(drawer);

  return bar;
}

function openExport(fmt) {
  const sc = currentData && currentData.scene;
  if (!sc) { toast('先打开一个场再导出'); return; }
  const a = document.createElement('a');
  a.href = '/api/export?scene=' + encodeURIComponent(sc.scene_no) + '&format=' + fmt;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(fmt === 'print' ? '正在导出 A4 打印版…' : '正在导出静态页…');
}

function cycleSort(key) {
  if (!sortState || sortState.key !== key) sortState = { key: key, dir: 1 };
  else if (sortState.dir === 1) sortState = { key: key, dir: -1 };
  else sortState = null;
  paintScene(document.getElementById('view'));
}

function sortedShots(shots) {
  const arr = shots.slice();
  const key = sortState.key;
  const dir = sortState.dir;
  arr.sort((a, b) => cmpVal(a[key], b[key]) * dir);
  return arr;
}

function cmpVal(va, vb) {
  const sa = va == null ? '' : String(va).trim();
  const sb = vb == null ? '' : String(vb).trim();
  const na = parseFloat(sa);
  const nb = parseFloat(sb);
  if (sa !== '' && sb !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
  if (!sa && sb) return 1;
  if (sa && !sb) return -1;
  return sa.localeCompare(sb, 'zh');
}


// ── 详情行空闲预热 ──
// 首开详情行有一次性的布局冷成本（实测 ~50ms 级）；渲染后在空闲时段分片强制布局一遍，
// 让用户真正点开的第一次也是热的。（分片 + 仅处理折叠态 + 同一任务内还原，不会闪）
let warmTimer = null;
function scheduleWarm(view) {
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    warmTimer = null;
    const rows = Array.from(view.querySelectorAll('tr.detail'));
    let i = 0;
    const step = () => {
      if (!view.isConnected) return;
      const end = Math.min(i + 6, rows.length);
      for (; i < end; i++) {
        const d = rows[i];
        if (!d.hidden) continue;
        d.hidden = false;
        void d.offsetHeight;
        d.hidden = true;
      }
      if (i < rows.length) {
        if (window.requestIdleCallback) window.requestIdleCallback(step, { timeout: 500 });
        else setTimeout(step, 60);
      }
    };
    step();
  }, 700);
}
