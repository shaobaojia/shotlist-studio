#!/usr/bin/env python3
"""API 薄层用例（批4/P12）：守卫分支 + 任务契约形状（mock 连接与引擎，零网络零库）。"""
import sys
import unittest
from pathlib import Path
from unittest import mock

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

from api import ai as api_ai  # noqa: E402
from api import audit as api_audit  # noqa: E402
from api import draft as api_draft  # noqa: E402
from core import ai as core_ai  # noqa: E402
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
                                              return_value={"has_key": False}):
            res, code = api_ai.preview(None, {"scene_id": 1, "action": "rewrite",
                                              "targets": [{"table": "shots", "id": 1,
                                                           "field": "blocking"}]}, {})
        self.assertEqual(code, 400)
        self.assertIn("API Key", res["error"])

    def test_core_error_maps_400(self):
        with self._no_db(), mock.patch.object(core_ai, "get_config",
                                              return_value={"has_key": True}), \
             mock.patch.object(rewrite.JOBS, "start",
                               side_effect=ValueError("未知 action：zzz")):
            res, code = api_ai.preview(None, {"scene_id": 1, "action": "zzz",
                                              "targets": [{"table": "shots", "id": 1,
                                                           "field": "blocking"}]}, {})
        self.assertEqual(code, 400)
        self.assertIn("未知 action", res["error"])

    def test_ok_shape(self):
        with self._no_db(), mock.patch.object(core_ai, "get_config",
                                              return_value={"has_key": True}), \
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
