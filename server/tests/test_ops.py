#!/usr/bin/env python3
"""core/ops.py 无头回归（stdlib unittest，直跑：python3 server/tests/test_ops.py -v）。"""
import sqlite3
import sys
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

from core import fields, ops  # noqa: E402

SCHEMA = (SERVER / "schema.sql").read_text(encoding="utf-8")


def make_db():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    con.execute("INSERT INTO films (title) VALUES ('t')")
    con.execute("INSERT INTO scenes (film_id, scene_no, title, value) VALUES (1, 's010', '第一场', '控制')")
    con.execute("INSERT INTO beats (scene_id, beat_no, name, kind) VALUES (1, '1', '被领导打压', '⚪ 填充')")
    for i, no in enumerate(["03", "01", "17A"], start=1):
        con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no, blocking) VALUES (1, 1, ?, ?, ?)",
                    (i, no, "动作%d" % i))
    con.commit()
    return con


class TestWriteKeys(unittest.TestCase):
    def test_shots_excludes_prompt(self):
        keys = ops.write_keys("shots")
        self.assertIn("shot_no", keys)
        self.assertIn("director_note", keys)
        self.assertNotIn("prompt", keys)
        self.assertNotIn("position", keys)

    def test_beats_and_scenes_keys(self):
        self.assertIn("kind", ops.write_keys("beats"))
        self.assertIn("value", ops.write_keys("scenes"))
        self.assertEqual(ops.write_keys("nonsense"), [])


class TestUpdateField(unittest.TestCase):
    def test_update_writes_row_and_history(self):
        con = make_db()
        row, changed = ops.update_field(con, "shots", 1, "director_note", "加个标记")
        self.assertTrue(changed)
        self.assertEqual(row["director_note"], "加个标记")
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(h[0]["entity"], "shots")
        self.assertEqual(h[0]["field"], "director_note")
        self.assertEqual(h[0]["old_value"], None)
        self.assertEqual(h[0]["new_value"], "加个标记")
        self.assertEqual(h[0]["source"], "manual")

    def test_update_same_value_noop(self):
        con = make_db()
        ops.update_field(con, "shots", 1, "blocking", "动作1")
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(len(h), 0)  # 无变化不记痕

    def test_update_rejects_unknown_field(self):
        con = make_db()
        with self.assertRaises(ValueError):
            ops.update_field(con, "shots", 1, "id", "9")
        with self.assertRaises(ValueError):
            ops.update_field(con, "shots", 1, "prompt", "x")
        with self.assertRaises(ValueError):
            ops.update_field(con, "nonsense", 1, "x", "y")

    def test_update_beats_and_scenes(self):
        con = make_db()
        ops.update_field(con, "beats", 1, "kind", "🔴 戏点")
        ops.update_field(con, "scenes", 1, "value", "失控")
        self.assertEqual(con.execute("SELECT kind FROM beats WHERE id=1").fetchone()["kind"], "🔴 戏点")
        self.assertEqual(con.execute("SELECT value FROM scenes WHERE id=1").fetchone()["value"], "失控")


class TestRenumber(unittest.TestCase):
    def test_renumber_by_position(self):
        con = make_db()
        changes = ops.renumber_scene(con, 1)
        self.assertEqual(len(changes), 3)
        rows = con.execute("SELECT shot_no FROM shots WHERE scene_id=1 ORDER BY position").fetchall()
        self.assertEqual([r["shot_no"] for r in rows], ["01", "02", "03"])
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(len(h), 3)
        self.assertTrue(all(x["source"] == "system" for x in h))

    def test_renumber_idempotent(self):
        con = make_db()
        ops.renumber_scene(con, 1)
        again = ops.renumber_scene(con, 1)
        self.assertEqual(again, [])


class TestMove(unittest.TestCase):
    def make(self):
        con = make_db()  # 基准：beat id1；shots id1/2/3（全在 beat1）
        con.execute("UPDATE beats SET position=0, beat_no='b1', name='b1' WHERE id=1")
        con.execute("INSERT INTO beats (scene_id, position, beat_no, name) VALUES (1, 1, 'b2', 'b2')")
        con.execute("UPDATE shots SET beat_id=1, position=0 WHERE id=1")
        con.execute("UPDATE shots SET beat_id=1, position=1 WHERE id=2")
        con.execute("UPDATE shots SET beat_id=2, position=2 WHERE id=3")
        con.commit()
        return con

    def test_move_within_beat(self):
        con = self.make()
        r = ops.move_shot(con, 1, 1, 1)  # s1 在 b1 内挪到 s2 之后
        self.assertTrue(r["changed"])
        ids = [x["id"] for x in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(ids, [2, 1, 3])

    def test_move_cross_beat(self):
        con = self.make()
        b2 = con.execute("SELECT id FROM beats WHERE beat_no='b2'").fetchone()["id"]
        r = ops.move_shot(con, 1, b2, 1)  # s1 放到 b2 的 s3 之后
        self.assertTrue(r["changed"])
        order = [x["id"] for x in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(order, [2, 3, 1])
        self.assertEqual(con.execute("SELECT beat_id FROM shots WHERE id=1").fetchone()["beat_id"], b2)
        pos = [x["position"] for x in con.execute("SELECT position FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(pos, [0, 1, 2])

    def test_move_to_empty_beat(self):
        con = self.make()
        con.execute("INSERT INTO beats (scene_id, position, beat_no, name) VALUES (1, 2, 'b3', 'b3')")
        con.commit()
        b3 = con.execute("SELECT id FROM beats WHERE beat_no='b3'").fetchone()["id"]
        r = ops.move_shot(con, 3, b3, 0)
        self.assertTrue(r["changed"])
        bids = [x["beat_id"] for x in con.execute("SELECT beat_id FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(bids, [1, 1, b3])

    def test_move_noop(self):
        con = self.make()
        r = ops.move_shot(con, 2, 1, 1)  # s2 落回 b1 原位
        self.assertFalse(r["changed"])

    def test_move_history_recorded(self):
        con = self.make()
        b2 = con.execute("SELECT id FROM beats WHERE beat_no='b2'").fetchone()["id"]
        ops.move_shot(con, 1, b2, 0)
        rows = con.execute("SELECT * FROM history WHERE field='drag'").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source"], "manual")

    def test_move_beat_reorders_shots(self):
        con = self.make()
        b2 = con.execute("SELECT id FROM beats WHERE beat_no='b2'").fetchone()["id"]
        r = ops.move_beat(con, b2, 0)
        self.assertTrue(r["changed"])
        order = [x["id"] for x in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(order, [3, 1, 2])
        bpos = [x["id"] for x in con.execute("SELECT id FROM beats WHERE scene_id=1 ORDER BY position, id")]
        self.assertEqual(bpos[0], b2)

    def test_move_beat_noop(self):
        con = self.make()
        b2 = con.execute("SELECT id FROM beats WHERE beat_no='b2'").fetchone()["id"]
        r = ops.move_beat(con, b2, 1)
        self.assertFalse(r["changed"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
