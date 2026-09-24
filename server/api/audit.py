"""审计接口（M4a）：GET /api/audit?scene_id=；POST /api/audit/run、/api/audit/issue、/api/audit/rules。

跑审计走后台任务（JOBS）：POST 立即返回任务快照，前端轮询 GET 里的 job 进度；完成后 issues 即最新。
纪律：参数守卫先于写连接；域层错误统一 ValueError → 400。
"""
from api import _guard as guard
from api import params
from core import audit, db


def rules_get(m, q):
    """规则清单（设置面板用；与场景无关）。"""
    def run(con):
        return {"ok": True, "rules": audit.rules_state(con)}, 200

    return guard.read(run)


def summary(m, q):
    """全片未处理计数（场次导航徽标用）。"""
    def run(con):
        return {"ok": True, "open_by_scene": audit.open_counts(con)}, 200

    return guard.read(run)


def audit_get(m, q):
    try:
        sid = params.req_int_q(q or {}, "scene_id")
    except ValueError as e:
        return guard.err(str(e))

    def run(con):
        if not audit.scene_exists(con, sid):
            return guard.err("场景不存在")
        return {"ok": True, "scene_id": sid,
                "job": audit.JOBS.get(sid),
                **audit.issues_state(con, sid)}, 200

    return guard.read(run)


def run(m, body, q):
    try:
        sid = params.req_int(body, "scene_id")
    except ValueError as e:
        return guard.err(str(e))
    with db.conn_ro() as con:
        if not audit.scene_exists(con, sid):
            return guard.err("场景不存在")
    try:
        return {"ok": True, "job": audit.JOBS.start(sid)}, 200
    except ValueError as e:
        return guard.err(str(e))


ISSUE_ACTIONS = {"waive", "unwaive", "recheck"}


def issue_op(m, body, q):
    action = body.get("action")
    if action not in ISSUE_ACTIONS:
        return guard.err("未知 action：%s" % action)
    try:
        iid = params.req_int(body, "id")
    except ValueError as e:
        return guard.err(str(e))
    if action == "recheck":
        with db.conn_ro() as con:
            try:
                row = audit.get_issue(con, iid)
                sid, rid = row["scene_id"], row["rule_id"]
            except ValueError as e:
                return guard.err(str(e))
        if rid is None:
            return guard.err("问题未关联规则（规则可能重种过）——请先「跑审计」一轮后再试")
        try:
            job = audit.JOBS.start(sid, only=[rid])
        except ValueError as e:                       # 规则行已不存在（§11 同门）
            return guard.err(str(e))
        return {"ok": True, "job": job}, 200

    def run(con):
        if action == "waive":
            sid = audit.waive_issue(con, iid, body.get("note"))
        else:
            sid = audit.unwaive_issue(con, iid)
        return {"ok": True, **audit.issues_state(con, sid)}, 200

    return guard.write(run)


def rules_op(m, body, q):
    try:
        rid = params.req_int(body, "id")
    except ValueError as e:
        return guard.err(str(e))
    enabled = body.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        return guard.err("参数格式错误（enabled）")
    pdict = body.get("params")
    if pdict is not None and not isinstance(pdict, dict):
        return guard.err("参数格式错误（params）")
    if enabled is None and pdict is None:
        return guard.err("参数不完整（无可写字段）")

    def run(con):
        return {"ok": True, "rules": audit.update_rule(con, rid, enabled=enabled,
                                                       params=pdict)}, 200

    return guard.write(run)
