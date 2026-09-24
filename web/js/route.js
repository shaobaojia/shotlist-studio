// 路由 hash 单点（F1-P2）：解析 / 场号 / 构造 / 是否本场。
// 全库唯一 hash 解析口径——main / scene / cmdk / film 一律经此，勿再手写 regex 或 decode（F1-B3）。
export function parseHash(h) {
  const s = (h === undefined || h === null) ? (location.hash || '') : String(h);
  const n = s === '' ? '#/' : s;
  try { return decodeURIComponent(n); } catch (e) { return n; }
}

// 场号（无场路由 → null）
export function sceneNo(h) {
  const m = parseHash(h).match(/^#\/(.+)$/);
  return m ? m[1] : null;
}

// 场号 → hash（编码交给浏览器）
export function hashOf(no) {
  return '#/' + String(no);
}

// 当前路由是否指向该场（非 ASCII / 编码形态一律归一比较）
export function isCurrentScene(no) {
  return sceneNo() === no;
}
