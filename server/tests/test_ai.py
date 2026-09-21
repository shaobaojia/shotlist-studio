#!/usr/bin/env python3
"""AI 创作通道单测（M4b-1）：配方装载 / 目标校验 / 预览任务（注入 stub、零网络）/ 应用落库。"""
import json
import os
import sqlite3
import sys
import tempfile
import time as _t
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import rewrite  # noqa: E402
from _fixture import make_audit_db  # noqa: E402


def _prep(con):
    """给审计夹具补上创作域文本。"""
    con.execute("UPDATE shots SET blocking='男人看着手机' WHERE shot_no='01'")
    con.execute("UPDATE shots SET blocking='他等着' WHERE shot_no='02'")
    con.execute("UPDATE shots SET blocking='' WHERE shot_no='03'")
    con.execute("UPDATE shots SET dialogue='「喂？」' WHERE shot_no='02'")
    con.execute("UPDATE beats SET beat_action='男人误发消息' WHERE beat_no='2'")
    con.commit()


def stub_items(mapping, inbox=None):
    """按 {i: after} 造模型回包；inbox 收集 messages 供断言。"""
    def stub(cfg, messages):
        if inbox is not None:
            inbox.append(messages)
        return json.dumps({"items": [{"i": i, "after": a} for i, a in mapping.items()]},
                          ensure_ascii=False)
    return stub


class TestRecipes(unittest.TestCase):
    def test_all_recipes_loadable(self):
        for name in list(rewrite.ACTIONS.values()) + [rewrite.CMDBAR_RECIPE]:
            body = rewrite.load_recipe(name)
            self.assertIn('"items"', body)
            self.assertGreater(len(body), 200)

    def test_missing_recipe_raises(self):
        with self.assertRaises(ValueError):
            rewrite.load_recipe("nope.md")


class Base(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.td.name, "rw.db")
        seed = make_audit_db(self.path)
        _prep(seed)
        seed.close()

    def tearDown(self):
        self.td.cleanup()

    def factory(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.execute("PRAGMA foreign_keys=ON")
        c.row_factory = sqlite3.Row
        return c

    def preview(self, targets, **kw):
        m = rewrite.PreviewJobs()
        job = m.start(1, targets, connect_factory=self.factory, **kw)
        deadline = _t.time() + 15
        while _t.time() < deadline:
            j = m.get(job["id"])
            if j and not j["running"]:
                return m, j
            _t.sleep(0.05)
        raise AssertionError("preview job 未在限时内完成")

    def shot_val(self, no, field="blocking"):
        con = self.factory()
        try:
            return con.execute("SELECT * FROM shots WHERE shot_no=?", (no,)).fetchone()[field]
        finally:
            con.close()

    def history(self):
        con = self.factory()
        try:
            return [dict(r) for r in con.execute("SELECT * FROM history ORDER BY id")]
        finally:
            con.close()

    def tshot(self, no, field="blocking"):
        con = self.factory()
        try:
            rid = con.execute("SELECT id FROM shots WHERE shot_no=?", (no,)).fetchone()["id"]
            return {"table": "shots", "id": rid, "field": field}
        finally:
            con.close()


class TestPreview(Base):
    def test_action_single_ok(self):
        inbox = []
        m, j = self.preview([self.tshot("01")], action="concretize",
                            chat=stub_items({0: "男人的视线钉在手机屏幕上"}, inbox))
        it = j["items"][0]
        self.assertEqual(it["before"], "男人看着手机")
        self.assertEqual(it["after"], "男人的视线钉在手机屏幕上")
        self.assertIsNone(it["error"])
        self.assertEqual(it["label"], "镜01 · 动作调度")
        self.assertEqual(j["mode"], "action")
        self.assertGreaterEqual(j["ms"], 0)
        self.assertEqual(j["done"], 1)
        msgs = inbox[0]
        self.assertIn("具象化", msgs[0]["content"])       # system = 配方
        self.assertIn("男人看着手机", msgs[1]["content"])   # user 含原文
        self.assertIn("镜头速览", msgs[1]["content"])
        # 预览零写入
        self.assertEqual(self.shot_val("01"), "男人看着手机")
        self.assertEqual(len(self.history()), 0)

    def test_cmdbar_multi_and_instruction(self):
        inbox = []
        m, j = self.preview([self.tshot("01"), self.tshot("02")],
                            instruction="把这两格都具象化",
                            chat=stub_items({0: "A", 1: "B"}, inbox))
        self.assertEqual(j["mode"], "cmdbar")
        self.assertEqual(j["instruction"], "把这两格都具象化")
        self.assertEqual([it["after"] for it in j["items"]], ["A", "B"])
        msgs = inbox[0]
        self.assertIn("【用户命令】把这两格都具象化", msgs[1]["content"])
        self.assertIn("序号 0", msgs[1]["content"])
        self.assertIn("序号 1", msgs[1]["content"])

    def test_pre_error_empty_text(self):
        inbox = []
        m, j = self.preview([self.tshot("03"), self.tshot("01")],
                            action="rewrite",
                            chat=stub_items({1: "NEW"}, inbox))
        items = j["items"]
        self.assertEqual(items[0]["error"], "原文为空")
        self.assertEqual(items[1]["after"], "NEW")
        self.assertIn("序号 1", inbox[0][1]["content"])
        self.assertNotIn("序号 0", inbox[0][1]["content"])   # 空条目不送模型
        self.assertEqual(j["done"], 2)

    def test_partial_output_marks_missing(self):
        m, j = self.preview([self.tshot("01"), self.tshot("02")],
                            action="rewrite", chat=stub_items({0: "A"}))
        self.assertEqual(j["items"][0]["after"], "A")
        self.assertIn("未返回", j["items"][1]["error"])

    def test_garbage_output(self):
        def bad(cfg, messages):
            return "抱歉，我无法完成这个任务。"
        m, j = self.preview([self.tshot("01")], action="rewrite", chat=bad)
        self.assertIsNone(j["items"][0]["after"])
        self.assertIn("未返回", j["items"][0]["error"])

    def test_stub_exception(self):
        def boom(cfg, messages):
            raise RuntimeError("boom")
        m, j = self.preview([self.tshot("01")], action="rewrite", chat=boom)
        self.assertIn("boom", j["items"][0]["error"])
        self.assertIn("boom", j["error"] or "")

    def test_text_target(self):
        m, j = self.preview([{"kind": "text", "text": "他愣住", "label": "选段"}],
                            action="expand",
                            chat=stub_items({0: "他愣在原地，喉结滚了一下"}))
        it = j["items"][0]
        self.assertEqual(it["kind"], "text")
        self.assertEqual(it["after"], "他愣在原地，喉结滚了一下")

    def test_validation_errors(self):
        m = rewrite.PreviewJobs()
        f = self.factory
        with self.assertRaises(ValueError):
            m.start(1, [], action="rewrite", connect_factory=f)
        with self.assertRaises(ValueError):
            m.start(1, [self.tshot("01")] * 31, action="rewrite", connect_factory=f)
        with self.assertRaises(ValueError):
            m.start(1, [self.tshot("01")], connect_factory=f)          # 无 action/instruction
        with self.assertRaises(ValueError):
            m.start(1, [self.tshot("01")], action="nope", connect_factory=f)
        with self.assertRaises(ValueError):
            m.start(1, [self.tshot("01")], action="rewrite", instruction="x",
                    connect_factory=f)                                  # 两个都给
        with self.assertRaises(ValueError):
            m.start(1, [{"table": "shots", "id": 1, "field": "spatial"}],
                    action="rewrite", connect_factory=f)                # 字段不受支持
        with self.assertRaises(ValueError):
            m.start(1, [{"table": "shots", "id": 9999, "field": "blocking"}],
                    action="rewrite", connect_factory=f)                # 行不存在
        with self.assertRaises(ValueError):
            m.start(1, [{"table": "beats", "id": 1, "field": "name"}],
                    action="rewrite", connect_factory=f)
        with self.assertRaises(ValueError):
            m.start(999, [self.tshot("01")], action="rewrite", connect_factory=f)


class TestApply(Base):
    def _mkjob(self, mapping, targets=None, **kw):
        targets = targets or [self.tshot("01"), self.tshot("02")]
        m, j = self.preview(targets, action="rewrite",
                            chat=stub_items(mapping), **kw)
        return m, j

    def test_apply_all(self):
        m, j = self._mkjob({0: "新甲", 1: "新乙"})
        con = self.factory()
        try:
            res = rewrite.apply_items(con, m.get(j["id"]))
        finally:
            con.close()
        self.assertEqual(res["applied"], 2)
        self.assertEqual(res["submitted"], 2)
        self.assertEqual(res["skipped"], [])
        self.assertEqual(res["results"][0]["i"], 0)
        self.assertEqual(self.shot_val("01"), "新甲")
        self.assertEqual(self.shot_val("02"), "新乙")
        hist = self.history()
        self.assertEqual(len(hist), 2)
        self.assertTrue(all(h["source"] == "ai" for h in hist))
        self.assertEqual(hist[0]["old_value"], "男人看着手机")
        self.assertEqual(hist[0]["new_value"], "新甲")

    def test_apply_duplicate_targets_keep_last(self):
        """同一 (表,行,字段) 多条目 → 只应用最后一条（回归：曾双写覆盖+幽灵痕迹）。"""
        t = self.tshot("01")
        m, j = self._mkjob({0: "先到", 1: "后到"}, targets=[t, t])
        self.assertEqual(len(j["items"]), 2)
        con = self.factory()
        try:
            res = rewrite.apply_items(con, m.get(j["id"]))
        finally:
            con.close()
        self.assertEqual(res["applied"], 1)
        self.assertEqual(res["submitted"], 1)
        self.assertEqual(self.shot_val("01"), "后到")
        self.assertEqual(len(self.history()), 1)
        self.assertIn("重复目标", res["skipped"][0]["reason"])

    def test_apply_subset(self):
        m, j = self._mkjob({0: "新甲", 1: "新乙"})
        con = self.factory()
        try:
            res = rewrite.apply_items(con, m.get(j["id"]), item_ids=[1])
        finally:
            con.close()
        self.assertEqual(res["applied"], 1)
        self.assertEqual(self.shot_val("01"), "男人看着手机")
        self.assertEqual(self.shot_val("02"), "新乙")

    def test_apply_stale_skip(self):
        m, j = self._mkjob({0: "新甲"})
        con = self.factory()
        try:
            con.execute("UPDATE shots SET blocking='手工改过了' WHERE id=?",
                        (j["items"][0]["id"],))
            con.commit()
            res = rewrite.apply_items(con, m.get(j["id"]))
        finally:
            con.close()
        self.assertEqual(res["applied"], 0)
        self.assertIn("原值已变", res["skipped"][0]["reason"])
        self.assertEqual(self.shot_val("01"), "手工改过了")

    def test_apply_text_target_skipped(self):
        m, j = self.preview([{"kind": "text", "text": "他愣住"}], action="expand",
                            chat=stub_items({0: "他愣在原地"}))
        con = self.factory()
        try:
            res = rewrite.apply_items(con, m.get(j["id"]))
        finally:
            con.close()
        self.assertEqual(res["applied"], 0)
        self.assertIn("非入库目标", res["skipped"][0]["reason"])

    def test_apply_guards(self):
        m, j = self._mkjob({0: "x"})
        con = self.factory()
        try:
            with self.assertRaises(ValueError):
                rewrite.apply_items(con, None)                  # 无任务
            m2 = rewrite.PreviewJobs()

            def slow(cfg, messages):
                _t.sleep(0.6)
                return '{"items":[{"i":0,"after":"慢稿"}]}'
            j2 = m2.start(1, [self.tshot("01")], action="rewrite",
                          chat=slow, connect_factory=self.factory)
            with self.assertRaises(ValueError):
                rewrite.apply_items(con, m2.get(j2["id"]))      # 未跑完
            dl = _t.time() + 10
            while _t.time() < dl and m2.get(j2["id"])["running"]:
                _t.sleep(0.1)
        finally:
            con.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
