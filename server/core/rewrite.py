"""AI 创作通道（M4b-1）：改写预览（动作族 + 指挥条）+ 应用落库。

口径（拍板）：
- 预览零写入：AI 产物先过目、再落库——不点「应用 / 接受」，库里一字不动。
- 应用走 ops.batch_update(source='ai')：白名单 + 痕迹（旧→新）+ 一次事务；撤销在前端栈。
- 配方 = recipes/ai/*.md（一份配方一个动作）；每次调用现读——改了立即生效、无需重启。
- 单次 ≤ 30 条；只改写既有文本——不增行、不删行、不动未选中项。
- 预览任务在内存（重启即清，进度不是持久数据）；apply 前校验「原值未变」，防误覆盖手工改动。
- 闸门（M10→L1）：同场在跑 → 并入（快照带 joined=True）；全通道并发 ≤ TASKS_MAX（core/jobs.py 单点），防连点刷外呼。
"""
import json
import threading
import time

from core import ai, ai_out, db, digest, fields, jobs, ops, recipes

ACTIONS = {"rewrite": "rewrite.md", "concretize": "concretize.md",
           "strengthen": "strengthen.md", "expand": "expand.md"}
CMDBAR_RECIPE = "cmdbar.md"
MAX_TARGETS = fields.AI_MAX_TARGETS
INSTRUCTION_MAX = fields.INSTRUCTION_MAX
CONTEXT_MAX = 600
AI_FIELDS = fields.AI_FIELDS              # 单源：core/fields.py（批4/P8）
FIELD_LABELS = {f["key"]: f["label"] for f in (fields.SHOT_FIELDS + fields.BEAT_FIELDS)}
_BRIEF = (("shot_size", 60), ("camera_pos", 60), ("blocking", 60))   # 镜头速览 spec（digest.shots_lines）

# 并发闸门与任务簿机制：core/jobs.py 单点（L1）——本域只留条目形状与 _run


def load_recipe(name):
    """读一份创作配方（现读；改完下次调用即生效）。
    经配方注册表白名单 + 路径双保险（批3 收口：不再裸拼路径）。"""
    r = recipes.read(name)
    if r["group"] != "ai":
        raise ValueError("不是创作配方：%s" % name)
    return r["content"]


# ════════ 目标校验与上下文装载 ════════

def _load_scene(con, scene_id):
    ctx = db.scene_ctx(con, scene_id)   # 整场装载单点（P0·S1-W1）
    if not ctx:
        raise ValueError("场景不存在")
    return ctx


def _norm_targets(con, scene_id, targets, by_key=None):
    """校验并规范化目标清单（i = 原始序号，前端按它对位）。
    db 目标 {table,id,field}；text 目标 {kind:'text',text,context?}（不进库，只取稿）。
    by_key：{("beats"|"shots", id): 行} 已装载映射（W13：免逐条 SELECT；只含本场行——不在即非本场）。"""
    if not isinstance(targets, list) or not targets:
        raise ValueError("目标为空")
    if len(targets) > MAX_TARGETS:
        raise ValueError("一次最多 %d 条（当前 %d 条）——请分批" % (MAX_TARGETS, len(targets)))
    out = []
    for i, t in enumerate(targets):
        t = t if isinstance(t, dict) else {}
        label = str(t.get("label") or "").strip()
        if t.get("kind") == "text":
            text = str(t.get("text") or "")
            item = {"i": i, "kind": "text",
                    "label": label or ("文本 %d" % (i + 1)),
                    "context": str(t.get("context") or "").strip()[:CONTEXT_MAX],
                    "before": text, "after": None, "error": None, "ms": 0}
            if not text.strip():
                item["error"] = "原文为空"
            out.append(item)
            continue
        table, rid, fld = t.get("table"), t.get("id"), t.get("field")
        ok = (table in AI_FIELDS and fields.is_id(rid)
              and isinstance(fld, str) and fld in AI_FIELDS[table])
        if not ok:
            raise ValueError("第 %d 条目标不受支持（%s.%s）" % (i + 1, table, fld))
        if by_key is not None:
            row = by_key.get((table, rid))            # W13：内存取行（不在装载集 = 不存在或非本场）
            if not row:
                raise ValueError("第 %d 条目标不存在或不属于本场" % (i + 1))
        else:
            row = con.execute("SELECT * FROM %s WHERE id=?" % table, (rid,)).fetchone()
            if not row or row["scene_id"] != scene_id:
                raise ValueError("第 %d 条目标不存在或不属于本场" % (i + 1))
        no = row["shot_no"] if table == "shots" else row["beat_no"]
        item = {"i": i, "kind": "db", "table": table, "id": rid, "field": fld,
                "label": label or ("%s%s · %s" % (
                    "镜" if table == "shots" else "节拍", no, FIELD_LABELS.get(fld, fld))),
                "before": row[fld] or "", "after": None, "error": None, "ms": 0}
        if not item["before"].strip():
            item["error"] = "原文为空"
        out.append(item)
    return out


def build_user(sc, beats, shots, items):
    """拼 user 消息：场线 + 节拍线 + 镜头速览 + 待改写清单（序号对位）。"""
    lines = [digest.scene_line(sc)]
    bl = "；".join(digest.beat_line(b, b["beat_no"]) for b in beats)   # W18：节拍行单点
    if bl:
        lines.append("节拍：" + bl)
    lines.append("镜头速览：")
    lines += digest.shots_lines(shots, _BRIEF)
    lines.append("")
    lines.append("【待改写 %d 条】" % len(items))
    for it in items:
        lines.append("序号 %d ｜ %s" % (it["i"], it["label"]))
        if it.get("context"):
            lines.append("所在段落：%s" % it["context"])
        lines.append("原文：%s" % it["before"].strip())
    return "\n".join(lines)


# ════════ 预览任务（内存级；轮询出稿） ════════

class PreviewJobs(jobs.JobBoard):
    """改写预览任务：一次调用出一版全稿；预览零写入（items 只活在内存，apply 时才落库）。"""

    def __init__(self, keep=40, gate=jobs.TASKS):
        super().__init__(keep=keep, gate=gate)

    @staticmethod
    def _done(job):
        return sum(1 for it in job["items"] if it["error"] or it["after"])

    def _touch(self, job):
        job["done"] = self._done(job)

    def _light(self, job):
        snap = dict(job)                     # 轮询期轻载（P7）：大文本不进快照
        snap["items"] = [{"i": it["i"], "label": it["label"],
                          "error": it["error"], "ms": it["ms"]}
                         for it in job["items"]]
        return snap

    def start(self, scene_id, targets, action=None, instruction=None,
              chat=None, connect_factory=None):
        """校验目标（同步——参数错立即抛）→ 建任务 → 后台出稿。返回任务快照。
        同场已在跑 → 并入该任务（快照带 joined=True）；并发超限 → ValueError。"""
        if not fields.is_id(scene_id):
            raise ValueError("参数不完整（scene_id）")
        if instruction is not None and not isinstance(instruction, str):
            raise ValueError("instruction 必须是文本")
        if action is not None and not isinstance(action, str):
            raise ValueError("action 必须是文本")
        instruction = (instruction or "").strip()[:INSTRUCTION_MAX] or None
        if action is not None and instruction:
            raise ValueError("action 与 instruction 只能给一个")
        if action is None and not instruction:
            raise ValueError("参数不完整（action 或 instruction）")
        if action is not None and action not in ACTIONS:
            raise ValueError("未知 action：%s" % action)
        con = connect_factory() if connect_factory else db.open_ro()
        try:
            sc, beats, shots = _load_scene(con, scene_id)
            by_key = {("beats", r["id"]): r for r in beats}
            by_key.update({("shots", r["id"]): r for r in shots})
            items = _norm_targets(con, scene_id, targets, by_key)     # W13：复用已装载行
        finally:
            con.close()

        def build(job_id):
            job = {"id": job_id, "scene_id": scene_id,
                   "action": action, "instruction": instruction,
                   "finished_at": None, "error": None, "ms": 0,
                   "total": len(items), "done": 0, "items": items}
            job["done"] = self._done(job)
            return job

        return self.start_job(              # P4 启动模板（锁内三步 + 快照 + 起线程）
            find=lambda j: j.get("scene_id") == scene_id,
            build=build, run=self._run,
            run_args=(sc, beats, shots, items, action, instruction, chat, connect_factory))

    def _run(self, job_id, sc, beats, shots, items, action, instruction,
             chat, connect_factory):
        send = [it for it in items if not it["error"]]
        if not send:
            self._finish(job_id)
            return
        try:
            cfg, ai_chat = ai.open_channel(chat, connect_factory)    # W15：开通道单点
            recipe = load_recipe(ACTIONS[action] if action else CMDBAR_RECIPE)
            user = build_user(sc, beats, shots, send)
            if instruction:
                user += "\n\n【用户命令】%s" % instruction
            t0 = time.time()
            text = ai_chat(cfg, [{"role": "system", "content": recipe},
                                 {"role": "user", "content": user}])
            ms = int((time.time() - t0) * 1000)
            got = ai_out.parse_items(text, {it["i"] for it in send})
            with self._lock:
                job = self._jobs.get(job_id)
                if job:
                    for it in job["items"]:
                        if it["error"]:
                            continue
                        it["after"] = got.get(it["i"])
                        it["ms"] = ms
                        if not it["after"]:
                            it["error"] = "模型未返回该条（可「再来一版」）"
                    job["ms"] = ms
            self._finish(job_id)
        except Exception as e:
            with self._lock:
                job = self._jobs.get(job_id)
                if job:
                    for it in job["items"]:
                        if not it["error"]:
                            it["error"] = "生成失败：%s" % e
            self._finish(job_id, "生成失败：%s" % e)


# ════════ 应用落库 ════════

def apply_items(con, job, item_ids=None):
    """把预览条目写库（source='ai'）。item_ids=None → 全部有稿条目。
    「原值未变」守卫：预览后手工改过的格子跳过，不覆盖。
    返回 {applied, submitted, skipped, results}（results 项带 i 对位）。"""
    if not job or job.get("running"):
        raise ValueError("预览任务不存在或未完成")
    picks = job.get("items") or []
    if item_ids is not None:
        if (not isinstance(item_ids, list) or not item_ids
                or not all(fields.is_id(x) for x in item_ids)):
            raise ValueError("参数格式错误（item_ids）")
        want = set(item_ids)
    else:
        want = {it["i"] for it in picks}
    last = {}                                # 同一 (表,行,字段) 多条目 → 只认最后一条
    for it in picks:
        if it["i"] not in want or it.get("kind") != "db" or not it.get("after"):
            continue
        t, f = it.get("table"), it.get("field")
        if t in AI_FIELDS and f in AI_FIELDS[t]:
            last[(t, it["id"], f)] = it["i"]
    items, idx, skipped, seen = [], [], [], set()
    for it in picks:
        if it["i"] not in want:
            continue
        seen.add(it["i"])
        if it.get("kind") != "db":
            skipped.append({"i": it["i"], "reason": "非入库目标（请在前端采用）"})
            continue
        if not it.get("after"):
            skipped.append({"i": it["i"], "reason": "无结果"})
            continue
        table, fld = it["table"], it["field"]
        if table not in AI_FIELDS or fld not in AI_FIELDS[table]:
            skipped.append({"i": it["i"], "reason": "目标不受支持"})
            continue
        if last.get((table, it["id"], fld)) != it["i"]:
            skipped.append({"i": it["i"], "reason": "重复目标（保留最后一条）"})
            continue
        # W14：不预检——原值期望随条目交 batch_update，与写入同一次原子裁决
        items.append({"table": table, "id": it["id"], "field": fld,
                      "value": it["after"], "expect": it["before"]})
        idx.append(it["i"])
    for x in sorted(want - seen):
        skipped.append({"i": x, "reason": "条目不存在"})
    res = ops.batch_update(con, items, source="ai")
    for r, i in zip(res["results"], idx):
        r["i"] = i
        if r.get("stale"):                        # W14：期望不匹配 → 归 skipped（同历史语义）
            r.pop("stale")
            skipped.append({"i": i, "reason": r.pop("error")})
    applied = sum(1 for r in res["results"] if r.get("changed"))
    skipped.sort(key=lambda s: s["i"])            # W14：统一按 i 序（stale 于批量后归队）
    return {"applied_n": applied, "submitted": len(items), "skipped": skipped,   # W21：与 draft 的 applied 分家
            "results": res["results"]}


JOBS = PreviewJobs()
