// 筛选与镜号跳转（DOM 级：不重建表格、输入不丢焦）。
import { groupsById, fieldsOf } from './state.js';
import { el, toast, flashIntoView } from './ui.js';

let filterState = { q: '', noPrompt: false };

export function filterActive() {
  return !!(filterState.q || filterState.noPrompt);
}

export function resetFilter() {
  filterState = { q: '', noPrompt: false };
}

// 在工具条上挂筛选组；ctx: { apply(), repaint(), allShots(), getView() }
export function buildFilterTools(bar, ctx) {
  const fq = document.createElement('input');
  fq.type = 'text';
  fq.className = 'filter-input';
  fq.placeholder = '筛选：关键字';
  fq.value = filterState.q;
  let t = null;
  fq.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      filterState.q = fq.value.trim();
      ctx.apply();
    }, 250);
  });
  bar.appendChild(fq);

  const fj = document.createElement('input');
  fj.type = 'text';
  fj.className = 'filter-input jump-input';
  fj.placeholder = '镜号跳转 ↵';
  fj.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToShot(fj.value, ctx);
    }
  });
  bar.appendChild(fj);

  const lab = el('label', 'tool');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = filterState.noPrompt;
  cb.addEventListener('change', (e) => {
    filterState.noPrompt = e.target.checked;
    ctx.apply();
  });
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(' 未写提示词'));
  bar.appendChild(lab);

  bar.appendChild(el('span', 'filter-info'));
  const clr = el('button', 'tool-btn clear-filter', '清除筛选');
  clr.style.display = filterActive() ? '' : 'none';
  clr.addEventListener('click', () => {
    resetFilter();
    ctx.repaint();
  });
  bar.appendChild(clr);
}

function shotMatches(s, groups) {
  if (filterState.q) {
    const q = filterState.q.toLowerCase();
    let hay = '';
    for (const f of fieldsOf('shots')) {
      if (f.type === 'prompt') continue;
      if (s[f.key] != null) hay += String(s[f.key]).toLowerCase() + '\n';
    }
    if (hay.indexOf(q) === -1) return false;
  }
  if (filterState.noPrompt) {
    const g = s.prompt_group_id != null ? groups[s.prompt_group_id] : null;
    if (g && String(g.text || '').trim()) return false;
  }
  return true;
}

// 行级过滤（首帧/重建后调用）：藏行、藏空节拍、更新计数；ctx: { getData(), getView(), allShots() }
export function applyFilter(ctx) {
  const view = ctx.getView();
  const data = ctx.getData();
  if (!view || !data) return;
  const active = filterActive();
  const groups = groupsById(data);
  const map = {};
  for (const s of ctx.allShots()) map[s.id] = s;
  let shown = 0;
  let total = 0;
  view.querySelectorAll('tr.shot').forEach((tr) => {
    const s = map[Number(tr.dataset.id)];
    if (!s) return;
    total++;
    const ok = !active || shotMatches(s, groups);
    if (ok) shown++;
    tr.style.display = ok ? '' : 'none';
    // 同行附加行联动（详情行 + 审计问题卡行 + 未来同类）：跟着本行一起藏/显（M6）
    let n = tr.nextElementSibling;
    while (n && (n.classList.contains('detail') || n.classList.contains('audit-card-tr'))) {
      n.style.display = ok ? '' : 'none';
      n = n.nextElementSibling;
    }
  });
  view.querySelectorAll('section.beat').forEach((sec) => {
    const rows = sec.querySelectorAll('tr.shot');
    if (!rows.length) return;
    let any = false;
    rows.forEach((tr) => { if (tr.style.display !== 'none') any = true; });
    sec.style.display = (!active || any) ? '' : 'none';
  });
  const info = view.querySelector('.filter-info');
  if (info) info.textContent = active ? ('筛选中 ' + shown + ' / ' + total + ' 镜') : '';
  const clr = view.querySelector('.clear-filter');
  if (clr) clr.style.display = active ? '' : 'none';
}

export function jumpToShot(raw, ctx) {
  const v = (raw || '').trim();
  if (!v) return;
  const norm = (x) => {
    const t = String(x == null ? '' : x).trim();
    if (/^\d+$/.test(t)) return String(parseInt(t, 10));
    return t.toUpperCase();
  };
  const key = norm(v);
  const target = ctx.allShots().find((s) => norm(s.shot_no) === key);
  if (!target) {
    toast('未找到镜号：' + v);
    return;
  }
  if (filterActive()) {
    resetFilter();
    ctx.repaint();
  }
  jumpToShotById(target.id);
}

// 滚到行并闪烁（id 单点；挂件带/镜号跳转共用）
export function jumpToShotById(id) {
  const tr = document.querySelector('tr.shot[data-id="' + id + '"]');
  if (!tr) return false;
  return flashIntoView(tr, { block: 'center' });
}
