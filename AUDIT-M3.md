# AUDIT-M3.md — shotlist-studio · M3 子系统审计报告

- **仓库**：`/volume1/主目录/Hermes/read/Projects/shotlist-studio`
- **日期**：2026-09-20 ｜ **审计基线**：`HEAD = 787607a`（工作树干净）
- **范围（M3 子系统，7 文件 / 2460 行）**：
  - 前端拼装台与块库：`web/js/hotbox.js`(613) · `web/js/blocks.js`(392) · `web/js/blockman.js`(450)
  - 后端提示词域：`server/core/prompts.py`(442) · `server/api/prompts.py`(80) · `server/tests/test_prompts.py`(325)
  - 脚本：`scripts/seed_blocks.py`(158)
- **未覆盖**：M1/M2 既有模块（edit / table / scene / ops / db / drag 等）仅作对照引用，未作独立审计；未做浏览器 E2E 回归。
- **方法**：simplify-code「审计模式」——**只报不改**。8 名审查员 ＝ 4 透镜（复用 / 质量 / 效率 / 修的高度）× 2 批（前端 / 后端），判据为注入规则书（clean-code.mini / refactoring.mini）；全部结论要求 `file:line` 证据，删除类建议先 `git blame`（Chesterton's Fence）。**聚合前对 15 条关键结论做了一手复核**（内存库跑仓库真代码，输出见文末附录）。
- **结果**：原始 111 条 findings + 18 条 bug → 去重合并后 **15 条真 Bug + 12 条先修 + 约 38 条值得做 + 9 条立项候选 + 小项若干**。

> 本报告不修改任何代码。修复走后续独立批次：点名条目（或批次），按正常改动纪律施工（每步提交 + AGENTS 入账 + 实测）。

---

## 一、真 Bug（15 条，建议先修）

> 标注「**实测**」的条目已在 `:memory:` 库用仓库真代码复现，原始输出见附录 B。

| # | 位置 | 现象 | 修法 | 严重 | 工量 |
|---|---|---|---|---|---|
| B1 | hotbox.js:445-449（+277 早退） | **订阅泄漏**：释放拼装台只置 `collapsed=true`，唯一清订阅的 `collapseBox` 因早退（277）永不执行 → 每次组操作泄漏 1 条块库订阅；闭包钉住整场 data、textarea、≤200 条快照；此后每次块写多跑 N 条死重绘 | `releaseActive` 里补 `st.unsub?.()` 并置 null（3-6 行） | 高 | XS |
| B2 | blocks.js:319-326（chipMenu:291） | 热盒右键「置顶」不记撤销、无成功提示（管理器 pinToggle:415 有）→ Ctrl+Z 撤掉的是更早的无关操作 | 收敛为 blocks.js 导出的 `togglePin`（写 + recordUndo + toast），两门共用 | 中 | XS |
| B3 | blocks.js:305-317 | 热盒右键「换分类」不记撤销、不传 position（与拖拽 `moveBlockTo` 落位不一致）→ 唯一「换完类不可撤」的路径 | 统一走 `moveBlockTo`（菜单只负责选分类） | 中 | S |
| B4 | blockman.js:369-407（同类 334-366、279-294） | 行内编辑写失败**丢用户输入**：草稿行先 `remove()` 再 create，失败只剩一句 toast；editRow / renameCat 失败不还原 | 失败保留行 + 文本 + 焦点，与 hotbox「保存失败留字」口径对齐 | 中 | S |
| B5 | hotbox.js:12 / 445-449 | `activeBox` 悬空：外部刷新（拖镜 / 整理镜号 / 筛选）整片丢 DOM 后仍指向死盒子，下次激活时对陈旧上下文 `saveText` 写库 | 刷新前 release；saveText 加 `isConnected` 守卫 | 中 | S-M |
| B6 | hotbox.js:166-173 | Ctrl+Z 让位链两缺陷：a) custom 条目不自刷新（edit.js:291-296 摄影机撤销后视图过期）；b) 两栈时序错乱（先打字再块操作，撤的是打字） | a) 让位路径无条件 `ctx.refresh()`；b) 见 ◆1 | 中 | S |
| B7 | blocks.js:171 vs 232-238 | 渲染序（置顶优先）与拖放索引（纯 position）不同源 → 有置顶块时拖放指示无法复现（拖完弹回最前） | 渲染序并入 `siblingList`，或置顶块移出拖序 | 中低 | S |
| B8 | core/prompts.py:253 / 260 / 267 | restore 写正文绕过 50000 上限与归一（**实测**：60000 字落库） | 统一过 `_check_group_text`（并入 F8） | 中 | XS |
| B9 | api/prompts.py:29-31 | `bool(body.get("pinned"))`：pin 不给参＝**取消置顶**（危险默认）；blocks_op 各分支缺 id 类型校验 | `pinned` 必须 bool 否则 400；补 id 校验 | 中 | XS |
| B10 | core/prompts.py:256-269 | restore 宽 catch `IntegrityError`（id 撞车与一切约束违规混同）+ 新 id 写回调用方入参 dict | 复用 ops `_insert_restore` 语义（提公开）+ 返回值映射 | 中低 | S |
| B11 | seed_blocks.py:105-107 | `if reset and n:` —— 块空但分类还在时 `--reset` 静默不清库 → 分类重复堆积 | 无条件清（与 n 无关），并入同一事务 | 中 | XS |
| B12 | seed_blocks.py:98-119 | 非原子（逐块 commit：**实测** 32 次 / 67ms vs 单事务 1.1ms）+ 半载入不可续（COUNT 判据）＝残缺库被永久固化；且是全仓唯一不做每日快照的破坏性写（grep：scripts/ 下 0 处调用） | 内容级幂等 + 单事务 + 写上边界快照（F9） | 中 | S |
| B13 | ops.py:34-45 | 每日快照裸拷 live DB（ThreadingHTTPServer 下可能拷到事务半写态）；中断留残缺文件且 `exists()` 守卫永不重试 | 换 SQLite 备份接口写 `.tmp` + `os.replace` 原子落地 | 中 | M |
| B14 | core/prompts.py:56 / 245-270 | 空组孤儿：删掉组唯一成员镜后组留存（**实测** member_shots=[]），前端无入口＝静默丢字；注释「随后会被清」的清理不存在，真清理会打断删镜撤销（FK） | 注释改事实 + `prompt_state` 标 `empty`；语义决定见 ◆4 | 中低 | S |
| B15 | prompts.py:72 / 234 / 314；api:58 / 68 / 73 | 类型口径分裂（**实测**）：`set_group_text(True)` 写进组 1；`cat_update('1')` 通过而 `block_create('x','1')` 拒；`position=0.7` 静默取 0（顺序变） | 统一 `_is_id`（非 bool int）+ position 严格 int + cat 路径统一校验 | 中低 | XS-S |

---

## 二、★ 先修清单（12 条：高价值 / 高严重度 × 可控工作量）

| # | 位置 | 问题 | 修法 | 严重 | 工量 |
|---|---|---|---|---|---|
| F1 | hotbox.js:20-25 | 镜头序知识第 3 份（scene.js:189 已有，且 filter/cellmenu/selection 都走 ctx 注入约定）；循环 concat O(节拍²×镜)；saveAndNext 同链重扫两遍 | scene.js 把 `allShots` 注入 ctx；单趟 push；nextTargetShotId 直接返回目标对象 | 中 | S |
| F2 | blockman.js:64 | 占位符清单缺 `{音频}`，与 hotbox.js:42 / seed_blocks.py:129 三处漂移（用户可见的自相矛盾） | blocks.js 导出唯一清单；管理器文案由它派生 | 中 | XS |
| F3 | blocks.js / blockman.js:223-256 / 415-425 | 块写操作无共享层：换类 ×3、删块 ×2（逐字双胞胎）、置顶 ×2、分类删除无撤销——787607a 的收敛只上了拖拽一条 | 把 `moveBlockTo` 模式推广为操作族（togglePin / deleteBlockWithUndo / moveMenu），两 UI 只调这些 | 中 | S-M |
| F4 | core/prompts.py:331-343 + api/prompts.py:23 | 块域**无写白名单**：未知键静默丢弃（ops 是拒绝）；接口层把整包 body（含 action）转交域层，宽容成为调用点依赖，双方锁死 | ① fields.py 加 BLOCK_FIELDS；② 未知键 raise「字段不可写」；③ api 显式投影；④ 测试补未知键→400 | 高 | S |
| F5 | core/prompts.py:11-15 | `_hist` 是仓库第 **21** 份 history INSERT（ops.py 同语句已内联 20 处） | 上收 `ops.record_history`；ops 20 处同批机械替换 | 中 | M |
| F6 | prompts.py:65-67 / 357-362 / 389-390 / 440-441（+ops 6 处） | 位置重排 kernel 全仓 10 份；`block_move` 与 `block_update` 两条等价实现并行（基准实测 [C,A,B] 两法一致）；且全分类重写（2000 块＝2004 条 UPDATE / 11.7ms） | 抽 `place_in_sequence` 原语 + 窗口重排 / 相邻互换；block_move 委托 block_update | 中 | M |
| F7 | prompts.py:311-316 vs 413-435 | `_check_cat` 未复用（3 处内联），规则与文案 ×4 且已分叉（见 B15） | cat_update / delete / move 统一调 `_check_cat`；文案拆「参数错误 / 不存在」 | 中 | S |
| F8 | prompts.py:93 / 254 / 302 / 399 / 412 | 文本校验三家分写（50000 / 20000 / 无）+ 上限魔数 6 处（写进文案） | `_check_str(value, label, max)` + 模块常量；restore 同过 | 中 | S |
| F9 | api/prompts.py:17 / 53 + handlers.py ×9 | 快照保护装在**调用点**（11 处复制）→ seed 等脚本写者继承不到；下一个写者（M4 AI 路径）必漏 | `db.connect(rw=True)` 内触发，删 11 处调用点；`db.write()` 上下文见 ◆3 | 中 | S |
| F10 | blocks.js:63-66 / hotbox.js:451-476 | 写后全量重拉：serve.log 88 次 POST 有 77 次紧跟全量 GET；组操作后整场 refetch + 全表重建（20/46）——而写响应已带 block/groups，前端也已有 applyGroups / updatePromptCell / refreshBoxesForGroup 三件套 | 用写响应就地更新、局部重绘；缺 groups 才回退全量 | 中 | M |
| F11 | test_prompts.py | 覆盖缺口：restore id 回退分支（AGENTS 坑条同源）、未知键契约、block_move 边界、删镜不剪组、position 致密性均无；api 层零覆盖 | 补 4 条用例；断言改 ORDER BY 查询（去掉裸取 `[0]`） | 中 | S |
| F12 | prompts.py:18-25 / 44-52（+db.py:51-58） | 场景查询 3 份实现且排序口径分叉（`position` vs `position,id`）；prompt_state 镜→组归属与 handlers.scene 又一份 | 改用 db 层（补 `,id` 兜底排序）+ 归属分桶下沉共享 | 中 | M |

---

## 三、☆ 值得做（约 38 条）

### 前端 · 结构收敛（消重 / 边界）

| 位置 | 问题 | 修法 | 工量 |
|---|---|---|---|
| blocks.js:28-33/83 + blockman.js:65/124 + hotbox.js:500-501 | 排序比较器 ×5 份（同位按 id 的口径散落） | 导出 `byPosition` 单点；blockman render、hotbox prevGroupOf 一并换 | XS |
| blockman.js:271-407 | 行内提交协议 ×4（done 幂等闸 + Enter/Esc/blur 各写一遍，且已分叉：input 裸 Enter vs textarea Ctrl+Enter、无失败回滚） | 抽 `inlineCommit(el, {multiline, onCommit})` 收拢 | S-M |
| blockman.js:40/66 vs blocks.js:111/175 | 搜索归一化 / haystack 口径两份（管理器不看分类名，热盒条看 → 同词两结果） | `blockMatch(b, q)` 共享，口径一次定义 | XS |
| hotbox.js:236-253 | 复制 / 剪切自编 `execCommand`，未走 clipboard.js `writeClipboard`（含「局域网 http」前提与兜底） | 改用共享工具；剪切＝写成功后再删 + hbPush 保撤销栈语义 | S |
| blocks.js:387-392 | `backToEditor` 反向摸 hotbox 私有 DOM（`.hotbox-editor` + offsetParent 猜可见性） | buildShelf opts 注入 `restoreFocus` 回调，删选择器 | S |
| hotbox.js:610-613 vs edit.js:163-167 | textarea 自增长两份（130 下限无出处）；且每次按键强制回流 | `growTextarea` 共享 + rAF 合并 | S |
| hotbox.js:32-33 vs cells.js:54-58 | 时长格式化两份（「3s」规则两条腿） | `durText` 共享 | XS |
| blocks.js:239-246 vs 292-295 | staged 切换两份（Shift＝切换，右键＝只进不出，无法取消） | `toggleStaged` 共享 + 菜单项动态 | XS |
| blocks.js（8 处） | drawCats/drawChips/drawStage 手工配对 ×8；开台 drawCats 双跑；doPin/delBlock 显式重绘叠订阅重绘 | `refreshShelf()` 唯一入口 + rAF dirty 合并 | S |
| hotbox.js:137/301/315 | `st.original` 过期基线：编辑面开着时别处改同组 → 保存短路误判「没变」静默跳过 / 过期值进撤销栈 | 现场推导基线（`(g&&g.text)||''`），无组时才留本地 | S |
| blockman.js:148/176/334/369 + 79-88 + 129/136 | 死参数链（sec/cat/afterId 从未被引用）+ pendingFocus 冗余 else + `bm-rows` 双判定 | 一并清（签名即文档） | S |
| blockman.js:58-90 | 搜索每键整面板重建 + O(分类×块) 分桶 | debounce ~120ms + 单趟 Map 分桶（或行级 display 过滤，不重建） | S |
| blockman.js:193-200 / 410-413 | dragover 每次全文档 `querySelectorAll` 清标记（每秒数十次） | 模块级 `markedEl` 记忆（O(1)）；仅 dragend 兜底全清 | S |
| blocks.js:12-17 | ensureBlocks 无 in-flight 去重；force 进行中非 force 调用直出旧缓存 | 模块级 `inflight` promise 复用 | S |
| blocks.js:35-52 | moveBlockTo TOCTOU：按缓存旧值判「原地」并作撤销负载（多端下错位 / 静默 no-op） | 直接写、以服务端返回为准 | S |
| blocks.js:192-196（+hotbox 焦点补偿） | chip 焦点守卫是消费方补丁（tabIndex=-1 + backToEditor，绕「blur+activeElement」收起启发式） | 换「指针点外」判定（menu.js / edit.js 已有两套范式），撤三处补偿 | M |
| hotbox.js:100-263 / blocks.js:184-255 | activateBox 160 行、blockChip 72 行、右键 6 臂链、键处理三层嵌套 | 拆 buildEditorDom / wireEditorEvents / wireChip*；动作查找表 | M |
| hotbox.js:528-591 | hb* 撤销栈（85 行 / 10 函数 / ta.__hb 挂载）与视图、组操作混在一个 613 行模块 | 抽 `hbedit.js`（常量栈深 200 / 分段 600ms 具名） | M |

### 后端 · 域与性能

| 位置 | 问题 | 修法 | 工量 |
|---|---|---|---|
| prompts.py:48-51 | prompt_state O(组×镜) 双层循环（500/500 基准 13.5ms vs 分桶 2.6ms） | defaultdict 分桶（handlers.scene 已示范） | S |
| prompts.py:128 / 142-149 | merge 每源组 2-3 条单行查询（300 组基准 = 1802 语句 / 30ms；同表查两遍） | IN 分组查询 + 内存判空组 | M |
| prompts.py:168 / 178 / 186-187 | detach 三处自写自读（made 不带 nid 回查、left 重查） | made 带 nid；集合差算 left | S |
| prompts.py:249 / 271-274 | restore 三浪费：逐组 SELECT、全场 NULL 再逐镜双写、all_ids 无去重 | 开场集合查询 + 只动未涉及行 | M |
| prompts.py:55-67 | normalize 全场重读（含 50KB 正文）只为 position | 窄列 SELECT（id/position） | S |
| prompts.py:301-316 | 「参数错误」与「不存在」合并成一句（`'z'` →「分类不存在：#z」） | 拆两段文案 | XS |
| prompts.py:336-338 / 368-370 / 378-380 | 块存在性守卫 ×3 | `_load_block` 单点 | XS |
| prompts.py:394-399 / 407-412 | 分类名校验 ×2 逐字重复 | `_check_cat_name` | XS |
| prompts.py:331-364 | block_update 34 行 4 件事 + 一层死过滤（360 行 `x['id']!=block_id` 已无意义） | 抽 `_place_block` | M |
| prompts.py:376-392 / 429-442 | 「已经到头了」抛异常 vs ops 全体 `changed:False` vs update 夹取——同动作三语义 + 口语化文案 | 统一「到头 = moved:False」 | S |
| prompts.py:253-254 / 271-274 | restore 不 bump updated_at（其它写路径全量 bump） | 统一 `_touch` | S |
| seed_blocks.py | 长线：内容级幂等（按正文查重可续）+ settings 记 seed 版本（防 --reset 铲用户编辑） | 见 B11/B12 修完后跟进 | S |
| ops.py:34-45 | 快照无保留策略（~250KB/天 ≈ 90MB/年） | 保留 N 天或旧档 gzip | S |
| prompts.py:294-299 / 322-323 | block_create 全读兄弟取末位 position | `SELECT MAX(position)`（基准 37×）+ 可选索引 | XS |
| prompts.py:78 / 239-240 | IN 占位符 `",".join("?"*n)` 写法易被后人改坏 | 显式 `["?"]*n` + 注释「只拼占位符」 | XS |
| api/prompts.py:57-59 / 67-69 / 72-74 | 参数守卫落在快照 / 连接之后（坏请求先拷整库）+ 文案两份；校验分两层无口径 | 守卫前置；`_int_or_400` 小 helper；「键存在在 API、语义在域层」定口径 | S |
| hotbox.js:478-496 | runPromptOp 四个包装同构（detachOp 是特例） | 合一张 {action, label, focus} 小表 | XS |

### 测试

| 位置 | 问题 | 修法 | 工量 |
|---|---|---|---|
| test_prompts.py:10-26 | 夹具复制 test_ops.py（schema 载入 + 种子两条腿） | `server/tests/_fixture.py` 共享 | S |
| test_prompts.py:96-98 / 125-127 / 136-137 | 断言弱 / 不稳：装饰字符断言、无 ORDER BY 裸取 `[0]`、缺 len 断言 | 指向契约的查询 + 先断条数 | S |
| test_prompts.py（新增） | 无规模用例，性能修法无人守 | 冒烟用例（断言语句数 / 耗时上限） | S |

---

## 四、◆ 立项候选（9 条：涉及设计决定或牵动面大，别混进小批次）

1. **Ctrl+Z 路由上收 + 两栈时序**：main.js 的全局 handler 遇 INPUT/TEXTAREA 直接 return，撤销路由写在被路由方（hotbox）；更深修法＝「编辑面注册 consumeUndo()，统一刷新」，两栈合一要动 edit.js 栈协议与全部 custom 条目（B6 根治）。
2. **restore 并发 / 可再审性**：整场覆盖式撤销依赖客户端内存栈，服务端无版本守卫、不留覆盖前现状。本批可先做：覆盖前留底（schema 已预留 `snapshots.kind='manual'`）+ 响应回带还原前状态 + 同镜两组 400；场景修订号（409）单独立项。
3. **api 层 `rw_endpoint` 收口**：快照 → connect → try/except → close 样板 ×11 + 响应形状统一（有的带实体有的只有 `{ok}`）。
4. **空组语义决定**：草稿组（可见可选）vs 「撤销携带正文后允许剪枝」——两条路都要动 ops 删除路径 + 前端（B14 收尾）。
5. **单镜特例显式化**：本批可先抽 `ensure_group_for_shot`（merge 内部分支委派）；前端「保存即建组」改显式 action 需 E2E。
6. **seed 脚本职责拆分**：SEED 内容 / 写库机制 / 文档渲染三分，`render_md` 改从库生成（清单不再可能与库不一致），占位符词汇单点。
7. **api 层测试脚手架**：patch `db.connect` → `:memory:`，钉「未知 action→400」「pin 缺参→400」等契约。
8. **ops.move_scene / move_beat 收口到位置原语**：跨表「镜头跟随」语义与块域不同，与 F6 分开做。
9. **cat_delete 撤销补齐**：重建分类 + 成员回挂（建议在 F3 操作族之后做，顺序：pin/delete → cat_delete）。

---

## 五、小项（低优汇总，顺手可清）

- `hotbox.js:8` `blocksData` 死导入；`test_prompts.py:13` `ops` 死导入（全文 0 次使用）。
- `prompts.py:34-35` `_labels` 名不符实（返回的是拼好的中文串）→ `_shot_refs`。
- `seed_blocks.py:7` docstring 产物名与仓库实际名不符；`110` `ncat` 计数器＝`len(SEED)`。
- `hotbox.js:313` 不可能分支静默 `ok:false`（无 toast）→ 删或补提示。
- `hotbox.js:536-537` selectionStart/End 冗余判空 ×4-6；归一化口径不一（clean vs trim）→ 统一。
- `prompts.py:253` 组 updated_at（已入 ☆）。
- history 无保留策略（读侧已有 LIMIT + 索引，信息级，可不动）。

---

## 六、已核定的刻意边界（勿误伤，修复时保留）

- **四道写入保护整体设计**（前端内存撤销栈 / 写白名单方向 / 痕迹 / 每日快照）——不拆，只补完成度（B1/B13/F9）。
- **提示词块「插入即固化」**（脱钩副本）——已定产品口径。
- **blockOp 的缓存 + 订阅统一**——方向正确（问题在 B1/B2 完成度）。
- **菜单 / 按钮 `mousedown preventDefault` 保焦点**；**focusEditor 仅首次落光标**（a777ef0 修复产物）——保留。
- **块库写路径不记 history**（库不是场数据，恢复靠快照 / 撤销栈）——文档缺口在 docstring（应写明例外）。
- **seed 裸 DELETE 绕开域函数**——dev 重灌路径刻意（快照补丁 B12/F9 除外）。
- **空组作为撤销载体**——机制保留，注释纠正（B14）。
- **hotbox「保存失败留字」**——正确行为，blockman 应向它对齐（B4）。
- **单镜特例存在**——有意设计（落点见 ◆5）。
- **每请求恰一次 connect/close、函数内单次 commit**——纪律正确（seed 是唯一例外，B12）。
- **M3.5 上收 `moveBlockTo`/`siblingList`**——方向正确，剩余路径续收（F3）。

---

## 附录 A · 复核明细（聚合前一手实测）

在 `:memory:` 库载入仓库 `schema.sql` 与《test_prompts.py》同款夹具，调用仓库真代码：

| 项 | 结果 |
|---|---|
| ① `cat_update(con, "1", "改名")` | **通过**（字符串 id 静默亲和转换） |
| ② `block_create(con, "x", "1")` | **拒绝**：`分类不存在：#1`（同库，口径分叉实锤） |
| ③ `set_group_text(con, True, "改文本")` | **通过**，组 1 被改（bool 干了 id=1 的活） |
| ④ restore 后 `prompt_groups.updated_at` | **未变化**（其它写路径均 bump） |
| ⑤ `restore_state` 写 60000 字文本 | **落库**（长度 60000，上限 50000 被绕过） |
| ⑥ restore 造零成员组 | **持久化**（组 4「空组」成员数 0） |
| ⑦ 删掉组唯一成员镜 | 组**留存**，`member_shots=[]`（孤儿空组实锤） |
| ⑧ 同镜出现在两组 | 静默归后一组（无报错） |
| ⑨ `block_update(position=0.7)` | 静默取 0，顺序变化（类型未收窄） |
| ⑩ `releaseActive` 代码走查 | 只置 collapsed、无 unsub；`collapseBox:277` 早退堵死补救（B1 成立） |

性能类数字（merge 1802 语句、prompt_state 13.5ms、2000 块 2004×UPDATE 等）来自审查员在合成规模（300 / 500 / 2000 件）下的基准，**当前真实库（34 镜 / 16 块）全部在 1-2ms 内、无可感卡顿**——属「为成长留余量」类修复。

## 附录 B · 审查方式

8 名子代理审查员，全部只读（未改任何文件、未重启服务、未写 `data/studio.db`）；跨文件对照 17 个既有模块与 AGENTS.md 的口径；Chesterton's Fence 用 `git blame` 核验（如 `scene.js:189 allShots` 早于 `hotbox.js` 建文件、`siblingList` 上收于 787607a）。原始记录（各审查员完整输出）：`/opt/data/cache/delegation/live/deleg_604c0770/task-{0..3}.log`（前端批）与 `deleg_3db2fbc0/task-{0..3}.log`（后端批）。
