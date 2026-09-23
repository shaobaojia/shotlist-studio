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

from core import ai, db, digest, jobs, ops

CARRIERS = ("scene", "beat", "shot", "seam")

# ── 规则注册表（唯一点；scripts/seed_audit_rules.py 由此落库） ──
# 一条规则一行：key = slug（DB 键，title 不再当键）；kind；recipe = LLM 配方文件名（程序规则 None）；
# params = 参数 schema（{参数: {type, label, default[, min]}}——前端控件与校验由此派生）；desc；field =「去改」目标列（可缺省）。
RULES = [
    {"key": "axis", "title": "轴线", "kind": "llm", "recipe": "axis.md", "params": {},
     "desc": "相邻镜头越轴检查：视线/位置反转且无过渡镜（seam 载体）。"},
    {"key": "loop", "title": "闭环", "kind": "program", "recipe": None,
     "params": {"require_reaction_shot": {"type": "bool", "label": "要求反应镜", "default": False}},
     "desc": "外界动作→人物反应闭环：节拍字段链完整性。"},
    {"key": "density", "title": "戏点密度", "kind": "program", "recipe": None,
     "params": {"min_shots": {"type": "int", "label": "最少镜头数", "default": 3, "min": 1}},
     "desc": "核心戏点（🔴）镜头数下限。"},
    {"key": "closeup", "title": "戏点特写", "kind": "program", "recipe": None,
     "params": {"sizes": {"type": "list", "label": "计作特写的景别", "default": ["特写", "极特"]}},
     "desc": "核心戏点至少 1 个特写/极特写（景别铁律）。"},
    {"key": "rhythm", "title": "节奏曲线", "kind": "llm", "recipe": "rhythm.md", "params": {},
     "desc": "镜头时长分布与节拍叙事职能的偏差（只报明确问题）。"},
    {"key": "space", "title": "空间一致性", "kind": "llm", "recipe": "space.md", "params": {},
     "field": "spatial", "desc": "角色位置突变无动机/缺过渡。"},
    {"key": "camera", "title": "机位一致性", "kind": "llm", "recipe": "camera.md", "params": {},
     "field": "camera_pos", "desc": "机位策略 vs 场景价值：反打连用 / 建立镜误用 / 插入过度。"},
    {"key": "size", "title": "景别完整", "kind": "program", "recipe": None,
     "params": {"require_dof": {"type": "bool", "label": "要求景深标注", "default": False}},
     "field": "shot_size", "desc": "景别标注完整性（景深已并入摄影机串，抽查为主）。"},
    {"key": "sound", "title": "声音完整性", "kind": "program", "recipe": None, "params": {},
     "field": "audio", "desc": "声音标注完整性：空音频提示（无声请标「—」）。"},
    {"key": "concrete", "title": "动作具象化", "kind": "llm", "recipe": "concrete.md",
     "params": {"wordlist": {"type": "list", "label": "模糊词表",
                             "default": ["看着", "说着", "走着", "笑了笑", "看了看", "望了望",
                                         "盯着", "望着", "望向", "停下脚步", "转过身"]}},
     "field": "blocking", "desc": "模糊词粗筛 + 判定与具象化建议。"},
]
_TITLE_KEY = {r["title"]: r["key"] for r in RULES}
_RULE_BY_TITLE = {r["title"]: r for r in RULES}
LLM_RECIPES = {r["key"]: r["recipe"] for r in RULES if r["recipe"]}   # key → 文件名（派生）


def _rule_key(rule):
    """规则键：key 优先；老行（无 key）按 title 回退（迁移回填后不再需要）。"""
    return rule.get("key") or _TITLE_KEY.get(rule.get("title"))


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


PROGRAM_RULES = {"loop": rule_loop, "density": rule_density, "closeup": rule_closeup,
                 "size": rule_size, "sound": rule_sound}


# ════════ LLM 类规则（digest → 配方 → JSON findings） ════════

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


def digest_axis(ctx, p):
    beats = "；".join("节拍 %s %s" % (b["beat_no"], b["name"] or "") for b in ctx["beats"])
    return "\n".join([digest.scene_line(ctx["scene"]), "节拍：" + beats, "镜头（按顺序）："] +
                     digest.shots_lines(ctx["shots"],
                                        (("camera_pos", 16), ("spatial", 60), ("blocking", 90)),
                                        colon=": "))


def digest_space(ctx, p):
    return "\n".join([digest.scene_line(ctx["scene"]), "镜头（按顺序）："] +
                     digest.shots_lines(ctx["shots"],
                                        (("spatial", 70), ("blocking", 110), ("camera_pos", 16)),
                                        colon=": "))


def digest_camera(ctx, p):
    return "\n".join([digest.scene_line(ctx["scene"]), "节拍："] + _beats_lines(ctx) + ["镜头："] +
                     digest.shots_lines(ctx["shots"],
                                        (("camera_pos", 20), ("shot_fn", 10),
                                         ("shot_size", 24), ("camera_move", 30)),
                                        colon=": "))


def digest_rhythm(ctx, p):
    lines = [digest.scene_line(ctx["scene"]), "节拍与时长："]
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
    return "\n".join([digest.scene_line(ctx["scene"]), "候选镜头（疑似模糊表达）："] + cand)


LLM_DIGESTS = {"axis": digest_axis, "space": digest_space, "camera": digest_camera,
               "rhythm": digest_rhythm, "concrete": digest_concrete}


def _load_recipe(key):
    p = db.ROOT / "recipes" / "audit" / LLM_RECIPES[key]
    if not p.is_file():
        raise ValueError("审计配方缺失：%s" % LLM_RECIPES[key])
    return p.read_text(encoding="utf-8")


def _extract_json(text):
    """AI 回包 → dict；不可解析即抛错——走规则级 error 通道（否则遗留问题会被误判「未再命中」静默熄灯）。"""
    t = (text or "").strip()
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        raise ValueError("回包无 JSON 对象（%.60s）" % (t or "空"))
    try:
        obj = json.loads(t[i:j + 1])
    except Exception as e:
        raise ValueError("回包 JSON 解析失败：%s" % e)
    if not isinstance(obj, dict):
        raise ValueError("回包 JSON 不是对象")
    return obj


def _norm_ref(ref):
    """引用归一：剥「镜头 / 镜 / 节拍 / beat」前缀与空白（模型常回「节拍2」「Beat 3」）。"""
    t = (ref or "").replace("镜头", "").replace("镜", "").replace("节拍", "").replace(" ", "")
    return t.replace("beat", "").replace("Beat", "").replace("BEAT", "")


def _resolve_ref(ctx, carrier, ref):
    if carrier == "scene":
        return str(ctx["scene"]["id"])
    r = _norm_ref(ref)
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
    """解析回包。返回 (findings, dropped)：dropped＝被丢弃条目数（P0·S2-B1，调用方必须当回事）。"""
    data = _extract_json(text)
    raw = data.get("findings")
    if not isinstance(raw, list):
        raise ValueError("回包缺少 findings 列表")
    out = []
    dropped = 0
    for f in raw:
        if not isinstance(f, dict):
            dropped += 1
            continue
        carrier = str(f.get("carrier") or "").strip()
        msg = str(f.get("message") or "").strip()
        if carrier not in CARRIERS or not msg:
            dropped += 1
            continue
        target = _resolve_ref(ctx, carrier, str(f.get("ref") or ""))
        if not target:
            dropped += 1
            continue
        out.append(_f(carrier, target, msg[:200]))
    return out, dropped


class FindingsDropped(ValueError):
    """回包 findings 有不可解析条目：走规则级 error 通道、本轮不对账（P0·S2-B1）。"""


def _run_llm_rule(ctx, rule, cfg, ai_chat):
    """返回 (state, findings)；state ∈ {"ran", "skipped"}（skipped＝无候选，不参与对账）。"""
    key = _rule_key(rule)
    body = LLM_DIGESTS[key](ctx, rule["params"])
    if body is None:
        return "skipped", []
    system = _load_recipe(key)
    text = ai_chat(cfg, [{"role": "system", "content": system},
                         {"role": "user", "content": body}])
    findings, dropped = _parse_findings(ctx, text)
    if dropped:
        raise FindingsDropped("%d 条 finding 引用不可解析" % dropped)
    return "ran", findings


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


def run_scene(con, scene_id, only=None, ai_chat=None, progress=None):
    """跑审计：only=None → 全部启用规则；only={id,…} → 指定规则（重检，无视开关）。
    progress(rule, state, found, error, ms) 供任务进度上报（state: running/done/error/skipped）。
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
    cfg, chat = ai.channel(con, ai_chat, precheck=False)  # 无 key 不拦整场：LLM 规则各自报错（语义照旧）
    t0 = time.time()
    plan, llm_jobs = [], []
    for r in rules:
        k = _rule_key(r)
        if k in PROGRAM_RULES:
            try:
                plan.append([r, PROGRAM_RULES[k](ctx, r["params"]), None, 0, "ran"])
            except Exception as e:
                plan.append([r, None, "程序规则异常：%s" % e, 0, "error"])
        elif k in LLM_DIGESTS:
            llm_jobs.append(r)
            plan.append([r, None, None, 0, None])
        else:
            plan.append([r, None, "无实现", 0, "error"])
    if progress:
        for r, findings, err, ms, _st in plan:
            if findings is None and err is None and _rule_key(r) in LLM_DIGESTS:
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
                    res = fut.result()
                    slot[1] = res[1]      # findings
                    slot[4] = res[0]      # "ran" / "skipped"
                    slot[3] = int((time.time() - t1) * 1000)
                except FindingsDropped as e:
                    slot[2] = str(e)
                except Exception as e:
                    slot[2] = "LLM 调用失败：%s" % e
                if progress:
                    st = "error" if slot[2] else ("skipped" if slot[4] == "skipped" else "done")
                    progress(r, st, len(slot[1] or []), slot[2], slot[3])
    summary, total = [], 0
    for r, findings, err, ms, st in plan:
        if err:
            summary.append({"id": r["id"], "title": r["title"], "ran": False,
                            "found": 0, "error": err, "ms": ms, "skipped": False})
            continue
        if st == "skipped":
            # 无候选：本轮无信息，不得对账（否则遗留 open 会被误判「未再命中」假熄灯；P0·S2-B1）
            summary.append({"id": r["id"], "title": r["title"], "ran": False,
                            "found": 0, "error": None, "ms": ms, "skipped": True})
            continue
        if findings is not None:
            reconcile(con, scene_id, r, findings)
        summary.append({"id": r["id"], "title": r["title"], "ran": True,
                        "found": len(findings or []), "error": None, "ms": ms, "skipped": False})
        total += len(findings or [])
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
    fields = {r["id"]: (_RULE_BY_TITLE.get(r["title"]) or {}).get("field")
              for r in con.execute("SELECT id, title FROM audit_rules")}
    rows = [dict(r) for r in con.execute(
        "SELECT * FROM audit_issues WHERE scene_id=?"
        " ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'fixed' THEN 1 ELSE 2 END,"
        " updated_at DESC, id DESC", (scene_id,))]
    counts = {"open": 0, "fixed": 0, "waived": 0}
    for r in rows:
        rid = r["rule_id"]
        r["rule_title"] = rules[rid]["title"] if rid in rules else "?"
        r["kind"] = rules[rid]["kind"] if rid in rules else "?"
        r["field"] = fields.get(rid)              # 「去改」目标列（L9：注册表下发）
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"issues": rows, "counts": counts}


def rules_state(con):
    meta = {r["title"]: r for r in RULES}
    out = []
    for r in con.execute("SELECT * FROM audit_rules ORDER BY id"):
        d = dict(r)
        d["enabled"] = bool(d["enabled"])
        d["params"] = _params(d)
        reg = meta.get(d["title"]) or {}
        d["key"] = d.get("key") or reg.get("key")
        d["desc"] = reg.get("desc", "")
        d["recipe"] = reg.get("recipe")
        d["params_schema"] = {k: {kk: v[kk] for kk in ("label", "type", "min") if kk in v}
                              for k, v in (reg.get("params") or {}).items()}
        out.append(d)
    return out


def waive_issue(con, issue_id, note=None):
    row = con.execute("SELECT * FROM audit_issues WHERE id=?", (issue_id,)).fetchone()
    if not row:
        raise ValueError("问题不存在")
    note = (note or "").strip()[:200] or None
    if row["status"] == "waived":
        # 已豁免：允许补/改理由（写了留痕，不写就没有——用户拍板口径）
        if note and note != ((row["waive_note"] or "").strip() or None):
            con.execute("UPDATE audit_issues SET waive_note=?,"
                        " updated_at=datetime('now','localtime') WHERE id=?", (note, issue_id))
            con.commit()
        return
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
    _ensure_key_column(con)
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


def _ensure_key_column(con):
    """迁移（幂等）：老库 audit_rules 补 key 列（G1「标题当键」退役）。"""
    cols = {r[1] for r in con.execute("PRAGMA table_info(audit_rules)")}
    if "key" not in cols:
        con.execute("ALTER TABLE audit_rules ADD COLUMN key TEXT")
        con.commit()


def _default_params(r):
    return {k: v["default"] for k, v in r["params"].items()}


def seed_default_rules(con, reset=False):
    """种子规则：幂等（按 title 查重；老行回填 key——迁移自 G1「标题当键」）。
    reset=True：重建——存量问题按 key（老行回退 title）回迁新 id（不留孤儿）。
    返回：reset 时 = 规则总数；否则 = 新增条数（回填不计）。"""
    _ensure_key_column(con)
    if reset:
        old = {r["id"]: (r["key"] or r["title"]) for r in con.execute(
            "SELECT id, title, key FROM audit_rules")}
        links = [(r["id"], r["rule_id"]) for r in con.execute(
            "SELECT id, rule_id FROM audit_issues WHERE rule_id IS NOT NULL")]
        con.execute("DELETE FROM audit_rules")
        new = {}
        for r in RULES:
            cur = con.execute(
                "INSERT INTO audit_rules (key, kind, title, params) VALUES (?,?,?,?)",
                (r["key"], r["kind"], r["title"],
                 json.dumps(_default_params(r), ensure_ascii=False)))
            new[r["key"]] = cur.lastrowid
        for iid, old_rid in links:
            ref = old.get(old_rid)
            nid = new.get(ref) or new.get(_TITLE_KEY.get(ref) or "")
            if nid:
                con.execute("UPDATE audit_issues SET rule_id=? WHERE id=?", (nid, iid))
        con.commit()
        return len(RULES)
    have = {r["title"]: r for r in con.execute("SELECT * FROM audit_rules")}
    added = 0
    for r in RULES:
        row = have.get(r["title"])
        if row is None:
            con.execute("INSERT INTO audit_rules (key, kind, title, params) VALUES (?,?,?,?)",
                        (r["key"], r["kind"], r["title"],
                         json.dumps(_default_params(r), ensure_ascii=False)))
            added += 1
        elif (dict(row).get("key") or "") != r["key"]:
            con.execute("UPDATE audit_rules SET key=? WHERE id=?", (r["key"], row["id"]))
    con.commit()
    return added


# ════════ 审计任务（后台跑，前端轮询进度） ════════

class JobManager(jobs.JobBoard):
    """内存级审计任务（基类 = core/jobs.py）：每场同一时刻至多一个；服务重启即清。"""

    def __init__(self):
        super().__init__(gate=None)          # 审计任务不在并发闸内（拍板语义）

    def status(self, scene_id):
        return self.get(scene_id)

    def start(self, scene_id, only=None, chat=None, connect_factory=None):
        """启动（或加入进行中的）任务，立即返回任务快照。
        joined=True = 并入既有任务（此时 only 不生效，前端应如实提示）；
        规则读取与登记同临界区——并发 start 只放行一份，不双跑。"""
        with self._lock:
            joined = self._find_running(lambda j: j.get("scene_id") == scene_id)
            if joined:
                return joined
            con = connect_factory() if connect_factory else db.connect()
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
            self._register(scene_id, job)
            snap = self._snap(job)
            snap["joined"] = False
        threading.Thread(target=self._run, args=(scene_id, only, chat, connect_factory),
                         daemon=True).start()
        return snap

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
            self._finish(scene_id, "连接失败：%s" % e)
            return
        try:
            summary, _state = run_scene(con, scene_id, only=only, ai_chat=chat,
                                        progress=updater)
            with self._lock:
                job = self._jobs.get(scene_id)
                if job:
                    job["found_total"] = summary["found"]
            self._finish(scene_id)
        except Exception as e:
            self._finish(scene_id, str(e))
        finally:
            con.close()


JOBS = JobManager()
