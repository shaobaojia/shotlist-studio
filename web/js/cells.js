// 老库单元格渲染——规格移植自 storyboard-shotlist（buildRow / formatKongjian / JIWEI_SHORT）。
// 全部 DOM 构建（数据不进 innerHTML），返回 DocumentFragment。
import { el, durText } from './ui.js';
import { parseCam } from './edit.js';

// 机位五色 → 单字缩写（原样搬自老库）
const JIWEI_SHORT = {
  '\u{1F534} 正打': '\u{1F534}正',
  '\u{1F7E1} 反打': '\u{1F7E1}反',
  '\u{1F7E2} 第三人称': '\u{1F7E2}三',
  '\u{1F535} 空间环境': '\u{1F535}环',
  '\u{1F7E3} 插入/切出': '\u{1F7E3}插',
};
export const JIWEI_LEGEND = Object.keys(JIWEI_SHORT);   // 单点派生（F1-W16）

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
    txt(JIWEI_SHORT[v] || v);
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
