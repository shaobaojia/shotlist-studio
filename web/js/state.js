export const state = { film: null, scenes: [], meta: null };

// 表 → 字段清单（F1-P5 单点）：未知表名回落空表
const FIELD_TABLES = { shots: 'shot_fields', beats: 'beat_fields', scenes: 'scene_fields' };
export function fieldsOf(table) {
  const m = state.meta || {};
  return m[FIELD_TABLES[table]] || [];
}

// 字段查找单点（批4/D 尾）：各模块统一走这里，勿再手写 state.meta.*_fields.find(...)
export function fieldOf(key, table) {
  return fieldsOf(table || 'shots').find((x) => x.key === key) || null;
}

// 提示词组映射单点（F1-P7）：id → group（scene 注入 / 各表缺省各拿一份）
export function groupsById(data) {
  const m = {};
  for (const g of (data && data.prompt_groups) || []) m[g.id] = g;
  return m;
}
