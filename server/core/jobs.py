"""任务簿基类（L1）：三域任务共用机制——锁、序号、剪枝护 running、并发闸门、轻载快照。

口径（拍板；行为照搬批1–3 修过的语义，一字不变）：
- 内存级任务（重启即清）；快照是拷贝，不是句柄。
- 剪枝只淘汰完成件（M9）：在跑任务绝不剪——不够删就允许超 keep；keep=None 不剪。
- 并发闸门：改写/草稿共用（TASKS_MAX）；审计任务不在闸内。
- 轮询期轻载（P7）：在跑时大文本不回传——裁什么由子类 _light 决定。
- 同场/同镜并入（M10）：判定归子类 _find_running；并入快照带 joined=True。
"""
import json
import threading
import time

TASKS_MAX = 4                 # 全通道同时进行的外呼上限（改写/草稿共用；审计任务不在内）


class Gate:
    """进程级并发闸门（计数）。"""

    def __init__(self, limit):
        self._lock = threading.Lock()
        self._limit = int(limit)
        self._active = 0

    @property
    def limit(self):
        return self._limit

    def acquire(self):
        with self._lock:
            if self._active >= self._limit:
                return False
            self._active += 1
            return True

    def release(self):
        with self._lock:
            self._active = max(0, self._active - 1)


TASKS = Gate(TASKS_MAX)       # 单例：改写 + 草稿共用（审计不在内）


class JobBoard:
    """任务簿基类：子类给「条目形状 + _run（+ _light/_touch）」，其余机制全在这。

    子类可覆写：_light（轮询期轻载）、_touch（快照前维护派生字段）。
    启动期三步（锁内，顺序固定）：_find_running → _gate_acquire → _seq_id/_register。
    """

    def __init__(self, keep=None, gate=None):
        self._lock = threading.Lock()
        self._jobs = {}
        self._seq = 0
        self._keep = keep
        self._gate = gate
        self._gated = set()          # 已占闸名额的任务键（收尾恰好释放一次）

    # ── 快照与查询 ──

    def _snap(self, job):
        return json.loads(json.dumps(job, ensure_ascii=False))

    def _touch(self, job):
        """锁内、快照前钩子（维护派生字段，如 done 计数）；默认无。"""
        return None

    def _light(self, job):
        """轮询期轻载变换（P7）：在跑时只回必要字段；默认退化为整快照。"""
        return self._snap(job)

    def get(self, key):
        with self._lock:
            job = self._jobs.get(key)
            if not job:
                return None
            self._touch(job)
            if job.get("running"):
                return self._light(job)
            return self._snap(job)

    # ── 启动期原语（锁内使用） ──

    def _find_running(self, pred):
        """锁内：找在跑且满足 pred 的任务 → 带 joined 快照；无 → None。"""
        for j in self._jobs.values():
            if j.get("running") and pred(j):
                snap = self._snap(j)
                snap["joined"] = True
                return snap
        return None

    def _gate_acquire(self):
        """锁内：认领并发名额（gate=None 恒成功）。"""
        if self._gate is None:
            return True
        return self._gate.acquire()

    def _seq_id(self):
        self._seq += 1
        return self._seq

    def _register(self, key, job):
        """锁内：登记任务 + 记账闸名额 + 剪枝（须紧跟在成功的 _gate_acquire 之后）。"""
        if self._gate is not None:
            self._gated.add(key)
        self._jobs[key] = job
        self._prune()

    def _prune(self):
        """只淘汰已完成任务（M9）：在跑任务绝不剪——不够删就允许超 keep。"""
        if self._keep is None or len(self._jobs) <= self._keep:
            return
        room = len(self._jobs) - self._keep
        for old in sorted(self._jobs):
            if room <= 0:
                break
            j = self._jobs.get(old)
            if j and j.get("running"):
                continue
            self._jobs.pop(old, None)
            room -= 1

    # ── 收尾 ──

    def _finish(self, key, err=None):
        """任务收尾（任意线程）：置终态 + 释放闸门（恰好一次）。"""
        with self._lock:
            job = self._jobs.get(key)
            if job:
                job["running"] = False
                job["error"] = err
                job["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                self._touch(job)
            gated = key in self._gated
            self._gated.discard(key)
        if gated and self._gate is not None:
            self._gate.release()
