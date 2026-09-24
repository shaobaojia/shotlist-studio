"""草稿档（M4b-4）：从台本出草稿（场级 · 空场专用入口由前端把门） + 组级提示词初稿。

口径（拍板）：
- 两段生成（节拍骨架 → 镜头行）走后台任务、轮询出稿；预览零写入——「落入」才落库。
- 落入 = 只新增、不覆盖（编号顺延既有行）；一步撤销由前端栈（删回本次新建行）。
- 组级初稿只出稿（文本），进编辑面与否由前端决定；不自动保存。
- 配方现读（recipes/ai/draft_*.md）——与四动作同口径。
"""
import time

from . import ai, ai_out, db, digest, fields, jobs, ops
from .rewrite import load_recipe


def _parse_reply(text):
    """回包 → (dict, note)：不可解析回 ({}, 留痕)。留痕单点 ai_out.fail_note（P0·S3-P5③）。"""
    t = text or ""
    try:
        return ai_out.extract_json(t), None
    except ValueError as e:
        return {}, ai_out.fail_note(t, e)

DRAFT_BEATS_RECIPE = "draft_beats.md"
DRAFT_SHOTS_RECIPE = "draft_shots.md"
DRAFT_PROMPT_RECIPE = "draft_prompt.md"
MAX_BEATS, MAX_SHOTS = 8, 40
SCRIPT_MIN, SCRIPT_MAX = fields.SCRIPT_MIN, fields.SCRIPT_MAX    # P6②：单源
KINDS = tuple(fields.BEAT_KINDS)                                  # P3②：单源（随 meta 下发 options）
CAM_POS = tuple(next(f["options"] for f in fields.SHOT_FIELDS
                     if f["key"] == "camera_pos"))                # P3①：单源派生
NAME_MAX, TEXT_MAX = 40, 200          # 节拍名 / 文本段（P6①：截断宽度单点）
BLOCKING_MAX, MOVE_MAX, POS_MAX, DUR_MAX = 300, 60, 40, 20
ERR_MAX, LINE_MAX = 300, 80           # 任务错误 / 初稿台本行
DRAFT_TEXT_MAX = fields.DRAFT_TEXT_MAX


# ── 解析（宁缺毋滥；种类 / 机位归一化） ──────────────────────────

def parse_beats(text):
    """回包 → (节拍列表, 丢弃数, 留痕note)——P0·S3-B2/W16：容器级闸门 + 丢弃有数 + 解析留痕。"""
    obj, note = _parse_reply(text)
    rows = obj.get("beats")
    rows = rows if isinstance(rows, list) else []        # B2：非数组容器直接为空（此前 KeyError/TypeError）
    out = []
    dropped = max(0, len(rows) - MAX_BEATS)
    for b in rows[:MAX_BEATS]:
        if not isinstance(b, dict):
            dropped += 1
            continue
        name = str(b.get("name") or "").strip()[:NAME_MAX]
        kind = str(b.get("kind") or "").strip()
        item = {"name": name or "新节拍", "kind": "⚪ 填充"}
        if kind not in KINDS:
            if kind:
                item["kind_raw"] = kind[:NAME_MAX]       # W16：不再静默改写——原文随行带回（前端可提示）
        else:
            item["kind"] = kind
        oa = str(b.get("outside_action") or "").strip()[:TEXT_MAX]
        rc = str(b.get("reaction") or "").strip()[:TEXT_MAX]
        cl = str(b.get("closed_loop") or "").strip()[:TEXT_MAX]
        if not (name or oa or rc):
            dropped += 1
            continue
        item.update(outside_action=oa, reaction=rc, closed_loop=cl)
        out.append(item)
    return out, dropped, note


def parse_shots(text, nbeats):
    """回包 → (镜头列表, 丢弃数, 留痕note)——P0·S3-B2/W16：容器级闸门 + 丢弃有数 + 解析留痕。"""
    obj, note = _parse_reply(text)
    rows = obj.get("shots")
    rows = rows if isinstance(rows, list) else []        # B2：非数组容器直接为空
    out = []
    dropped = max(0, len(rows) - MAX_SHOTS)
    for s in rows[:MAX_SHOTS]:
        if not isinstance(s, dict):
            dropped += 1
            continue
        try:
            bi = int(s.get("beat"))
        except (TypeError, ValueError):
            dropped += 1
            continue
        if not (1 <= bi <= nbeats):
            dropped += 1
            continue
        blk = str(s.get("blocking") or "").strip()[:BLOCKING_MAX]
        dlg = str(s.get("dialogue") or "").strip()[:TEXT_MAX]
        if not blk and not dlg:
            dropped += 1
            continue
        pos = str(s.get("camera_pos") or "").strip()
        if pos and pos not in CAM_POS:
            pos = ai_out.norm_option(pos, CAM_POS) or pos    # P3③：按 options 归一（精确+容错）
        out.append({"beat": bi,
                    "camera_move": str(s.get("camera_move") or "").strip()[:MOVE_MAX],
                    "camera_pos": pos[:POS_MAX],
                    "blocking": blk, "dialogue": dlg,
                    "duration": _strip_dur(s.get("duration"))})
    return out, dropped, note


def _strip_dur(v):
    # F4-B6：剥尾缀单位（s/S/秒），落库后 ribbon 统一拼「s」，防「2ss / 2秒s」
    v = str(v or "").strip()
    while v and (v[-1] in "sS" or v.endswith("秒")):
        v = v[:-1]
    return v[:DUR_MAX]


_MEMBER_SPEC = (("shot_size", 80), ("focal", 80), ("camera_move", 80), ("camera_pos", 80),
                ("spatial", 80), ("blocking", 80), ("dialogue", 80))   # 组内镜头速览 spec


# ── 任务（内存级；重启即清） ────────────────────────────────────

class DraftJobs(jobs.JobBoard):
    """草稿任务簿：场级草稿（两段生成）+ 组级初稿；轮询期轻载（P7）。"""

    def __init__(self, keep=30, gate=jobs.TASKS):
        super().__init__(keep=keep, gate=gate)

    def _light(self, job):
        snap = dict(job)                     # 轮询期轻载（P7）：骨架正文不随轮询回传
        snap["beats"] = []
        snap["shots"] = []
        snap["text"] = None
        snap["beats_n"] = len(job.get("beats") or [])
        snap["shots_n"] = len(job.get("shots") or [])
        return snap

    # ── 场级：从台本出草稿 ──

    def start_scene(self, scene_id, script, chat=None, connect_factory=None):
        if not fields.is_id(scene_id):
            raise ValueError("参数不完整（scene_id）")
        script = (script or "").strip()
        if len(script) < SCRIPT_MIN:
            raise ValueError("台本太短（至少 %d 字）" % SCRIPT_MIN)
        if len(script) > SCRIPT_MAX:
            raise ValueError("台本太长（上限 %d 字）" % SCRIPT_MAX)
        con = connect_factory() if connect_factory else db.open_ro()
        try:
            sc = db.row(con, "scenes", scene_id, "场景不存在")     # W19/W8：取行单点
        finally:
            con.close()

        def build(job_id):
            return {"id": job_id, "kind": "scene", "scene_id": scene_id,
                    "stage": "beats", "error": None, "ms": 0,
                    "finished_at": None, "beats": [], "shots": [], "applied": False}

        return self.start_job(              # P4 启动模板（锁内三步 + 快照 + 起线程）
            find=lambda j: j.get("kind") == "scene" and j.get("scene_id") == scene_id,
            build=build, run=self._run_scene,
            run_args=(sc, script, chat, connect_factory))

    def _run_scene(self, job_id, sc, script, chat, connect_factory):
        try:
            cfg, ai_chat = ai.open_channel(chat, connect_factory)    # W15：开通道单点
            t0 = time.time()
            scene_line = digest.scene_line_terse(sc)
            text1 = ai_chat(cfg, [
                {"role": "system", "content": load_recipe(DRAFT_BEATS_RECIPE)},
                {"role": "user", "content": scene_line + "\n\n【台本】\n" + script}])
            beats, dropped, pnote = parse_beats(text1)
            if not beats:
                raise ValueError("节拍骨架生成为空——可「重来」" + ("；%s" % pnote if pnote else ""))
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["beats"] = beats
                    j["dropped"] = dropped          # W16：丢弃有数（前端可提示）
                    j["stage"] = "shots"
            lines = [scene_line, "", "【台本】", script, "", "【节拍骨架】"]
            lines += [digest.beat_line(b, i + 1, style="labeled")   # W18：节拍行单点
                      for i, b in enumerate(beats)]
            text2 = ai_chat(cfg, [
                {"role": "system", "content": load_recipe(DRAFT_SHOTS_RECIPE)},
                {"role": "user", "content": "\n".join(lines)}])
            shots, dropped2, pnote2 = parse_shots(text2, len(beats))
            if not shots:
                raise ValueError("镜头行生成为空——可「重来」" + ("；%s" % pnote2 if pnote2 else ""))
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["shots"] = shots
                    j["dropped"] = dropped + dropped2
                    j["ms"] = int((time.time() - t0) * 1000)
                    # W20：stage 只表生成阶段（beats→shots）——终态由 running/error 表达
            self._finish(job_id)
        except Exception as e:      # noqa: BLE001 —— 任务错误留给前端展示
            self._finish(job_id, str(e)[:ERR_MAX])

    # ── 组级：提示词初稿 ──

    def start_prompt(self, scene_id, shot_id, chat=None, connect_factory=None):
        if not fields.is_id(scene_id) or not fields.is_id(shot_id):
            raise ValueError("参数不完整（scene_id / shot_id）")
        con = connect_factory() if connect_factory else db.open_ro()
        try:
            sc = db.row(con, "scenes", scene_id, "场景不存在")            # W19/W8
            sh = db.row(con, "shots", shot_id, "镜头不存在或不属于本场")
            if sh["scene_id"] != scene_id:
                raise ValueError("镜头不存在或不属于本场")
            if sh["prompt_group_id"] is not None:
                members = db.group_members(con, [sh["prompt_group_id"]])[sh["prompt_group_id"]]  # W2
            else:
                members = [sh]
            blocks = [r[0] for r in con.execute(
                "SELECT text FROM blocks ORDER BY position, id LIMIT 80")]
        finally:
            con.close()

        def build(job_id):
            return {"id": job_id, "kind": "prompt", "scene_id": scene_id, "shot_id": shot_id,
                    "stage": "prompt", "error": None, "ms": 0, "finished_at": None,
                    "text": None, "members": [m["shot_no"] for m in members]}

        return self.start_job(
            find=lambda j: j.get("kind") == "prompt" and j.get("shot_id") == shot_id,
            build=build, run=self._run_prompt,
            run_args=(sc, members, blocks, chat, connect_factory))

    def _run_prompt(self, job_id, sc, members, blocks, chat, connect_factory):
        try:
            cfg, ai_chat = ai.open_channel(chat, connect_factory)    # W15：开通道单点
            t0 = time.time()
            lines = [digest.scene_line_terse(sc), "", "【组内镜头（%d 镜）】" % len(members)]
            lines += digest.shots_lines(members, _MEMBER_SPEC)
            lines.append("")
            lines.append("【块库（可复用句式）】")
            for t in blocks:
                t = " ".join(str(t).split())
                if t:
                    lines.append("- " + t[:LINE_MAX])
            text = ai_out.strip_fence(ai_chat(cfg, [
                {"role": "system", "content": load_recipe(DRAFT_PROMPT_RECIPE)},
                {"role": "user", "content": "\n".join(lines)}]))
            if not text:
                raise ValueError("初稿生成为空——可「再来一版」")
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["text"] = text[:DRAFT_TEXT_MAX]
                    j["ms"] = int((time.time() - t0) * 1000)
            self._finish(job_id)
        except Exception as e:      # noqa: BLE001
            self._finish(job_id, str(e)[:ERR_MAX])

    # ── 落入（同步；只新增 + 痕迹 source=ai） ──

    def apply(self, job_id, connect_factory=None):
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise ValueError("任务不存在（服务重启后请重新生成）")
            if job["kind"] != "scene":
                raise ValueError("该任务不是场次草稿")
            if job["running"]:
                raise ValueError("任务还在生成中")
            if job["error"] or not job["beats"] or not job["shots"]:
                raise ValueError("草稿不可用：%s" % (job["error"] or "生成为空"))
            if job.get("applied"):
                raise ValueError("这份草稿已落入过——请重新生成")
            job["applied"] = True        # 锁内认领（CAS）：并发双落入只放行一份
            beats = [dict(b) for b in job["beats"]]
            shots = [dict(s) for s in job["shots"]]
            scene_id = job["scene_id"]
        con = connect_factory() if connect_factory else db.open_rw()
        try:
            db.row(con, "scenes", scene_id, "场景不存在（可能已被删除）")   # W19/W8：取行单点
            beat_ids = ops.append_beats(con, scene_id, [
                {"name": b["name"], "kind": b["kind"], "outside_action": b["outside_action"],
                 "reaction": b["reaction"], "closed_loop": b["closed_loop"]}
                for b in beats], source="ai")
            shot_ids = ops.append_shots(con, scene_id, [
                {"beat_id": beat_ids[s["beat"] - 1], "camera_move": s["camera_move"],
                 "camera_pos": s["camera_pos"], "blocking": s["blocking"],
                 "dialogue": s["dialogue"], "duration": s["duration"]}
                for s in shots], source="ai")
            con.commit()
        except Exception:
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["applied"] = False     # 写失败放开认领：修正后可重试
            raise
        finally:
            con.close()
        return {"beat_ids": beat_ids, "shot_ids": shot_ids,
                "applied": {"beats": len(beat_ids), "shots": len(shot_ids)}}
