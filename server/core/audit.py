"""审计引擎（M4a）：规则注册表 + 程序类规则 + LLM 类规则 + 问题对账（三态）+ 设置存取。

载体（carrier）：scene / beat / shot / seam；target_id 语义：
  scene → 场 id；beat → 节拍 id；shot → 镜头 id；seam → 「镜头id>镜头id」。
对账键 = (scene, rule, carrier, target)：重跑幂等；同键多消息合并（「；」）。
状态机：open --重跑未再命中--> fixed；fixed --再次命中--> open；waived 不自动重开（用户拍板接受，可手动取消豁免）。
"""
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from core import ai, db, digest, jobs, ops, recipes

# 载体四值：与 schema.sql audit_issues.carrier CHECK、web/js/audit.js 的 carrierText 对账
# （stdlib sqlite 无法共享字面量——改动时三处同改；W20）。
CARRIERS = ("scene", "beat", "shot", "seam")

# 状态词汇单点（P0·S2-W8）：前端 audit.js/auditpanel.js 同名常量与之逐字一致。
STATUS_OPEN, STATUS_FIXED, STATUS_WAIVED = "open", "fixed", "waived"                 # 问题状态
STATE_PENDING, STATE_RUNNING, STATE_DONE = "pending", "running", "done"              # 任务规则态
STATE_ERROR, STATE_SKIPPED = "error", "skipped"

MSG_MAX = 200      # finding 消息（合并前逐条）截断（注记5：与 NOTE_MAX 语义分家）
NOTE_MAX = 200     # 豁免理由截断

# ── 规则注册表（唯一点；scripts/seed_audit_rules.py 由此落库） ──
# 一条规则一行：key = slug（DB 键，title 不再当键）；kind；recipe = LLM 配方文件名（程序规则 None）；
# params = 参数 schema（{参数: {type, label, default[, min]}}——前端控件与校验由此派生）；desc；field =「去改」目标列（可缺省）。
RULES = [
    {"key": "axis", "title": "轴线", "kind": "llm", "recipe": "axis.md", "params": {},
     "desc": "相邻镜头越轴检查：视线/位置反转且无过渡镜（seam 载体）。"},
    {"key": "loop", "title": "闭环", "kind": "program",
     "params": {"require_reaction_shot": {"type": "bool", "label": "要求反应镜", "default": False}},
     "desc": "外界动作→人物反应闭环：节拍字段链完整性。"},
    {"key": "density", "title": "戏点密度", "kind": "program",
     "params": {"min_shots": {"type": "int", "label": "最少镜头数", "default": 3, "min": 1}},
     "desc": "核心戏点（🔴）镜头数下限。"},
    {"key": "closeup", "title": "戏点特写", "kind": "program",
     "params": {"sizes": {"type": "list", "label": "计作特写的景别", "default": ["特写", "极特"]}},
     "desc": "核心戏点至少 1 个特写/极特写（景别铁律）。"},
    {"key": "rhythm", "title": "节奏曲线", "kind": "llm", "recipe": "rhythm.md", "params": {},
     "desc": "镜头时长分布与节拍叙事职能的偏差（只报明确问题）。"},
    {"key": "space", "title": "空间一致性", "kind": "llm", "recipe": "space.md", "params": {},
     "field": "spatial", "desc": "角色位置突变无动机/缺过渡。"},
    {"key": "camera", "title": "机位一致性", "kind": "llm", "recipe": "camera.md", "params": {},
     "field": "camera_pos", "desc": "机位策略 vs 场景价值：反打连用 / 建立镜误用 / 插入过度。"},
    {"key": "size", "title": "景别完整", "kind": "program",
     "params": {"require_dof": {"type": "bool", "label": "要求景深标注", "default": False}},
     "field": "shot_size", "desc": "景别标注完整性（景深已并入摄影机串，抽查为主）。"},
    {"key": "sound", "title": "声音完整性", "kind": "program", "params": {},
     "field": "audio", "desc": "声音标注完整性：空音频提示（无声请标「—」）。"},
    {"key": "concrete", "title": "动作具象化", "kind": "llm", "recipe": "concrete.md",
     "params": {"wordlist": {"type": "list", "label": "模糊词表",
                             "default": ["看着", "说着", "走着", "笑了笑", "看了看", "望了望",
                                         "盯着", "望着", "望向", "停下脚步", "转过身"]}},
     "field": "blocking", "desc": "模糊词粗筛 + 判定与具象化建议。"},
]
_RULE_BY_TITLE = {r["title"]: r for r in RULES}
LLM_RECIPES = {r["key"]: r["recipe"] for r in RULES if r.get("recipe")}   # key → 文件名（派生）


def _rule_key(rule):
    """规则键：key 优先；老行（无 key）按 title 回退（迁移回填后不再需要）——P0·S2-W1。"""
    return rule.get("key") or (_RULE_BY_TITLE.get(rule.get("title")) or {}).get("key")


# ════════ 上下文装载 ════════

def _norm_keys(x):
    """镜号/节拍号查找键变体（有序）：原样、去前导零、补两位——P0·S2-W13。"""
    x = (x or "").strip()
    if not x:
        return ()
    ks = [x]
    if x.isdigit():
        d = str(int(x))
        if d not in ks:
            ks.append(d)
        if len(x) == 1:
            ks.append("0" + x)
    return tuple(ks)


# 列投影超集（P0·S2-W13）：与 fields.SHOT_FIELDS 的对账由测试兜底；新增规则若读
# shots 其它列，须并把该列并进本表，否则会缺席 ctx（KeyError 走规则级 error）。
_CTX_SHOT_COLS = ("id", "beat_id", "position", "shot_no", "camera_move", "spatial",
                  "shot_size", "focal", "dof", "camera_pos", "blocking", "dialogue",
                  "duration", "audio", "director_note", "shot_fn", "pov")


def load_ctx(con, scene_id):
    """场上下文 + 引用索引（P0·S2-W13：装载走 db.scene_ctx 单点 + 列投影；
    索引原样键优先，重号变体不复占——B2）。"""
    got = db.scene_ctx(con, scene_id, cols=_CTX_SHOT_COLS)
    if not got:
        raise ValueError("场景不存在")
    sc, beats, shots = got
    by_beat = {}
    for s in shots:
        by_beat.setdefault(s["beat_id"], []).append(s)
    return {"scene": sc, "beats": beats, "shots": shots,
            "shot_by_no": _index_by_no(shots, "shot_no", "镜头"),
            "beat_by_no": _index_by_no(beats, "beat_no", "节拍"),
            "shots_by_beat": by_beat}


def _index_by_no(rows, col, what):
    """号 → 行 索引：原样键先注册（精确引用不被补零变体抢占）；变体键见缝插针，
    同键冲突保留先注册者并告警——P0·S2-W13/B2。"""
    m = {}
    for r in rows:
        k = (r[col] or "").strip()
        if k:
            m.setdefault(k, r)
    for r in rows:
        for k in _norm_keys(r[col])[1:]:
            if k in m and m[k]["id"] != r["id"]:
                sys.stderr.write("[audit] %s号映射冲突：%r（#%s 与 #%s 同键，后者跳过）\n"
                                 % (what, k, m[k]["id"], r["id"]))
                continue
            m.setdefault(k, r)
    return m


def _lookup(m, ref):
    """引用查找：原样键优先（精确命中），再试归一变体——P0·S2-B2/W10。"""
    t = (ref or "").strip()
    if t in m:
        return m[t]
    for k in _norm_keys(t)[1:]:
        if k in m:
            return m[k]
    return None


# ════════ 程序类规则（纯函数：ctx → findings） ════════

def _f(carrier, target, msg):
    return (carrier, str(target), msg)


def _txt(row, key):
    """文本列取值单点：None → ""，其余 str + strip（P0·S2-W9）。"""
    v = row.get(key) if isinstance(row, dict) else row[key]
    return (v if isinstance(v, str) else str(v or "")).strip()


def rule_loop(ctx, p):
    out = []
    for b in ctx["beats"]:
        has_out = bool(_txt(b, "outside_action"))
        has_rea = bool(_txt(b, "reaction"))
        if has_out and not has_rea:
            out.append(_f("beat", b["id"], "外界动作「%s」未匹配人物反应"
                          % _txt(b, "outside_action")[:24]))
        if has_out and p.get("require_reaction_shot"):
            mem = ctx["shots_by_beat"].get(b["id"], [])
            if not any("反应" in (s["shot_fn"] or "") for s in mem):
                out.append(_f("beat", b["id"], "缺少反应镜（fn 无「反应镜」）"))
    return out


def rule_density(ctx, p):
    lo = int(p.get("min_shots"))          # P2②：默认只在 schema（不再 or 3 折算）
    out = []
    for b in ctx["beats"]:
        if "🔴" not in (b["kind"] or ""):
            continue
        n = len(ctx["shots_by_beat"].get(b["id"], []))
        if n < lo:
            out.append(_f("beat", b["id"], "戏点节拍仅 %d 镜（＜%d）" % (n, lo)))
    return out


def rule_closeup(ctx, p):
    sizes = p.get("sizes") or []          # P2②：默认只在 schema（写侧拒空表）
    out = []
    for b in ctx["beats"]:
        if "🔴" not in (b["kind"] or ""):
            continue
        mem = ctx["shots_by_beat"].get(b["id"], [])
        if not any(any(sz in (s["shot_size"] or "") for sz in sizes) for s in mem):
            out.append(_f("beat", b["id"], "戏点节拍缺特写镜（景别铁律：≥1 特写/极特写）"))
    return out


def rule_size(ctx, p):
    return [_f("shot", s["id"], "景别为空") for s in ctx["shots"]
            if not _txt(s, "shot_size")]


def rule_sound(ctx, p):
    out = []
    for s in ctx["shots"]:
        if not _txt(s, "audio"):
            msg = "声音未标注（音频列空）"
            if _txt(s, "dialogue"):
                msg += "；本镜有台词，需落音效轨"
            out.append(_f("shot", s["id"], msg))
    return out


PROGRAM_RULES = {"loop": rule_loop, "density": rule_density, "closeup": rule_closeup,
                 "size": rule_size, "sound": rule_sound}


# ════════ LLM 类规则（digest → 配方 → JSON findings） ════════

def _digest(ctx, head, spec):
    """LLM digest 公共骨架（P0·S2-W7）：场线 + 头行 + 镜头行（audit 风格）。"""
    return "\n".join([digest.scene_line(ctx["scene"])] + head +
                      digest.shots_lines(ctx["shots"], spec, style="audit"))


def digest_axis(ctx, p):
    head = ["节拍：" + "；".join(digest.beats_lines(ctx["beats"])), "镜头（按顺序）："]
    return _digest(ctx, head, (("camera_pos", 16), ("spatial", 60), ("blocking", 90)))


def digest_space(ctx, p):
    return _digest(ctx, ["镜头（按顺序）："],
                   (("spatial", 70), ("blocking", 110), ("camera_pos", 16)))


def digest_camera(ctx, p):
    head = ["节拍："] + digest.beats_lines(
        ctx["beats"], kind=True,
        fields=(("outside_action", "外界", 50), ("reaction", "反应", 50))) + ["镜头："]
    return _digest(ctx, head, (("camera_pos", 20), ("shot_fn", 10),
                               ("shot_size", 24), ("camera_move", 30)))


def digest_rhythm(ctx, p):
    by_beat = ctx.get("shots_by_beat") or {}

    def with_dur(b, seg):
        mem = by_beat.get(b["id"], [])
        durs = [_txt(s, "duration") or "—" for s in mem]
        vals = [x for x in (digest.dur_num(d) for d in durs) if x is not None]
        avg = ("%.1fs" % (sum(vals) / len(vals))) if vals else "—"
        return "%s ｜ %d 镜，时长：%s（均 %s）" % (seg, len(mem), "/".join(durs), avg)

    lines = [digest.scene_line(ctx["scene"]), "节拍与时长："]
    lines += digest.beats_lines(ctx["beats"], kind=True, extra=with_dur)
    return "\n".join(lines)


def digest_concrete(ctx, p):
    words = [w for w in (p.get("wordlist") or []) if w]
    cand = []
    for s in ctx["shots"]:
        bl = _txt(s, "blocking")
        hit = [w for w in words if w in bl]
        if hit:
            cand.append("镜%s ｜ 命中词：%s ｜ 动作原文：%s" % (s["shot_no"], "/".join(hit), bl[:220]))
    if not cand:
        return None  # 无候选：跳过调用
    return "\n".join([digest.scene_line(ctx["scene"]), "候选镜头（疑似模糊表达）："] + cand)


LLM_DIGESTS = {"axis": digest_axis, "space": digest_space, "camera": digest_camera,
               "rhythm": digest_rhythm, "concrete": digest_concrete}


def _load_recipe(key):
    """配方正文（单点走 recipes.read：白名单 + 前缀双保险）——P0·S2-§6。"""
    return recipes.read(LLM_RECIPES[key])["content"]


_REF_PREFIX_RE = re.compile(r"^\s*(?:镜头|镜|节拍|beat)\s*", re.I)
SEAM_SEPS = ("->", "→", ">", "-", "–")   # 接缝分隔符枚举（模型实测形态；更深＝L3 canonicalizer）


def _norm_ref(ref):
    """引用归一：剥「镜头 / 镜 / 节拍 / beat」前缀（单次正则，大小写不敏感）——P0·S2-W10。"""
    return _REF_PREFIX_RE.sub("", ref or "").strip()


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
    for sep in SEAM_SEPS:
        if sep in r:
            a, _, c = r.partition(sep)
            s1 = _lookup(ctx["shot_by_no"], _norm_ref(a))
            s2 = _lookup(ctx["shot_by_no"], _norm_ref(c))
            if s1 and s2:
                return "%s>%s" % (s1["id"], s2["id"])
    return None


def _parse_findings(ctx, text):
    """解析回包。返回 (findings, dropped)：dropped＝被丢弃条目数（P0·S2-B1，调用方必须当回事）。"""
    data = ai.extract_json(text)
    raw = data.get("findings")
    if not isinstance(raw, list):
        raise ValueError("回包缺少 findings 列表")
    out = []
    dropped = 0
    for f in raw:
        if not isinstance(f, dict):
            dropped += 1
            continue
        carrier = _txt(f, "carrier")
        msg = _txt(f, "message")
        if carrier not in CARRIERS or not msg:
            dropped += 1
            continue
        target = _resolve_ref(ctx, carrier, str(f.get("ref") or ""))
        if not target:
            dropped += 1
            continue
        out.append(_f(carrier, target, msg[:MSG_MAX]))
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

def _issue_set(con, issue_id, **cols):
    """问题行 UPDATE 单点（列名代码写死直拼，值参数化；updated_at 统一）——P0·S2-§3。
    调用侧各自保留语义守卫（如 reconcile 的「同消息不触碰」）。"""
    keys = ", ".join("%s=?" % k for k in cols)
    con.execute("UPDATE audit_issues SET %s,"
                " updated_at=datetime('now','localtime') WHERE id=?" % keys,
                (*cols.values(), issue_id))


def reconcile(con, scene_id, rule, findings):
    """把本轮 findings 对进 audit_issues（键 = carrier+target；批写）——P0·S2-W5。"""
    agg = {}
    for carrier, target, msg in findings:
        agg.setdefault((carrier, target), []).append(msg)
    existing = {(r["carrier"], r["target_id"]): dict(r) for r in con.execute(
        "SELECT * FROM audit_issues WHERE scene_id=? AND rule_id=?", (scene_id, rule["id"]))}
    ins, reopen, remsg = [], [], []
    now = set()
    for (carrier, target), msgs in agg.items():
        key = (carrier, target)
        now.add(key)
        message = "；".join(dict.fromkeys(msgs))[:500]
        ex = existing.get(key)
        if ex is None:
            ins.append((scene_id, carrier, target, rule["id"], message))
        elif ex["status"] == STATUS_FIXED:
            reopen.append((message, ex["id"]))
        elif ex["status"] == STATUS_OPEN and (ex["message"] or "") != message:
            remsg.append((message, ex["id"]))
        # waived：不动（用户拍板接受）
    if ins:
        con.executemany("INSERT INTO audit_issues (scene_id, carrier, target_id, rule_id, message)"
                        " VALUES (?,?,?,?,?)", ins)
    for message, iid in reopen:
        _issue_set(con, iid, status=STATUS_OPEN, message=message)
    for message, iid in remsg:
        _issue_set(con, iid, message=message)
    fixed_ids = [ex["id"] for key, ex in existing.items()
                 if key not in now and ex["status"] == STATUS_OPEN]
    if fixed_ids:
        qs = ", ".join("?" * len(fixed_ids))
        con.execute("UPDATE audit_issues SET status=?,"
                    " updated_at=datetime('now','localtime') WHERE id IN (%s)" % qs,
                    (STATUS_FIXED, *fixed_ids))


def _select_rules(con, only=None):
    """读规则并过滤（start 与 run 同源：快照 = 实跑）——P0·S2-§1。
    only=None → 仅启用；only={id,…} → 指定（重检，无视开关）。"""
    rules = [dict(r) for r in con.execute("SELECT * FROM audit_rules ORDER BY id")]
    if only is not None:
        ids = set(only)
        return [r for r in rules if r["id"] in ids]
    return [r for r in rules if r["enabled"]]


def run_scene(con, scene_id, only=None, ai_chat=None, progress=None):
    """跑审计：only=None → 全部启用规则；only={id,…} → 指定规则（重检，无视开关）。
    progress(rule, state, found, error, ms) 供任务进度上报（state: running/done/error/skipped）。
    返回 (summary, state)。"""
    t0 = time.time()                                      # 注记3：ms 含装载成本（诚实口径）
    ctx = load_ctx(con, scene_id)
    rules = _select_rules(con, only)
    if not rules:
        raise ValueError("没有可运行的规则（检查启用状态或 only）")
    for r in rules:
        r["params"], r["_params_error"] = _params(r)
    cfg, chat = ai.channel(con, ai_chat, precheck=False)  # 无 key 不拦整场：LLM 规则各自报错（语义照旧）
    progress = progress or (lambda *a: None)              # W3：消 if 分支
    plan, llm_jobs = [], []
    for r in rules:
        k = _rule_key(r)
        if r.get("_params_error"):                            # P2③：坏参数 = 规则级 error（可见）
            plan.append({"rule": r, "state": STATE_ERROR, "findings": None,
                         "error": "参数读取失败：%s" % r["_params_error"], "ms": 0})
            continue
        if k in PROGRAM_RULES:
            try:
                plan.append({"rule": r, "state": STATE_DONE,
                             "findings": PROGRAM_RULES[k](ctx, r["params"]), "error": None, "ms": 0})
            except Exception as e:
                plan.append({"rule": r, "state": STATE_ERROR, "findings": None,
                             "error": "程序规则异常：%s" % e, "ms": 0})
        elif k in LLM_DIGESTS:
            llm_jobs.append(r)
            plan.append({"rule": r, "state": STATE_PENDING, "findings": None, "error": None, "ms": 0})
        else:
            plan.append({"rule": r, "state": STATE_ERROR, "findings": None, "error": "无实现", "ms": 0})
    for x in plan:                                        # 已完成者先报（LLM 待跑不进进度）
        if x["state"] != STATE_PENDING:
            progress(x["rule"], x["state"], len(x["findings"] or []), x["error"], 0)
    if llm_jobs:
        slots = {x["rule"]["id"]: x for x in plan}
        with ThreadPoolExecutor(max_workers=min(5, len(llm_jobs))) as ex:
            futs = {ex.submit(_run_llm_rule, ctx, r, cfg, chat): slots[r["id"]] for r in llm_jobs}
            for r in llm_jobs:
                progress(r, STATE_RUNNING, 0, None, 0)
            for fut in as_completed(futs):
                slot = futs[fut]                          # W3：futs 直接存槽位
                r = slot["rule"]
                try:
                    t1 = time.time()
                    state, findings = fut.result()
                    if state == "ran":
                        state = STATE_DONE                # 内部 ran → 进度协议 done
                    slot["state"], slot["findings"] = state, findings
                    slot["ms"] = int((time.time() - t1) * 1000)
                except FindingsDropped as e:
                    slot["state"], slot["error"] = STATE_ERROR, str(e)
                except Exception as e:
                    slot["state"], slot["error"] = STATE_ERROR, "LLM 调用失败：%s" % e
                progress(r, slot["state"], len(slot["findings"] or []), slot["error"], slot["ms"])
    summary, total = [], 0
    for x in plan:
        r, st = x["rule"], x["state"]
        if x["error"]:
            summary.append({"id": r["id"], "title": r["title"], "ran": False,
                            "found": 0, "error": x["error"], "ms": x["ms"], "skipped": False})
            continue
        if st == STATE_SKIPPED:
            # 无候选：本轮无信息，不得对账（否则遗留 open 会被误判「未再命中」假熄灯；P0·S2-B1）
            summary.append({"id": r["id"], "title": r["title"], "ran": False,
                            "found": 0, "error": None, "ms": x["ms"], "skipped": True})
            continue
        if x["findings"] is not None:
            reconcile(con, scene_id, r, x["findings"])
        summary.append({"id": r["id"], "title": r["title"], "ran": True,
                        "found": len(x["findings"] or []), "error": None, "ms": x["ms"], "skipped": False})
        total += len(x["findings"] or [])
    con.commit()
    return ({"scene_id": scene_id, "rules": summary, "found": total,
             "ms": int((time.time() - t0) * 1000)}, issues_state(con, scene_id))


# ════════ 状态读取与用户操作 ════════

def _params(row):
    """规则参数（读时合并 schema 默认，单点）——P0·S2-P2②③。
    返回 (params, err)：err 非空＝参数损坏（面板可见，本轮该规则按 error 处理）。"""
    try:
        p = json.loads(row["params"] or "{}")
    except Exception as e:
        return {}, "参数 JSON 损坏：%s" % e
    if not isinstance(p, dict):
        return {}, "参数不是对象"
    reg = _RULE_BY_TITLE.get(row.get("title")) or {}
    out = {}
    for k, spec in (reg.get("params") or {}).items():
        out[k] = p[k] if (k in p and p[k] is not None) else spec.get("default")
    for k, v in p.items():
        out.setdefault(k, v)                  # 灰数据保留（不参与控件，但回写不丢）
    return out, None


def _check_params(rule, params):
    """写侧参数校验（P0·S2-P2①/P1③）：未知键拒；type 可转；min 下界；空表拒。
    通过时返回规范化后的整体参数（只含 schema 键）。"""
    reg = _RULE_BY_TITLE.get(rule.get("title")) or {}
    schema = reg.get("params") or {}
    out = {}
    for k, v in params.items():
        spec = schema.get(k)
        if spec is None:
            raise ValueError("未知参数：%s" % k)
        t = spec.get("type")
        if t == "int":
            if isinstance(v, bool) or not isinstance(v, int):
                try:
                    v = int(str(v).strip())
                except (TypeError, ValueError):
                    raise ValueError("参数 %s 必须是整数" % k)
            mn = spec.get("min")
            if mn is not None and v < mn:
                raise ValueError("参数 %s 不得小于 %s" % (k, mn))
        elif t == "bool":
            if not isinstance(v, bool):
                raise ValueError("参数 %s 必须是布尔" % k)
        elif t == "list":
            if not isinstance(v, list):
                raise ValueError("参数 %s 必须是列表" % k)
            v = [str(x).strip() for x in v if str(x).strip()]
            if not v:
                raise ValueError("参数 %s 不能为空（至少 1 项）" % k)     # P1③：空词表写侧拒
        out[k] = v
    return out


def scene_exists(con, scene_id):
    """场景存在性（api 直读收口）——P0·S2-§2。"""
    return bool(con.execute("SELECT id FROM scenes WHERE id=?", (scene_id,)).fetchone())


def get_issue(con, issue_id):
    """问题行 or 抛「问题不存在」（同模板收口）——P0·S2-§2。"""
    row = con.execute("SELECT * FROM audit_issues WHERE id=?", (issue_id,)).fetchone()
    if not row:
        raise ValueError("问题不存在")
    return row


def open_counts(con):
    """全片未处理计数（场次导航徽标用）——P0·S2-§2。"""
    rows = con.execute("SELECT scene_id, COUNT(*) AS n FROM audit_issues"
                       " WHERE status=? GROUP BY scene_id", (STATUS_OPEN,)).fetchall()
    return {str(r["scene_id"]): r["n"] for r in rows}


def issues_state(con, scene_id):
    """场问题清单 + 计数 + 孤儿计数（P0·S2-§4：规则表单次读；W11：orphan 可观测）。"""
    rules = {r["id"]: r for r in con.execute("SELECT id, title, kind FROM audit_rules")}
    rows = [dict(r) for r in con.execute(
        "SELECT * FROM audit_issues WHERE scene_id=?"
        " ORDER BY CASE status WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END,"
        " updated_at DESC, id DESC", (scene_id, STATUS_OPEN, STATUS_FIXED))]
    counts = {STATUS_OPEN: 0, STATUS_FIXED: 0, STATUS_WAIVED: 0}
    orphan = 0
    for r in rows:
        rid = r["rule_id"]
        row = rules.get(rid)
        if row is None:
            orphan += 1                            # 悬空 rule_id（规则重种后旧 id 不复存在）
        reg = (_RULE_BY_TITLE.get(row["title"]) or {}) if row else {}
        r["rule_title"] = row["title"] if row else "?"
        r["kind"] = row["kind"] if row else "?"
        r["field"] = reg.get("field")              # 「去改」目标列（L9：注册表下发）
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"issues": rows, "counts": counts, "orphan": orphan}


def rules_state(con):
    out = []
    for r in con.execute("SELECT * FROM audit_rules ORDER BY id"):
        d = dict(r)
        d["enabled"] = bool(d["enabled"])
        d["params"], d["params_error"] = _params(d)
        reg = _RULE_BY_TITLE.get(d["title"]) or {}
        d["key"] = d.get("key") or reg.get("key")
        d["desc"] = reg.get("desc", "")
        d["recipe"] = reg.get("recipe")
        d["params_schema"] = {k: {kk: v[kk] for kk in ("label", "type", "min") if kk in v}
                              for k, v in (reg.get("params") or {}).items()}
        out.append(d)
    return out


def waive_issue(con, issue_id, note=None):
    """豁免单条；返回 scene_id（api 免重复读）——P0·S2-§2。"""
    row = get_issue(con, issue_id)
    note = (note or "").strip()[:NOTE_MAX] or None
    if row["status"] == STATUS_WAIVED:
        # 已豁免：允许补/改理由（改了盖新理由，不另留痕；不写就没有——用户拍板口径，注记6）
        if note and note != (_txt(row, "waive_note") or None):
            _issue_set(con, issue_id, waive_note=note)
            con.commit()
        return row["scene_id"]
    _issue_set(con, issue_id, status=STATUS_WAIVED, waive_note=note)
    ops.record_history(con, row["scene_id"], "audit", issue_id, field="status", old_value=row["status"], new_value=STATUS_WAIVED)
    con.commit()
    return row["scene_id"]


def unwaive_issue(con, issue_id):
    """取消豁免；返回 scene_id（api 免重复读）——P0·S2-§2。"""
    row = get_issue(con, issue_id)
    if row["status"] != STATUS_WAIVED:
        return row["scene_id"]
    con.execute("UPDATE audit_issues SET status=?, waive_note=NULL,"
                " updated_at=datetime('now','localtime') WHERE id=?", (STATUS_OPEN, issue_id))
    ops.record_history(con, row["scene_id"], "audit", issue_id, field="status", old_value=STATUS_WAIVED, new_value=STATUS_OPEN)
    con.commit()
    return row["scene_id"]


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
        params = _check_params(dict(row), params)     # schema 校验（P0·S2-P2①/P1③）
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


def _insert_rule(con, r):
    """规则行 INSERT 单点（默认参数落库）——P0·S2-W6。"""
    cur = con.execute(
        "INSERT INTO audit_rules (key, kind, title, params) VALUES (?,?,?,?)",
        (r["key"], r["kind"], r["title"],
         json.dumps(_default_params(r), ensure_ascii=False)))
    return cur.lastrowid


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
            new[r["key"]] = _insert_rule(con, r)
        for iid, old_rid in links:
            ref = old.get(old_rid)
            nid = new.get(ref) or new.get(_TITLE_KEY.get(ref) or "")
            if nid:
                con.execute("UPDATE audit_issues SET rule_id=? WHERE id=?", (nid, iid))
        con.commit()
        return len(RULES)
    db_by_title = {r["title"]: r for r in con.execute("SELECT * FROM audit_rules")}
    added = 0
    for r in RULES:
        row = db_by_title.get(r["title"])
        if row is None:
            _insert_rule(con, r)
            added += 1
        else:
            if (dict(row).get("key") or "") != r["key"]:
                con.execute("UPDATE audit_rules SET key=? WHERE id=?", (r["key"], row["id"]))
            try:
                cur = json.loads(row["params"] or "{}")
            except Exception:
                cur = None
            if isinstance(cur, dict):                     # P2④：既有行补新增参数键默认
                miss = {k: v["default"] for k, v in r["params"].items() if k not in cur}
                if miss:
                    cur.update(miss)
                    con.execute("UPDATE audit_rules SET params=? WHERE id=?",
                                (json.dumps(cur, ensure_ascii=False), row["id"]))
    con.commit()
    return added


# ════════ 审计任务（后台跑，前端轮询进度） ════════

class JobManager(jobs.JobBoard):
    """内存级审计任务（基类 = core/jobs.py）：每场同一时刻至多一个；服务重启即清。"""

    def __init__(self):
        super().__init__(keep=20, gate=None)   # 剪枝只淘汰完成件（P0·S2-P4①）；不在并发闸内（拍板语义）

    def _touch(self, job):
        """found_total 单点派生（已完成规则的 found 之和）——P0·S2-W4。"""
        job["found_total"] = sum(
            x["found"] for x in job["rules"] if x["state"] == STATE_DONE)

    def _light(self, job):
        """轮询轻载（P4②）：只回进度所需字段；保留 title/error（前端逐规则显示用）。
        ——M4 §三「轮询响应去 rules 大字段」的落点。"""
        return {"scene_id": job.get("scene_id"), "running": job.get("running"),
                "started_at": job.get("started_at"), "finished_at": job.get("finished_at"),
                "found_total": job.get("found_total"), "error": job.get("error"),
                "rules": [{"id": x.get("id"), "title": x.get("title"), "state": x.get("state"),
                           "found": x.get("found"), "error": x.get("error"), "ms": x.get("ms")}
                          for x in job.get("rules", [])]}

    def start(self, scene_id, only=None, ai_chat=None, connect_factory=None):
        """启动（或加入进行中的）任务，立即返回任务快照。
        joined=True = 并入既有任务（此时 only 不生效，前端应如实提示）；
        规则读取与登记同临界区——并发 start 只放行一份，不双跑。
        connect_factory：仅供测试注入（规则读取连接）；_run 恒用 rw 连接——
        查询/命令分离属有意设计（P0·S2-W15）。过滤后无规则 → ValueError（§11，api 转 400）。"""
        with self._lock:
            joined = self._find_running(lambda j: j.get("scene_id") == scene_id)
            if joined:
                return joined
            con = connect_factory() if connect_factory else db.connect()
            try:
                rules = _select_rules(con, only)
            finally:
                con.close()
            if not rules:
                raise ValueError("没有可运行的规则（检查启用状态或 only）")
            job = {
                "scene_id": scene_id, "running": True,
                "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "finished_at": None, "found_total": 0, "error": None,
                "rules": [{"id": r["id"], "title": r["title"], "kind": r["kind"],
                           "state": STATE_PENDING, "found": 0, "error": None, "ms": 0} for r in rules],
            }
            self._register(scene_id, job, gated=False)   # 审计不在闸内（P0·S1-B6）
            snap = self._snap(job)
            snap["joined"] = False
        threading.Thread(target=self._run, args=(scene_id, only, ai_chat, connect_factory),
                         daemon=True).start()
        return snap

    def _run(self, scene_id, only, ai_chat, connect_factory):
        def updater(rule, state, found, error, ms):
            with self._lock:
                job = self._jobs.get(scene_id)
                if not job:
                    return
                for x in job["rules"]:
                    if x["id"] == rule["id"]:
                        x.update(state=state, found=found, error=error, ms=ms)
                        break

        try:
            con = (connect_factory or (lambda: db.connect(rw=True)))()
        except Exception as e:
            self._finish(scene_id, "连接失败：%s" % e)
            return
        try:
            run_scene(con, scene_id, only=only, ai_chat=ai_chat, progress=updater)
            self._finish(scene_id)
        except Exception as e:
            self._finish(scene_id, str(e))
        finally:
            con.close()


JOBS = JobManager()
