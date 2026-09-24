"""AI 接口：设置（M4a）+ 创作通道（M4b：preview / job / apply）。

安全口径：key 明文永不回传前端（public_config 只有 has_key 布尔）；api_key 留空 = 不改动。
"""
from api import _guard as guard
from api import params
from core import ai, db, fields, rewrite

REPLY_PREVIEW_MAX = 50     # 连通性小测回包预览截断（P6①）


def settings_get(m, q):
    def run(con):
        return {"ok": True, "config": ai.public_config(ai.get_config(con))}, 200

    return guard.read(run)


def settings_set(m, body, q):
    if not any(k in body for k in ("provider", "model", "base_url", "api_key")):
        return guard.err("参数不完整（无可写字段）")
    data = {dst: body[src] for src, dst in ai.OUTER_FIELDS if src in body}   # P7⑤：映射单表
    if "api_key" in body:
        data["api_key"] = body["api_key"]

    def run(con):
        cfg = ai.save_config(con, data)
        return {"ok": True, "config": ai.public_config(cfg)}, 200

    return guard.write(run)


def test(m, body, q):
    with db.conn_ro() as con:
        cfg = ai.get_config(con)
    try:
        res = ai.probe(cfg)
        return {"ok": True, "ms": res["ms"], "model": res["model"],
                "reply": (res["text"] or "").strip()[:REPLY_PREVIEW_MAX]}, 200
    except ai.AiError as e:
        return {"ok": False, "error": str(e)}, 200


def preview(m, body, q):
    """创作预览（M4b）：起后台任务出稿；参数错立即 400。预览零写入。"""
    sid = body.get("scene_id")
    if not fields.is_id(sid):
        return guard.err("参数不完整（scene_id）")
    with db.conn_ro() as con:
        cfg = ai.get_config(con)
    try:
        ai.require_key(cfg)
    except ai.AiError as e:
        return guard.err(str(e))
    try:
        job = rewrite.JOBS.start(sid, targets=body.get("targets"),
                                 action=body.get("action"),
                                 instruction=body.get("instruction"))
    except ValueError as e:
        return guard.err(str(e))
    return {"ok": True, "job": job}, 200


def job_get(m, q):
    """预览任务快照（前端轮询）。"""
    try:
        jid = params.req_int_q(q, "id")                 # P7①：query id 单点
    except ValueError as e:
        return guard.err(str(e))
    return {"ok": True, "job": rewrite.JOBS.get(jid)}, 200


def apply_op(m, body, q):
    """应用预览条目（source=ai 落库；一步事务；前端推撤销栈）。"""
    jid = body.get("job_id")
    if not fields.is_id(jid):
        return guard.err("参数不完整（job_id）")
    job = rewrite.JOBS.get(jid)
    if not job:
        return guard.err("预览任务不存在（服务重启会清空，请重新生成）")
    if job.get("running"):
        return guard.err("预览还没跑完")

    def run(con):
        res = rewrite.apply_items(con, job, item_ids=body.get("item_ids"))
        return {"ok": True, **res}, 200

    return guard.write(run)
