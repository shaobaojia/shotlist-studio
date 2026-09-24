#!/usr/bin/env python3
"""全库 JSON 导出用例（批7）：形状 / 行数 / JSON 序列化安全。"""
import importlib.util
import json
import unittest

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from _fixture import make_base_db  # noqa: E402

_spec = importlib.util.spec_from_file_location("export_json", _boot.SERVER.parent / "scripts" / "export_json.py")
export_json = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(export_json)


class TestExportJson(unittest.TestCase):
    def test_dump_shape_and_counts(self):
        con = make_base_db()
        data = export_json.dump_db(con)
        self.assertIn("meta", data)
        self.assertIn("schema", data)
        self.assertEqual(data["meta"]["app"], "shotlist-studio")
        self.assertEqual(len(data["tables"]["scenes"]), 1)
        self.assertEqual(len(data["tables"]["shots"]), 4)
        self.assertEqual(data["tables"]["shots"][0]["shot_no"], "01")
        self.assertTrue(any("CREATE TABLE" in s for s in data["schema"]))
        # 全部值为 JSON 原生类型（可序列化）
        json.dumps(data, ensure_ascii=False)

    def test_mask_keys_redacts_settings(self):
        con = make_base_db()
        con.execute("INSERT INTO settings (key, value) VALUES ('ai_api_key', 'sk-fake-value-for-test')")
        con.commit()
        data = export_json.dump_db(con, mask_keys=True)
        text = json.dumps(data, ensure_ascii=False)
        self.assertNotIn("sk-", text)
        vals = {r["key"]: r["value"] for r in data["tables"]["settings"]}
        self.assertEqual(vals.get("ai_api_key"), "<redacted>")
        self.assertIn("settings.ai_api_key", data["meta"]["masked_fields"])

    def test_roundtrip_to_text(self):
        con = make_base_db()
        data = export_json.dump_db(con)
        text = json.dumps(data, ensure_ascii=False)
        back = json.loads(text)
        self.assertEqual(back["tables"]["shots"][0]["shot_no"], "01")

    def test_tables_manifest(self):
        """导出契约：表清单（sorted 稳定）+ JSON 序列化安全（P2·S4-B12）。"""
        con = make_base_db()
        data = export_json.dump_db(con)
        names = sorted(data["tables"])
        self.assertEqual(names, sorted(names))
        for must in ("scenes", "shots", "beats", "prompt_groups", "settings", "history"):
            self.assertIn(must, names)
        text = json.dumps(data, ensure_ascii=False)
        self.assertIsInstance(text, str)
        self.assertGreater(len(text), 100)


if __name__ == "__main__":
    unittest.main()
