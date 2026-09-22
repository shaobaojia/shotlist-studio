// 提示词抽屉（M5 批3）：旧版样式独立抽屉 = 浮层壳（drawer.js）+ 拼装台瓤（M3 全量迁入）。
// 交互口径：Ctrl+Enter 保存并下一镜 · Esc 编辑→查看（不保存）· 查看态 Esc→关闭 · 未钉住点抽屉外＝保存并关闭 · 钉住＝不关（切镜跟随）。
// 写作逻辑不变：块库点插（插入即固化）+ 自由手写；{占位符} 在插入瞬间代入当前镜的值。
import { api } from './api.js';
import { el, toast, growTextarea, durText } from './ui.js';
import { openMenu, menuEl } from './menu.js';
import { recordUndo, undo as globalUndo } from './edit.js';
import { buildShelf, storeAsBlock, byPosition } from './blocks.js';
import { writeClipboard } from './clipboard.js';
import { openManager } from './blockman.js';
import { aiTextMenu } from './aiwrite.js';
import { openPromptDraft } from './draft.js';
import { createDrawer } from './drawer.js';
import {
  EDITOR_MIN_H, editorReset, editorUndo, editorRedo,
  editorHasUndo, editorOnInput, insertInto, replaceAll, replaceRange,
} from './hbedit.js';

// ctx 注入（scene.js）：getData / refresh / allShots（镜头序单点）/ groupsMap（本帧共用组映射）/ reapply（筛选重评）
let ctx = { getData: () => null, refresh: async () => {}, allShots: () => [], groupsMap: () => null };
export function initHotbox(c) { ctx = Object.assign(ctx, c); }

let dr = null;                    // 抽屉实例（懒建）
let escWired = false;
const S = {                       // 抽屉会话状态
  shotId: null, s: null,
  mode: 'edit',                   // 'view' | 'edit'
  ta: null, original: '', unsub: null,
  toggleBtn: null,
};

function groupOf(s, groups) {
  return (s && s.prompt_group_id != null && groups) ? (groups[s.prompt_group_id] || null) : null;
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

// ── 抽屉装配 ──
function ensureDrawer() {
  if (dr) return dr;
  dr = createDrawer({
    id: 'prompt',
    width: 500,
    onOutside,
    onClose: onDrawerClosed,
  });
  dr.addDockButton('bottom');
  dr.addDockButton('right');
  dr.addPinButton();
  S.toggleBtn = dr.addButton('编辑', {
    title: '查看 ⇄ 编辑（编辑中点＝保存）',
    onClick: onToggleMode,
  });
  dr.addButton('复制', {
    title: '复制全文（自动过滤 [镜XX] 注释）',
    onClick: onCopy,
  });
  dr.addCloseButton(() => commitClose());

  if (!escWired) {
    escWired = true;
    // 焦点在抽屉内时：Esc 编辑→查看（不保存）/ 查看→关闭（未钉住）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!dr || !dr.isOpen()) return;
      const t = e.target;
      if (t && t.closest && t.closest('.menu')) return;                       // 菜单自管优先
      const inDrawer = !!(t && dr.el.contains(t));
      if (!inDrawer && t && t.closest && t.closest('.drawer')) return;        // 焦点在别的抽屉：让它家处理
      if (!inDrawer && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;                                                                 // 别处编辑中：不介入（编辑面内由 ta 自管）
      }
      if (S.mode === 'edit') { renderDrawer('view'); return; }
      if (!dr.isPinned()) commitClose();
    });

    // 钉住＝浏览模式：点其他镜头行/详情行 → 切正文（不关）
    document.addEventListener('click', (e) => {
      if (!dr || !dr.isOpen() || !dr.isPinned()) return;
      const t = e.target;
      if (!t.closest || dr.el.contains(t)) return;
      if (t.closest('.cell-prompt')) return;                      // 提示词列由自身处理器接棒
      const hit = t.closest('tr.shot, tr.detail');
      if (!hit) return;
      const sid = Number(hit.dataset.id || hit.dataset.for);
      if (sid && sid !== S.shotId) openPromptDrawer(sid);
    });
  }
  return dr;
}

// ── 打开 / 切换（入口：提示词列点击 / 详情预览点击 / 保存并下一镜 / 组操作回位）──
export async function openPromptDrawer(shotId, opts) {
  opts = opts || {};
  const shots = ctx.allShots() || [];
  const s = shots.find((x) => x.id === shotId);
  if (!s) return;
  const d = ensureDrawer();
  if (d.isOpen() && S.shotId === shotId) {
    if (opts.toggle && !d.isPinned()) commitClose();       // 再点同一格＝收起保存（钉住时不动）
    return;
  }
  if (d.isOpen() && S.mode === 'edit' && S.ta) {
    const r = await saveCurrent();                          // 切换前静默保存
    if (!r.ok) return;                                      // 保存失败：留在原镜重试
  }
  S.shotId = shotId;
  S.s = s;
  const mode = d.isOpen() ? S.mode : (opts.mode || 'edit');
  d.open();
  renderDrawer(mode);
}

// 兼容旧出口：聚焦某镜的拼装台（供刷新后回位 / 保存并下一镜用）
export function focusShotComposer(shotId) {
  openPromptDrawer(shotId, { mode: 'edit' });
}

// 重绘前释放：编辑态＝丢弃关闭（防陈旧上下文写库）；查看态＝重挂内容（钉住/记忆保持）
export function releaseComposer() {
  if (!dr || !dr.isOpen()) return;
  if (S.mode === 'edit') { dr.close(); return; }
  const s2 = (ctx.allShots() || []).find((x) => x.id === S.shotId);
  if (!s2) { dr.close(); return; }
  S.s = s2;
  renderDrawer('view');
}

function onDrawerClosed() {
  detachEditor();
  S.shotId = null;
  S.s = null;
  S.mode = 'edit';
  S.original = '';
}

function detachEditor() {
  if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } S.unsub = null; }
  S.ta = null;
}

// ── 渲染（view / edit 两态）──
function promptTitle(s, g) {
  const no = s.shot_no != null ? String(s.shot_no) : String(s.id);
  if (g && g.member_shots.length > 1) {
    return '提示词 · 本组 ' + g.member_shots.length + ' 镜（' + g.member_shots.join(' / ') + '）';
  }
  return '提示词 · 镜 ' + no;
}

function renderDrawer(mode) {
  const d = ensureDrawer();
  const s = S.s;
  if (!s || !d.isOpen()) return;
  const g = groupOf(s, ctx.groupsMap());
  S.mode = mode;
  d.setTitle(promptTitle(s, g));
  if (S.toggleBtn) S.toggleBtn.textContent = (mode === 'edit') ? '💾 保存' : '编辑';
  detachEditor();
  d.bodyEl.textContent = '';
  d.bodyEl.scrollTop = 0;
  if (mode === 'edit') {
    const box = buildEditorDom(d.bodyEl, g);
    S.ta = box.ta;
    S.original = box.ta.value;
    const shelfCtl = buildShelf(box.shelf, {
      onInsert: (text) => insertInto(box.ta, substitute(text, s, ctx.getData())),
      openManager: (fid) => openManager(fid),
      restoreFocus: () => focusTaSoft(),
    });
    S.unsub = shelfCtl ? shelfCtl.off : null;
    editorReset(box.ta);
    wireEditorEvents(box, s);
    growTextarea(box.ta, EDITOR_MIN_H);
    const n = box.ta.value.length;
    setTimeout(() => {
      try { box.ta.focus(); box.ta.setSelectionRange(n, n); } catch (e) { /* ignore */ }
    }, 0);
  } else {
    renderView(d.bodyEl, s, g);
  }
}

function focusTaSoft() {
  if (S.mode !== 'edit' || !S.ta) return;
  try { S.ta.focus({ preventScroll: true }); } catch (e) { S.ta.focus(); }
}

// ── 查看态：徽标着色解析（旧版基准确认：人物绿/场景琥珀/空间锚蓝/镜头紫/风格紫+动作三件套石板灰）──
const PR_NODOT = new Set(['动作表演', '拍摄方式', '画面呈现']);
const PR_RE = /^(@图片\d+|镜头[一二三四五六七八九十百零〇\d]+|场景|空间锚|人物|风格|主光方位|视角|光线|调色|氛围|时长|景别|焦段|景深|机位|运镜|动作表演|拍摄方式|画面呈现)\s*[：:]/;

function prColor(lab) {
  if (lab === '场景') return '#f59e0b';
  if (lab === '空间锚') return '#3b82f6';
  if (lab === '人物') return '#10b981';
  if (/^镜头/.test(lab)) return '#a78bfa';
  if (lab === '风格') return '#8b5cf6';
  if (PR_NODOT.has(lab)) return '#94a3b8';
  return '#6b7280';
}

function appendAnnotated(div, text) {
  const re = /\[[^\]]*\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) div.appendChild(document.createTextNode(text.slice(last, m.index)));
    div.appendChild(el('span', 'pann', m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) div.appendChild(document.createTextNode(text.slice(last)));
}

function renderRichText(box, text) {
  const lines = String(text == null ? '' : text).split('\n');
  for (const line of lines) {
    const div = el('div', 'pline');
    let rest = line;
    const m = PR_RE.exec(line);
    if (m) {
      const lab = m[1];
      const col = prColor(lab);
      if (!PR_NODOT.has(lab)) {
        const dot = el('span', 'pdot', '●');
        dot.style.color = col;
        div.appendChild(dot);
      }
      const labSpan = el('span', 'pl', line.slice(0, m[0].length));
      labSpan.style.color = col;
      div.appendChild(labSpan);
      rest = line.slice(m[0].length);
    }
    appendAnnotated(div, rest);
    box.appendChild(div);
  }
}

function renderView(bodyEl, s, g, data) {
  const wrap = el('div', 'pd-view');
  const rich = el('div', 'prompt-text pd-rich');
  const text = (g && g.text) ? String(g.text) : '';
  if (!text.trim()) {
    rich.appendChild(el('div', 'pd-empty', '（未写提示词）'));
    wrap.appendChild(rich);
    wrap.appendChild(el('div', 'pd-tips', '点「编辑」开始拼装 —— 块库拼积木 + 自由手写'));
  } else {
    renderRichText(rich, text);
    wrap.appendChild(rich);
    wrap.appendChild(el('div', 'pd-tips', '点「编辑」修改 · 「复制」自动过滤 [镜XX] 注释'));
  }
  if (g && g.member_shots.length > 1) {
    const ops = el('div', 'pd-ops');
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
    wrap.appendChild(ops);
  }
  bodyEl.appendChild(wrap);
}

// ── 编辑态 DOM（正文 + 脚部 + 块库条）──
function buildEditorDom(bodyEl, g) {
  const box = el('div', 'hotbox');
  const ta = document.createElement('textarea');
  ta.className = 'hotbox-editor';
  ta.spellcheck = false;
  ta.placeholder = '拼装提示词：点下方块库插入积木，或直接手写…';
  ta.value = (g && g.text) ? g.text : '';

  const foot = el('div', 'hotbox-foot');
  foot.appendChild(el('span', 'hotbox-hint', 'Ctrl+Enter 保存并下一镜 · Esc 返回查看'));

  const draftBtn = el('button', 'tool-btn small dz-violet', '✦ 初稿');
  draftBtn.title = '按本镜数据 + 块库出一版初稿（进编辑面、未保存）';
  const saveBtn = el('button', 'tool-btn small', '存 → 下一镜');
  saveBtn.title = '保存并跳到下一镜的提示词（Ctrl+Enter）';
  const copyBtn = el('button', 'tool-btn small', '拷上组');
  copyBtn.title = '从上一条提示词组拷全文（整段插入到光标处，可 Ctrl+Z）';
  const blockBtn = el('button', 'tool-btn small', '存为块');
  blockBtn.title = '把编辑面里选中的文字存进块库（先选中文字）';
  foot.appendChild(draftBtn);
  foot.appendChild(saveBtn);
  foot.appendChild(copyBtn);
  foot.appendChild(blockBtn);

  const shelf = el('div', 'hotbox-shelf');
  box.appendChild(ta);
  box.appendChild(foot);
  box.appendChild(shelf);
  bodyEl.appendChild(box);
  return { ta: ta, draftBtn: draftBtn, saveBtn: saveBtn, copyBtn: copyBtn, blockBtn: blockBtn, shelf: shelf };
}

// 编辑面事件接线（键处理 / 脚部按钮 / 右键菜单）
function wireEditorEvents(box, s) {
  const ta = box.ta;
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
      renderDrawer('view');       // 收起（不保存）——原口径
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveAndNext();
    }
  });

  box.draftBtn.addEventListener('mousedown', (e) => e.preventDefault());
  box.draftBtn.addEventListener('click', () => {
    openPromptDraft({
      sceneId: ctx.getData().scene.id, shotId: s.id,
      onInsert: (text) => {
        if (S.ta !== ta) { toast('已切换镜头，初稿未插入'); return; }
        replaceAll(ta, text);
        toast('初稿已进编辑面——精修后「保存」才落库（Ctrl+Z 可撤）');
      },
    });
  });
  box.saveBtn.addEventListener('mousedown', (e) => e.preventDefault());
  box.saveBtn.addEventListener('click', () => saveAndNext());
  box.copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
  box.copyBtn.addEventListener('click', () => copyPrevInto(ta, s));
  box.blockBtn.addEventListener('mousedown', (e) => e.preventDefault());
  box.blockBtn.addEventListener('click', () => {
    const sel = selText().trim();
    if (!sel) { toast('先在编辑面里选中要存成块的文字'); return; }
    storeAsBlock(box.blockBtn, sel);
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
          let p0 = sPos;
          if (ta.value.slice(p0, p0 + seg.length) !== seg) {
            p0 = ta.value.indexOf(seg);           // 锚点过期（卡片开着时编辑过）→ 退化：首个相同段
            if (p0 < 0) { toast('选段已变化，未替换——请重新选中再试', 'err'); return; }
          }
          replaceRange(ta, p0, p0 + seg.length, after);   // 范围替换单点（L7）
          toast('已替换选段（Ctrl+Z 可撤）');
        });
      } else if (k === 'all') {
        copyPrevInto(ta, s);
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
          replaceRange(ta, s0, s1, '');                    // 剪切 = 空串替换（L7 单点，也进撤销栈）
          toast('已剪切选中文字（Ctrl+Z 可撤）');
        });
      } else if (k === 'selall') {
        ta.focus();
        ta.select();
      }
    });
  });
}

// ── 保存 ──
async function saveCurrent() {
  if (!S.s || !S.ta) return { ok: true, changed: false };
  return saveText(S.s, S.ta.value, S.original);
}

// 保存正文（未组镜头自动建组）；返回 {ok, changed}
async function saveText(s, text, original) {
  const data = ctx.getData();
  let g = groupOf(s, ctx.groupsMap());
  // 基线现场推导：有组 = 组上现文（别处改过也不会误判「没变」）；无组 = 编辑面本次会话起点
  const base = g ? (g.text || '') : (original || '');
  if (text === base && (g || !String(text).trim())) return { ok: true, changed: false };
  try {
    if (!g) {
      if (!String(text).trim()) { S.original = text; return { ok: true, changed: false }; }
      const res = await api.promptOp('merge', { shot_ids: [s.id] });
      applyPromptGroups(res.groups || []);
      g = groupOf(s, ctx.groupsMap());
      if (!g) { toast('建组失败：未找到新组（请重试）', 'err'); return { ok: false, changed: false }; }
    }
    const prior = g.text || '';                // 保存前组上的现文（撤销目标）
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
            await api.promptOp('set_text', { group_id: gid, text: prior });
            const map = ctx.groupsMap ? ctx.groupsMap() : null;
            if (map && map[gid]) map[gid].text = prior;
            refreshPreviewsForGroup(gid);
            refreshDrawerSoft();
          } catch (err) {
            toast('撤销失败：' + err.message, 'err');
          }
        },
      });
      if (ctx.reapply) ctx.reapply();          // 「未写提示词」等筛选口径随文本变化重评
      refreshPreviewsForGroup(gid);
    }
    return { ok: true, changed: changed };
  } catch (err) {
    toast('提示词保存失败：' + err.message, 'err');
    return { ok: false, changed: false };
  }
}

async function commitClose() {
  if (!dr || !dr.isOpen()) return;
  if (S.mode === 'edit' && S.ta) {
    const r = await saveCurrent();
    if (!r.ok) return;                          // 保存失败：留在编辑面（内容不丢）
  }
  dr.close();
}

async function onToggleMode() {
  if (!dr || !dr.isOpen()) return;
  if (S.mode === 'edit') {
    const r = await saveCurrent();
    if (!r.ok) return;
    renderDrawer('view');
  } else {
    renderDrawer('edit');
  }
}

function onCopy() {
  const s = S.s;
  if (!s) return;
  const g = groupOf(s, ctx.groupsMap());
  const text = (g && g.text) ? String(g.text).replace(/\[[^\]]*\]/g, '') : '';
  if (!text.trim()) { toast('还没有提示词可复制'); return; }
  writeClipboard(text).then((ok) => {
    toast(ok ? '已复制全文（已过滤 [镜XX] 注释）' : '复制失败：浏览器限制，请手动选择');
  });
}

function onOutside(e) {
  const t = e.target;
  if (!dr || !dr.isOpen()) return;
  if (menuEl() && menuEl().contains(t)) return;
  if (t.closest && t.closest('.float-card:not(.scene-freeze), .drawer, #block-manager, #draft-card, #hist-panel, #sel-bar, .ai-diff, [id^="ai-"], .prompt-box, .cell-prompt')) {
    return;                                     // 浮卡/菜单/块库管理/AI 卡/详情预览/提示词列：不算点外（场头不豁免）
  }
  if (dr.isPinned()) return;                    // 钉住：不关
  commitClose();                                // 保存（若编辑中）并关闭
}

// ── 保存并下一镜 / 跳到下一镜 ──
function nextTargetShot(s, gid) {
  const shots = ctx.allShots() || [];
  const i = shots.findIndex((x) => x.id === s.id);
  if (i === -1) return null;
  for (let j = i + 1; j < shots.length; j++) {
    const t = shots[j];
    if (gid != null && t.prompt_group_id === gid) continue;   // 同组 = 同一份提示词，跳过
    return t;
  }
  return null;
}

async function saveAndNext() {
  if (S.mode !== 'edit' || !S.s || !S.ta) return;
  const s = S.s;
  const r = await saveCurrent();
  if (!r.ok) return;                             // 失败：留在编辑面重试（错误已 toast）
  const g = groupOf(s, ctx.groupsMap());
  const t = nextTargetShot(s, g ? g.id : null);
  if (!t) {
    toast('已存 · 已到本场末尾');
    renderDrawer('view');
    return;
  }
  S.shotId = t.id;
  S.s = t;
  renderDrawer('edit');
  toast('已存 · 跳到镜 ' + t.shot_no);
  flashRow(t.id);
}

function flashRow(shotId) {
  const tr = document.querySelector('tr.shot[data-id="' + shotId + '"]');
  if (!tr) return;
  try { tr.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
  tr.classList.add('flash');
  setTimeout(() => tr.classList.remove('flash'), 1600);
}

// ── 只读预览（详情行内；点击在抽屉中打开）──
export function buildPromptBox(s, groups, data) {
  const pb = el('div', 'prompt-box');
  pb._ctx = { s, groups, data };
  renderPreview(pb);
  return pb;
}

function renderPreview(pb) {
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
  const openBtn = el('button', 'tool-btn small', '在抽屉中打开');
  openBtn.title = '打开提示词抽屉（浮动 · 可拖拽 / 贴附 / 钉住）';
  openBtn.addEventListener('mousedown', (e) => e.preventDefault());
  openBtn.addEventListener('click', (e) => { e.stopPropagation(); openPromptDrawer(s.id); });
  head.appendChild(openBtn);
  pb.appendChild(head);

  const body = el('div', 'pb-body pb-read');
  const rich = el('div', 'prompt-text pd-rich');
  const text = (g && g.text) ? String(g.text) : '';
  if (!text.trim()) {
    rich.appendChild(el('div', 'pd-empty', '（未写提示词 — 点击在抽屉中拼装）'));
  } else {
    renderRichText(rich, text);
  }
  body.appendChild(rich);
  body.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest && t.closest('#block-manager')) return;
    openPromptDrawer(s.id);
  });
  pb.appendChild(body);
}

function refreshPreviewsForGroup(gid) {
  document.querySelectorAll('.prompt-box').forEach((pb) => {
    const c = pb._ctx;
    if (!c) return;
    const g = groupOf(c.s, c.groups);
    if (g && g.id === gid) renderPreview(pb);
  });
}

function refreshAllPreviews() {
  document.querySelectorAll('.prompt-box').forEach((pb) => renderPreview(pb));
}

function refreshDrawerSoft() {
  if (dr && dr.isOpen() && S.mode === 'view') renderDrawer('view');
}

function updatePromptCell(s, g) {
  const label = g ? g.member_shots.join(' / ') : '—';
  document.querySelectorAll('tr.shot[data-id="' + s.id + '"] td.cell-prompt').forEach((td) => {
    td.textContent = label;
    if (g) td.title = '提示词组：' + label + '（点击打开）';
    else td.removeAttribute('title');
  });
}

// 写响应就地套用：组态 + 各镜归属 + 提示词格 + 只读预览 + 抽屉（查看态）+ 筛选重评
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
  for (const s of (ctx.allShots() || [])) {
    s.prompt_group_id = (byShot[s.id] != null ? byShot[s.id] : null);
  }
  syncPromptCells();
  refreshAllPreviews();
  refreshDrawerSoft();
  if (ctx.reapply) ctx.reapply();               // 筛选重评（「未写提示词」等）
}

function syncPromptCells() {
  const data = ctx.getData();
  if (!data) return;
  const map = {};
  for (const g of data.prompt_groups) map[g.id] = g;
  for (const s of (ctx.allShots() || [])) {
    updatePromptCell(s, s.prompt_group_id != null ? (map[s.prompt_group_id] || null) : null);
  }
}

// ── 组操作（含撤销快照） ──
function promptSnapshot(data) {
  const idsByGroup = {};
  for (const sh of (ctx.allShots() || [])) {
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

async function runPromptOp(action, payload, focusId, label) {
  const data = ctx.getData();
  if (!data) return false;
  const snap = promptSnapshot(data);
  const wasOpen = !!(dr && dr.isOpen());
  const wasMode = wasOpen ? S.mode : 'edit';
  detachEditor();                                // 丢弃编辑面（组态将变，旧上下文作废）
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
    if (wasOpen) {
      const shots = ctx.allShots() || [];
      const target = (focusId != null) ? shots.find((x) => x.id === focusId) : S.s;
      if (target) { S.shotId = target.id; S.s = target; }
      if (dr.isOpen() && S.s) renderDrawer(wasMode);
    } else if (focusId != null) {
      openPromptDrawer(focusId, { mode: 'edit' });
    }
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

// ── 拷上组：整组拷「上一条提示词组」全文（提示词单一概念，不拆声明段） ──
function prevGroupOf(s, groups, data) {
  const list = (data.prompt_groups || []).slice().sort(byPosition);
  const g = groupOf(s, groups);
  if (g) {
    const i = list.findIndex((x) => x.id === g.id);
    return i > 0 ? list[i - 1] : null;
  }
  const shots = ctx.allShots() || [];
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
function copyPrevInto(ta, s) {
  const prev = prevGroupOf(s, ctx.groupsMap(), ctx.getData());
  if (!prev || !String(prev.text || '').trim()) { toast('上一组还没有提示词可拷'); return; }
  insertInto(ta, substitute(String(prev.text), s, ctx.getData()));
  toast('已拷入上组全文（Ctrl+Z 可撤）');
}
