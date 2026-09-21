#!/usr/bin/env python3
"""草稿档单测（M4b-4）：两段生成（注入 stub、零网络）/ 解析规整 / 落入落库与顺延 / 组级初稿。"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time as _t
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import draft      # noqa: E402
from _fixture import conn_factory, make_base_db  # noqa: E402

SCRIPT = "内景 旧公寓客厅 深夜。男人坐在沙发上反复解锁手机，屏幕上没有新消息。他起身走到窗前拉开一条缝，对面楼的灯一盏盏灭着。"

BEATS_OK = {"beats": [
    {"name": "等消息", "kind": "⚪ 填充", "outside_action": "男人反复解锁手机",
     "reaction": "手指悬在屏幕上方", "closed_loop": "没有新消息"},
    {"name": "窗边张望", "kind": "乱七八糟", "outside_action": "走到窗前拉缝张望",
     "reaction": "犹豫", "closed_loop": "把窗帘拉上"},
    {"kind": "⚪ 填充"},                       # 空壳 → 丢弃
]}
SHOTS_OK = {"shots": [
    {"beat": 1, "camera_move": "固定", "camera_pos": "🟢 第三人称",
     "blocking": "男人坐沙发上反复解锁手机", "dialogue": "", "duration": "4"},
    {"beat": 2, "camera_move": "手持跟", "camera_pos": "正打",
     "blocking": "他走到窗前拉开一条缝", "dialogue": "", "duration": "5"},
    {"beat": 9, "blocking": "越界拍"},          # beat 越界 → 丢弃
]}


def stub(payloads, inbox=None):
    def fn(cfg, messages):
        if inbox is not None:
            inbox.append(messages)
        sysc = messages[0]["content"]
        if "草稿·节拍骨架" in sysc:
            return {"text": json.dumps(payloads.get("beats", {}), ensure_ascii=False)}
        if "草稿·镜头行" in sysc:
            return {"text": json.dumps(payloads.get("shots", {}), ensure_ascii=False)}
        return {"text": payloads.get("text", "初稿正文")}
    return fn


class Base(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.td.name, "draft.db")
        seed = make_base_db(self.path)
        seed.close()
        self.factory = conn_factory(self.path)

    def tearDown(self):
        self.td.cleanup()

    def mk_scene(self):
        con = self.factory()
        try:
            f = con.execute("SELECT id FROM films LIMIT 1").fetchone()
            fid = f["id"] if f else con.execute(
                "INSERT INTO films (title) VALUES ('测试片')").lastrowid
            cur = con.execute(
                "INSERT INTO scenes (film_id, position, scene_no, title) VALUES (?,?,?,?)",
                (fid, 99, "s99", "测试场"))
            con.commit()
            return cur.lastrowid
        finally:
            con.close()

    def mk_shot(self, sid, no, blocking="他拿起手机", pos=0):
        con = self.factory()
        try:
            cur = con.execute(
                "INSERT INTO shots (scene_id, position, shot_no, blocking) VALUES (?,?,?,?)",
                (sid, pos, no, blocking))
            con.commit()
            return cur.lastrowid
        finally:
            con.close()

    def wait(self, m, jid, timeout=15):
        deadline = _t.time() + timeout
        while _t.time() < deadline:
            j = m.get(jid)
            if j and not j["running"]:
                return j
            _t.sleep(0.05)
        raise AssertionError("job 未在限时内完成")

    def run_scene(self, sid, payloads, inbox=None, m=None):
        m = m or draft.DraftJobs()
        j = m.start_scene(sid, SCRIPT, chat=stub(payloads, inbox),
                          connect_factory=self.factory)
        return m, self.wait(m, j["id"])

    def rows(self, sql, args=()):
        con = self.factory()
        try:
            return [dict(r) for r in con.execute(sql, args)]
        finally:
            con.close()


class TestParse(unittest.TestCase):
    def test_beats_normalize(self):
        out = draft.parse_beats(json.dumps(BEATS_OK, ensure_ascii=False))
        self.assertEqual(len(out), 2)                     # 空壳被丢
        self.assertEqual(out[1]["kind"], "⚪ 填充")        # 坏 kind 归填充

    def test_shots_normalize(self):
        out = draft.parse_shots(json.dumps(SHOTS_OK, ensure_ascii=False), 2)
        self.assertEqual(len(out), 2)                     # 越界被丢
        self.assertEqual(out[1]["camera_pos"], "🔴 正打")  # 裸词「正打」→ 五色值

    def test_fence_strip(self):
        self.assertEqual(draft._strip_fence("```\n正文\n```"), "正文")
        self.assertEqual(draft._strip_fence("正文"), "正文")


class TestSceneFlow(Base):
    def test_full_flow(self):
        sid = self.mk_scene()
        inbox = []
        m, j = self.run_scene(sid, {"beats": BEATS_OK, "shots": SHOTS_OK}, inbox)
        self.assertIsNone(j["error"])
        self.assertEqual(len(j["beats"]), 2)
        self.assertEqual(len(j["shots"]), 2)
        self.assertEqual(j["stage"], "done")
        self.assertGreaterEqual(j["ms"], 0)
        self.assertEqual(len(inbox), 2)
        self.assertIn(SCRIPT, inbox[0][1]["content"])
        self.assertIn("【节拍骨架】", inbox[1][1]["content"])
        self.assertIn("1 ｜ 等消息", inbox[1][1]["content"])

    def test_reply_dict_form(self):
        """真调归一：chat 返回 {text,...} 字典时同样解析。"""
        def stub_dict(payloads):
            def fn(cfg, messages):
                sysc = messages[0]["content"]
                if "草稿·节拍骨架" in sysc:
                    return {"text": json.dumps(payloads["beats"], ensure_ascii=False), "ms": 1}
                if "草稿·镜头行" in sysc:
                    return {"text": json.dumps(payloads["shots"], ensure_ascii=False), "ms": 1}
                return {"text": payloads.get("text", "初稿正文"), "ms": 1}
            return fn
        sid = self.mk_scene()
        m = draft.DraftJobs()
        j = m.start_scene(sid, SCRIPT, chat=stub_dict({"beats": BEATS_OK, "shots": SHOTS_OK}),
                          connect_factory=self.factory)
        j = self.wait(m, j["id"])
        self.assertIsNone(j["error"])
        self.assertEqual(len(j["beats"]), 2)
        self.assertEqual(len(j["shots"]), 2)

    def test_rejects(self):
        m = draft.DraftJobs()
        # 台本太短 / 太长 / 场景不存在
        with self.assertRaises(ValueError):
            m.start_scene(1, "太短", chat=stub({}), connect_factory=self.factory)
        with self.assertRaises(ValueError):
            m.start_scene(1, "字" * 6001, chat=stub({}), connect_factory=self.factory)
        with self.assertRaises(ValueError):
            m.start_scene(99999, SCRIPT, chat=stub({}), connect_factory=self.factory)

    def test_empty_generation_errors(self):
        sid = self.mk_scene()
        m, j = self.run_scene(sid, {"beats": {"beats": []}, "shots": SHOTS_OK})
        self.assertIn("节拍骨架生成为空", j["error"] or "")
        with self.assertRaises(ValueError):
            m.apply(j["id"], connect_factory=self.factory)


class TestApply(Base):
    def test_apply_empty_scene(self):
        sid = self.mk_scene()
        m, j = self.run_scene(sid, {"beats": BEATS_OK, "shots": SHOTS_OK})
        res = m.apply(j["id"], connect_factory=self.factory)
        self.assertEqual(res["applied"], {"beats": 2, "shots": 2})
        bs = self.rows("SELECT * FROM beats WHERE scene_id=? ORDER BY position", (sid,))
        ss = self.rows("SELECT * FROM shots WHERE scene_id=? ORDER BY position", (sid,))
        self.assertEqual([b["beat_no"] for b in bs], ["1", "2"])
        self.assertEqual([b["name"] for b in bs], ["等消息", "窗边张望"])
        self.assertEqual(bs[1]["kind"], "⚪ 填充")
        self.assertEqual([s["shot_no"] for s in ss], ["01", "02"])
        self.assertEqual(ss[0]["beat_id"], bs[0]["id"])
        self.assertEqual(ss[1]["beat_id"], bs[1]["id"])
        self.assertEqual(ss[1]["camera_pos"], "🔴 正打")
        h = self.rows("SELECT * FROM history WHERE scene_id=?", (sid,))
        self.assertEqual(len(h), 4)
        self.assertTrue(all(r["source"] == "ai" and r["field"] == "create" for r in h))
        # 二次落入被拒
        with self.assertRaises(ValueError):
            m.apply(j["id"], connect_factory=self.factory)

    def test_apply_concurrent_single_write(self):
        """并发「落入」只放行一份（锁内认领）——回归：曾并发双写。"""
        sid = self.mk_scene()
        m, j = self.run_scene(sid, {"beats": BEATS_OK, "shots": SHOTS_OK})
        jid = j["id"]
        entered = threading.Event()
        gate = threading.Event()
        calls = []

        def factory():
            calls.append(threading.current_thread().name)
            if len(calls) == 1:
                entered.set()
                gate.wait(5)
            return self.factory()

        results = {}

        def worker(name):
            try:
                res = m.apply(jid, connect_factory=factory)
                results[name] = ("ok", res["applied"])
            except ValueError as e:
                results[name] = ("rej", str(e))

        t1 = threading.Thread(target=worker, args=("w1",), name="w1")
        t2 = threading.Thread(target=worker, args=("w2",), name="w2")
        t1.start()
        self.assertTrue(entered.wait(3))
        t2.start()
        t2.join(5)
        gate.set()
        t1.join(5)
        self.assertFalse(t1.is_alive() or t2.is_alive())
        ok = [k for k, v in results.items() if v[0] == "ok"]
        rej = [k for k, v in results.items() if v[0] == "rej"]
        self.assertEqual(len(ok), 1, results)
        self.assertEqual(len(rej), 1, results)
        self.assertIn("已落入过", results[rej[0]][1])
        self.assertEqual(results[ok[0]][1], {"beats": 2, "shots": 2})
        bs = self.rows("SELECT * FROM beats WHERE scene_id=?", (sid,))
        ss = self.rows("SELECT * FROM shots WHERE scene_id=?", (sid,))
        self.assertEqual(len(bs), 2)                      # 只写了一份
        self.assertEqual(len(ss), 2)

    def test_apply_appends(self):
        sid = self.mk_scene()
        con = self.factory()
        con.execute("INSERT INTO beats (scene_id, position, beat_no, name) VALUES (?,0,'1','旧拍')", (sid,))
        con.execute("INSERT INTO shots (scene_id, position, shot_no, blocking) VALUES (?,0,'01','旧镜')", (sid,))
        con.commit()
        con.close()
        m, j = self.run_scene(sid, {"beats": BEATS_OK, "shots": SHOTS_OK})
        res = m.apply(j["id"], connect_factory=self.factory)
        self.assertEqual(res["applied"], {"beats": 2, "shots": 2})
        bs = self.rows("SELECT * FROM beats WHERE scene_id=? ORDER BY position", (sid,))
        ss = self.rows("SELECT * FROM shots WHERE scene_id=? ORDER BY position", (sid,))
        self.assertEqual([b["beat_no"] for b in bs], ["1", "2", "3"])
        self.assertEqual([s["shot_no"] for s in ss], ["01", "02", "03"])
        self.assertEqual(bs[0]["name"], "旧拍")             # 既有行分毫未动

    def test_apply_guards(self):
        m = draft.DraftJobs()
        with self.assertRaises(ValueError):
            m.apply(999, connect_factory=self.factory)
        sid = self.mk_scene()
        sh = self.mk_shot(sid, "01")
        pj = m.start_prompt(sid, sh, chat=stub({"text": "初稿"}), connect_factory=self.factory)
        self.wait(m, pj["id"])
        with self.assertRaises(ValueError):
            m.apply(pj["id"], connect_factory=self.factory)


class TestPromptDraft(Base):
    def test_prompt_single_shot(self):
        sid = self.mk_scene()
        sh = self.mk_shot(sid, "01")
        inbox = []
        m = draft.DraftJobs()
        j = m.start_prompt(sid, sh, chat=stub({"text": "```\n镜头一：[镜01]\n空间关系：…\n```"}, inbox),
                           connect_factory=self.factory)
        j = self.wait(m, j["id"])
        self.assertIsNone(j["error"])
        self.assertEqual(j["text"], "镜头一：[镜01]\n空间关系：…")
        self.assertEqual(j["members"], ["01"])
        user = inbox[0][1]["content"]
        self.assertIn("镜01", user)

    def test_prompt_group_members_and_blocks(self):
        sid = self.mk_scene()
        s1 = self.mk_shot(sid, "01", pos=0)
        s2 = self.mk_shot(sid, "02", pos=1)
        con = self.factory()
        gid = con.execute("INSERT INTO prompt_groups (scene_id, position, text) VALUES (?,0,'')", (sid,)).lastrowid
        con.execute("UPDATE shots SET prompt_group_id=? WHERE id IN (?,?)", (gid, s1, s2))
        con.execute("INSERT INTO blocks (category_id, text, position) VALUES (NULL,'空间关系：基于@图片',0)")
        con.commit()
        con.close()
        inbox = []
        m = draft.DraftJobs()
        j = m.start_prompt(sid, s1, chat=stub({"text": "初稿"}, inbox), connect_factory=self.factory)
        j = self.wait(m, j["id"])
        self.assertEqual(j["members"], ["01", "02"])
        user = inbox[0][1]["content"]
        self.assertIn("镜01", user)
        self.assertIn("镜02", user)
        self.assertIn("【块库（可复用句式）】", user)
        self.assertIn("空间关系：基于@图片", user)

    def test_prompt_guards(self):
        m = draft.DraftJobs()
        sid = self.mk_scene()
        with self.assertRaises(ValueError):
            m.start_prompt(99999, 1, chat=stub({"text": "x"}), connect_factory=self.factory)
        with self.assertRaises(ValueError):
            m.start_prompt(sid, 99999, chat=stub({"text": "x"}), connect_factory=self.factory)

    def test_prompt_recipe_dispatch(self):
        """三份草稿配方现读可载（注册表口径）。"""
        for name in (draft.DRAFT_BEATS_RECIPE, draft.DRAFT_SHOTS_RECIPE, draft.DRAFT_PROMPT_RECIPE):
            body = draft.load_recipe(name)
            self.assertGreater(len(body), 200)


class TestGates(Base):
    def test_scene_join_running(self):
        """同场草稿在跑 → 并入同一任务（M10）。"""
        m = draft.DraftJobs()
        calls = []

        def slow(cfg, messages):
            calls.append(1)
            _t.sleep(0.5)
            if "草稿·节拍骨架" in messages[0]["content"]:
                return json.dumps(BEATS_OK, ensure_ascii=False)
            return json.dumps(SHOTS_OK, ensure_ascii=False)

        sid = self.mk_scene()
        j1 = m.start_scene(sid, SCRIPT, chat=slow, connect_factory=self.factory)
        j2 = m.start_scene(sid, SCRIPT, chat=slow, connect_factory=self.factory)
        self.assertTrue(j2.get("joined"))
        self.assertEqual(j2["id"], j1["id"])
        self.wait(m, j1["id"])

    def test_prompt_join_same_shot(self):
        """同一镜头初稿在跑 → 并入（M10）。"""
        m = draft.DraftJobs()

        def slow(cfg, messages):
            _t.sleep(0.4)
            return "初稿正文"

        sid = self.mk_scene()
        shid = self.mk_shot(sid, "01")
        j1 = m.start_prompt(sid, shid, chat=slow, connect_factory=self.factory)
        j2 = m.start_prompt(sid, shid, chat=slow, connect_factory=self.factory)
        self.assertTrue(j2.get("joined"))
        self.assertEqual(j2["id"], j1["id"])
        self.wait(m, j1["id"])

    def test_prompt_different_shots_both_run(self):
        """不同镜头各自成任务（并入只认同一镜头）。"""
        m = draft.DraftJobs()

        def slow(cfg, messages):
            _t.sleep(0.4)
            return "初稿正文"

        sid = self.mk_scene()
        s1 = self.mk_shot(sid, "01")
        s2 = self.mk_shot(sid, "02")
        j1 = m.start_prompt(sid, s1, chat=slow, connect_factory=self.factory)
        j2 = m.start_prompt(sid, s2, chat=slow, connect_factory=self.factory)
        self.assertFalse(j2.get("joined"))
        self.assertNotEqual(j2["id"], j1["id"])
        self.wait(m, j1["id"])
        self.wait(m, j2["id"])

    def test_get_light_while_running(self):
        """轮询期轻载（P7）：在跑时骨架正文不回传，数量字段保留（阶段提示用）。"""
        m = draft.DraftJobs()

        def slow(cfg, messages):
            _t.sleep(0.5)
            if "草稿·节拍骨架" in messages[0]["content"]:
                return json.dumps(BEATS_OK, ensure_ascii=False)
            return json.dumps(SHOTS_OK, ensure_ascii=False)

        sid = self.mk_scene()
        j = m.start_scene(sid, SCRIPT, chat=slow, connect_factory=self.factory)
        mid = m.get(j["id"])
        self.assertTrue(mid["running"])
        self.assertEqual(mid["beats"], [])
        self.assertIn("beats_n", mid)
        j2 = self.wait(m, j["id"])
        self.assertGreater(len(j2["beats"]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
