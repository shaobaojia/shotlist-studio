#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄影机旧格式一次性迁移（F1-L4）：shot_size 内嵌焦段/景深 → 独立字段。

背景：早期版本把焦段（nmm）与景深（·浅|中|深）嵌在 shot_size 串里（如「近景 ★★★★ 50mm·中」），
后改为独立字段 focal / dof。本脚本把历史串一次性剥净——值以「显示为准」
（界面所见 = 串内嵌值优先，见 web/js/cells.js 渲染口径），迁移后界面零变化。

用法：
  python3 scripts/migrate_cam_embed.py            # 干跑：只读扫描 + 打印对照表（不写库）
  python3 scripts/migrate_cam_embed.py --apply    # 真跑：热备（VACUUM INTO）+ 单事务写库
幂等：无内嵌值 → 打印「无需迁移」退出 0。
"""
import argparse
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from core import db, paths  # noqa: E402
from core.ops import record_history  # noqa: E402

# 与前端 web/js/edit.js parseCam 同口径（前端为正本；本处为一次性迁移复刻）
_CAM_RE = re.compile(r"(\d+mm)(?:·(?:浅|中|深)(?:→(?:浅|中|深))?)?")


def parse_cam(raw):
    """串 → (t1, t2, lens, dof)；口径对齐 edit.js parseCam。"""
    v = ("" if raw is None else str(raw)).strip()
    rest, lens, dof = v, None, None
    m = _CAM_RE.search(rest)
    if m:
        lens = m.group(1)
        d = re.search(r"·(浅|中|深)→(浅|中|深)", m.group(0))
        if d:
            dof = d.group(1) + "→" + d.group(2)
        else:
            d2 = re.search(r"·(浅|中|深)", m.group(0))
            if d2:
                dof = d2.group(1)
        rest = (rest[:m.start()] + rest[m.end():]).strip()
    parts = rest.split("↓") if "↓" in rest else [rest]
    t1 = parts[0].strip()
    t2 = parts[1].strip() if len(parts) > 1 else None
    return t1, t2, lens, dof


def target_of(raw, focal, dof):
    """迁移目标 (new_size, new_focal, new_dof)；无内嵌焦段 → None。"""
    t1, t2, lens, d = parse_cam(raw)
    if lens is None:
        return None
    new_size = (t1 + " ↓ " + t2) if t2 else t1
    new_focal = lens                                     # 串值定稿（显示为准）
    new_dof = d if d is not None else ("" if dof is None else dof)
    return new_size, new_focal, new_dof


def scan(con):
    """全库扫描：需迁移行列表 + 异常跳过行（剥离后为空）。"""
    rows = con.execute("SELECT id, scene_id, shot_size, focal, dof FROM shots ORDER BY id").fetchall()
    jobs, skipped = [], []
    for r in rows:
        t = target_of(r["shot_size"], r["focal"], r["dof"])
        if t is None:
            continue
        new_size, new_focal, new_dof = t
        if not new_size:
            skipped.append(dict(r))
            continue
        jobs.append({
            "id": r["id"], "scene_id": r["scene_id"],
            "old_size": r["shot_size"] or "", "old_focal": r["focal"] or "", "old_dof": r["dof"] or "",
            "new_size": new_size, "new_focal": new_focal, "new_dof": new_dof,
        })
    return jobs, skipped


def fmt_changes(j):
    ch = []
    if j["new_focal"] != j["old_focal"]:
        ch.append("焦段 %s→%s" % (j["old_focal"] or "空", j["new_focal"] or "空"))
    if j["new_dof"] != j["old_dof"]:
        ch.append("景深 %s→%s" % (j["old_dof"] or "空", j["new_dof"] or "空"))
    if j["new_size"] != j["old_size"]:
        ch.append("串剥净")
    return "  [" + "] [".join(ch) + "]"


def main():
    ap = argparse.ArgumentParser(description="摄影机旧格式迁移（F1-L4）")
    ap.add_argument("--apply", action="store_true", help="真跑（默认干跑）")
    args = ap.parse_args()

    con = db.open_rw() if args.apply else db.open_ro()
    try:
        jobs, skipped = scan(con)
        for s in skipped:
            print("⚠ 跳过（剥离后为空，需人工看）：#%s %r" % (s["id"], s["shot_size"]))
        if not jobs:
            print("无需迁移：shot_size 已无内嵌焦段/景深 ✓")
            return 0
        print("需迁移 %d 条：" % len(jobs))
        for j in jobs:
            print("  #%-3s %s" % (j["id"], j["old_size"]))
            print("      → %s%s" % (j["new_size"], fmt_changes(j)))
        if not args.apply:
            print("\n[干跑] 未写库。加 --apply 真跑。")
            return 0

        con.commit()                                     # VACUUM 须在事务外
        bakdir = paths.DATA_DIR / "snapshots" / "migrations"
        bakdir.mkdir(parents=True, exist_ok=True)
        bak = bakdir / ("studio-cam-migrate-%s.db" % time.strftime("%Y%m%d-%H%M%S"))
        con.execute("VACUUM INTO '%s'" % str(bak).replace("'", "''"))
        print("\n热备：%s" % bak)

        n = 0
        for j in jobs:
            con.execute("UPDATE shots SET shot_size=?, focal=?, dof=? WHERE id=?",
                        (j["new_size"], j["new_focal"], j["new_dof"], j["id"]))
            if j["new_size"] != j["old_size"]:
                record_history(con, j["scene_id"], "shots", j["id"], "shot_size", j["old_size"], j["new_size"], source="system")
            if j["new_focal"] != j["old_focal"]:
                record_history(con, j["scene_id"], "shots", j["id"], "focal", j["old_focal"], j["new_focal"], source="system")
            if j["new_dof"] != j["old_dof"]:
                record_history(con, j["scene_id"], "shots", j["id"], "dof", j["old_dof"], j["new_dof"], source="system")
            n += 1
        con.commit()

        jobs2, _ = scan(con)
        if jobs2:
            print("⚠ 复核仍有 %d 条残留！" % len(jobs2))
            return 1
        print("写库 %d 条；复核 0 条残留 ✓" % n)
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
