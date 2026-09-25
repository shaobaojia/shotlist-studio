# -*- coding: utf-8 -*-
"""快照落盘 + snapshots 登记（小件 · M8 清理刀）：lock_scene / delete_film 共用。
不 commit（调用方事务内）；路径列恒仓库相对（P0·S1-W15）；原子写走 fsutil.dump_json（P1·S4-P5）。"""
from datetime import datetime
from pathlib import Path

from core import fsutil, paths


def write_snapshot(con, root, name_base, payload, scope, kind, label):
    """根目录建齐 → 原子写 <name_base>-<时间戳>.json → snapshots 登记。
    name_base 由调用方保证安全（含防互盖的 id 后缀）；返回 {path(仓库相对), at}。"""
    now = datetime.now()
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    saved_at = now.strftime("%Y-%m-%d %H:%M:%S")
    fpath = root / ("%s-%s.json" % (name_base, now.strftime("%Y%m%d-%H%M%S")))
    fsutil.dump_json(fpath, {"saved_at": saved_at, **(payload or {})})
    rel = str(fpath.relative_to(paths.ROOT))    # 恒仓库相对（snap_root 只决定文件落哪）
    con.execute("INSERT INTO snapshots (scope, kind, label, path) VALUES (?,?,?,?)",
                (scope, kind, label, rel))
    return {"path": rel, "at": saved_at}
