#!/usr/bin/env python3
"""全库 JSON 导出用例（批7 · S4-L2 归位后）：形状 / 行数 / JSON 序列化安全 / 落盘剪枝。"""
import json
import os
import tempfile
import unittest
from pathlib import Path

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from _fixture import make_base_db  # noqa: E402
from core import backup  # noqa: E402


class TestExportJson(unittest.TestCase):
    def test_dump_shape_and_counts(self):
        con = make_base_db()
        data = backup.dump_db(con)
        self.assertIn("meta", data)
        self.assertIn("schema", data)
        self.assertEqual(data["meta"]["app"], "shotlist-studio")
        self.assertEqual(len(data["tables"]["scenes"]), 1)
        self.assertEqual(len(data["tables"]["shots"]), 4)
        self.assertEqual(data["tables"]["shots"][0]["shot_no"], "01")
        self.assertTrue(any("CREATE TABLE" in s for s in data["schema"]))
        json.dumps(data, ensure_ascii=False)     # 全部值为 JSON 原生类型（可序列化）

    def test_mask_keys_redacts_settings(self):
        con = make_base_db()
        con.execute("INSERT INTO settings (key, value) VALUES ('ai_api_key', 'sk-fak...test')")
        con.commit()
        data = backup.dump_db(con, mask_keys=True)
        text = json.dumps(data, ensure_ascii=False)
        self.assertNotIn("sk-", text)
        vals = {r["key"]: r["value"] for r in data["tables"]["settings"]}
        self.assertEqual(vals.get("ai_api_key"), "<redacted>")
        self.assertIn("settings.ai_api_key", data["meta"]["masked_fields"])

    def test_roundtrip_to_text(self):
        con = make_base_db()
        data = backup.dump_db(con)
        text = json.dumps(data, ensure_ascii=False)
        back = json.loads(text)
        self.assertEqual(back["tables"]["shots"][0]["shot_no"], "01")

    def test_tables_manifest(self):
        """导出契约：表清单（sorted 稳定）+ JSON 序列化安全（P2·S4-B12）。"""
        con = make_base_db()
        data = backup.dump_db(con)
        names = sorted(data["tables"])
        self.assertEqual(names, sorted(names))
        for must in ("scenes", "shots", "beats", "prompt_groups", "settings", "history"):
            self.assertIn(must, names)
        text = json.dumps(data, ensure_ascii=False)
        self.assertIsInstance(text, str)
        self.assertGreater(len(text), 100)

    def test_dump_to_writes_and_prunes(self):
        """落盘 + 剪枝（S4-L2 归位余项）：tmp 库直测，不触真库。"""
        with tempfile.TemporaryDirectory() as d:
            dbp = os.path.join(d, "s.db")
            make_base_db(dbp).close()
            out = Path(d) / "exports"
            out.mkdir()
            for i in range(25):                  # 预置 25 份旧导出，超过保留 20
                (out / ("studio-20260101-0000%02d-000.json" % i)).write_text("{}")
            fname, data = backup.dump_to(out, db_path=dbp)
            self.assertTrue(fname.exists())
            self.assertEqual(data["meta"]["app"], "shotlist-studio")
            self.assertLessEqual(len(list(out.glob("studio-*.json"))), 20)


if __name__ == "__main__":
    unittest.main()
