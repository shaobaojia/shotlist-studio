#!/usr/bin/env python3
"""S2-L1 规则键迁移链直测：UNIQUE 索引 / 重复收敛 / reset 老行重映。"""
import unittest

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from _fixture import make_base_db  # noqa: E402
from core import audit  # noqa: E402


class TestRuleKeyMigration(unittest.TestCase):
    def setUp(self):
        self.con = make_base_db()
        audit.seed_default_rules(self.con)

    def tearDown(self):
        self.con.close()

    def test_unique_index_present(self):
        """种子链内迁移建 UNIQUE 索引（S2-L1）。"""
        idx = [r[1] for r in self.con.execute("PRAGMA index_list(audit_rules)")]
        self.assertIn("idx_audit_rules_key", idx)

    def test_duplicate_keys_rejected(self):
        """UNIQUE 咬：重复 key 双插进不去（DB 层防线）。"""
        row = self.con.execute("SELECT key, kind FROM audit_rules LIMIT 1").fetchone()
        with self.assertRaises(Exception) as ctx:
            self.con.execute("INSERT INTO audit_rules (key, kind, title, params) VALUES (?,?,?,?)",
                             (row["key"], row["kind"], "重复行", "{}"))
            self.con.commit()
        self.con.rollback()
        self.assertIn("UNIQUE", str(ctx.exception).upper())

    def test_migration_dedupes_and_remaps(self):
        """重复 key 收敛：保最小 id、挂靠问题重指、索引重建。"""
        con = self.con
        con.execute("DROP INDEX IF EXISTS idx_audit_rules_key")
        key = con.execute("SELECT key FROM audit_rules ORDER BY id LIMIT 1").fetchone()["key"]
        keep = con.execute("SELECT id FROM audit_rules WHERE key=?", (key,)).fetchone()["id"]
        dup = con.execute("INSERT INTO audit_rules (key, kind, title, params) VALUES (?,?,?,?)",
                          (key, "program", "重复", "{}")).lastrowid
        con.execute("INSERT INTO audit_issues (scene_id, carrier, target_id, rule_id, message)"
                    " VALUES (1, 'scene', 's010', ?, 'm')", (dup,))
        con.commit()
        audit._ensure_key_column(con)                      # 迁移重跑
        left = [r["id"] for r in con.execute("SELECT id FROM audit_rules WHERE key=?", (key,))]
        self.assertEqual(left, [keep])                     # 保最小 id
        rid = con.execute("SELECT rule_id FROM audit_issues WHERE message='m'").fetchone()["rule_id"]
        self.assertEqual(rid, keep)                        # 重指保留行
        idx = [r[1] for r in con.execute("PRAGMA index_list(audit_rules)")]
        self.assertIn("idx_audit_rules_key", idx)          # 索引重建

    def test_reset_remaps_legacy_rows(self):
        """reset 重映：无 key 老行经 title→key 映射回迁（不留孤儿）。"""
        con = make_base_db()
        con.execute("INSERT INTO audit_rules (kind, title, params) VALUES ('program','闭环','{}')")
        con.commit()
        old_rid = con.execute("SELECT id FROM audit_rules WHERE title='闭环'").fetchone()["id"]
        con.execute("INSERT INTO audit_issues (scene_id, carrier, target_id, rule_id, message)"
                    " VALUES (1, 'scene', 's010', ?, 'legacy')", (old_rid,))
        con.commit()
        audit.seed_default_rules(con, reset=True)
        rid = con.execute("SELECT rule_id FROM audit_issues WHERE message='legacy'").fetchone()["rule_id"]
        self.assertIsNotNone(rid)
        key = con.execute("SELECT key FROM audit_rules WHERE id=?", (rid,)).fetchone()["key"]
        self.assertEqual(key, "loop")                      # 挂到新行且 key 正确
        con.close()


if __name__ == "__main__":
    unittest.main()
