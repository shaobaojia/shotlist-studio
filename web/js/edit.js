// 就地编辑引擎：点击即编 / 自动保存（无保存键）/ Esc 取消 / Ctrl+Z 撤销栈。
// 写路径统一走 api.update（服务端白名单 + 痕迹）；乐观更新，失败回滚。
// 摄影机复合控件（景别×2 + 焦段）也在这里：改动即存，含旧格式归一化（内嵌焦段/景深迁入独立字段）。
// 单选字段与复合控件走自绘浮动菜单（menu.js，非原生 select）：一次点击直达列表，拾取不关表单。
import { api } from './api.js';
import { toast, growTextarea, placeFlip, onOutsideClose } from './ui.js';
import { openMenu, closeMenu, menuOpen, optItems } from './menu.js';

const undoStack = [];
const UNDO_MAX = 100;

export function peekUndo() {
  return undoStack.length ? undoStack[undoStack.length - 1] : null;
}

export function recordUndo(op) {
  undoStack.push(op);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

export function canUndo() {
  return undoStack.length > 0;
}

// 批量写单点（F2-W12）：一次请求、逐项结果；任一项被拒 → 抛出（撤销路径可感知失败）
export async function batchUpdate(items) {
  const ret = await api.batch(items);
  const errs = ((ret && ret.results) || []).filter((r) => r.error);
  if (errs.length) throw new Error(errs.length + ' 项被拒绝：' + errs[0].error);
  return ret;
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
      await batchUpdate(op.changes.map((c) => ({ table: 'shots', id: c.id, field: 'shot_no', value: c.old == null ? '' : c.old })));
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

// 字段落定（L7 单点出口）：写成功后调用——本地模型更新 → 编辑面开着就地显示 + 基线同步（否则渲染格）→ 撤销入栈。
// cfg: { table, id, field, label, onLocal?, renderCell?, ed? }（写口由调用方负责：api.update / api.aiApply 等）。
// opts.apply=false（F2-P1）：调用方已在写前乐观落定（如 save()），只补撤销 + 广播，避免同 tick 二次重绘。
export function commitField(cfg, oldV, newV, opts) {
  if (!opts || opts.apply !== false) {
    if (cfg.onLocal) cfg.onLocal(newV);
    if (cfg.ed && cfg.ed.isConnected) {
      cfg.ed.value = newV;
      if (cfg.ed._syncBaseline) cfg.ed._syncBaseline(newV);
    } else if (cfg.renderCell) {
      cfg.renderCell();
    }
  }
  recordUndo({ type: 'field', table: cfg.table, id: cfg.id, field: cfg.field,
               restore: oldV, label: cfg.label });
  notifyRowsChanged(cfg.table, cfg.field, cfg.id);
}

// 行级落定广播（M5j 活体件）：场景头「规模/总时长」与挂件带等据此就地刷新（不整页重绘）。
export function notifyRowsChanged(table, field, id) {
  window.dispatchEvent(new CustomEvent('shotlist:rows-changed', { detail: { table: table, field: field, id: id } }));
}

// cfg: { table, id, field, label, getValue(), onLocal(v), renderCell(),
//        multiline?, select?: [options], save?: async (oldV, newV) => (抛错=失败) }
// 编辑句柄（F2-W11）：跨模块入口收进 WeakMap，不再借 DOM expando 传值
const EDITOR_HANDLES = new WeakMap();
export function editorHandleAt(host) {
  return EDITOR_HANDLES.get(host) || null;
}

export function attachEditable(host, cfg) {
  host.classList.add('editable');
  if (!host.title) host.title = cfg.dbl ? '双击编辑' : '点击编辑';
  host.addEventListener(cfg.dbl ? 'dblclick' : 'click', (ev) => {
    ev.stopPropagation();
    if (cfg.dbl) ev.preventDefault();
    if (cfg.select) {
      openSelectMenu(host, cfg);
      return;
    }
    if (host.querySelector('.cell-editor')) return;
    openEditor(host, cfg, null);
  });
  EDITOR_HANDLES.set(host, {
    openSeed(seed) {                                  // 打字即编入口（F2-W11）：替代 td._seedText + 合成 dblclick
      if (cfg.select) { openSelectMenu(host, cfg); return true; }
      if (host.querySelector('.cell-editor')) return false;
      openEditor(host, cfg, seed);
      return true;
    },
  });
}

// 单选字段：点击 → 浮动菜单就地选（一次点击直达列表）
function openSelectMenu(host, cfg) {
  const original = cfg.getValue() == null ? '' : String(cfg.getValue());
  const opts = cfg.select.slice();
  if (original && opts.indexOf(original) === -1) opts.push(original);
  const items = optItems(opts, original);
  host.classList.add('editing');
  openMenu(host, items, (v) => {
    if (v !== original) save(cfg, original, v);
  }, { onClosed: () => host.classList.remove('editing') });
}

function openEditor(host, cfg, seed) {
  let base = cfg.getValue() == null ? '' : String(cfg.getValue());
  const ed = document.createElement(cfg.multiline ? 'textarea' : 'input');
  ed.value = seed != null ? String(seed) : base;
  ed._syncBaseline = (v) => { base = v; };   // 外部落库（AI 接受）后同步基线（L9）
  ed.title = cfg.multiline ? 'Ctrl+Enter 保存 · Tab 走格 · Esc 取消' : 'Enter 保存并下移 · Tab 走格 · Esc 取消';
  ed.className = 'cell-editor';
  host.classList.add('editing');
  host.textContent = '';
  host.appendChild(ed);

  let closed = false;
  const close = (commit) => {
    if (closed) return;
    closed = true;
    const nv = ed.value;
    host.classList.remove('editing');
    // F2-W10：提交路径由 save() 乐观落定重画（先按旧值绘一遍是纯浪费）；取消 / 无变化才就地重画
    if (commit && nv !== base) save(cfg, base, nv);
    else cfg.renderCell();
  };

  decorateEditor(host, ed, cfg, close, base);
  fitEditorOpen(ed, host);
  ed.focus();
  if (ed.tagName === 'INPUT') {
    if (seed != null) ed.setSelectionRange(ed.value.length, ed.value.length);
    else ed.select();
  } else {
    ed.setSelectionRange(ed.value.length, ed.value.length);
  }

  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    } else if (e.key === 'Tab' && cfg.walk) {
      e.preventDefault();
      close(true);
      const dir = e.shiftKey ? -1 : 1;
      setTimeout(() => { cfg.walk(dir); }, 0);
    } else if (e.key === 'Enter' && (!cfg.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      close(true);
      if (cfg.walk && !cfg.multiline) setTimeout(() => { cfg.walk('down'); }, 0);
    }
  });
  if (ed.tagName === 'TEXTAREA') ed.addEventListener('input', () => growTextarea(ed, 0));   // W9：fitEditorLive 退役
  ed.addEventListener('blur', () => close(true));
}

// 编辑面装饰（F2-W7 外提）：✦ AI 挂件 + 预设条（一键落值）；close/base 由 openEditor 传入
function decorateEditor(host, ed, cfg, close, base) {
  if (cfg.aiOpen) {
    const wand = document.createElement('span');
    wand.className = 'ai-wand';
    wand.textContent = '✦';
    wand.title = 'AI 改写…（改写 / 具象化 / 强化 / 扩写）';
    wand.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    wand.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cfg.aiOpen(cfg, ed, wand);
    });
    host.appendChild(wand);
  }
  if (cfg.presets && cfg.presets.length) {
    const strip = document.createElement('div');
    strip.className = 'cell-presets';
    cfg.presets.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset' + (p === base ? ' on' : '');
      b.textContent = p;
      b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });  // 保住输入焦点，不触发 blur 提交
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ed.value = p;
        close(true);   // 一键落值并收（同单选菜单语义）
      });
      strip.appendChild(b);
    });
    host.appendChild(strip);
    // 兜底翻转（F2-P5 单点）：表底行时条悬出 .table-wrap（overflow 纵裁不可点）→ 翻到格子上方
    const wrapEl = host.closest ? host.closest('.table-wrap') : null;
    if (wrapEl) {
      const wr = wrapEl.getBoundingClientRect();
      const res = placeFlip(host.getBoundingClientRect(), 0, strip.offsetHeight,
        { gapBelow: 6, pad: 0, maxBottom: wr.bottom + 1 });
      if (res.flipped) strip.classList.add('above');
    }
  }
}

// 保存（F2-P1 收编）：乐观落定 → 写口 → 落定单点；失败整体回滚 + 报错。
// 自定义 save（如焦段归一）自管撤销与广播；缺省写口走 cfg.write（F2-W6 契约点）或 api.update。
async function save(cfg, oldV, newV) {
  cfg.onLocal(newV);
  cfg.renderCell();
  if (cfg.save) {
    try {
      await cfg.save(oldV, newV);
      notifyRowsChanged(cfg.table, cfg.field, cfg.id);
    } catch (err) {
      rollback(cfg, oldV);
      toast('保存失败：' + err.message, 'err');
    }
    return;
  }
  const write = cfg.write || ((field, v) => api.update(cfg.table, cfg.id, field, v));
  try {
    await write(cfg.field, newV);
    commitField(cfg, oldV, newV, { apply: false });   // 撤销 + 广播单点（乐观落定已走完，不重复重绘）
  } catch (err) {
    rollback(cfg, oldV);
    toast('保存失败：' + err.message, 'err');
  }
}

// 失败回滚（F2-P1）：模型与渲染回旧值（原三处逐字重复段）
function rollback(cfg, oldV) {
  cfg.onLocal(oldV);
  cfg.renderCell();
}

// 打开时：贴合格子现有高度（首帧贴格；随后交 growTextarea 统一自增长——W9）
function fitEditorOpen(ed, host) {
  if (ed.tagName !== 'TEXTAREA') return;
  const cs = getComputedStyle(host);
  const avail = host.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
  if (avail > 0) ed.style.height = avail + 'px';
  requestAnimationFrame(() => {
    if (ed.isConnected && ed.scrollHeight > ed.clientHeight + 1) ed.style.height = ed.scrollHeight + 'px';
  });
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

// cfg: { id, getCam() -> {raw, focal, dof}, setCam(field, v), renderCell(), camOptions() -> {tiers, lens}, dbl?, refreshSiblings? }
export function attachCamEditor(host, cfg) {
  host.classList.add('editable');
  if (!host.title) host.title = cfg.dbl ? '双击编辑（景别 / 焦段）' : '点击编辑（景别 / 焦段）';
  host.addEventListener(cfg.dbl ? 'dblclick' : 'click', (ev) => {
    ev.stopPropagation();
    if (cfg.dbl) ev.preventDefault();
    if (host.querySelector('.cam-editor')) return;
    openCamForm(host, cfg);
  });
  EDITOR_HANDLES.set(host, {
    openSeed() {                                      // 打字即编落在摄影机格 → 开复合控件（种子不适用）
      if (host.querySelector('.cam-editor')) return false;
      openCamForm(host, cfg);
      return true;
    },
  });
}

function openCamForm(host, cfg) {
  const cam = cfg.getCam();
  const opts = cfg.camOptions();
  const p = parseCam(cam.raw);
  const st = {                                       // 槽位状态（F2-W7：提交与回滚共用一份）
    v1: p.t1 || (opts.tiers[0] || ''),
    v2: p.t2 == null ? NONE : p.t2,
    v3: (p.lens || cam.focal || '') || NONE,
  };

  const wrap = document.createElement('div');
  wrap.className = 'cam-editor';
  const slots = [];
  // 槽位：点击 → 浮动菜单（一次点击直达列表；拾取后就地更新并落库，表单保持打开）
  const mkSlot = (key, options) => {
    const slot = document.createElement('div');
    slot.className = 'cam-slot';
    const txt = document.createElement('span');
    txt.className = 'cam-slot-text';
    txt.textContent = st[key];
    const car = document.createElement('span');
    car.className = 'cam-slot-car';
    car.textContent = '▾';
    slot.appendChild(txt);
    slot.appendChild(car);
    slot.addEventListener('click', (e) => {
      e.stopPropagation();
      const items = optItems(options(), st[key]);
      openMenu(slot, items, (v) => {
        if (v !== st[key]) st[key] = v;
        txt.textContent = v;
        commit();
      });
    });
    slots.push({ key: key, txt: txt });
    return slot;
  };

  wrap.appendChild(mkSlot('v1', () => opts.tiers));
  wrap.appendChild(mkSlot('v2', () => [NONE].concat(opts.tiers)));
  wrap.appendChild(mkSlot('v3', () => [NONE].concat(opts.lens)));

  host.classList.add('editing');
  host.textContent = '';
  host.appendChild(wrap);

  // 失败回滚槽文本（F2-B4）：读模型真值 → 回填状态与三个槽位
  const resetSlots = () => {
    const c2 = cfg.getCam();
    const p2 = parseCam(c2.raw);
    st.v1 = p2.t1 || (opts.tiers[0] || '');
    st.v2 = p2.t2 == null ? NONE : p2.t2;
    st.v3 = (p2.lens || c2.focal || '') || NONE;
    for (const sl of slots) sl.txt.textContent = st[sl.key];
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeMenu();
    host.classList.remove('editing');
    cfg.renderCell();
    cleanup();
  };
  // 点外关闭 + Esc 单点（F2-W23）：菜单优先消费 Esc（优先级规则随单点走）
  const cleanup = onOutsideClose(wrap, close, { onEsc: () => menuOpen(), floatExempt: true, stopProp: false });

  const commit = () => commitCam(cfg, st, resetSlots);
}

// 摄影机提交（F2-W7/W8/W12）：比较 → 单次批量写 → 撤销入栈；失败整体回滚（含槽位 B4）
async function commitCam(cfg, st, resetSlots) {
  const t1 = st.v1;
  const t2 = st.v2 === NONE ? null : st.v2;
  const lens = st.v3 === NONE ? '' : st.v3;
  const newSize = t2 ? (t1 + ' ↓ ' + t2) : t1;
  const cur = cfg.getCam();
  const writes = [];
  if (newSize !== (cur.raw || '')) writes.push({ field: 'shot_size', value: newSize });
  if (lens !== (cur.focal || '')) writes.push({ field: 'focal', value: lens });
  const pd = parseCam(cur.raw);
  if (pd.dof && !cur.dof) writes.push({ field: 'dof', value: pd.dof });
  if (!writes.length) return;
  const oldVals = {};
  for (const w of writes) oldVals[w.field] = w.field === 'shot_size' ? cur.raw : cur[w.field];
  for (const w of writes) cfg.setCam(w.field, w.value);
  if (cfg.refreshSiblings) cfg.refreshSiblings();
  try {
    await batchUpdate(writes.map((w) => ({ table: 'shots', id: cfg.id, field: w.field, value: w.value })));
    recordUndo({
      type: 'custom', label: '摄影机',
      undo: async () => {
        await batchUpdate(writes.map((w) => ({ table: 'shots', id: cfg.id, field: w.field,
          value: oldVals[w.field] == null ? '' : oldVals[w.field] })));
      },
    });
    if (writes.some((w) => w.field === 'shot_size')) notifyRowsChanged('shots', 'shot_size', cfg.id);
  } catch (err) {
    for (const w of writes) cfg.setCam(w.field, oldVals[w.field]);
    if (cfg.refreshSiblings) cfg.refreshSiblings();
    if (resetSlots) resetSlots();
    toast('保存失败：' + err.message, 'err');
  }
}
