#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""块序段化一次性迁移（F3-L2 (a)）：把既有 pinned 块归位到「置顶段」（分类内 pinned 前置）。

背景：pin 拨位语义上线前，pinned=1 的块 position 不保证在分类前段——「显示序 ≡ position 序」
口径下会出现「已置顶的块不在前面」。本脚本对每个分类组（含未分类）做一次稳定归位：
pinned 块（保持现相对序）在前 + 非 pinned 块（保持现相对序）在后；已归位不写（幂等）。

用法：
  python3 scripts/migrate_block_order.py            # 干跑：只读扫描 + 打印需归位组（不写库）
  python3 scripts/migrate_block_order.py --apply    # 真跑：热备（VACUUM INTO）+ 单事务写库
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from core import db, paths  # noqa: E402
from core.ops import reseq  # noqa: E402


def groups_of(con):
    """[{cid, rows}]（含未分类 None；rows 按 position, id 序）。"""
    cids = [r["category_id"] for r in con.execute("SELECT DISTINCT category_id FROM blocks")]
    out = []
    for cid in cids:
        if cid is None:
            rows = con.execute("SELECT * FROM blocks WHERE category_id IS NULL ORDER BY position, id").fetchall()
        else:
            rows = con.execute("SELECT * FROM blocks WHERE category_id=? ORDER BY position, id", (cid,)).fetchall()
        out.append({"cid": cid, "rows": [dict(r) for r in rows]})
    return out


def plan(con):
    """[{cid, want_ids, names}]——仅含需归位的组。"""
    todo = []
    for g in groups_of(con):
        rows = g["rows"]
        want = [x["id"] for x in rows if x["pinned"]] + [x["id"] for x in rows if not x["pinned"]]
        have = [x["id"] for x in rows]
        if want != have:
            todo.append({"cid": g["cid"], "want_ids": want,
                         "names": [x["text"][:14] for x in rows]})
    return todo


def main():
    ap = argparse.ArgumentParser(description="块序段化迁移（F3-L2 (a)）")
    ap.add_argument("--apply", action="store_true", help="真跑（默认干跑）")
    args = ap.parse_args()

    con = db.open_rw() if args.apply else db.open_ro()
    try:
        todo = plan(con)
        if not todo:
            print("无需迁移：所有分类的置顶块均已在置顶段 ✓")
            return 0
        print("需归位 %d 个分类组：" % len(todo))
        for t in todo:
            print("  分类 %s：%s" % ("（未分类）" if t["cid"] is None else "#%s" % t["cid"], " | ".join(t["names"])))
        if not args.apply:
            print("\n[干跑] 未写库。加 --apply 真跑。")
            return 0

        con.commit()                                     # VACUUM 须在事务外
        bakdir = paths.DATA_DIR / "snapshots" / "migrations"
        bakdir.mkdir(parents=True, exist_ok=True)
        bak = bakdir / ("studio-block-order-%s.db" % time.strftime("%Y%m%d-%H%M%S"))
        con.execute("VACUUM INTO '%s'" % str(bak).replace("'", "''"))
        print("\n热备：%s" % bak)

        for t in todo:
            reseq(con, "blocks", t["want_ids"])
        con.commit()

        left = plan(con)
        if left:
            print("⚠ 复核仍有 %d 组未归位！" % len(left))
            return 1
        print("写库 %d 组；复核 0 组残留 ✓" % len(todo))
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
