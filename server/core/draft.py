"""草稿档（M4b-4）：从台本出草稿（场级 · 空场专用入口由前端把门） + 组级提示词初稿。

口径（拍板）：
- 两段生成（节拍骨架 → 镜头行）走后台任务、轮询出稿；预览零写入——「落入」才落库。
- 落入 = 只新增、不覆盖（编号顺延既有行）；一步撤销由前端栈（删回本次新建行）。
- 组级初稿只出稿（文本），进编辑面与否由前端决定；不自动保存。
- 配方现读（recipes/ai/draft_*.md）——与四动作同口径。
"""
import json
import re
import threading
import time

from . import ai, db, ops
from .rewrite import _extract_json, load_recipe

DRAFT_BEATS_RECIPE = "draft_beats.md"
DRAFT_SHOTS_RECIPE = "draft_shots.md"
DRAFT_PROMPT_RECIPE = "draft_prompt.md"
MAX_BEATS, MAX_SHOTS = 8, 40
SCRIPT_MIN, SCRIPT_MAX = 30, 6000
KINDS = ("🔴 戏点", "🟡 空间建立", "⚪ 填充")
CAM_POS = ("🔴 正打", "🟡 反打", "🟢 第三人称", "🔵 空间环境", "🟣 插入/切出")


# ── 解析（宁缺毋滥；种类 / 机位归一化） ──────────────────────────

def parse_beats(text):
    obj = _extract_json(text)
    out = []
    for b in (obj.get("beats") or [])[:MAX_BEATS]:
        if not isinstance(b, dict):
            continue
        name = str(b.get("name") or "").strip()[:40]
        kind = str(b.get("kind") or "").strip()
        if kind not in KINDS:
            kind = "⚪ 填充"
        oa = str(b.get("outside_action") or "").strip()[:200]
        rc = str(b.get("reaction") or "").strip()[:200]
        cl = str(b.get("closed_loop") or "").strip()[:200]
        if not (name or oa or rc):
            continue
        out.append({"name": name or "新节拍", "kind": kind,
                    "outside_action": oa, "reaction": rc, "closed_loop": cl})
    return out


def parse_shots(text, nbeats):
    obj = _extract_json(text)
    out = []
    for s in (obj.get("shots") or [])[:MAX_SHOTS]:
        if not isinstance(s, dict):
            continue
        try:
            bi = int(s.get("beat"))
        except (TypeError, ValueError):
            continue
        if not (1 <= bi <= nbeats):
            continue
        blk = str(s.get("blocking") or "").strip()[:300]
        dlg = str(s.get("dialogue") or "").strip()[:200]
        if not blk and not dlg:
            continue
        pos = str(s.get("camera_pos") or "").strip()
        if pos and pos not in CAM_POS:
            for cand in CAM_POS:                      # 裸词容错：正打 → 🔴 正打
                if pos in cand:
                    pos = cand
                    break
        out.append({"beat": bi,
                    "camera_move": str(s.get("camera_move") or "").strip()[:60],
                    "camera_pos": pos[:40],
                    "blocking": blk, "dialogue": dlg,
                    "duration": str(s.get("duration") or "").strip()[:20]})
    return out


def _strip_fence(t):
    t = (t or "").strip()
    if t.startswith("```"):
        lines = t.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    return t


def _reply_text(reply):
    """真 chat 返回 {text,...}·测试桩返回 str——同 rewrite.py 口径归一。"""
    return (reply.get("text") or "") if isinstance(reply, dict) else (reply or "")


def _scene_line(sc):
    parts = ["场：%s %s" % (sc.get("scene_no") or "?", sc.get("title") or "")]
    if sc.get("value"):
        parts.append("价值：%s" % sc["value"])
    if sc.get("pole_start") or sc.get("pole_end"):
        parts.append("弧线：%s → %s" % (sc.get("pole_start") or "—", sc.get("pole_end") or "—"))
    return " ｜ ".join(parts)


# ── 任务（内存级；重启即清） ────────────────────────────────────

class DraftJobs:
    def __init__(self, keep=30):
        self._lock = threading.Lock()
        self._jobs = {}
        self._seq = 0
        self._keep = keep

    def _snap(self, job):
        return json.loads(json.dumps(job, ensure_ascii=False))

    def get(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            return self._snap(job) if job else None

    def _prune(self):
        if len(self._jobs) <= self._keep:
            return
        for old in sorted(self._jobs)[:len(self._jobs) - self._keep]:
            self._jobs.pop(old, None)

    # ── 场级：从台本出草稿 ──

    def start_scene(self, scene_id, script, chat=None, connect_factory=None):
        script = (script or "").strip()
        if len(script) < SCRIPT_MIN:
            raise ValueError("台本太短（至少 %d 字）" % SCRIPT_MIN)
        if len(script) > SCRIPT_MAX:
            raise ValueError("台本太长（上限 %d 字）" % SCRIPT_MAX)
        con = connect_factory() if connect_factory else db.connect()
        try:
            sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
            if not sc:
                raise ValueError("场景不存在")
            sc = dict(sc)
        finally:
            con.close()
        with self._lock:
            self._seq += 1
            job_id = self._seq
            job = {"id": job_id, "kind": "scene", "scene_id": scene_id, "running": True,
                   "stage": "beats", "error": None, "ms": 0,
                   "started_at": time.strftime("%Y-%m-%d %H:%M:%S"), "finished_at": None,
                   "beats": [], "shots": [], "applied": False}
            self._jobs[job_id] = job
            self._prune()
            snap = self._snap(job)
        threading.Thread(target=self._run_scene, args=(
            job_id, sc, script, chat, connect_factory), daemon=True).start()
        return snap

    def _run_scene(self, job_id, sc, script, chat, connect_factory):
        def finish(err=None):
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["running"] = False
                    j["error"] = err
                    j["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            con = connect_factory() if connect_factory else db.connect()
            try:
                cfg = ai.get_config(con)
            finally:
                con.close()
            ai_chat = chat or (lambda c, m: ai.chat(c, m))
            t0 = time.time()
            scene_line = _scene_line(sc)
            reply1 = ai_chat(cfg, [
                {"role": "system", "content": load_recipe(DRAFT_BEATS_RECIPE)},
                {"role": "user", "content": scene_line + "\n\n【台本】\n" + script}])
            beats = parse_beats(_reply_text(reply1))
            if not beats:
                raise ValueError("节拍骨架生成为空——可「重来」")
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["beats"] = beats
                    j["stage"] = "shots"
            lines = [scene_line, "", "【台本】", script, "", "【节拍骨架】"]
            for i, b in enumerate(beats):
                lines.append("%d ｜ %s ｜ %s ｜ 外界动作:%s ｜ 反应:%s ｜ 闭环:%s" % (
                    i + 1, b["name"], b["kind"], b["outside_action"], b["reaction"], b["closed_loop"]))
            reply2 = ai_chat(cfg, [
                {"role": "system", "content": load_recipe(DRAFT_SHOTS_RECIPE)},
                {"role": "user", "content": "\n".join(lines)}])
            shots = parse_shots(_reply_text(reply2), len(beats))
            if not shots:
                raise ValueError("镜头行生成为空——可「重来」")
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["shots"] = shots
                    j["stage"] = "done"
                    j["ms"] = int((time.time() - t0) * 1000)
            finish()
        except Exception as e:      # noqa: BLE001 —— 任务错误留给前端展示
            finish(str(e)[:300])

    # ── 组级：提示词初稿 ──

    def start_prompt(self, scene_id, shot_id, chat=None, connect_factory=None):
        con = connect_factory() if connect_factory else db.connect()
        try:
            sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
            if not sc:
                raise ValueError("场景不存在")
            sh = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
            if not sh or sh["scene_id"] != scene_id:
                raise ValueError("镜头不存在或不属于本场")
            if sh["prompt_group_id"] is not None:
                members = list(con.execute(
                    "SELECT * FROM shots WHERE prompt_group_id=? ORDER BY position, id",
                    (sh["prompt_group_id"],)))
            else:
                members = [sh]
            members = [dict(m) for m in members]
            blocks = [r[0] for r in con.execute(
                "SELECT text FROM blocks ORDER BY position, id LIMIT 80")]
            sc = dict(sc)
        finally:
            con.close()
        with self._lock:
            self._seq += 1
            job_id = self._seq
            job = {"id": job_id, "kind": "prompt", "scene_id": scene_id, "shot_id": shot_id,
                   "running": True, "stage": "prompt", "error": None, "ms": 0,
                   "started_at": time.strftime("%Y-%m-%d %H:%M:%S"), "finished_at": None,
                   "text": None, "members": [m["shot_no"] for m in members]}
            self._jobs[job_id] = job
            self._prune()
            snap = self._snap(job)
        threading.Thread(target=self._run_prompt, args=(
            job_id, sc, members, blocks, chat, connect_factory), daemon=True).start()
        return snap

    def _run_prompt(self, job_id, sc, members, blocks, chat, connect_factory):
        def finish(err=None):
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["running"] = False
                    j["error"] = err
                    j["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            con = connect_factory() if connect_factory else db.connect()
            try:
                cfg = ai.get_config(con)
            finally:
                con.close()
            ai_chat = chat or (lambda c, m: ai.chat(c, m))
            t0 = time.time()
            lines = [_scene_line(sc), "", "【组内镜头（%d 镜）】" % len(members)]
            for m in members:
                parts = ["镜%s" % m["shot_no"]]
                for key, cn in (("shot_size", "景别"), ("focal", "焦段"), ("camera_move", "运镜"),
                                ("camera_pos", "机位"), ("spatial", "空间关系"),
                                ("blocking", "动作"), ("dialogue", "台词")):
                    v = (m.get(key) or "").strip().replace("\n", " ")
                    if v:
                        parts.append("%s:%s" % (cn, v[:80]))
                lines.append(" ｜ ".join(parts))
            lines.append("")
            lines.append("【块库（可复用句式）】")
            for t in blocks:
                t = " ".join(str(t).split())
                if t:
                    lines.append("- " + t[:80])
            reply = ai_chat(cfg, [
                {"role": "system", "content": load_recipe(DRAFT_PROMPT_RECIPE)},
                {"role": "user", "content": "\n".join(lines)}])
            text = _strip_fence(_reply_text(reply))
            if not text:
                raise ValueError("初稿生成为空——可「再来一版」")
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["text"] = text[:8000]
                    j["ms"] = int((time.time() - t0) * 1000)
            finish()
        except Exception as e:      # noqa: BLE001
            finish(str(e)[:300])

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
        con = connect_factory() if connect_factory else db.connect(rw=True)
        try:
            sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
            if not sc:
                raise ValueError("场景不存在（可能已被删除）")
            ex_b = list(con.execute(
                "SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,)))
            ex_s = list(con.execute(
                "SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))
            mx_b = mx_s = 0
            for b in ex_b:
                m = re.match(r"^(\d+)", str(b["beat_no"] or ""))
                if m:
                    mx_b = max(mx_b, int(m.group(1)))
            for s in ex_s:
                m = re.match(r"^(\d+)", str(s["shot_no"] or ""))
                if m:
                    mx_s = max(mx_s, int(m.group(1)))
            pos_b = max([b["position"] for b in ex_b]) + 1 if ex_b else 0
            pos_s = max([s["position"] for s in ex_s]) + 1 if ex_s else 0
            beat_ids = []
            for i, b in enumerate(beats):
                no = str(mx_b + 1 + i)
                cur = con.execute(
                    "INSERT INTO beats (scene_id, position, beat_no, name, kind,"
                    " outside_action, reaction, closed_loop) VALUES (?,?,?,?,?,?,?,?)",
                    (scene_id, pos_b + i, no, b["name"], b["kind"],
                     b["outside_action"], b["reaction"], b["closed_loop"]))
                bid = cur.lastrowid
                beat_ids.append(bid)
                ops.record_history(con, scene_id, "beats", bid, "create", None, no, source="ai")
            shot_ids = []
            for k, s in enumerate(shots):
                no = "%02d" % (mx_s + 1 + k)
                cur = con.execute(
                    "INSERT INTO shots (scene_id, beat_id, position, shot_no, camera_move,"
                    " camera_pos, blocking, dialogue, duration) VALUES (?,?,?,?,?,?,?,?,?)",
                    (scene_id, beat_ids[s["beat"] - 1], pos_s + k, no, s["camera_move"],
                     s["camera_pos"], s["blocking"], s["dialogue"], s["duration"]))
                sid = cur.lastrowid
                shot_ids.append(sid)
                ops.record_history(con, scene_id, "shots", sid, "create", None, no, source="ai")
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
