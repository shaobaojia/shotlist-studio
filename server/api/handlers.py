"""接口层：组装只读 JSON 载荷。所有 handler 签名 (match, query) -> (obj, status)。"""
from core import db, fields


def health(m, q):
    return {"ok": True, "service": "shotlist-studio"}, 200


def meta(m, q):
    return fields.meta(), 200


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
