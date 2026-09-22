#!/usr/bin/env python3
"""core/ops.py 无头回归（stdlib unittest，直跑：python3 server/tests/test_ops.py -v）。"""
import sys
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import fields, ops  # noqa: E402
from _fixture import make_ops_db as make_db, make_ops_db0 as make_db0  # noqa: E402


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

    def test_conditional_write_guards_lost_update(self):
        """P5 条件写：迟到者不得静默覆盖新值；守卫失败走 ValueError（不写、不记痕）。"""
        import unittest.mock as mock
        con = make_db()
        ops.update_field(con, "shots", 1, "director_note", "甲")
        ops.update_field(con, "shots", 1, "director_note", "乙")     # 另一写者先行落笔
        self.assertFalse(ops._guarded_set(con, "shots", "director_note", 1, "甲", "丙"))  # 携旧值 → 被拒
        self.assertEqual(con.execute("SELECT director_note FROM shots WHERE id=1").fetchone()["director_note"], "乙")
        self.assertTrue(ops._guarded_set(con, "shots", "director_note", 1, "乙", "丙"))   # 现值相符 → 照写
        h0 = len(ops.history_of(con, scene_id=1))
        with mock.patch.object(ops, "_guarded_set", return_value=False):
            with self.assertRaises(ValueError):
                ops.update_field(con, "shots", 1, "director_note", "丁")
        self.assertEqual(len(ops.history_of(con, scene_id=1)), h0)
        self.assertEqual(con.execute("SELECT director_note FROM shots WHERE id=1").fetchone()["director_note"], "丙")


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


class TestMoveShots(unittest.TestCase):
    """M5 批2：多行整组搬家（move_shots）。"""

    def make(self):
        con = make_db()  # 基准：beat id1；shots 1/2/3 全在 beat1（position 0/1/2）
        return con

    def make2(self):
        con = make_db()
        con.execute("UPDATE beats SET position=0, beat_no='b1', name='b1' WHERE id=1")
        con.execute("INSERT INTO beats (scene_id, position, beat_no, name) VALUES (1, 1, 'b2', 'b2')")
        con.execute("UPDATE shots SET beat_id=1, position=0 WHERE id=1")
        con.execute("UPDATE shots SET beat_id=1, position=1 WHERE id=2")
        con.execute("UPDATE shots SET beat_id=2, position=2 WHERE id=3")
        con.commit()
        return con

    def order(self, con):
        return [x["id"] for x in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]

    def bids(self, con):
        return [x["beat_id"] for x in con.execute("SELECT beat_id FROM shots WHERE scene_id=1 ORDER BY position")]

    def b2id(self, con):
        return con.execute("SELECT id FROM beats WHERE beat_no='b2'").fetchone()["id"]

    def test_group_within_beat(self):
        con = self.make()
        r = ops.move_shots(con, [1, 2], 1, 1)   # 组[1,2] 挪到 s3 之后（去掉组后 b1=[3]）
        self.assertTrue(r["changed"])
        self.assertEqual(self.order(con), [3, 1, 2])

    def test_group_cross_beat(self):
        con = self.make2()
        b2 = self.b2id(con)
        r = ops.move_shots(con, [1, 2], b2, 1)  # 整组插到 s3 之后
        self.assertTrue(r["changed"])
        self.assertEqual(self.order(con), [3, 1, 2])
        self.assertEqual(self.bids(con), [b2, b2, b2])

    def test_group_noop(self):
        con = self.make2()
        r = ops.move_shots(con, [1, 2], 1, 0)   # 组已在 b1 原位
        self.assertFalse(r["changed"])

    def test_group_order_and_dupes(self):
        con = self.make2()
        b2 = self.b2id(con)
        r = ops.move_shots(con, [2, 1, 1], b2, 1)  # 乱序+重复入参：组按场序去重
        self.assertTrue(r["changed"])
        self.assertEqual(r["ids"], [1, 2])
        self.assertEqual(self.order(con), [3, 1, 2])

    def test_group_round_trip_undo(self):
        con = self.make2()
        b2 = self.b2id(con)
        before = self.order(con)
        before_bids = self.bids(con)
        ops.move_shots(con, [1, 2], b2, 1)
        ops.move_shots(con, [1, 2], 1, 0)          # 撤销：搬回 b1 起始位
        self.assertEqual(self.order(con), before)
        self.assertEqual(self.bids(con), before_bids)

    def test_group_history_rows(self):
        con = self.make2()
        b2 = self.b2id(con)
        ops.move_shots(con, [1, 2], b2, 1)
        hist = con.execute("SELECT * FROM history WHERE field='drag'").fetchall()
        self.assertEqual(len(hist), 2)
        self.assertTrue(all(h["source"] == "manual" for h in hist))

    def test_group_missing_shot(self):
        con = self.make2()
        b2 = self.b2id(con)
        with self.assertRaises(ValueError):
            ops.move_shots(con, [1, 999], b2, 0)


class TestBatch(unittest.TestCase):
    def test_batch_mixed(self):
        con = make_db()
        items = [
            {"table": "shots", "id": 1, "field": "director_note", "value": "A"},
            {"table": "shots", "id": 2, "field": "director_note", "value": "B"},
            {"table": "shots", "id": 2, "field": "director_note", "value": "B"},   # 无变化
            {"table": "shots", "id": 3, "field": "id", "value": "9"},              # 白名单外
            {"table": "shots", "id": 999, "field": "director_note", "value": "X"},  # 行不存在
        ]
        res = ops.batch_update(con, items)
        self.assertEqual(res["changed"], 2)
        r = res["results"]
        self.assertTrue(r[0]["changed"])
        self.assertTrue(r[1]["changed"])
        self.assertFalse(r[2]["changed"])
        self.assertIn("error", r[3])
        self.assertIn("error", r[4])
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(len(h), 2)
        got = con.execute("SELECT director_note FROM shots WHERE id=1").fetchone()["director_note"]
        self.assertEqual(got, "A")

    def test_batch_single_commit_visible(self):
        con = make_db()
        ops.batch_update(con, [{"table": "shots", "id": 1, "field": "dialogue", "value": "x"}])
        got = con.execute("SELECT dialogue FROM shots WHERE id=1").fetchone()["dialogue"]
        self.assertEqual(got, "x")
        self.assertEqual(len(ops.history_of(con, scene_id=1)), 1)


class TestDuplicateDelete(unittest.TestCase):
    def test_duplicate_inserts_after_source(self):
        con = make_db()
        shot = ops.duplicate_shot(con, 1)  # id1='03' 在 pos1
        self.assertEqual(shot["shot_no"], "03A")
        self.assertEqual(shot["position"], 2)
        self.assertEqual(shot["beat_id"], 1)
        self.assertEqual(shot["blocking"], "动作1")
        order = [x["id"] for x in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(order, [1, shot["id"], 2, 3])

    def test_duplicate_suffix_increments(self):
        con = make_db()
        a = ops.duplicate_shot(con, 1)
        b = ops.duplicate_shot(con, 1)
        self.assertEqual([a["shot_no"], b["shot_no"]], ["03A", "03B"])
        c = ops.duplicate_shot(con, 3)  # 源 '17A' → '17B'
        self.assertEqual(c["shot_no"], "17B")

    def test_duplicate_history(self):
        con = make_db()
        ops.duplicate_shot(con, 1)
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(len(h), 1)
        self.assertEqual(h[0]["field"], "create")
        self.assertEqual(h[0]["old_value"], "03")
        self.assertEqual(h[0]["new_value"], "03A")

    def test_delete_compacts(self):
        con = make_db()
        shot = ops.duplicate_shot(con, 1)
        res = ops.delete_shot(con, shot["id"])
        self.assertEqual(res["shot_no"], "03A")
        order = [x["id"] for x in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(order, [1, 2, 3])
        fields = [r["field"] for r in con.execute("SELECT field FROM history ORDER BY id")]
        self.assertEqual(fields, ["create", "delete"])

    def test_delete_missing(self):
        con = make_db()
        with self.assertRaises(ValueError):
            ops.delete_shot(con, 999)





# ══════════ M2-6 结构操作（三层增删插复移）══════════

class TestBlankShot(unittest.TestCase):
    def test_insert_mid_suffix(self):
        con = make_db0()
        # 序：[03, 01, 17A]；在 03 之后（index 1）
        s = ops.create_blank_shot(con, 1, 1, 1)
        self.assertEqual(s["shot_no"], "03A")
        self.assertEqual(s["position"], 1)
        nos = [r["shot_no"] for r in con.execute("SELECT shot_no FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(nos, ["03", "03A", "01", "17A"])
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(h[0]["field"], "create")
        self.assertEqual(h[0]["new_value"], "03A")

    def test_insert_first_edge(self):
        con = make_db0()
        s = ops.create_blank_shot(con, 1, 1, 0)
        self.assertEqual(s["position"], 0)
        self.assertEqual(s["shot_no"], "03A")

    def test_append_sequential(self):
        con = make_db0()
        s = ops.create_blank_shot(con, 1, 1, 3)  # 追尾（index == 行数）
        self.assertEqual(s["shot_no"], "18")     # 最大数字 17 +1
        self.assertEqual(s["position"], 3)

    def test_empty_scene_first_shots(self):
        con = make_db0()
        con.execute("INSERT INTO scenes (film_id, scene_no, title) VALUES (1, 's020', '二')")
        sid = con.execute("SELECT id FROM scenes WHERE scene_no='s020'").fetchone()["id"]
        s1 = ops.create_blank_shot(con, sid, None, 0)
        s2 = ops.create_blank_shot(con, sid, None, 1)
        self.assertEqual([s1["shot_no"], s2["shot_no"]], ["01", "02"])

    def test_bad_beat_rejected(self):
        con = make_db0()
        with self.assertRaises(ValueError):
            ops.create_blank_shot(con, 1, 999, 0)


class TestDeleteRestoreShots(unittest.TestCase):
    def test_multi_delete_and_restore_keeps_ids(self):
        con = make_db0()
        rows = ops.delete_shots(con, [1, 3])
        self.assertEqual([r["shot_no"] for r in rows], ["03", "17A"])
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM shots WHERE scene_id=1").fetchone()["c"], 1)
        p0 = con.execute("SELECT position FROM shots WHERE scene_id=1").fetchone()["position"]
        self.assertEqual(p0, 0)  # 位置致密
        back = ops.restore_shots(con, [dict(r) for r in rows])
        self.assertEqual([b["id"] for b in back], [1, 3])  # 原 id 复用（撤销栈寻址稳定）
        nos = [r["shot_no"] for r in con.execute("SELECT shot_no FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(nos, ["03", "01", "17A"])
        self.assertEqual(con.execute("SELECT blocking FROM shots WHERE id=3").fetchone()["blocking"], "动作3")

    def test_delete_shot_keeps_empty_group(self):
        """删镜不剪组：组成为空组（撤销载体，刻意保留），restore_shots 带组插回成功（审计 F11）。"""
        con = make_db0()
        con.execute("INSERT INTO prompt_groups (scene_id, position, text) VALUES (1, 0, '组文本')")
        gid = con.execute("SELECT id FROM prompt_groups").fetchone()["id"]
        con.execute("UPDATE shots SET prompt_group_id=? WHERE id=2", (gid,))
        con.commit()
        rows = ops.delete_shots(con, [2])
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM prompt_groups WHERE id=?", (gid,)).fetchone()["c"], 1)
        back = ops.restore_shots(con, [dict(r) for r in rows])
        self.assertEqual(back[0]["prompt_group_id"], gid)
        self.assertEqual(
            con.execute("SELECT prompt_group_id FROM shots WHERE id=2").fetchone()["prompt_group_id"], gid)

    def test_delete_missing_raises(self):
        con = make_db0()
        with self.assertRaises(ValueError):
            ops.delete_shots(con, [999])


class TestBeatsStruct(unittest.TestCase):
    def test_create_beat_append(self):
        con = make_db0()
        b = ops.create_beat(con, 1)
        self.assertEqual(b["beat_no"], "2")
        self.assertEqual(b["position"], 1)
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(h[0]["entity"], "beats")

    def test_duplicate_beat_deep(self):
        con = make_db0()
        nb = ops.duplicate_beat(con, 1)
        self.assertEqual(nb["beat_no"], "1A")
        self.assertEqual(nb["position"], 1)
        nos = [r["shot_no"] for r in con.execute("SELECT shot_no FROM shots WHERE scene_id=1 ORDER BY position")]
        self.assertEqual(nos, ["03", "01", "17A", "03A", "01A", "17B"])
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM shots WHERE beat_id=?", (nb["id"],)).fetchone()["c"], 3)

    def test_delete_beat_orphan_and_restore(self):
        con = make_db0()
        res = ops.delete_beat(con, 1)
        self.assertEqual(len(res["shot_ids"]), 3)
        self.assertIsNone(con.execute("SELECT beat_id FROM shots WHERE id=1").fetchone()["beat_id"])
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM beats WHERE scene_id=1").fetchone()["c"], 0)
        b = ops.restore_beat(con, res["beat"], res["shot_ids"])
        self.assertEqual(b["id"], 1)  # 原 id 复用
        self.assertEqual(con.execute("SELECT beat_id FROM shots WHERE id=1").fetchone()["beat_id"], 1)

    def test_delete_beat_with_shots(self):
        con = make_db0()
        ops.delete_beat(con, 1, with_shots=True)
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM shots WHERE scene_id=1").fetchone()["c"], 0)
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM beats WHERE scene_id=1").fetchone()["c"], 0)


class TestScenesStruct(unittest.TestCase):
    def test_create_scene_numbering(self):
        con = make_db0()
        s1 = ops.create_scene(con)
        self.assertEqual(s1["scene_no"], "s020")
        self.assertEqual(s1["position"], 1)
        s2 = ops.create_scene(con)
        self.assertEqual(s2["scene_no"], "s030")

    def test_move_scene(self):
        con = make_db0()
        s2 = ops.create_scene(con)
        res = ops.move_scene(con, s2["id"], 0)
        self.assertTrue(res["changed"])
        order = [r["scene_no"] for r in con.execute("SELECT scene_no FROM scenes ORDER BY position")]
        self.assertEqual(order, ["s020", "s010"])
        res2 = ops.move_scene(con, s2["id"], 0)
        self.assertFalse(res2["changed"])  # 原地不动 = noop

    def test_duplicate_scene_deep_and_restore(self):
        con = make_db0()
        con.execute("INSERT INTO prompt_groups (scene_id, position, text) VALUES (1, 0, '组文案')")
        gid = con.execute("SELECT id FROM prompt_groups WHERE scene_id=1").fetchone()["id"]
        con.execute("UPDATE shots SET prompt_group_id=? WHERE id=2", (gid,))
        con.commit()
        d = ops.duplicate_scene(con, 1)
        self.assertEqual(d["scene_no"], "s020")
        nid = d["id"]
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM beats WHERE scene_id=?", (nid,)).fetchone()["c"], 1)
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM shots WHERE scene_id=?", (nid,)).fetchone()["c"], 3)
        nos = [r["shot_no"] for r in con.execute("SELECT shot_no FROM shots WHERE scene_id=? ORDER BY position", (nid,))]
        self.assertEqual(nos, ["03", "01", "17A"])  # 新场镜号原样
        g2 = con.execute("SELECT id FROM prompt_groups WHERE scene_id=?", (nid,)).fetchone()
        self.assertIsNotNone(g2)
        m = con.execute("SELECT COUNT(*) c FROM shots WHERE scene_id=? AND prompt_group_id=?",
                        (nid, g2["id"])).fetchone()["c"]
        self.assertEqual(m, 1)  # 词组外键重连
        pay = ops.delete_scene(con, nid)
        self.assertEqual(len(pay["shots"]), 3)
        r = ops.restore_scene_full(con, pay)
        self.assertEqual(r["id"], nid)  # 原 id 复用
        self.assertEqual(con.execute("SELECT COUNT(*) c FROM shots WHERE scene_id=?", (nid,)).fetchone()["c"], 3)
        bid = con.execute("SELECT beat_id FROM shots WHERE scene_id=? AND shot_no='03'", (nid,)).fetchone()["beat_id"]
        self.assertIsNotNone(bid)  # 外键重连


class TestLockScene(unittest.TestCase):
    """M2-7 锁定本场：场次版本快照（JSON 落盘 + snapshots 记录）+ 锁定标记；解锁只清标记。"""

    def test_lock_writes_snapshot_row_and_flag(self):
        import json
        import tempfile
        con = make_db()
        with tempfile.TemporaryDirectory() as td:
            res = ops.lock_scene(con, 1, True, snap_root=td)
            self.assertEqual(res["scene"]["locked"], 1)
            snap = res["snapshot"]
            self.assertIsNotNone(snap)
            path = Path(snap["path"])
            self.assertTrue(path.exists())
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["scene"]["scene_no"], "s010")
            self.assertEqual(len(data["shots"]), 3)
            self.assertEqual(len(data["beats"]), 1)
        row = con.execute("SELECT * FROM snapshots").fetchone()
        self.assertEqual(row["scope"], "scene")
        self.assertEqual(row["kind"], "locked")
        self.assertEqual(row["label"], "s010")
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(h[0]["entity"], "scenes")
        self.assertEqual(h[0]["field"], "locked")
        self.assertEqual(h[0]["new_value"], "1")

    def test_unlock_clears_flag_without_snapshot(self):
        import tempfile
        con = make_db()
        with tempfile.TemporaryDirectory() as td:
            ops.lock_scene(con, 1, True, snap_root=td)
            res2 = ops.lock_scene(con, 1, False, snap_root=td)
        self.assertEqual(res2["scene"]["locked"], 0)
        self.assertIsNone(res2["snapshot"])
        c = con.execute("SELECT COUNT(*) c FROM snapshots").fetchone()["c"]
        self.assertEqual(c, 1)

    def test_lock_missing_scene_raises(self):
        con = make_db()
        with self.assertRaises(ValueError):
            ops.lock_scene(con, 999, True, snap_root="/tmp")


class TestAppendRows(unittest.TestCase):
    """L4 追加行原语：编号顺延 / 位置续尾 / 痕迹 / 不自行 commit（事务归调用方）。"""

    def setUp(self):
        self.con = make_db()

    def tearDown(self):
        self.con.close()

    def test_append_beats_sequential(self):
        ids = ops.append_beats(self.con, 1, [
            {"name": "新节拍", "kind": "⚪ 填充", "outside_action": "a", "reaction": "b",
             "closed_loop": "c"},
            {"name": "新节拍2", "kind": "🔴 戏点", "outside_action": "", "reaction": "",
             "closed_loop": ""}], source="ai")
        self.assertEqual(len(ids), 2)
        rows = [dict(r) for r in self.con.execute(
            "SELECT * FROM beats WHERE scene_id=1 ORDER BY position")]
        self.assertEqual([r["beat_no"] for r in rows], ["1", "2", "3"])
        self.assertEqual([r["position"] for r in rows], [0, 1, 2])
        hist = [dict(r) for r in self.con.execute("SELECT * FROM history WHERE entity='beats'")]
        self.assertEqual(len(hist), 2)
        self.assertEqual({h["source"] for h in hist}, {"ai"})
        self.assertEqual({h["new_value"] for h in hist}, {"2", "3"})

    def test_append_shots_sequential(self):
        ids = ops.append_shots(self.con, 1, [
            {"beat_id": 1, "camera_move": "推", "camera_pos": "🔴 正打", "blocking": "b1",
             "dialogue": "", "duration": "3"},
            {"beat_id": 1, "blocking": "b2"}], source="ai")
        self.assertEqual(len(ids), 2)
        rows = [dict(r) for r in self.con.execute(
            "SELECT * FROM shots WHERE id IN (?,?) ORDER BY position", ids)]
        self.assertEqual([r["shot_no"] for r in rows], ["18", "19"])   # 既有 03/01/17A → 最大 17 顺延
        self.assertEqual([r["position"] for r in rows], [4, 5])        # 既有 1..3 → 续尾
        self.assertEqual(rows[0]["camera_move"], "推")

    def test_append_empty_scene(self):
        cur = self.con.execute(
            "INSERT INTO scenes (film_id, scene_no, title) VALUES (1, 's020', '空场')")
        sid = cur.lastrowid
        self.con.commit()
        bids = ops.append_beats(self.con, sid, [{"name": "头", "kind": "⚪ 填充"}], source="ai")
        b = self.con.execute("SELECT * FROM beats WHERE id=?", (bids[0],)).fetchone()
        self.assertEqual((b["beat_no"], b["position"]), ("1", 0))
        sids = ops.append_shots(self.con, sid, [{"beat_id": bids[0], "blocking": "开篇"}], source="ai")
        s = self.con.execute("SELECT * FROM shots WHERE id=?", (sids[0],)).fetchone()
        self.assertEqual((s["shot_no"], s["position"]), ("01", 0))

    def test_not_committed_by_callee(self):
        """不自行 commit：回滚即无痕（事务归调用方）。"""
        ops.append_beats(self.con, 1, [{"name": "x", "kind": "⚪ 填充"}], source="ai")
        self.con.rollback()
        n = self.con.execute("SELECT COUNT(*) c FROM beats WHERE scene_id=1").fetchone()["c"]
        self.assertEqual(n, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestSceneScript(unittest.TestCase):
    """M5 批3b：scenes.script（台本）写白名单与痕迹。"""

    def test_script_writable_only_for_scenes(self):
        self.assertIn("script", ops.write_keys("scenes"))
        self.assertNotIn("script", ops.write_keys("shots"))
        self.assertNotIn("script", ops.write_keys("beats"))

    def test_script_update_and_history(self):
        con = make_db()
        row, changed = ops.update_field(con, "scenes", 1, "script", "s010 商场过道\n内景 商场 白天")
        self.assertTrue(changed)
        self.assertEqual(row["script"], "s010 商场过道\n内景 商场 白天")
        h = ops.history_of(con, scene_id=1)
        self.assertEqual(h[0]["entity"], "scenes")
        self.assertEqual(h[0]["field"], "script")

    def test_script_noop_no_history(self):
        con = make_db()
        ops.update_field(con, "scenes", 1, "script", "同一段")
        n = len(ops.history_of(con, scene_id=1))
        ops.update_field(con, "scenes", 1, "script", "同一段")
        self.assertEqual(len(ops.history_of(con, scene_id=1)), n)
