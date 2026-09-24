#!/usr/bin/env python3
"""审计引擎单测（M4a）：程序规则 / 对账状态机 / 开关 / LLM 注入（内存库，零网络）。"""
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import audit, fields  # noqa: E402
from _fixture import conn_factory, make_base_db  # noqa: E402


BASE_OPEN = 4        # _fixture 基线：景别×1 声音×1 密度×1 特写×1（见 _fixture.py:70-71）
N_RULES = len(audit.RULES)
EMPTY_REPLY = {"text": '{"findings": []}'}   # 空 findings 回包（桩共用单点）


def stub_empty(cfg, messages):
    return EMPTY_REPLY


def _wait_idle(m, key, seconds=15):
    """等任务收尾（P5④：收编两处轮询等待）。"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        j = m.get(key)
        if j and not j["running"]:
            return j
        time.sleep(0.1)
    return m.get(key)


def _stub_axis(msg=None):
    def stub(cfg, messages):
        if "节拍：" in messages[1]["content"] and "镜头（按顺序）：" in messages[1]["content"]:
            if msg is None:
                return EMPTY_REPLY
            return {"text": '{"findings":[{"carrier":"seam","ref":"01->02","message":"%s"}]}' % msg}
        return EMPTY_REPLY
    return stub


def _issues(con, sid, title=None):
    rows = audit.issues_state(con, sid)["issues"]
    return [r for r in rows if r["rule_title"] == title] if title else rows


class _AuditCase(unittest.TestCase):
    """审计用例基类（W17）：内存库 + 种子 + sid=1；跑审计统一入口。"""

    sid = 1

    def setUp(self):
        self.con = make_base_db()
        audit.seed_default_rules(self.con)

    def tearDown(self):
        self.con.close()

    def run_audit(self, stub=None):
        return audit.run_scene(self.con, self.sid, ai_chat=(stub or stub_empty))


class TestProgramRules(_AuditCase):

    def test_baseline_findings(self):
        _, state = self.run_audit()
        self.assertEqual(state["counts"]["open"], BASE_OPEN)  # 景别×1 声音×1 密度×1 特写×1
        titles = sorted(r["rule_title"] for r in state["issues"])
        self.assertEqual(titles, ["声音完整性", "戏点密度", "戏点特写", "景别完整"])
        by_title = {r["rule_title"]: r for r in state["issues"]}
        self.assertEqual(by_title["景别完整"]["message"], "景别为空")
        self.assertIn("台词", by_title["声音完整性"]["message"])
        self.assertEqual(by_title["戏点密度"]["carrier"], "beat")

    def test_rerun_idempotent(self):
        self.run_audit()
        self.run_audit()
        state = audit.issues_state(self.con, self.sid)
        self.assertEqual(state["counts"]["open"], BASE_OPEN)

    def test_reply_contract_shapes(self):
        """ai.reply_text 归一契约（W19）：{text} / 裸串两形状都收；非 JSON 走规则级 error（不熄灯）。"""
        _, state = self.run_audit(stub=lambda cfg, messages: EMPTY_REPLY)
        self.assertEqual(state["counts"]["open"], BASE_OPEN)
        _, state2 = self.run_audit(stub=lambda cfg, messages: '{"findings": []}')     # 裸串形状
        self.assertEqual(state2["counts"]["open"], BASE_OPEN)
        _, state3 = self.run_audit(stub=lambda cfg, messages: {"text": "不是 JSON"})  # 归一后解析失败
        self.assertEqual(state3["counts"]["open"], BASE_OPEN)                         # 规则级 error，不熄灯

    def test_fix_and_reopen(self):
        self.run_audit()
        self.con.execute("UPDATE shots SET shot_size='中景', audio='—' WHERE shot_no='02'")
        self.con.commit()
        _, state = self.run_audit()
        self.assertEqual(state["counts"]["open"], 2)
        self.assertEqual(state["counts"]["fixed"], 2)
        self.con.execute("UPDATE shots SET shot_size='', audio='' WHERE shot_no='02'")
        self.con.commit()
        _, state = self.run_audit()
        self.assertEqual(state["counts"]["open"], BASE_OPEN)
        self.assertEqual(state["counts"]["fixed"], 0)

    def test_waive_stays_waived(self):
        self.run_audit()
        issue = _issues(self.con, self.sid, "戏点密度")[0]
        audit.waive_issue(self.con, issue["id"], "刻意压缩")
        self.assertEqual(_issues(self.con, self.sid, "戏点密度")[0]["status"], "waived")
        self.run_audit()  # 再次命中 → 不重开
        row = _issues(self.con, self.sid, "戏点密度")[0]
        self.assertEqual(row["status"], "waived")
        self.assertEqual(row["waive_note"], "刻意压缩")
        audit.unwaive_issue(self.con, issue["id"])
        self.assertEqual(_issues(self.con, self.sid, "戏点密度")[0]["status"], "open")

    def test_waive_note_edit(self):
        self.run_audit()
        issue = _issues(self.con, self.sid, "戏点密度")[0]
        audit.waive_issue(self.con, issue["id"])          # 一键豁免：不写理由
        self.assertIsNone(_issues(self.con, self.sid, "戏点密度")[0]["waive_note"])
        audit.waive_issue(self.con, issue["id"], "补一句理由")   # 已豁免 → 补理由
        row = _issues(self.con, self.sid, "戏点密度")[0]
        self.assertEqual(row["waive_note"], "补一句理由")
        self.assertEqual(row["status"], "waived")

    def test_loop_rule(self):
        self.con.execute("UPDATE beats SET reaction='' WHERE beat_no='1'")
        self.con.commit()
        self.run_audit()
        loop = _issues(self.con, self.sid, "闭环")
        self.assertEqual(len(loop), 1)
        self.assertEqual(loop[0]["carrier"], "beat")
        self.con.execute("UPDATE beats SET reaction='男人僵住' WHERE beat_no='1'")
        self.con.commit()
        self.run_audit()
        self.assertEqual(_issues(self.con, self.sid, "闭环")[0]["status"], "fixed")

    def test_rule_toggle(self):
        self.run_audit()
        rid = [r for r in audit.rules_state(self.con) if r["title"] == "声音完整性"][0]["id"]
        audit.update_rule(self.con, rid, enabled=False)
        summary, _ = self.run_audit()
        self.assertNotIn("声音完整性", [x["title"] for x in summary["rules"]])
        # 关掉的规则不跑：旧 open 保持不动、不自动收敛
        self.assertEqual(_issues(self.con, self.sid, "声音完整性")[0]["status"], "open")
        audit.update_rule(self.con, rid, enabled=True)

    def test_seed_idempotent(self):
        self.assertEqual(audit.seed_default_rules(self.con), 0)
        self.assertEqual(len(audit.rules_state(self.con)), N_RULES)

    def test_seed_reset_remaps_issues(self):
        """--reset 重建：存量问题按 key 回迁新规则 id（老行回退 title；不留孤儿——回归：曾全变 NULL）。"""
        self.run_audit()
        before = audit.issues_state(self.con, self.sid)["issues"]
        self.assertEqual(len(before), BASE_OPEN)
        self.assertTrue(all(r["rule_id"] is not None for r in before))
        audit.seed_default_rules(self.con, reset=True)
        after = audit.issues_state(self.con, self.sid)["issues"]
        self.assertEqual(len(after), BASE_OPEN)
        self.assertTrue(all(r["rule_id"] is not None for r in after))
        self.assertTrue(all(r["rule_title"] != "?" for r in after))
        self.assertEqual(len(audit.rules_state(self.con)), N_RULES)


class TestRegistry(_AuditCase):
    """L3 规则注册表单点：key / 引擎 / schema 对账（title 当键退役的守卫）。"""

    def test_registry_covers_engines(self):
        keys = [r["key"] for r in audit.RULES]
        self.assertEqual(len(keys), len(set(keys)))                     # slug 唯一
        self.assertEqual(set(audit.PROGRAM_RULES),
                         {r["key"] for r in audit.RULES if r["kind"] == "program"})
        self.assertEqual(set(audit.LLM_DIGESTS),
                         {r["key"] for r in audit.RULES if r["kind"] == "llm"})
        self.assertEqual(set(audit.LLM_RECIPES),
                         {r["key"] for r in audit.RULES if r.get("recipe")})

    def test_seed_backfills_key(self):
        """老库迁移（G1 根治）：无 key 的行由种子回填 slug，id 不变（问题挂靠不动）。"""
        con = make_base_db()
        con.execute("INSERT INTO audit_rules (kind, title, params)"
                    " VALUES ('program', '闭环', '{}')")
        con.commit()
        rid = con.execute("SELECT id FROM audit_rules WHERE title='闭环'").fetchone()["id"]
        audit.seed_default_rules(con)
        row = con.execute("SELECT * FROM audit_rules WHERE id=?", (rid,)).fetchone()
        self.assertEqual(row["key"], "loop")                            # 原位回填
        self.assertEqual(len(audit.rules_state(con)), N_RULES)
        con.close()

    def test_rules_state_matches_registry_full(self):
        """L10 对账扩展：rules_state 每行与 RULES 逐字段对齐（key/desc/recipe/schema）。"""
        rows = audit.rules_state(self.con)
        self.assertEqual(len(rows), len(audit.RULES))
        by_key = {r["key"]: r for r in rows}
        self.assertEqual(set(by_key), {r["key"] for r in audit.RULES})
        for r in audit.RULES:
            row = by_key[r["key"]]
            self.assertEqual(row["desc"], r.get("desc", ""))
            self.assertEqual(row.get("recipe"), r.get("recipe"))
            self.assertEqual(set(row["params_schema"]),
                             set((r.get("params") or {}).keys()))

    def test_seed_idempotent(self):
        """种子幂等：重复 seed 不增行、id 与 key 稳定（幂等回填的守卫）。"""
        before = [(r["id"], r["key"]) for r in audit.rules_state(self.con)]
        audit.seed_default_rules(self.con)
        after = [(r["id"], r["key"]) for r in audit.rules_state(self.con)]
        self.assertEqual(before, after)

    def test_rules_state_exposes_schema(self):
        rows = {r["key"]: r for r in audit.rules_state(self.con)}
        d = rows["density"]["params_schema"]["min_shots"]
        self.assertEqual((d["label"], d["type"], d["min"]), ("最少镜头数", "int", 1))
        self.assertIsNone(rows["loop"]["recipe"])                      # 程序规则无配方
        self.assertEqual(rows["camera"]["recipe"], "camera.md")
        self.assertEqual(rows["loop"]["params"]["require_reaction_shot"], False)   # 值来自 DB
        self.assertTrue(rows["axis"]["desc"])

    def test_update_rule_param_guards(self):
        """P2：写侧参数契约——未知键/类型/下界/空表拒；数字串可转。"""
        rid = self.con.execute("SELECT id FROM audit_rules WHERE key='density'").fetchone()["id"]
        with self.assertRaisesRegex(ValueError, "未知参数"):
            audit.update_rule(self.con, rid, params={"nope": 1})
        with self.assertRaisesRegex(ValueError, "必须是整数"):
            audit.update_rule(self.con, rid, params={"min_shots": "abc"})
        with self.assertRaisesRegex(ValueError, "不得小于"):
            audit.update_rule(self.con, rid, params={"min_shots": 0})
        ok = {r["key"]: r for r in audit.update_rule(self.con, rid, params={"min_shots": "2"})}
        self.assertEqual(ok["density"]["params"]["min_shots"], 2)      # 数字串可转
        cid = self.con.execute("SELECT id FROM audit_rules WHERE key='concrete'").fetchone()["id"]
        with self.assertRaisesRegex(ValueError, "不能为空"):
            audit.update_rule(self.con, cid, params={"wordlist": [" ", ""]})

    def test_issues_state_orphan_count(self):
        """W11：悬空 rule_id 计入 orphan（面板可观测；「?」回退保留）。"""
        self.con.execute("INSERT INTO audit_issues (scene_id, carrier, status)"
                         " VALUES (1, 'scene', 'open')")
        self.con.commit()
        st = audit.issues_state(self.con, 1)
        self.assertEqual(st["orphan"], 1)
        self.assertEqual(st["issues"][0]["rule_title"], "?")

    def test_field_hints_from_registry(self):
        """L9：去改目标列由注册表下发（原前端 FIELD_HINT 退役）；W2：与 fields 单点对账。"""
        want = {"size": "shot_size", "sound": "audio", "concrete": "blocking",
                "space": "spatial", "camera": "camera_pos"}
        got = {r["key"]: r.get("field") for r in audit.RULES if r.get("field")}
        self.assertEqual(got, want)
        shot_keys = {f["key"] for f in fields.SHOT_FIELDS}
        for key, col in got.items():
            self.assertIn(col, shot_keys, "%s 的 field=%s 不在 fields.SHOT_FIELDS" % (key, col))

    def test_issues_carry_field(self):
        """L9：问题行随带 field（去改不再按标题硬编码）。"""
        rid = self.con.execute(
            "SELECT id FROM audit_rules WHERE title='声音完整性'").fetchone()["id"]
        self.con.execute("INSERT INTO audit_issues (scene_id, carrier, target_id, rule_id, message)"
                         " VALUES (1, 'shot', '1', ?, '冒烟')", (rid,))
        self.con.commit()
        row = [r for r in audit.issues_state(self.con, 1)["issues"] if r["rule_id"] == rid][0]
        self.assertEqual(row["field"], "audio")
        rid2 = self.con.execute(
            "SELECT id FROM audit_rules WHERE title='轴线'").fetchone()["id"]
        self.con.execute("INSERT INTO audit_issues (scene_id, carrier, target_id, rule_id, message)"
                         " VALUES (1, 'seam', '1>2', ?, '冒烟2')", (rid2,))
        self.con.commit()
        row2 = [r for r in audit.issues_state(self.con, 1)["issues"] if r["rule_id"] == rid2][0]
        self.assertIsNone(row2["field"])                                  # 无 field：不跳格


class TestResolveRef(unittest.TestCase):
    def test_dup_shot_no_index_no_collapse(self):
        """B2 修法：同场「01 与 1」——原样键各归其主，精确引用不被补零变体抢占。"""
        rows = [{"id": 101, "shot_no": "01"}, {"id": 102, "shot_no": "1"}]
        sb = audit._index_by_no(rows, "shot_no", "镜头")
        self.assertEqual(sb["01"]["id"], 101)
        self.assertEqual(sb["1"]["id"], 102)                    # 修复前：102 全部键不可达
        self.assertEqual(audit._lookup(sb, "1")["id"], 102)
        self.assertEqual(audit._lookup(sb, "01")["id"], 101)

    def test_norm_ref_prefixes(self):
        """引用归一（L4）：模型回「节拍2」「Beat 2」「镜头1」等前缀也要落位——回归：曾静默丢弃。"""
        ctx = {"scene": {"id": 9}, "shot_by_no": {"1": {"id": 101}, "2": {"id": 102}},
               "beat_by_no": {"2": {"id": 7}}}
        self.assertEqual(audit._resolve_ref(ctx, "beat", "节拍2"), "7")
        self.assertEqual(audit._resolve_ref(ctx, "beat", "Beat 2"), "7")
        self.assertEqual(audit._resolve_ref(ctx, "shot", "镜01"), "101")
        self.assertEqual(audit._resolve_ref(ctx, "shot", "镜头1"), "101")
        self.assertEqual(audit._resolve_ref(ctx, "seam", "镜1→镜2"), "101>102")
        self.assertEqual(audit._resolve_ref(ctx, "scene", ""), "9")


class TestLlmRules(_AuditCase):

    def test_llm_seam_finding_and_message_update(self):
        audit.run_scene(self.con, self.sid, ai_chat=_stub_axis("视线反向，疑越轴"))
        rows = _issues(self.con, self.sid, "轴线")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["carrier"], "seam")
        self.assertEqual(rows[0]["target_id"], "1>2")  # 镜01→02 的 id 对
        # 同键重跑 + 消息漂移 → 就地更新，不重复
        audit.run_scene(self.con, self.sid, ai_chat=_stub_axis("视线反向（更新版），建议加过渡镜"))
        rows = _issues(self.con, self.sid, "轴线")
        self.assertEqual(len(rows), 1)
        self.assertIn("更新版", rows[0]["message"])

    def test_llm_garbage_and_bad_ref(self):
        def garbage(cfg, messages):
            return {"text": "抱歉，我无法完成。not json"}
        summary, _ = audit.run_scene(self.con, self.sid, ai_chat=garbage)
        self.assertEqual(len(_issues(self.con, self.sid, "轴线")), 0)
        axis = [x for x in summary["rules"] if x["title"] == "轴线"][0]
        self.assertFalse(axis["ran"])                     # 不可解析 → 规则级 error（不静默）
        self.assertIn("回包", axis["error"])

        def bad_ref(cfg, messages):
            if "节拍：" in messages[1]["content"] and "镜头（按顺序）：" in messages[1]["content"]:
                return {"text": '{"findings":[{"carrier":"seam","ref":"99->01","message":"x"}]}'}
            return EMPTY_REPLY
        summary, _ = audit.run_scene(self.con, self.sid, ai_chat=bad_ref)
        axis = [x for x in summary["rules"] if x["title"] == "轴线"][0]
        self.assertFalse(axis["ran"])                      # 丢弃条目 → 规则级 error（P0·S2-B1）
        self.assertIn("引用不可解析", axis["error"])
        self.assertEqual(len(_issues(self.con, self.sid, "轴线")), 0)

    def test_llm_error_records_summary(self):
        def broken(cfg, messages):
            raise RuntimeError("boom")
        summary, _ = audit.run_scene(self.con, self.sid, ai_chat=broken)
        axis = [x for x in summary["rules"] if x["title"] == "轴线"][0]
        self.assertFalse(axis["ran"])
        self.assertIn("boom", axis["error"])
        prog = ("闭环", "戏点密度", "戏点特写", "景别完整", "声音完整性")
        self.assertTrue(all(x["ran"] for x in summary["rules"] if x["title"] in prog))

    def test_unparseable_reply_no_silent_fix(self):
        """LLM 回包不可解析 → 该规则跳过 reconcile：旧 open 不被假熄灭（回归）。"""
        audit.run_scene(self.con, self.sid, ai_chat=_stub_axis("视线反向，疑越轴"))
        self.assertEqual(_issues(self.con, self.sid, "轴线")[0]["status"], "open")

        def garbage(cfg, messages):
            return {"text": "不知道。"}
        audit.run_scene(self.con, self.sid, ai_chat=garbage)
        self.assertEqual(_issues(self.con, self.sid, "轴线")[0]["status"], "open")

    def test_skip_and_drop_no_silent_fix(self):
        """假熄灯回归（P0·S2-B1）：无候选跳过 / 引用丢弃 均不得把存量 open 对账成 fixed。"""
        rid = {r["title"]: r["id"] for r in self.con.execute("SELECT id, title FROM audit_rules")}["动作具象化"]
        self.con.execute("UPDATE shots SET blocking='男人僵住' WHERE shot_no='01'")
        self.con.commit()
        audit.update_rule(self.con, rid, params={"wordlist": ["僵住"]})
        calls = []

        def hit(cfg, messages):
            calls.append(messages[1]["content"])
            if "候选镜头（疑似模糊表达）" in messages[1]["content"]:
                return {"text": '{"findings":[{"carrier":"shot","ref":"01","message":"「僵住」不够具象"}]}'}
            return EMPTY_REPLY

        audit.run_scene(self.con, self.sid, ai_chat=hit)
        rows = _issues(self.con, self.sid, "动作具象化")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "open")

        # ① 词表为空（外部改库形态——写侧现已拒空）→ 无候选：跳过（不调模型）且不对账，存量 open 不动
        self.con.execute("UPDATE audit_rules SET params=? WHERE id=?",
                         ('{"wordlist": []}', rid))
        self.con.commit()
        calls.clear()
        summary, _ = audit.run_scene(self.con, self.sid, ai_chat=hit)
        self.assertFalse(any("候选镜头" in c for c in calls))
        item = [x for x in summary["rules"] if x["title"] == "动作具象化"][0]
        self.assertTrue(item["skipped"])
        self.assertFalse(item["ran"])
        self.assertEqual(_issues(self.con, self.sid, "动作具象化")[0]["status"], "open")

        # ② 引用不可解析 → 规则级 error：不对账，存量 open 不动
        audit.update_rule(self.con, rid, params={"wordlist": ["僵住"]})

        def bad(cfg, messages):
            if "候选镜头（疑似模糊表达）" in messages[1]["content"]:
                return {"text": '{"findings":[{"carrier":"shot","ref":"99","message":"x"}]}'}
            return EMPTY_REPLY

        summary, _ = audit.run_scene(self.con, self.sid, ai_chat=bad)
        item = [x for x in summary["rules"] if x["title"] == "动作具象化"][0]
        self.assertFalse(item["ran"])
        self.assertIn("引用不可解析", item["error"])
        self.assertEqual(_issues(self.con, self.sid, "动作具象化")[0]["status"], "open")


class TestJobManager(unittest.TestCase):
    def test_job_runs_and_reports(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "audit.db")
            seed = make_base_db(path)
            audit.seed_default_rules(seed)
            seed.close()

            factory = conn_factory(path)

            def slow_stub(cfg, messages):
                time.sleep(0.15)
                return EMPTY_REPLY

            m = audit.JobManager()
            job = m.start(1, ai_chat=slow_stub, connect_factory=factory)
            self.assertTrue(job["running"])
            self.assertEqual(len(job["rules"]), N_RULES)
            # 进行中再次 start → 加入同一任务
            again = m.start(1, ai_chat=slow_stub, connect_factory=factory)
            self.assertEqual(again["started_at"], job["started_at"])
            j = _wait_idle(m, 1)
            self.assertFalse(j["running"], "job 未在限时内完成")
            states = {x["title"]: x["state"] for x in j["rules"]}
            self.assertTrue(all(s in ("done", "skipped") for s in states.values()), states)
            self.assertEqual(j["found_total"], BASE_OPEN)
            con = factory()
            try:
                self.assertEqual(audit.issues_state(con, 1)["counts"]["open"], BASE_OPEN)
            finally:
                con.close()

    def test_start_empty_rules_raises(self):
        """§11：过滤后无规则 → ValueError（api 转 400），不建空任务。"""
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "audit.db")
            seed = make_base_db(path)
            audit.seed_default_rules(seed)
            seed.close()
            m = audit.JobManager()
            with self.assertRaisesRegex(ValueError, "没有可运行的规则"):
                m.start(1, only=[99999], connect_factory=conn_factory(path))

    def test_concurrent_start_joins_instead_of_double(self):
        """并发 start：第二个必须并入（不双读规则/双跑）——回归：曾双跑双写。"""
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "audit.db")
            seed = make_base_db(path)
            audit.seed_default_rules(seed)
            seed.close()
            calls = []
            entered = threading.Event()
            gate = threading.Event()

            _base_factory = conn_factory(path)

            def factory():
                name = threading.current_thread().name
                calls.append(name)
                if name == "starter-1" and calls.count("starter-1") == 1:
                    entered.set()
                    gate.wait(5)
                return _base_factory()

            m = audit.JobManager()
            snaps = {}

            def go(name):
                snaps[name] = m.start(1, ai_chat=lambda cfg, ms: EMPTY_REPLY,
                                      connect_factory=factory)

            t1 = threading.Thread(target=go, args=("starter-1",), name="starter-1")
            t2 = threading.Thread(target=go, args=("starter-2",), name="starter-2")
            t1.start()
            self.assertTrue(entered.wait(3))
            t2.start()
            time.sleep(0.15)                     # 让第二路抵达临界区
            gate.set()
            t1.join(5)
            t2.join(5)
            self.assertFalse(t1.is_alive() or t2.is_alive())
            self.assertEqual(calls.count("starter-1"), 1)
            self.assertEqual(calls.count("starter-2"), 0)      # 并入：第二路不读规则
            self.assertTrue(snaps["starter-2"].get("joined"))
            self.assertFalse(snaps["starter-1"].get("joined"))
            self.assertEqual(snaps["starter-1"]["started_at"], snaps["starter-2"]["started_at"])
            j = _wait_idle(m, 1)
            self.assertFalse(j["running"])
            con = conn_factory(path)()
            try:
                self.assertEqual(audit.issues_state(con, 1)["counts"]["open"], BASE_OPEN)
            finally:
                con.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
