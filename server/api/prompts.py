"""提示词与块库接口层（M3）：GET /api/blocks；POST /api/blocks（action 分发）；POST /api/prompt/<action>。

纪律：参数守卫先于写连接（坏请求不触发写路径）；域层错误统一 ValueError → 400。"""
from core import db, prompts

BLOCK_ACTIONS = {"create", "update", "delete", "move", "pin",
                 "cat_create", "cat_update", "cat_delete", "cat_move"}
BLOCK_UPDATE_KEYS = ("text", "category_id", "pinned", "position")  # 块可写字段（投影白名单）
PROMPT_ACTIONS = {"set_text", "merge", "detach", "split", "restore"}


def _req_int(body, key):
    """取整型参数；缺失/类型不对：返回 (None, 错误响应)。"""
    v = body.get(key)
    if not prompts.is_id(v):
        return None, ({"error": "参数不完整（%s）" % key}, 400)
    return v, None


def blocks(m, q):
    con = db.connect()
    try:
        return prompts.blocks_state(con), 200
    finally:
        con.close()


def blocks_op(m, body, q):
    """块库写操作：create / update / delete / move / pin / cat_create / cat_update / cat_delete / cat_move。"""
    body = body or {}
    action = body.get("action")
    if action not in BLOCK_ACTIONS:
        return {"error": "未知 action：%s" % action}, 400
    # ── 参数前置校验（进写连接之前） ──
    rid = None
    if action in ("update", "delete", "move", "pin", "cat_update", "cat_delete", "cat_move"):
        rid, err = _req_int(body, "id")
        if err:
            return err
    if action == "pin" and not isinstance(body.get("pinned"), bool):
        return {"error": "参数不完整（pinned）"}, 400
    data = None
    if action == "update":
        data = {k: body[k] for k in BLOCK_UPDATE_KEYS if k in body}
        if not data:                                   # L10：投影空检查前移（坏请求不触写连接）
            return {"error": "参数不完整（无可写字段）"}, 400
    con = db.connect(rw=True)
    try:
        if action == "create":
            return {"ok": True, "block": prompts.block_create(con, body.get("text"), body.get("category_id"))}, 200
        if action == "update":
            return {"ok": True, "block": prompts.block_update(con, rid, data)}, 200
        if action == "delete":
            return {"ok": True, "deleted": prompts.block_delete(con, rid)}, 200
        if action == "move":
            return {"ok": True, "moved": prompts.block_move(con, rid, body.get("dir"))["moved"]}, 200
        if action == "pin":
            return {"ok": True, "block": prompts.block_update(con, rid, {"pinned": body.get("pinned")})}, 200
        if action == "cat_create":
            return {"ok": True, "category": prompts.cat_create(con, body.get("name"))}, 200
        if action == "cat_update":
            return {"ok": True, "category": prompts.cat_update(con, rid, body.get("name"))}, 200
        if action == "cat_delete":
            prompts.cat_delete(con, rid)
            return {"ok": True}, 200
        return {"ok": True, "moved": prompts.cat_move(con, rid, body.get("dir"))["moved"]}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def prompt_op(m, body, q):
    """提示词组写操作：set_text / merge / detach / split / restore。"""
    action = m.group(1)
    body = body or {}
    if action not in PROMPT_ACTIONS:
        return {"error": "未知 action：%s" % action}, 400
    # ── 参数前置校验（进写连接之前） ──
    gid = None
    if action in ("set_text", "split"):
        gid, err = _req_int(body, "group_id")
        if err:
            return err
    sid = None
    if action == "restore":
        sid, err = _req_int(body, "scene_id")
        if err:
            return err
    con = db.connect(rw=True)
    try:
        if action == "set_text":
            res = prompts.set_group_text(con, gid, body.get("text"))
            return {"ok": True, **res}, 200
        if action == "merge":
            return {"ok": True, "groups": prompts.merge_shots(con, body.get("shot_ids"))}, 200
        if action == "detach":
            return {"ok": True, "groups": prompts.detach_shots(con, body.get("shot_ids"))}, 200
        if action == "split":
            return {"ok": True, "groups": prompts.split_group(con, gid)}, 200
        return {"ok": True, "groups": prompts.restore_state(con, sid, body.get("groups"))}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()
