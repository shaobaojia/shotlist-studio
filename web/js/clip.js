// 跨工程剪贴板（M8 工程库）：选区「复制行」→ 切工程 →「粘贴到本场」。
// 叶子模块（M8 清理刀：自 filmlib 迁出，解 selbar→filmlib→scene→selbar 环）：
// 只依赖 api/state/ui/route/selection（overCap 上限单点）；粘贴后刷新经 initClipBar 注入回调。
import { api } from './api.js';
import { state, sceneLabel } from './state.js';
import { el, toast } from './ui.js';
import { sceneNo } from './route.js';
import { overCap } from './selection.js';

let clip = null;        // {filmTitle, ids}（会话级内存——切工程 / 关源工程不丢）
let clipBar = null;     // 底栏
let onPasted = null;    // 粘贴成功后刷新当前视图（main 注入）

export function initClipBar(opts) {
  onPasted = (opts && opts.onPasted) || null;
  if (clipBar) return;
  clipBar = el('div');
  clipBar.id = 'clip-bar';
  document.body.appendChild(clipBar);
  renderClipBar();
}

export function setClip(ids) {
  if (!ids || !ids.length) { toast('先选中镜头行', 'err'); return; }
  if (overCap(ids.length, '行')) return;               // 上限单点（与批量写同源；M8 清理刀）
  clip = { filmTitle: (state.film && state.film.title) || '', ids: ids.slice() };
  renderClipBar();
  toast('已复制 ' + clip.ids.length + ' 镜——切换工程后可粘贴');
}

function renderClipBar() {
  if (!clipBar) return;
  if (!clip || !clip.ids.length) { clipBar.style.display = 'none'; return; }
  clipBar.style.display = 'flex';
  clipBar.textContent = '';
  clipBar.appendChild(el('span', 'cb-txt', '📋 已复制 ' + clip.ids.length + ' 镜'));
  clipBar.appendChild(el('span', 'cb-src', '来自「' + clip.filmTitle + '」'));
  const paste = el('button', 'tool-btn', '粘贴到本场');
  paste.title = '把剪贴板中的镜头追加到当前打开场次的末尾';
  paste.addEventListener('click', doPaste);
  clipBar.appendChild(paste);
  const x = el('button', 'tool-btn small', '✕');
  x.title = '清空剪贴板';
  x.addEventListener('click', () => { clip = null; renderClipBar(); });
  clipBar.appendChild(x);
}

async function doPaste() {
  if (!clip || !clip.ids.length) return;
  const curNo = sceneNo();
  if (!curNo) { toast('先打开一个场，再粘贴到本场', 'err'); return; }
  const sc = state.scenes.find((x) => x.scene_no === curNo);
  if (!sc) { toast('当前场不存在', 'err'); return; }
  try {
    const res = await api.paste(sc.id, clip.ids);
    toast('已粘贴 ' + res.pasted.count + ' 镜到 ' + sceneLabel(sc));
    if (onPasted) await onPasted();
  } catch (e) { toast('粘贴失败：' + e.message, 'err'); }
}
