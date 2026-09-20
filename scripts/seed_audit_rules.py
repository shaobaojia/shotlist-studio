#!/usr/bin/env python3
"""M4a 审计规则种子：十项规则落库（幂等）。

用法：
  python3 scripts/seed_audit_rules.py          # 缺什么补什么
  python3 scripts/seed_audit_rules.py --reset  # 清空重建（连接时自动留当日快照）
  python3 scripts/seed_audit_rules.py --list   # 只列现状（只读）
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from core import audit, db  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        con = db.connect()
        try:
            for r in audit.rules_state(con):
                print("#%s [%s] %s enabled=%s params=%s" % (
                    r["id"], r["kind"], r["title"], r["enabled"], r["params"]))
        finally:
            con.close()
        return
    con = db.connect(rw=True)
    try:
        added = audit.seed_default_rules(con, reset=args.reset)
        rows = audit.rules_state(con)
        print("种子完成：新增 %d，现共 %d 条" % (added, len(rows)))
        for r in rows:
            print("  #%s [%s] %s" % (r["id"], r["kind"], r["title"]))
    finally:
        con.close()


if __name__ == "__main__":
    main()
