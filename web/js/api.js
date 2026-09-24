// F5-P6②：请求层单点（get/post 共用同一 ok 检查与错误解析）
async function req(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = String(res.status);
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

function get(path) { return req(path); }

function post(path, payload) {
  return req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export const api = {
  meta: () => get('/api/meta'),
  film: () => get('/api/film'),
  scene: (no) => get('/api/scenes/' + encodeURIComponent(no)),
  update: (table, id, field, value) => post('/api/update', { table: table, id: id, field: field, value: value }),
  renumber: (no) => post('/api/scenes/' + encodeURIComponent(no) + '/renumber', {}),
  move: (table, id, payload) => post('/api/move', Object.assign({ table: table, id: id }, payload || {})),
  moveMany: (table, ids, payload) => post('/api/move', Object.assign({ table: table, ids: ids }, payload || {})),
  batch: (ops) => post('/api/batch', { ops: ops }),
  duplicate: (table, id) => post('/api/duplicate', { table: table, id: id }),
  del: (payload) => post('/api/delete', payload),
  create: (payload) => post('/api/create', payload),
  restore: (payload) => post('/api/restore', payload),
  lock: (id, lock) => post('/api/lock', { id: id, lock: lock }),
  blocks: () => get('/api/blocks'),
  blockOp: (payload) => post('/api/blocks', payload),
  promptOp: (action, payload) => post('/api/prompt/' + action, payload || {}),
  history: (sceneId, limit) => get('/api/history?scene_id=' + sceneId + '&limit=' + (limit || 100)),
  audit: (sceneId) => get('/api/audit?scene_id=' + sceneId),
  auditSummary: () => get('/api/audit/summary'),
  auditRun: (sceneId) => post('/api/audit/run', { scene_id: sceneId }),
  auditIssue: (payload) => post('/api/audit/issue', payload),
  auditRules: (payload) => post('/api/audit/rules', payload),
  auditRulesGet: () => get('/api/audit/rules'),
  aiSettings: () => get('/api/ai/settings'),
  aiSave: (payload) => post('/api/ai/settings', payload),
  aiTest: () => post('/api/ai/test', {}),
  aiPreview: (payload) => post('/api/ai/preview', payload),
  aiJob: (id) => get('/api/ai/job?id=' + id),
  aiApply: (jobId, itemIds) => post('/api/ai/apply', { job_id: jobId, item_ids: itemIds }),
  recipes: () => get('/api/recipes'),
  recipeGet: (name) => get('/api/recipes/get?name=' + encodeURIComponent(name)),
  recipeSave: (name, content) => post('/api/recipes/save', { name: name, content: content }),
  recipeDefault: (name) => post('/api/recipes/default', { name: name }),
  draft: (sceneId, script) => post('/api/ai/draft', { scene_id: sceneId, script: script }),
  draftPrompt: (sceneId, shotId) => post('/api/ai/draft/prompt', { scene_id: sceneId, shot_id: shotId }),
  draftJob: (id) => get('/api/ai/draft/job?id=' + id),
  draftApply: (jobId) => post('/api/ai/draft/apply', { job_id: jobId }),
};

// 导出单点（F1-P7）：href 模板与下载触发（场务菜单 / 命令面板共用）
export function exportUrl(no, fmt) {
  return '/api/export?scene=' + encodeURIComponent(no) + '&format=' + fmt;
}

export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
