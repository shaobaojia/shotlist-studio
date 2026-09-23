#!/usr/bin/env python3
"""全库 JSON 导出（批7·工程收尾）：数据安全留档——所有表逐行转 JSON，落 data/exports/。

用法：python3 scripts/export_json.py [--out 目录]
产物：<out>/studio-YYYYMMDD-HHMMSS.json（原子写 tmp+os.replace；含 meta / schema / tables）
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from core import ai as core_ai  # noqa: E402
from core import db as core_db  # noqa: E402


def dump_db(con, mask_keys=False):
    """把整库转成可 JSON 化的 dict：meta + schema（建表语句）+ tables（逐表逐行）。
    mask_keys=True：命中 ai.KEY_FIELD 的设置行写 <redacted>，meta.masked_fields 记账（P0·S4-B1）。"""
    names = [r["name"] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    tables = {}
    masked = []
    for n in names:
        rows = [dict(r) for r in con.execute('SELECT * FROM "%s" ORDER BY rowid' % n)]
        if mask_keys:
            for r in rows:
                if r.get("key") == core_ai.KEY_FIELD:
                    r["value"] = "<redacted>"
                    masked.append("%s.%s" % (n, r["key"]))
        tables[n] = rows
    schema = [r["sql"] for r in con.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")]
    return {
        "meta": {
            "app": "shotlist-studio",
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source_db": str(core_db.DB_PATH),
            "masked_fields": masked,
        },
        "schema": schema,
        "tables": tables,
    }


def main():
    ap = argparse.ArgumentParser(description="shotlist-studio 全库 JSON 导出")
    ap.add_argument("--out", default=str(ROOT / "data" / "exports"), help="输出目录（默认 data/exports/）")
    args = ap.parse_args()

    if not core_db.DB_PATH.exists():
        print("✗ 数据库不存在：%s" % core_db.DB_PATH, file=sys.stderr)
        return 1
    con = core_db.connect()
    try:
        data = dump_db(con, mask_keys=True)
    finally:
        con.close()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    fname = outdir / ("studio-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
    tmp = fname.with_name(fname.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, fname)
    os.chmod(fname, 0o664)
    counts = {k: len(v) for k, v in data["tables"].items()}
    print("✓ 已导出 %s（%.1f KB）" % (fname, fname.stat().st_size / 1024))
    print("  行数：%s" % json.dumps(counts, ensure_ascii=False))
    if data["meta"].get("masked_fields"):
        print("  已脱敏：%s" % ", ".join(data["meta"]["masked_fields"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
