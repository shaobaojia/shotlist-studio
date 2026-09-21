// 拼装台编辑面撤销栈（块插入 / 剪切 / 打字片段都进栈；Ctrl+Z 撤 · Ctrl+Shift+Z / Ctrl+Y 重做）。
// 独立模块：挂在 textarea.__hb 上（每只编辑面一条栈）。视图与组操作在 hotbox.js。
import { growTextarea } from './ui.js';

export const EDITOR_MIN_H = 130;   // 编辑面最小高度（px）
const STACK_MAX = 200;             // 栈深上限
const SEGMENT_MS = 600;            // 打字分段：同段合并，新段（间隔 >600ms）把段前状态入栈

function state(ta) {
  if (!ta.__hb) ta.__hb = { undo: [], redo: [], last: null, t: 0 };
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
  hb.t = Date.now();
}

export function editorHasUndo(ta) {
  return state(ta).undo.length > 0;
}

// 输入事件：新段开始时把段前状态入栈（打字按段撤销）
export function editorOnInput(ta) {
  const hb = state(ta);
  if (Date.now() - hb.t > SEGMENT_MS) {
    const prev = hb.last || snap(ta);
    const top = hb.undo[hb.undo.length - 1];
    if (!same(top, prev)) {
      hb.undo.push(prev);
      cap(hb);
      hb.redo.length = 0;
    }
  }
  hb.last = snap(ta);
  hb.t = Date.now();
  growTextarea(ta, EDITOR_MIN_H);
}

export function editorPush(ta) {
  const hb = state(ta);
  const cur = snap(ta);
  const top = hb.undo[hb.undo.length - 1];
  if (!same(top, cur)) {
    hb.undo.push(cur);
    cap(hb);
  }
  hb.redo.length = 0;
  hb.last = cur;
  hb.t = Date.now();
}

export function editorMark(ta) {
  const hb = state(ta);
  hb.last = snap(ta);
  hb.t = Date.now();
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

// 光标处插入（保住光标 · 自动长高；插入也进撤销栈）
export function insertInto(ta, text) {
  if (text == null || text === '') return;
  editorPush(ta);
  const s0 = ta.selectionStart;
  const s1 = ta.selectionEnd;
  const before = ta.value.slice(0, s0);
  const after = ta.value.slice(s1);
  const lead = (before && !/\n\s*$/.test(before)) ? '\n\n' : '';
  ta.value = before + lead + text + after;
  const pos = (before + lead + text).length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  growTextarea(ta, EDITOR_MIN_H);
  editorMark(ta);
}

// 整文替换（初稿落入等；进撤销栈——Ctrl+Z 可撤）
export function replaceAll(ta, text) {
  if (text == null) return;
  editorPush(ta);
  ta.value = text;
  const pos = text.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  growTextarea(ta, EDITOR_MIN_H);
  editorMark(ta);
}
