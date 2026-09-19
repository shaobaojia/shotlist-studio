// 就地编辑引擎：点击即编 / 自动保存（无保存键）/ Esc 取消 / Ctrl+Z 撤销栈。
// 写路径统一走 api.update（服务端白名单 + 痕迹）；乐观更新，失败回滚。
// 摄影机复合控件（景别×2 + 焦段）也在这里：改动即存，含旧格式归一化（内嵌焦段/景深迁入独立字段）。
// 单选字段与复合控件走自绘浮动菜单（menu.js，非原生 select）：一次点击直达列表，拾取不关表单。
import { api } from './api.js';
import { toast } from './ui.js';
import { openMenu, closeMenu, menuOpen, menuEl } from './menu.js';

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
    if (op.type === 'custom') {
      await op.undo();
      toast('已撤销：' + (op.label || '操作'));
      return true;
    }
  } catch (err) {
    toast('撤销失败：' + err.message, 'err');
  }
  return false;
}

// cfg: { table, id, field, label, getValue(), onLocal(v), renderCell(),
//        multiline?, select?: [options], save?: async (oldV, newV) => (抛错=失败) }
export function attachEditable(host, cfg) {
  host.classList.add('editable');
  if (!host.title) host.title = '点击编辑';
  host.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (cfg.select) {
      openSelectMenu(host, cfg);
      return;
    }
    if (host.querySelector('.cell-editor')) return;
    openEditor(host, cfg);
  });
}

// 单选字段：点击 → 浮动菜单就地选（一次点击直达列表）
function openSelectMenu(host, cfg) {
  const original = cfg.getValue() == null ? '' : String(cfg.getValue());
  const opts = cfg.select.slice();
  if (original && opts.indexOf(original) === -1) opts.push(original);
  const items = opts.map((o) => ({ key: o, label: o, current: o === original }));
  host.classList.add('editing');
  openMenu(host, items, (v) => {
    if (v !== original) save(cfg, original, v);
  }, { onClosed: () => host.classList.remove('editing') });
}

function openEditor(host, cfg) {
  const original = cfg.getValue() == null ? '' : String(cfg.getValue());
  const ed = document.createElement(cfg.multiline ? 'textarea' : 'input');
  ed.value = original;
  ed.title = cfg.multiline ? 'Ctrl+Enter 保存 · Esc 取消' : 'Enter 保存 · Esc 取消';
  ed.className = 'cell-editor';
  host.classList.add('editing');
  host.textContent = '';
  host.appendChild(ed);
  fitEditorOpen(ed, host);
  ed.focus();
  if (ed.tagName === 'INPUT') {
    ed.select();
  } else {
    ed.setSelectionRange(ed.value.length, ed.value.length);
  }

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
    } else if (e.key === 'Enter' && (!cfg.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      close(true);
    }
  });
  if (ed.tagName === 'TEXTAREA') ed.addEventListener('input', () => fitEditorLive(ed));
  ed.addEventListener('blur', () => close(true));
}

async function save(cfg, oldV, newV) {
  cfg.onLocal(newV);
  cfg.renderCell();
  if (cfg.save) {
    try {
      await cfg.save(oldV, newV);
    } catch (err) {
      cfg.onLocal(oldV);
      cfg.renderCell();
      toast('保存失败：' + err.message, 'err');
    }
    return;
  }
  try {
    await api.update(cfg.table, cfg.id, cfg.field, newV);
    recordUndo({ type: 'field', table: cfg.table, id: cfg.id, field: cfg.field, restore: oldV, label: cfg.label });
  } catch (err) {
    cfg.onLocal(oldV);
    cfg.renderCell();
    toast('保存失败：' + err.message, 'err');
  }
}

// 打开时：贴合格子现有高度（不触发强制回流、不推挤下方行）；下一帧校正防裁切
function fitEditorOpen(ed, host) {
  if (ed.tagName !== 'TEXTAREA') return;
  const cs = getComputedStyle(host);
  const avail = host.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
  if (avail > 0) ed.style.height = avail + 'px';
  requestAnimationFrame(() => {
    if (ed.isConnected && ed.scrollHeight > ed.clientHeight + 1) ed.style.height = ed.scrollHeight + 'px';
  });
}

// 输入中：按内容自动长高
function fitEditorLive(ed) {
  if (ed.tagName !== 'TEXTAREA') return;
  ed.style.height = 'auto';
  ed.style.height = ed.scrollHeight + 'px';
}

// ── 摄影机复合控件 ──

// 解析摄影机串：'近景 ★★★★ ↓ 中全 ★★ 50mm·中→深' → { t1, t2, lens, dof }
export function parseCam(raw) {
  const v = (raw == null ? '' : String(raw)).trim();
  let rest = v;
  let lens = null;
  let dof = null;
  const m = rest.match(/(\d+mm)(?:·(?:浅|中|深)(?:→(?:浅|中|深))?)?/);
  if (m) {
    lens = m[1];
    const d = m[0].match(/·(浅|中|深)→(浅|中|深)/) || m[0].match(/·(浅|中|深)/);
    dof = d ? (d[2] ? d[1] + '→' + d[2] : d[1]) : null;
    rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim();
  }
  const parts = rest.indexOf('↓') !== -1 ? rest.split('↓').map((x) => x.trim()) : [rest];
  return { t1: parts[0] || '', t2: parts[1] || null, lens: lens, dof: dof };
}

const NONE = '（无）';

// cfg: { id, getCam() -> {raw, focal, dof}, setCam(field, v), renderCell(), camOptions() -> {tiers, lens} }
export function attachCamEditor(host, cfg) {
  host.classList.add('editable');
  if (!host.title) host.title = '点击编辑（景别 / 焦段）';
  host.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (host.querySelector('.cam-editor')) return;
    openCamForm(host, cfg);
  });
}

function openCamForm(host, cfg) {
  const cam = cfg.getCam();
  const opts = cfg.camOptions();
  const p = parseCam(cam.raw);
  let v1 = p.t1 || (opts.tiers[0] || '');
  let v2 = p.t2 == null ? NONE : p.t2;
  let v3 = (p.lens || cam.focal || '') || NONE;

  const wrap = document.createElement('div');
  wrap.className = 'cam-editor';

  // 槽位：点击 → 浮动菜单（一次点击直达列表；拾取后就地更新并落库，表单保持打开）
  const mkSlot = (get, set, options) => {
    const slot = document.createElement('div');
    slot.className = 'cam-slot';
    const txt = document.createElement('span');
    txt.className = 'cam-slot-text';
    txt.textContent = get();
    const car = document.createElement('span');
    car.className = 'cam-slot-car';
    car.textContent = '▾';
    slot.appendChild(txt);
    slot.appendChild(car);
    slot.addEventListener('click', (e) => {
      e.stopPropagation();
      const items = options().map((o) => ({ key: o, label: o, current: o === get() }));
      openMenu(slot, items, (v) => {
        if (v !== get()) {
          set(v);
          txt.textContent = v;
          commit();
        }
      });
    });
    return slot;
  };

  wrap.appendChild(mkSlot(() => v1, (v) => { v1 = v; }, () => opts.tiers));
  wrap.appendChild(mkSlot(() => v2, (v) => { v2 = v; }, () => [NONE].concat(opts.tiers)));
  wrap.appendChild(mkSlot(() => v3, (v) => { v3 = v; }, () => [NONE].concat(opts.lens)));

  host.classList.add('editing');
  host.textContent = '';
  host.appendChild(wrap);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeMenu();
    host.classList.remove('editing');
    cfg.renderCell();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  const onOutside = (e) => {
    const t = e.target;
    if (wrap.contains(t)) return;
    const m = menuEl();
    if (m && m.contains(t)) return; // 菜单内的点选不算点外
    close();
  };
  const onEsc = (e) => {
    if (e.key !== 'Escape') return;
    if (menuOpen()) return; // 菜单先消费 Esc
    e.preventDefault();
    close();
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onEsc, true);

  const commit = async () => {
    const t1 = v1;
    const t2 = v2 === NONE ? null : v2;
    const lens = v3 === NONE ? '' : v3;
    const newSize = t2 ? (t1 + ' ↓ ' + t2) : t1;
    const cur = cfg.getCam();
    const writes = [];
    if (newSize !== (cur.raw || '')) writes.push(['shot_size', newSize]);
    if (lens !== (cur.focal || '')) writes.push(['focal', lens]);
    const pd = parseCam(cur.raw);
    if (pd.dof && !cur.dof) writes.push(['dof', pd.dof]);
    if (!writes.length) return;
    const fields = writes.map((w) => w[0]);
    const oldVals = {};
    for (const f of fields) oldVals[f] = f === 'shot_size' ? cur.raw : cur[f];
    for (const w of writes) cfg.setCam(w[0], w[1]);
    if (cfg.refreshSiblings) cfg.refreshSiblings();
    try {
      for (const w of writes) await api.update('shots', cfg.id, w[0], w[1]);
      recordUndo({
        type: 'custom', label: '摄影机',
        undo: async () => {
          for (const f of fields) await api.update('shots', cfg.id, f, oldVals[f] == null ? '' : oldVals[f]);
        },
      });
    } catch (err) {
      for (const f of fields) cfg.setCam(f, oldVals[f]);
      if (cfg.refreshSiblings) cfg.refreshSiblings();
      toast('保存失败：' + err.message, 'err');
    }
  };
}
