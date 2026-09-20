"""审计引擎（M4a）：规则注册表 + 程序类规则 + LLM 类规则 + 问题对账（三态）+ 设置存取。

载体（carrier）：scene / beat / shot / seam；target_id 语义：
  scene → 场 id；beat → 节拍 id；shot → 镜头 id；seam → 「镜头id>镜头id」。
对账键 = (scene, rule, carrier, target)：重跑幂等；同键多消息合并（「；」）。
状态机：open --重跑未再命中--> fixed；fixed --再次命中--> open；waived 不自动重开（用户拍板接受，可手动取消豁免）。
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from core import ai, db, ops

CARRIERS = ("scene", "beat", "shot", "seam")

# ── 规则注册表（种子定义唯一点；scripts/seed_audit_rules.py 由此落库） ──
DEFAULT_RULES = [
    ("轴线", "llm", {},
     "相邻镜头越轴检查：视线/位置反转且无过渡镜（seam 载体）。"),
    ("闭环", "program", {"require_reaction_shot": False},
     "外界动作→人物反应闭环：节拍字段链完整性。"),
    ("戏点密度", "program", {"min_shots": 3},
     "核心戏点（🔴）镜头数下限。"),
    ("戏点特写", "program", {"sizes": ["特写", "极特"]},
     "核心戏点至少 1 个特写/极特写（景别铁律）。"),
    ("节奏曲线", "llm", {},
     "镜头时长分布与节拍叙事职能的偏差（只报明确问题）。"),
    ("空间一致性", "llm", {},
     "角色位置突变无动机/缺过渡。"),
    ("机位一致性", "llm", {},
     "机位策略 vs 场景价值：反打连用 / 建立镜误用 / 插入过度。"),
    ("景别完整", "program", {"require_dof": False},
     "景别标注完整性（景深已并入摄影机串，抽查为主）。"),
    ("声音完整性", "program", {},
     "声音标注完整性：空音频提示（无声请标「—」）。"),
    ("动作具象化", "llm",
     {"wordlist": ["看着", "说着", "走着", "笑了笑", "看了看", "望了望",
                   "盯着", "望着", "望向", "停下脚步", "转过身"]},
     "模糊词粗筛 + 判定与具象化建议。"),
]
LLM_RECIPES = {"轴线": "axis.md", "节奏曲线": "rhythm.md", "空间一致性": "space.md",
               "机位一致性": "camera.md", "动作具象化": "concrete.md"}
FIELD_CN = {"camera_pos": "机位", "spatial": "空间", "blocking": "动作", "shot_size": "景别",
            "shot_fn": "职能", "camera_move": "运镜", "dialogue": "台词"}


# ════════ 上下文装载 ════════

def _norm_keys(x):
    """镜号/节拍号查找键变体：原样、去前导零、补两位。"""
    x = (x or "").strip()
    ks = {x} if x else set()
    if x.isdigit():
        ks.add(str(int(x)))
        if len(x) == 1:
            ks.add("0" + x)
    return ks


def load_ctx(con, scene_id):
    sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if not sc:
        raise ValueError("场景不存在")
    beats = [dict(r) for r in con.execute(
        "SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,))]
    shots = [dict(r) for r in con.execute(
        "SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,))]
    sb, bb = {}, {}
    for s in shots:
        for k in _norm_keys(s["shot_no"]):
            sb.setdefault(k, s)
    for b in beats:
        for k in _norm_keys(b["beat_no"]):
            bb.setdefault(k, b)
    return {"scene": dict(sc), "beats": beats, "shots": shots,
            "shot_by_no": sb, "beat_by_no": bb}


def _lookup(m, ref):
    for k in _norm_keys(ref):
        if k in m:
            return m[k]
    return None


# ════════ 程序类规则（纯函数：ctx → findings） ════════

def _f(carrier, target, msg):
    return (carrier, str(target), msg)


def rule_loop(ctx, p):
    out = []
    for b in ctx["beats"]:
        has_out = bool((b["outside_action"] or "").strip())
        has_rea = bool((b["reaction"] or "").strip())
        if has_out and not has_rea:
            out.append(_f("beat", b["id"], "外界动作「%s」未匹配人物反应"
                          % b["outside_action"].strip()[:24]))
        if has_out and p.get("require_reaction_shot"):
            mem = [s for s in ctx["shots"] if s["beat_id"] == b["id"]]
            if not any("反应" in (s["shot_fn"] or "") for s in mem):
                out.append(_f("beat", b["id"], "缺少反应镜（fn 无「反应镜」）"))
    return out


def rule_density(ctx, p):
    lo = int(p.get("min_shots") or 3)
    out = []
    for b in ctx["beats"]:
        if "🔴" not in (b["kind"] or ""):
            continue
        n = sum(1 for s in ctx["shots"] if s["beat_id"] == b["id"])
        if n < lo:
            out.append(_f("beat", b["id"], "戏点节拍仅 %d 镜（＜%d）" % (n, lo)))
    return out


def rule_closeup(ctx, p):
    sizes = p.get("sizes") or ["特写", "极特"]
    out = []
    for b in ctx["beats"]:
        if "🔴" not in (b["kind"] or ""):
            continue
        mem = [s for s in ctx["shots"] if s["beat_id"] == b["id"]]
        if not any(any(sz in (s["shot_size"] or "") for sz in sizes) for s in mem):
            out.append(_f("beat", b["id"], "戏点节拍缺特写镜（景别铁律：≥1 特写/极特写）"))
    return out


def rule_size(ctx, p):
    return [_f("shot", s["id"], "景别为空") for s in ctx["shots"]
            if not (s["shot_size"] or "").strip()]


def rule_sound(ctx, p):
    out = []
    for s in ctx["shots"]:
        if not (s["audio"] or "").strip():
            msg = "声音未标注（音频列空）"
            if (s["dialogue"] or "").strip():
                msg += "；本镜有台词，需落音效轨"
            out.append(_f("shot", s["id"], msg))
    return out


PROGRAM_RULES = {"闭环": rule_loop, "戏点密度": rule_density, "戏点特写": rule_closeup,
                 "景别完整": rule_size, "声音完整性": rule_sound}


# ════════ LLM 类规则（digest → 配方 → JSON findings） ════════

def _sc_head(ctx):
    sc = ctx["scene"]
    return "场：%s %s ｜ 价值：%s ｜ 弧线：%s → %s" % (
        sc.get("scene_no") or "?", sc.get("title") or "",
        sc.get("value") or "—", sc.get("pole_start") or "—", sc.get("pole_end") or "—")


def _beats_lines(ctx):
    lines = []
    for b in ctx["beats"]:
        seg = "节拍 %s [%s] %s" % (b["beat_no"], b["kind"] or "—", b["name"] or "")
        if (b["outside_action"] or "").strip():
            seg += " ｜ 外界：%s" % b["outside_action"].strip()[:50]
        if (b["reaction"] or "").strip():
            seg += " ｜ 反应：%s" % b["reaction"].strip()[:50]
        lines.append(seg)
    return lines


def _shots_lines(ctx, fields, widths):
    lines = []
    for s in ctx["shots"]:
        parts = ["镜%s" % s["shot_no"]]
        for f, w in zip(fields, widths):
            v = (s[f] or "").strip().replace("\n", " ")
            if v:
                parts.append("%s: %s" % (FIELD_CN[f], v[:w]))
        lines.append(" ｜ ".join(parts))
    return lines


def digest_axis(ctx, p):
    beats = "；".join("节拍 %s %s" % (b["beat_no"], b["name"] or "") for b in ctx["beats"])
    return "\n".join([_sc_head(ctx), "节拍：" + beats, "镜头（按顺序）："] +
                     _shots_lines(ctx, ("camera_pos", "spatial", "blocking"), (16, 60, 90)))


def digest_space(ctx, p):
    return "\n".join([_sc_head(ctx), "镜头（按顺序）："] +
                     _shots_lines(ctx, ("spatial", "blocking", "camera_pos"), (70, 110, 16)))


def digest_camera(ctx, p):
    return "\n".join([_sc_head(ctx), "节拍："] + _beats_lines(ctx) + ["镜头："] +
                     _shots_lines(ctx, ("camera_pos", "shot_fn", "shot_size", "camera_move"), (20, 10, 24, 30)))


def digest_rhythm(ctx, p):
    lines = [_sc_head(ctx), "节拍与时长："]
    for b in ctx["beats"]:
        mem = [s for s in ctx["shots"] if s["beat_id"] == b["id"]]
        durs = [str(s["duration"]).strip() if s["duration"] not in (None, "") else "—"
                for s in mem]
        vals = [float(d) for d in durs if d.replace(".", "", 1).isdigit()]
        avg = ("%.1fs" % (sum(vals) / len(vals))) if vals else "—"
        lines.append("节拍 %s [%s] %s ｜ %d 镜，时长：%s（均 %s）" % (
            b["beat_no"], b["kind"] or "—", b["name"] or "", len(mem), "/".join(durs), avg))
    return "\n".join(lines)


def digest_concrete(ctx, p):
    words = [w for w in (p.get("wordlist") or []) if w]
    cand = []
    for s in ctx["shots"]:
        bl = (s["blocking"] or "").strip()
        hit = [w for w in words if w in bl]
        if hit:
            cand.append("镜%s ｜ 命中词：%s ｜ 动作原文：%s" % (s["shot_no"], "/".join(hit), bl[:220]))
    if not cand:
        return None  # 无候选：跳过调用
    return "\n".join([_sc_head(ctx), "候选镜头（疑似模糊表达）："] + cand)


LLM_DIGESTS = {"轴线": digest_axis, "空间一致性": digest_space, "机位一致性": digest_camera,
               "节奏曲线": digest_rhythm, "动作具象化": digest_concrete}


def _load_recipe(title):
    p = db.ROOT / "recipes" / "audit" / LLM_RECIPES[title]
    if not p.is_file():
        raise ValueError("审计配方缺失：%s" % LLM_RECIPES[title])
    return p.read_text(encoding="utf-8")


def _extract_json(text):
    t = (text or "").strip()
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        return {}
    try:
        obj = json.loads(t[i:j + 1])
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _resolve_ref(ctx, carrier, ref):
    if carrier == "scene":
        return str(ctx["scene"]["id"])
    r = (ref or "").replace("镜", "").replace(" ", "")
    if carrier == "shot":
        s = _lookup(ctx["shot_by_no"], r)
        return str(s["id"]) if s else None
    if carrier == "beat":
        b = _lookup(ctx["beat_by_no"], r)
        return str(b["id"]) if b else None
    for sep in ("->", "→", ">", "-", "–"):
        if sep in r:
            a, _, c = r.partition(sep)
            s1, s2 = _lookup(ctx["shot_by_no"], a), _lookup(ctx["shot_by_no"], c)
            if s1 and s2:
                return "%s>%s" % (s1["id"], s2["id"])
    return None


def _parse_findings(ctx, text):
    data = _extract_json(text)
    out = []
    for f in (data.get("findings") or []):
        if not isinstance(f, dict):
            continue
        carrier = str(f.get("carrier") or "").strip()
        msg = str(f.get("message") or "").strip()
        if carrier not in CARRIERS or not msg:
            continue
        target = _resolve_ref(ctx, carrier, str(f.get("ref") or ""))
        if not target:
            continue
        out.append(_f(carrier, target, msg[:200]))
    return out


def _default_chat(cfg, messages):
    return ai.chat(cfg, messages)


def _run_llm_rule(ctx, rule, cfg, ai_chat):
    title = rule["title"]
    body = LLM_DIGESTS[title](ctx, rule["params"])
    if body is None:
        return []
    system = _load_recipe(title)
    reply = ai_chat(cfg, [{"role": "system", "content": system},
                          {"role": "user", "content": body}])
    text = reply["text"] if isinstance(reply, dict) else reply
    return _parse_findings(ctx, text)


# ════════ 对账与运行 ════════

def reconcile(con, scene_id, rule, findings):
    """把本轮 findings 对进 audit_issues（键 = carrier+target）。"""
    agg = {}
    for carrier, target, msg in findings:
        agg.setdefault((carrier, target), []).append(msg)
    existing = {(r["carrier"], r["target_id"]): dict(r) for r in con.execute(
        "SELECT * FROM audit_issues WHERE scene_id=? AND rule_id=?", (scene_id, rule["id"]))}
    now = set()
    for (carrier, target), msgs in agg.items():
        key = (carrier, target)
        now.add(key)
        message = "；".join(dict.fromkeys(msgs))[:500]
        ex = existing.get(key)
        if ex is None:
            con.execute("INSERT INTO audit_issues (scene_id, carrier, target_id, rule_id, message)"
                        " VALUES (?,?,?,?,?)", (scene_id, carrier, target, rule["id"], message))
        elif ex["status"] == "fixed":
            con.execute("UPDATE audit_issues SET status='open', message=?,"
                        " updated_at=datetime('now','localtime') WHERE id=?", (message, ex["id"]))
        elif ex["status"] == "open" and (ex["message"] or "") != message:
            con.execute("UPDATE audit_issues SET message=?,"
                        " updated_at=datetime('now','localtime') WHERE id=?", (message, ex["id"]))
        # waived：不动（用户拍板接受）
    for key, ex in existing.items():
        if key not in now and ex["status"] == "open":
            con.execute("UPDATE audit_issues SET status='fixed',"
                        " updated_at=datetime('now','localtime') WHERE id=?", (ex["id"],))


def run_scene(con, scene_id, only=None, ai_chat=None, write=True, progress=None):
    """跑审计：only=None → 全部启用规则；only={id,…} → 指定规则（重检，无视开关）。
    progress(rule, state, found, error, ms) 供任务进度上报（state: running/done/error）。
    返回 (summary, state)。"""
    ctx = load_ctx(con, scene_id)
    rules = [dict(r) for r in con.execute("SELECT * FROM audit_rules ORDER BY id")]
    if only is not None:
        ids = set(only)
        rules = [r for r in rules if r["id"] in ids]
    else:
        rules = [r for r in rules if r["enabled"]]
    for r in rules:
        r["params"] = _params(r)
    cfg = ai.get_config(con)
    chat = ai_chat or _default_chat
    t0 = time.time()
    plan, llm_jobs = [], []
    for r in rules:
        if r["title"] in PROGRAM_RULES:
            try:
                plan.append([r, PROGRAM_RULES[r["title"]](ctx, r["params"]), None, 0])
            except Exception as e:
                plan.append([r, None, "程序规则异常：%s" % e, 0])
        elif r["title"] in LLM_RECIPES:
            llm_jobs.append(r)
            plan.append([r, None, None, 0])
        else:
            plan.append([r, None, "无实现", 0])
    if progress:
        for r, findings, err, ms in plan:
            if findings is None and err is None and r["title"] in LLM_RECIPES:
                continue  # LLM 规则待跑
            progress(r, "error" if err else "done", len(findings or []), err, ms)
    if llm_jobs:
        with ThreadPoolExecutor(max_workers=min(5, len(llm_jobs))) as ex:
            futs = {}
            for r in llm_jobs:
                if progress:
                    progress(r, "running", 0, None, 0)
                futs[ex.submit(_run_llm_rule, ctx, r, cfg, chat)] = r
            for fut in as_completed(futs):
                r = futs[fut]
                slot = next(x for x in plan if x[0] is r)
                try:
                    t1 = time.time()
                    slot[1] = fut.result()
                    slot[3] = int((time.time() - t1) * 1000)
                except Exception as e:
                    slot[2] = "LLM 调用失败：%s" % e
                if progress:
                    progress(r, "error" if slot[2] else "done",
                             len(slot[1] or []), slot[2], slot[3])
    summary, total = [], 0
    for r, findings, err, ms in plan:
        if err:
            summary.append({"id": r["id"], "title": r["title"], "ran": False,
                            "found": 0, "error": err, "ms": ms})
            continue
        if write and findings is not None:
            reconcile(con, scene_id, r, findings)
        summary.append({"id": r["id"], "title": r["title"], "ran": True,
                        "found": len(findings or []), "error": None, "ms": ms})
        total += len(findings or [])
    if write:
        con.commit()
    return ({"scene_id": scene_id, "rules": summary, "found": total,
             "ms": int((time.time() - t0) * 1000)}, issues_state(con, scene_id))


# ════════ 状态读取与用户操作 ════════

def _params(row):
    try:
        p = json.loads(row["params"] or "{}")
    except Exception:
        p = {}
    return p if isinstance(p, dict) else {}


def issues_state(con, scene_id):
    rules = {r["id"]: r for r in con.execute("SELECT id, title, kind FROM audit_rules")}
    rows = [dict(r) for r in con.execute(
        "SELECT * FROM audit_issues WHERE scene_id=?"
        " ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'fixed' THEN 1 ELSE 2 END,"
        " updated_at DESC, id DESC", (scene_id,))]
    counts = {"open": 0, "fixed": 0, "waived": 0}
    for r in rows:
        rid = r["rule_id"]
        r["rule_title"] = rules[rid]["title"] if rid in rules else "?"
        r["kind"] = rules[rid]["kind"] if rid in rules else "?"
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"issues": rows, "counts": counts}


def rules_state(con):
    meta = {t: d for t, k, p, d in DEFAULT_RULES}
    out = []
    for r in con.execute("SELECT * FROM audit_rules ORDER BY id"):
        d = dict(r)
        d["enabled"] = bool(d["enabled"])
        d["params"] = _params(d)
        d["desc"] = meta.get(d["title"], "")
        out.append(d)
    return out


def waive_issue(con, issue_id, note=None):
    row = con.execute("SELECT * FROM audit_issues WHERE id=?", (issue_id,)).fetchone()
    if not row:
        raise ValueError("问题不存在")
    if row["status"] == "waived":
        return
    note = (note or "").strip()[:200] or None
    con.execute("UPDATE audit_issues SET status='waived', waive_note=?,"
                " updated_at=datetime('now','localtime') WHERE id=?", (note, issue_id))
    ops.record_history(con, row["scene_id"], "audit", issue_id, "status", row["status"], "waived")
    con.commit()


def unwaive_issue(con, issue_id):
    row = con.execute("SELECT * FROM audit_issues WHERE id=?", (issue_id,)).fetchone()
    if not row:
        raise ValueError("问题不存在")
    if row["status"] != "waived":
        return
    con.execute("UPDATE audit_issues SET status='open', waive_note=NULL,"
                " updated_at=datetime('now','localtime') WHERE id=?", (issue_id,))
    ops.record_history(con, row["scene_id"], "audit", issue_id, "status", "waived", "open")
    con.commit()


def update_rule(con, rid, enabled=None, params=None):
    row = con.execute("SELECT * FROM audit_rules WHERE id=?", (rid,)).fetchone()
    if not row:
        raise ValueError("规则不存在")
    if enabled is not None:
        con.execute("UPDATE audit_rules SET enabled=? WHERE id=?", (1 if enabled else 0, rid))
    if params is not None:
        if not isinstance(params, dict):
            raise ValueError("参数格式错误")
        con.execute("UPDATE audit_rules SET params=? WHERE id=?",
                    (json.dumps(params, ensure_ascii=False), rid))
    con.commit()
    return rules_state(con)


def seed_default_rules(con, reset=False):
    """种子规则：幂等（按 title 查重）；reset=True 先清空。"""
    if reset:
        con.execute("DELETE FROM audit_rules")
    have = {r["title"] for r in con.execute("SELECT title FROM audit_rules")}
    added = 0
    for title, kind, params, _desc in DEFAULT_RULES:
        if title in have:
            continue
        con.execute("INSERT INTO audit_rules (kind, title, params) VALUES (?,?,?)",
                    (kind, title, json.dumps(params, ensure_ascii=False)))
        added += 1
    con.commit()
    return added


# ════════ 审计任务（后台跑，前端轮询进度） ════════

class JobManager:
    """内存级审计任务：每场同一时刻至多一个；服务重启即清（进度不是持久数据）。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._jobs = {}  # scene_id -> job dict

    def _snap(self, job):
        return json.loads(json.dumps(job, ensure_ascii=False))

    def status(self, scene_id):
        with self._lock:
            job = self._jobs.get(scene_id)
            return self._snap(job) if job else None

    def start(self, scene_id, only=None, chat=None, connect_factory=None):
        """启动（或加入进行中的）任务，立即返回任务快照。"""
        with self._lock:
            cur = self._jobs.get(scene_id)
            if cur and cur["running"]:
                return self._snap(cur)
        con = db.connect()
        try:
            rules = [dict(r) for r in con.execute("SELECT * FROM audit_rules ORDER BY id")]
        finally:
            con.close()
        if only is not None:
            ids = set(only)
            rules = [r for r in rules if r["id"] in ids]
        else:
            rules = [r for r in rules if r["enabled"]]
        job = {
            "scene_id": scene_id, "running": True,
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "finished_at": None, "found_total": 0, "error": None,
            "rules": [{"id": r["id"], "title": r["title"], "kind": r["kind"],
                       "state": "pending", "found": 0, "error": None, "ms": 0} for r in rules],
        }
        with self._lock:
            self._jobs[scene_id] = job
        threading.Thread(target=self._run, args=(scene_id, only, chat, connect_factory),
                         daemon=True).start()
        return self._snap(job)

    def _run(self, scene_id, only, chat, connect_factory):
        def updater(rule, state, found, error, ms):
            with self._lock:
                job = self._jobs.get(scene_id)
                if not job:
                    return
                for x in job["rules"]:
                    if x["id"] == rule["id"]:
                        x.update(state=state, found=found, error=error, ms=ms)
                        break
                job["found_total"] = sum(
                    x["found"] for x in job["rules"] if x["state"] == "done")

        try:
            con = (connect_factory or (lambda: db.connect(rw=True)))()
        except Exception as e:
            with self._lock:
                job = self._jobs.get(scene_id)
                if job:
                    job["running"] = False
                    job["error"] = "连接失败：%s" % e
                    job["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            return
        try:
            summary, _state = run_scene(con, scene_id, only=only, ai_chat=chat,
                                        progress=updater)
            with self._lock:
                job = self._jobs.get(scene_id)
                if job:
                    job["running"] = False
                    job["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    job["found_total"] = summary["found"]
        except Exception as e:
            with self._lock:
                job = self._jobs.get(scene_id)
                if job:
                    job["running"] = False
                    job["error"] = str(e)
                    job["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        finally:
            con.close()


JOBS = JobManager()
