# -*- coding: utf-8 -*-
"""接口层分发骨架（P0·S3-P7②③ / S1-L2）：action 分发表模板 + 连接信封 + 文案单点。

纪律：参数守卫先于写连接（坏请求不触发写路径）；域层 ValueError → 400。
边界契约（P7④）：body 已由 app.py 归一为 dict（S1-P4②）——handler 不再 (body or {})。
"""
from core import db

UNKNOWN_ACTION = "未知 action：%s"          # P7③：文案单点
MSG_NO_FILM = "库里还没有影片—先跑迁移脚本"    # 无片文案单点（M8 清理刀）
MSG_FILM_MISSING = "工程不存在：%s"          # 指定片号缺失文案单点（同上）


def err(msg, code=400):
    """错误信封单点（S1/S3-L2）：{"error": msg}, code。"""
    return {"error": msg}, code


def read(fn):
    """读信封（S1-L2）：open_ro + close；fn(con) → (obj, code)。"""
    with db.conn_ro() as con:
        return fn(con)


def write(fn):
    """写信封（S1-L2）：open_rw + ValueError→400 + close；fn(con) → (obj, code)。"""
    try:
        with db.conn_rw() as con:
            return fn(con)
    except ValueError as e:
        return err(str(e))


def scene_or_404(con, scene_no, film_id=None):
    """场装载 + 404 双判（S1-L2 单点）：返回 (sc, None) 或 (None, (obj, code))。
    film_id 给定 → 限定工程（M8 工程库）。"""
    f, sc = db.load_scene(con, scene_no, film_id)
    if not f:
        if film_id is None:
            return None, err(MSG_NO_FILM, 404)
        return None, err(MSG_FILM_MISSING % film_id, 404)   # 指定片号缺失：精确诊断（M8 清理刀）
    if not sc:
        return None, err("场景不存在：%s" % scene_no, 404)
    return sc, None


def run_actions(spec, body, precheck=None, action=None, post=None):
    """分发模板（P7②）：未知 action → 400；precheck(body, action) → (ctx, err)；
    写连接内 spec[action](con, body, ctx) 分派，结果并入 {"ok": True}；ValueError → 400。
    post(con, out)（可选，F3-L4）：同连接内补发字段（写响应就地套用所需的全量视图）。
    action 缺省取自 body["action"]；prompt_op 的 action 来自 URL（m.group(1)）须显式传。"""
    action = action if action is not None else body.get("action")
    if action not in spec:
        return err(UNKNOWN_ACTION % action)
    ctx, e = precheck(body, action) if precheck else ({}, None)
    if e:
        return e

    def run(con):
        out = spec[action](con, body, ctx)
        extra = post(con, out) if post else None
        return {"ok": True, **(out or {}), **(extra or {})}, 200

    return write(run)
