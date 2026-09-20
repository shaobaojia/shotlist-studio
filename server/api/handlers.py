"""接口层：组装 JSON 载荷。GET handler：(match, query)；POST handler：(match, body, query)。"""
from urllib.parse import unquote

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
    scene_no = unquote(m.group(1))
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
    if table == "scenes" and field == "scene_no":
        value = ("" if value is None else str(value)).strip()
        if not value:
            return {"error": "场号不能为空"}, 400
    con = db.connect(rw=True)
    try:
        if table == "scenes" and field == "scene_no":
            dup = con.execute("SELECT id FROM scenes WHERE scene_no=? AND id<>?",
                              (value, row_id)).fetchone()
            if dup:
                return {"error": "场号已存在：%s" % value}, 400
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
    if table not in ("shots", "beats", "scenes") or not isinstance(rid, int):
        return {"error": "参数不完整（table/id/index）"}, 400
    con = db.connect(rw=True)
    try:
        if table == "shots":
            bid = (body or {}).get("beat_id")
            if not isinstance(bid, int):
                return {"error": "缺少目标节拍 beat_id"}, 400
            res = ops.move_shot(con, rid, bid, index)
        elif table == "beats":
            res = ops.move_beat(con, rid, index)
        else:
            res = ops.move_scene(con, rid, index)
        return {"ok": True, "moved": res}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def renumber(m, body, q):
    """M2 整理镜号：按当前顺序整场顺排；旧号入痕迹。"""
    scene_no = unquote(m.group(1))
    con = db.connect(rw=True)
    try:
        f = db.film(con)
        if not f:
            return {"error": "库里还没有影片"}, 404
        sc = db.scene_by_no(con, f["id"], scene_no)
        if not sc:
            return {"error": "场景不存在：%s" % scene_no}, 404
        return {"ok": True, "changes": ops.renumber_scene(con, sc["id"])}, 200
    finally:
        con.close()


def duplicate(m, body, q):
    """M2-5/6 副本：镜头行 / 节拍（连镜头）/ 场次（整场）深拷。"""
    table = (body or {}).get("table") or "shots"
    rid = (body or {}).get("id")
    if table not in ("shots", "beats", "scenes") or not isinstance(rid, int):
        return {"error": "参数不完整（table/id）"}, 400
    con = db.connect(rw=True)
    try:
        if table == "shots":
            return {"ok": True, "shot": ops.duplicate_shot(con, rid)}, 200
        if table == "beats":
            return {"ok": True, "beat": ops.duplicate_beat(con, rid)}, 200
        return {"ok": True, "scene": ops.duplicate_scene(con, rid)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def delete_row(m, body, q):
    """M2-6 删除：镜头行（可多行）/ 节拍（镜头落未归或连删）/ 场次（整场级联）；返回快照供撤销。"""
    table = (body or {}).get("table") or "shots"
    ids = (body or {}).get("ids")
    if ids is None and isinstance((body or {}).get("id"), int):
        ids = [(body or {}).get("id")]
    if table not in ("shots", "beats", "scenes") or not isinstance(ids, list) or not ids \
            or not all(isinstance(x, int) for x in ids):
        return {"error": "参数不完整（table + id/ids）"}, 400
    if len(ids) > 200:
        return {"error": "一次最多 200 行"}, 400
    con = db.connect(rw=True)
    try:
        if table == "shots":
            return {"ok": True, "deleted": {"rows": ops.delete_shots(con, ids)}}, 200
        if len(ids) != 1:
            return {"error": "该删除一次只能一项"}, 400
        if table == "beats":
            res = ops.delete_beat(con, ids[0], with_shots=bool((body or {}).get("with_shots")))
            return {"ok": True, "deleted": res}, 200
        return {"ok": True, "deleted": ops.delete_scene(con, ids[0])}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def create(m, body, q):
    """M2-6 创建：空镜头（可指定插入位）/ 空节拍（末尾）/ 空场（末尾）。"""
    kind = (body or {}).get("kind")
    con = db.connect(rw=True)
    try:
        if kind == "shot":
            scene_id = (body or {}).get("scene_id")
            beat_id = (body or {}).get("beat_id")
            index = (body or {}).get("index", 0)
            if not isinstance(scene_id, int) or not isinstance(index, int) \
                    or (beat_id is not None and not isinstance(beat_id, int)):
                return {"error": "参数不完整（scene_id/beat_id/index）"}, 400
            return {"ok": True, "shot": ops.create_blank_shot(con, scene_id, beat_id, index)}, 200
        if kind == "beat":
            scene_id = (body or {}).get("scene_id")
            if not isinstance(scene_id, int):
                return {"error": "参数不完整（scene_id）"}, 400
            return {"ok": True, "beat": ops.create_beat(con, scene_id)}, 200
        if kind == "scene":
            return {"ok": True, "scene": ops.create_scene(con)}, 200
        return {"error": "未知 kind：%s" % kind}, 400
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def restore(m, body, q):
    """M2-6 撤销专用还原：删行 / 删节拍 / 删场 的完整回插。"""
    kind = (body or {}).get("kind")
    con = db.connect(rw=True)
    try:
        if kind == "shots":
            rows = (body or {}).get("rows")
            if not isinstance(rows, list) or not rows:
                return {"error": "参数不完整（rows）"}, 400
            return {"ok": True, "shots": ops.restore_shots(con, rows)}, 200
        if kind == "beat":
            beat = (body or {}).get("beat")
            shot_ids = (body or {}).get("shot_ids") or []
            if not isinstance(beat, dict):
                return {"error": "参数不完整（beat）"}, 400
            return {"ok": True, "beat": ops.restore_beat(con, beat, shot_ids)}, 200
        if kind == "scene":
            payload = (body or {}).get("payload")
            if not isinstance(payload, dict) or not isinstance(payload.get("scene"), dict):
                return {"error": "参数不完整（payload）"}, 400
            return {"ok": True, "scene": ops.restore_scene_full(con, payload)}, 200
        return {"error": "未知 kind：%s" % kind}, 400
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()


def lock(m, body, q):
    """M2-7 锁定本场：场次版本快照（落盘 + snapshots 记录）+ 锁定标记（锁定 ≠ 禁止编辑）。"""
    rid = (body or {}).get("id")
    lock_flag = bool((body or {}).get("lock", True))
    if not isinstance(rid, int):
        return {"error": "参数不完整（id）"}, 400
    con = db.connect(rw=True)
    try:
        return {"ok": True, **ops.lock_scene(con, rid, lock_flag)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    finally:
        con.close()
