#!/usr/bin/env python3
"""快照族直测（S4-L4·B9）：日期解析 / 剪枝纯函数 / 每日快照幂等（tmp 直测，不触真库）。"""
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from core import snapshot as snap  # noqa: E402


def _name(days_ago):
    return "studio-%s.db" % (date.today() - timedelta(days=days_ago)).strftime("%Y%m%d")


class TestSnapshotDate(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(snap._snapshot_date(Path("studio-20260924.db")), date(2026, 9, 24))

    def test_bad_name(self):
        self.assertIsNone(snap._snapshot_date(Path("studio-x.db")))
        self.assertIsNone(snap._snapshot_date(Path("other-20260924.db")))

    def test_bad_date(self):
        self.assertIsNone(snap._snapshot_date(Path("studio-20261340.db")))


class TestPrune(unittest.TestCase):
    def test_keeps_window_prunes_old(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for i in range(40):                       # 0..39 天前各一份
                (root / _name(i)).write_bytes(b"x")
            (root / "note.txt").write_bytes(b"x")     # 非快照文件不触碰
            snap._prune_snapshots(root)
            left = sorted(f.name for f in root.glob("studio-*.db"))
            self.assertEqual(len(left), snap.SNAPSHOT_RETAIN_DAYS + 1)   # 保留窗：当天 + 前 30 天
            self.assertNotIn(_name(39), left)
            self.assertIn(_name(29), left)
            self.assertTrue((root / "note.txt").exists())


class TestEnsureDaily(unittest.TestCase):
    def test_makes_then_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            src = root / "src.db"
            c = sqlite3.connect(str(src))
            c.execute("CREATE TABLE x(y)")
            c.commit()
            c.close()
            snap_root = root / "snaps"
            made = snap.ensure_daily_snapshot(db_path=str(src), snap_root=str(snap_root))
            files = list(snap_root.glob("studio-*.db"))
            self.assertEqual(len(files), 1)
            os_mtime = files[0].stat().st_mtime
            again = snap.ensure_daily_snapshot(db_path=str(src), snap_root=str(snap_root))
            self.assertIsNone(again)                  # 幂等：不再重做
            self.assertEqual(len(list(snap_root.glob("studio-*.db"))), 1)
            self.assertEqual(list(snap_root.glob("studio-*.db"))[0].stat().st_mtime, os_mtime)


if __name__ == "__main__":
    unittest.main()
