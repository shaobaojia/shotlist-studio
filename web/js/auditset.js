// 审计设置浮卡（M4a-2）：十项规则开关 / 参数就地改。（AI 通道与配方 → 顶栏「设置」，M4b-3 搬迁）
// 口径：每次「跑审计」严格按开关执行；单条「重检」不受开关限制。key 明文永不出后端（只显示是否已配置）。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { fieldRow } from './formkit.js';
import { panelShell, floatEnter, floatLeave } from './float.js';

let panel = null, bodyEl = null;

function closeAuditSet() {
  if (panel) panel.hidden = true;
  floatLeave('panel', closeAuditSet);
}

export function openAuditSettings() {
  floatEnter('panel', closeAuditSet);   // 浮卡互斥：审计设置 ↮ 设置（F8 入注册表，L6）
  if (!panel) build();
  panel.hidden = false;
  load();
}

function build() {
  const sh = panelShell({ id: 'audit-set', headCls: 'as-head', bodyCls: 'as-body', title: '审计设置', onClose: closeAuditSet });
  panel = sh.card;
  bodyEl = sh.body;
  panel.hidden = true;
  document.body.appendChild(panel);
}

async function load() {
  bodyEl.textContent = '加载中…';
  try {
    const res = await api.auditRulesGet();
    bodyEl.textContent = '';
    renderRules(res.rules || []);
    bodyEl.appendChild(el('div', 'as-desc', 'AI 通道与配方 → 顶栏「设置」。'));
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
    const schema = r.params_schema || {};       // 控件由后端 schema 派生（L9：RULES 单点）
    const pbox = el('div', 'as-params');
    for (const k of keys) pbox.appendChild(paramField(r.id, params, k, schema[k]));
    row.appendChild(pbox);
  }
  return row;
}

function paramField(rid, params, k, meta) {
  meta = meta || {};
  const val = params[k];
  const type = meta.type || (typeof val === 'boolean' ? 'bool'
    : (typeof val === 'number' ? 'int' : (Array.isArray(val) ? 'list' : 'text')));
  let spec;
  if (type === 'bool') {
    spec = { cls: '', type: 'checkbox', checked: !!val };
  } else if (type === 'int') {
    spec = { type: 'number', cls: 'as-input as-num', value: val,
             min: meta.min != null ? meta.min : 1 };
  } else if (type === 'list') {
    const multiline = (val || []).length > 6;
    spec = { tag: multiline ? 'textarea' : 'input', rows: multiline ? 3 : 0,
             cls: 'as-input' + (multiline ? ' as-area' : ''), value: (val || []).join('，') };
  } else {
    spec = { value: String(val) };
  }
  const fr = fieldRow(meta.label || k, spec);
  const inp = fr.inp;
  if (type === 'bool') {
    inp.addEventListener('change', () => saveRuleParams(rid, params, k, inp.checked, inp));
  } else if (type === 'int') {
    inp.addEventListener('change', () => {
      const raw = (inp.value || '').trim();
      const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
      if (!raw || !Number.isFinite(n) || n < 1) {   // 空值/折算一律拒绝：不再「显示 0、实跑 3」（L3）
        inp.value = params[k];
        toast('请输入 ≥1 的整数（保持原值不变）', 'err');
        return;
      }
      saveRuleParams(rid, params, k, n, inp);
    });
  } else if (type === 'list') {
    inp.addEventListener('change', () => saveRuleParams(rid, params, k,
      inp.value.split(/[，,\n]/).map((s) => s.trim()).filter(Boolean), inp));
  } else {
    inp.addEventListener('change', () => saveRuleParams(rid, params, k, inp.value, inp));
  }
  return fr.row;
}

async function saveRuleParams(rid, params, k, v, inp) {
  const prev = params[k];
  const next = Object.assign({}, params);
  next[k] = v;
  try {
    await api.auditRules({ id: rid, params: next });
    params[k] = v;
    toast('已保存（下次跑审计生效）');
  } catch (err) {
    if (inp) {                                   // 失败回滚到原显示值（与开关同款，L3）
      if (typeof prev === 'boolean') inp.checked = prev;
      else if (Array.isArray(prev)) inp.value = prev.join('，');
      else inp.value = String(prev);
    }
    toast('保存失败：' + err.message, 'err');
  }
}
