# -*- coding: utf-8 -*-
"""接口层分发骨架（P0·S3-P7②③）：action 分发表模板 + 文案单点。

纪律：参数守卫先于写连接（坏请求不触发写路径）；域层 ValueError → 400。
边界契约（P7④）：body 已由 app.py 归一为 dict（S1-P4②）——handler 不再 (body or {})。
"""
from core import db

UNKNOWN_ACTION = "未知 action：%s"          # P7③：文案单点


def run_actions(spec, body, precheck=None, action=None):
    """分发模板（P7②）：未知 action → 400；precheck(body, action) → (ctx, err)；
    写连接内 spec[action](con, body, ctx) 分派，结果并入 {"ok": True}；ValueError → 400。
    action 缺省取自 body["action"]；prompt_op 的 action 来自 URL（m.group(1)）须显式传。"""
    action = action if action is not None else body.get("action")
    if action not in spec:
        return {"error": UNKNOWN_ACTION % action}, 400
    ctx, err = precheck(body, action) if precheck else ({}, None)
    if err:
        return err
    con = db.open_rw()
    try:
        out = spec[action](con, body, ctx)
        return {"ok": True, **(out or {})}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()
