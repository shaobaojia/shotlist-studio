// 设置与配方中心（M4b-3）：顶栏「设置」→ 浮卡两区（AI 通道 + 配方）。
// 配方口径：一个功能一份，保存即生效（不重启）；保存/恢复前自动备份旧版。
// key 明文永不出后端（只显示「已配置（留空＝不改）」）。
import { api } from './api.js';
import { el, toast } from './ui.js';

let card = null, bodyEl = null, listBox = null;

export function bindSettingsBtn(btn) {
  if (btn) btn.addEventListener('click', toggleSettings);
}

export function toggleSettings() {
  if (card && !card.hidden) { card.hidden = true; return; }
  openSettings();
}

export function openSettings() {
  if (!card) build();
  card.hidden = false;
  loadAll();
}

function build() {
  card = el('div');
  card.id = 'settings-card';
  card.hidden = true;
  const head = el('div', 'sc-head');
  head.appendChild(el('b', null, '设置'));
  const x = el('button', 'tool-btn small', '✕');
  x.addEventListener('click', () => { card.hidden = true; });
  head.appendChild(x);
  card.appendChild(head);
  bodyEl = el('div', 'sc-body');
  card.appendChild(bodyEl);
  document.body.appendChild(card);
}

function loadAll() {
  bodyEl.textContent = '';
  loadAI();
  loadRecipes();
}

// ── 一区：AI 通道（自审计 ⚙ 搬迁）────────────────────────────

async function loadAI() {
  const sec = el('div', 'as-sec');
  sec.appendChild(el('div', 'as-sec-t', 'AI 通道 · 创作与 LLM 审计共用（key 只存本地库、不入 git、不回传浏览器）'));
  bodyEl.appendChild(sec);
  try {
    const res = await api.aiSettings();
    renderAI(sec, (res && res.config) || {});
  } catch (err) {
    sec.appendChild(el('div', 'as-desc', '加载失败：' + err.message));
  }
}

function renderAI(sec, cfg) {
  const field = (label, key, val, ph) => {
    const wrap = el('label', 'as-p');
    wrap.appendChild(el('span', 'as-p-k', label));
    const inp = document.createElement('input');
    inp.className = 'as-input';
    inp.dataset.k = key;
    inp.value = val == null ? '' : val;
    if (ph) inp.placeholder = ph;
    wrap.appendChild(inp);
    return wrap;
  };
  sec.appendChild(field('provider', 'provider', cfg.provider));
  sec.appendChild(field('model', 'model', cfg.model));
  sec.appendChild(field('base_url', 'base_url', cfg.base_url));
  sec.appendChild(field('api_key', 'api_key', '', cfg.has_key ? '已配置（留空＝不改）' : '未配置'));

  const bar = el('div', 'as-bar');
  const save = el('button', 'tool-btn small', '保存配置');
  save.addEventListener('click', async () => {
    const payload = {};
    sec.querySelectorAll('.as-input').forEach((inp) => {
      const v = (inp.value || '').trim();
      if (inp.dataset.k === 'api_key') { if (v) payload.api_key = v; }
      else if (v) payload[inp.dataset.k] = v;
    });
    try {
      await api.aiSave(payload);
      toast('AI 配置已保存');
    } catch (err) { toast('保存失败：' + err.message, 'err'); }
  });
  const testb = el('button', 'tool-btn small', '连通测试');
  const result = el('span', 'as-test-result', '');
  testb.addEventListener('click', async () => {
    testb.disabled = true;
    result.textContent = '测试中…';
    try {
      const res = await api.aiTest();
      result.textContent = res.ok ? ('✓ ' + res.ms + 'ms · ' + (res.reply || '')) : ('✗ ' + (res.error || '失败'));
    } catch (err) {
      result.textContent = '✗ ' + err.message;
    }
    testb.disabled = false;
  });
  bar.appendChild(save);
  bar.appendChild(testb);
  bar.appendChild(result);
  sec.appendChild(bar);
}

// ── 二区：配方（列表 → 就地编辑）────────────────────────────

async function loadRecipes() {
  const sec = el('div', 'as-sec');
  sec.appendChild(el('div', 'as-sec-t', '配方 · 某个功能里 AI 手里那份提示词，一个功能一份，保存即生效；骨架：①身份 → ②检查/改写要求 → ③喂什么数据 → ④输出格式 → ⑤质量口径。'));
  listBox = el('div', 'sc-recipes');
  sec.appendChild(listBox);
  bodyEl.appendChild(sec);
  await refreshList();
}

function fmtSize(b) { return b < 1024 ? (b + ' B') : ((b / 1024).toFixed(1) + ' KB'); }
function fmtTime(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function refreshList() {
  listBox.textContent = '加载中…';
  try {
    const res = await api.recipes();
    listBox.textContent = '';
    for (const g of (res.groups || [])) {
      listBox.appendChild(el('div', 'sc-g-t', g.label));
      for (const it of (g.items || [])) {
        const row = el('div', 'sc-r' + (it.exists ? '' : ' missing'));
        row.appendChild(el('span', 'sc-r-t', it.title));
        row.appendChild(el('span', 'sc-r-m', it.exists ? (fmtSize(it.size) + ' · ' + fmtTime(it.mtime)) : '文件缺失'));
        if (it.exists) {
          row.appendChild(el('span', 'sc-r-go', '改 ›'));
          row.addEventListener('click', () => openEdit(it.name));
        } else {
          row.addEventListener('click', () => toast('文件缺失，无法编辑', 'err'));
        }
        listBox.appendChild(row);
      }
    }
  } catch (err) {
    listBox.textContent = '加载失败：' + err.message;
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
  const head = el('div', 'sc-e-head');
  const back = el('button', 'tool-btn small', '‹ 返回列表');
  back.addEventListener('click', () => { refreshList(); });
  head.appendChild(back);
  head.appendChild(el('b', 'sc-e-title', r.title + '（' + r.group + '/' + r.name + '）'));
  listBox.appendChild(head);

  const ta = document.createElement('textarea');
  ta.className = 'as-input as-area sc-e-area';
  ta.spellcheck = false;
  ta.value = r.content;
  listBox.appendChild(ta);

  const meta = el('div', 'as-desc', fmtSize(r.size) + ' · 改于 ' + fmtTime(r.mtime));
  listBox.appendChild(meta);

  const bar = el('div', 'as-bar');
  const save = el('button', 'tool-btn small', '保存');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const out = await api.recipeSave(name, ta.value);
      const rr = out.recipe;
      meta.textContent = fmtSize(rr.size) + ' · 改于 ' + fmtTime(rr.mtime) + ' · 旧版已备份';
      toast('已保存：' + r.title + '（立即生效，旧版已备份）');
    } catch (err) {
      toast('保存失败：' + err.message, 'err');
    }
    save.disabled = false;
  });
  const dft = el('button', 'tool-btn small', '恢复默认');
  dft.title = '回到出厂文本（当前版本会先备份）';
  dft.addEventListener('click', async () => {
    dft.disabled = true;
    try {
      const out = await api.recipeDefault(name);
      ta.value = out.recipe.content;
      meta.textContent = '已恢复出厂文本（旧版已备份）';
      toast('已恢复默认：' + r.title);
    } catch (err) {
      toast('恢复失败：' + err.message, 'err');
    }
    dft.disabled = false;
  });
  bar.appendChild(save);
  bar.appendChild(dft);
  listBox.appendChild(bar);
}
