#!/usr/bin/env python3
"""工程域（M8）：列表统计 / 新建（空白·复制深拷）/ 重命名 / 归档 / 删除（留底+级联）/ 多工程寻址（咬合点）。"""
import json
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from unittest import mock

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from api import films as films_api  # noqa: E402
from core import db, ops  # noqa: E402

SCHEMA = (_boot.SERVER / "schema.sql").read_text(encoding="utf-8")


def _conn():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


def make_films_db():
    """基准：甲乙两工程；甲含 1 场（1 节拍 2 镜 1 组）；乙空。"""
    con = _conn()
    con.execute("INSERT INTO films (title) VALUES ('甲工程')")
    con.execute("INSERT INTO films (title) VALUES ('乙工程')")
    con.execute("INSERT INTO scenes (film_id, position, scene_no, title) VALUES (1, 0, 's010', '第一场')")
    con.execute("INSERT INTO beats (scene_id, position, beat_no, name) VALUES (1, 0, '1', 'b1')")
    con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no, blocking) VALUES (1, 1, 1, '01', '动作一')")
    con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no, blocking) VALUES (1, 1, 2, '02', '动作二')")
    cur = con.execute("INSERT INTO prompt_groups (scene_id, position, text) VALUES (1, 0, '组一')")
    gid = cur.lastrowid
    con.execute("UPDATE shots SET prompt_group_id=? WHERE shot_no='01'", (gid,))
    con.commit()
    return con


class _M:
    """假 match：m.group(1) → action。"""

    def __init__(self, action):
        self._a = action

    def group(self, i):
        return self._a


class TestListFilms(unittest.TestCase):
    def test_stats(self):
        con = make_films_db()
        films = ops.list_films(con)
        self.assertEqual([f["title"] for f in films], ["甲工程", "乙工程"])
        self.assertEqual(films[0]["scene_count"], 1)
        self.assertEqual(films[0]["shot_count"], 2)
        self.assertEqual(films[1]["scene_count"], 0)
        self.assertIsNotNone(films[1]["last_edit"])      # 无痕迹 → 回退 updated_at

    def test_last_edit_prefers_history(self):
        con = make_films_db()
        con.execute("UPDATE films SET updated_at='2020-01-01 00:00:00' WHERE id=1")
        con.execute("INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value)"
                    " VALUES (1, 'shots', 1, 'blocking', 'a', 'b')")
        con.commit()
        f = ops.list_films(con)[0]
        self.assertNotEqual(f["last_edit"], "2020-01-01 00:00:00")   # 场内痕迹优先


class TestCreateFilm(unittest.TestCase):
    def test_blank(self):
        con = make_films_db()
        f = ops.create_film(con, "  新 片  ")
        self.assertEqual(f["title"], "新 片")
        self.assertEqual(
            con.execute("SELECT COUNT(*) FROM scenes WHERE film_id=?", (f["id"],)).fetchone()[0], 0)
        h = con.execute("SELECT * FROM history WHERE entity='films' AND entity_id=? AND field='create'",
                        (f["id"],)).fetchone()
        self.assertIsNotNone(h)
        self.assertEqual(h["new_value"], "新 片")

    def test_copy_deep(self):
        con = make_films_db()
        f = ops.create_film(con, "甲副本", copy_from=1)
        scenes = con.execute("SELECT * FROM scenes WHERE film_id=?", (f["id"],)).fetchall()
        self.assertEqual(len(scenes), 1)
        nsc = scenes[0]["id"]
        self.assertNotEqual(nsc, 1)                      # id 全重映射
        self.assertEqual(
            con.execute("SELECT COUNT(*) FROM beats WHERE scene_id=?", (nsc,)).fetchone()[0], 1)
        shots = con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position", (nsc,)).fetchall()
        self.assertEqual(len(shots), 2)
        self.assertEqual(shots[0]["blocking"], "动作一")   # 内容拷贝
        gid = shots[0]["prompt_group_id"]
        self.assertIsNotNone(gid)                        # 组映射：指向新组
        self.assertEqual(
            con.execute("SELECT scene_id FROM prompt_groups WHERE id=?", (gid,)).fetchone()[0], nsc)
        con.execute("UPDATE shots SET blocking='改' WHERE id=?", (shots[0]["id"],))   # 副本独立
        self.assertEqual(con.execute(
            "SELECT blocking FROM shots WHERE shot_no='01' AND scene_id=1").fetchone()[0], "动作一")
        self.assertEqual(json.loads(f["meta"])["copied_from"], 1)     # meta 记来源

    def test_title_guards(self):
        con = make_films_db()
        with self.assertRaises(ValueError):
            ops.create_film(con, "   ")
        with self.assertRaises(ValueError):
            ops.create_film(con, "x" * 61)

    def test_copy_from_missing(self):
        con = make_films_db()
        with self.assertRaises(ValueError):
            ops.create_film(con, "无源", copy_from=999)


class TestRenameArchive(unittest.TestCase):
    def test_rename_changed(self):
        con = make_films_db()
        out = ops.rename_film(con, 1, "甲改")
        self.assertTrue(out["changed"])
        self.assertEqual(out["film"]["title"], "甲改")
        h = con.execute("SELECT * FROM history WHERE entity='films' AND field='title'").fetchone()
        self.assertEqual((h["old_value"], h["new_value"]), ("甲工程", "甲改"))

    def test_rename_same_noop(self):
        con = make_films_db()
        out = ops.rename_film(con, 1, "甲工程")
        self.assertFalse(out["changed"])
        self.assertEqual(con.execute(
            "SELECT COUNT(*) FROM history WHERE entity='films' AND field='title'").fetchone()[0], 0)

    def test_archive_roundtrip(self):
        con = make_films_db()
        ops.archive_film(con, 1, True)
        self.assertEqual(ops.list_films(con)[-1]["id"], 1)          # 归档排后
        ops.archive_film(con, 1, False)
        self.assertEqual(ops.list_films(con)[0]["id"], 1)


class TestDeleteFilm(unittest.TestCase):
    def test_cascade_and_snapshot(self):
        con = make_films_db()
        repo = ops.db.DB_PATH.parent.parent
        td = tempfile.mkdtemp(dir=repo)                  # 仓库内临时目录（P0·S1-W15 口径）
        try:
            out = ops.delete_film(con, 1, snap_root=td)
            p = repo / out["snapshot"]["path"]           # 仓库相对 → 拼根存在
            self.assertTrue(p.exists())
            payload = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(payload["film"]["title"], "甲工程")
            self.assertEqual(len(payload["scenes"]), 1)
            self.assertEqual(len(payload["scenes"][0]["shots"]), 2)
            snap = con.execute("SELECT * FROM snapshots WHERE scope='film'").fetchone()
            self.assertEqual(snap["kind"], "manual")
            self.assertEqual(snap["label"], "甲工程")
            self.assertEqual(snap["path"], out["snapshot"]["path"])
            self.assertEqual(con.execute("SELECT COUNT(*) FROM scenes").fetchone()[0], 0)         # 级联全清
            self.assertEqual(con.execute("SELECT COUNT(*) FROM beats").fetchone()[0], 0)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM shots").fetchone()[0], 0)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM prompt_groups").fetchone()[0], 0)
            h = con.execute("SELECT * FROM history WHERE entity='films' AND field='delete'").fetchone()
            self.assertEqual(h["old_value"], "甲工程")
        finally:
            shutil.rmtree(td, ignore_errors=True)

    def test_only_target_film_removed(self):
        con = make_films_db()
        repo = ops.db.DB_PATH.parent.parent
        td = tempfile.mkdtemp(dir=repo)
        try:
            ops.delete_film(con, 2, snap_root=td)
        finally:
            shutil.rmtree(td, ignore_errors=True)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM films").fetchone()[0], 1)
        self.assertEqual(con.execute("SELECT id FROM films").fetchone()[0], 1)


class TestMultiFilmAddressing(unittest.TestCase):
    """多工程寻址（咬合点：旧实现永远取第一行）。"""

    def test_same_scene_no_two_films(self):
        con = make_films_db()
        con.execute("INSERT INTO scenes (film_id, position, scene_no, title) VALUES (2, 0, 's010', '乙场')")
        con.commit()
        _f1, sc1 = db.load_scene(con, "s010", 1)
        _f2, sc2 = db.load_scene(con, "s010", 2)
        self.assertEqual(sc1["title"], "第一场")
        self.assertEqual(sc2["title"], "乙场")
        _f0, sc0 = db.load_scene(con, "s010")            # 缺省＝第一行（兼容）
        self.assertEqual(sc0["title"], "第一场")

    def test_create_scene_into_film2(self):
        con = make_films_db()
        sc2 = ops.create_scene(con, 2)
        self.assertEqual(sc2["film_id"], 2)
        sc0 = ops.create_scene(con)
        self.assertEqual(sc0["film_id"], 1)              # 缺省仍落第一行

    def test_history_film_filter(self):
        con = make_films_db()
        con.execute("INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value)"
                    " VALUES (1, 'shots', 1, 'blocking', 'a', 'b')")
        con.execute("INSERT INTO films (title) VALUES ('丙工程')")
        con.execute("INSERT INTO scenes (film_id, position, scene_no, title) VALUES (3, 0, 's001', '丙场')")
        con.execute("INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value)"
                    " VALUES (3, 'shots', 9, 'blocking', 'c', 'd')")
        con.commit()
        only1 = ops.history_of(con, None, 100, 1)
        self.assertEqual([h["scene_id"] for h in only1], [1])
        self.assertEqual(len(ops.history_of(con, None, 100)), 2)     # 不传 film → 全量


class TestFilmOpEnvelope(unittest.TestCase):
    """API 层信封：film_op 写后附全量 films（F3-L4 口径）。"""

    def test_op_response_carries_films(self):
        con = make_films_db()

        @contextmanager
        def fake_rw(db_path=None):
            yield con

        with mock.patch("core.db.conn_rw", fake_rw):
            obj, code = films_api.film_op(_M("create"), {"title": "信封片"}, None)
        self.assertEqual(code, 200)
        self.assertTrue(obj["ok"])
        self.assertEqual(obj["film"]["title"], "信封片")
        self.assertEqual(len(obj["films"]), 3)           # 全量（含新建）
        self.assertIn("scene_count", obj["films"][0])

    def test_op_bad_params_400(self):
        con = make_films_db()

        @contextmanager
        def fake_rw(db_path=None):
            yield con

        with mock.patch("core.db.conn_rw", fake_rw):
            obj, code = films_api.film_op(_M("create"), {"title": "  "}, None)
        self.assertEqual(code, 400)
        self.assertIn("title", obj["error"])


if __name__ == "__main__":
    unittest.main()
