// 草稿档（M4b-4）：从台本出草稿（空场专用）+ 组级提示词初稿。
// 口径：生成走后台任务轮询；预览零写入——「落入」才落库（一步撤销走全局栈）；
// 组级初稿只出稿，插进编辑面由调用方决定（未保存，保存才落库）。
import { api } from './api.js';
import { el, toast } from './ui.js';
import { recordUndo } from './edit.js';

let card = null;      // 场次草稿卡
let pd = null;        // 组级初稿小卡

export function closeDraftCards() {
  if (card) {
    if (card._timer) { clearInterval(card._timer); card._timer = null; }
    card.hidden = true;
  }
  if (pd) {
    if (pd._timer) { clearInterval(pd._timer); pd._timer = null; }
    pd.remove();
    pd = null;
  }
}

// ── 场次草稿卡 ──────────────────────────────────────────────

export function openSceneDraft(sceneId, onApplied) {
  if (!card) buildCard();
  card.hidden = false;
  card._sceneId = sceneId;
  card._onApplied = onApplied;
  card._jobId = null;
  showForm();
}

function buildCard() {
  card = el('div', 'float-card');
  card.id = 'draft-card';
  card.hidden = true;
  const head = el('div', 'sc-head');
  head.appendChild(el('b', null, '✦ 从台本出草稿'));
  const x = el('button', 'tool-btn small', '✕');
  x.addEventListener('click', closeDraftCards);
  head.appendChild(x);
  card.appendChild(head);
  card._body = el('div', 'sc-body');
  card.appendChild(card._body);
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
  if (card._timer) clearInterval(card._timer);
  card._ticks = 0;
  card._timer = setInterval(async () => {
    if (!card._jobId) return;
    if (++card._ticks > 420) {                  // 上限 ~8 分钟：死任务不许无限轮询
      clearInterval(card._timer);
      card._timer = null;
      toast('任务超时——请重来', 'err');
      showForm();
      return;
    }
    let j;
    try {
      j = (await api.draftJob(card._jobId)).job;
    } catch (err) {
      return;                                   // 网络抖动：下轮再试
    }
    if (!j) {
      clearInterval(card._timer);
      card._timer = null;
      toast('任务丢失（服务重启？）——请重来', 'err');
      showForm();
      return;
    }
    if (j.running) {
      card._stage.textContent = j.stage === 'shots'
        ? ('② 出镜头行…（骨架 ' + (j.beats_n != null ? j.beats_n : (j.beats || []).length) + ' 拍已就绪）')
        : '① 分析节拍骨架…';
      return;
    }
    clearInterval(card._timer);
    card._timer = null;
    if (j.error) {
      toast('生成失败：' + j.error, 'err');
      showForm();
      return;
    }
    showPreview(j);
  }, 1200);
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
  if (pd) {                       // 换卡：旧卡计时器先停（旧闭包只许碰本实例）
    if (pd._timer) { clearInterval(pd._timer); pd._timer = null; }
    pd.remove();
    pd = null;
  }
  pd = el('div', 'float-card');
  const self = pd;                // 本卡实例：轮询只认它
  pd.id = 'pdraft-card';
  let stop = () => {};            // 本轮的停表函数（run() 装载）
  const close = () => {
    stop();
    self.remove();
    if (pd === self) pd = null;
  };
  const head = el('div', 'sc-head');
  head.appendChild(el('b', null, '✦ 组级初稿'));
  const x = el('button', 'tool-btn small', '✕');
  x.addEventListener('click', close);
  head.appendChild(x);
  pd.appendChild(head);
  const body = el('div', 'sc-body');
  const stage = el('div', 'dz-stage', '生成中……约 10～30 秒');
  body.appendChild(stage);
  pd.appendChild(body);
  document.body.appendChild(pd);

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
    try {
      const res = await api.draftPrompt(opts.sceneId, opts.shotId);
      if (pd !== self) return;                    // 卡已被替换/关闭：本轮作废
      const jid = res.job.id;
      if (res.job.joined) toast('这个镜头的初稿正在生成——已并入');
      stop();
      let ticks = 0;
      stop = () => {
        if (self._timer) { clearInterval(self._timer); self._timer = null; }
      };
      self._timer = setInterval(async () => {
        if (pd !== self) { stop(); return; }      // 本卡已谢幕：旧计时器自行退场
        if (++ticks > 420) { stop(); stage.textContent = '任务超时——请重试'; return; }
        let j;
        try {
          j = (await api.draftJob(jid)).job;
        } catch (err) {
          return;                                 // 网络抖动：下轮再试
        }
        if (!j) { stop(); stage.textContent = '任务丢失（服务重启？）——请重试'; return; }
        if (j.running) return;
        stop();
        if (j.error) {
          stage.textContent = '生成失败：' + j.error;
          return;
        }
        renderText(j.text);
      }, 1200);
    } catch (err) {
      stage.textContent = '启动失败：' + err.message;
    }
  };
  run();
}
