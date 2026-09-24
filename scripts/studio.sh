#!/bin/bash
# shotlist-studio 一条命令管线（批7）：run / stop / status / test / migrate / export
# 用法：bash scripts/studio.sh <命令> [参数]
#   run      启动服务（脱会话常驻；等价 serve.sh start）
#   stop     停止服务（整组杀守护）
#   status   查看服务状态
#   test     全量无头回归（uv run --with pytest）
#   migrate  飞书迁移脚本（透传参数，如 --reset）
#   export   全库 JSON 导出 → data/exports/（数据安全留档）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-help}"; shift 2>/dev/null || true
case "$CMD" in
  run)     exec bash "$ROOT/scripts/serve.sh" start ;;
  stop)    exec bash "$ROOT/scripts/serve.sh" stop ;;
  status)  exec bash "$ROOT/scripts/serve.sh" status ;;
  test)    cd "$ROOT/server" && exec env UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}" uv run --with pytest python3 -m pytest tests/ -q "$@" ;;
  migrate) cd "$ROOT" && exec python3 scripts/migrate_feishu.py "$@" ;;
  export)  cd "$ROOT" && exec python3 scripts/export_json.py "$@" ;;
  seed)
    case "${1:-}" in
      blocks)  script="seed_blocks.py" ;;
      audit)   script="seed_audit_rules.py" ;;
      recipes) script="seed_recipe_defaults.py" ;;
      *) echo "用法: bash scripts/studio.sh seed {blocks|audit|recipes} [参数]" >&2; exit 2 ;;
    esac
    cd "$ROOT" && exec python3 "scripts/$script" "${@:2}" ;;
  help)    echo "用法: bash scripts/studio.sh {run|stop|status|test|migrate|export|seed} [参数]" ;;
  *)       echo "用法: bash scripts/studio.sh {run|stop|status|test|migrate|export|seed} [参数]" >&2; exit 2 ;;
esac
