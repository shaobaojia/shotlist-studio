#!/usr/bin/env python3
"""导出用例（批6-2）：静态页 / A4 打印版——内容完整、自含、转义、缺场兜底。"""
import unittest
from unittest import mock

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from _fixture import make_base_db  # noqa: E402
from api import export as api_export  # noqa: E402
from core import db as core_db  # noqa: E402
from core import export as core_export  # noqa: E402


class TestExportScene(unittest.TestCase):
    def test_page_structure_and_content(self):
        con = make_base_db()
        html_text, name_utf8, name_ascii = core_export.build_scene_html(con, "s010", "page")
        self.assertIn("<h1>s010 · 第一场</h1>", html_text)
        self.assertIn("4 镜 / 2 节拍", html_text)
        self.assertIn("beat 1：被领导打压 (2 镜)", html_text)
        self.assertIn("beat 2：误发消息 (2 镜)", html_text)
        self.assertEqual(html_text.count('class="no"'), 4)
        # 列数/列序与 EXPORT_COLS 逐项同源（P2·S4-P7②/B11）
        self.assertEqual(html_text.count("<th>"), len(core_export.EXPORT_COLS))
        head = html_text[html_text.index("<thead>"):html_text.index("</thead>")]
        for col in core_export.EXPORT_COLS:
            self.assertIn("<th>%s</th>" % col["label"], head)
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
        # 页面版不带 A4 打印页规则（同 con 连调两次——导出只读，P2·S4-P7③）
        page, _, _ = core_export.build_scene_html(con, "s010", "page")
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
        with self.assertRaises(core_export.SceneNotFound):
            core_export.build_scene_html(con, "s999", "page")

    def test_total_duration(self):
        con = make_base_db()
        con.execute("UPDATE shots SET duration='90' WHERE shot_no='01'")
        con.execute("UPDATE shots SET duration='30' WHERE shot_no='02'")
        con.commit()
        html_text, _, _ = core_export.build_scene_html(con, "s010", "page")
        self.assertIn("总时长 2′00″", html_text)


class TestExportRoute(unittest.TestCase):
    """导出接口 handler 级（P2·S4-P7①）：非法格式 / 缺参 / 缺场 / 双文件名消毒。"""

    def test_bad_format_400(self):
        """非法 format → 400 且不触连接。"""
        with mock.patch.object(core_db, "open_ro", side_effect=AssertionError("坏请求触达了连接")), \
             mock.patch.object(core_db, "open_rw", side_effect=AssertionError("坏请求触达了连接")):
            obj, code = api_export.export_get(None, {"scene": ["s010"], "format": ["weird"]})
        self.assertEqual(code, 400)
        self.assertIn("format", obj["error"])

    def test_missing_scene_400(self):
        """缺 scene → 400 且不触连接。"""
        with mock.patch.object(core_db, "open_ro", side_effect=AssertionError("坏请求触达了连接")), \
             mock.patch.object(core_db, "open_rw", side_effect=AssertionError("坏请求触达了连接")):
            obj, code = api_export.export_get(None, {"format": ["page"]})
        self.assertEqual(code, 400)
        self.assertIn("scene", obj["error"])

    def test_scene_not_found_404(self):
        """场不存在 → 404（SceneNotFound 在接口层转译）。"""
        con = make_base_db()
        with mock.patch.object(core_db, "open_ro", return_value=con), mock.patch.object(core_db, "open_rw", return_value=con):
            obj, code = api_export.export_get(None, {"scene": ["s999"], "format": ["page"]})
        self.assertEqual(code, 404)
        self.assertIn("s999", obj["error"])

    def test_ok_double_filename(self):
        """成功 → __attachment__；Content-Disposition 双文件名（quote() 与 ASCII 名并存是唯一易回退点）。"""
        con = make_base_db()
        with mock.patch.object(core_db, "open_ro", return_value=con), mock.patch.object(core_db, "open_rw", return_value=con):
            obj, code = api_export.export_get(None, {"scene": ["s010"], "format": ["page"]})
        self.assertEqual(code, 200)
        att = obj["__attachment__"]
        self.assertEqual(att["ctype"], "text/html; charset=utf-8")
        self.assertIn("s010", att["body"].decode("utf-8")[:200])
        disp = att["extra"]["Content-Disposition"]
        self.assertIn('filename="s010-storyboard.html"', disp)
        self.assertIn("filename*=UTF-8''s010", disp)

    def test_disp_sanitized(self):
        """B5 消毒（P1·S4-B5）：ASCII 段剥 CR/LF/引号，UTF-8 段走百分号编码。"""
        disp = api_export._disp('s010"\r\nX-Evil: 1', "s010 分镜表.html")
        self.assertNotIn("\r", disp)
        self.assertNotIn("\n", disp)
        self.assertNotIn('s010"', disp)
        self.assertIn("filename*=UTF-8''s010%20%E5%88%86", disp)


if __name__ == "__main__":
    unittest.main()
