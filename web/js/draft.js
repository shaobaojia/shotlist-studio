// 草稿档（M4b-4）：从台本出草稿（空场专用）+ 组级提示词初稿。
// 口径：生成走后台任务轮询；预览零写入——「落入」才落库（一步撤销走全局栈）；
// 组级初稿只出稿，插进编辑面由调用方决定（未保存，保存才落库）。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { recordUndo } from './edit.js';
import { pollJob } from './aicard.js';
import { panelShell, floatEnter, floatLeave, floatClose } from './float.js';

let card = null;      // 场次草稿卡
let pd = null;        // 组级初稿小卡

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

export function openSceneDraft(sceneId, onApplied) {
  if (!card) buildCard();
  floatEnter('draft', closeScene);   // 互斥：场次草稿 ↔ 组级初稿（开新关旧，L6）
  card.hidden = false;
  card._sceneId = sceneId;
  card._onApplied = onApplied;
  card._jobId = null;
  showForm();
}

function buildCard() {
  const sh = panelShell({ id: 'draft-card', title: '✦ 从台本出草稿', onClose: closeDraftCards });
  card = sh.card;
  card.hidden = true;
  card._body = sh.body;
  document.body.appendChild(card);
}

function showForm() {
  const b = card._body;
  b.textContent = '';
  b.appendChild(el('div', 'as-sec-t', '把这一场的台本段贴进来（几百字～两千字）。生成的是初稿——结构对、细节你来过手；只新增、不覆盖，落入后一步可撤。'));
  const ta = document.createElement('textarea');
  ta.className = 'as-input as-area dz-script';
  ta.placeholder = '例：\n内景 旧公寓客厅 深夜\n男人坐在沙发上反复解锁手机……';
  ta.spellcheck = false;
  if (card._lastScript) ta.value = card._lastScript;
  b.appendChild(ta);
  const bar = el('div', 'as-bar');
  const go = el('button', 'tool-btn small dz-violet', '生成草稿');
  go.addEventListener('click', () => startRun(ta.value));
  const cancel = el('button', 'tool-btn small', '取消');
  cancel.addEventListener('click', closeDraftCards);
  bar.appendChild(go);
  bar.appendChild(cancel);
  b.appendChild(bar);
}

async function startRun(script) {
  if (!script || script.trim().length < 30) {
    toast('台本太短——至少贴 30 字', 'err');
    return;
  }
  card._lastScript = script;
  try {
    const res = await api.draft(card._sceneId, script);
    card._jobId = res.job.id;
    if (res.job.joined) toast('本场已有草稿任务在跑——已并入');
    showRun();
    pollScene();
  } catch (err) {
    toast('启动失败：' + err.message, 'err');
  }
}

function showRun() {
  const b = card._body;
  b.textContent = '';
  b.appendChild(el('div', 'as-sec-t', '两段生成中：① 节拍骨架 → ② 镜头行。约 20～60 秒，请稍候……'));
  card._stage = el('div', 'dz-stage', '① 分析节拍骨架…');
  b.appendChild(card._stage);
}

function pollScene() {
  const jid = card._jobId;
  pollJob(() => api.draftJob(jid).then((x) => x.job), {
    interval: 1200, limit: 420, tolerant: true,   // 网络抖动：下轮再试
    alive: () => !card.hidden && card._jobId === jid,
    onTick: (j) => {
      card._stage.textContent = j.stage === 'shots'
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
    if (r.st === 'gone') { toast('任务丢失（服务重启？）——请重来', 'err'); showForm(); return; }
    if (r.st === 'timeout') { toast('任务超时——请重来', 'err'); showForm(); return; }
  });
}

function showPreview(j) {
  const b = card._body;
  b.textContent = '';
  b.appendChild(el('div', 'as-sec-t', '共 ' + j.beats.length + ' 拍 · ' + j.shots.length + ' 镜（初稿——落入后每行可改）。'));
  const list = el('div', 'dz-list');
  for (let i = 0; i < j.beats.length; i++) {
    const bt = j.beats[i];
    const bh = el('div', 'dz-beat');
    bh.appendChild(el('span', 'dz-bno', String(i + 1)));
    bh.appendChild(el('span', 'dz-bname', bt.name));
    bh.appendChild(el('span', 'dz-bkind', bt.kind));
    list.appendChild(bh);
    const sum = [bt.outside_action, bt.reaction, bt.closed_loop].filter(Boolean).join(' ／ ');
    if (sum) list.appendChild(el('div', 'dz-bsum', sum));
    for (const s of j.shots.filter((x) => x.beat === i + 1)) {
      const row = el('div', 'dz-shot');
      row.appendChild(el('b', null, [s.camera_move, s.camera_pos].filter(Boolean).join(' · ') || '—'));
      row.appendChild(el('span', null, s.blocking));
      if (s.dialogue) row.appendChild(el('span', 'dz-dim', '「' + s.dialogue + '」'));
      if (s.duration) row.appendChild(el('span', 'dz-dim', s.duration + 's'));
      list.appendChild(row);
    }
  }
  b.appendChild(list);
  const bar = el('div', 'as-bar');
  const ok = el('button', 'tool-btn small dz-violet', '落入草稿（' + j.beats.length + ' 拍 / ' + j.shots.length + ' 镜）');
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      const res = await api.draftApply(card._jobId);
      recordUndo({
        type: 'custom', label: 'AI 草稿落入',
        undo: async () => {
          await api.del({ table: 'shots', ids: res.shot_ids });
          if (res.beat_ids && res.beat_ids.length) await api.del({ table: 'beats', ids: res.beat_ids });   // 一次批删，不再 N+1（批4/D 尾）
        },
      });
      toast('已落入：' + res.applied.beats + ' 拍 / ' + res.applied.shots + ' 镜（Ctrl+Z 可撤）');
      const cb = card._onApplied;
      closeDraftCards();
      if (cb) await cb();
    } catch (err) {
      toast('落入失败：' + err.message, 'err');
      ok.disabled = false;
    }
  });
  const again = el('button', 'tool-btn small', '重来');
  again.addEventListener('click', () => startRun(card._lastScript));
  const cancel = el('button', 'tool-btn small', '取消');
  cancel.addEventListener('click', closeDraftCards);
  bar.appendChild(ok);
  bar.appendChild(again);
  bar.appendChild(cancel);
  b.appendChild(bar);
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
    const bar = el('div', 'as-bar');
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
      if (res.job.joined) toast('这个镜头的初稿正在生成——已并入');
      const r = await pollJob(() => api.draftJob(jid).then((x) => x.job), {
        interval: 1200, limit: 420, tolerant: true,
        alive: () => pd === self && seq === my,
      });
      if (r.st === 'abort') return;
      if (r.st === 'timeout') { stage.textContent = '任务超时——请重试'; return; }
      if (r.st === 'gone') { stage.textContent = '任务丢失（服务重启？）——请重试'; return; }
      if (r.job.error) { stage.textContent = '生成失败：' + r.job.error; return; }
      renderText(r.job.text);
    } catch (err) {
      if (pd === self && seq === my) stage.textContent = '启动失败：' + err.message;
    }
  };
  run();
}
