#!/usr/bin/env python3
"""API 薄层用例（批4/P12）：守卫分支 + 任务契约形状（mock 连接与引擎，零网络零库）。"""
import sys
import unittest
from pathlib import Path
from unittest import mock

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fixture import make_base_db  # noqa: E402
from api import ai as api_ai  # noqa: E402
from api import audit as api_audit  # noqa: E402
from api import draft as api_draft  # noqa: E402
from api import prompts as api_prompts  # noqa: E402
from core import ai as core_ai  # noqa: E402
from core import audit as core_audit  # noqa: E402
from core import db as core_db  # noqa: E402
from core import fields  # noqa: E402
from core import rewrite  # noqa: E402


class TestMeta(unittest.TestCase):
    def test_ai_capability_from_meta(self):
        """P8：AI 能力位与上限经 /api/meta 下发（单源 core/fields）。"""
        m = fields.meta()
        self.assertIn("blocking", m["ai_fields"])
        self.assertIn("beat_action", m["ai_fields"])
        self.assertEqual(m["ai_max_targets"], 30)


class TestAiPreviewGuard(unittest.TestCase):
    def _no_db(self):
        return mock.patch.object(core_db, "connect", return_value=mock.MagicMock())

    def test_bad_scene_id(self):
        res, code = api_ai.preview(None, {"scene_id": "x"}, {})
        self.assertEqual(code, 400)
        self.assertIn("scene_id", res["error"])

    def test_no_key(self):
        with self._no_db(), mock.patch.object(core_ai, "get_config",
                                              return_value={"api_key": "", "has_key": False}):
            res, code = api_ai.preview(None, {"scene_id": 1, "action": "rewrite",
                                              "targets": [{"table": "shots", "id": 1,
                                                           "field": "blocking"}]}, {})
        self.assertEqual(code, 400)
        self.assertIn("API Key", res["error"])

    def test_core_error_maps_400(self):
        with self._no_db(), mock.patch.object(core_ai, "get_config",
                                              return_value={"api_key": "sk-test", "has_key": True}), \
             mock.patch.object(rewrite.JOBS, "start",
                               side_effect=ValueError("未知 action：zzz")):
            res, code = api_ai.preview(None, {"scene_id": 1, "action": "zzz",
                                              "targets": [{"table": "shots", "id": 1,
                                                           "field": "blocking"}]}, {})
        self.assertEqual(code, 400)
        self.assertIn("未知 action", res["error"])

    def test_ok_shape(self):
        with self._no_db(), mock.patch.object(core_ai, "get_config",
                                              return_value={"api_key": "sk-test", "has_key": True}), \
             mock.patch.object(rewrite.JOBS, "start",
                               return_value={"id": 7, "running": True}):
            res, code = api_ai.preview(None, {"scene_id": 1, "action": "rewrite",
                                              "targets": [{"table": "shots", "id": 1,
                                                           "field": "blocking"}]}, {})
        self.assertEqual(code, 200)
        self.assertEqual(res["job"]["id"], 7)

    def test_job_get_contract(self):
        res, code = api_ai.job_get(None, {})
        self.assertEqual(code, 400)
        res, code = api_ai.job_get(None, {"id": ["abc"]})
        self.assertEqual(code, 400)
        res, code = api_ai.job_get(None, {"id": ["999999"]})
        self.assertEqual(code, 200)
        self.assertIsNone(res["job"])


class TestDraftGuard(unittest.TestCase):
    def test_start_script_must_be_str(self):
        res, code = api_draft.start(None, {"scene_id": 1, "script": ["x"]}, {})
        self.assertEqual(code, 400)

    def test_job_get_missing_is_null(self):
        res, code = api_draft.job_get(None, {"id": ["999999"]})
        self.assertEqual(code, 200)
        self.assertIsNone(res["job"])


class TestAuditGuards(unittest.TestCase):
    def test_audit_get_needs_scene(self):
        res, code = api_audit.audit_get(None, {})
        self.assertEqual(code, 400)

    def test_rules_op_guards(self):
        for body in ({}, {"id": 1, "enabled": "yes"}, {"id": 1, "params": [1]},
                     {"id": 1}):
            res, code = api_audit.rules_op(None, body, {})
            self.assertEqual(code, 400, "body=%r" % (body,))


class TestAiSettingsLayer(unittest.TestCase):
    """设置薄层（M14 契约）：短键→全键映射 / key 永不回传 / 探活错误形状。"""

    def test_settings_set_maps_short_keys(self):
        captured = {}

        def fake_save(con, data):
            captured["data"] = data
            return {"ai_provider": "p", "ai_model": "m", "ai_base_url": "u",
                    "api_key": "sk-secret", "has_key": True}

        with (
            mock.patch.object(core_db, "connect", return_value=mock.MagicMock()),
            mock.patch.object(core_ai, "save_config", side_effect=fake_save),
        ):
            res, code = api_ai.settings_set(
                None, {"provider": "p", "model": "m", "base_url": "u", "api_key": "sk-secret"}, {})
        self.assertEqual(code, 200)
        self.assertEqual(captured["data"], {"ai_provider": "p", "ai_model": "m",
                                            "ai_base_url": "u", "api_key": "sk-secret"})
        self.assertEqual(res["config"], {"provider": "p", "model": "m", "base_url": "u",
                                         "has_key": True})
        self.assertNotIn("api_key", res["config"])

    def test_settings_set_unknown_only_400(self):
        with mock.patch.object(core_db, "connect",
                               side_effect=AssertionError("坏请求触达了连接")):
            res, code = api_ai.settings_set(None, {"foo": 1}, {})
        self.assertEqual(code, 400)

    def test_settings_get_never_leaks_key(self):
        cfg = {"ai_provider": "p", "ai_model": "m", "ai_base_url": "u",
               "api_key": "sk-secret", "has_key": True}
        with (
            mock.patch.object(core_db, "connect", return_value=mock.MagicMock()),
            mock.patch.object(core_ai, "get_config", return_value=cfg),
        ):
            res, code = api_ai.settings_get(None, {})
        self.assertEqual(code, 200)
        self.assertNotIn("sk-secret", str(res))
        self.assertTrue(res["config"]["has_key"])

    def test_probe_shapes(self):
        """探活：成功 200 形状（reply 去空白截断）；失败 200 + ok:False（不当网络错误）。"""
        with (
            mock.patch.object(core_db, "connect", return_value=mock.MagicMock()),
            mock.patch.object(core_ai, "get_config", return_value={}),
            mock.patch.object(core_ai, "probe",
                              return_value={"ms": 9, "model": "m", "text": " 在的 "}),
        ):
            res, code = api_ai.test(None, {}, {})
        self.assertEqual(code, 200)
        self.assertEqual(res["reply"], "在的")
        with (
            mock.patch.object(core_db, "connect", return_value=mock.MagicMock()),
            mock.patch.object(core_ai, "get_config", return_value={}),
            mock.patch.object(core_ai, "probe",
                              side_effect=core_ai.AiError("未配置 API Key（先去设置里填）")),
        ):
            res, code = api_ai.test(None, {}, {})
        self.assertEqual(code, 200)
        self.assertFalse(res["ok"])


class TestAiApplyGuards(unittest.TestCase):
    """应用薄层（apply）：job 守卫三连 + 域错映射 + 成功形状。"""

    def test_bad_job_id(self):
        for body in ({}, {"job_id": "x"}, {"job_id": [1]}):
            res, code = api_ai.apply_op(None, body, {})
            self.assertEqual(code, 400, "body=%r" % (body,))

    def test_job_missing(self):
        with mock.patch.object(rewrite.JOBS, "get", return_value=None):
            res, code = api_ai.apply_op(None, {"job_id": 999}, {})
        self.assertEqual(code, 400)
        self.assertIn("不存在", res["error"])

    def test_job_running(self):
        with mock.patch.object(rewrite.JOBS, "get", return_value={"id": 1, "running": True}):
            res, code = api_ai.apply_op(None, {"job_id": 1}, {})
        self.assertEqual(code, 400)
        self.assertIn("还没跑完", res["error"])

    def test_valueerror_maps_400(self):
        with (
            mock.patch.object(rewrite.JOBS, "get", return_value={"id": 1, "running": False}),
            mock.patch.object(core_db, "connect", return_value=mock.MagicMock()),
            mock.patch.object(rewrite, "apply_items",
                              side_effect=ValueError("原值已变（手工改过？）")),
        ):
            res, code = api_ai.apply_op(None, {"job_id": 1}, {})
        self.assertEqual(code, 400)
        self.assertIn("原值已变", res["error"])

    def test_ok_shape(self):
        with (
            mock.patch.object(rewrite.JOBS, "get", return_value={"id": 1, "running": False}),
            mock.patch.object(core_db, "connect", return_value=mock.MagicMock()),
            mock.patch.object(rewrite, "apply_items", return_value={"applied": 2}),
        ):
            res, code = api_ai.apply_op(None, {"job_id": 1, "item_ids": [0, 1]}, {})
        self.assertEqual(code, 200)
        self.assertEqual(res["applied"], 2)


class TestDraftThinLayer(unittest.TestCase):
    """草稿薄层增量：prompt / apply 的守卫与域错映射。"""

    def test_prompt_args(self):
        res, code = api_draft.prompt(None, {"scene_id": 1}, {})
        self.assertEqual(code, 400)
        self.assertIn("shot_id", res["error"])

    def test_prompt_valueerror(self):
        with mock.patch.object(api_draft.JOBS, "start_prompt",
                               side_effect=ValueError("镜头不存在")):
            res, code = api_draft.prompt(None, {"scene_id": 1, "shot_id": 9}, {})
        self.assertEqual(code, 400)
        self.assertIn("镜头不存在", res["error"])

    def test_apply_args(self):
        res, code = api_draft.apply_op(None, {}, {})
        self.assertEqual(code, 400)
        self.assertIn("job_id", res["error"])

    def test_apply_valueerror(self):
        with mock.patch.object(api_draft.JOBS, "apply",
                               side_effect=ValueError("该任务已落入过")):
            res, code = api_draft.apply_op(None, {"job_id": 3}, {})
        self.assertEqual(code, 400)
        self.assertIn("已落入过", res["error"])


class TestPromptsThinLayer(unittest.TestCase):
    """提示词/块库薄层（补零覆盖）：守卫先于写连接 + 域错 → 400。"""

    @staticmethod
    def _dead():
        return mock.patch.object(core_db, "connect",
                                 side_effect=AssertionError("坏请求触达了写连接"))

    def test_blocks_unknown_action(self):
        with self._dead():
            res, code = api_prompts.blocks_op(None, {"action": "zzz"}, {})
        self.assertEqual(code, 400)
        self.assertIn("未知 action", res["error"])

    def test_blocks_guards_pre_connect(self):
        cases = ({"action": "update", "id": 1, "weird": 1},   # 投影后无可写字段（L10 前置修正）
                 {"action": "pin", "id": 1, "pinned": "yes"},
                 {"action": "update"},                          # 缺 id
                 {"action": "cat_move", "id": "x"})
        with self._dead():
            for body in cases:
                res, code = api_prompts.blocks_op(None, dict(body), {})
                self.assertEqual(code, 400, "body=%r" % (body,))

    def test_blocks_update_projection(self):
        con = mock.MagicMock()
        with (
            mock.patch.object(core_db, "connect", return_value=con),
            mock.patch.object(api_prompts.prompts, "block_update",
                              return_value={"id": 1, "text": "新"}) as bu,
        ):
            res, code = api_prompts.blocks_op(
                None, {"action": "update", "id": 1, "text": "新", "junk": 9}, {})
        self.assertEqual(code, 200)
        self.assertEqual(bu.call_args[0][2], {"text": "新"})     # 白名单投影（junk 不进）

    def test_prompt_unknown_action(self):
        m = mock.MagicMock()
        m.group.return_value = "zzz"
        with self._dead():
            res, code = api_prompts.prompt_op(m, {}, {})
        self.assertEqual(code, 400)

    def test_prompt_guards_pre_connect(self):
        cases = (("set_text", {}), ("split", {"group_id": "x"}), ("restore", {}))
        with self._dead():
            for action, body in cases:
                m = mock.MagicMock()
                m.group.return_value = action
                res, code = api_prompts.prompt_op(m, dict(body), {})
                self.assertEqual(code, 400, "%s %r" % (action, body))


class TestAuditThinLayer(unittest.TestCase):
    """审计薄层增量：issue_op / run / rules_get / summary（真库夹具，零网络）。"""

    def setUp(self):
        self.con = make_base_db()
        core_audit.seed_default_rules(self.con)

    def tearDown(self):
        try:
            self.con.close()
        except Exception:
            pass

    def test_issue_op_guards(self):
        with mock.patch.object(core_db, "connect",
                               side_effect=AssertionError("坏请求触达了连接")):
            for body in ({"action": "zzz", "id": 1}, {"action": "waive"},
                         {"action": "recheck", "id": "x"}):
                res, code = api_audit.issue_op(None, body, {})
                self.assertEqual(code, 400, "body=%r" % (body,))

    def test_recheck_orphan_rule_400(self):
        """孤儿问题（rule_id NULL，G1 老库残留）→ 400 提示先跑一轮，不炸。"""
        self.con.execute("INSERT INTO audit_issues (scene_id, carrier, status)"
                         " VALUES (1, 'scene', 'open')")
        self.con.commit()
        with (
            mock.patch.object(core_db, "connect", return_value=self.con),
            mock.patch.object(core_audit.JOBS, "start",
                              side_effect=AssertionError("不该启动")),
        ):
            res, code = api_audit.issue_op(None, {"action": "recheck", "id": 1}, {})
        self.assertEqual(code, 400)
        self.assertIn("未关联规则", res["error"])

    def test_recheck_passthrough_joined(self):
        rid = self.con.execute("SELECT id FROM audit_rules WHERE key='loop'").fetchone()["id"]
        self.con.execute("INSERT INTO audit_issues (scene_id, carrier, rule_id, status)"
                         " VALUES (1, 'scene', ?, 'open')", (rid,))
        self.con.commit()
        iid = self.con.execute("SELECT id FROM audit_issues").fetchone()["id"]
        with (
            mock.patch.object(core_db, "connect", return_value=self.con),
            mock.patch.object(core_audit.JOBS, "start",
                              return_value={"id": 9, "joined": True}) as st,
        ):
            res, code = api_audit.issue_op(None, {"action": "recheck", "id": iid}, {})
        self.assertEqual(code, 200)
        self.assertTrue(res["joined"])
        self.assertEqual(st.call_args[0][0], 1)                  # 同场
        self.assertEqual(st.call_args[1].get("only"), [rid])     # 只重查该规则

    def test_run_scene_missing_and_ok(self):
        con = mock.MagicMock()
        con.execute.return_value.fetchone.return_value = None
        with mock.patch.object(core_db, "connect", return_value=con):
            res, code = api_audit.run(None, {"scene_id": 1}, {})
        self.assertEqual(code, 400)
        self.assertIn("场景不存在", res["error"])
        con2 = mock.MagicMock()
        con2.execute.return_value.fetchone.return_value = {"id": 1}
        with (
            mock.patch.object(core_db, "connect", return_value=con2),
            mock.patch.object(core_audit.JOBS, "start",
                              return_value={"id": 4, "running": True}),
        ):
            res, code = api_audit.run(None, {"scene_id": 1}, {})
        self.assertEqual(code, 200)
        self.assertEqual(res["job"]["id"], 4)

    def test_rules_get_contract_matches_registry(self):
        """L10 对账（API 边界）：rules_state 每行与 RULES 逐字段对齐。"""
        with mock.patch.object(core_db, "connect", return_value=self.con):
            res, code = api_audit.rules_get(None, {})
        self.assertEqual(code, 200)
        by_key = {r["key"]: r for r in res["rules"]}
        self.assertEqual(set(by_key), {r["key"] for r in core_audit.RULES})
        for r in core_audit.RULES:
            row = by_key[r["key"]]
            self.assertEqual(row["desc"], r.get("desc", ""))
            self.assertEqual(row.get("recipe"), r.get("recipe"))
            self.assertEqual(set(row["params_schema"]),
                             set((r.get("params") or {}).keys()))

    def test_summary_counts_open_only(self):
        for st in ("open", "open", "waived", "fixed"):
            self.con.execute("INSERT INTO audit_issues (scene_id, carrier, status)"
                             " VALUES (1, 'scene', ?)", (st,))
        self.con.commit()
        with mock.patch.object(core_db, "connect", return_value=self.con):
            res, code = api_audit.summary(None, {})
        self.assertEqual(code, 200)
        self.assertEqual(res["open_by_scene"], {"1": 2})


if __name__ == "__main__":
    unittest.main(verbosity=2)
