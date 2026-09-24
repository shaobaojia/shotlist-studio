// 剧本抽屉（M5 批3b）：本场台本常驻抽屉 = 浮层壳（drawer.js）+ scenes.script 接线。
// 形态：右侧浮动卡 · 查看 ⇄ 编辑（一步撤销）· 钉住时切场跟随。
// 导入：整本粘贴 → 按场号行首切分（「s010 …」/「10、…」）→ 逐场勾选覆盖（一步可撤）。
import { api } from './api.js';
import { el, toast, growTextarea, isFloatTarget, isTypingTarget } from './ui.js';
import { menuEl } from './menu.js';
import { recordUndo } from './edit.js';
import { writeClipboard } from './clipboard.js';
import { createDrawer } from './drawer.js';
import { panelShell, floatEnter, floatLeave } from './float.js';

let ctx = { getScene: () => null };
export function initScriptDrawer(c) { ctx = Object.assign(ctx, c); }

let dr = null;
let toggleBtn = null;
const S = { mode: 'view', sceneId: null, scene: null, ta: null };
const IMP = { card: null, lastText: '' };

// ── 抽屉（壳：右缘浮动 · 拖拽 / 缩放 / 贴附 / 钉住 / 记忆）──
function ensureDrawer() {
  if (dr) return dr;
  dr = createDrawer({ id: 'script', width: 460, onOutside: onOutside, onClose: onClosed });
  dr.addDockButton('bottom');
  dr.addDockButton('right');
  dr.addPinButton();
  toggleBtn = dr.addButton('编辑', { title: '切换 查看 ⇄ 编辑（编辑中点击＝保存回查看）', onClick: onToggleMode });
  dr.addButton('复制', { title: '复制本场台本全文', onClick: onCopy });
  dr.addCloseButton(() => commitClose());

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!dr || !dr.isOpen()) return;
    const t = e.target;
    if (t && t.closest && t.closest('.menu')) return;
    const inDrawer = !!(t && dr.el.contains(t));
    if (!inDrawer && t && t.closest && t.closest('.drawer')) return;
    if (!inDrawer && isTypingTarget(t)) return;
    if (S.mode === 'edit') { toView(); return; }
    if (!dr.isPinned()) commitClose();
  });
  return dr;
}

export function openScriptDrawer() {
  const sc = ctx.getScene();
  if (!sc) return;
  const d = ensureDrawer();
  if (d.isOpen() && S.sceneId === sc.id) return;
  const go = async () => {
    if (d.isOpen() && S.mode === 'edit' && S.ta) {
      const r = await commitSave();
      if (!r.ok) return;
    }
    S.sceneId = sc.id;
    S.scene = sc;
    d.open();
    render('view');
  };
  go();
}

// 重绘钩子（scene.js paintScene 调）：同场不打扰；切场未钉住即关、钉住跟场
export function scriptsOnRepaint(sceneId) {
  if (!dr || !dr.isOpen()) return;
  if (S.sceneId === sceneId) return;
  if (!dr.isPinned()) { dr.close(); return; }
  const follow = async () => {
    if (S.mode === 'edit' && S.ta) {
      const r = await commitSave();
      if (!r.ok) return;
    }
    const sc = ctx.getScene();
    if (!sc) { dr.close(); return; }
    S.sceneId = sc.id;
    S.scene = sc;
    render('view');
  };
  follow();
}

// 外部改动后（导入台本等）重读当前场
export function refreshScriptDrawer() {
  if (!dr || !dr.isOpen()) return;
  const sc = ctx.getScene();
  if (!sc || sc.id !== S.sceneId) return;
  S.scene = sc;
  renderSoft();
}

function renderSoft() {
  if (dr && dr.isOpen() && S.mode === 'view') render('view');
}

// ── 渲染 ──
function render(mode) {
  const d = ensureDrawer();
  const sc = S.scene;
  if (!sc || !d.isOpen()) return;
  S.mode = mode;
  d.setTitle('剧本 · ' + sc.scene_no + (sc.title ? ' ' + sc.title : ''));
  if (toggleBtn) toggleBtn.textContent = (mode === 'edit') ? '💾 保存' : '编辑';
  S.ta = null;
  d.bodyEl.textContent = '';
  d.bodyEl.scrollTop = 0;
  const text = sc.script == null ? '' : String(sc.script);
  if (mode === 'edit') {
    const ta = document.createElement('textarea');
    ta.className = 'hotbox-editor sd-editor';
    ta.spellcheck = false;
    ta.placeholder = '本场台本……';
    ta.value = text;
    d.bodyEl.appendChild(ta);
    d.bodyEl.appendChild(el('div', 'hotbox-hint', '「保存」落库 · 一步可撤（Ctrl+Z） · Esc 返回查看'));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toView(); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveToView(); }
    });
    S.ta = ta;
    growTextarea(ta, 240);
    setTimeout(() => { try { ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n); } catch (err) { /* ignore */ } }, 0);
  } else {
    const box = el('div', 'prompt-text sd-view');
    if (!text.trim()) {
      box.appendChild(el('div', 'pd-empty', '本场还没有台本——点「编辑」直接写，或用「导入台本…」整本切分导入'));
    } else {
      box.appendChild(document.createTextNode(text));
    }
    d.bodyEl.appendChild(box);
    if (text.trim()) d.bodyEl.appendChild(el('div', 'pd-tips', '点「编辑」修订 · 「复制」拷全文'));
  }
}

// ── 存 / 撤 / 关 ──
async function commitSave() {
  if (!S.scene || !S.ta) return { ok: true, changed: false };
  const sid = S.scene.id;
  const text = S.ta.value;
  const prior = S.scene.script == null ? '' : String(S.scene.script);
  if (text === prior) return { ok: true, changed: false };
  try {
    await api.update('scenes', sid, 'script', text);
    S.scene.script = text;
    recordUndo({
      type: 'custom', label: '台本',
      undo: async () => {
        try {
          await api.update('scenes', sid, 'script', prior);
          const cur = ctx.getScene();
          if (cur && cur.id === sid) cur.script = prior;
          if (S.sceneId === sid) renderSoft();
        } catch (err) { toast('撤销失败：' + err.message, 'err'); }
      },
    });
    return { ok: true, changed: true };
  } catch (err) {
    toast('台本保存失败：' + err.message, 'err');
    return { ok: false };
  }
}

async function saveToView() {
  const r = await commitSave();
  if (r.ok) render('view');
}

async function commitClose() {
  if (!dr || !dr.isOpen()) return;
  if (S.mode === 'edit' && S.ta) {
    const r = await commitSave();
    if (!r.ok) return;
  }
  dr.close();
}

function toView() { if (S.mode === 'edit') render('view'); }

async function onToggleMode() {
  if (!dr || !dr.isOpen()) return;
  if (S.mode === 'edit') await saveToView();
  else render('edit');
}

function onCopy() {
  if (!S.scene) return;
  const text = S.scene.script == null ? '' : String(S.scene.script);
  if (!text.trim()) { toast('本场还没有台本可复制'); return; }
  writeClipboard(text).then((ok) => toast(ok ? '已复制台本全文' : '复制失败：浏览器限制，请手动选择'));
}

function onOutside(e) {
  if (!dr || !dr.isOpen()) return;
  const t = e.target;
  if (menuEl() && menuEl().contains(t)) return;
  if (isFloatTarget(t, { prompt: true })) return;   // 单点名单（F1-B5）
  if (dr.isPinned()) return;
  commitClose();
}

function onClosed() {
  S.ta = null;
  S.sceneId = null;
  S.scene = null;
  S.mode = 'view';
}

// ── 导入台本（整本切分 → 逐场勾选覆盖）──
export function openScriptImport() {
  if (!IMP.card) {
    const sh = panelShell({ id: 'script-import-card', title: '导入台本（整本切分）', onClose: closeImport });
    IMP.card = sh.card;
    IMP.card.hidden = true;
    IMP.card._body = sh.body;
    document.body.appendChild(IMP.card);
  }
  floatEnter('draft', closeImport);       // 与草稿卡同层互斥（开新关旧）
  IMP.card.hidden = false;
  showImportForm();
}

function closeImport() {
  if (IMP.card) IMP.card.hidden = true;
  floatLeave('draft', closeImport);
}

function showImportForm() {
  const b = IMP.card._body;
  b.textContent = '';
  b.appendChild(el('div', 'as-sec-t', '整本剧本贴进来——按场号行首自动切分（「s010 …」或「10、…」）。解析后逐场勾选，只覆盖勾选的场；已有台本的场默认不勾（防误覆盖），导入可一步撤销。'));
  const ta = document.createElement('textarea');
  ta.className = 'as-input as-area';
  ta.spellcheck = false;
  ta.style.minHeight = '120px';
  ta.placeholder = 's010 商场过道\n内景 商场 白天\n……\n\ns020 电玩城门口\n……';
  ta.value = IMP.lastText || '';
  b.appendChild(ta);
  const bar = el('div', 'as-bar');
  const parseBtn = el('button', 'tool-btn small dz-violet', '解析');
  bar.appendChild(parseBtn);
  b.appendChild(bar);
  const list = el('div', 'sd-imp-list');
  list.hidden = true;
  b.appendChild(list);
  parseBtn.addEventListener('click', async () => {
    IMP.lastText = ta.value;
    await doParse(ta.value, list);
  });
}

async function doParse(text, list) {
  list.hidden = false;
  list.textContent = '';
  let scenes = [];
  try {
    const r = await fetch('/api/film');
    const res = await r.json();
    scenes = (res && res.scenes) || [];
  } catch (err) {
    toast('读取场景列表失败：' + err.message, 'err');
    return;
  }
  const out = splitScript(text, scenes);
  if (!out.size) {
    list.appendChild(el('div', 'sd-imp-empty', '没有匹配到任何场号——检查行首是否为「s010 …」或「10、…」'));
    return;
  }
  for (const sc of scenes) {
    const seg = out.get(sc.id) || '';
    const has = sc.script != null && String(sc.script).trim() !== '';
    const row = el('label', 'sd-imp-row');
    row.dataset.sceneId = sc.id;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = !seg;
    cb.checked = !!seg && !has;
    if (seg) cb._seg = seg;
    cb.addEventListener('change', refreshStat);
    row.appendChild(cb);
    row.appendChild(el('span', 'sd-imp-no', sc.scene_no));
    row.appendChild(el('span', 'sd-imp-title', sc.title || ''));
    if (seg) {
      row.appendChild(el('span', 'sd-imp-meta', seg.length + ' 字'));
      if (has) row.appendChild(el('span', 'sd-imp-warn', '已有台本 · 勾选覆盖'));
    } else {
      row.appendChild(el('span', 'sd-imp-meta', '未匹配到'));
      row.style.opacity = '.45';
    }
    list.appendChild(row);
  }
  if (IMP.applyBar && IMP.applyBar.parentNode) IMP.applyBar.parentNode.removeChild(IMP.applyBar);
  const applyBar = el('div', 'as-bar sd-imp-applybar');
  const apply = el('button', 'tool-btn small dz-violet', '导入勾选的场');
  const stat = el('span', 'sd-imp-stat', '');
  applyBar.appendChild(apply);
  applyBar.appendChild(stat);
  list.parentElement.appendChild(applyBar);      // 常驻卡底：不随列表滚动（点击可达）
  IMP.applyBar = applyBar;

  function refreshStat() {
    const n = list.querySelectorAll('.sd-imp-row input:checked').length;
    stat.textContent = '已选 ' + n + ' 场';
    apply.disabled = n === 0;
    apply.style.opacity = n === 0 ? '.5' : '';
  }
  refreshStat();

  apply.addEventListener('click', async () => {
    const picked = [];
    list.querySelectorAll('.sd-imp-row').forEach((row) => {
      const cb = row.querySelector('input');
      if (cb && cb.checked && cb._seg) picked.push({ id: Number(row.dataset.sceneId), seg: cb._seg, cb, row });
    });
    if (!picked.length) { toast('先勾选要导入的场'); return; }
    // 写前重取现值：撤销基线取「此刻库内真值」，抹平解析→导入之间的外部编辑（P0·F4-B2）
    let priors;
    try {
      const fj = await api.film();
      const fmap = new Map(((fj && fj.scenes) || []).map((x) => [x.id, x]));
      priors = picked.map((j) => {
        const f = fmap.get(j.id);
        return { id: j.id, prior: f && f.script != null ? String(f.script) : '' };
      });
    } catch (err) {
      toast('读取最新台本失败：' + err.message, 'err');
      return;
    }
    let ret;
    try {
      ret = await api.batch(picked.map((j) => ({ table: 'scenes', id: j.id, field: 'script', value: j.seg })));   // 一次往返（P0·F4）
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
      return;
    }
    const results = (ret && ret.results) || [];
    const changedIds = new Set(results.filter((r) => r.changed).map((r) => r.id));
    const done = picked.filter((j) => changedIds.has(j.id));
    if (done.length) {
      const byId = new Map(scenes.map((x) => [x.id, x]));   // 预建查找（P0·F4）
      const undoPriors = priors.filter((p) => changedIds.has(p.id));
      for (const j of done) {
        const sc = byId.get(j.id);
        if (sc) sc.script = j.seg;
        const cur = ctx.getScene();
        if (cur && cur.id === j.id) cur.script = j.seg;
      }
      recordUndo({
        type: 'custom', label: '导入台本',
        undo: async () => {
          await api.batch(undoPriors.map((p) => ({ table: 'scenes', id: p.id, field: 'script', value: p.prior })));
          const cur = ctx.getScene();
          for (const p of undoPriors) {
            if (cur && cur.id === p.id) cur.script = p.prior;
          }
          refreshScriptDrawer();
        },
      });
      toast('已导入 ' + done.length + ' 场台本（Ctrl+Z 可整批撤）');
      refreshScriptDrawer();
      for (const j of done) {
        j.cb.checked = false;
        if (!j.row.querySelector('.sd-imp-warn')) {
          j.row.appendChild(el('span', 'sd-imp-warn', '已有台本 · 勾选覆盖'));
        }
      }
      refreshStat();
    } else {
      const ferr = results.find((r) => r.error);
      toast('导入未生效：' + (ferr ? ferr.error : '无变更'), 'err');
    }
  });
}

// 切分：行首「s010」直接匹配；「10、/10./10．/10:」按 3 位补零映射
function splitScript(text, scenes) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const byNo = new Map(scenes.map((sc) => [String(sc.scene_no).toLowerCase(), sc]));
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let no = null;
    let m = /^\s*(s\d{2,4})(?![0-9])/i.exec(line);
    if (m) no = m[1].toLowerCase();
    else {
      m = /^\s*(\d{1,3})\s*[、.．:：]/.exec(line);
      if (m) no = 's' + String(parseInt(m[1], 10)).padStart(3, '0');
    }
    if (!no) continue;
    const sc = byNo.get(no);
    if (sc) hits.push({ sc, line: i });
  }
  const out = new Map();
  for (let k = 0; k < hits.length; k++) {
    const cur = hits[k];
    const end = k + 1 < hits.length ? hits[k + 1].line : lines.length;
    const seg = lines.slice(cur.line, end).join('\n').trim();
    if (!seg) continue;
    if (out.has(cur.sc.id)) out.set(cur.sc.id, out.get(cur.sc.id) + '\n\n' + seg);
    else out.set(cur.sc.id, seg);
  }
  return out;
}
