# shotlist-studio

分镜工作台 v2：价值弧线 → 节拍 → 分镜 → 提示词。一个常驻局域网的单用户 web 应用。
Python 3 stdlib 零依赖 + SQLite + 原生 HTML/JS（无构建链）。

**状态：v1.0 冻结（2026-09-23）**

## 一条命令管线

```
bash scripts/studio.sh {run|stop|status|test|migrate|export}
```

- run / stop / status —— 服务（:8094；静态页与 API 同一服务；脱会话常驻、崩溃自动重拉）
- test —— 全量无头回归（224 例）
- export —— 全库 JSON 导出 → `data/exports/`（数据安全留档）
- migrate —— 飞书迁移脚本（一次性；参数透传）

## 文档

- DESIGN.md —— 设计文档（v0.1.1 冻结 · 动工依据）
- AGENTS.md —— 交接备忘录（状态权威：刚做完 / 正在做 / 下一步 / 坑）
- AUDIT-M3.md · AUDIT-M4.md —— 审计报告（含修复台账与「刻意边界」清单）
- 需求池.md —— 新想法 /「先凑合」都记这里
- 快捷键速查卡.md · 种子块库.md · 视觉宣言.md —— 使用与资产
- server/ · web/ · scripts/ · recipes/ · references/ —— 代码与资产
- data/ —— 运行数据（DB / 快照 / 导出件），不入 git
