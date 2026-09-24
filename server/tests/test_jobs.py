#!/usr/bin/env python3
"""任务簿基类单测（L1）：闸门计数 / 登记与并入 / 剪枝护 running / 轻载与收尾 / 释放恰一次。"""
import threading
import time
import unittest

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）

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

    def test_tasks_limit(self):
        self.assertEqual(jobs.TASKS.limit, jobs.TASKS_MAX)


class TestBoard(unittest.TestCase):
    def test_register_get_light_finish_release(self):
        g = jobs.Gate(1)
        b = Board(gate=g)
        with b._lock:
            self.assertTrue(b._gate_acquire())           # 认领名额（与 _register 成对）
            b._register(7, {"id": 7, "running": True, "heavy": "X", "error": None}, gated=True)
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

    def test_prune_registration_order(self):
        """淘汰按注册序（dict 插入序）；在跑跳过不淘汰（P0·S1-W23）。"""
        b = Board(keep=2)
        with b._lock:
            b._jobs = {4: {"running": False}, 1: {"running": True},
                       3: {"running": False}, 2: {"running": False}}
            b._prune()
            self.assertIn(1, b._jobs)
            self.assertEqual(sorted(b._jobs), [1, 2])
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


class RunBoard(jobs.JobBoard):
    """带真实 run 的最小子类（S3-L4 用例）：run 等待信号，收尾显式或听看门。"""

    def __init__(self, gate=None, keep=None):
        super().__init__(keep=keep, gate=gate)
        self.gate_ev = threading.Event()
        self.started = threading.Event()
        self.done = threading.Event()

    def _run(self, job_id, *a):
        self.started.set()
        self.gate_ev.wait(3)
        self._finish(job_id)
        self.done.set()          # 线程收尾完成信号（测试等待用）


class TestStartTemplate(unittest.TestCase):
    """P4 模板（S3-L4）：key / deadline / joined。"""

    def test_key_and_joined(self):
        b = RunBoard()
        snap = b.start_job(find=lambda j: False, build=lambda i: {"x": 1},
                           run=lambda jid, *a: None, key=7)
        self.assertFalse(snap["joined"])
        self.assertIsNotNone(b.get(7))          # key=7 登记（而非序号）

    def test_deadline_field_exposed(self):
        b = RunBoard()
        snap = b.start_job(find=lambda j: False, build=lambda i: {"x": 1},
                           run=lambda jid, *a: None, deadline=60)
        self.assertGreater(snap["deadline"], time.time())
        snap2 = b.start_job(find=lambda j: j.get("x") == 2, build=lambda i: {"x": 2},
                            run=lambda jid, *a: None, deadline=None)
        self.assertIsNone(snap2.get("deadline"))

    def test_join_running(self):
        b = RunBoard()
        b.start_job(find=lambda j: False, build=lambda i: {"x": 1},
                    run=lambda jid, *a: None, key=1)
        snap = b.start_job(find=lambda j: j.get("x") == 1, build=lambda i: {"x": 1},
                           run=lambda jid, *a: None, key=2)
        self.assertTrue(snap.get("joined"))


class TestDeadlineWatch(unittest.TestCase):
    """S3-L4 超时看门：到点置终态 + 归还闸门 + 晚到 _finish 不覆盖。"""

    def test_expire_and_gate_release(self):
        g = jobs.Gate(2)
        b = RunBoard(gate=g)
        b.start_job(find=lambda j: False, build=lambda i: {"x": 1},
                    run=b._run, deadline=0.1, key=1)
        self.assertTrue(b.started.wait(2))
        self.assertEqual(g._active, 1)               # 已占闸
        time.sleep(0.25)
        snap = b.get(1)                              # 惰性看门
        self.assertFalse(snap["running"])
        self.assertEqual(snap["error"], "任务超时")
        self.assertEqual(g._active, 0)               # 闸门已归还
        b.gate_ev.set()
        self.assertTrue(b.done.wait(2))              # 线程晚到 _finish 已跑完
        self.assertEqual(b._jobs[1]["error"], "任务超时")   # 内部终态未被覆盖（绕完成态缓存）
        snap = b.get(1)
        self.assertEqual(snap["error"], "任务超时")


class TestCancel(unittest.TestCase):
    """S3-L4 协作式取消。"""

    def test_cancel_cooperative(self):
        b = RunBoard()
        b.start_job(find=lambda j: False, build=lambda i: {"x": 1}, run=b._run)
        self.assertTrue(b.cancel(1))
        self.assertTrue(b._cancelled(1))
        b.gate_ev.set()
        self.assertTrue(b.done.wait(2))              # 等线程收尾（防时序抖动）
        self.assertFalse(b.cancel(1))                # 已完成：不受理
        self.assertFalse(b.cancel(999))              # 不存在：不受理
        self.assertFalse(b._cancelled(999))


if __name__ == "__main__":
    unittest.main(verbosity=2)
