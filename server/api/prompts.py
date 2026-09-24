# -*- coding: utf-8 -*-
"""提示词与块库接口层（M3）：GET /api/blocks；POST /api/blocks（action 分发）；POST /api/prompt/<action>。

纪律：可前移的参数守卫先于写连接（坏请求不触发写路径）——create/cat_create/cat_update 的
域值校验（文本/名称非空与长度）仍在域层连接内执行（历史口径，见 W26）；域层错误统一
ValueError → 400。分发骨架走 api._guard.run_actions（P0·S3-P7②）；body 由边界归一（app.py，S1-P4②）。
"""
from api import _guard as guard
from api import params
from core import fields, prompts


def _req_int(body, key):
    """取整型参数；缺失/类型不对：返回 (None, 错误响应)。——P0·S2-P3（逻辑走 params.req_int 单点）"""
    try:
        return params.req_int(body, key), None
    except ValueError as e:
        return None, guard.err(str(e))


def blocks(m, q):
    def run(con):
        return prompts.blocks_state(con), 200

    return guard.read(run)


# ── 块库（P7②：分发表） ──

def _block_precheck(body, action):
    ctx = {}
    if action in ("update", "delete", "move", "pin", "cat_update", "cat_delete", "cat_move"):
        rid, err = _req_int(body, "id")
        if err:
            return None, err
        ctx["rid"] = rid
    if action == "pin" and not isinstance(body.get("pinned"), bool):
        return None, guard.err("参数不完整（pinned）")
    if action == "update":
        data = {k: body[k] for k in fields.BLOCK_WRITE_KEYS if k in body}
        if not data:                                   # L10：投影空检查前移（坏请求不触写连接）
            return None, guard.err("参数不完整（无可写字段）")
        ctx["data"] = data
    return ctx, None


def _cat_delete(con, b, ctx):
    prompts.cat_delete(con, ctx["rid"])
    return {}


BLOCK_SPEC = {
    "create": lambda con, b, c: {"block": prompts.block_create(con, b.get("text"), b.get("category_id"))},
    "update": lambda con, b, c: {"block": prompts.block_update(con, c["rid"], c["data"])},
    "delete": lambda con, b, c: {"deleted": prompts.block_delete(con, c["rid"])},
    "move": lambda con, b, c: {"moved": prompts.block_move(con, c["rid"], b.get("dir"))["moved"]},
    "pin": lambda con, b, c: {"block": prompts.block_update(con, c["rid"], {"pinned": b.get("pinned")})},
    "cat_create": lambda con, b, c: {"category": prompts.cat_create(con, b.get("name"))},
    "cat_update": lambda con, b, c: {"category": prompts.cat_update(con, c["rid"], b.get("name"))},
    "cat_delete": _cat_delete,
    "cat_move": lambda con, b, c: {"moved": prompts.cat_move(con, c["rid"], b.get("dir"))["moved"]},
}


def blocks_op(m, body, q):
    """块库写操作：create / update / delete / move / pin / cat_create / cat_update / cat_delete / cat_move。"""
    return guard.run_actions(BLOCK_SPEC, body, _block_precheck)


# ── 提示词组（P7②：分发表） ──

def _prompt_precheck(body, action):
    ctx = {}
    if action in ("set_text", "split"):
        gid, err = _req_int(body, "group_id")
        if err:
            return None, err
        ctx["gid"] = gid
    if action == "restore":
        sid, err = _req_int(body, "scene_id")
        if err:
            return None, err
        ctx["sid"] = sid
    return ctx, None


PROMPT_SPEC = {
    "set_text": lambda con, b, c: prompts.set_group_text(con, c["gid"], b.get("text")),
    "merge": lambda con, b, c: {"groups": prompts.merge_shots(con, b.get("shot_ids"))},
    "detach": lambda con, b, c: {"groups": prompts.detach_shots(con, b.get("shot_ids"))},
    "split": lambda con, b, c: {"groups": prompts.split_group(con, c["gid"])},
    "restore": lambda con, b, c: {"groups": prompts.restore_state(con, c["sid"], b.get("groups"))},
}


def prompt_op(m, body, q):
    """提示词组写操作：set_text / merge / detach / split / restore。"""
    return guard.run_actions(PROMPT_SPEC, body, _prompt_precheck, action=m.group(1))
