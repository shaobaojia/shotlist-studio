# -*- coding: utf-8 -*-
"""每日快照族（自 ops/snapshot.py 迁出 · S1-L4）：并发锁 + 进程内幂等键；只依赖 paths。
写边界（open_rw 显式入口）调用；不依赖 db / ops 两模块（断掉旧循环）。"""
import os
import re
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path

from core import paths


# -*- coding: utf-8 -*-
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
    src = Path(db_path) if db_path else paths.DB_PATH
    root = Path(snap_root) if snap_root else (
        src.parent / "snapshots" / "daily" if db_path else paths.SNAP_DAILY_DIR)
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


