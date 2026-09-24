// 表单件单点（L9）：设置卡（settings.js）与审计设置卡（auditset.js）共用。
// 行骨架保持既有类名（.form-p / .form-p-k / .form-input）——纯结构复用，视觉零变化。
import { el } from './ui.js';

// 表单行：<label class="form-p"><span class="form-p-k">label</span><控件/></label>
// spec: {tag:'input'|'textarea', type?, cls?, value?, checked?, placeholder?, rows?, min?, key?(data-k)}
// 返回 { row, inp }（事件由调用方挂）。
export function fieldRow(label, spec) {
  spec = spec || {};
  const row = el('label', 'form-p');
  row.appendChild(el('span', 'form-p-k', label));
  const inp = document.createElement(spec.tag || 'input');
  const cls = spec.cls === undefined ? 'form-input' : spec.cls;
  if (cls) inp.className = cls;
  if (spec.type) inp.type = spec.type;
  if (spec.rows) inp.rows = spec.rows;
  if (spec.min != null) inp.min = spec.min;
  if (spec.placeholder) inp.placeholder = spec.placeholder;
  if (spec.type === 'checkbox') inp.checked = !!spec.checked;
  else if (spec.value != null) inp.value = spec.value;
  if (spec.key) inp.dataset.k = spec.key;
  row.appendChild(inp);
  return { row: row, inp: inp };
}

// 取值收集：sec 内全部 [data-k] 控件 → {k: 去空白值}
export function collect(sec) {
  const out = {};
  sec.querySelectorAll('[data-k]').forEach((inp) => { out[inp.dataset.k] = (inp.value || '').trim(); });
  return out;
}
