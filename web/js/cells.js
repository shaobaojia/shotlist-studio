// 老库单元格渲染——规格移植自 storyboard-shotlist（buildRow / formatKongjian / JIWEI_SHORT）。
// 全部 DOM 构建（数据不进 innerHTML），返回 DocumentFragment。
import { el, durText } from './ui.js';
import { fieldOf } from './state.js';
import { parseCam } from './edit.js';

// 机位五色枚举随 meta（S3-P3②：服务端单源）；缩写 = 各选项定字（视觉细节，留在 UI 层）
const JIWEI_ABBR = { '正打': '正', '反打': '反', '第三人称': '三', '空间环境': '环', '插入/切出': '插' };

function jiweiOptions() {
  const f = fieldOf('camera_pos');
  return (f && f.options) || [];
}

// 机位图例（原 JIWEI_LEGEND 常量 → 函数；用法 .join(' ') 不变）
export function jiweiLegend() {
  return jiweiOptions();
}

function jiweiShort(v) {
  for (const o of jiweiOptions()) {
    if (o === v) {
      const name = o.replace(/^\S+\s*/, '');           // 去 emoji 前缀
      return o.split(/\s+/)[0] + (JIWEI_ABBR[name] || name[0] || '');
    }
  }
  return v;                                            // 未注册值原样（同旧口径）
}

export function cellContent(f, s) {
  const type = f.type;
  const v = (s && s[f.key]) == null ? '' : String(s[f.key]);
  const frag = document.createDocumentFragment();
  const push = (n) => frag.appendChild(n);
  const txt = (t) => push(document.createTextNode(t));
  const br = () => push(document.createElement('br'));

  if (type === 'spatial') {
    v.split('\n').forEach((line, i) => {
      if (i) br();
      line.split('[').forEach((seg, j) => {
        if (j) { push(document.createElement('wbr')); txt('['); }
        txt(seg);
      });
    });
    return frag;
  }

  if (type === 'camera') {
    // 解析单点（F1-W17）：复用 edit.parseCam；景深后缀丢弃口径不变
    const p = parseCam(v);
    const lens = p.lens || ((s && s.focal) ? String(s.focal).trim() : null);
    const parts = p.t2 ? [p.t1, '\u2193', p.t2] : [p.t1];
    parts.forEach((it, i) => { if (i) br(); txt(it); });
    if (lens) { br(); push(el('span', 'lens-tech', lens)); }
    return frag;
  }

  if (type === 'jiwei') {
    txt(jiweiShort(v));
    return frag;
  }

  if (type === 'duration') {
    txt(durText(v) || '—');
    return frag;
  }

  if (type === 'audio') {
    const t = v.trim();
    if (t && t !== '—') {
      const span = el('span', 'audio-sfx');
      t.split('\n').forEach((line, i) => {
        if (i) span.appendChild(document.createElement('br'));
        span.appendChild(document.createTextNode(line));
      });
      push(span);
    } else {
      push(el('span', 'audio-music', '—'));
    }
    return frag;
  }

  txt(v || '—');
  return frag;
}
