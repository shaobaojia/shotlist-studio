"""接口层：组装 JSON 载荷。GET handler：(match, query)；POST handler：(match, body, query)。"""
from core import db, fields, ops


def health(m, q):
    return {"ok": True, "service": "shotlist-studio"}, 200


def meta(m, q):
    obj = fields.meta()
    try:
        con = db.connect()
        try:
            rows = con.execute(
                "SELECT DISTINCT kind FROM beats WHERE kind IS NOT NULL AND kind<>'' ORDER BY kind")
            obj["beat_kinds"] = [r["kind"] for r in rows]
        finally:
            con.close()
    except Exception:
        obj["beat_kinds"] = []
    return obj, 200


def film(m, q):
    con = db.connect()
    try:
        f = db.film(con)
        if not f:
            return {"error": "库里还没有影片—先跑迁移脚本"}, 404
        return {"film": {"id": f["id"], "title": f["title"]},
                "scenes": db.scenes(con, f["id"])}, 200
    finally:
        con.close()


def scene(m, q):
    scene_no = m.group(1)
    con = db.connect()
    try:
        f = db.film(con)
        if not f:
            return {"error": "库里还没有影片—先跑迁移脚本"}, 404
        sc = db.scene_by_no(con, f["id"], scene_no)
        if not sc:
            return {"error": "场景不存在：%s" % scene_no}, 404
        beats = db.beats(con, sc["id"])
        shots = db.shots(con, sc["id"])
        groups = db.prompt_groups(con, sc["id"])

        by_beat = {}
        for s in shots:
            by_beat.setdefault(s.get("beat_id"), []).append(s)
        for b in beats:
            b["shots"] = by_beat.pop(b["id"], [])
        orphan = by_beat.pop(None, [])

        gmap = {g["id"]: g for g in groups}
        for g in groups:
            g["member_shots"] = []
        for s in shots:
            gid = s.get("prompt_group_id")
            if gid in gmap:
                gmap[gid]["member_shots"].append(s["shot_no"])

        payload = {"scene": sc, "beats": beats, "prompt_groups": groups}
        if orphan:
            payload["orphan_shots"] = orphan
        return payload, 200
    finally:
        con.close()


def history(m, q):
    sid = (q.get("scene_id") or [None])[0]
    try:
        limit = min(500, max(1, int((q.get("limit") or ["100"])[0])))
    except ValueError:
        limit = 100
    con = db.connect()
    try:
        return {"history": ops.history_of(con, int(sid) if sid else None, limit)}, 200
    finally:
        con.close()


def update(m, body, q):
    """M2 写路径：单字段更新（白名单 + 痕迹）。"""
    table = (body or {}).get("table")
    row_id = (body or {}).get("id")
    field = (body or {}).get("field")
    value = (body or {}).get("value")
    if table not in ("shots", "beats", "scenes") or not isinstance(row_id, int) or not field:
        return {"error": "参数不完整（table/id/field）"}, 400
    ops.ensure_daily_snapshot()
    con = db.connect(rw=True)
    try:
        row, changed = ops.update_field(con, table, row_id, field,
                                        "" if value is None else str(value))
        return {"ok": True, "changed": changed, "row": row}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def batch(m, body, q):
    """M2-4 写路径：批量单字段更新（逐项白名单 + 痕迹；上限 400 项）。"""
    items = (body or {}).get("ops")
    if not isinstance(items, list) or not items:
        return {"error": "参数不完整（ops）"}, 400
    if len(items) > 400:
        return {"error": "一次最多 400 项"}, 400
    ops.ensure_daily_snapshot()
    con = db.connect(rw=True)
    try:
        res = ops.batch_update(con, items)
        return {"ok": True, "changed": res["changed"], "results": res["results"]}, 200
    finally:
        con.close()


def move(m, body, q):
    table = (body or {}).get("table")
    rid = (body or {}).get("id")
    index = (body or {}).get("index", 0)
    if table not in ("shots", "beats") or not isinstance(rid, int):
        return {"error": "参数不完整（table/id/index）"}, 400
    ops.ensure_daily_snapshot()
    con = db.connect(rw=True)
    try:
        if table == "shots":
            bid = (body or {}).get("beat_id")
            if not isinstance(bid, int):
                return {"error": "缺少目标节拍 beat_id"}, 400
            res = ops.move_shot(con, rid, bid, index)
        else:
            res = ops.move_beat(con, rid, index)
        return {"ok": True, "moved": res}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def renumber(m, body, q):
    """M2 整理镜号：按当前顺序整场顺排；旧号入痕迹。"""
    scene_no = m.group(1)
    con = db.connect(rw=True)
    try:
        f = db.film(con)
        if not f:
            return {"error": "库里还没有影片"}, 404
        sc = db.scene_by_no(con, f["id"], scene_no)
        if not sc:
            return {"error": "场景不存在：%s" % scene_no}, 404
        ops.ensure_daily_snapshot()
        return {"ok": True, "changes": ops.renumber_scene(con, sc["id"])}, 200
    finally:
        con.close()


def duplicate(m, body, q):
    """M2-5 行副本：在源镜头后插入整行副本（同节拍；镜号字母后缀；内容列全拷）。"""
    rid = (body or {}).get("id")
    if not isinstance(rid, int):
        return {"error": "参数不完整（id）"}, 400
    ops.ensure_daily_snapshot()
    con = db.connect(rw=True)
    try:
        return {"ok": True, "shot": ops.duplicate_shot(con, rid)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def delete_row(m, body, q):
    """M2-5 删除行（内部：供「创建行副本」撤销用；只允许 shots）。"""
    table = (body or {}).get("table") or "shots"
    rid = (body or {}).get("id")
    if table != "shots" or not isinstance(rid, int):
        return {"error": "参数不完整（table=shots + id）"}, 400
    ops.ensure_daily_snapshot()
    con = db.connect(rw=True)
    try:
        return {"ok": True, "deleted": ops.delete_shot(con, rid)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()

