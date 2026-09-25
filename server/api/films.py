# -*- coding: utf-8 -*-
"""工程接口（工程库 · M8）：GET /api/films；POST /api/film/(create|rename|archive|delete)、/api/paste。

写响应附全量 films（F3-L4 信封口径：前端就地套用、不跟发 GET）。
参数守卫先于写连接；域层 ValueError → 400（guard.run_actions 模板）。
"""
from api import _guard as guard
from api import params
from core import fields, ops

# 四动作单源（M8 清理刀）：路由正则（app.py）与 SPEC 同序共用
ACTIONS = ("create", "rename", "archive", "delete")


def films_list(m, q):
    def run(con):
        return {"ok": True, "films": ops.list_films(con)}, 200

    return guard.read(run)


def _precheck(body, action):
    ctx = {}
    if action in ("create", "rename"):
        t = body.get("title")
        if not isinstance(t, str):                       # 仅类型层；非空/长度等域值规则归域层（_clean_title，W26）
            return None, guard.err("参数不完整（title）")
        ctx["title"] = t
    if action == "create":
        cf = body.get("copy_from")
        if cf is not None:
            if not fields.is_id(cf):
                return None, guard.err("参数不完整（copy_from）")
            ctx["copy_from"] = cf
    if action in ("rename", "archive", "delete"):
        rid = body.get("id")
        if not fields.is_id(rid):
            return None, guard.err("参数不完整（id）")
        ctx["id"] = rid
    if action == "archive":
        ctx["archived"] = bool(body.get("archived", True))
    return ctx, None


SPEC = {
    "create": lambda con, body, ctx: {"film": ops.create_film(con, ctx["title"], ctx.get("copy_from"))},
    "rename": lambda con, body, ctx: ops.rename_film(con, ctx["id"], ctx["title"]),
    "archive": lambda con, body, ctx: ops.archive_film(con, ctx["id"], ctx["archived"]),
    "delete": lambda con, body, ctx: ops.delete_film(con, ctx["id"]),
}


def film_op(m, body, q):
    """POST /api/film/(create|rename|archive|delete)（action 取自 URL 捕获组）。"""
    return guard.run_actions(SPEC, body, precheck=_precheck, action=m.group(1),
                             post=lambda con, out: {"films": ops.list_films(con)})   # 写后全量列表（F3-L4 信封）


def paste_op(m, body, q):
    """POST /api/paste：跨工程/跨场粘贴镜头到目标场表尾（M8 刀B）。
    行数上限同批量写（BATCH_MAX）；前端 overCap 预检同源（M8 清理刀）。"""
    scene_id = body.get("scene_id")
    if not fields.is_id(scene_id):
        return guard.err("参数不完整（scene_id）")
    try:
        ids = params.req_ids(body, "ids", max_n=fields.BATCH_MAX)
    except ValueError as e:
        return guard.err(str(e))

    def run(con):
        return {"ok": True, "pasted": ops.paste_shots(con, ids, scene_id)}, 200

    return guard.write(run)

