#!/usr/bin/env python3
"""core/prompts.py 无头回归（stdlib unittest，直跑：python3 server/tests/test_prompts.py -v）。"""
import copy
import json
import sqlite3
import sys
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

from core import ops, prompts  # noqa: E402

SCHEMA = (SERVER / "schema.sql").read_text(encoding="utf-8")


def make_db():
    """1 场：镜 01–07（位 1–7）；组 g1=01/02、g2=03/04、g3=05；06/07 无组。"""
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    con.execute("INSERT INTO films (title) VALUES ('t')")
    con.execute("INSERT INTO scenes (film_id, scene_no, title) VALUES (1, 's010', '第一场')")
    con.execute("INSERT INTO beats (scene_id, beat_no, name) VALUES (1, '1', 'b1')")
    for i, no in enumerate(["01", "02", "03", "04", "05", "06", "07"], start=1):
        con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no) VALUES (1, 1, ?, ?)", (i, no))
    con.execute("INSERT INTO prompt_groups (id, scene_id, position, text) VALUES (1, 1, 0, '组一文本')")
    con.execute("INSERT INTO prompt_groups (id, scene_id, position, text) VALUES (2, 1, 1, '组二文本')")
    con.execute("INSERT INTO prompt_groups (id, scene_id, position, text) VALUES (3, 1, 2, '组五文本')")
    con.execute("UPDATE shots SET prompt_group_id=1 WHERE id IN (1,2)")
    con.execute("UPDATE shots SET prompt_group_id=2 WHERE id IN (3,4)")
    con.execute("UPDATE shots SET prompt_group_id=3 WHERE id=5")
    con.commit()
    return con


def gmap(con):
    return {g["id"]: g for g in prompts.prompt_state(con, 1)}


def hist_of(con, entity_id, field):
    return [dict(r) for r in con.execute(
        "SELECT * FROM history WHERE entity='prompt_groups' AND entity_id=? AND field=? ORDER BY id",
        (entity_id, field))]


def snap_of(con):
    return [{"id": g["id"], "text": g["text"], "shot_ids": list(g["member_ids"])}
            for g in prompts.prompt_state(con, 1)]


class TestSetText(unittest.TestCase):
    def test_set_and_history(self):
        con = make_db()
        res = prompts.set_group_text(con, 1, "新文")
        self.assertTrue(res["changed"])
        self.assertEqual(res["text"], "新文")
        self.assertEqual(con.execute("SELECT text FROM prompt_groups WHERE id=1").fetchone()["text"], "新文")
        h = hist_of(con, 1, "text")
        self.assertEqual(len(h), 1)
        self.assertEqual(h[0]["old_value"], "组一文本")
        self.assertEqual(h[0]["new_value"], "新文")
        self.assertEqual(h[0]["scene_id"], 1)

    def test_same_noop(self):
        con = make_db()
        res = prompts.set_group_text(con, 1, "组一文本")
        self.assertFalse(res["changed"])
        self.assertEqual(con.execute(
            "SELECT COUNT(*) AS n FROM history WHERE entity='prompt_groups'").fetchone()["n"], 0)

    def test_clear_and_missing(self):
        con = make_db()
        prompts.set_group_text(con, 1, "")
        self.assertEqual(con.execute("SELECT text FROM prompt_groups WHERE id=1").fetchone()["text"], "")
        with self.assertRaises(ValueError):
            prompts.set_group_text(con, 999, "x")


class TestMerge(unittest.TestCase):
    def test_keeps_first_text_and_membership(self):
        con = make_db()
        prompts.merge_shots(con, [3, 4, 5])
        g = gmap(con)
        self.assertNotIn(3, g)  # 来源组已删
        self.assertEqual(g[2]["member_shots"], ["03", "04", "05"])
        self.assertEqual(g[2]["text"], "组二文本")
        self.assertEqual(g[2]["position"], 1)
        m = hist_of(con, 3, "merge")
        self.assertEqual(len(m), 1)
        self.assertEqual(m[0]["old_value"], "组五文本")  # 文本可找回
        self.assertIn("已并入", m[0]["new_value"])
        mi = hist_of(con, 2, "merge_in")
        self.assertEqual(len(mi), 1)
        self.assertIn("＋", mi[0]["new_value"])
        self.assertIn("05", mi[0]["new_value"])

    def test_merge_with_ungrouped(self):
        con = make_db()
        prompts.merge_shots(con, [5, 6])
        g = gmap(con)
        self.assertEqual(g[3]["member_shots"], ["05", "06"])
        self.assertEqual(g[3]["text"], "组五文本")
        self.assertEqual(len(hist_of(con, 3, "merge")), 0)  # 来源未空：不记
        self.assertEqual(len(hist_of(con, 3, "merge_in")), 1)

    def test_same_group_noop(self):
        con = make_db()
        before = copy.deepcopy(gmap(con))
        prompts.merge_shots(con, [3, 4])
        g = gmap(con)
        self.assertEqual(g[2]["member_shots"], before[2]["member_shots"])
        self.assertEqual(con.execute(
            "SELECT COUNT(*) AS n FROM history WHERE entity='prompt_groups'").fetchone()["n"], 0)

    def test_creates_new_group(self):
        con = make_db()
        prompts.merge_shots(con, [6, 7])
        st = prompts.prompt_state(con, 1)
        newg = [x for x in st if x["member_shots"] == ["06", "07"]]
        self.assertEqual(len(newg), 1)
        self.assertIsNone(newg[0]["text"])
        mi = [h for h in con.execute(
            "SELECT * FROM history WHERE entity='prompt_groups' AND field='merge_in'")]
        self.assertIn("新建组", mi[0]["new_value"])

    def test_single_ungrouped_creates_group(self):
        con = make_db()
        prompts.merge_shots(con, [6])
        g = gmap(con)
        holder = [x for x in g.values() if x["member_shots"] == ["06"]]
        self.assertEqual(len(holder), 1)
        self.assertIsNone(holder[0]["text"])
        h = list(con.execute("SELECT * FROM history WHERE field='create'"))
        self.assertEqual(len(h), 1)
        before = con.execute("SELECT COUNT(*) AS n FROM prompt_groups").fetchone()["n"]
        prompts.merge_shots(con, [1])  # 已组单镜：无操作
        self.assertEqual(con.execute("SELECT COUNT(*) AS n FROM prompt_groups").fetchone()["n"], before)

    def test_errors(self):
        con = make_db()
        con.execute("INSERT INTO scenes (film_id, scene_no, title) VALUES (1, 's020', '第二场')")
        con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no) VALUES (2, NULL, 1, '01')")
        con.commit()
        with self.assertRaises(ValueError):
            prompts.merge_shots(con, [1, 8])


class TestDetach(unittest.TestCase):
    def test_detach_one(self):
        con = make_db()
        prompts.detach_shots(con, [4])
        g = gmap(con)
        self.assertEqual(g[2]["member_shots"], ["03"])
        shot4 = con.execute("SELECT prompt_group_id FROM shots WHERE id=4").fetchone()["prompt_group_id"]
        self.assertNotEqual(shot4, 2)
        self.assertIsNone(con.execute("SELECT text FROM prompt_groups WHERE id=?", (shot4,)).fetchone()["text"])
        h = hist_of(con, 2, "detach")
        self.assertEqual(h[0]["old_value"], "镜03 / 04")
        self.assertIn("拆出 04", h[0]["new_value"])

    def test_alone_and_ungrouped_noop(self):
        con = make_db()
        prompts.detach_shots(con, [5])
        prompts.detach_shots(con, [6, 7])
        self.assertEqual(con.execute(
            "SELECT COUNT(*) AS n FROM history WHERE entity='prompt_groups'").fetchone()["n"], 0)
        self.assertEqual(len(gmap(con)), 3)

    def test_all_out_text_follows_first(self):
        con = make_db()
        prompts.detach_shots(con, [3, 4])
        g = gmap(con)
        self.assertNotIn(2, g)  # 原组全空 → 删
        holder = [x for x in g.values() if x["text"] == "组二文本"]
        self.assertEqual(len(holder), 1)
        self.assertEqual(holder[0]["member_shots"], ["03"])  # 文本随首镜
        h = hist_of(con, 2, "detach")
        self.assertIn("全部拆出", h[0]["new_value"])
        self.assertIn("文本随镜03保留", h[0]["new_value"])


class TestSplit(unittest.TestCase):
    def test_split_keeps_text_on_first(self):
        con = make_db()
        prompts.split_group(con, 2)
        g = gmap(con)
        self.assertEqual(g[2]["member_shots"], ["03"])
        self.assertEqual(g[2]["text"], "组二文本")
        shot4 = con.execute("SELECT prompt_group_id FROM shots WHERE id=4").fetchone()["prompt_group_id"]
        self.assertIsNone(con.execute("SELECT text FROM prompt_groups WHERE id=?", (shot4,)).fetchone()["text"])
        h = hist_of(con, 2, "split")
        self.assertEqual(h[0]["old_value"], "镜03 / 04")
        self.assertEqual(h[0]["new_value"], "镜03（拆出 04）")

    def test_split_alone_noop_and_missing(self):
        con = make_db()
        prompts.split_group(con, 3)
        self.assertEqual(len(gmap(con)), 3)
        with self.assertRaises(ValueError):
            prompts.split_group(con, 999)


class TestRestore(unittest.TestCase):
    def test_roundtrip_after_merge(self):
        con = make_db()
        snap = json.loads(json.dumps(snap_of(con)))
        prompts.merge_shots(con, [3, 4, 5])
        prompts.restore_state(con, 1, snap)
        g = gmap(con)
        self.assertEqual(sorted(g.keys()), [1, 2, 3])
        self.assertEqual(g[2]["member_shots"], ["03", "04"])
        self.assertEqual(g[3]["member_shots"], ["05"])
        self.assertEqual(g[3]["text"], "组五文本")

    def test_roundtrip_after_split(self):
        con = make_db()
        snap = json.loads(json.dumps(snap_of(con)))
        prompts.split_group(con, 2)
        prompts.restore_state(con, 1, snap)
        g = gmap(con)
        self.assertEqual(sorted(g.keys()), [1, 2, 3])
        self.assertEqual(g[2]["member_shots"], ["03", "04"])

    def test_restore_new_group_and_delete_strays(self):
        con = make_db()
        st = [{"id": 1, "text": "组一文本", "shot_ids": [1, 2]},
              {"id": None, "text": "新组", "shot_ids": [3, 4]}]
        prompts.restore_state(con, 1, st)
        g = gmap(con)
        self.assertEqual(len(g), 2)
        self.assertEqual(g[1]["member_shots"], ["01", "02"])
        newg = [x for x in g.values() if x["text"] == "新组"]
        self.assertEqual(newg[0]["member_shots"], ["03", "04"])
        left6 = con.execute("SELECT prompt_group_id FROM shots WHERE id=6").fetchone()["prompt_group_id"]
        self.assertIsNone(left6)

    def test_errors(self):
        con = make_db()
        with self.assertRaises(ValueError):
            prompts.restore_state(con, 1, [{"id": 1, "text": "x", "shot_ids": [999]}])
        with self.assertRaises(ValueError):
            prompts.restore_state(con, 999, [])
        with self.assertRaises(ValueError):
            prompts.restore_state(con, 1, "nope")


class TestBlocks(unittest.TestCase):
    def test_crud_and_order(self):
        con = make_db()
        c1 = prompts.cat_create(con, "骨架")
        c2 = prompts.cat_create(con, "风格")
        b1 = prompts.block_create(con, "块A", c1["id"])
        b2 = prompts.block_create(con, "块B", c1["id"])
        b3 = prompts.block_create(con, "块C", None)
        self.assertEqual(b2["position"], 1)
        prompts.block_move(con, b2["id"], -1)
        st = prompts.blocks_state(con)
        order = [b["text"] for b in st["blocks"] if b["category_id"] == c1["id"]]
        self.assertEqual(order, ["块B", "块A"])
        b1 = prompts.block_update(con, b1["id"], {"pinned": True, "text": "块A改"})
        self.assertEqual(b1["pinned"], 1)
        self.assertEqual(b1["text"], "块A改")
        prompts.block_update(con, b3["id"], {"category_id": c2["id"]})
        self.assertEqual(con.execute("SELECT category_id FROM blocks WHERE id=?", (b3["id"],)).fetchone()[0], c2["id"])
        deleted = prompts.block_delete(con, b2["id"])
        self.assertEqual(deleted["text"], "块B")
        prompts.cat_delete(con, c1["id"])
        self.assertIsNone(con.execute("SELECT category_id FROM blocks WHERE id=?", (b1["id"],)).fetchone()[0])
        prompts.cat_update(con, c2["id"], "风格改")
        self.assertEqual(con.execute(
            "SELECT name FROM block_categories WHERE id=?", (c2["id"],)).fetchone()["name"], "风格改")

    def test_update_position_and_drag_semantics(self):
        con = make_db()
        c1 = prompts.cat_create(con, "A")
        c2 = prompts.cat_create(con, "B")
        a1 = prompts.block_create(con, "a1", c1["id"])
        a2 = prompts.block_create(con, "a2", c1["id"])
        a3 = prompts.block_create(con, "a3", c1["id"])
        # 同分类重排：a3 移到最前
        prompts.block_update(con, a3["id"], {"position": 0})
        order = [x["text"] for x in prompts.blocks_state(con)["blocks"] if x["category_id"] == c1["id"]]
        self.assertEqual(order, ["a3", "a1", "a2"])
        # 跨分类带位置：a1 插到 B 类 idx0
        b0 = prompts.block_create(con, "b0", c2["id"])
        prompts.block_update(con, a1["id"], {"category_id": c2["id"], "position": 0})
        o2 = [x["text"] for x in prompts.blocks_state(con)["blocks"] if x["category_id"] == c2["id"]]
        self.assertEqual(o2, ["a1", "b0"])
        # 源分类重排连续
        src = [x["text"] for x in prompts.blocks_state(con)["blocks"] if x["category_id"] == c1["id"]]
        self.assertEqual(src, ["a3", "a2"])
        # 越界夹取到末尾
        prompts.block_update(con, a2["id"], {"category_id": c2["id"], "position": 99})
        o3 = [x["text"] for x in prompts.blocks_state(con)["blocks"] if x["category_id"] == c2["id"]]
        self.assertEqual(o3, ["a1", "b0", "a2"])
        # 缺省 position：仍为末尾（兼容旧行为）
        prompts.block_update(con, a3["id"], {"category_id": c2["id"]})
        o4 = [x["text"] for x in prompts.blocks_state(con)["blocks"] if x["category_id"] == c2["id"]]
        self.assertEqual(o4, ["a1", "b0", "a2", "a3"])
        # 换回未分类 + 位置无效参数
        prompts.block_update(con, b0["id"], {"category_id": None, "position": 0})
        self.assertIsNone(con.execute("SELECT category_id FROM blocks WHERE id=?", (b0["id"],)).fetchone()[0])
        with self.assertRaises(ValueError):
            prompts.block_update(con, b0["id"], {"position": "x"})

    def test_cat_move_and_errors(self):
        con = make_db()
        c1 = prompts.cat_create(con, "A")
        c2 = prompts.cat_create(con, "B")
        prompts.cat_move(con, c2["id"], -1)
        cats = [c["name"] for c in prompts.blocks_state(con)["categories"]]
        self.assertEqual(cats, ["B", "A"])
        with self.assertRaises(ValueError):
            prompts.block_create(con, "  ")
        with self.assertRaises(ValueError):
            prompts.block_create(con, "x", 999)
        with self.assertRaises(ValueError):
            prompts.cat_move(con, c1["id"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
