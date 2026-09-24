#!/usr/bin/env python3
"""digest 共享模块单测（L8）：黄金对拍——同一数据下与三域旧实现逐字节等。
（唯一有意归一：草稿组内速览「空间关系」→「空间」，见 test_draft_members_spec。）"""
import unittest

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

from core import audit, digest, draft  # noqa: E402

SCENE = {'id': 1, 'film_id': 1, 'position': 0, 'scene_no': 's010', 'title': '第一场', 'value': '控制', 'pole_start': '维持', 'pole_end': '失控', 'locked': 0}
BEATS = [{'id': 11, 'scene_id': 1, 'position': 0, 'beat_no': '1', 'name': '被领导打压', 'kind': '⚪ 填充', 'outside_action': '领导来电话吼骂', 'reaction': '男人僵住', 'closed_loop': '是'}, {'id': 12, 'scene_id': 1, 'position': 1, 'beat_no': '2', 'name': '误发消息', 'kind': '🔴 戏点', 'outside_action': '消息误发', 'reaction': '男人瞳孔收缩', 'closed_loop': '是'}]
SHOTS = [{'id': 101, 'scene_id': 1, 'beat_id': 11, 'position': 0, 'shot_no': '01', 'camera_move': '固定', 'camera_pos': '🔴 正打', 'spatial': '左前沙发', 'shot_fn': '叙事镜', 'shot_size': '中景', 'blocking': '男人看着手机\n手指滑动', 'dialogue': '', 'duration': '3.5', 'audio': '空调底噪'}, {'id': 102, 'scene_id': 1, 'beat_id': 12, 'position': 1, 'shot_no': '02', 'camera_move': '推', 'camera_pos': '🟡 反打', 'spatial': '', 'shot_fn': '反应镜', 'shot_size': '近景', 'blocking': '男人盯着屏幕', 'dialogue': '「喂？」', 'duration': '2', 'audio': '—'}]
def _by_beat(shots):
    g = {}
    for s in shots:
        g.setdefault(s["beat_id"], []).append(s)
    return g


CTX = {"scene": SCENE, "beats": BEATS, "shots": SHOTS, "shots_by_beat": _by_beat(SHOTS)}


class TestSceneLine(unittest.TestCase):
    def test_full_form_parity(self):
        want = '场：s010 第一场 ｜ 价值：控制 ｜ 弧线：维持 → 失控'
        self.assertEqual(digest.scene_line(SCENE), want)                       # 审计/创作体
        self.assertEqual(digest.scene_line_terse(SCENE), '场：s010 第一场 ｜ 价值：控制 ｜ 弧线：维持 → 失控')             # 草稿体（字段满时同串）

    def test_terse_omits_empty(self):
        self.assertEqual(digest.scene_line_terse({"scene_no": "s020", "title": "空场"}), '场：s020 空场')


class TestShotsLines(unittest.TestCase):
    def test_rewrite_brief_parity(self):
        self.assertEqual(
            digest.shots_lines(SHOTS, (("shot_size", 60), ("camera_pos", 60), ("blocking", 60))),
            ['镜01 ｜ 景别:中景 ｜ 机位:🔴 正打 ｜ 动作:男人看着手机 手指滑动', '镜02 ｜ 景别:近景 ｜ 机位:🟡 反打 ｜ 动作:男人盯着屏幕'])

    def test_draft_members_spec(self):
        """草稿组内速览：逐字节对齐旧格式（唯一有意归一：空间关系 → 空间）。"""
        self.assertEqual(digest.shots_lines(SHOTS, draft._MEMBER_SPEC), ['镜01 ｜ 景别:中景 ｜ 运镜:固定 ｜ 机位:🔴 正打 ｜ 空间:左前沙发 ｜ 动作:男人看着手机 手指滑动', '镜02 ｜ 景别:近景 ｜ 运镜:推 ｜ 机位:🟡 反打 ｜ 动作:男人盯着屏幕 ｜ 台词:「喂？」'])

    def test_spec_keys_registered(self):
        """digest spec 的键必须在 LABELS 登记（防英文键直写进中文提示词；audit 三组为内联口径同步）——P0·S1-W22。"""
        from core import rewrite
        specs = (rewrite._BRIEF, draft._MEMBER_SPEC,
                 (("camera_pos", 16), ("spatial", 60), ("blocking", 90)),
                 (("spatial", 70), ("blocking", 110), ("camera_pos", 16)),
                 (("camera_pos", 20), ("shot_fn", 10), ("shot_size", 24), ("camera_move", 30)))
        for spec in specs:
            for f, _w in spec:
                self.assertIn(f, digest.LABELS, f)

    def test_labels_single_source(self):
        self.assertEqual(digest.LABELS["spatial"], "空间")


class TestAuditDigestsGolden(unittest.TestCase):
    """audit 五条 digest 切换后与旧实现逐字节等（digest 模块被正确嫁接）。"""

    def test_axis(self):
        self.assertEqual(audit.digest_axis(CTX, {}), '场：s010 第一场 ｜ 价值：控制 ｜ 弧线：维持 → 失控\n节拍：节拍 1 被领导打压；节拍 2 误发消息\n镜头（按顺序）：\n镜01 ｜ 机位: 🔴 正打 ｜ 空间: 左前沙发 ｜ 动作: 男人看着手机 手指滑动\n镜02 ｜ 机位: 🟡 反打 ｜ 动作: 男人盯着屏幕')

    def test_space(self):
        self.assertEqual(audit.digest_space(CTX, {}), '场：s010 第一场 ｜ 价值：控制 ｜ 弧线：维持 → 失控\n镜头（按顺序）：\n镜01 ｜ 空间: 左前沙发 ｜ 动作: 男人看着手机 手指滑动 ｜ 机位: 🔴 正打\n镜02 ｜ 动作: 男人盯着屏幕 ｜ 机位: 🟡 反打')

    def test_camera(self):
        self.assertEqual(audit.digest_camera(CTX, {}), '场：s010 第一场 ｜ 价值：控制 ｜ 弧线：维持 → 失控\n节拍：\n节拍 1 [⚪ 填充] 被领导打压 ｜ 外界：领导来电话吼骂 ｜ 反应：男人僵住\n节拍 2 [🔴 戏点] 误发消息 ｜ 外界：消息误发 ｜ 反应：男人瞳孔收缩\n镜头：\n镜01 ｜ 机位: 🔴 正打 ｜ 职能: 叙事镜 ｜ 景别: 中景 ｜ 运镜: 固定\n镜02 ｜ 机位: 🟡 反打 ｜ 职能: 反应镜 ｜ 景别: 近景 ｜ 运镜: 推')

    def test_rhythm(self):
        self.assertEqual(audit.digest_rhythm(CTX, {}), '场：s010 第一场 ｜ 价值：控制 ｜ 弧线：维持 → 失控\n节拍与时长：\n节拍 1 [⚪ 填充] 被领导打压 ｜ 1 镜，时长：3.5（均 3.5s）\n节拍 2 [🔴 戏点] 误发消息 ｜ 1 镜，时长：2（均 2.0s）')

    def test_concrete(self):
        self.assertEqual(audit.digest_concrete(CTX, {"wordlist": ["看着", "盯着"]}), '场：s010 第一场 ｜ 价值：控制 ｜ 弧线：维持 → 失控\n候选镜头（疑似模糊表达）：\n镜01 ｜ 命中词：看着 ｜ 动作原文：男人看着手机\n手指滑动\n镜02 ｜ 命中词：盯着 ｜ 动作原文：男人盯着屏幕')


if __name__ == "__main__":
    unittest.main(verbosity=2)
