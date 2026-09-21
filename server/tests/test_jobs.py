#!/usr/bin/env python3
"""任务簿基类单测（L1）：闸门计数 / 登记与并入 / 剪枝护 running / 轻载与收尾 / 释放恰一次。"""
import sys
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

from core import jobs  # noqa: E402


class Board(jobs.JobBoard):
    """最小子类：直接暴露机制，无需真实任务。"""

    def _light(self, job):
        snap = dict(job)
        snap["heavy"] = None
        return snap


class TestGate(unittest.TestCase):
    def test_counts(self):
        g = jobs.Gate(2)
        self.assertTrue(g.acquire())
        self.assertTrue(g.acquire())
        self.assertFalse(g.acquire())        # 占满不消耗
        g.release()
        self.assertTrue(g.acquire())
        g.release()
        g.release()                          # 多余释放不为负
        self.assertTrue(g.acquire())
        self.assertTrue(g.acquire())
        self.assertFalse(g.acquire())

    def test_shared_singleton(self):
        self.assertIs(jobs.TASKS, jobs.TASKS)
        self.assertEqual(jobs.TASKS.limit, jobs.TASKS_MAX)


class TestBoard(unittest.TestCase):
    def test_register_get_light_finish_release(self):
        g = jobs.Gate(1)
        b = Board(gate=g)
        with b._lock:
            self.assertTrue(b._gate_acquire())           # 认领名额（与 _register 成对）
            b._register(7, {"id": 7, "running": True, "heavy": "X", "error": None})
        self.assertFalse(g.acquire())                    # 名额已占
        snap = b.get(7)
        self.assertTrue(snap["running"])
        self.assertIsNone(snap["heavy"])                 # 在跑 → 轻载
        b._finish(7)
        self.assertTrue(g.acquire())                     # 收尾恰释放一次
        g.release()
        full = b.get(7)
        self.assertFalse(full["running"])
        self.assertIsNone(full["error"])
        self.assertEqual(full["heavy"], "X")             # 跑完 → 全量
        self.assertIsNotNone(full["finished_at"])
        b._finish(7)                                     # 重复收尾不二次释放
        self.assertTrue(g.acquire())
        g.release()
        self.assertIsNone(b.get(99))                     # 不存在 → None

    def test_touch_on_snapshot(self):
        class B2(Board):
            def _touch(self, job):
                job["derived"] = "v"

        b = B2()
        with b._lock:
            b._register(1, {"id": 1, "running": True})
        self.assertEqual(b.get(1)["derived"], "v")

    def test_find_running_joined(self):
        b = Board()
        with b._lock:
            b._register(1, {"id": 1, "running": True, "scene_id": 5})
            b._register(2, {"id": 2, "running": False, "scene_id": 5})
        hit = b._find_running(lambda j: j.get("scene_id") == 5)
        self.assertEqual(hit["id"], 1)
        self.assertTrue(hit["joined"])
        self.assertEqual(len(b._jobs), 2)                # 并入不新增
        self.assertIsNone(b._find_running(lambda j: j.get("scene_id") == 6))

    def test_seq_id(self):
        b = Board()
        with b._lock:
            self.assertEqual(b._seq_id(), 1)
            self.assertEqual(b._seq_id(), 2)

    def test_prune_keeps_running(self):
        b = Board(keep=2)
        with b._lock:
            b._jobs = {1: {"running": True}, 2: {"running": False},
                       3: {"running": False}, 4: {"running": False}}
            b._prune()
            self.assertIn(1, b._jobs)
            self.assertEqual(sorted(b._jobs), [1, 4])
            b._jobs = {5: {"running": True}, 6: {"running": True}, 7: {"running": True}}
            b._prune()
            self.assertEqual(len(b._jobs), 3)            # 全在跑：超 keep 保留

    def test_keep_none_no_prune(self):
        b = Board()
        with b._lock:
            for i in range(10):
                b._jobs[i] = {"running": False}
            b._prune()
            self.assertEqual(len(b._jobs), 10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
