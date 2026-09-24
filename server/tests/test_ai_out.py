#!/usr/bin/env python3
"""S3-L3 单点直测：extract_json 两口径 / fail_note / parse_items / norm_option / strip_fence / clip。"""
import unittest

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from core import ai_out  # noqa: E402


class TestExtractJson(unittest.TestCase):
    def test_ok_with_wrappers(self):
        self.assertEqual(ai_out.extract_json('前言 {"a": 1} 后语'), {"a": 1})

    def test_raise_mode(self):
        for bad in ("无花括号", "{坏 JSON}", "[1,2]"):
            with self.assertRaises(ValueError):
                ai_out.extract_json(bad)

    def test_empty_mode(self):
        for bad in ("无花括号", "{坏 JSON}", "[1,2]", "", None):
            self.assertEqual(ai_out.extract_json(bad, on_fail="empty"), {})

    def test_fail_note(self):
        note = ai_out.fail_note("x" * 300, "解析炸")
        self.assertIn("解析炸", note)
        self.assertIn("300 字", note)
        self.assertEqual(len(note) <= 200 + 40, True)     # 首 200 字截断（含前缀不计）


class TestParseItems(unittest.TestCase):
    def test_filters_and_clips(self):
        text = '{"items": [{"i": 1, "after": "改A"}, {"i": 2, "after": ""}, {"i": 9, "after": "越界"}, "坏"]}'
        out = ai_out.parse_items(text, {1, 2})
        self.assertEqual(out, {1: "改A"})

    def test_bad_json_empty(self):
        self.assertEqual(ai_out.parse_items("not json", {1}), {})


class TestNormOption(unittest.TestCase):
    def test_matrix(self):
        opts = ("特写", "景别")
        self.assertEqual(ai_out.norm_option("特写", opts), "特写")     # 精确
        self.assertEqual(ai_out.norm_option("特", opts), "特写")       # 容错（选项含裸值）
        self.assertIsNone(ai_out.norm_option("远", opts))
        self.assertIsNone(ai_out.norm_option("", opts))


class TestStripFence(unittest.TestCase):
    def test_matrix(self):
        self.assertEqual(ai_out.strip_fence("```\n正文\n```"), "正文")
        self.assertEqual(ai_out.strip_fence("正文"), "正文")
        self.assertEqual(ai_out.strip_fence(""), "")


class TestClip(unittest.TestCase):
    def test_clip(self):
        self.assertEqual(ai_out.clip("abcdef", 3), "abc")
        self.assertEqual(ai_out.clip(None, 3), "")
        self.assertEqual(ai_out.clip("ab", 5), "ab")


if __name__ == "__main__":
    unittest.main()
