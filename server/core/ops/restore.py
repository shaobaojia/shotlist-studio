# -*- coding: utf-8 -*-
"""还原族：insert_restore / restore_shots / restore_beat / restore_scene_full（原 ops.py 拆分 · S1-L1）。"""
from .write import record_history
from .structure import _scene_beats, _make_room, _table_cols, _insert_dict


def insert_restore(con, table, row, replace=None):
    """还原回插（撤销专用）：优先带原 id——撤销栈里更早的闭包都按原 id 记的，id 稳定才不悬空；
    id 已被占用时退回自增。replace 覆盖指定列（position / scene_id 等）。"""
    cols_all = _table_cols(con, table)
    rep = replace or {}
    d = {k: rep.get(k, row.get(k)) for k in row.keys() if k in cols_all}
    if d.get("id") is not None:
        occupied = con.execute("SELECT 1 FROM %s WHERE id=?" % table, (d["id"],)).fetchone()
        if occupied is not None:
            d.pop("id", None)
    return _insert_dict(con, table, d)


def restore_shots(con, rows_):
    """撤销删除：按原序（position 升序）插回原位；原编号/内容/提示词归属全带回（新 id）。"""
    rows_ = sorted(rows_, key=lambda r: (r.get("position") or 0))
    out = []
    for r in rows_:
        scene_id = r.get("scene_id")
        if not isinstance(scene_id, int):
            raise ValueError("恢复行缺 scene_id")
        cnt = con.execute("SELECT COUNT(*) c FROM shots WHERE scene_id=?", (scene_id,)).fetchone()["c"]
        idx = max(0, min(int(r.get("position") or 0), cnt))
        _make_room(con, "shots", "scene_id", scene_id, idx)
        new_id = insert_restore(con, "shots", r, {"position": idx})
        record_history(con, scene_id, "shots", new_id, field="create", old_value=None, new_value=r.get("shot_no"))
        out.append(dict(con.execute("SELECT * FROM shots WHERE id=?", (new_id,)).fetchone()))
    con.commit()
    return out


def restore_beat(con, beat_row, shot_ids):
    """撤销删除：重建节拍（原位）并认领镜头（按 id 重挂）。"""
    scene_id = beat_row.get("scene_id")
    if not isinstance(scene_id, int):
        raise ValueError("恢复节拍缺 scene_id")
    bs = _scene_beats(con, scene_id)
    idx = max(0, min(int(beat_row.get("position") or 0), len(bs)))
    _make_room(con, "beats", "scene_id", scene_id, idx)
    new_id = insert_restore(con, "beats", beat_row, {"position": idx})
    for sid in (shot_ids or []):
        if isinstance(sid, int):
            con.execute("UPDATE shots SET beat_id=? WHERE id=?", (new_id, sid))
    record_history(con, scene_id, "beats", new_id, field="create", old_value=None, new_value=beat_row.get("beat_no"))
    con.commit()
    return dict(con.execute("SELECT * FROM beats WHERE id=?", (new_id,)).fetchone())


def restore_scene_full(con, payload):
    """撤销删场：重建整场（新 id；场号/顺序原样；节拍/镜头/提示词组外键重连）。"""
    sc = dict(payload.get("scene") or {})
    film_id = sc.get("film_id")
    if not isinstance(film_id, int):
        raise ValueError("恢复场次缺 film_id")
    scenes = list(con.execute("SELECT id, position FROM scenes WHERE film_id=? ORDER BY position, id", (film_id,)))
    idx = max(0, min(int(sc.get("position") or 0), len(scenes)))
    _make_room(con, "scenes", "film_id", film_id, idx)
    new_sid = insert_restore(con, "scenes", sc, {"position": idx})
    bmap = {}
    for b in payload.get("beats") or []:
        bmap[b["id"]] = insert_restore(con, "beats", b, {"scene_id": new_sid})
    gmap = {}
    for g in payload.get("groups") or []:
        gmap[g["id"]] = insert_restore(con, "prompt_groups", g, {"scene_id": new_sid})
    for shot in payload.get("shots") or []:
        bid = bmap.get(shot.get("beat_id")) if shot.get("beat_id") is not None else None
        gid = gmap.get(shot.get("prompt_group_id")) if shot.get("prompt_group_id") is not None else None
        insert_restore(con, "shots", shot,
                        {"scene_id": new_sid, "beat_id": bid, "prompt_group_id": gid})
    record_history(con, new_sid, "scenes", new_sid, field="create", old_value=None, new_value=sc.get("scene_no"))
    con.commit()
    return {"id": new_sid, "scene_no": sc.get("scene_no")}

