#!/usr/bin/env python3
"""配方中心单测（M4b-3）：注册表覆盖 / 列表 / 保存+备份 / 恢复默认 / 白名单防穿越。"""
import sys
import tempfile
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

from core import recipes  # noqa: E402


class TestRegistry(unittest.TestCase):
    def test_registry_covers_disk(self):
        """真库：注册表 13 份（审计 5 + 创作 8）全部实际存在。"""
        self.assertEqual(sum(len(v) for v in recipes.REGISTRY.values()), 13)
        for g, rows in recipes.REGISTRY.items():
            for n, t in rows:
                p = Path(recipes.db.ROOT) / "recipes" / g / n
                self.assertTrue(p.is_file(), "缺文件：%s/%s" % (g, n))

    def test_audit_registry_matches_engine(self):
        """审计注册名字串与 audit.py 的 LLM_RECIPES 映射一致。"""
        sys.path.insert(0, str(SERVER))
        from core import audit
        for title, fname in audit.LLM_RECIPES.items():
            self.assertIn(fname, [n for n, t in recipes.REGISTRY["audit"]],
                          "审计配方 %s 未注册" % fname)

    def test_ai_registry_matches_engine(self):
        """创作注册名字串与 rewrite.ACTIONS / CMDBAR / draft 常量一致（对账）。"""
        from core import draft as _draft
        from core import rewrite as _rw
        want = set(_rw.ACTIONS.values()) | {
            _rw.CMDBAR_RECIPE, _draft.DRAFT_BEATS_RECIPE,
            _draft.DRAFT_SHOTS_RECIPE, _draft.DRAFT_PROMPT_RECIPE}
        reg = {n for n, t in recipes.REGISTRY["ai"]}
        self.assertEqual(want, reg)


class TestFileOps(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        d = self.root / "recipes" / "ai"
        d.mkdir(parents=True)
        (d / "rewrite.md").write_text("v1 内容", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_listing(self):
        groups = recipes.listing(root=self.root)
        self.assertEqual([g["group"] for g in groups], ["audit", "ai"])
        rw = [i for i in groups[1]["items"] if i["name"] == "rewrite.md"][0]
        self.assertTrue(rw["exists"])
        self.assertGreater(rw["size"], 0)
        axis = groups[0]["items"][0]
        self.assertFalse(axis["exists"])   # tmp 里没建文件

    def test_save_backup_roundtrip(self):
        out = recipes.save("rewrite.md", "v2 内容", root=self.root)
        self.assertTrue(out["backup"].startswith("ai__rewrite."))
        self.assertEqual(recipes.read("rewrite.md", root=self.root)["content"], "v2 内容")
        baks = list((self.root / "data" / "recipe-backups").glob("ai__rewrite.*.md"))
        self.assertEqual(len(baks), 1)
        self.assertEqual(baks[0].read_text(encoding="utf-8"), "v1 内容")
        # 白名单内但磁盘还没有的文件 → 直接新建
        recipes.save("axis.md", "新建", root=self.root)
        self.assertEqual(recipes.read("axis.md", root=self.root)["content"], "新建")

    def test_save_atomic(self):
        """原子写（M11）：成功后无 .tmp 残留；写失败原文件未动、也不留 .tmp。"""
        from unittest import mock
        recipes.save("rewrite.md", "v2", root=self.root)
        self.assertEqual(list((self.root / "recipes").rglob("*.tmp")), [])
        real = Path.write_text

        def boom(self, *a, **k):
            if self.name.endswith(".tmp"):
                raise OSError("disk full")
            return real(self, *a, **k)

        with mock.patch.object(Path, "write_text", boom):
            with self.assertRaises(OSError):
                recipes.save("rewrite.md", "坏写", root=self.root)
        self.assertEqual(recipes.read("rewrite.md", root=self.root)["content"], "v2")
        self.assertEqual(list((self.root / "recipes").rglob("*.tmp")), [])

    def test_save_rejects(self):
        for bad in ("nope.md", "../axis.md", "audit/axis.md", "rewrite.md/../x", ""):
            with self.assertRaises(recipes.RecipeError):
                recipes.save(bad, "x", root=self.root)
        with self.assertRaises(recipes.RecipeError):
            recipes.save("rewrite.md", "   ", root=self.root)          # 空白
        with self.assertRaises(recipes.RecipeError):
            recipes.save("rewrite.md", "x" * 200_001, root=self.root)  # 超限
        with self.assertRaises(recipes.RecipeError):
            recipes.save("rewrite.md", 123, root=self.root)            # 非文本
        # 失败后原文件未动
        self.assertEqual(recipes.read("rewrite.md", root=self.root)["content"], "v1 内容")

    def test_restore_default(self):
        with self.assertRaises(recipes.RecipeError):
            recipes.restore_default("rewrite.md", root=self.root)      # 无出厂副本
        dd = self.root / "data" / "recipe-defaults" / "ai"
        dd.mkdir(parents=True)
        (dd / "rewrite.md").write_text("出厂版", encoding="utf-8")
        recipes.save("rewrite.md", "改坏了", root=self.root)
        out = recipes.restore_default("rewrite.md", root=self.root)
        self.assertEqual(out["content"], "出厂版")
        self.assertEqual(recipes.read("rewrite.md", root=self.root)["content"], "出厂版")
        baks = sorted((self.root / "data" / "recipe-backups").glob("ai__rewrite.*.md"))
        self.assertEqual(len(baks), 2)                                  # 保存 1 + 恢复前 1
        self.assertEqual(baks[-1].read_text(encoding="utf-8"), "改坏了")
        self.assertEqual(list((self.root / "recipes").rglob("*.tmp")), [])

    def test_read_missing(self):
        with self.assertRaises(recipes.RecipeError):
            recipes.read("concretize.md", root=self.root)               # 未建文件
        with self.assertRaises(recipes.RecipeError):
            recipes.read("zzz.md", root=self.root)                      # 未注册


if __name__ == "__main__":
    unittest.main(verbosity=2)
