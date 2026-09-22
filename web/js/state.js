export const state = { film: null, scenes: [], meta: null };

// 字段查找单点（批4/D 尾）：各模块统一走这里，勿再手写 state.meta.*_fields.find(...)
export function fieldOf(key, table) {
  const m = state.meta || {};
  const list = table === 'beats' ? m.beat_fields : (table === 'scenes' ? m.scene_fields : m.shot_fields);
  return ((list || []).find((x) => x.key === key)) || null;
}
