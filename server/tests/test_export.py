#!/usr/bin/env python3
"""导出用例（批6-2）：静态页 / A4 打印版——内容完整、自含、转义、缺场兜底。"""
import sys
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fixture import make_base_db  # noqa: E402
from core import export as core_export  # noqa: E402


class TestExportScene(unittest.TestCase):
    def test_page_structure_and_content(self):
        con = make_base_db()
        html_text, name_utf8, name_ascii = core_export.build_scene_html(con, "s010", "page")
        self.assertIn("<h1>s010 · 第一场</h1>", html_text)
        self.assertIn("4 镜 / 2 节拍", html_text)
        self.assertIn("beat 1：被领导打压（2 镜）", html_text)
        self.assertIn("beat 2：误发消息（2 镜）", html_text)
        self.assertEqual(html_text.count('class="no"'), 4)
        self.assertIn("运镜", html_text)
        self.assertIn("导演备注", html_text)
        self.assertNotIn(">提示词</th>", html_text)
        # 自含：无脚本、无外部资源
        self.assertNotIn("<script", html_text)
        self.assertNotIn('src="http', html_text)
        self.assertNotIn('href="http', html_text)
        # 文件名
        self.assertIn("s010", name_ascii)
        self.assertIn("分镜表", name_utf8)

    def test_print_mode_a4(self):
        con = make_base_db()
        html_text, name_utf8, name_ascii = core_export.build_scene_html(con, "s010", "print")
        self.assertIn("@page", html_text)
        self.assertIn("A4 landscape", html_text)
        self.assertIn("break-inside: avoid", html_text)
        self.assertIn("A4", name_ascii)
        # 页面版不带 A4 打印页规则
        con2 = make_base_db()
        page, _, _ = core_export.build_scene_html(con2, "s010", "page")
        self.assertNotIn("@page", page)

    def test_escape_and_empty(self):
        con = make_base_db()
        con.execute("UPDATE shots SET blocking='<b>bad</b> & \"x\"' WHERE shot_no='01'")
        con.commit()
        html_text, _, _ = core_export.build_scene_html(con, "s010", "page")
        self.assertNotIn("<b>bad</b>", html_text)
        self.assertIn("&lt;b&gt;bad&lt;/b&gt;", html_text)
        self.assertIn("<td>—</td>", html_text)

    def test_missing_scene(self):
        con = make_base_db()
        r = core_export.build_scene_html(con, "s999", "page")
        self.assertEqual(r, (None, None, None))

    def test_total_duration(self):
        con = make_base_db()
        con.execute("UPDATE shots SET duration='90' WHERE shot_no='01'")
        con.execute("UPDATE shots SET duration='30' WHERE shot_no='02'")
        con.commit()
        html_text, _, _ = core_export.build_scene_html(con, "s010", "page")
        self.assertIn("总时长 2′00″", html_text)


if __name__ == "__main__":
    unittest.main()
