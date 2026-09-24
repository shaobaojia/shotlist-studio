#!/usr/bin/env python3
"""S2-L3 canonicalizer 直测：规范形 × 非规范形矩阵（编号规范 + 引用解析）。"""
import unittest

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from core import audit  # noqa: E402


class TestCanonNo(unittest.TestCase):
    def test_canon_matrix(self):
        """规范形 × 非规范形矩阵（S2-L3）。"""
        cases = [
            ("1", "1"), ("01", "1"), ("001", "1"), (" 1 ", "1"),
            ("１", "1"), ("０１", "1"), ("\u30001\u3000", "1"),
            ("17a", "17a"), ("17A", "17a"), ("１７ａ", "17a"),
            ("1a", "1a"), ("1 a", "1a"),
            ("abc", None), ("", None), ("17a1", None), ("-1", None), (None, None),
        ]
        for src, want in cases:
            self.assertEqual(audit._canon_no(src), want, "canon(%r)" % src)


class TestLookupMatrix(unittest.TestCase):
    def test_nonstandard_refs_hit(self):
        """非规范形引用命中（原样精确 → canon 规范）。"""
        rows = [{"id": 1, "shot_no": "1"}, {"id": 2, "shot_no": "17A"}]
        m = audit._index_by_no(rows, "shot_no", "镜头")
        for ref, want in [("1", 1), ("01", 1), ("１", 1), (" 1 ", 1),
                          ("17a", 2), ("１７ａ", 2), ("17A", 2)]:
            hit = audit._lookup(m, ref)
            self.assertIsNotNone(hit, "lookup(%r)" % ref)
            self.assertEqual(hit["id"], want, "lookup(%r)" % ref)
        self.assertIsNone(audit._lookup(m, "99"))
        self.assertIsNone(audit._lookup(m, "zz"))

    def test_exact_precedence(self):
        """同数异写（01/1 并存）：精确引用各归各行；规范冲突可见且不夺占。"""
        rows = [{"id": 101, "shot_no": "01"}, {"id": 102, "shot_no": "1"}]
        m = audit._index_by_no(rows, "shot_no", "镜头")
        self.assertEqual(audit._lookup(m, "1")["id"], 102)     # 精确层
        self.assertEqual(audit._lookup(m, "01")["id"], 101)    # 精确层
        self.assertEqual(audit._lookup(m, "001")["id"], 102)   # canon '1' → 精确层所有者

    def test_legacy_variants_still_hit(self):
        """旧枚举变体的历史场景仍全命中（行为兼容回归）。"""
        rows = [{"id": 7, "shot_no": "01"}]
        m = audit._index_by_no(rows, "shot_no", "镜头")
        for ref in ("01", "1", "001", " 1 ", "０１"):
            self.assertEqual(audit._lookup(m, ref)["id"], 7, "lookup(%r)" % ref)


if __name__ == "__main__":
    unittest.main()
