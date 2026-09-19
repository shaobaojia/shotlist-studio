// 提示词拼装台（M3）：点击提示词 → 就地编辑面（正文 + 热盒/块库条）+ 组操作 + 保存并下一镜。
// 写作逻辑 = 拼积木式：块库点插（插入即固化）＋ 自由手写；{占位符} 在插入瞬间代入当前镜的值。
// 交互口径：Ctrl+Enter 保存并下一镜 · Esc 收起（不保存）· 点编辑面外回读视图（自动保存）。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { recordUndo } from './edit.js';
import { buildShelf, storeAsBlock } from './blocks.js';
import { openManager } from './blockman.js';

let ctx = { getData: () => null, refresh: async () => {} };
let activeBox = null;    // 当前激活的拼装台（单例）

export function initHotbox(c) { ctx = Object.assign(ctx, c); }

function groupOf(s, groups) {
  return (s && s.prompt_group_id != null) ? (groups[s.prompt_group_id] || null) : null;
}

function allShots(data) {
  let shots = [];
  for (const b of (data.beats || [])) shots = shots.concat(b.shots || []);
  if (data.orphan_shots) shots = shots.concat(data.orphan_shots);
  return shots;
}

// ── 占位符代入 ──
function substitute(text, s, data) {
  const t = String(text == null ? '' : text);
  if (t.indexOf('{') === -1) return t;
  const clean = (v) => String(v == null ? '' : v).replace(/★+/g, '').replace(/\s+/g, ' ').trim();
  const dur = s.duration == null || s.duration === '' ? ''
    : (/[a-z秒sS]$/.test(String(s.duration)) ? String(s.duration) : String(s.duration) + 's');
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
  body.addEventListener('click', () => activateBox(pb));
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
  const box = el('div', 'hotbox');

  const ta = document.createElement('textarea');
  ta.className = 'hotbox-editor';
  ta.spellcheck = false;
  ta.placeholder = '拼装提示词：点下方块库插入积木，或直接手写…';
  ta.value = (g && g.text) ? g.text : '';

  const foot = el('div', 'hotbox-foot');
  const hint = el('span', 'hotbox-hint', 'Ctrl+Enter 保存并下一镜 · Esc 收起');
  const saveBtn = el('button', 'tool-btn small', '存 → 下一镜');
  saveBtn.title = '保存并跳到下一镜的提示词（Ctrl+Enter）';
  const blockBtn = el('button', 'tool-btn small', '存为块');
  blockBtn.title = '把编辑面里选中的文字存进块库（先选中文字）';
  foot.appendChild(hint);
  foot.appendChild(saveBtn);
  foot.appendChild(blockBtn);

  const shelf = el('div', 'hotbox-shelf');
  box.appendChild(ta);
  box.appendChild(foot);
  box.appendChild(shelf);
  body.appendChild(box);

  pb._state = { collapsed: false, ta: ta, original: ta.value, unsub: null };
  activeBox = pb;

  const shelfCtl = buildShelf(shelf, {
    onInsert: (text) => insertInto(ta, substitute(text, s, data)),
    openManager: (fid) => openManager(fid),
  });
  pb._state.unsub = shelfCtl ? shelfCtl.off : null;

  ta.addEventListener('input', () => autoGrow(ta));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      collapseBox(pb, false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveAndNext(pb);
    }
  });
  ta.addEventListener('blur', () => {
    setTimeout(() => {
      const stx = pb._state;
      if (!stx || stx.collapsed) return;
      if (document.activeElement === ta) return;
      const inner = pb.querySelector('.hotbox');
      if (inner && inner.contains(document.activeElement)) return;
      collapseBox(pb, true);
    }, 0);
  });
  saveBtn.addEventListener('mousedown', (e) => e.preventDefault());
  saveBtn.addEventListener('click', () => saveAndNext(pb));
  blockBtn.addEventListener('mousedown', (e) => e.preventDefault());
  blockBtn.addEventListener('click', () => {
    const sel = ta.value.slice(ta.selectionStart || 0, ta.selectionEnd || 0).trim();
    if (!sel) { toast('先在编辑面里选中要存成块的文字'); return; }
    storeAsBlock(blockBtn, sel);
  });

  autoGrow(ta);
  focusEditor(pb);
}

function focusEditor(pb) {
  const st = pb._state;
  if (!st || !st.ta) return;
  st.ta.focus();
  st.ta.setSelectionRange(st.ta.value.length, st.ta.value.length);
  setTimeout(() => { try { pb.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }, 0);
}

// ── 收起（回只读视图）；commit=true 时先保存 ──
function collapseBox(pb, commit) {
  const st = pb._state;
  if (!st || st.collapsed) return;
  st.collapsed = true;
  if (activeBox === pb) activeBox = null;
  if (st.unsub) { try { st.unsub(); } catch (e) { /* ignore */ } }
  const text = st.ta ? st.ta.value : '';
  const done = commit ? saveText(pb, text) : Promise.resolve();
  done.then(() => {
    const stx = pb._state;
    if (stx && !stx.collapsed) return;   // 已重新激活：别动
    renderBox(pb);
  });
}

// ── 保存正文（未组镜头自动建组） ──
async function saveText(pb, text) {
  const st = pb._state;
  const { s, groups, data } = pb._ctx;
  let g = groupOf(s, groups);
  if (text === st.original && (g || !String(text).trim())) return;
  try {
    if (!g) {
      if (!String(text).trim()) { st.original = text; return; }
      const res = await api.promptOp('merge', { shot_ids: [s.id] });
      applyGroups(data, groups, res.groups);
      g = groupOf(s, groups);
      if (g) {
        s.prompt_group_id = g.id;
        updatePromptCell(s);
      }
      if (!g) return;
    }
    const original = st.original;
    const res = await api.promptOp('set_text', { group_id: g.id, text: text });
    st.original = text;
    if (res.changed) {
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
    }
  } catch (err) {
    toast('提示词保存失败：' + err.message, 'err');
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

function updatePromptCell(s) {
  document.querySelectorAll('tr.shot[data-id="' + s.id + '"] td.cell-prompt').forEach((td) => {
    td.textContent = s.shot_no;
    td.title = '提示词组：' + s.shot_no + '（点击展开）';
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
function nextTargetShotId(s, gid, data) {
  const shots = allShots(data);
  const i = shots.findIndex((x) => x.id === s.id);
  if (i === -1) return null;
  for (let j = i + 1; j < shots.length; j++) {
    const t = shots[j];
    if (gid != null && t.prompt_group_id === gid) continue;   // 同组 = 同一份提示词，跳过
    return t.id;
  }
  return null;
}

async function saveAndNext(pb) {
  const st = pb._state;
  if (!st || st.collapsed) return;
  const { s, groups, data } = pb._ctx;
  await saveText(pb, st.ta.value);
  const g = groupOf(s, groups);
  const gid = g ? g.id : null;
  const nextId = nextTargetShotId(s, gid, data);
  collapseBox(pb, false);
  if (nextId != null) {
    const t = allShots(data).find((x) => x.id === nextId);
    focusShotComposer(nextId);
    toast('已存' + (t ? ' · 跳到镜 ' + t.shot_no : ''));
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
  for (const sh of allShots(data)) {
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

function releaseActive() {
  const pb = activeBox;
  activeBox = null;
  if (pb && pb._state) pb._state.collapsed = true;
}

async function runPromptOp(action, payload, focusId, label) {
  const data = ctx.getData();
  if (!data) return false;
  const snap = promptSnapshot(data);
  releaseActive();
  try {
    await api.promptOp(action, payload);
    recordUndo({
      type: 'custom', label: label,
      undo: async () => {
        try {
          await api.promptOp('restore', { scene_id: snap.scene_id, groups: snap.groups });
          await ctx.refresh();
        } catch (err) {
          toast('撤销失败：' + err.message, 'err');
        }
      },
    });
    await ctx.refresh();
    if (focusId != null) focusShotComposer(focusId);
    return true;
  } catch (err) {
    toast(label + '失败：' + err.message, 'err');
    return false;
  }
}

function detachOp(ids, focusId) {
  runPromptOp('detach', { shot_ids: ids }, focusId, '独立成组').then((ok) => { if (ok) toast('已独立成组'); });
}

function splitOp(gid, focusId) {
  runPromptOp('split', { group_id: gid }, focusId, '拆开本组').then((ok) => { if (ok) toast('已拆开本组'); });
}

export async function mergeShotsByIds(ids) {
  if (!ids || ids.length < 2) { toast('至少选 2 镜才能并为一组'); return; }
  const ok = await runPromptOp('merge', { shot_ids: ids }, ids[0], '并为一组');
  if (ok) toast('已并为一组（' + ids.length + ' 镜）');
}

export async function detachShotsByIds(ids) {
  if (!ids || !ids.length) return;
  const ok = await runPromptOp('detach', { shot_ids: ids }, ids[0], '独立成组');
  if (ok) toast('已独立成组');
}

// ── 光标处插入（保住光标 · 自动长高） ──
function insertInto(ta, text) {
  if (text == null || text === '') return;
  const s0 = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const s1 = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
  const before = ta.value.slice(0, s0);
  const after = ta.value.slice(s1);
  const lead = (before && !/\n\s*$/.test(before)) ? '\n\n' : '';
  ta.value = before + lead + text + after;
  const pos = (before + lead + text).length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  autoGrow(ta);
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(130, ta.scrollHeight) + 'px';
}
