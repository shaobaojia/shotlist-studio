# -*- coding: utf-8 -*-
"""工程接口（工程库 · M8）：GET /api/films；POST /api/film/(create|rename|archive|delete)。

写响应附全量 films（F3-L4 信封口径：前端就地套用、不跟发 GET）。
参数守卫先于写连接；域层 ValueError → 400（guard.run_actions 模板）。
"""
from api import _guard as guard
from core import fields, ops


def films_list(m, q):
    def run(con):
        return {"ok": True, "films": ops.list_films(con)}, 200

    return guard.read(run)


def _precheck(body, action):
    ctx = {}
    if action in ("create", "rename"):
        t = body.get("title")
        if not isinstance(t, str) or not t.strip():
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


def _post(con, out):
    return {"films": ops.list_films(con)}    # 全量列表：弹层就地重渲（F3-L4 信封扩展）


SPEC = {
    "create": lambda con, body, ctx: {"film": ops.create_film(con, ctx["title"], ctx.get("copy_from"))},
    "rename": lambda con, body, ctx: ops.rename_film(con, ctx["id"], ctx["title"]),
    "archive": lambda con, body, ctx: ops.archive_film(con, ctx["id"], ctx["archived"]),
    "delete": lambda con, body, ctx: ops.delete_film(con, ctx["id"]),
}


def film_op(m, body, q):
    """POST /api/film/(create|rename|archive|delete)（action 取自 URL 捕获组）。"""
    return guard.run_actions(SPEC, body, precheck=_precheck, action=m.group(1), post=_post)
