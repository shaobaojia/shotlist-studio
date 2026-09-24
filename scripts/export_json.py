#!/usr/bin/env python3
"""全库 JSON 导出（批7·工程收尾）：数据安全留档——所有表逐行转 JSON，落 data/exports/。

用法：python3 scripts/export_json.py [--out 目录]
产物：<out>/studio-YYYYMMDD-HHMMSS-NNN.json（原子写；含 meta / schema / tables）
能力归位（S4-L2）：dump_db / 剪枝 / 原子写 在 server/core/backup.py——本脚本仅 CLI 壳。
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from core import backup  # noqa: E402
from core import db as core_db  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="shotlist-studio 全库 JSON 导出")
    ap.add_argument("--out", default=str(ROOT / "data" / "exports"), help="输出目录（默认 data/exports/）")
    args = ap.parse_args()

    if not core_db.DB_PATH.exists():
        print("✗ 数据库不存在：%s" % core_db.DB_PATH, file=sys.stderr)
        return 1
    fname, data = backup.dump_to(args.out)
    counts = {k: len(v) for k, v in data["tables"].items()}
    print("✓ 已导出 %s（%.1f KB）" % (fname, fname.stat().st_size / 1024))
    print("  行数：%s" % json.dumps(counts, ensure_ascii=False))
    if data["meta"].get("masked_fields"):
        print("  已脱敏：%s" % ", ".join(data["meta"]["masked_fields"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
