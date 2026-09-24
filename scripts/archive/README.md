# scripts/archive —— 归档的一次性工具

以下脚本已完成使命 / 属保险性工具，**不在一条命令管线内**，只人工运行：

- `migrate_feishu.py` —— 电玩城全量迁入（2026-09-19 已完成）。
  用法：`python3 scripts/archive/migrate_feishu.py [--reset] [--export DIR] [--db PATH]`
- `export_feishu_raw.py` —— 飞书两表原始数据保险导出。
  用法：`python3 scripts/archive/export_feishu_raw.py [--config PATH] [--out DIR]`

管线总览：`bash scripts/studio.sh help`（P8 归档除名 · AUDIT-M8/S4）。
