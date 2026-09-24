// 块库（M3）：积木块数据缓存与操作族（块库卡 / 拼装台 / 菜单共用）。
// 关键口径「插入即固化」：插入的是文字副本，之后改库不影响已写入的提示词。
import { api } from './api.js';
import { toast, silent } from './ui.js';
import { openMenu } from './menu.js';
import { recordUndo } from './edit.js';

// 占位符词汇单点（F3-W7）：拼装台代入表（hotbox.js substitute）的键由此派生；新增占位符先入此表
export const PLACEHOLDERS = ['镜号', '景别', '焦段', '运镜', '机位', '时长', '台词', '音频', '场景'];

// 位置序单点（分类 / 块 / 组通用）：先 position 后 id
export function byPosition(a, b) {
  return (a.position || 0) - (b.position || 0) || a.id - b.id;
}

let cache = null;              // { categories:[], blocks:[] }
const listeners = [];
let inflight = null;           // 载入中的请求（并发去重）
let needRefresh = false;       // 上笔写后重取失败（F3-B3）：显示留旧，下次读取补拉
let cacheGen = 0;              // 写世代（F3-L4）：写响应就地套用 +1；在途旧快照落地时对不上即弃

export async function ensureBlocks(force) {
  if (inflight) {
    if (!force) return inflight;                    // 非 force：复用同一在途请求（并发去重）
    await inflight.catch(() => {});                 // force（F3-B4）：先等在途落地——绝不复用可能早于本次写的快照
    if (inflight) return inflight;                  // 等待期间被并行调用续上了新请求：直接复用它
  }
  if (cache && !force && !needRefresh) return cache;
  const gen = cacheGen;
  inflight = api.blocks().then((res) => {
    if (gen === cacheGen) {                          // F3-L4：期间发生过写（gen 变）→ 本快照早于写，丢弃
      cache = { categories: res.categories || [], blocks: res.blocks || [] };
      needRefresh = false;
    }
    return cache;
  }).finally(() => { inflight = null; });
  return inflight;
}

export function blocksData() { return cache; }

export function catName(catId) {
  const c = catOf(catId);
  return c ? c.name : '未分类';
}

// 分类对象单点（F3-P6①）：id → 分类对象（未分类 / 悬空 id → null）
export function catOf(catId) {
  if (catId == null) return null;
  return (cache ? cache.categories : []).find((x) => x.id === catId) || null;
}

// 分类色单点（F3-P4③/W17）：调色板按分类序取色；未分类＝中性色；悬空 id＝末位色；缓存换代即重建 Map
const PALETTE = ['#b8563e', '#c08a2e', '#7a8b3f', '#4e7f6a', '#5d7fa3', '#8a6aa8', '#a05f74', '#8b6b4a'];
export const UNCAT_COLOR = '#9a9182';
let colorMap = null;
let colorSrc = null;
export function catColorOf(cid) {
  if (cid == null) return UNCAT_COLOR;
  if (!cache) return PALETTE[PALETTE.length - 1];
  if (colorSrc !== cache) {
    colorSrc = cache;
    colorMap = new Map();
    cache.categories.forEach((c, i) => colorMap.set(c.id, PALETTE[i % PALETTE.length]));
  }
  return colorMap.get(cid) || PALETTE[PALETTE.length - 1];
}

// 搜索口径单点（正文 + 分类名；管理器 / 热盒条共用）；
// haystack 记忆（F3-W18）：块对象每次取数换代，WeakMap 随旧对象自然回收
const HAY = new WeakMap();
export function blockMatch(b2, q) {
  if (!q) return true;
  let h = HAY.get(b2);
  if (h == null) {
    h = (String(b2.text) + ' ' + catName(b2.category_id)).toLowerCase();
    HAY.set(b2, h);
  }
  return h.indexOf(q) !== -1;
}

// ── 块移动（管理器 / 热盒条共用）：换类 + 定位 → 后端 position 支持 ──
export function siblingList(catId) {
  const d = blocksData() || { blocks: [] };
  const list = d.blocks.filter((b) => (catId == null ? b.category_id == null : b.category_id === catId));
  list.sort(byPosition);
  return list;
}

// 直写 + 撤销负载取自本地快照（单端足够；不做「按旧缓存判原地」的前置短路——缓存可能过期）
export async function moveBlockTo(target, catId, idx) {
  const b = findBlock(target.id) || target;
  const oldCid = b.category_id;
  const oldPos = b.position || 0;
  const oldPin = b.pinned ? 1 : 0;                 // F3-L2：置顶块拖落普通段＝服务端自动取消置顶——撤销一并还原标记
  const res = await blockOpToast({ action: 'update', id: b.id, category_id: catId, position: idx }, '移动');
  if (!res) return;
  toast('已移到「' + (catId == null ? '未分类' : catName(catId)) + '」（Ctrl+Z 可撤）');
  blockUndo('块移动', () => ({ action: 'update', id: b.id, category_id: oldCid, position: oldPos, pinned: oldPin }));
}

// ── 块写操作族（管理器 / 热盒条共用；撤销与提示一处定义） ──
export async function togglePin(b2) {
  const next = !b2.pinned;
  const oldCid = b2.category_id;
  const oldPos = b2.position || 0;
  const res = await blockOpToast({ action: 'pin', id: b2.id, pinned: next }, next ? '置顶' : '取消置顶');
  if (!res) return;
  toast(next ? '已置顶（Ctrl+Z 可撤）' : '已取消置顶（Ctrl+Z 可撤）');
  // 撤销＝标记 + 位置一并还原（F3-L2：置顶会拨位到置顶段尾；复合负载避免重放二次拨位）
  blockUndo(next ? '置顶' : '取消置顶',
    () => ({ action: 'update', id: b2.id, category_id: oldCid, position: oldPos, pinned: next ? 0 : 1 }));
}

export async function deleteBlockWithUndo(b2, onAfter) {
  const resDel = await blockOpToast({ action: 'delete', id: b2.id }, '删除');
  if (!resDel) return;
  toast('已删除块（Ctrl+Z 可撤）');
  recordUndo({                       // 撤销＝重建（链式：create→pin→复位），无法单载荷化，保留（F3-W3 例外：仅此一处）
    type: 'custom', label: '删除块',
    undo: async () => {
      const res = await blockOp({ action: 'create', text: b2.text, category_id: b2.category_id });
      if (!res || !res.block) return;
      if (b2.pinned) await blockOp({ action: 'pin', id: res.block.id, pinned: true });
      // 还原原位置（F3-B2）：create 落在分类末尾，补一次定位（服务端按去掉自身后的清单夹取）
      await blockOp({ action: 'update', id: res.block.id, category_id: b2.category_id, position: b2.position == null ? 0 : b2.position });
    },
  });
  if (onAfter) onAfter();
}

// 换分类菜单（选中即走 moveBlockTo，落目标分类末尾；撤销统一为「块移动」）
export function moveMenu(anchor, b2) {
  openMenu(anchor, catMenuItems(b2.category_id), (k) => {
    const cid = k === 'none' ? null : Number(k);
    if (cid === b2.category_id) return;
    moveBlockTo(b2, cid, dropIndex(cid, b2.id, null));
  });
}

// 数据变化订阅；返回退订函数
export function onBlocksChange(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export async function blockOp(payload) {
  const res = await api.blockOp(payload);           // 写成功即事实成立（F3-B3）——重取失败不再把写报成失败
  if (res && res.state) {                           // F3-L4：写响应带全量 state——就地套用（省一次全库 GET，且必然晚于写事务）
    cacheGen += 1;                                  // 在途旧快照作废（gen 对不上即弃）
    cache = { categories: res.state.categories || [], blocks: res.state.blocks || [] };
    needRefresh = false;
  } else {
    try {
      await ensureBlocks(true);
    } catch (err) {
      needRefresh = true;                           // 缓存可能过期：显示留旧不空窗，下次读取补拉
      silent(err, 'blocks-refresh');
      toast('块库刷新失败（显示可能略旧）');
    }
  }
  for (const fn of listeners.slice()) { try { fn(); } catch (e) { silent(e, 'blocks-subscriber'); } }
  return res;
}

// 撤销登记单点（F3-W3）：label + 回放载荷 thunk（id 于撤销时再取）；undo 恒为「重放一个块 op」
export function blockUndo(label, payload) {
  recordUndo({ type: 'custom', label: label, undo: async () => { await blockOp(payload()); } });
}

// 写 + 报错单点（F3-W3）：统一 catch → '<label>失败：…' → null（调用方见 null 即中止后续）
export async function blockOpToast(payload, label) {
  try { return await blockOp(payload); }
  catch (err) { toast(label + '失败：' + err.message, 'err'); return null; }
}

// 展示序（F3-L2 (a) 单源）：分类序 → position 序——置顶的「前置」由服务端 pin 拨位固化进
// position（显示序 ≡ position 序），本地不再叠 pinned 比较键
export function sortedBlocks() {
  const cats = cache ? cache.categories : [];
  const order = {};
  cats.forEach((c, i) => { order[c.id] = i; });
  const arr = (cache ? cache.blocks : []).slice();
  const LAST = Number.MAX_SAFE_INTEGER;               // 殿后哨兵（F3-W5）：悬空分类 id 原先与 id 比较出 NaN
  arr.sort((a, b) => {
    const oa = a.category_id == null || order[a.category_id] == null ? LAST : order[a.category_id];
    const ob = b.category_id == null || order[b.category_id] == null ? LAST : order[b.category_id];
    if (oa !== ob) return oa - ob;
    return byPosition(a, b);
  });
  return arr;
}

export function findBlock(id) {
  return (cache ? cache.blocks : []).find((b) => b.id === id) || null;
}

// 折叠键单点（F3-P6③）：分类 id → 折叠集键（未分类 = 'none'）
export function foldKeyOf(catId) {
  return catId == null ? 'none' : 'c' + catId;
}

// 数据属性键单点（F3-W4）：data-catkey 的写法与读法（未分类 = 'none'）
export function catKeyOf(cid) {
  return cid == null ? 'none' : String(cid);
}

// 换分类菜单条目单点（F3-P6②）：由分类结构派生（currentCid 标当前项）
export function catMenuItems(currentCid) {
  const mark = currentCid !== undefined;   // 未给「当前」＝纯选择菜单（如「存为块」）：不打勾（F3-W2）
  const items = (cache ? cache.categories : []).map((c) => ({ key: String(c.id), label: c.name, current: mark && c.id === currentCid }));
  items.push({ sep: true }, { key: 'none', label: '（未分类）', current: mark && currentCid == null });
  return items;
}

// 可见块单点（F3-P6⑥）：展示序（置顶最前 → 分类序 → 块序）＋筛选（置顶 / 搜索词）
export function visibleBlocks(opts) {
  const o = opts || {};
  let arr = sortedBlocks();
  if (o.pinnedOnly) arr = arr.filter((x) => x.pinned);
  if (o.query) arr = arr.filter((x) => blockMatch(x, o.query));
  return arr;
}

// 分段单点（F3-P6⑤）：展示序 arr → [{key, cat, cid, name, items}]；showEmpty＝含空分类（含「未分类」）
export function sectionsOf(arr, opts) {
  const o = opts || {};
  const d = cache || { categories: [] };
  const buckets = new Map();
  for (const b of arr) {
    const k = catKeyOf(b.category_id);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(b);
  }
  const secs = [];
  for (const c of d.categories) {
    const items = buckets.get(catKeyOf(c.id)) || [];
    if (!items.length && !o.showEmpty) continue;
    secs.push({ key: foldKeyOf(c.id), cat: c, cid: c.id, name: c.name, items: items });
  }
  const none = buckets.get(catKeyOf(null)) || [];
  if (none.length || o.showEmpty) secs.push({ key: 'none', cat: null, cid: null, name: '未分类', items: none });
  return secs;
}

// 落点索引单点（F3-W6④）：去掉拖拽源后的目标清单里，插到 target 前/后（target 缺省或不在列＝末尾）
export function dropIndex(catId, srcId, targetId, below) {
  const list = siblingList(catId).filter((x) => x.id !== srcId);
  if (targetId == null) return list.length;
  const i = list.findIndex((x) => x.id === targetId);
  if (i === -1) return list.length;
  return below ? i + 1 : i;
}

// 「存为块」：把一段文字存进块库（选分类）
export async function storeAsBlock(anchor, text) {
  try {
    await ensureBlocks();
  } catch (err) {
    toast('块库加载失败：' + err.message, 'err');
    return;
  }
  openMenu(anchor, catMenuItems(undefined), async (k) => {   // 与换分类菜单同源（F3-W2）：无「当前项」标记
    const res = await blockOpToast({ action: 'create', text: text, category_id: k === 'none' ? null : Number(k) }, '存块');
    if (!res) return;
    toast('已添加到提示词块' + (k === 'none' ? '' : '（' + catName(Number(k)) + '）') + '· Ctrl+Z 可撤');
    if (res.block) blockUndo('添加块', () => ({ action: 'delete', id: res.block.id }));
  });
}

