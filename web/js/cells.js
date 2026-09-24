// 老库单元格渲染——规格移植自 storyboard-shotlist（buildRow / formatKongjian / JIWEI_SHORT）。
// 全部 DOM 构建（数据不进 innerHTML），返回 DocumentFragment。
import { el, durText } from './ui.js';

// 机位五色 → 单字缩写（原样搬自老库）
const JIWEI_SHORT = {
  '\u{1F534} 正打': '\u{1F534}正',
  '\u{1F7E1} 反打': '\u{1F7E1}反',
  '\u{1F7E2} 第三人称': '\u{1F7E2}三',
  '\u{1F535} 空间环境': '\u{1F535}环',
  '\u{1F7E3} 插入/切出': '\u{1F7E3}插',
};
export const JIWEI_LEGEND = ['\u{1F534} 正打', '\u{1F7E1} 反打', '\u{1F7E2} 第三人称', '\u{1F535} 空间环境', '\u{1F7E3} 插入/切出'];

// 摄影机列 = 景别 + 焦段（景深后缀识别后丢弃；2026-09-19 实测弃用）
const LENS_RE = /(\d+mm)(?:·(?:浅|中|深)(?:→(?:浅|中|深))?)?/;

export function cellContent(type, value, extra) {
  const v = value == null ? '' : String(value);
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
    const raw = v.trim();
    const m = raw.match(LENS_RE);
    const lens = m ? m[1] : (extra && extra.focal ? String(extra.focal).trim() : null);
    const framing = m ? (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim() : raw;
    const parts = framing.indexOf('\u2193') !== -1
      ? [framing.split('\u2193')[0].trim(), '\u2193', (framing.split('\u2193')[1] || '').trim()]
      : [framing];
    parts.forEach((p, i) => { if (i) br(); txt(p); });
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
