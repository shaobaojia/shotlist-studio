# AGENTS.md — shotlist-studio

分镜工作台 v2 的交接备忘录（给 AI 协作者：Hermes / CLI 子代理）。
规矩：开工前先读本文件；收尾时更新下面四字段。状态权威 = 本文件 + git log。

## 刚做完

- 2026-09-19 仓库骨架建立；设计稿 v0.1.1 冻结（DESIGN.md）。
- 2026-09-19 飞书两表全量导出留档：分镜表 46 条（s010×34 + s020×12）、分析表 3 条（s020 节拍），在 data/archive/feishu-2026-09-19/（不入 git）。
- 2026-09-19 server/schema.sql（v1，按 DESIGN §3）落地并自检通过。

## 正在做

- M1 底座：迁移脚本（scripts/migrate_feishu.py）→ 服务骨架 → 只读镜头表。

## 下一步

- scripts/migrate_feishu.py 首跑：s010 34 镜 + 提示词、s020 3 节拍 + 12 镜、全片价值弧线 → SQLite
- server/app.py 服务骨架 + 一条命令管线（run / migrate / test / export）
- 验收目标：浏览器里看到电玩城全量

## 坑

- 老库教训清单见 DESIGN §11.1（生成器拼 HTML、硬编码、无分层——勿重蹈）。
- 本仓库在 NAS 共享卷：容器内新建文件后注意权限（保持 a+rwX 双向可写）。
- 凭证红线：一切 key / secret 不入库；飞书凭证在库外（feishu_config.json）。
- 大文件改动走脚本替换，禁裸 patch（老库坑条）。
- 老库页面服务 :8089 保留运行（迁移对照用）。
- 分析表目前只有 s020 的 3 条节拍；s010 节拍信息在分镜行的 beat 列里，迁移时以此立节拍并核对。
