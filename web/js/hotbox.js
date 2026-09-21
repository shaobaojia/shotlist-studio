// 提示词拼装台（M3）：点击提示词 → 就地编辑面（正文 + 热盒/块库条）+ 组操作 + 保存并下一镜。
// 写作逻辑 = 拼积木式：块库点插（插入即固化）＋ 自由手写；{占位符} 在插入瞬间代入当前镜的值。
// 交互口径：Ctrl+Enter 保存并下一镜 · Esc 收起（不保存）· 点编辑面外回读视图（自动保存）。
import { api } from './api.js';
import { el, toast, growTextarea, durText } from './ui.js';
import { openMenu, menuEl } from './menu.js';
import { recordUndo, undo as globalUndo } from './edit.js';
import { buildShelf, storeAsBlock, byPosition } from './blocks.js';
import { writeClipboard } from './clipboard.js';
import { openManager } from './blockman.js';
import { aiTextMenu } from './aiwrite.js';
import { openPromptDraft } from './draft.js';
import {
  EDITOR_MIN_H, editorReset, editorPush, editorMark, editorUndo, editorRedo,
  editorHasUndo, editorOnInput, insertInto, replaceAll,
} from './hbedit.js';

// ctx 注入（scene.js）：getData / refresh / allShots（镜头序单点在 scene.js）/
// groupsMap（本帧共用组映射）/ reapply（筛选重评）
let ctx = { getData: () => null, refresh: async () => {} };
let activeBox = null;    // 当前激活的拼装台（单例）

export function initHotbox(c) { ctx = Object.assign(ctx, c); }

function groupOf(s, groups) {
  return (s && s.prompt_group_id != null) ? (groups[s.prompt_group_id] || null) : null;
}

// ── 占位符代入 ──
function substitute(text, s, data) {
  const t = String(text == null ? '' : text);
  if (t.indexOf('{') === -1) return t;
  const clean = (v) => String(v == null ? '' : v).replace(/★+/g, '').replace(/\s+/g, ' ').trim();
  const dur = durText(s.duration);
  const map = {
    '镜号': clean(s.shot_no),
    '景别': clean(s.shot_size),
    '焦段': clean(s.focal),
    '运镜': clean(s.camera_move),
    '机位': clean(s.camera_pos),
    '时长': dur,
    '台词': String(s.dialogue == null ? '' : s.dialogue).trim(),
    '音频': String(s.audio == null ? '' : s.audio).trim(),
    '场景': data && data.scene ? String(data.scene.title || '') : '',
  };
  return t.replace(/\{([^{}]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m));
}

// ── 只读视图 / 拼装关系重绘 ──
export function buildPromptBox(s, groups, data) {
  const pb = el('div', 'prompt-box');
  pb._ctx = { s, groups, data };
  renderBox(pb);
  return pb;
}

function renderBox(pb) {
  const { s, groups } = pb._ctx;
  const g = groupOf(s, groups);
  pb.textContent = '';

  const head = el('div', 'pb-head');
  const label = el('div', 'kv-label');
  label.textContent = g
    ? (g.member_shots.length > 1
        ? '提示词（本组 ' + g.member_shots.length + ' 镜：' + g.member_shots.join(' / ') + '）'
        : '提示词（镜 ' + g.member_shots[0] + '）')
    : '提示词（未组 —— 写入时自动建组）';
  head.appendChild(label);
  const dbtn = el('button', 'tool-btn small dz-violet', '✦ 初稿');
  dbtn.title = '按本组镜头数据 + 块库出一版初稿（进编辑面、未保存）';
  dbtn.addEventListener('mousedown', (e) => e.preventDefault());
  dbtn.addEventListener('click', () => {
    openPromptDraft({
      sceneId: pb._ctx.data.scene.id, shotId: s.id,
      onInsert: (text) => {
        if (!pb._state || pb._state.collapsed) activateBox(pb);
        const st = pb._state;
        if (st && st.ta) { replaceAll(st.ta, text); }
        toast('初稿已进编辑面——精修后「保存」才落库（Ctrl+Z 可撤）');
      },
    });
  });
  head.appendChild(dbtn);
  if (g && g.member_shots.length > 1) {
    const ops = el('span', 'pb-ops');
    const b1 = el('button', 'tool-btn small', '本镜独立');
    b1.title = '本镜拆出、单独成组（可 Ctrl+Z）';
    b1.addEventListener('mousedown', (e) => e.preventDefault());
    b1.addEventListener('click', () => detachOp([s.id], s.id));
    const b2 = el('button', 'tool-btn small', '整组拆开');
    b2.title = '组内每镜各自成组；正文留在首镜（可 Ctrl+Z）';
    b2.addEventListener('mousedown', (e) => e.preventDefault());
    b2.addEventListener('click', () => splitOp(g.id, s.id));
    ops.appendChild(b1);
    ops.appendChild(b2);
    head.appendChild(ops);
  }
  pb.appendChild(head);

  const body = el('div', 'pb-body pb-read');
  const pre = el('pre', 'prompt-text', (g && g.text) ? g.text : '（未写提示词 — 点击拼装）');
  if (!g || !g.text) pre.classList.add('empty-hint');
  body.appendChild(pre);
  body.appendChild(el('div', 'pb-tips',
    g ? '点击正文拼装 · 块库拼积木 + 自由手写' : '点击拼装（写入自动建组）· 块库拼积木 + 自由手写'));
  body.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('.hotbox')) return;   // 编辑面内部点击（定位光标 / 热盒条 / 搜索框）：只管拼，不重激活、不重设光标
    activateBox(pb);
  });
  pb.appendChild(body);
}

// ── 激活（只读 → 编辑面） ──
function activateBox(pb) {
  const st = pb._state;
  if (st && !st.collapsed) { focusEditor(pb); return; }
  if (activeBox && activeBox !== pb) collapseBox(activeBox, true);
  const { s, groups, data } = pb._ctx;
  const g = groupOf(s, groups);

  const body = pb.querySelector('.pb-body');
  body.classList.remove('pb-read');
  body.textContent = '';
  const refs = buildEditorDom(body, g);

  pb._state = { collapsed: false, ta: refs.ta, original: refs.ta.value, unsub: null, docMouse: null };
  activeBox = pb;

  const shelfCtl = buildShelf(refs.shelf, {
    onInsert: (text) => insertInto(refs.ta, substitute(text, s, data)),
    openManager: (fid) => openManager(fid),
    restoreFocus: () => focusTaSoft(pb),
  });
  pb._state.unsub = shelfCtl ? shelfCtl.off : null;

  editorReset(refs.ta);
  wireEditorEvents(pb, refs, s, data);

  // 点外收起：指针判定（替代旧的 blur + 「焦点在 .hotbox 内」启发式——chip 不再需要 tabindex 补偿）
  const onDocMouse = (e) => {
    const stx = pb._state;
    if (!stx || stx.collapsed) return;
    const t = e.target;
    if (t && pb.contains(t)) return;
    const m = menuEl();
    if (m && m.contains(t)) return;    // 菜单内点选不算点外
    if (t.closest && t.closest('.ai-diff, .ai-cmd, #draft-card, #pdraft-card')) return;   // 浮卡不算点外（M4b-2/4）
    collapseBox(pb, true);
  };
  pb._state.docMouse = onDocMouse;
  document.addEventListener('mousedown', onDocMouse, true);

  growTextarea(refs.ta, EDITOR_MIN_H);
  focusEditor(pb);
}

// 编辑面 DOM（正文 + 脚部 + 热盒条槽位）
function buildEditorDom(body, g) {
  const box = el('div', 'hotbox');
  const ta = document.createElement('textarea');
  ta.className = 'hotbox-editor';
  ta.spellcheck = false;
  ta.placeholder = '拼装提示词：点下方块库插入积木，或直接手写…';
  ta.value = (g && g.text) ? g.text : '';

  const foot = el('div', 'hotbox-foot');
  foot.appendChild(el('span', 'hotbox-hint', 'Ctrl+Enter 保存并下一镜 · Esc 收起'));
  const saveBtn = el('button', 'tool-btn small', '存 → 下一镜');
  saveBtn.title = '保存并跳到下一镜的提示词（Ctrl+Enter）';
  const copyBtn = el('button', 'tool-btn small', '拷上组');
  copyBtn.title = '从上一条提示词组拷全文（整段插入到光标处，可 Ctrl+Z）';
  const blockBtn = el('button', 'tool-btn small', '存为块');
  blockBtn.title = '把编辑面里选中的文字存进块库（先选中文字）';
  foot.appendChild(saveBtn);
  foot.appendChild(copyBtn);
  foot.appendChild(blockBtn);

  const shelf = el('div', 'hotbox-shelf');
  box.appendChild(ta);
  box.appendChild(foot);
  box.appendChild(shelf);
  body.appendChild(box);
  return { ta: ta, saveBtn: saveBtn, copyBtn: copyBtn, blockBtn: blockBtn, shelf: shelf };
}

// 编辑面事件接线（键处理 / 脚部按钮 / 右键菜单）
function wireEditorEvents(pb, refs, s, data) {
  const ta = refs.ta;
  const selText = () => ta.value.slice(ta.selectionStart, ta.selectionEnd);

  ta.addEventListener('input', () => editorOnInput(ta));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) { editorRedo(ta); return; }
      if (editorHasUndo(ta)) { editorUndo(ta); return; }
      // 编辑面栈空 → 让位全局撤销；撤销后无条件刷新（custom 条目不自刷新的坑：审计 B6a）
      globalUndo().then((ok) => { if (ok) ctx.refresh(); });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      editorRedo(ta);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      collapseBox(pb, false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveAndNext(pb);
    }
  });
  refs.saveBtn.addEventListener('mousedown', (e) => e.preventDefault());
  refs.saveBtn.addEventListener('click', () => saveAndNext(pb));
  refs.copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
  refs.copyBtn.addEventListener('click', () => copyPrevInto(pb, ta, s, data));
  refs.blockBtn.addEventListener('mousedown', (e) => e.preventDefault());
  refs.blockBtn.addEventListener('click', () => {
    const sel = selText().trim();
    if (!sel) { toast('先在编辑面里选中要存成块的文字'); return; }
    storeAsBlock(refs.blockBtn, sel);
  });

  // 编辑面内右键：独立菜单（选中文字 → 添加块 / 拷上组全文 / 复制剪切全选）
  ta.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const hasSel = selText().trim().length > 0;
    const pt = { x: e.clientX, y: e.clientY };
    openMenu(pt, [
      { key: 'mk', label: '添加到提示词块…', disabled: !hasSel },
      { key: 'ai', label: '✦ AI 改写选中段…', disabled: !hasSel },
      { sep: true },
      { key: 'all', label: '拷上组全文' },
      { sep: true },
      { key: 'copy', label: '复制', disabled: !hasSel },
      { key: 'cut', label: '剪切', disabled: !hasSel },
      { key: 'selall', label: '全选' },
    ], (k) => {
      if (k === 'mk') {
        if (!hasSel) { toast('先选中要添加的文字'); return; }
        storeAsBlock(pt, selText().trim());
      } else if (k === 'ai') {
        if (!hasSel) { toast('先选中要改写的文字'); return; }
        const seg = selText();
        const sPos = ta.selectionStart;
        aiTextMenu(pt, seg, ta.value, (after) => {
          editorPush(ta);
          ta.value = ta.value.slice(0, sPos) + after + ta.value.slice(sPos + seg.length);
          const pos = sPos + after.length;
          ta.focus();
          ta.setSelectionRange(pos, pos);
          growTextarea(ta, EDITOR_MIN_H);
          editorMark(ta);
          toast('已替换选段（Ctrl+Z 可撤）');
        });
      } else if (k === 'all') {
        copyPrevInto(pb, ta, s, data);
      } else if (k === 'copy') {
        writeClipboard(selText()).then((ok) => {
          toast(ok ? '已复制选中文字' : '复制失败：浏览器限制，请用 Ctrl+C');
        });
      } else if (k === 'cut') {
        const s0 = ta.selectionStart;
        const s1 = ta.selectionEnd;
        if (s1 <= s0) { toast('先选中要剪切的文字'); return; }
        const text = ta.value.slice(s0, s1);
        writeClipboard(text).then((ok) => {
          if (!ok) { toast('剪切失败：浏览器限制，请用 Ctrl+X'); return; }
          editorPush(ta);                                  // 剪切也进撤销栈
          ta.value = ta.value.slice(0, s0) + ta.value.slice(s1);
          ta.focus();
          ta.setSelectionRange(s0, s0);
          growTextarea(ta, EDITOR_MIN_H);
          editorMark(ta);
          toast('已剪切选中文字（Ctrl+Z 可撤）');
        });
      } else if (k === 'selall') {
        ta.focus();
        ta.select();
      }
    });
  });
}

// 拆订阅与点外监听（收起 / 释放共用；修 B1 泄漏）
function detachBox(pb) {
  const st = pb._state;
  if (!st) return;
  if (st.unsub) { try { st.unsub(); } catch (e) { /* ignore */ } st.unsub = null; }
  if (st.docMouse) { document.removeEventListener('mousedown', st.docMouse, true); st.docMouse = null; }
}

// 把焦点还给编辑面（不滚动视口、不动光标）
function focusTaSoft(pb) {
  const st = pb._state;
  if (!st || st.collapsed || !st.ta) return;
  try { st.ta.focus({ preventScroll: true }); } catch (e) { st.ta.focus(); }
}

function focusEditor(pb) {
  const st = pb._state;
  if (!st || !st.ta) return;
  const hadFocus = document.activeElement === st.ta;
  st.ta.focus();
  if (!hadFocus) st.ta.setSelectionRange(st.ta.value.length, st.ta.value.length);   // 仅首次激活时把光标放末尾；已聚焦则原地不动
  setTimeout(() => { try { pb.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }, 0);
}

// ── 收起（回只读视图）；commit=true 时先保存；保存失败则编辑面留着（内容不丢） ──
function collapseBox(pb, commit) {
  const st = pb._state;
  if (!st || st.collapsed) return;
  st.collapsed = true;
  if (activeBox === pb) activeBox = null;
  detachBox(pb);
  const text = st.ta ? st.ta.value : '';
  const done = commit ? saveText(pb, text) : Promise.resolve({ ok: true });
  done.then((r) => {
    if (!r || !r.ok) {
      const stx = pb._state;
      if (stx) stx.collapsed = false;
      if (!activeBox) activeBox = pb;
      return;
    }
    const stx = pb._state;
    if (stx && !stx.collapsed) return;   // 已重新激活：别动
    renderBox(pb);
  });
}

// ── 保存正文（未组镜头自动建组）；返回 {ok, changed} ──
async function saveText(pb, text) {
  const st = pb._state;
  const { s, groups, data } = pb._ctx;
  let g = groupOf(s, groups);
  // 基线现场推导：有组 = 组上现文（别处改过也不会误判「没变」）；无组 = 编辑面本次会话起点
  const base = g ? (g.text || '') : (st.original || '');
  if (text === base && (g || !String(text).trim())) return { ok: true, changed: false };
  try {
    if (!g) {
      if (!String(text).trim()) { st.original = text; return { ok: true, changed: false }; }
      const res = await api.promptOp('merge', { shot_ids: [s.id] });
      applyPromptGroups(res.groups || []);
      g = groupOf(s, groups);
      if (!g) { toast('建组失败：未找到新组（请重试）', 'err'); return { ok: false, changed: false }; }
    }
    const original = g.text || '';            // 保存前组上的现文（撤销目标）
    const res = await api.promptOp('set_text', { group_id: g.id, text: text });
    let changed = false;
    if (res.changed) {
      changed = true;
      const gid = g.id;
      g.text = text;
      recordUndo({
        type: 'custom', label: '提示词',
        undo: async () => {
          try {
            await api.promptOp('set_text', { group_id: gid, text: original });
            g.text = original;
            refreshBoxesForGroup(gid);
          } catch (err) {
            toast('撤销失败：' + err.message, 'err');
          }
        },
      });
      if (ctx.reapply) ctx.reapply();          // 「未写提示词」等筛选口径随文本变化重评
    }
    return { ok: true, changed: changed };
  } catch (err) {
    toast('提示词保存失败：' + err.message, 'err');
    return { ok: false, changed: false };
  }
}

function applyGroups(data, groupsMap, list) {
  data.prompt_groups.length = 0;
  for (const k of Object.keys(groupsMap)) delete groupsMap[k];
  for (const g of (list || [])) {
    data.prompt_groups.push(g);
    groupsMap[g.id] = g;
  }
}

function updatePromptCell(s, g) {
  const label = g ? g.member_shots.join(' / ') : '—';
  document.querySelectorAll('tr.shot[data-id="' + s.id + '"] td.cell-prompt').forEach((td) => {
    td.textContent = label;
    if (g) td.title = '提示词组：' + label + '（点击展开）';
    else td.removeAttribute('title');
  });
}

function refreshBoxesForGroup(gid) {
  document.querySelectorAll('.prompt-box').forEach((pb) => {
    const st = pb._state;
    if (st && !st.collapsed && st.ta) return;   // 编辑中的不动
    const g = pb._ctx ? groupOf(pb._ctx.s, pb._ctx.groups) : null;
    if (g && g.id === gid) renderBox(pb);
  });
}

// ── 保存并下一镜 / 跳到下一镜 ──
function nextTargetShot(s, gid) {
  const shots = ctx.allShots();
  const i = shots.findIndex((x) => x.id === s.id);
  if (i === -1) return null;
  for (let j = i + 1; j < shots.length; j++) {
    const t = shots[j];
    if (gid != null && t.prompt_group_id === gid) continue;   // 同组 = 同一份提示词，跳过
    return t;
  }
  return null;
}

async function saveAndNext(pb) {
  const st = pb._state;
  if (!st || st.collapsed) return;
  const { s, groups } = pb._ctx;
  const r = await saveText(pb, st.ta.value);
  if (!r.ok) return;   // 失败：留在编辑面重试（错误已 toast）
  const g = groupOf(s, groups);
  const t = nextTargetShot(s, g ? g.id : null);
  collapseBox(pb, false);
  if (t) {
    focusShotComposer(t.id);
    toast('已存 · 跳到镜 ' + t.shot_no);
  } else {
    toast('已存 · 已到本场末尾');
  }
}

// ── 对外：聚焦某镜的拼装台（供刷新后回位 / 保存并下一镜用） ──
export function focusShotComposer(shotId) {
  const det = document.querySelector('tr.detail[data-for="' + shotId + '"]');
  if (!det) return;
  const tr = document.querySelector('tr.shot[data-id="' + shotId + '"]');
  if (det.hidden) {
    det.hidden = false;
    if (tr) tr.classList.add('open');
  }
  const pb = det.querySelector('.prompt-box');
  if (pb) activateBox(pb);
  if (tr) { try { tr.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ } }
}

// 提示词单元格点击：切换拼装台（开 → 激活；再点 → 收起保存）
export function toggleComposer(det, s) {
  const pb = det.querySelector('.prompt-box');
  if (!pb) return;
  const st = pb._state;
  if (!det.hidden && st && !st.collapsed) {
    collapseBox(pb, true);
    return;
  }
  det.hidden = false;
  const tr = det.previousElementSibling;
  if (tr) tr.classList.add('open');
  activateBox(pb);
}

// ── 组操作（含撤销快照） ──
function promptSnapshot(data) {
  const idsByGroup = {};
  for (const sh of ctx.allShots()) {
    if (sh.prompt_group_id != null) {
      (idsByGroup[sh.prompt_group_id] = idsByGroup[sh.prompt_group_id] || []).push(sh.id);
    }
  }
  return {
    scene_id: data.scene.id,
    groups: (data.prompt_groups || []).map((g) => ({
      id: g.id, text: g.text, shot_ids: (idsByGroup[g.id] || []).slice(),
    })),
  };
}

// 释放当前编辑面（刷新 / 组操作前调用）：标收起 + 清订阅与点外监听（防泄漏与陈旧上下文写库）
export function releaseComposer() {
  const pb = activeBox;
  activeBox = null;
  if (!pb || !pb._state) return;
  detachBox(pb);
  pb._state.collapsed = true;
}

async function runPromptOp(action, payload, focusId, label) {
  const data = ctx.getData();
  if (!data) return false;
  const snap = promptSnapshot(data);
  releaseComposer();
  try {
    const res = await api.promptOp(action, payload);
    recordUndo({
      type: 'custom', label: label,
      undo: async () => {
        try {
          const r2 = await api.promptOp('restore', { scene_id: snap.scene_id, groups: snap.groups });
          if (r2 && r2.groups) applyPromptGroups(r2.groups);
          else await ctx.refresh();
        } catch (err) {
          toast('撤销失败：' + err.message, 'err');
        }
      },
    });
    if (res && res.groups) applyPromptGroups(res.groups);   // 就地套用写响应（全量组态），不再全量重拉
    else await ctx.refresh();
    if (focusId != null) focusShotComposer(focusId);
    return true;
  } catch (err) {
    toast(label + '失败：' + err.message, 'err');
    return false;
  }
}

// 组操作 UI 包装（四个同构 → 一张小表驱动）
const OP_UI = {
  detach: { label: '独立成组', done: () => '已独立成组' },
  split: { label: '拆开本组', done: () => '已拆开本组' },
  merge: { label: '并为一组', done: (n) => '已并为一组（' + n + ' 镜）' },
};

async function promptOpUI(kind, payload, focusId, n) {
  const ui = OP_UI[kind];
  const ok = await runPromptOp(kind, payload, focusId, ui.label);
  if (ok) toast(ui.done(n));
  return ok;
}

function detachOp(ids, focusId) {
  promptOpUI('detach', { shot_ids: ids }, focusId);
}

function splitOp(gid, focusId) {
  promptOpUI('split', { group_id: gid }, focusId);
}

export async function mergeShotsByIds(ids) {
  if (!ids || ids.length < 2) { toast('至少选 2 镜才能并为一组'); return; }
  await promptOpUI('merge', { shot_ids: ids }, ids[0], ids.length);
}

export async function detachShotsByIds(ids) {
  if (!ids || !ids.length) return;
  await promptOpUI('detach', { shot_ids: ids }, ids[0]);
}

// 写响应就地套用：组态 + 各镜归属 + 提示词格 + 只读箱 + 筛选重评（编辑中的箱不动）
export function applyPromptGroups(list) {
  const data = ctx.getData();
  if (!data) return;
  data.prompt_groups.length = 0;
  for (const g of list) data.prompt_groups.push(g);
  const map = ctx.groupsMap ? ctx.groupsMap() : null;
  if (map) {
    for (const k of Object.keys(map)) delete map[k];
    for (const g of list) map[g.id] = g;
  }
  const byShot = {};
  for (const g of list) for (const sid of (g.member_ids || [])) byShot[sid] = g.id;
  for (const s of ctx.allShots()) {
    s.prompt_group_id = (byShot[s.id] != null ? byShot[s.id] : null);
  }
  syncPromptCells();
  document.querySelectorAll('.prompt-box').forEach((pb) => {
    const st = pb._state;
    if (st && !st.collapsed && st.ta) return;   // 编辑中的不动
    renderBox(pb);
  });
  if (ctx.reapply) ctx.reapply();               // 筛选重评（「未写提示词」等）
}

function syncPromptCells() {
  const data = ctx.getData();
  if (!data) return;
  const map = {};
  for (const g of data.prompt_groups) map[g.id] = g;
  for (const s of ctx.allShots()) {
    updatePromptCell(s, s.prompt_group_id != null ? (map[s.prompt_group_id] || null) : null);
  }
}

// ── 拷上组：整组拷「上一条提示词组」全文（提示词单一概念，不拆声明段） ──
function prevGroupOf(s, groups, data) {
  const list = (data.prompt_groups || []).slice().sort(byPosition);
  const g = groupOf(s, groups);
  if (g) {
    const i = list.findIndex((x) => x.id === g.id);
    return i > 0 ? list[i - 1] : null;
  }
  const shots = ctx.allShots();
  const mine = shots.findIndex((x) => x.id === s.id);
  let prev = null;
  for (const x of list) {
    let first = -1;
    for (let j = 0; j < shots.length; j++) {
      if (shots[j].prompt_group_id === x.id) { first = j; break; }
    }
    if (first >= 0 && first < mine) prev = x;
  }
  return prev;
}

// 拷上组全文（脚部按钮 / 右键；整段插入到光标处，Ctrl+Z 可撤）
function copyPrevInto(pb, ta, s, data) {
  const prev = prevGroupOf(s, pb._ctx.groups, data);
  if (!prev || !String(prev.text || '').trim()) { toast('上一组还没有提示词可拷'); return; }
  insertInto(ta, substitute(String(prev.text), s, data));
  toast('已拷入上组全文（Ctrl+Z 可撤）');
}
