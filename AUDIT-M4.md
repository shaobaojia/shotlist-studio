# AUDIT-M4.md — shotlist-studio · M4 子系统审计报告

- **仓库**：`/volume1/主目录/Hermes/read/Projects/shotlist-studio`
- **日期**：2026-09-21 ｜ **审计基线**：`HEAD = ad1c54b`（工作树干净，仅既有未跟踪 `AUDIT-M3.md`）
- **范围（M4 = 审计注解层 M4a + AI 通道 M4b，共 4 批 / 净增 ≈4,336 行新文件 + 776 行接线）**：
  - **批 A · 服务端审计域**：`core/audit.py`(589) · `api/audit.py`(132) · `tests/test_audit.py`(219) · `scripts/seed_audit_rules.py`(43)
  - **批 B · 服务端 AI 域**：`core/{ai,rewrite,recipes,draft}.py`(91+327+147+357) · `api/{ai,recipes,draft}.py`(103+36+51) · 测试三件(289+98+285)
  - **批 C · 前端审计域**：`web/js/{audit,auditpanel,auditset}.js`(379+149+131) + 接线 diff
  - **批 D · 前端 AI 域**：`web/js/{aiwrite,settings,draft}.js`(479+209+265) + 接线 diff
- **未覆盖**：M1–M3 既有模块（edit / table / scene / ops / db / prompts 等）仅作对照引用，未作独立审计；未做全链浏览器回归（属 M5 体检）。
- **方法**：simplify-code「审计模式」——**只报不改**。16 名审查员 ＝ 4 透镜（复用 / 质量 / 效率 / 高度）× 4 批，判据为注入规则书（clean-code.mini / refactoring.mini）；全部结论要求 `file:line` 证据，删除类先 `git blame`（Chesterton's Fence）。**聚合前对 3 条关键结论做了一手复核**（内存/临时库跑仓库真代码，输出见附录 A）。
- **结果**：原始 **222 条 findings + 37 条 bug** → 去重合并后 **29 条真 Bug + 12 条先修 + 约 45 条值得做 + 10 条立项候选**。
- **数据安全声明**：全程**零写库**。审查窗口（11:33–12:00）`serve.log` 零 POST、`audit_issues` 今日更新 0 条、DB 最后写入 10:16:58（用户自身操作）。某审阅员报告「数据在变」经核为同期兄弟审阅员浏览器内存注入的串扰，非真实写入。

> 本报告不修改任何代码。修复走后续独立批次：点名条目（或修复包），按正常改动纪律施工（每步提交 + AGENTS 入账 + 实测）。标记说明：**★** = 聚合前一手复核或浏览器实测过。**进度列图例**：✅ 已修（批次1 = `de21316`；批次2 = `2953b61`；批次3 = `7374775`+`4159e51`；批次4 = `cccde33`）｜◐ 部分（余项已注明）｜◆ 立项（第二轮进行中：先出方案、拍板、逐条施工；收官记 ✅ 二轮N）｜✅ 二轮1 = L1+L2（`7c82222`）；✅ 二轮2 = L8+L4+L3（`9fcf99e`）；✅ 二轮3 = L7+L9（`48242b6`）；✅ 二轮4 = L6+L5（`6610f74`）；✅ 二轮5 = L10（`4a941bc`）。**☐ 已全部清零——第一轮（批1–4）收官：29/29 Bug + P1–P12；第二轮（L1–L10）收官：10/10。**与文末「修复台账」同步维护。

---

## 一、真 Bug（29 条，按严重度排序）

### 高危 · 数据错/丢、虚假成功、功能缺口（6 条）

| # | 进度 | 批 | 位置 | 现象 | 修法 | 工量 |
|---|--------|---|----|------|------|------|
| G1 | ✅ 批1 | A | `scripts/seed_audit_rules.py:33` + `core/audit.py:486` + `schema.sql:125` | **`--reset` 孤儿问题**：清空规则表使存量 issues 的 `rule_id` 置 NULL（ON DELETE SET NULL）→ 标题变「?」、永不收敛、重检静默空跑、重跑后同批问题翻倍。★一手复现：reset 后 4 条全孤儿（counts 仍 open 4），再跑 → open=8 | reset 同事务清 issues 或按 title 回迁 rule_id；api recheck 对 rid=None 收 400 | XS |
| G2 | ✅ 批1 | A | `core/audit.py:246-247` + `327-330` | **LLM 回复不可解析 → 静默转 fixed**：`_extract_json` 吞错返回 `{}` → 该规则遗留 open 被 reconcile 判为「未再命中」全部转 fixed（灯熄灭的假象），summary 仍报成功、无 error | 解析失败抛错走规则级 error 通道，该规则本轮跳过 reconcile | S |
| G3 | ✅ 批1 | B | `core/draft.py:291-355` | **草稿并发双落入**：applied 守卫跨两个临界区（check-then-act），两并发 apply 同 job 双写。★一手复现：beats/shots 2/4 → 4/6（期望 3/5），两份痕迹 | 锁内 CAS 占位（applied=True 前置，异常回滚） | XS |
| G4 | ✅ 批2 | C | `audit.js:52-58 / 127-132 / 245-249` | **平铺视图节拍问题口径分裂**：灯不画（findAnchor 无回退），「去改」静默失效；卡与清单有回退而灯没有——同一问题三处可见性不一致。★浏览器实测 | 抽 `resolveCarrier` 单点（灯/卡/清单/去改同源，平铺退首镜行） | M |
| G5 | ✅ 批1 | D | `draft.js:183-186 + 234-259` | **初稿卡定时器跨实例互踩**：换卡不清旧 interval，旧闭包用模块级 `pd` 清掉"新卡的" timer → 本会话此后所有初稿卡秒杀停在「生成中」，旧任务无限轮询（静态推演，路径确定） | 卡状态实例化（st 对象）+ 代次校验；换卡先 stopPoll | S |
| G6 | ✅ 批1 | B+D | `draft.js:98-108/242-251` + `api/draft.py:36-38` + `api.js:3-8` | **草稿「任务丢失」死分支 + 无限轮询**：404 被 catch 当网络抖动吞掉，`if (!j)` 提示永不触发 → 服务重启后卡片卡死「生成中」并按 1.2s 永续轮询（对照 `/api/ai/job` 的 200+null 契约是活的） | 统一 200+job:null（推荐）；或前端分错处理 + 拍数上限 | XS |

### 中危（14 条）

| # | 进度 | 批 | 位置 | 现象 | 修法 | 工量 |
|---|--------|---|----|------|------|------|
| M1 | ✅ 批1 | A | `core/audit.py:519-541` | **JobManager.start 查重与登记不同临界区** → 并发双跑同场（重复计费、进度串台；双击/双标签可命中）。两审查员独立复现 | 占位登记并入第一段锁；或锁内读完规则再出锁 | S |
| M2 | ✅ 批2 | C | `app.css:457` + `:121` | **wrap-off 模式接缝灯被裁**：「不换行」下 `td{c overflow:hidden}` 裁掉 `top:100%` 的接缝灯 → 轴线规则在网格上零提示（该模式唯一载体消失）。★浏览器实测 | `td.cell-toggle { overflow:visible }` 豁免（同 `:466` 先例） | XS |
| M3 | ✅ 批2 | C | `audit.js:104-109` | **关场级卡不重算吸顶高度**：closeCard 不派 resize → `--freeze-h` 残留，平铺吸顶表头下坠 ~140px 悬空。★浏览器实测 | closeCard 补派 resize；或吸顶重算收归 scene.js 单点 | XS |
| M4 | ✅ 批2 | C | `auditpanel.js:143-147` + `scene.js:70` | **清单跳转成败判定失效 + 全片视图清单残留**：jumpToIssue 目标行不存在仍返真值 → 条目标 active 但无跳转无提示；切「全片」后旧场清单继续浮着、点击全静默。★浏览器实测 | jumpToIssue 未落地返回 null + 失败 toast；进全片视图即关清单 | S |
| M5 | ✅ 批2 | C | `audit.js:329-356` | **轮询乱序覆盖 + 无在飞守卫**：tick 不等上一拍，慢响应可回写旧快照（刚熄灭的灯复活一拍）；3s 桩实测两发并发 | 单飞守卫 + 单调时序号；applyIssues 后作废在飞响应 | S |
| M6 | ✅ 批2 | C | `filter.js:102-103` + `audit.js:135` | **筛选隐藏行后已展开审计卡残留**：行藏了、灯随行藏了，卡还悬空 105px。★浏览器实测 | 同行隐藏按 `data-for` 属性统一（覆盖 detail/审计卡/未来同行行） | S |
| M7 | ✅ 批3 | B | `core/rewrite.py:189` + `api/ai.py:70` | **preview 传非字符串 action → TypeError → 500**（`action not in ACTIONS` 对 dict 不可哈希；api 只捕 ValueError）。★一手复现 | `not isinstance(action, str) or action not in ACTIONS` → ValueError | XS |
| M8 | ✅ 批1 | B | `core/rewrite.py:306-321` + `ops.py:130-141` | **apply_items 重复目标覆盖 + 幽灵痕迹**：同 (id,field) 两条目标后者覆盖前者，applied=2/skipped=[]，history 多一条幽灵记录 | 提交前按 (table,id,field) 去重（留最后）；或守卫下沉条件写 | S |
| M9 | ✅ 批3 | B | `core/rewrite.py:215-219` / `draft.py:121-125` | **_prune 剪掉 running 任务** → 已计费外呼结果静默丢弃、前端「任务丢失」（keep=1 实测） | 只淘汰已完成任务；不够删就允许超 keep | XS |
| M10 | ✅ 批3 | B | `rewrite.py:207-212` / `draft.py:143-154` 等 | **AI 任务簿无并发闸门**：连点 ✦ 6 次 = 6 条线程 × 180s 外呼（LAN 可刷、无鉴权）；对照 audit.JobManager 有每场闸 | 搬 audit 每场去重口径 + 全局信号量上限 | S |
| M11 | ✅ 批3 | B | `core/recipes.py:128/143` | **配方保存/恢复非原子写**：截断式写 + 配方「每次现读」→ 后台生成线程可读到半截 system 提示词（120KB 并发实测 1590/400 次读损）。仓库已有 `.tmp+os.replace` 先例（ops.py:58-68） | 原子写（先备份后替换） | XS |
| M12 | ✅ 批1 | D | `aiwrite.js:42-52` | **pollJob 无取消通道**：close 后照跑满 420×650ms≈4.5 分钟、每 650ms 一次 GET；重开卡再叠加双路 | pollJob 接 isAlive 判据，循环内每拍检查 | XS |
| M13 | ✅ 批1 | D | `hotbox.js:249-258` + `aiwrite.js:220-224` | **选段改写锚点过期静默串文**：接受时按"打开菜单时"的偏移拼接，等待期用户可继续输入 → 替换落错位置（DB 路径有原值守卫，文本路径没有） | 接受时校验 `slice(sPos, sPos+len)===seg`，不符退化为 indexOf 或提示重选 | S |
| M14 | ✅ 批4 | D | `settings.js:78-89` | **保存配置三缺陷**：空值静默跳过（清空 model/base_url 无效）、api_key 明文留 DOM、保存后不回读 → 占位符与 has_key 态本会话永不更新，且 toast 虚报「已保存」 | 三键恒定发送（空串即清空）；保存后 loadAI() 刷新；key 输入置空 | S |

### 低危（9 条）

| # | 进度 | 批 | 位置 | 现象 | 修法 | 工量 |
|---|--------|---|----|------|------|------|
| L1 | ✅ 批4 | C/D | `hotbox.js:149` + `selection.js:105`（+`edit.js:283`） | **点外豁免名单遗漏 + 双份硬编码**：审计三卡、设置卡不在名单（点卡清选区/收编辑面，实测）；名单字面量两份手抄、edit.js 根本没有名单 | 统一 `.float-card`/`isFloatTarget()` 单点判定 | S |
| L2 | ✅ 批2 | C | `audit.js:184` + `234-251` | 「去改」对 scene/seam 载体空转（按钮通用摆出，实现只有 shot/beat 两支） | 按载体决定摆不摆；或补两支落点 | S |
| L3 | ✅ 批4 | C | `auditset.js:59-68 vs 87-131` | 参数保存失败不回滚（开关回滚、参数不回滚）+ `Number(x)\|\|0` 静默折算与后端 `or 3` 冲突（显示 0、实跑 3） | 与开关同款失败回退；空值拒绝不折算 | S |
| L4 | ✅ 批2 | A | `core/audit.py:253` | `_resolve_ref` 不剥「节拍」前缀 → 模型回「节拍2」时问题被静默丢弃（实测 `'节拍2'→None`） | 前缀剥离补「节拍」；抽 `_norm_ref` + 单测 | XS |
| L5 | ✅ 批1 | A | `api/audit.py:89-98` + `core/audit.py:519-522` | 「重检」在任务进行中被静默合并（only=[rid] 被吞、无提示） | start 返回 joined 标记；前端提示「正在跑，完成即含该规则」 | S |
| L6 | ✅ 批3 | B | `api/ai.py:56-59` + `core/rewrite.py:184-190` | instruction 口径分叉：`"   "+action` 时 api 回 400 而 core 接受；`instruction=123` → AttributeError（契约外异常） | 校验只留 core，先 isinstance 再 strip | XS |
| L7 | ✅ 批2 | C | `audit.js:80` + `135` | decorate 静默 reconcile 替用户弹「该行被筛选隐藏了」toast + 清 openKey（后台重绘替用户"说话"） | silent 路径不弹 toast、不清 openKey | XS |
| L8 | ✅ 批4 | D | `aiwrite.js:165-178` | 锚点（格角 ✦）被重绘销毁后卡片跳视口左上 (8,8)（DOM 实测游离矩形全 0 → `Math.max(8,…)`） | `place()` 对 `!anchor.isConnected` 保持原位 | XS |
| L9 | ✅ 批4 | D | `aiwrite.js:230-238` + `edit.js:114-140` | 接受回显分叉：编辑器 `original` 基线不同步 → 收起时再发一次同值写（无痕但白跑）+ 再压一条撤销（Ctrl+Z 要多按一次） | edit 导出基线同步钩子 / commitField 统一出口 | S |

---

## 二、★ 先修清单（12 条修复包，按性价比排序）

> 与上表重叠处为"成套修"的入口；每条都是小步、可验证、不改变可观察行为的施工包。

| # | 进度 | 包 | 内容 | 涉及 |
|---|--------|-----|------|------|
| P1 | ✅ 批1 | 草稿线加固 | CAS 占位（G3）+ 404 契约统一（G6）+ 定时器实例化（G5）+ pollJob 取消（M12）+ 锚点校验（M13）——**一次修完"草稿/AI 卡"全防线** | B/D 批 |
| P2 | ✅ 批2 | 审计轮询四小改 | 无变化不 notify、换场即 stopPoll、页面隐藏不拉、单飞+时序号（M5）+ 徽标只在 counts 变时刷——四个 ≤6 行改动砍掉一半请求 | C 批 |
| P3 | ✅ 批2 | 审计显示三连 | resolveCarrier 单点（G4/L2）+ closeCard 吸顶重算（M3）+ 接缝灯豁免（M2） | C 批 |
| P4 | ✅ 批1 | 孤儿防治组 | seed --reset 同事务清/回迁（G1）+ recheck 空 rid 400（L5）+ 解析失败走 error 通道（G2） | A 批 |
| P5 | ✅ 批2 | check-then-act 清扫 | draft CAS（G3 同组）+ apply_items 去重（M8）+ 守卫条件写（`UPDATE ... WHERE v=old`）+ JobManager 占位入锁（M1） | A/B 批 |
| P6 | ✅ 批3 | 配方写安全组 | 原子写（M11）+ 出厂副本自举脚本 `scripts/seed_recipe_defaults.py` + 注册表↔引擎对账测试（AI 组） | B 批 |
| P7 | ✅ 批3 | 任务闸门组 | AI 任务簿每场去重 + 全局上限（M10）+ prune 跳过 running（M9）+ 轻量轮询载荷 | B 批 |
| P8 | ✅ 批4 | 前端字段契约 | `/api/meta` 下发 AI 能力位 → `AIS`/`table.js`/`cellmenu.js` 单源（消灭三处手抄漂移） | C/D 批 |
| P9 | ✅ 批4 | 单格卡加固 | `[it.i]` 替 `[0]`、接受 disable、skip 终态卡、锚点失效兜底（L8/L9 相关） | D 批 |
| P10 | ✅ 批4 | 去改与设置组 | goEdit 按载体摆钮（L2）+ auditset 失败回滚（L3）+ 设置保存回读（M14） | C/D 批 |
| P11 | ✅ 批4 | 死件清理包 | 删 ctx.refresh 注入 / export closeCard / qb primary + 死样式 / onTick 空参 / `write=True` 死参 / `cur.rules` 驻留（前后端同步删）/ 灯具 mousedown 冗余 | 全批，机械 |
| P12 | ✅ 批4 | 测试网补缺 | api 层用例（4-6 条）+ `core/ai` 三契约用例（public_config 无 key / save_config 空值不改）+ dict 回包用例（audit）+ 夹具 `conn_factory` 上收 + 桩分派键改标题 | 全批 |

**修序建议**：P2 的四个小改当日可清 → P1/P4/P5 是数据安全线（优先）→ P7/P6 结构线 → 其余穿插。立项候选（第四节）不混入本次修复。

---

## 三、☆ 值得做（约 45 条，按域分组，均为「material 但不紧急」）

### 服务端 · 审计域（A）
- `api/audit.py` 四处裸 SQL/重复读 → `core.audit` 收口（`scene_exists`/`get_issue`/`open_counts`），api 层回归纯守卫+组装
- 轮询响应去 `rules`（前端零消费，每拍 4 SQL + 1820B/拍浪费；前后端同步删）
- `reconcile` 改条件插 / 加唯一索引（TOCTOU、防重复行）
- `load_ctx` 补 `shots_by_beat` 分桶（4 条规则去掉 O(拍×镜) 重扫）
- `rules_state`+`issues_state` 单次读规则表；api summary 聚合下沉 core
- `is_id` 上收 db/ops（audit 不再 import 提示词域）
- `_issue_write` 统一 `updated_at`（6 处手抄）
- run_scene 计划槽位 dict 化（四元位置列表→命名槽；`next(x…)` 扫描消失）
- `_select_rules` 单点（start/run 同源，快照=实跑）；start 读窄列
- `FIELD_HINT` 由后端下发 field（改标题不再静默失能）
- 空任务守卫：only 过滤为空 → 400 而非空跑「成功」
- 测试桩分派键「越轴」→ 标题级唯一串；夹具 `make_audit_db`→`make_base_db` + `conn_factory`
- 规则参数加 schema 声明（见立项 L3）；`CARRIERS` 与 schema CHECK 词汇表单点

### 服务端 · AI 域（B）
- `_extract_json` / `load_recipe` / `reply_text` / `channel()` 上收（立项 L2 半）
- 注册表↔引擎 AI 组对账测试（审计组有、AI 组缺）；引擎名单由 `recipes.names()` 派生
- `load_recipe` 走 `recipes.read`（白名单+前缀双保险，实测现可读 `../audit/axis.md`）
- `CAM_POS`/`KINDS`/`AI_FIELDS` 由 fields.py 派生（消灭三份副本）
- 轮询期轻量载荷（running/stage 小响应）；`get` 快照浅拷贝替 json 往返（53.8KB/0.44ms）
- 错误可观察：解析失败带 `raw[:200]` 截样；`except pass` 两处补 stderr/占位
- `apply_items` zip 位置耦合 → 键回填；items 目标去重
- settings 字段名映射单点（core 一张 FIELDS 表）；core/ai 补三契约单测
- `ai.test` 改名 `probe`；api 层重复校验删除（文案单源）
- `JOBS = DraftJobs()` 移 core；job 契约两端统一（200+null）
- 配方 stat 一次；`_entry` 噪声返回值整理；test_recipes docstring 数字同源

### 前端 · 审计域（C）
- 轮询生命周期单点收敛（六出口→一处）；decorate key-diff 增量 + 首轮去重
- `removeCards` 清理口单点（三处复制）；`flashEl` 提 ui.js（全仓第 5 份）
- `carrierText` 缓存 map；清单 render 改 fragment + 一次分桶 + 搜索 150ms 防抖
- 浮卡外壳 CSS 抽 `.float-card` 基类（7 处重复）；`.as-*` 通用表单件归位
- 「去改」320ms 合成事件 → edit 暴露开编辑器 API（同步直开）
- 灯监听 4→3（mousedown 冗余）或事件委托；flash 定时器可取消
- 审计设置与顶栏设置互斥（现可同开、后者盖住前者 ✕）
- 死样式清理（`.qbtn.primary`、重复 rowFlash 行）；宽度/z 口径注释
- `progressText` 单点；main.js 徽标第二通道收敛

### 前端 · AI 域（D）
- `targetsFromSel` 复用到 cellmenu（删内联双循环）
- 单格/批量卡骨架合一（立项 L5 前端半）；`closeAiCards` 全量互斥入口
- draft.js 状态实例化（G5 修复的根）+ 两卡生命周期统一
- settings 视图状态显式（列表/编辑不靠 DOM 反推）+ 未保存返回提示
- `MAX_TARGETS` 单点；字段查找 `fieldOf` 单点（全仓第 9 份）
- beats 批量回写缺口：入口断言 shots-only 或按 table 分派
- api.js 命名统一（`ai*`/`draft*` 三前缀混用）
- 「落入」撤销 N+1 串行删除 → 批量原语
- `place()` rAF 合并 + transform 定位（滚动期强制布局）；`placeNear` 与 menu.js 共享
- edit.js 角标槽位泛化（`cfg.corner`），edit 不再认识 AI；table↔aiwrite 依赖环拆解
- scene.js 绘制前清理改注册表（现在的五连调用是 shotgun 形态）
- 30 格预检删除或单点（服务端 400 文案已权威）

---

## 四、立项候选（10 条：深修一次做完，别半途留两套）

| # | 进度 | 立项 | 范围 | 为什么 |
|---|--------|------|------|--------|
| L1 | ✅ 二轮1（`7c82222`） | **`core/jobs.py` 任务基建** | 三任务簿（audit/rewrite/draft）合基类：lock/jobs/seq/keep + snap/prune/finish + 并发闸门 + 轻量快照；各自只留 `_run` 与条目形状 | 第 3、4 份同构已出现；keep/prune/取消口径三样分裂；A/B 批共建 |
| L2 | ✅ 二轮1（`7c82222`） | **`core/ai` 契约收口** | `channel()`（配置读+key 预检+chat 归一）/`reply_text()`/`require_key()`/FIELDS 映射；测试桩改返真形状 `{text}`，删两侧 isinstance 补丁 | 归一口径已三份、lambda 三份、配置读五处翻译；根因=契约缺失 |
| L3 | ✅ 二轮2（`9fcf99e`；前端派生随 L9） | **规则注册表单点** | slug key + kind + params schema + recipe 文件名 + desc 一张表；DB 增 key 列；前端 FIELD_HINT/参数控件由它派生 | 标题当键族全链（G1 修复的根治形态）；DESIGN §11.2#4「配置表驱动」只做了一半 |
| L4 | ✅ 二轮2（`9fcf99e`） | **ops 追加行原语** | `append_beats/append_shots`（编号顺延+位置+痕迹+单事务）；draft.apply 只做映射 | 编号知识已 3-4 份；洞场落位已分叉 |
| L5 | ✅ 二轮4（`6610f74`） | **前端任务卡原语 `aicard.js` + 统一 `pollJob`** | 四张卡（单格/批量/草稿/初稿）共享壳 + 三态 + 取消；五处轮询合一（间隔/上限/取消/错误契约单点） | 骨架 ~145 行×2 重复、轮询 5 份口径分裂 |
| L6 | ✅ 二轮4（`6610f74`） | **浮层治理** | `.float-card` 基类 + `isFloatTarget()` 注册 + 互斥（同层开新关旧）+ 点外豁免统一 | 外壳 7 处、名单 2 份、互斥缺失、新增浮层要 grep 全体监听（坑区 175 起源） |
| L7 | ✅ 二轮3（`48242b6`） | **前端写入出口三件** | `edit.commitField`（统一写+撤销+基线）/ `selection.batchWrite` 泛化（table 参数化）/ `hbedit.replaceRange` | AI 域三处重抄主路径的根因；三个小出口让后续功能复用主路径 |
| L8 | ✅ 二轮2（`9fcf99e`） | **digest 共享模块** | `scene_line(sc, terse)` / `shots_lines(rows, spec)` / 短标签表（audit/rewrite/draft 三域共用） | 场线 3 版、digest 3 份、标签 4 套已分叉 |
| L9 | ✅ 二轮3（`48242b6`） | **表单件与参数 schema** | settings/auditset 共享 `fieldRow/collect`；规则参数 schema 下发 → 前端控件派生 | 两份表单构建器 + 参数形状无契约（写侧只查 dict） |
| L10 | ✅ 二轮5（`4a941bc`） | **测试网补强** | api 层用例（三域薄层零覆盖→+24）+ core/ai 契约用例（+3）+ 并发用例（apply/start，随步补齐）+ 注册表对账（+3）——176→206 全绿 | 「桩≠真调」已两度咬人；M4 的 112 例测试对 api/ai 边界是盲区——已专项清零 |

---

## 五、刻意未报（设计口径，勿误改）与环境记录

- 灯两态（修/豁免即消失）、四载体切分、注解层不改镜头数据、对账键 `(scene,rule,carrier,target)`——提案 v0.2 拍板。
- JobManager 轮询（无 WebSocket）、每场至多一个任务（M1 修的是实现竞态，不动语义）、服务重启即清。
- 预览零写入 / 应用 `ops.batch_update(source='ai')` / 原值未变守卫 / 撤销在前端栈 / 配方每次现读 / key 明文不出后端 / 配方白名单+备份（每份留 30）。
- 两段生成、落入才写、只新增不覆盖、编号顺延；空场专用入口由前端把门。
- `core/audit.py` 589 行属 ≤400 行豁免；stdlib-only / 零构建 / 中文注释。
- 环境记录：审查窗口零 POST；DB mtime 10:16:58（用户自身操作）；某审阅员观察到的「数据变动」= 兄弟审阅员浏览器内存注入串扰；另有一枚审阅员探针产物 `file:race?mode=memory&cache=shared`（96KB 夹具库）已清理。

---

## 附录 A · 一手复核记录（聚合前，库外内存/临时库）

| 结论 | 复核方式 | 结果 |
|------|---------|------|
| G1 seed --reset 孤儿 | 内存库跑仓库真代码：seed → run_scene（4 open）→ reset → 再跑 | ✓ 复现：reset 后 rule_id 全 NULL、title「?」、counts 仍 4；再跑 open=8 |
| G3 草稿并发双落入 | 临时库 + 两线程（工厂闸门对齐），同 job 双 apply | ✓ 复现：T1/T2 均成功，beats/shots 2/4→4/6（期望 3/5） |
| M7 action 非字符串 500 | 直调 `PreviewJobs().start(action={'x':1})` | ✓ 复现：`TypeError: unhashable type: 'dict'`（api 只捕 ValueError → 500） |
| M2/CSS 行号 | `grep -n` 抽查 `app.css:457/121/466/489` | ✓ 全部对位（含既有豁免先例 :466） |

签名存档：`seed_default_rules(con, reset=False)` · `run_scene(con, scene_id, only=None, ai_chat=None, write=True, progress=None)` · `PreviewJobs.start(self, scene_id, targets, action=None, instruction=None, chat=None, connect_factory=None)` · `DraftJobs(keep=30)`。

## 附录 B · 原始材料索引

- 批次与审查员：批 A `deleg_65da5ca3` · 批 B `deleg_6b55923d` · 批 C `deleg_5cdb80b0` · 批 D `deleg_12c5a396`（各 4 名，全量 transcripts 于 `/opt/data/cache/delegation/live/<id>/task-{0..3}.log`）。
- 固化索引：`/opt/data/cache/m4b/audit/{batch-a,batch-b,batch-c}-manifest.md` + `verify-results.md`。
- 判据规则书：`/opt/data/skills/software-development/simplify-code/references/{clean-code,refactoring}.mini.md`。

> 备注：批 D 审阅员报告过任务书里 `998254e`（wand 相关）与仓库实况不符——实际 wand 定位改动在 `cea2620` 且已入坑区；该编号为聚合时笔误，不影响结论。

---

## 修复台账（滚动）

- **批次1 · 数据安全线 ✅**（`de21316`，2026-09-21）：
  G1 seed `--reset` 孤儿回迁 ✅ ｜ G2 回包解析失败不假熄灯 ✅ ｜ M1 审计并发 start 锁内认领 + joined ✅ ｜ L5 重检如实提示 + 空 rid 守卫 ✅ ｜ G3 草稿落入 CAS ✅ ｜ G6 草稿任务契约 404→200+null ✅ ｜ G5 初稿卡定时器实例化 ✅ ｜ M12 pollJob 取消通道 ✅ ｜ M13 选段锚点校验 ✅ ｜ M8 重复目标去重 ✅
  验证：单测 113→**118/118** 全绿；浏览器四幕实测（替换存活 / 重启丢失 / 取消即停 / 过期锚点）；scratch 场 API E2E 全绿；s010 全程零写入。
- **批次2 · 审计线 ✅**（`2953b61`，2026-09-21）：
  G4 resolveCarrier 单点（灯/卡/跳转/去改同源，平铺节拍退首镜行）✅ ｜ M2 接缝灯防裁（wrap-off 特异性修正）✅ ｜ M3 closeCard 吸顶重算 ✅ ｜ M4 跳转失败如实报 + 离场关清单 ✅ ｜ M5+P2 轮询四小改（无变化不 notify / 换场停 / 页面隐藏不拉 / 单飞+时序号；徽标随变化）✅ ｜ M6 筛选联动卡行 ✅ ｜ L2 去改按载体摆钮 ✅ ｜ L4 引用归一（节拍/beat 前缀）✅ ｜ L7 静默重绘零打扰 ✅ ｜ F8 设置两卡互斥 ✅ ｜ P5 余项条件写守卫 ✅
  验证：单测 118→**120/120**；浏览器 T1–T9 全过（含 CSS 特异性修正复测）；P2 请求特征实测（2s 拍零叠发 / 隐藏期 0 拉取 / 恢复 0.4s 补拍 / 完成即停）；scratch 清场零残留；s010 零写入。
- **批次3 · AI 通道线 ✅**（`7374775`+`4159e51`，2026-09-21）：
  M10 任务闸门（同场并入 joined + 全通道并发 ≤4 + 前端并入提示）✅ ｜ M9 剪枝护 running ✅ ｜ M11 配方原子写 ✅ ｜ M7 preview 类型防线 ✅ ｜ L6 校验单源 ✅ ｜ 清尾：load_recipe 白名单 / ai.test→probe / 注册表↔引擎对账测试 / 出厂副本脚本 ✅ ｜ P6 ✅ P7 ✅（含轮询期轻载）
  验证：单测 120→**133/133**（+13）；真调实测（第二枪 joined 同 id、一次外呼；轻载轮询无大文本、完成回全量）；UI 实测（并入 toast 命中、共享任务出稿、零 JS 错误）；s010 零写入（history 173 原样）；服务已重启。
- **批次4 · 前端与设置线 ✅**（`cccde33`，2026-09-21）：
  M14 设置卡三缺陷（三键恒定 / 空串即清 / 保存回读 + key 置空）✅ ｜ L1 点外豁免单点（`.float-card` + `isFloatTarget`，三处名单收编）✅ ｜ L3 参数拒绝不折算 + 失败回滚 ✅ ｜ L8 锚点失效原位保持 ✅ ｜ L9 编辑基线同步（收起不重写 / 撤销不重按）✅ ｜ P10 ✅（L2 批2 + L3/M14 本批）｜ P8 单源（`/api/meta` 下发 ai_fields / ai_max_targets；AIS 与 30 格改读 meta）✅ ｜ P9 单格卡加固（`[it.i]` / 接受禁双击 / skip 终态卡 / 并入按目标定位）✅ ｜ P11 死件清理（ctx.refresh / closeCard export / qb primary + 死样式 + 重复 rowFlash / `write` 死参 / `cur.rules` 前后端删 / 灯具 mousedown；「onTick 空参」经复核已随 M12 取消通道消灭）✅ ｜ P12 测试网（+13：api 守卫 / meta / ai 契约 / dict 回包 / 夹具上收 / 桩键改标题级）✅ ｜ D 尾（fieldOf 单点 / cellmenu 复用 targetsFromSel / 草稿撤销批删 / settings 未保存返回提示）✅
  验证：单测 133→**146/146** 全绿；浏览器实测（L1 三项保持 / L3 拒绝回滚 + 服务端还原 / L8 原位 815px / L9 零重复写 + 单次撤销 + 「没有可撤销」 / M14 清空回读默认）；scratch s100 清场零残留。⚠️ 实测插曲：自动化选择器误触「跑审计」一次——s010 审计正常跑完（9/9 无错），问题清单按真实重跑对账刷新（open 4→7、2 条转已修；豁免 4 不动）；零数据损坏。
- **二轮 · 第1步（L2+L1）✅**（`7c82222`，2026-09-21）：
  `core/jobs.py` 任务基类（`Gate` 计数闸 + `JobBoard`：锁内认领 / 同场并入 / 剪枝护 running / 轮询期轻载 / 收尾释放恰一次）✅ ｜ audit / rewrite / draft 三簿迁移（各留条目形状 + `_run`；`_task_acquire`/`_task_release`、`_prune`×2、`_snap`×2、`_default_chat`、`_reply_text` 全退役）✅ ｜ `ai.channel()/require_key()/reply_text()` 契约单点（配置读 + key 预检 + 归一宽进；api 层预检同源）✅ ｜ 测试桩改真形状 `{text}` ✅
  签名变化：`DraftJobs(keep=30, gate=jobs.TASKS)` · `PreviewJobs(keep=40, gate=jobs.TASKS)` · `JobManager()`（不带闸，语义不变；测试可注入独立闸 `Gate(n)`）。
  验证：单测 146→**157/157** 全绿（+11：`test_jobs` 基类 8 例 + `TestChannel` 3 例）；真调（活服 preview 单条真出稿 4.3s、s010 history 293→293 零写入）；audit 基类对生产库副本全流程（5 程序规则 done、无错）；服务已重启（20:59）。
- **二轮 · 第2步（L8+L4+L3）✅**（`9fcf99e`，2026-09-21）：
  `core/digest.py` 共享模块（`scene_line(sc, terse)` / `shots_lines(rows, spec, colon)` / `LABELS` 短标签表）——audit 五条 digest + rewrite 镜头速览 + draft 场线/组内速览全切换；黄金对拍 10 例逐字节等（唯一有意归一：草稿「空间关系」→「空间」）✅ ｜ `ops.append_beats/append_shots` 追加行原语（编号顺延/位置续尾/逐行 create 痕迹/不 commit 由调用方收尾）；`draft.apply` 只做映射（CAS 与形状校验保留）✅ ｜ 规则注册表 `RULES` 单点（key/kind/recipe/params schema/desc；`PROGRAM_RULES`/`LLM_DIGESTS`/`LLM_RECIPES` 全换 slug；`_rule_key` 老行回退）✅ ｜ DB：`schema.sql` 增 key 列 + `_ensure_key_column` 幂等迁移 + 种子按 key 回填/reset 按 key 回迁 + `rules_state` 下发 key/desc/recipe/params_schema + 种子脚本 `--list` 带 key ✅
  验证：单测 157→**174/174** 全绿（+17：digest 黄金 10 + 追加原语 4 + 注册表 3）；真调（活服 preview concretize 3.5s 出稿、s010 history 293→293 零写入；副本 ZZ9 草稿真调 5 节拍 16 镜 → 落入编号 1→2..6 / 01,02→03..18 顺延 + 位置连续 + ai 痕迹 21 行 + 二次落入被拦）；活库迁移：key 列实体 + 十行回填（concrete 保持 disabled 原样）；服务已重启。

- **二轮 · 第3步（L7+L9）✅**（`48242b6`，2026-09-21）：
  `edit.commitField` 字段落定单点（模型 → 编辑面就地+基线同步 → 撤销；AI 单格接受改走此口）✅ ｜ `selection.batchWrite` 泛化（`opts.write` 写口注入 / table·resolve·refresh 换域 / done·fail 收尾；AI 批量应用接入——一次写口一步撤销）✅ ｜ `hbedit.replaceRange` 范围替换单点（AI 选段接受 / 剪切 / insertInto / replaceAll 四路收敛）✅ ｜ `web/js/formkit.js` 表单件单点（`fieldRow`/`collect`；设置卡 + 审计设置卡切换）✅ ｜ auditset 参数控件由 `params_schema` 派生（`PARAM_CN` 退役）✅ ｜ 「去改」目标列由注册表随问题下发（RULES `field` + `issues_state.field`；前端 `FIELD_HINT` 退役——改标题/换列不再静默失能）✅
  验证：单测 174→**176/176** 全绿（+2）；浏览器五幕实测（设置卡保存回读一致 / 审计参数往返 3→4→0拒→3 / 单格接受双分支：编辑面开=基线不重写、关=重画 + Ctrl+Z 单步回退 / 批量选区两块一写口一撤销双格回退 / hotbox 选段替换 + 编辑器撤销零落库 / 去改落 `row34·audio` 准）；两卡改前/改后截图逐像素一致；s010 数据净回（5/6 镜原文经 API 还原、全留痕）；服务运行中。
  过程插曲（自咬）：aiwrite 删 import 误伤 runPreview 的 `renderCell`（非编辑面接受分支）——靠该分支实测咬出、提交前修复；同轮踩中「同 URL 不触发真重载」假验证——均记 AGENTS 坑区。

- **二轮 · 第4步（L6+L5）✅**（`6610f74`，2026-09-21）：
  `web/js/float.js` 新建（互斥注册表 `floatEnter/floatLeave/floatClose` + `panelShell` 外壳基类）；外壳收敛 7 处（设置卡 / 审计设置 / 审计面板 / 草稿两卡 → panelShell；AI 两卡 → taskShell）；互斥三层入表（`'panel'` 设置↔审计设置＝F8 收编 / `'ai'` 单格↔批量 / `'draft'` 场次草稿↔组级初稿）；`closeAiCards/closeDraftCards` → `floatClose` 全量入口 ✅ ｜ **审计面板补挂 `.float-card`**（批4/L1 单点化遗漏；修前点面板＝清选区/收编辑面/关相机表单——本轮实测复现、修后复测选区保持）✅ ｜ `web/js/aicard.js` 新建（`pollJob` 轮询单点 + `cardLife` + `taskShell/spinHead/cancelBtn/renderFail`）；四卡迁移（单格/批量/场次草稿/组级初稿；文本卡随单格）——手写轮询（`setInterval`×2 + pollJob×1）退役 ✅
  验证：单测 **176/176** 全绿；结构化对照逐字节一致（设置 3181 / 审计设置 3971 / 单格 485 / 批量 571 / 初稿 402 / 草稿表单 517 / 运行 283；草稿预览＝表头+尾部逐字节 + list 单元集合相等——拍镜数差异为内容变体；审计面板差异＝补挂类 + 实时数据）；互斥实测（单格→批量自动关旧 / 初稿换卡只 1 张 / 切场重绘收起）✓；行为回归（G5 换卡 / M12 ✕ 中途取消不复活 / L8 锚点销毁后滚动原位 / L9 接受+ESC+Ctrl+Z 净回恰 2 条痕 / 文本卡选段替换零落库 / ESC 收起零落库）✓；s010 数据净回、s060 零写入。
  过程记录：测试环境两坑（横滚致坐标出视口、宽面板遮目标格）已入 AGENTS 坑区；测试期间用户在场编辑 s010（history source=ai+manual 成对流）——测试改选镜头 1（避开用户镜头 3-6）。

- **二轮 · 第5步（L10）✅**（`4a941bc`，2026-09-22）：
  api 三域薄层 **+24**（设置薄层：短键→全键映射 / key 永不回传 / 探活双形状；应用守卫：job 三连 + 域错映射 + 成功形状；草稿 prompt·apply；**提示词/块库薄层零覆盖补齐**——守卫先于写连接以 dead-db 实锤；审计薄层：issue_op / recheck 孤儿 / joined 透传 / run / rules_get 契约 / summary）✅ ｜ 对账扩展 **+3**（`rules_state` 每行与 RULES 全字段对齐〔含 API 边界〕/ 种子幂等 / 审计注册**反向无孤儿**）✅ ｜ core/ai 契约 **+3**（配置默认兜底 / 注入桩跳预检 / probe 预检先行）✅ ｜ 并发三例清点（draft 双线程 / audit start 并入 / rewrite 并入——已随各步补齐）✅ ｜ 修正：`api/prompts.py` update 投影空检查前移（坏请求不触写连接，补纪律缺口）✅
  验证：单测 176→**206/206** 全绿（+30）；**咬合力实测**：prompts 降级回旧版 → `test_blocks_guards_pre_connect` 翻车（AssertionError: 坏请求触达了写连接）→ 还原全绿（测试能咬出真缺陷）。
  收官清点：二轮五步全清（1 L2+L1 `7c82222` / 2 L8+L4+L3 `9fcf99e` / 3 L7+L9 `48242b6` / 4 L6+L5 `6610f74` / 5 L10 `4a941bc`）——**L1–L10 10/10 ✅**。
