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


def _print_rule(r, prefix="", extra=None):
    """规则摘录打印单点（--list 与种子后共用）——P0·S2-W20。"""
    line = prefix + "#%s [%s] %s key=%s" % (r["id"], r["kind"], r["title"], r.get("key"))
    if extra:
        line += extra(r)
    print(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        con = db.connect()
        try:
            for r in audit.rules_state(con):
                _print_rule(r, extra=lambda x: " enabled=%s params=%s" % (x["enabled"], x["params"]))
        finally:
            con.close()
        return
    con = db.connect(rw=True)
    try:
        added = audit.seed_default_rules(con, reset=args.reset)
        rows = audit.rules_state(con)
        print("种子完成：新增 %d，现共 %d 条" % (added, len(rows)))
        for r in rows:
            _print_rule(r, prefix="  ")
    finally:
        con.close()


if __name__ == "__main__":
    main()
