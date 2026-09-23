"""AI 接口：设置（M4a）+ 创作通道（M4b：preview / job / apply）。

安全口径：key 明文永不回传前端（public_config 只有 has_key 布尔）；api_key 留空 = 不改动。
"""
from core import ai, db, fields, rewrite


def settings_get(m, q):
    con = db.connect()
    try:
        return {"ok": True, "config": ai.public_config(ai.get_config(con))}, 200
    finally:
        con.close()


def settings_set(m, body, q):
    body = body or {}
    if not any(k in body for k in ("provider", "model", "base_url", "api_key")):
        return {"error": "参数不完整（无可写字段）"}, 400
    data = {}
    for src, dst in (("provider", "ai_provider"), ("model", "ai_model"),
                     ("base_url", "ai_base_url")):
        if src in body:
            data[dst] = body[src]
    if "api_key" in body:
        data["api_key"] = body["api_key"]
    con = db.connect(rw=True)
    try:
        cfg = ai.save_config(con, data)
        return {"ok": True, "config": ai.public_config(cfg)}, 200
    finally:
        con.close()


def test(m, body, q):
    con = db.connect()
    try:
        cfg = ai.get_config(con)
    finally:
        con.close()
    try:
        res = ai.probe(cfg)
        return {"ok": True, "ms": res["ms"], "model": res["model"],
                "reply": (res["text"] or "").strip()[:50]}, 200
    except ai.AiError as e:
        return {"ok": False, "error": str(e)}, 200


def preview(m, body, q):
    """创作预览（M4b）：起后台任务出稿；参数错立即 400。预览零写入。"""
    body = body or {}
    sid = body.get("scene_id")
    if not fields.is_id(sid):
        return {"error": "参数不完整（scene_id）"}, 400
    con = db.connect()
    try:
        cfg = ai.get_config(con)
    finally:
        con.close()
    try:
        ai.require_key(cfg)
    except ai.AiError as e:
        return {"error": str(e)}, 400
    try:
        job = rewrite.JOBS.start(sid, targets=body.get("targets"),
                                 action=body.get("action"),
                                 instruction=body.get("instruction"))
    except ValueError as e:
        return {"error": str(e)}, 400
    return {"ok": True, "job": job}, 200


def job_get(m, q):
    """预览任务快照（前端轮询）。"""
    v = (q.get("id") or [None])[0]
    try:
        jid = int(v)
    except (TypeError, ValueError):
        return {"error": "参数不完整（id）"}, 400
    return {"ok": True, "job": rewrite.JOBS.get(jid)}, 200


def apply_op(m, body, q):
    """应用预览条目（source=ai 落库；一步事务；前端推撤销栈）。"""
    body = body or {}
    jid = body.get("job_id")
    if not fields.is_id(jid):
        return {"error": "参数不完整（job_id）"}, 400
    job = rewrite.JOBS.get(jid)
    if not job:
        return {"error": "预览任务不存在（服务重启会清空，请重新生成）"}, 400
    if job.get("running"):
        return {"error": "预览还没跑完"}, 400
    con = db.connect(rw=True)
    try:
        res = rewrite.apply_items(con, job, item_ids=body.get("item_ids"))
        return {"ok": True, **res}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()
