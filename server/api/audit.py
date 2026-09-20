"""审计接口（M4a）：GET /api/audit?scene_id=；POST /api/audit/run、/api/audit/issue、/api/audit/rules。

跑审计走后台任务（JOBS）：POST 立即返回任务快照，前端轮询 GET 里的 job 进度；完成后 issues 即最新。
纪律：参数守卫先于写连接；域层错误统一 ValueError → 400。
"""
from core import audit, db, prompts


def _int_q(q):
    v = (q.get("scene_id") or [None])[0]
    try:
        v = int(v)
    except (TypeError, ValueError):
        return None
    return v if prompts.is_id(v) else None


def _scene_exists(con, sid):
    return bool(con.execute("SELECT id FROM scenes WHERE id=?", (sid,)).fetchone())


def _scene_of_issue(con, iid):
    row = con.execute("SELECT scene_id FROM audit_issues WHERE id=?", (iid,)).fetchone()
    if not row:
        raise ValueError("问题不存在")
    return row["scene_id"]


def rules_get(m, q):
    """规则清单（设置面板用；与场景无关）。"""
    con = db.connect()
    try:
        return {"ok": True, "rules": audit.rules_state(con)}, 200
    finally:
        con.close()


def summary(m, q):
    """全片未处理计数（场次导航徽标用）。"""
    con = db.connect()
    try:
        rows = con.execute("SELECT scene_id, COUNT(*) AS n FROM audit_issues"
                           " WHERE status='open' GROUP BY scene_id").fetchall()
        return {"ok": True, "open_by_scene": {str(r["scene_id"]): r["n"] for r in rows}}, 200
    finally:
        con.close()


def audit_get(m, q):
    sid = _int_q(q or {})
    if sid is None:
        return {"error": "参数不完整（scene_id）"}, 400
    con = db.connect()
    try:
        if not _scene_exists(con, sid):
            return {"error": "场景不存在"}, 400
        return {"ok": True, "scene_id": sid, "rules": audit.rules_state(con),
                "job": audit.JOBS.status(sid),
                **audit.issues_state(con, sid)}, 200
    finally:
        con.close()


def run(m, body, q):
    body = body or {}
    sid = body.get("scene_id")
    if not prompts.is_id(sid):
        return {"error": "参数不完整（scene_id）"}, 400
    con = db.connect()
    try:
        if not _scene_exists(con, sid):
            return {"error": "场景不存在"}, 400
    finally:
        con.close()
    return {"ok": True, "job": audit.JOBS.start(sid)}, 200


ISSUE_ACTIONS = {"waive", "unwaive", "recheck"}


def issue_op(m, body, q):
    body = body or {}
    action = body.get("action")
    if action not in ISSUE_ACTIONS:
        return {"error": "未知 action：%s" % action}, 400
    iid = body.get("id")
    if not prompts.is_id(iid):
        return {"error": "参数不完整（id）"}, 400
    if action == "recheck":
        con = db.connect()
        try:
            row = con.execute("SELECT * FROM audit_issues WHERE id=?", (iid,)).fetchone()
            if not row:
                return {"error": "问题不存在"}, 400
            sid, rid = row["scene_id"], row["rule_id"]
        finally:
            con.close()
        return {"ok": True, "job": audit.JOBS.start(sid, only=[rid])}, 200
    con = db.connect(rw=True)
    try:
        if action == "waive":
            audit.waive_issue(con, iid, body.get("note"))
        else:
            audit.unwaive_issue(con, iid)
        return {"ok": True, **audit.issues_state(con, _scene_of_issue(con, iid))}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def rules_op(m, body, q):
    body = body or {}
    rid = body.get("id")
    if not prompts.is_id(rid):
        return {"error": "参数不完整（id）"}, 400
    enabled = body.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        return {"error": "参数格式错误（enabled）"}, 400
    params = body.get("params")
    if params is not None and not isinstance(params, dict):
        return {"error": "参数格式错误（params）"}, 400
    if enabled is None and params is None:
        return {"error": "参数不完整（无可写字段）"}, 400
    con = db.connect(rw=True)
    try:
        return {"ok": True, "rules": audit.update_rule(con, rid, enabled=enabled,
                                                       params=params)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()
