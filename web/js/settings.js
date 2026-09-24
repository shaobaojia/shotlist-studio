// 设置与配方中心（M4b-3）：顶栏「设置」→ 浮卡两区（AI 通道 + 配方）。
// 配方口径：一个功能一份，保存即生效（不重启）；保存/恢复前自动备份旧版。
// key 明文永不出后端（只显示「已配置（留空＝不改）」）。
import { api } from './api.js';
import { el, toast, stageText, failToast, busy, fmtStamp } from './ui.js';
import { fieldRow, collect } from './formkit.js';
import { panelShell, floatEnter, floatLeave } from './float.js';

let card = null, bodyEl = null, listBox = null, refs = {};   // refs：AI 区控件句柄（F5-W24）
let viewDirty = null;    // 编辑态脏检查（批4：未保存返回提示）

// F5-B1：离卡脏检查单点（返回列表 / 关闭共用——原仅「返回列表」有）
function guardLeave(what) {
  if (viewDirty && viewDirty() && !confirm('有未保存的修改，确定丢弃并' + what + '？')) return false;
  return true;
}

export function bindSettingsBtn(btn) {
  if (btn) btn.addEventListener('click', toggleSettings);
}

export function toggleSettings() {
  if (card && !card.hidden) { closeSettings(); return; }
  openSettings();
}

function closeSettings() {
  if (!guardLeave('关闭')) return;   // F5-B1：编辑态关卡需确认（原静默丢弃）
  if (card) card.hidden = true;
  floatLeave('panel', closeSettings);
}

export function openSettings() {
  floatEnter('panel', closeSettings);   // 浮卡互斥：设置 ↮ 审计设置（F8 入注册表，L6）
  if (!card) build();
  card.hidden = false;
  loadAll();
}

function build() {
  const sh = panelShell({ id: 'settings-card', title: '设置', onClose: closeSettings });
  card = sh.card;
  bodyEl = sh.body;
  card.hidden = true;
  document.body.appendChild(card);
}

let _loading = false;
function loadAll() {
  if (_loading) return;   // F5-P6③：单飞（在飞时重入忽略——原每次开卡清空重拉）
  _loading = true;
  bodyEl.textContent = '';
  Promise.allSettled([loadAI(), loadRecipes()]).then(() => { _loading = false; });
}

// ── 一区：AI 通道（自审计 ⚙ 搬迁）────────────────────────────

async function loadAI() {
  const sec = el('div', 'form-sec');
  sec.appendChild(el('div', 'form-sec-t', 'AI 通道 · 创作与 LLM 审计共用（key 只存本地库、不入 git、不回传浏览器）'));
  bodyEl.appendChild(sec);
  try {
    const res = await api.aiSettings();
    renderAI(sec, (res && res.config) || {});
  } catch (err) {
    const d = el('div', 'form-desc');   // F5-W20/W22：错误态统一（stageText + err-note）
    stageText(d, 'error', err);
    sec.appendChild(d);
  }
}

function renderAI(sec, cfg) {
  // F5-W24：控件句柄留 ref（原 fillAI 按 data-k 反查 DOM）
  const fprovider = fieldRow('provider', { key: 'provider', value: cfg.provider });
  const fmodel = fieldRow('model', { key: 'model', value: cfg.model });
  const fbase = fieldRow('base_url', { key: 'base_url', value: cfg.base_url });
  const fkey = fieldRow('api_key', { key: 'api_key', value: '',
    placeholder: cfg.has_key ? '已配置（留空＝不改）' : '未配置' });
  refs = { provider: fprovider.inp, model: fmodel.inp, base_url: fbase.inp, api_key: fkey.inp };
  sec.appendChild(fprovider.row);
  sec.appendChild(fmodel.row);
  sec.appendChild(fbase.row);
  sec.appendChild(fkey.row);

  const bar = el('div', 'form-bar');
  const save = el('button', 'tool-btn small', '保存配置');
  save.addEventListener('click', () => busy(save, async () => {   // F5-W16：忙碌模板
    const vals = collect(sec);
    const payload = {};
    for (const k of Object.keys(vals)) {
      if (k === 'api_key') { if (vals[k]) payload.api_key = vals[k]; }
      else payload[k] = vals[k];                    // 三键恒定发送：空串 = 清回默认（M14）
    }
    try {
      const out = await api.aiSave(payload);
      fillAI(sec, (out && out.config) || {});       // 回读刷新值与占位符（M14）
      toast('AI 配置已保存');
    } catch (err) { failToast('保存失败', err); }
  }));
  const testb = el('button', 'tool-btn small', '连通测试');
  const result = el('span', 'form-test-result', '');
  testb.addEventListener('click', () => busy(testb, async () => {   // F5-W16
    result.textContent = '测试中…';
    try {
      const res = await api.aiTest();
      result.textContent = res.ok ? ('✓ ' + res.ms + 'ms · ' + (res.reply || '')) : ('✗ ' + (res.error || '失败'));
    } catch (err) {
      result.textContent = '✗ ' + err.message;
    }
  }));
  bar.appendChild(save);
  bar.appendChild(testb);
  bar.appendChild(result);
  sec.appendChild(bar);
}

function fillAI(sec, cfg) {
  const set = (k, v) => { const i = refs[k]; if (i) i.value = v == null ? '' : v; };   // F5-W24：走 refs
  set('provider', cfg.provider);
  set('model', cfg.model);
  set('base_url', cfg.base_url);
  set('api_key', '');                               // key 明文不留在 DOM（M14）
  if (refs.api_key) refs.api_key.placeholder = cfg.has_key ? '已配置（留空＝不改）' : '未配置';
}

// ── 二区：配方（列表 → 就地编辑）────────────────────────────

async function loadRecipes() {
  const sec = el('div', 'form-sec');
  sec.appendChild(el('div', 'form-sec-t', '配方 · 某个功能里 AI 手里那份提示词，一个功能一份，保存即生效；骨架：①身份 → ②检查/改写要求 → ③喂什么数据 → ④输出格式 → ⑤质量口径。'));
  listBox = el('div', 'pane-recipes');
  sec.appendChild(listBox);
  bodyEl.appendChild(sec);
  await refreshList();
}

function fmtSize(b) { return b < 1024 ? (b + ' B') : ((b / 1024).toFixed(1) + ' KB'); }

async function refreshList() {
  viewDirty = null;
  stageText(listBox, 'loading');
  try {
    const res = await api.recipes();
    listBox.textContent = '';
    for (const g of (res.groups || [])) {
      listBox.appendChild(el('div', 'pane-g-t', g.label));
      for (const it of (g.items || [])) {
        const row = el('div', 'pane-r' + (it.exists ? '' : ' missing'));
        row.appendChild(el('span', 'pane-r-t', it.title));
        row.appendChild(el('span', 'pane-r-m', it.exists ? (fmtSize(it.size) + ' · ' + fmtStamp(it.mtime * 1000, 'md-hm')) : '文件缺失'));   // F5-P8③：时间戳单点
        if (it.exists) {
          row.appendChild(el('span', 'pane-r-go', '改 ›'));
          row.addEventListener('click', () => openEdit(it.name));
        } else {
          row.addEventListener('click', () => toast('文件缺失，无法编辑', 'err'));
        }
        listBox.appendChild(row);
      }
    }
  } catch (err) {
    stageText(listBox, 'error', err);
  }
}

async function openEdit(name) {
  let r;
  try {
    const res = await api.recipeGet(name);
    r = res.recipe;
  } catch (err) {
    toast('读取失败：' + err.message, 'err');
    return;
  }
  listBox.textContent = '';
  const head = el('div', 'pane-e-head');
  const back = el('button', 'tool-btn small', '‹ 返回列表');
  back.addEventListener('click', () => {
    if (!guardLeave('返回列表')) return;   // F5-B1：单点
    refreshList();
  });
  head.appendChild(back);
  head.appendChild(el('b', 'pane-e-title', r.title + '（' + r.group + '/' + r.name + '）'));
  listBox.appendChild(head);

  const ta = document.createElement('textarea');
  ta.className = 'form-input form-area pane-e-area';
  ta.spellcheck = false;
  ta.value = r.content;
  viewDirty = () => ta.value !== r.content;    // 脏检查（批4）
  listBox.appendChild(ta);

  const meta = el('div', 'form-desc', fmtSize(r.size) + ' · 改于 ' + fmtStamp(r.mtime * 1000, 'md-hm'));
  listBox.appendChild(meta);

  const bar = el('div', 'form-bar');
  const save = el('button', 'tool-btn small', '保存');
  save.addEventListener('click', () => busy(save, async () => {   // F5-W16
    try {
      const out = await api.recipeSave(name, ta.value);
      const rr = out.recipe;
      r.content = ta.value;                       // 基线同步：脏检查归零（批4）
      meta.textContent = fmtSize(rr.size) + ' · 改于 ' + fmtStamp(rr.mtime * 1000, 'md-hm') + ' · 旧版已备份';
      toast('已保存：' + r.title + '（立即生效，旧版已备份）');
    } catch (err) {
      failToast('保存失败', err);
    }
  }));
  const dft = el('button', 'tool-btn small', '恢复默认');
  dft.title = '回到出厂文本（当前版本会先备份）';
  dft.addEventListener('click', () => busy(dft, async () => {   // F5-W16
    try {
      const out = await api.recipeDefault(name);
      ta.value = out.recipe.content;
      r.content = out.recipe.content;             // 恢复即基线（批4）
      meta.textContent = '已恢复出厂文本（旧版已备份）';
      toast('已恢复默认：' + r.title);
    } catch (err) {
      failToast('恢复失败', err);
    }
  }));
  bar.appendChild(save);
  bar.appendChild(dft);
  listBox.appendChild(bar);
}
