"""草稿档接口（M4b-4）：场次草稿 / 组级初稿 / 轮询 / 落入。薄层，逻辑在 core/draft。"""
from api import _guard as guard
from api import params
from core import draft, fields

JOBS = draft.DraftJobs()


def start(m, body, q):
    sid, script = body.get("scene_id"), body.get("script")
    if not fields.is_id(sid):
        return guard.err("参数不完整（scene_id）")
    if not isinstance(script, str):
        return guard.err("参数不完整（script）")
    try:
        return {"ok": True, "job": JOBS.start_scene(sid, script)}, 200
    except ValueError as e:
        return guard.err(str(e))


def prompt(m, body, q):
    sid, shid = body.get("scene_id"), body.get("shot_id")
    if not fields.is_id(sid) or not fields.is_id(shid):
        return guard.err("参数不完整（scene_id / shot_id）")
    try:
        return {"ok": True, "job": JOBS.start_prompt(sid, shid)}, 200
    except ValueError as e:
        return guard.err(str(e))


def job_get(m, q):
    try:
        jid = params.req_int_q(q, "id")                 # P7①：query id 单点
    except ValueError as e:
        return guard.err(str(e))
    job = JOBS.get(jid)
    if not job:
        # 与 AI 域同契约：任务不在 → 200 + job:null（前端走「任务丢失」提示，不当网络错误死轮询）
        return {"ok": True, "job": None}, 200
    return {"ok": True, "job": job}, 200


def apply_op(m, body, q):
    jid = body.get("job_id")
    if not fields.is_id(jid):
        return guard.err("参数不完整（job_id）")
    try:
        res = JOBS.apply(jid)
        return {"ok": True, **res}, 200
    except ValueError as e:
        return guard.err(str(e))
