# -*- coding: utf-8 -*-
"""场级操作：创建 / 移动 / 复制 / 删除 / 整号 / 载荷（原 ops.py 拆分 · S1-L1）。"""
from datetime import datetime
from pathlib import Path

from core import db, fsutil, paths
from .write import record_history, _row_or_raise
from .structure import _scene_beats, _scene_shots, reseq, _make_room, _reseq_survivors, _table_cols, _copy_row
from .numbering import COPY_COLS, _next_scene_no


def renumber_scene(con, scene_id):
    """整理镜号：按 position 整场顺排（01、02…）。旧号入痕迹；无变化则返回空表。"""
    rows = con.execute(
        "SELECT id, shot_no FROM shots WHERE scene_id=? ORDER BY position, id",
        (scene_id,)).fetchall()
    changes = []
    for i, r in enumerate(rows, 1):
        new_no = str(i).zfill(2)
        if (r["shot_no"] or "") != new_no:
            con.execute(
                "UPDATE shots SET shot_no=?, updated_at=datetime('now','localtime') WHERE id=?",
                (new_no, r["id"]))
            record_history(con, scene_id, "shots", r["id"], field="shot_no",
                           old_value=r["shot_no"], new_value=new_no, source="system")
            changes.append({"id": r["id"], "old": r["shot_no"], "new": new_no})
    con.commit()
    return changes


def _scene_payload(con, scene_id):
    """场次完整载荷：{scene, beats, shots, groups}（锁底/删场撤销共用单点）——P0·S1-W4。"""
    return {
        "scene": dict(_row_or_raise(con, "scenes", scene_id, "场景")),
        "beats": [dict(b) for b in _scene_beats(con, scene_id)],
        "shots": [dict(s) for s in _scene_shots(con, scene_id)],
        "groups": [dict(g) for g in con.execute(
            "SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,))],
    }


def create_scene(con, film_id=None):
    """在影片末尾追加空场（场号自动）。film_id 给定 → 限定工程（M8 工程库）。"""
    f = db.film(con, film_id)
    if not f:
        raise ValueError("还没有影片")
    scenes = list(con.execute("SELECT * FROM scenes WHERE film_id=? ORDER BY position, id", (f["id"],)))
    no = _next_scene_no(con)
    cur = con.execute(
        "INSERT INTO scenes (film_id, position, scene_no, title) VALUES (?,?,?,?)",
        (f["id"], len(scenes), no, "新场"))
    new_id = cur.lastrowid
    record_history(con, new_id, "scenes", new_id, field="create", old_value=None, new_value=no)
    con.commit()
    return dict(con.execute("SELECT * FROM scenes WHERE id=?", (new_id,)).fetchone())


def move_scene(con, scene_id, index):
    """场次排序：重排 scenes.position（index 基于去掉自身后的场序）。"""
    sc = _row_or_raise(con, "scenes", scene_id, "场景")
    scenes = list(con.execute("SELECT * FROM scenes WHERE film_id=? ORDER BY position, id", (sc["film_id"],)))
    others = [s for s in scenes if s["id"] != scene_id]
    idx = max(0, min(int(index), len(others)))
    new_order = others[:idx] + [sc] + others[idx:]
    if [s["id"] for s in new_order] == [s["id"] for s in scenes]:
        return {"changed": False, "id": scene_id}
    old_i = [s["id"] for s in scenes].index(scene_id)
    reseq(con, "scenes", [s["id"] for s in new_order])
    record_history(con, scene_id, "scenes", scene_id, field="drag", old_value="#%s" % old_i, new_value="#%s" % idx)
    con.commit()
    return {"changed": True, "id": scene_id, "index": idx, "old_index": old_i}


def duplicate_scene(con, scene_id):
    """场次深拷：场 + 节拍 + 镜头 + 提示词组；新场紧跟源场；场号自动；镜号原样（新场不冲突）。"""
    src = _row_or_raise(con, "scenes", scene_id, "场景")
    film_id = src["film_id"]
    new_no = _next_scene_no(con)
    _make_room(con, "scenes", "film_id", film_id, src["position"], after=True)
    scols = _table_cols(con, "scenes")
    bcols = _table_cols(con, "beats")
    gcols = _table_cols(con, "prompt_groups")
    skeys = [k for k in src.keys() if k in scols and k not in ("id", "position", "scene_no", "locked", "film_id")]
    new_sid = _copy_row(con, "scenes", src,
                        {"film_id": film_id, "position": src["position"] + 1, "scene_no": new_no, "locked": 0},
                        skeys)
    bmap = {}
    for b in _scene_beats(con, scene_id):
        bkeys = [k for k in b.keys() if k in bcols and k not in ("id", "scene_id")]
        bmap[b["id"]] = _copy_row(con, "beats", b, {"scene_id": new_sid}, bkeys)
    gmap = {}
    for g in con.execute("SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,)):
        gkeys = [k for k in g.keys() if k in gcols and k not in ("id", "scene_id")]
        gmap[g["id"]] = _copy_row(con, "prompt_groups", g, {"scene_id": new_sid}, gkeys)
    s2 = _scene_shots(con, scene_id)
    for shot in s2:
        bid = bmap.get(shot["beat_id"]) if shot["beat_id"] is not None else None
        gid = gmap.get(shot["prompt_group_id"]) if shot["prompt_group_id"] is not None else None
        _copy_row(con, "shots", shot,
                  {"scene_id": new_sid, "beat_id": bid, "position": shot["position"],
                   "shot_no": shot["shot_no"], "prompt_group_id": gid},
                  COPY_COLS)
    nbeats = len(bmap)
    record_history(con, new_sid, "scenes", new_sid, field="create", old_value=src["scene_no"],
                   new_value="%s（%d 节拍 / %d 镜）" % (new_no, nbeats, len(s2)))
    con.commit()
    return {"id": new_sid, "scene_no": new_no, "beats": nbeats, "shots": len(s2)}


def delete_scene(con, scene_id):
    """删场：整场级联（节拍/镜头/提示词组随删）；返回全量快照供撤销。"""
    sc = _row_or_raise(con, "scenes", scene_id, "场景")
    film_id = sc["film_id"]
    payload = _scene_payload(con, scene_id)
    con.execute("DELETE FROM scenes WHERE id=?", (scene_id,))
    _reseq_survivors(con, "scenes", "film_id", film_id)
    record_history(con, scene_id, "scenes", scene_id, field="delete", old_value=sc["scene_no"], new_value=None)
    con.commit()
    return payload


def lock_scene(con, scene_id, lock=True, snap_root=None):
    """锁定本场（M2-7）：留底 = 场次版本快照（JSON 落盘 + snapshots 记录）+ 锁定标记。
    锁定 ≠ 禁止编辑（设计稿 §128）；解锁只清标记，不动已留底文件。"""
    sc = _row_or_raise(con, "scenes", scene_id, "场景")
    snap = None
    if lock:
        payload = {"saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                   **_scene_payload(con, scene_id)}
        root = Path(snap_root) if snap_root else paths.SNAP_SCENES_DIR
        root.mkdir(parents=True, exist_ok=True)
        fname = "%s-%s.json" % (sc["scene_no"] or ("scene%d" % scene_id),
                                datetime.now().strftime("%Y%m%d-%H%M%S"))
        fpath = root / fname
        fsutil.dump_json(fpath, payload)   # 原子写单点（P1·S4-P5）
        rel = str(fpath.relative_to(paths.ROOT))   # 恒仓库相对（snap_root 只决定文件落哪）——P0·S1-W15
        con.execute("INSERT INTO snapshots (scope, kind, label, path) VALUES ('scene','locked',?,?)",
                    (sc["scene_no"], rel))
        snap = {"path": rel, "at": payload["saved_at"]}
    con.execute("UPDATE scenes SET locked=? WHERE id=?", (1 if lock else 0, scene_id))
    record_history(con, scene_id, "scenes", scene_id, field="locked",
                   old_value="1" if sc["locked"] else "0", new_value="1" if lock else "0")
    con.commit()
    return {"scene": dict(con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()),
            "snapshot": snap}
