# -*- coding: utf-8 -*-
"""每日快照 / 保留剪枝 / 场锁（原 ops.py 拆分 · S1-L1）。"""
import os
import re
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path
from core import db, fsutil
from .write import record_history, _row_or_raise
from .structure import _scene_payload


SNAPSHOT_RETAIN_DAYS = 30

# 每日快照：并发锁 + 进程内「今日已做」幂等键（P0·S1-B2）
_snapshot_lock = threading.Lock()
_snapshot_done = None   # (src, root, ymd)：做完才置位；免每次写连接的 stat+glob


def ensure_daily_snapshot(db_path=None, snap_root=None):
    """每日快照：当天首次写操作前整库备份一份（幂等，已存在则跳过）。
    用 SQLite 备份接口落 .tmp 再原子改名——不裸拷 live 文件（避免拷到事务半写态），
    中断只留 .tmp、不留半截正式备份；顺带清理超过 SNAPSHOT_RETAIN_DAYS 天的旧档。
    并发安全：锁内复查 + tmp 名带 pid（P0·S1-B2）；进程内「今日已做」免重复 stat+glob。"""
    global _snapshot_done
    src = Path(db_path) if db_path else db.DB_PATH
    root = Path(snap_root) if snap_root else src.parent / "snapshots" / "daily"
    if not src.exists():
        return None
    key = (str(src), str(root), date.today().strftime("%Y%m%d"))
    if _snapshot_done == key:
        return None
    root.mkdir(parents=True, exist_ok=True)
    dest = root / ("studio-%s.db" % key[2])
    made = None
    with _snapshot_lock:
        if _snapshot_done == key:   # 等锁期间已被别的线程做完
            return None
        if not dest.exists():
            tmp = root / (dest.name + ".%d.tmp" % os.getpid())
            src_con = sqlite3.connect("file:%s?mode=ro" % src, uri=True)
            try:
                dst_con = sqlite3.connect(str(tmp))
                try:
                    src_con.backup(dst_con)
                finally:
                    dst_con.close()
            finally:
                src_con.close()
            os.replace(tmp, dest)
            made = str(dest)
        _prune_snapshots(root)
        _snapshot_done = key
    return made


def _snapshot_date(path):
    """存档名中的日期（studio-YYYYMMDD.db）；不匹配/非法 → None——P0·S1-P6③。"""
    m = re.match(r"^studio-(\d{8})\.db$", path.name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d").date()
    except ValueError:
        return None


def _prune_snapshots(root):
    """保留最近 SNAPSHOT_RETAIN_DAYS 天的每日快照，过期删除（失败静默）。"""
    cutoff = date.today().toordinal() - SNAPSHOT_RETAIN_DAYS
    try:
        for f in root.glob("studio-*.db"):
            d = _snapshot_date(f)
            if d and d.toordinal() < cutoff:
                f.unlink()
    except OSError:
        pass


def kv_set(con, key, value):
    """settings KV 写单点（P2·S4-C6）：upsert；调用方负责事务提交。"""
    con.execute(
        "INSERT INTO settings (key, value) VALUES (?,?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
    return value


def lock_scene(con, scene_id, lock=True, snap_root=None):
    """锁定本场（M2-7）：留底 = 场次版本快照（JSON 落盘 + snapshots 记录）+ 锁定标记。
    锁定 ≠ 禁止编辑（设计稿 §128）；解锁只清标记，不动已留底文件。"""
    sc = _row_or_raise(con, "scenes", scene_id, "场景")
    snap = None
    if lock:
        payload = {"saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                   **_scene_payload(con, scene_id)}
        root = Path(snap_root) if snap_root else db.DB_PATH.parent / "snapshots" / "scenes"
        root.mkdir(parents=True, exist_ok=True)
        fname = "%s-%s.json" % (sc["scene_no"] or ("scene%d" % scene_id),
                                datetime.now().strftime("%Y%m%d-%H%M%S"))
        fpath = root / fname
        fsutil.dump_json(fpath, payload)   # 原子写单点（P1·S4-P5）
        rel = str(fpath.relative_to(db.DB_PATH.parent.parent))   # 恒仓库相对（snap_root 只决定文件落哪）——P0·S1-W15
        con.execute("INSERT INTO snapshots (scope, kind, label, path) VALUES ('scene','locked',?,?)",
                    (sc["scene_no"], rel))
        snap = {"path": rel, "at": payload["saved_at"]}
    con.execute("UPDATE scenes SET locked=? WHERE id=?", (1 if lock else 0, scene_id))
    record_history(con, scene_id, "scenes", scene_id, field="locked",
                   old_value="1" if sc["locked"] else "0", new_value="1" if lock else "0")
    con.commit()
    return {"scene": dict(con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()),
            "snapshot": snap}


