import { api } from './api.js';
import { state } from './state.js';
import { el, fmt, kindChip } from './ui.js';

export async function renderScene(view, sceneNo) {
  view.textContent = '';
  view.appendChild(el('div', 'empty', '加载中…'));
  let data;
  try {
    data = await api.scene(sceneNo);
  } catch (err) {
    view.textContent = '';
    view.appendChild(el('div', 'empty err', '加载失败：' + err.message));
    return;
  }
  if (location.hash !== '' && location.hash !== '#/' + sceneNo) return;

  view.textContent = '';
  const sc = data.scene;
  const fields = state.meta.shot_fields;
  const tableFields = fields.filter(f => f.in_table);
  const groups = {};
  for (const g of data.prompt_groups) groups[g.id] = g;

  const head = el('div', 'scene-head');
  head.appendChild(el('h1', 'scene-title', sc.scene_no + (sc.title ? ' · ' + sc.title : '')));
  const meta = el('div', 'scene-meta');
  const totalShots = data.beats.reduce((n, b) => n + b.shots.length, 0) + (data.orphan_shots || []).length;
  const kv = (label, val) => {
    if (val === null || val === undefined || val === '') return;
    const span = el('span', 'kv');
    span.appendChild(el('b', null, label));
    span.appendChild(document.createTextNode(fmt(val)));
    meta.appendChild(span);
  };
  kv('价值', sc.value);
  kv('弧线', [sc.pole_start, sc.pole_end].filter(Boolean).join(' → '));
  kv('翻转', sc.turn);
  kv('视点', sc.pov);
  kv('规模', totalShots + ' 镜 / ' + data.beats.length + ' 节拍');
  head.appendChild(meta);
  view.appendChild(head);

  if (!data.beats.length && !(data.orphan_shots || []).length) {
    view.appendChild(el('div', 'empty', '本场暂无镜头——价值弧线已登记，等待创作填入。'));
    return;
  }

  for (const b of data.beats) view.appendChild(beatSection(b, tableFields, fields, groups));
  if (data.orphan_shots && data.orphan_shots.length) {
    view.appendChild(beatSection(
      { beat_no: null, name: '未归节拍', kind: null, shots: data.orphan_shots },
      tableFields, fields, groups));
  }
}

function beatSection(b, tableFields, allFields, groups) {
  const sec = el('section', 'beat');
  const head = el('div', 'beat-head');
  const title = (b.beat_no != null && /^\d+$/.test(String(b.beat_no)))
    ? '节拍 ' + b.beat_no + (b.name ? ' · ' + b.name : '')
    : (b.name || String(b.beat_no || '未归节拍'));
  head.appendChild(el('span', 'beat-name', title));
  if (b.kind) head.appendChild(kindChip(b.kind));
  head.appendChild(el('span', 'beat-count', b.shots.length + ' 镜'));
  sec.appendChild(head);

  if (!b.shots.length) {
    sec.appendChild(el('div', 'empty small', '（暂无镜头）'));
    return sec;
  }

  const wrap = el('div', 'table-wrap');
  const t = el('table', 'shots');
  const cg = document.createElement('colgroup');
  let sum = 0;
  for (const f of tableFields) {
    const c = document.createElement('col');
    c.style.width = f.w + 'px';
    cg.appendChild(c);
    sum += f.w;
  }
  t.appendChild(cg);
  t.style.minWidth = sum + 'px';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const f of tableFields) htr.appendChild(el('th', null, f.label));
  thead.appendChild(htr);
  t.appendChild(thead);

  const tb = document.createElement('tbody');
  for (const s of b.shots) tb.appendChild(shotRows(s, tableFields, allFields, groups));
  t.appendChild(tb);
  wrap.appendChild(t);
  sec.appendChild(wrap);
  return sec;
}

function shotRows(s, tableFields, allFields, groups) {
  const frag = document.createDocumentFragment();
  const tr = el('tr', 'shot');
  for (const f of tableFields) {
    const td = el('td');
    if (f.type === 'prompt') {
      const g = s.prompt_group_id != null ? groups[s.prompt_group_id] : null;
      td.classList.add('prompt-cell');
      td.textContent = g ? g.member_shots.join(' / ') : '—';
      td.title = g ? '提示词组：' + g.member_shots.join(' / ') : '';
    } else {
      td.textContent = fmt(s[f.key]);
      if (td.textContent !== '—') td.title = td.textContent;
    }
    tr.appendChild(td);
  }
  const det = el('tr', 'detail');
  det.hidden = true;
  const dtd = document.createElement('td');
  dtd.colSpan = tableFields.length;
  dtd.appendChild(detailBox(s, allFields, groups));
  det.appendChild(dtd);

  tr.addEventListener('click', () => {
    det.hidden = !det.hidden;
    tr.classList.toggle('open', !det.hidden);
  });
  frag.appendChild(tr);
  frag.appendChild(det);
  return frag;
}

function detailBox(s, allFields, groups) {
  const box = el('div', 'detail-grid');
  for (const f of allFields) {
    if (f.type === 'prompt') continue;
    const item = el('div', 'kv-item');
    item.appendChild(el('div', 'kv-label', f.label));
    item.appendChild(el('div', 'kv-value', fmt(s[f.key])));
    box.appendChild(item);
  }
  const g = s.prompt_group_id != null ? groups[s.prompt_group_id] : null;
  const pb = el('div', 'prompt-box');
  pb.appendChild(el('div', 'kv-label',
    g ? ('提示词（本组 ' + g.member_shots.length + ' 镜：' + g.member_shots.join(' / ') + '）') : '提示词'));
  pb.appendChild(el('pre', 'prompt-text', g ? g.text : '（未写提示词）'));
  box.appendChild(pb);
  return box;
}
