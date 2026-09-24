// 提示词抽屉（M5 批3）：旧版样式独立抽屉 = 浮层壳（drawer.js）+ 拼装台瓤（M3 全量迁入）。
// 交互口径：Ctrl+Enter 保存并下一镜 · Esc 编辑→查看（不保存）· 查看态 Esc→关闭 · 未钉住点抽屉外＝保存并关闭 · 钉住＝不关（切镜跟随）。
// 写作逻辑不变：块库点插（插入即固化）+ 自由手写；{占位符} 在插入瞬间代入当前镜的值。
import { api } from './api.js';
import { el, toast, durText, isTypingTarget, flashIntoView } from './ui.js';
import { groupsById } from './state.js';
import { openMenu } from './menu.js';
import { recordCustomUndo, undo as globalUndo } from './edit.js';
import { storeAsBlock, byPosition, PLACEHOLDERS } from './blocks.js';
import { shotRow } from './table.js';
import { initBlockCard, cardSetActive, cardSetInsert } from './blockcard.js';
import { writeClipboard, copyText } from './clipboard.js';
import { aiTextMenu } from './aiwrite.js';
import { openPromptDraft } from './draft.js';
import { createDrawer, bindDrawerEsc } from './drawer.js';
import {
  EDITOR_MIN_H, editorPane, editorReset, editorUndo, editorRedo, editorRev,
  editorHasUndo, editorOnInput, editorOnBeforeInput, editorOnCompositionEnd, insertInto, replaceAll, replaceRange,
} from './hbedit.js';

// ctx 注入（scene.js）：getData / refresh / allShots（镜头序单点）/ groupsMap（本帧共用组映射）/ reapply（筛选重评）
let ctx = { getData: () => null, refresh: async () => {}, allShots: () => [], groupsMap: () => null };
export function initHotbox(c) { ctx = Object.assign(ctx, c); }

let dr = null;                    // 抽屉实例（懒建）
let listenersWired = false;   // F4-W18②：原 escWired 一旗管三监听（selectionchange/Esc/钉住浏览），名字如实化
const S = {                       // 抽屉会话状态（F4-W9①：selStatEl 补入字面量，关抽屉即清）
  shotId: null, s: null,
  mode: 'edit',                   // 'view' | 'edit'
  ta: null, original: '', unsub: null,
  toggleBtn: null, selStatEl: null,
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
  const values = {
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
  const map = {};
  for (const k of PLACEHOLDERS) map[k] = Object.prototype.hasOwnProperty.call(values, k) ? values[k] : '';   // 键表单点（F3-W7）：新占位符先入 PLACEHOLDERS
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
    floatPrompt: true,
    save: () => saveCurrent(),                      // F4-L1①：切前静默保存回调（壳 tryLeave 调）
    isEditing: () => S.mode === 'edit',             // F4-L1③：软刷新判定
    render: () => renderDrawer('view'),             // F4-L1③：软刷新重绘（查看态）
  });
  initBlockCard(dr);
  // F4-L1②：重绘钩子（scene.js 经 repaintDrawers 广播）——编辑态＝丢弃关闭（防陈旧上下文写库）；查看态＝重挂内容
  dr.repaint = () => {
    if (!dr.isOpen()) return;
    if (S.mode === 'edit') { dr.close(); return; }
    const s2 = (ctx.allShots() || []).find((x) => x.id === S.shotId);
    if (!s2) { dr.close(); return; }
    S.s = s2;
    renderDrawer('view');
  };
  S.toggleBtn = dr.addStandardButtons({                 // F3-W31：标准钮组单点
    onToggleMode: onToggleMode,
    toggleTitle: '进入编辑面（编辑态无保存钮：Ctrl+Enter／点外面即存）',
    onCopy: onCopy,
    copyTitle: '复制全文（自动过滤 [镜XX] 注释）',
    onClose: () => commitClose(),
  });

  if (!listenersWired) {
    listenersWired = true;
    // 选区字数：查看态（抽屉内渲染文本的 DOM 选区）
    document.addEventListener('selectionchange', () => {
      if (!dr || !dr.isOpen() || S.mode !== 'view') return;
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) { setSelCount(0); return; }
      const n = sel.anchorNode;
      setSelCount((n && dr.el.contains(n)) ? String(sel).length : 0);   // F4-W11：码点展开退役（BMP 中文 .length 语义等同）
    });
    bindDrawerEsc(dr, () => {                        // F4-W39：阶梯单点（原 12 行逐字两份）
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
  if (!(await d.tryLeave())) return;                        // F4-L1①：切换前静默保存（失败留在原镜重试）
  S.shotId = shotId;
  S.s = s;
  const mode = d.isOpen() ? S.mode : (opts.mode || 'edit');
  d.open();
  renderDrawer(mode);
}

// （F4-W14：focusShotComposer 死导出已退役——全库 0 调用；回位走 openPromptDrawer）

// （F4-L1②：原 releaseComposer 已迁入壳钩子——见 ensureDrawer 内 `dr.repaint`；scene.js 经 repaintDrawers 广播）

function resetSession() {                        // F4-W9③：会话态一处归零（原四处散落，selStatEl 漏清）
  S.shotId = null;
  S.s = null;
  S.mode = 'edit';
  S.original = '';
  S.selStatEl = null;
}

function onDrawerClosed() {
  detachEditor();
  clearCover();
  cardSetActive(false);
  resetSession();
}

function detachEditor() {
  if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } S.unsub = null; }
  S.ta = null;
}

// ── 渲染（view / edit 两态）──
function promptTitle(s, g) {
  return '提示词 · ' + (g && g.member_shots.length > 1 ? groupLabel(g) : shotLabel(s));
}

// 镜/组标签格式化单点（F4-W10）：原三套方言（标题 / 状态行 / 预览头）各手拼
function shotLabel(s) {
  const no = s.shot_no != null ? String(s.shot_no) : String(s.id);
  return '镜 ' + no;
}
function groupLabel(g) {
  return '本组 ' + g.member_shots.length + ' 镜（' + g.member_shots.join(' / ') + '）';
}

function renderDrawer(mode) {
  const d = ensureDrawer();
  const s = S.s;
  if (!s || !d.isOpen()) return;
  const g = groupOf(s, ctx.groupsMap());
  S.mode = mode;
  d.setTitle(promptTitle(s, g));
  // 编辑态不设「保存」钮（退役：保存路径＝Ctrl+Enter／点外／✕／钉住切镜）；该钮只在查看态现身
  if (S.toggleBtn) { S.toggleBtn.textContent = '编辑'; S.toggleBtn.hidden = (mode === 'edit'); }
  detachEditor();
  d.bodyEl.textContent = '';
  d.bodyEl.scrollTop = 0;
  d.bodyEl.appendChild(buildStatRow(s, g));
  if (mode === 'edit') {
    const box = buildEditorDom(d.bodyEl, g);
    S.ta = box.ta;
    S.original = box.ta.value;
    cardSetInsert((text) => {
      insertInto(box.ta, substitute(text, s, ctx.getData()));
      focusTaSoft();
    });
    cardSetActive(true);
    editorReset(box.ta);
    wireEditorEvents(box, s);
  } else {
    cardSetActive(false);
    renderView(d.bodyEl, s, g);
  }
  refreshCover();
}

// ── 覆盖高亮（B 聚焦降噪）：打开抽屉时，提示词覆盖的镜头行高亮、其余退噪 ──
function coverIdsOf(s) {
  const g = groupOf(s, ctx.groupsMap());
  return (g && g.member_ids && g.member_ids.length) ? g.member_ids.slice() : [s.id];
}

function refreshCover() {
  const on = !!(dr && dr.isOpen() && S.s);
  const ids = on ? coverIdsOf(S.s) : null;
  document.querySelectorAll('tr.shot').forEach((tr) => {          // F4-W4c：差量写类（新/旧态一致时不再整表重写）
    const want = !on ? '' : (ids.indexOf(Number(tr.dataset.id)) !== -1 ? 'cover' : 'cover-off');
    const hasC = tr.classList.contains('cover');
    const hasO = tr.classList.contains('cover-off');
    if (want === 'cover' && !hasC) tr.classList.add('cover');
    else if (hasC) tr.classList.remove('cover');
    if (want === 'cover-off' && !hasO) tr.classList.add('cover-off');
    else if (hasO) tr.classList.remove('cover-off');
  });
}

function clearCover() {
  document.querySelectorAll('tr.shot.cover, tr.shot.cover-off')
    .forEach((tr) => tr.classList.remove('cover', 'cover-off'));
}

// 已选字数（单点）：S.selStatEl 由 buildStatRow 每次重建
function setSelCount(n) {
  const sp = S.selStatEl;
  if (!sp) return;
  if (n > 0) { sp.textContent = '已选 ' + n + ' 字'; sp.hidden = false; }
  else { sp.textContent = ''; sp.hidden = true; }
}

// 状态行（三段固定·头）：镜号 · 组/覆盖镜 · 已选/字数
function buildStatRow(s, g) {
  const row = el('div', 'pd-stat');
  const left = el('span');
  left.appendChild(el('span', 'k', shotLabel(s)));
  if (g && g.member_shots.length > 1) {
    const n = groupOrdinal(g, ctx.getData());
    left.appendChild(document.createTextNode(
      ' · ' + (n ? '组' + n : '成组') + ' · 覆盖 ' + g.member_shots.length + ' 镜（' + g.member_shots.join(' / ') + '）'));
  } else {
    left.appendChild(document.createTextNode(' · 单镜'));
  }
  row.appendChild(left);
  const right = el('span', 'pd-stat-right');
  S.selStatEl = el('span', 'pd-stat-sel');
  S.selStatEl.hidden = true;
  right.appendChild(S.selStatEl);
  const text = (g && g.text) ? String(g.text) : '';
  right.appendChild(el('span', 'pd-stat-r', text.trim() ? ('约 ' + text.length + ' 字') : '未写'));
  row.appendChild(right);
  return row;
}

function focusTaSoft() {
  if (S.mode !== 'edit' || !S.ta) return;
  try { S.ta.focus({ preventScroll: true }); } catch (e) { S.ta.focus(); }
}

// ── 查看态：徽标着色解析（旧版基准确认：人物绿/场景琥珀/空间锚蓝/镜头紫/风格紫+动作三件套石板灰）──
// F4-W13：内联巨正则 → 词表小表（正则由表生成；色值冻结不变＝视觉零变化）
const PR_WORDS = [
  '@图片\\d+', '镜头[一二三四五六七八九十百零〇\\d]+', '场景', '空间锚', '人物', '风格', '主光方位', '视角', '光线', '调色',
  '氛围', '时长', '景别', '焦段', '景深', '机位', '运镜', '动作表演', '拍摄方式', '画面呈现',
];
const PR_NODOT = new Set(['动作表演', '拍摄方式', '画面呈现']);
const PR_RE = new RegExp('^(' + PR_WORDS.join('|') + ')\\s*[：:]');

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

function renderView(bodyEl, s, g) {   // F4-W18①：死参 data 退役（函数体零引用）
  const scroll = el('div', 'pd-scroll');
  let footZone = null;
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
    const mem = el('div', 'pd-members');
    mem.appendChild(el('span', 'pd-mem-label', '成员：'));
    for (let i = 0; i < g.member_ids.length; i++) {
      const mid = g.member_ids[i];
      const chip = el('button', 'pd-mem-chip' + (mid === s.id ? ' cur' : ''), String(g.member_shots[i]));
      chip.title = (mid === s.id ? '本镜' : '点此跳到镜 ' + g.member_shots[i]);
      chip.addEventListener('mousedown', (e) => e.preventDefault());
      if (mid !== s.id) chip.addEventListener('click', () => jumpToShot(mid));
      mem.appendChild(chip);
    }
    wrap.appendChild(mem);
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
    footZone = el('div', 'pd-foot');
    footZone.appendChild(ops);
    footZone.appendChild(el('div', 'pd-tips', '换成员：选区条「并为一组 / 独立成组」 · 右键「并入上一组」'));
  }
  scroll.appendChild(wrap);
  bodyEl.appendChild(scroll);
  if (footZone) bodyEl.appendChild(footZone);
}

// ── 编辑态 DOM（正文 + 脚部 + 块库条）──
function buildEditorDom(bodyEl, g) {
  const pane = editorPane({                        // F4-W1：六连写收进 hbedit.editorPane 单点
    cls: 'hotbox',
    parent: bodyEl,
    placeholder: '拼装提示词：点左侧块库插入积木，或直接手写…',
    value: (g && g.text) ? g.text : '',
    hint: 'Ctrl+Enter 存 → 下一镜 · Esc 返回',
    minH: EDITOR_MIN_H,
    onSave: () => saveAndNext(),
    onEsc: () => renderDrawer('view'),             // 收起（不保存）——原口径
  });
  const box = pane.box;
  const ta = pane.ta;

  const foot = el('div', 'hotbox-foot');
  if (pane.hintEl) foot.appendChild(pane.hintEl);
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
  box.appendChild(foot);
  return { ta: ta, draftBtn: draftBtn, saveBtn: saveBtn, copyBtn: copyBtn, blockBtn: blockBtn };
}

// 编辑面事件接线（键处理 / 脚部按钮 / 右键菜单）——F4-W8：111 行四职拆三分
function wireEditorEvents(box, s) {
  const ta = box.ta;
  const selText = () => ta.value.slice(ta.selectionStart, ta.selectionEnd);
  bindEditorKeys(ta);
  bindEditorFooter(box, s, ta, selText);
  bindEditorMenu(ta, s, selText);
}

function bindEditorKeys(ta) {
  ta.addEventListener('input', () => editorOnInput(ta));
  ta.addEventListener('beforeinput', (e) => editorOnBeforeInput(ta, e));   // F2-W21：按输入事务分段（组合期不切段）
  ta.addEventListener('compositionend', () => editorOnCompositionEnd(ta));
  // 选区字数：编辑面（textarea 选区）
  const selCount = () => { const v = ta.value.slice(ta.selectionStart, ta.selectionEnd); setSelCount(v.trim() ? v.length : 0); };   // F4-W11
  ta.addEventListener('select', selCount);
  ta.addEventListener('keyup', selCount);
  ta.addEventListener('mouseup', selCount);
  ta.addEventListener('blur', () => setSelCount(0));
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
    // Esc / Ctrl+Enter 已由 editorPane 装配（F4-W1）
  });
}

function bindEditorFooter(box, s, ta, selText) {
  box.draftBtn.addEventListener('mousedown', (e) => e.preventDefault());
  box.draftBtn.addEventListener('click', () => {
    openPromptDraft({
      sceneId: ctx.getData().scene.id, shotId: s.id,
      onInsert: (text) => {
        if (S.ta !== ta) { toast('已切换镜头，初稿未插入'); return; }
        replaceAll(ta, text);
        toast('初稿已进编辑面——精修后 Ctrl+Enter／点外面保存落库（Ctrl+Z 可撤）');
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
}

function bindEditorMenu(ta, s, selText) {
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
        const rev = editorRev(ta);                      // F4-W12：选段身份＝rev + 选区（锚点过期不再退化成首个相同段）
        aiTextMenu(pt, seg, ta.value, (after) => {
          if (editorRev(ta) !== rev || ta.value.slice(sPos, sPos + seg.length) !== seg) {
            toast('选段已变化，未替换——请重新选中再试', 'err');
            return;
          }
          replaceRange(ta, sPos, sPos + seg.length, after);   // 范围替换单点（L7）
          toast('已替换选段（Ctrl+Z 可撤）');
        });
      } else if (k === 'all') {
        copyPrevInto(ta, s);
      } else if (k === 'copy') {
        copyText(selText(), '已复制选中文字');
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
// 未变判定（F4-W18③）：有组＝与组文同；无组＝与基线同且非空白
function unchanged(text, base, g) {
  if (g) return text === base;
  return text === base && !String(text).trim();
}

async function saveText(s, text, original) {
  const data = ctx.getData();
  let g = groupOf(s, ctx.groupsMap());
  // 基线现场推导：有组 = 组上现文（别处改过也不会误判「没变」）；无组 = 编辑面本次会话起点
  const base = g ? (g.text || '') : (original || '');
  if (unchanged(text, base, g)) return { ok: true, changed: false };   // F4-W18③：三合一判拆谓词
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
      recordCustomUndo('提示词', async () => {          // F4-W36：撤销登记单点
        await api.promptOp('set_text', { group_id: gid, text: prior });
        const map = ctx.groupsMap ? ctx.groupsMap() : null;
        if (map && map[gid]) map[gid].text = prior;
        refreshPromptViews(gid);                        // F4-W2：扇出单点
      });
      if (ctx.reapplyActive && ctx.reapplyActive()) ctx.reapply();   // F4-W5：无筛选时不重评（原无条件清选区+全表重算）
      refreshPromptViews(gid);
    }
    return { ok: true, changed: changed };
  } catch (err) {
    toast('提示词保存失败：' + err.message, 'err');
    return { ok: false, changed: false };
  }
}

async function commitClose() {
  if (!dr || !dr.isOpen()) return;
  const at = S.shotId;
  if (!(await dr.tryLeave())) return;           // F4-L1①：保存失败：留在编辑面（内容不丢）
  if (S.shotId !== at) return;                  // 关闭期间已切到别的镜：不补关
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
  copyText(text, '已复制全文（已过滤 [镜XX] 注释）');   // F4-W44②：失败文案走单点默认
}

function onOutside() {
  // 点外收口（F2-L3）：过滤链已收编 drawer 基件（浮卡/菜单豁免 + 钉住）；这里只收
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
  jumpToShot(t.id);                        // F4-W17：闪烁三件套单点（flashRow 逐字两份退役）
}

// ── 只读预览（详情行内；点击在抽屉中打开）──
const PB_CTX = new WeakMap();                      // F4-W37：预览上下文进 WeakMap（原 DOM expando）
export function buildPromptBox(s, groups, data) {
  const pb = el('div', 'prompt-box');
  PB_CTX.set(pb, { s, groups, data });
  renderPreview(pb);
  return pb;
}

function renderPreview(pb) {
  const { s, groups } = PB_CTX.get(pb) || {};
  const g = groupOf(s, groups);
  pb.textContent = '';

  const head = el('div', 'pb-head');
  const label = el('div', 'kv-label');
  label.textContent = g
    ? (g.member_shots.length > 1 ? '提示词（' + groupLabel(g) + '）' : '提示词（镜 ' + g.member_shots[0] + '）')
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
  body.addEventListener('click', () => {
    openPromptDrawer(s.id);
  });
  pb.appendChild(body);
}

function refreshPreviewsForGroup(gid) {
  document.querySelectorAll('.prompt-box').forEach((pb) => {
    const c = PB_CTX.get(pb);
    if (!c) return;
    const g = groupOf(c.s, c.groups);
    if (g && g.id === gid) renderPreview(pb);
  });
}

function refreshAllPreviews() {
  document.querySelectorAll('.prompt-box').forEach((pb) => {
    if (pb.offsetParent === null) return;   // F4-W4b：隐藏详情行里的预览卡不重建（纯废功）
    renderPreview(pb);
  });
}

function refreshDrawerSoft() {
  if (dr) dr.softRefresh();                     // F4-L1③：判定收壳（开着且非编辑态才重绘）
}

// 提示词写响应扇出单点（F4-W2）：组预览 → 抽屉查看态 → 覆盖高亮
function refreshPromptViews(gid) {
  refreshPreviewsForGroup(gid);
  refreshDrawerSoft();
  refreshCover();
}

// 提示词格渲染（初始表 + 组态刷新共用；成组多镜出徽标「组N · x镜」）
export function paintPromptCell(td, g, data) {
  const multi = !!(g && g.member_shots.length > 1);
  const label = g ? g.member_shots.join(' / ') : '—';
  td.textContent = '';
  if (multi && data) {
    const n = groupOrdinal(g, data);
    const b = el('span', 'pg-badge', n ? ('组' + n + ' · ' + g.member_shots.length + '镜') : (g.member_shots.length + '镜'));
    b.title = '提示词组 ' + label;
    td.appendChild(b);
  }
  td.appendChild(document.createTextNode(label));
  if (g) td.title = '提示词组：' + label + '（点击打开）';
  else td.removeAttribute('title');
}

function updatePromptCell(s, g, data) {
  shotRow(s.id).querySelectorAll('td.cell-prompt').forEach((td) => paintPromptCell(td, g, data));   // F4-W41：行单点
}

// 写响应就地套用（F4-W3）：组归属落定（adoptGroups）与重画扇出（repaintPromptViews）拆开，map 只建一次
export function applyPromptGroups(list) {
  const data = ctx.getData();
  if (!data) return;
  adoptGroups(list, data);
  repaintPromptViews(data);
}

// 组态 → 本地数据模型（list 落 data + 各镜归属；共享 map 同步）
function adoptGroups(list, data) {
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
}

// 组态变更后的重画扇出（F4-W2 单点）：组序号缓存失效 → 提示词格 → 预览 → 抽屉 → 覆盖 → 筛选重评
function repaintPromptViews(data) {
  groupOrdinalMap = null;                          // F4-W6：组序号缓存随组态失效
  syncPromptCells(data);
  refreshAllPreviews();
  refreshDrawerSoft();
  refreshCover();
  if (ctx.reapplyActive && ctx.reapplyActive()) ctx.reapply();   // F4-W5：无筛选时不重评
}

function syncPromptCells(data) {
  const map = groupsById(data);
  for (const s of (ctx.allShots() || [])) {
    updatePromptCell(s, s.prompt_group_id != null ? (map[s.prompt_group_id] || null) : null, data);
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
    recordCustomUndo(label, async () => {                    // F4-W36：撤销登记单点
      const r2 = await api.promptOp('restore', { scene_id: snap.scene_id, groups: snap.groups });
      if (r2 && r2.groups) applyPromptGroups(r2.groups);
      else await ctx.refresh();
    });
    if (res && res.groups) applyPromptGroups(res.groups);   // 就地套用写响应（全量组态），不再全量重拉
    else await ctx.refresh();
    if (wasOpen) {
      const shots = ctx.allShots() || [];
      const target = (focusId != null) ? shots.find((x) => x.id === focusId) : S.s;
      if (target) { S.shotId = target.id; S.s = target; }
      if (dr.isOpen() && S.s) renderDrawer(wasMode);
    } else if (focusId != null) {
      jumpToShot(focusId);   // 分组导览：滚到并闪烁——分组≠编辑提示词，不弹面板
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

// ── N4：分组标识与「并入上一组」──

// 跳镜：滚到该行并闪烁（成员 chips 用）
function jumpToShot(shotId) {
  const tr = shotRow(shotId);              // F4-W41：行单点
  if (!tr) { toast('该镜不在当前视图（可能被筛选隐藏）'); return; }
  flashIntoView(tr);
}

// 组序号（按场序：全部组一起数）；F4-W6：预建 id→序 Map，组态变更时失效（O(G log G)→O(1)）
let groupOrdinalMap = null;
function ordinalMapOf(data) {
  if (groupOrdinalMap) return groupOrdinalMap;
  const list = (data.prompt_groups || []).slice().sort(byPosition);
  groupOrdinalMap = new Map();
  for (let i = 0; i < list.length; i++) groupOrdinalMap.set(list[i].id, i + 1);
  return groupOrdinalMap;
}
function groupOrdinal(g, data) {
  const i = ordinalMapOf(data).get(g.id);
  return i == null ? null : i;
}

// 本镜能否并入上一组（上方存在其它提示词组）
export function canJoinPrev(shotId) {
  return !!prevGroupBefore(shotId);
}

// 并入上一组：本镜所在组整体并入上方最近的另一组（上一组为主组）
export async function joinPrevGroup(shotId) {
  const found = prevGroupBefore(shotId);
  if (!found) { toast('上方没有可并入的组'); return false; }
  const { g, prev } = found;
  const ids = [prev.member_ids[0]];
  for (const mid of (g ? g.member_ids : [shotId])) if (!ids.includes(mid)) ids.push(mid);
  await promptOpUI('merge', { shot_ids: ids }, ids[0], ids.length);
  return true;
}

// 向上找最近的其它组（F4-W7）：canJoinPrev / joinPrevGroup / prevGroupOf 三处共用（原判定循环逐字三份）
function prevGroupBefore(shotId) {
  const data = ctx.getData();
  if (!data) return null;
  const shots = ctx.allShots() || [];
  const i = shots.findIndex((x) => x.id === shotId);
  if (i <= 0) return null;
  const map = ctx.groupsMap ? ctx.groupsMap() : null;
  const g = groupOf(shots[i], map);
  for (let k = i - 1; k >= 0; k--) {
    const pg = groupOf(shots[k], map);
    if (pg && (!g || pg.id !== g.id)) return { g: g, prev: pg };
  }
  return null;
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
