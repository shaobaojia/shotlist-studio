"""草稿档接口（M4b-4）：场次草稿 / 组级初稿 / 轮询 / 落入。薄层，逻辑在 core/draft。"""
from core import draft, fields

JOBS = draft.DraftJobs()


def start(m, body, q):
    body = body or {}
    sid, script = body.get("scene_id"), body.get("script")
    if not fields.is_id(sid):
        return {"error": "参数不完整（scene_id）"}, 400
    if not isinstance(script, str):
        return {"error": "参数不完整（script）"}, 400
    try:
        return {"ok": True, "job": JOBS.start_scene(sid, script)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400


def prompt(m, body, q):
    body = body or {}
    sid, shid = body.get("scene_id"), body.get("shot_id")
    if not fields.is_id(sid) or not fields.is_id(shid):
        return {"error": "参数不完整（scene_id / shot_id）"}, 400
    try:
        return {"ok": True, "job": JOBS.start_prompt(sid, shid)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400


def job_get(m, q):
    try:
        jid = int((q.get("id") or [""])[0])
    except ValueError:
        return {"error": "参数不完整（id）"}, 400
    job = JOBS.get(jid)
    if not job:
        # 与 AI 域同契约：任务不在 → 200 + job:null（前端走「任务丢失」提示，不当网络错误死轮询）
        return {"ok": True, "job": None}, 200
    return {"ok": True, "job": job}, 200


def apply_op(m, body, q):
    body = body or {}
    jid = body.get("job_id")
    if not fields.is_id(jid):
        return {"error": "参数不完整（job_id）"}, 400
    try:
        res = JOBS.apply(jid)
        return {"ok": True, **res}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
