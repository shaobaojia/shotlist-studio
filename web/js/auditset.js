// 审计设置浮卡（M4a-2）：十项规则开关 / 参数就地改 + AI 通道最小配置口。
// 口径：每次「跑审计」严格按开关执行；单条「重检」不受开关限制。key 明文永不出后端（只显示是否已配置）。
import { api } from './api.js';
import { el, toast } from './ui.js';

const PARAM_CN = { min_shots: '最少镜头数', sizes: '计作特写的景别', wordlist: '模糊词表',
  require_reaction_shot: '要求反应镜', require_dof: '要求景深标注' };

let panel = null, bodyEl = null;

export function openAuditSettings() {
  if (!panel) build();
  panel.hidden = false;
  load();
}

function build() {
  panel = el('div');
  panel.id = 'audit-set';
  panel.hidden = true;
  const head = el('div', 'as-head');
  head.appendChild(el('b', null, '审计设置'));
  const x = el('button', 'tool-btn small', '✕');
  x.addEventListener('click', () => { panel.hidden = true; });
  head.appendChild(x);
  panel.appendChild(head);
  bodyEl = el('div', 'as-body');
  panel.appendChild(bodyEl);
  document.body.appendChild(panel);
}

async function load() {
  bodyEl.textContent = '加载中…';
  try {
    const res = await api.auditRulesGet();
    const ai = await api.aiSettings();
    bodyEl.textContent = '';
    renderRules(res.rules || []);
    renderAI((ai && ai.config) || {});
  } catch (err) {
    bodyEl.textContent = '加载失败：' + err.message;
  }
}

function renderRules(rules) {
  const sec = el('div', 'as-sec');
  sec.appendChild(el('div', 'as-sec-t', '规则 · 每次「跑审计」严格按开关执行；单条「重检」不受开关限制。'));
  for (const r of rules) sec.appendChild(ruleRow(r));
  bodyEl.appendChild(sec);
}

function ruleRow(r) {
  const row = el('div', 'as-rule' + (r.enabled ? '' : ' off'));
  const line = el('div', 'as-line');
  const sw = el('label', 'as-switch');
  sw.title = r.enabled ? '点击停用' : '点击启用';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!r.enabled;
  cb.addEventListener('change', async () => {
    try {
      await api.auditRules({ id: r.id, enabled: cb.checked });
      row.classList.toggle('off', !cb.checked);
      sw.title = cb.checked ? '点击停用' : '点击启用';
      toast(cb.checked ? '已启用：' + r.title : '已停用：' + r.title);
    } catch (err) {
      cb.checked = !cb.checked;
      toast('保存失败：' + err.message, 'err');
    }
  });
  sw.appendChild(cb);
  sw.appendChild(el('span', 'as-slider'));
  line.appendChild(sw);
  line.appendChild(el('span', 'as-title', r.title));
  line.appendChild(el('span', 'eng ' + (r.kind === 'llm' ? 'l' : 'p'), r.kind === 'llm' ? 'LLM' : '程序'));
  row.appendChild(line);
  if (r.desc) row.appendChild(el('div', 'as-desc', r.desc));
  const params = r.params || {};
  const keys = Object.keys(params);
  if (keys.length) {
    const pbox = el('div', 'as-params');
    for (const k of keys) pbox.appendChild(paramField(r.id, params, k));
    row.appendChild(pbox);
  }
  return row;
}

function paramField(rid, params, k) {
  const wrap = el('label', 'as-p');
  wrap.appendChild(el('span', 'as-p-k', PARAM_CN[k] || k));
  const val = params[k];
  let inp;
  if (typeof val === 'boolean') {
    inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = val;
    inp.addEventListener('change', () => saveRuleParams(rid, params, k, inp.checked));
  } else if (typeof val === 'number') {
    inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'as-input as-num';
    inp.value = val;
    inp.addEventListener('change', () => saveRuleParams(rid, params, k, Number(inp.value) || 0));
  } else if (Array.isArray(val)) {
    const multiline = val.length > 6;
    inp = document.createElement(multiline ? 'textarea' : 'input');
    if (multiline) inp.rows = 3;
    inp.className = 'as-input' + (multiline ? ' as-area' : '');
    inp.value = val.join('，');
    inp.addEventListener('change', () => saveRuleParams(rid, params, k,
      inp.value.split(/[，,\n]/).map((s) => s.trim()).filter(Boolean)));
  } else {
    inp = document.createElement('input');
    inp.className = 'as-input';
    inp.value = String(val);
    inp.addEventListener('change', () => saveRuleParams(rid, params, k, inp.value));
  }
  wrap.appendChild(inp);
  return wrap;
}

async function saveRuleParams(rid, params, k, v) {
  const next = Object.assign({}, params);
  next[k] = v;
  try {
    await api.auditRules({ id: rid, params: next });
    params[k] = v;
    toast('已保存（下次跑审计生效）');
  } catch (err) {
    toast('保存失败：' + err.message, 'err');
  }
}

function renderAI(cfg) {
  const sec = el('div', 'as-sec');
  sec.appendChild(el('div', 'as-sec-t', 'AI 通道 · LLM 规则用（key 只存本地库、不入 git、不回传浏览器）'));
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
      load();
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
  bodyEl.appendChild(sec);
}
