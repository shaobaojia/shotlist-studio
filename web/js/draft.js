// 草稿档（M4b-4）：从台本出草稿（空场专用）+ 组级提示词初稿。
// 口径：生成走后台任务轮询；预览零写入——「落入」才落库（一步撤销走全局栈）；
// 组级初稿只出稿，插进编辑面由调用方决定（未保存，保存才落库）。
import { api } from './api.js';
import { el, toast, durText } from './ui.js';
import { limits } from './state.js';
import { recordCustomUndo } from './edit.js';
import { pollJob, POLL, failText, joinedToast } from './aicard.js';
import { panelShell, floatEnter, floatLeave, floatClose } from './float.js';

let card = null;      // 场次草稿卡
let pd = null;        // 组级初稿小卡

// 场次草稿卡会话态（F4-W37：原 _sceneId/_onApplied/_prescript/_jobId/_lastScript/_stage 六键挂 DOM expando）
const D = { body: null, sceneId: null, onApplied: null, prescript: '', jobId: null, lastScript: '', stage: null };

// 重绘/换场前收起（scene.js paintScene 调用）：同层（'draft'）全量闭合（L6 注册表）
export function closeDraftCards() {
  floatClose('draft');
}

// 场次草稿卡：关闭 = 收起（下一次打开回到表单；轮询经 alive 自行退场）
function closeScene() {
  if (card) card.hidden = true;
  floatLeave('draft', closeScene);
}

// ── 场次草稿卡 ──────────────────────────────────────────────

export function openSceneDraft(sceneId, onApplied, prescript) {
  if (!card) buildCard();
  floatEnter('draft', closeScene);   // 互斥：场次草稿 ↔ 组级初稿（开新关旧，L6）
  card.hidden = false;
  D.sceneId = sceneId;
  D.onApplied = onApplied;
  D.prescript = prescript || '';
  D.jobId = null;
  showForm();
}

function buildCard() {
  const sh = panelShell({ id: 'draft-card', title: '✦ 从台本出草稿', onClose: closeDraftCards });
  card = sh.card;
  card.hidden = true;
  D.body = sh.body;
  document.body.appendChild(card);
}

function showForm() {
  const b = D.body;
  b.textContent = '';
  b.appendChild(el('div', 'form-sec-t', '把这一场的台本段贴进来（几百字～两千字）。生成的是初稿——结构对、细节你来过手；只新增、不覆盖，落入后一步可撤。'));
  const ta = document.createElement('textarea');
  ta.className = 'form-input form-area dz-script';
  ta.placeholder = '例：\n内景 旧公寓客厅 深夜\n男人坐在沙发上反复解锁手机……';
  ta.spellcheck = false;
  if (D.lastScript) ta.value = D.lastScript;
  else if (D.prescript) ta.value = D.prescript;
  b.appendChild(ta);
  const bar = el('div', 'form-bar');
  const go = el('button', 'tool-btn small dz-violet', '生成草稿');
  go.addEventListener('click', () => startRun(ta.value));
  const cancel = el('button', 'tool-btn small', '取消');
  cancel.addEventListener('click', closeDraftCards);
  bar.appendChild(go);
  bar.appendChild(cancel);
  b.appendChild(bar);
}

async function startRun(script) {
  const t = (script || '').trim();
  const lim = limits();                                // S3-P6②：限额随 meta（服务端单源）
  const lo = lim.script_min || 0;
  const hi = lim.script_max || 0;
  if (t.length < lo) {
    toast('台本太短——至少贴 ' + lo + ' 字', 'err');
    return;
  }
  if (hi && t.length > hi) {
    toast('台本太长——上限 ' + hi + ' 字', 'err');
    return;
  }
  D.lastScript = script;
  try {
    const res = await api.draft(D.sceneId, script);
    D.jobId = res.job.id;
    if (res.job.joined) joinedToast('draft');   // F4-W20：文案单点
    showRun();
    pollScene();
  } catch (err) {
    toast('启动失败：' + err.message, 'err');
  }
}

function showRun() {
  const b = D.body;
  b.textContent = '';
  b.appendChild(el('div', 'form-sec-t', '两段生成中：① 节拍骨架 → ② 镜头行。约 20～60 秒，请稍候……'));
  D.stage = el('div', 'dz-stage', '① 分析节拍骨架…');
  b.appendChild(D.stage);
}

function pollScene() {
  const jid = D.jobId;
  pollJob(() => api.draftJob(jid).then((x) => x.job), {
    interval: POLL.slow, tolerant: true,   // F4-W26：节奏单点
    alive: () => !card.hidden && D.jobId === jid,
    onTick: (j) => {
      D.stage.textContent = j.stage === 'shots'
        ? ('② 出镜头行…（骨架 ' + (j.beats_n != null ? j.beats_n : (j.beats || []).length) + ' 拍已就绪）')
        : '① 分析节拍骨架…';
    },
  }).then((r) => {
    if (r.st === 'abort') return;
    if (r.st === 'done') {
      if (r.job.error) { toast('生成失败：' + r.job.error, 'err'); showForm(); return; }
      showPreview(r.job);
      return;
    }
    toast(failText(r, POLL.slow), 'err');   // F4-P8：终态文案单点（原 err 态静默）
    showForm();
  });
}

function showPreview(j) {
  const b = D.body;
  b.textContent = '';
  const dropped = j.dropped ? '（另有 ' + j.dropped + ' 条未通过校验，已忽略）' : '';   // S3-W16
  b.appendChild(el('div', 'form-sec-t', countText(j.beats.length, j.shots.length) + dropped + '（初稿——落入后每行可改）。'));
  const list = el('div', 'dz-list');
  const byBeat = new Map();                       // F4-W34：一次分桶（原每拍 j.shots.filter 一趟 O(beats×shots)）
  for (const s of j.shots) {
    const arr = byBeat.get(s.beat) || [];
    arr.push(s);
    byBeat.set(s.beat, arr);
  }
  for (let i = 0; i < j.beats.length; i++) {
    const bt = j.beats[i];
    const bh = el('div', 'dz-beat');
    bh.appendChild(el('span', 'dz-bno', String(i + 1)));
    bh.appendChild(el('span', 'dz-bname', bt.name));
    bh.appendChild(el('span', 'dz-bkind', bt.kind));
    list.appendChild(bh);
    const sum = [bt.outside_action, bt.reaction, bt.closed_loop].filter(Boolean).join(' ／ ');
    if (sum) list.appendChild(el('div', 'dz-bsum', sum));
    for (const s of (byBeat.get(i + 1) || [])) {
      const row = el('div', 'dz-shot');
      row.appendChild(el('b', null, [s.camera_move, s.camera_pos].filter(Boolean).join(' · ') || '—'));
      row.appendChild(el('span', null, s.blocking));
      if (s.dialogue) row.appendChild(el('span', 'dz-dim', '「' + s.dialogue + '」'));
      if (s.duration) row.appendChild(el('span', 'dz-dim', durText(s.duration)));   // F4-B6/W45：时长显示走单点（原 +'s' 会拼出 2ss）
      list.appendChild(row);
    }
  }
  b.appendChild(list);
  const bar = el('div', 'form-bar');
  const ok = el('button', 'tool-btn small dz-violet', '落入草稿（' + countText(j.beats.length, j.shots.length) + '）');
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      const res = await api.draftApply(D.jobId);
      recordCustomUndo('AI 草稿落入', async () => {          // F4-W36：统一 catch + toast（原份无 catch＝unhandled rejection）
        await api.del({ table: 'shots', ids: res.shot_ids });
        if (res.beat_ids && res.beat_ids.length) await api.del({ table: 'beats', ids: res.beat_ids });   // 一次批删，不再 N+1（批4/D 尾）
      });
      toast('已落入：' + countText(res.applied.beats, res.applied.shots) + '（Ctrl+Z 可撤）');
      const cb = D.onApplied;
      closeDraftCards();
      if (cb) await cb();
    } catch (err) {
      toast('落入失败：' + err.message, 'err');
      ok.disabled = false;
    }
  });
  const again = el('button', 'tool-btn small', '重来');
  again.addEventListener('click', () => startRun(D.lastScript));
  const cancel = el('button', 'tool-btn small', '取消');
  cancel.addEventListener('click', closeDraftCards);
  bar.appendChild(ok);
  bar.appendChild(again);
  bar.appendChild(cancel);
  b.appendChild(bar);
}

// 「拍 × 镜」计数文案单点（F4-W35）：预览头与落入钮同一格式（原两种格式）
function countText(beats, shots) {
  return '共 ' + beats + ' 拍 · ' + shots + ' 镜';
}

// ── 组级初稿小卡 ────────────────────────────────────────────

export function openPromptDraft(opts) {
  let self = null;                // 本卡实例：轮询只认它
  let seq = 0;                    // 本轮轮询口令：换轮/关闭即作废（旧闭包只许碰本实例）
  const stop = () => { seq++; };
  const close = () => {
    stop();
    if (self) self.remove();
    if (pd === self) pd = null;
    floatLeave('draft', close);
  };
  const sh = panelShell({ id: 'pdraft-card', title: '✦ 组级初稿', onClose: close });
  self = sh.card;
  floatEnter('draft', close);     // 互斥：场次草稿 ↔ 组级初稿（开新关旧，L6）
  pd = self;
  const body = sh.body;
  const stage = el('div', 'dz-stage', '生成中……约 10～30 秒');
  body.appendChild(stage);
  document.body.appendChild(self);

  const renderText = (text) => {
    body.textContent = '';
    body.appendChild(el('pre', 'dz-draft-text', text));
    const bar = el('div', 'form-bar');
    const ins = el('button', 'tool-btn small dz-violet', '插入编辑面（未保存）');
    ins.title = '替换当前编辑面内容；保存后才落库——编辑面内 Ctrl+Z 可撤';
    ins.addEventListener('click', () => {
      opts.onInsert(text);
      close();
    });
    const again = el('button', 'tool-btn small', '再来一版');
    again.addEventListener('click', () => {
      body.textContent = '';
      stage.textContent = '生成中……约 10～30 秒';
      body.appendChild(stage);
      run();
    });
    const cancel = el('button', 'tool-btn small', '丢弃');
    cancel.addEventListener('click', close);
    bar.appendChild(ins);
    bar.appendChild(again);
    bar.appendChild(cancel);
    body.appendChild(bar);
  };

  const run = async () => {
    const my = ++seq;                             // 本轮口令：旧轮作废
    try {
      const res = await api.draftPrompt(opts.sceneId, opts.shotId);
      if (pd !== self || seq !== my) return;      // 卡已被替换/关闭：本轮作废
      const jid = res.job.id;
      if (res.job.joined) joinedToast('pdraft');   // F4-W20：文案单点
      const r = await pollJob(() => api.draftJob(jid).then((x) => x.job), {
        interval: POLL.slow, tolerant: true,   // F4-W26：节奏单点
        alive: () => pd === self && seq === my,
      });
      if (r.st === 'abort') return;
      if (r.st !== 'done') { stage.textContent = failText(r, POLL.slow); return; }   // F4-P8：终态文案单点
      if (r.job.error) { stage.textContent = '生成失败：' + r.job.error; return; }
      renderText(r.job.text);
    } catch (err) {
      if (pd === self && seq === my) stage.textContent = '启动失败：' + err.message;
    }
  };
  run();
}
