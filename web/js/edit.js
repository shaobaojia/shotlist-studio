// 就地编辑引擎：点击即编 / 自动保存（无保存键）/ Esc 取消 / Ctrl+Z 撤销栈。
// 写路径统一走 api.update（服务端白名单 + 痕迹）；乐观更新，失败回滚。
import { api } from './api.js';
import { toast } from './ui.js';

const undoStack = [];
const UNDO_MAX = 100;

export function recordUndo(op) {
  undoStack.push(op);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

export function canUndo() {
  return undoStack.length > 0;
}

export async function undo() {
  const op = undoStack.pop();
  if (!op) {
    toast('没有可撤销的操作');
    return false;
  }
  try {
    if (op.type === 'field') {
      await api.update(op.table, op.id, op.field, op.restore);
      toast('已撤销：' + op.label);
      return true;
    }
    if (op.type === 'renumber') {
      for (const c of op.changes) {
        await api.update('shots', c.id, 'shot_no', c.old == null ? '' : c.old);
      }
      toast('已撤销镜号整理');
      return true;
    }
  } catch (err) {
    toast('撤销失败：' + err.message, 'err');
  }
  return false;
}

// cfg: { table, id, field, label, getValue(), onLocal(v), renderCell(),
//        multiline?, select?: [options] }
export function attachEditable(host, cfg) {
  host.classList.add('editable');
  if (!host.title) host.title = '点击编辑';
  host.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (host.querySelector('.cell-editor')) return;
    openEditor(host, cfg);
  });
}

function openEditor(host, cfg) {
  const original = cfg.getValue() == null ? '' : String(cfg.getValue());
  let ed;
  if (cfg.select) {
    ed = document.createElement('select');
    const opts = cfg.select.slice();
    if (original && opts.indexOf(original) === -1) opts.push(original);
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = o;
      op.textContent = o;
      ed.appendChild(op);
    }
    ed.value = original;
  } else {
    ed = document.createElement(cfg.multiline ? 'textarea' : 'input');
    if (cfg.multiline) {
      ed.rows = Math.min(8, Math.max(2, original.split('\n').length));
      ed.placeholder = 'Ctrl+Enter 保存 · Esc 取消';
    } else {
      ed.placeholder = 'Enter 保存 · Esc 取消';
    }
    ed.value = original;
  }
  ed.className = 'cell-editor';
  host.classList.add('editing');
  host.textContent = '';
  host.appendChild(ed);
  ed.focus();
  if (ed.tagName === 'INPUT') ed.select();

  let closed = false;
  const close = (commit) => {
    if (closed) return;
    closed = true;
    const nv = ed.value;
    host.classList.remove('editing');
    cfg.renderCell();
    if (commit && nv !== original) save(cfg, original, nv);
  };
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    } else if (e.key === 'Enter' && ed.tagName !== 'SELECT' && (!cfg.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      close(true);
    }
  });
  if (ed.tagName === 'SELECT') ed.addEventListener('change', () => close(true));
  ed.addEventListener('blur', () => close(true));
}

async function save(cfg, oldV, newV) {
  cfg.onLocal(newV);
  cfg.renderCell(); // 乐观更新
  try {
    await api.update(cfg.table, cfg.id, cfg.field, newV);
    recordUndo({ type: 'field', table: cfg.table, id: cfg.id, field: cfg.field, restore: oldV, label: cfg.label });
  } catch (err) {
    cfg.onLocal(oldV);
    cfg.renderCell();
    toast('保存失败：' + err.message, 'err');
  }
}
