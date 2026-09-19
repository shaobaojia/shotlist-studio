"""提示词与块库接口层（M3）：GET /api/blocks；POST /api/blocks（action 分发）；POST /api/prompt/<action>。"""
from core import db, ops, prompts


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
    ops.ensure_daily_snapshot()
    con = db.connect(rw=True)
    try:
        if action == "create":
            return {"ok": True, "block": prompts.block_create(con, body.get("text"), body.get("category_id"))}, 200
        if action == "update":
            return {"ok": True, "block": prompts.block_update(con, body.get("id"), body)}, 200
        if action == "delete":
            return {"ok": True, "deleted": prompts.block_delete(con, body.get("id"))}, 200
        if action == "move":
            prompts.block_move(con, body.get("id"), body.get("dir"))
            return {"ok": True}, 200
        if action == "pin":
            return {"ok": True,
                    "block": prompts.block_update(con, body.get("id"), {"pinned": bool(body.get("pinned"))})}, 200
        if action == "cat_create":
            return {"ok": True, "category": prompts.cat_create(con, body.get("name"))}, 200
        if action == "cat_update":
            return {"ok": True, "category": prompts.cat_update(con, body.get("id"), body.get("name"))}, 200
        if action == "cat_delete":
            prompts.cat_delete(con, body.get("id"))
            return {"ok": True}, 200
        if action == "cat_move":
            prompts.cat_move(con, body.get("id"), body.get("dir"))
            return {"ok": True}, 200
        return {"error": "未知 action：%s" % action}, 400
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def prompt_op(m, body, q):
    """提示词组写操作：set_text / merge / detach / split / restore。"""
    action = m.group(1)
    body = body or {}
    ops.ensure_daily_snapshot()
    con = db.connect(rw=True)
    try:
        if action == "set_text":
            gid = body.get("group_id")
            if not isinstance(gid, int):
                return {"error": "参数不完整（group_id）"}, 400
            res = prompts.set_group_text(con, gid, body.get("text"))
            return {"ok": True, **res}, 200
        if action == "merge":
            return {"ok": True, "groups": prompts.merge_shots(con, body.get("shot_ids"))}, 200
        if action == "detach":
            return {"ok": True, "groups": prompts.detach_shots(con, body.get("shot_ids"))}, 200
        if action == "split":
            gid = body.get("group_id")
            if not isinstance(gid, int):
                return {"error": "参数不完整（group_id）"}, 400
            return {"ok": True, "groups": prompts.split_group(con, gid)}, 200
        if action == "restore":
            sid = body.get("scene_id")
            if not isinstance(sid, int):
                return {"error": "参数不完整（scene_id）"}, 400
            return {"ok": True, "groups": prompts.restore_state(con, sid, body.get("groups"))}, 200
        return {"error": "未知 action：%s" % action}, 400
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()
