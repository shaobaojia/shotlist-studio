// 拼装台编辑面撤销栈（块插入 / 剪切 / 打字片段都进栈；Ctrl+Z 撤 · Ctrl+Shift+Z / Ctrl+Y 重做）。
// 独立模块：挂在 textarea.__hb 上（每只编辑面一条栈）。视图与组操作在 hotbox.js。
// F2-W21：打字分段改挂 beforeinput（按 inputType 切段——连续 insertText 同段，删除/替换等独立成段）；
// 时间阈值（SEGMENT_MS）退役；IME 组合期不切段，组合结束补标记。
import { growTextarea } from './ui.js';

export const EDITOR_MIN_H = 130;   // 编辑面最小高度（px）
const STACK_MAX = 200;             // 栈深上限

function state(ta) {
  if (!ta.__hb) ta.__hb = { undo: [], redo: [], last: null, kind: '' };
  return ta.__hb;
}

function snap(ta) {
  return { v: ta.value, s0: ta.selectionStart, s1: ta.selectionEnd };
}

function same(a, b) {
  return !!(a && b) && a.v === b.v && a.s0 === b.s0 && a.s1 === b.s1;
}

function cap(hb) {
  if (hb.undo.length > STACK_MAX) hb.undo.shift();
  if (hb.redo.length > STACK_MAX) hb.redo.shift();
}

export function editorReset(ta) {
  const hb = state(ta);
  hb.undo.length = 0;
  hb.redo.length = 0;
  hb.last = snap(ta);
  hb.kind = '';
}

export function editorHasUndo(ta) {
  return state(ta).undo.length > 0;
}

// 分段开新（F2-W21）：把「段前状态」入栈（打字按段撤销）
function openSegment(ta) {
  const hb = state(ta);
  const prev = hb.last || snap(ta);
  const top = hb.undo[hb.undo.length - 1];
  if (!same(top, prev)) {
    hb.undo.push(prev);
    cap(hb);
    hb.redo.length = 0;
  }
}

// 输入事件：只维护快照与自增长（F2-W21：分段在 beforeinput，这里不再看时间）
export function editorOnInput(ta) {
  const hb = state(ta);
  hb.last = snap(ta);
  growTextarea(ta, EDITOR_MIN_H);
}

// 输入分段（F2-W21）：连续 insertText 并入当前段；删除/替换/粘贴等动作独立成段
export function editorOnBeforeInput(ta, e) {
  const hb = state(ta);
  if (e.isComposing || (e.inputType || '') === 'insertCompositionText') return;   // 组合期：不切段
  if ((e.inputType || '') === 'insertText') {
    if (hb.kind === 'insertText') return;   // 连续打字：同段
    openSegment(ta);
    hb.kind = 'insertText';
    return;
  }
  openSegment(ta);                          // deleteContentBackward / insertFromPaste / …：独立成段
  hb.kind = 'other';
}

// 组合结束（F2-W21）：闭段（下一次 insertText 开新段）
export function editorOnCompositionEnd(ta) {
  const hb = state(ta);
  hb.kind = '';
}

function editorPush(ta) {
  const hb = state(ta);
  const cur = snap(ta);
  const top = hb.undo[hb.undo.length - 1];
  if (!same(top, cur)) {
    hb.undo.push(cur);
    cap(hb);
  }
  hb.redo.length = 0;
  hb.last = cur;
}

function editorMark(ta) {
  const hb = state(ta);
  hb.last = snap(ta);
}

function apply(ta, st) {
  ta.value = st.v;
  ta.focus();
  ta.setSelectionRange(st.s0, st.s1);
  growTextarea(ta, EDITOR_MIN_H);
  editorMark(ta);
}

export function editorUndo(ta) {
  const hb = state(ta);
  if (!hb.undo.length) return;
  hb.redo.push(snap(ta));
  cap(hb);
  apply(ta, hb.undo.pop());
}

export function editorRedo(ta) {
  const hb = state(ta);
  if (!hb.redo.length) return;
  hb.undo.push(snap(ta));
  cap(hb);
  apply(ta, hb.redo.pop());
}

// 范围替换（L7 单点：选段改写 / 剪切 / 插入 / 整文替换共用；进撤销栈）。
// 返回新光标位（= s0 + text.length）；text 为空串即删除该范围（剪切用）。
// F2-W20：回写序列复用 apply（原「五步」与 apply 重复一遍）。
export function replaceRange(ta, s0, s1, text) {
  editorPush(ta);
  const pos = s0 + text.length;
  apply(ta, { v: ta.value.slice(0, s0) + text + ta.value.slice(s1), s0: pos, s1: pos });
  return pos;
}

// 光标处插入（保住光标 · 自动长高；插入也进撤销栈）
export function insertInto(ta, text) {
  if (text == null || text === '') return;
  const s0 = ta.selectionStart;
  const s1 = ta.selectionEnd;
  const before = ta.value.slice(0, s0);
  const lead = (before && !/\n\s*$/.test(before)) ? '\n\n' : '';
  replaceRange(ta, s0, s1, lead + text);
}

// 整文替换（初稿落入等；进撤销栈——Ctrl+Z 可撤）
export function replaceAll(ta, text) {
  if (text == null) return;
  replaceRange(ta, 0, ta.value.length, text);
}
