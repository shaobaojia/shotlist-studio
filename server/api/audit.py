"""审计接口（M4a）：GET /api/audit?scene_id=；POST /api/audit/run、/api/audit/issue、/api/audit/rules。

跑审计走后台任务（JOBS）：POST 立即返回任务快照，前端轮询 GET 里的 job 进度；完成后 issues 即最新。
纪律：参数守卫先于写连接；域层错误统一 ValueError → 400。
"""
from api import params
from core import audit, db


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
        return {"ok": True, "open_by_scene": audit.open_counts(con)}, 200
    finally:
        con.close()


def audit_get(m, q):
    try:
        sid = params.req_int_q(q or {}, "scene_id")
    except ValueError as e:
        return {"error": str(e)}, 400
    con = db.connect()
    try:
        if not audit.scene_exists(con, sid):
            return {"error": "场景不存在"}, 400
        return {"ok": True, "scene_id": sid,
                "job": audit.JOBS.get(sid),
                **audit.issues_state(con, sid)}, 200
    finally:
        con.close()


def run(m, body, q):
    body = body or {}
    try:
        sid = params.req_int(body, "scene_id")
    except ValueError as e:
        return {"error": str(e)}, 400
    con = db.connect()
    try:
        if not audit.scene_exists(con, sid):
            return {"error": "场景不存在"}, 400
    finally:
        con.close()
    try:
        return {"ok": True, "job": audit.JOBS.start(sid)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400


ISSUE_ACTIONS = {"waive", "unwaive", "recheck"}


def issue_op(m, body, q):
    body = body or {}
    action = body.get("action")
    if action not in ISSUE_ACTIONS:
        return {"error": "未知 action：%s" % action}, 400
    try:
        iid = params.req_int(body, "id")
    except ValueError as e:
        return {"error": str(e)}, 400
    if action == "recheck":
        con = db.connect()
        try:
            row = audit.get_issue(con, iid)
            sid, rid = row["scene_id"], row["rule_id"]
        except ValueError as e:
            return {"error": str(e)}, 400
        finally:
            con.close()
        if rid is None:
            return {"error": "问题未关联规则（规则可能重种过）——请先「跑审计」一轮后再试"}, 400
        try:
            job = audit.JOBS.start(sid, only=[rid])
        except ValueError as e:                       # 规则行已不存在（§11 同门）
            return {"error": str(e)}, 400
        return {"ok": True, "job": job}, 200
    con = db.connect(rw=True)
    try:
        if action == "waive":
            sid = audit.waive_issue(con, iid, body.get("note"))
        else:
            sid = audit.unwaive_issue(con, iid)
        return {"ok": True, **audit.issues_state(con, sid)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def rules_op(m, body, q):
    body = body or {}
    try:
        rid = params.req_int(body, "id")
    except ValueError as e:
        return {"error": str(e)}, 400
    enabled = body.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        return {"error": "参数格式错误（enabled）"}, 400
    pdict = body.get("params")
    if pdict is not None and not isinstance(pdict, dict):
        return {"error": "参数格式错误（params）"}, 400
    if enabled is None and pdict is None:
        return {"error": "参数不完整（无可写字段）"}, 400
    con = db.connect(rw=True)
    try:
        return {"ok": True, "rules": audit.update_rule(con, rid, enabled=enabled,
                                                       params=pdict)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()
