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
GATE_BUSY_MSG = "生成任务过多（同时最多 %d 个）——请等一个跑完再试"   # 闸门文案单点（P0·S3-P4）


def now_ts():
    """统一时间戳（秒级）：started_at / finished_at 共用（P0·S3-W17）。"""
    return time.strftime("%Y-%m-%d %H:%M:%S")


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
        """轮询期轻载变换（P7）：在跑时只回必要字段；默认退化为整快照。
        子类覆写时须覆盖 job 全部大字段（文本/列表），否则轮询面照旧全量回传（W22）。"""
        return self._snap(job)

    def get(self, key):
        with self._lock:
            job = self._jobs.get(key)
            if not job:
                return None
            self._touch(job)
            if job.get("running"):
                return self._light(job)          # 在跑：子类轻载（P7）
            cache = job.get("_done_cache")
            if cache is None or cache.get("applied") != job.get("applied"):
                cache = self._snap(job)
                job["_done_cache"] = cache       # 完成态首拍缓存（P0·S3-W35）：只以 applied 变更失效
            return cache
        # 约定：完成态缓存按「只读」返回（轮询 / apply 侧不得原地改）——快照语义自 S1-W24/P7 起为只读共享

    # ── 启动期模板（子类给三个钩子；P0·S3-P4） ──

    def start_job(self, find, build, run, run_args=()):
        """启动任务（模板方法）：锁内三步（查重并入 → 闸门 → 登记）+ 快照，锁外起线程。

        find：谓词——查在跑同目标任务（命中 → 返回其快照并入）；build：构造 (job_id, job)；
        build 只给条目形状——running / started_at 由本方法统一补。run(job_id, *run_args)：
        线程入口。返回快照（新任务或加入快照 joined=True）。闸门满 → ValueError（文案单点）。
        """
        with self._lock:
            joined = self._find_running(find)
            if joined:
                return joined
            if not self._gate_acquire():
                raise ValueError(GATE_BUSY_MSG % self._gate.limit)
            job_id = self._seq_id()
            job = build(job_id)
            job.setdefault("running", True)
            job["started_at"] = now_ts()
            self._register(job_id, job, gated=True)
            snap = self._snap(job)
        threading.Thread(target=run, args=(job_id, *run_args), daemon=True).start()
        return snap

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

    def _register(self, key, job, gated=False):
        """锁内：登记任务 + 剪枝；gated=True 时记账闸名额（须紧跟在成功的 _gate_acquire 之后）——P0·S1-B6。"""
        if gated and self._gate is not None:
            self._gated.add(key)
        self._jobs[key] = job
        self._prune()

    def _prune(self):
        """只淘汰已完成任务（M9）：在跑任务绝不剪——不够删就允许超 keep。"""
        if self._keep is None or len(self._jobs) <= self._keep:
            return
        room = len(self._jobs) - self._keep
        for key in list(self._jobs):          # 注册序淘汰（dict 插入序；P0·S1-W23）
            if room <= 0:
                break
            j = self._jobs.get(key)
            if j and j.get("running"):
                continue
            self._jobs.pop(key, None)
            room -= 1

    # ── 收尾 ──

    def _finish(self, key, err=None):
        """任务收尾（任意线程）：置终态 + 释放闸门（恰好一次）。"""
        with self._lock:
            job = self._jobs.get(key)
            if job:
                job["running"] = False
                job["error"] = err
                job["finished_at"] = now_ts()
                self._touch(job)
            gated = key in self._gated
            self._gated.discard(key)
        if gated and self._gate is not None:
            self._gate.release()
