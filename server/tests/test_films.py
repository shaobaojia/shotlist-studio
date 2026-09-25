#!/usr/bin/env python3
"""工程域（M8）：列表统计 / 新建（空白·复制深拷）/ 重命名 / 归档 / 删除（留底+级联）/ 多工程寻址 / 粘贴（咬合点）。"""
import json
import shutil
import tempfile
import unittest
from contextlib import contextmanager
from unittest import mock

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from api import films as films_api  # noqa: E402
from api import handlers  # noqa: E402
from api import params  # noqa: E402
from core import db, fields, ops, paths  # noqa: E402
from _fixture import fake_rw, make_conn  # noqa: E402


def make_films_db():
    """基准：甲乙两工程；甲含 1 场（1 节拍 2 镜 1 组）；乙空。"""
    con = make_conn()
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


@contextmanager
def _temp_snap_root():
    """仓库内临时目录（P0·S1-W15：path 列恒仓库相对）。"""
    td = tempfile.mkdtemp(dir=paths.ROOT)
    try:
        yield td
    finally:
        shutil.rmtree(td, ignore_errors=True)


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
        self.assertEqual(films[1]["last_edit"], films[1]["updated_at"])   # 无痕迹 → 回退 updated_at（精确）

    def test_last_edit_prefers_history(self):
        con = make_films_db()
        con.execute("UPDATE films SET updated_at='2020-01-01 00:00:00' WHERE id=1")
        con.execute("INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, at)"
                    " VALUES (1, 'shots', 1, 'blocking', 'a', 'b', '2024-05-05 05:05:05')")
        con.commit()
        f = ops.list_films(con)[0]
        self.assertEqual(f["last_edit"], "2024-05-05 05:05:05")           # 场内痕迹优先（精确位）


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

    def test_copy_null_refs(self):
        """孤儿镜头（beat_id / prompt_group_id 为 NULL）深拷不崩、归属仍空。"""
        con = make_films_db()
        con.execute("INSERT INTO shots (scene_id, position, shot_no, blocking) VALUES (1, 3, '03', '孤儿')")
        con.commit()
        f = ops.create_film(con, "含孤儿", copy_from=1)
        nsc = con.execute("SELECT id FROM scenes WHERE film_id=?", (f["id"],)).fetchone()[0]
        rows = con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position", (nsc,)).fetchall()
        self.assertEqual(len(rows), 3)
        orphan = [r for r in rows if r["shot_no"] == "03"][0]
        self.assertIsNone(orphan["beat_id"])
        self.assertIsNone(orphan["prompt_group_id"])
        self.assertEqual(orphan["blocking"], "孤儿")

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
        with _temp_snap_root() as td:
            out = ops.delete_film(con, 1, snap_root=td)
            p = paths.ROOT / out["snapshot"]["path"]     # 仓库相对 → 拼根存在
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

    def test_only_target_film_removed(self):
        con = make_films_db()
        with _temp_snap_root() as td:
            ops.delete_film(con, 2, snap_root=td)
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
        con.execute("INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value)"
                    " VALUES (NULL, 'films', 1, 'title', '甲工程', '甲改')")     # 工程级痕迹
        con.commit()
        only1 = ops.history_of(con, None, 100, 1)
        self.assertEqual([h["scene_id"] for h in only1 if h["scene_id"] is not None], [1])
        self.assertTrue(any(h["entity"] == "films" for h in only1))          # 工程级痕迹入滤（M8 清理刀）
        self.assertEqual(len(ops.history_of(con, None, 100)), 3)             # 不传 film → 全量


class TestSceneNoScoped(unittest.TestCase):
    """场号唯一性按工程（M8 清理刀）：跨工程互不影响。"""

    def test_next_no_per_film(self):
        con = make_films_db()
        sc = ops.create_scene(con, 2)                 # 乙（空）→ s010（按工程起算，非全库顺延 s020）
        self.assertEqual(sc["scene_no"], "s010")
        sc2 = ops.create_scene(con, 1)                # 甲（有 s010）→ s020（甲内顺延）
        self.assertEqual(sc2["scene_no"], "s020")

    def test_cross_film_no_reuse(self):
        """跨工程重号可用（旧实现：全库判重 → 误拒）。"""
        con = make_films_db()
        ops.create_scene(con, 2)                                            # 乙 s010
        sid = con.execute("SELECT id FROM scenes WHERE film_id=2").fetchone()[0]
        ops.update_field(con, "scenes", sid, "scene_no", "s900")            # 乙改独立号
        a_id = con.execute("SELECT id FROM scenes WHERE film_id=1").fetchone()[0]
        row, changed = ops.update_field(con, "scenes", a_id, "scene_no", "s900")   # 甲用乙已占的 s900
        self.assertTrue(changed)                                            # 跨工程同名放行
        self.assertEqual(row["scene_no"], "s900")

    def test_no_conflict_within_film(self):
        """工程内唯一不变量保持。"""
        con = make_films_db()
        ops.create_scene(con, 2)                       # 乙 s010
        sc2 = ops.create_scene(con, 2)                 # 乙 s020
        with self.assertRaises(ValueError):
            ops.update_field(con, "scenes", sc2["id"], "scene_no", "s010")   # 乙内撞号 → 拒


class TestParamsGuards(unittest.TestCase):
    """?film= / ?id= 参数守卫与 ids 收编（M8 清理刀）。"""

    def test_opt_int_q(self):
        self.assertIsNone(params.opt_int_q({}, "film"))                  # 缺省
        self.assertIsNone(params.opt_int_q({"film": []}, "film"))        # 空值
        self.assertEqual(params.opt_int_q({"film": ["7"]}, "film"), 7)   # 合法
        with self.assertRaises(ValueError):
            params.opt_int_q({"film": ["x"]}, "film")                    # 非法 → ValueError

    def test_film_handler_bad_q_400(self):
        obj, code = handlers.film(None, {"id": ["x"]})                   # 守卫先于连接（无 DB 访问）
        self.assertEqual(code, 400)
        self.assertIn("id", obj["error"])

    def test_req_ids(self):
        self.assertEqual(params.req_ids({"ids": [1, 2]}, "ids"), [1, 2])
        with self.assertRaises(ValueError):
            params.req_ids({"ids": []}, "ids")
        with self.assertRaises(ValueError):
            params.req_ids({"ids": [1]}, "ids", max_n=0)
        with self.assertRaises(ValueError):
            params.req_ids({"ids": [1, "x"]}, "ids")


class TestFilmOpEnvelope(unittest.TestCase):
    """API 层信封：film_op 写后附全量 films（F3-L4 口径）。"""

    def test_op_response_carries_films(self):
        con = make_films_db()
        with mock.patch("core.db.conn_rw", fake_rw(con)):
            obj, code = films_api.film_op(_M("create"), {"title": "信封片"}, None)
        self.assertEqual(code, 200)
        self.assertTrue(obj["ok"])
        self.assertEqual(obj["film"]["title"], "信封片")
        self.assertEqual(len(obj["films"]), 3)           # 全量（含新建）
        self.assertIn("scene_count", obj["films"][0])

    def test_op_blank_title_400_domain(self):
        """title 空白：内容规则归域层（_clean_title），precheck 只拦类型。"""
        con = make_films_db()
        with mock.patch("core.db.conn_rw", fake_rw(con)):
            obj, code = films_api.film_op(_M("create"), {"title": "  "}, None)
        self.assertEqual(code, 400)
        self.assertIn("工程名", obj["error"])

    def test_op_missing_title_400(self):
        con = make_films_db()
        with mock.patch("core.db.conn_rw", fake_rw(con)):
            obj, code = films_api.film_op(_M("create"), {}, None)
        self.assertEqual(code, 400)
        self.assertIn("title", obj["error"])

    def test_archive_default_true(self):
        con = make_films_db()
        with mock.patch("core.db.conn_rw", fake_rw(con)):
            obj, code = films_api.film_op(_M("archive"), {"id": 1}, None)
        self.assertEqual(code, 200)
        self.assertEqual(obj["film"]["archived"], 1)     # 缺省 archived=True（咬合）


class TestPasteShots(unittest.TestCase):
    """跨工程/跨场粘贴（M8 刀B）。"""

    def test_cross_film_paste(self):
        con = make_films_db()
        con.execute("INSERT INTO scenes (film_id, position, scene_no, title) VALUES (2, 0, 's001', '乙场')")
        con.commit()
        tsc = con.execute("SELECT id FROM scenes WHERE film_id=2").fetchone()[0]
        src = [r["id"] for r in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
        out = ops.paste_shots(con, src, tsc)
        self.assertEqual(out["count"], 2)
        self.assertEqual(out["shot_nos"], ["01", "02"])
        news = con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position", (tsc,)).fetchall()
        self.assertEqual(len(news), 2)
        self.assertTrue(all(r["scene_id"] == tsc for r in news))
        self.assertTrue(all(r["beat_id"] is None for r in news))          # 未归节拍
        self.assertTrue(all(r["prompt_group_id"] is None for r in news))  # 无组
        self.assertEqual(news[0]["blocking"], "动作一")                    # 内容随拷
        self.assertEqual(con.execute("SELECT COUNT(*) FROM shots WHERE scene_id=1").fetchone()[0], 2)   # 源不受影响
        h = con.execute("SELECT COUNT(*) FROM history WHERE scene_id=? AND entity='shots' AND field='create'",
                        (tsc,)).fetchone()[0]
        self.assertEqual(h, 2)

    def test_paste_appends_numbering(self):
        con = make_films_db()
        src = [r["id"] for r in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
        out = ops.paste_shots(con, src, 1)                               # 同场粘贴
        self.assertEqual(out["shot_nos"], ["03", "04"])                  # 顺延
        self.assertEqual(con.execute("SELECT COUNT(*) FROM shots WHERE scene_id=1").fetchone()[0], 4)

    def test_paste_dedup_src_ids(self):
        con = make_films_db()
        sid = con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position").fetchone()[0]
        out = ops.paste_shots(con, [sid, sid], 1)                        # 同 id 出现两次 → 只拷一行
        self.assertEqual(out["count"], 1)

    def test_paste_missing_source(self):
        con = make_films_db()
        with self.assertRaises(ValueError):
            ops.paste_shots(con, [999], 1)

    def test_paste_bad_params_400(self):
        con = make_films_db()
        with mock.patch("core.db.conn_rw", fake_rw(con)):
            obj, code = films_api.paste_op(None, {"scene_id": 1, "ids": []}, None)
        self.assertEqual(code, 400)
        self.assertIn("ids", obj["error"])

    def test_paste_over_limit_400(self):
        con = make_films_db()
        over = list(range(1, fields.BATCH_MAX + 2))                      # 超一行
        with mock.patch("core.db.conn_rw", fake_rw(con)):
            obj, code = films_api.paste_op(None, {"scene_id": 1, "ids": over}, None)
        self.assertEqual(code, 400)
        self.assertIn("一次最多", obj["error"])


if __name__ == "__main__":
    unittest.main()
