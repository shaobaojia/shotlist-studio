"""领域操作（写路径的唯一实现）：字段更新 / 批量更新 / 整理镜号 / 痕迹 / 每日快照。
逻辑为主、可单测（tests/test_ops.py）。改动维护：写白名单从 fields.py 派生，不另写一份。"""
import re
import shutil
import string
from datetime import date
from pathlib import Path

from core import db, fields

TABLES = {
    "shots":  {"spec": fields.SHOT_FIELDS,  "skip_types": {"prompt"}},
    "beats":  {"spec": fields.BEAT_FIELDS,  "skip_types": set()},
    "scenes": {"spec": fields.SCENE_FIELDS, "skip_types": set()},
}


def write_keys(table):
    """该表允许直改的字段白名单（prompt 为虚拟列，position/id/时间戳不在清单）。"""
    t = TABLES.get(table)
    if not t:
        return []
    return [f["key"] for f in t["spec"] if f["type"] not in t["skip_types"]]


def _scene_of(con, table, row_id):
    if table == "scenes":
        return row_id
    row = con.execute("SELECT scene_id FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    return row["scene_id"] if row else None


def ensure_daily_snapshot(db_path=None, snap_root=None):
    """每日快照：当天首次写操作前整库拷贝一份（幂等，已存在则跳过）。"""
    src = Path(db_path) if db_path else db.DB_PATH
    root = Path(snap_root) if snap_root else src.parent / "snapshots" / "daily"
    if not src.exists():
        return None
    dest = root / ("studio-%s.db" % date.today().strftime("%Y%m%d"))
    if dest.exists():
        return None
    root.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dest)
    return str(dest)


def _apply_field(con, table, row_id, field, value, source="manual"):
    """单字段更新（不 commit）：白名单校验 → 写行 → 记痕迹。返回 (row, changed)。"""
    if field not in write_keys(table):
        raise ValueError("字段不可写：%s.%s" % (table, field))
    row = con.execute("SELECT * FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    if not row:
        raise ValueError("行不存在：%s #%s" % (table, row_id))
    old = row[field]
    if (old if old is not None else "") == (value if value is not None else ""):
        return dict(row), False
    con.execute(
        "UPDATE %s SET %s=?, updated_at=datetime('now','localtime') WHERE id=?" % (table, field),
        (value, row_id))
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (_scene_of(con, table, row_id), table, row_id, field, old, value, source))
    fresh = con.execute("SELECT * FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    return dict(fresh), True


def update_field(con, table, row_id, field, value, source="manual"):
    """更新单字段并提交。返回 (row, changed)。"""
    row, changed = _apply_field(con, table, row_id, field, value, source)
    con.commit()
    return row, changed


def batch_update(con, items, source="manual"):
    """批量单字段更新（一个连接、最后一次性 commit）：items=[{table,id,field,value}]。
    逐项白名单校验；单项失败只记 error、不中断其余。返回 {changed, results}。"""
    results = []
    changed = 0
    for it in items:
        it = it or {}
        table = it.get("table")
        rid = it.get("id")
        field = it.get("field")
        value = it.get("value")
        try:
            if not isinstance(rid, int) or not field:
                raise ValueError("参数不完整")
            _row, did = _apply_field(con, table, rid, field, "" if value is None else str(value), source)
            results.append({"table": table, "id": rid, "field": field, "changed": did})
            if did:
                changed += 1
        except ValueError as e:
            results.append({"table": table, "id": rid, "field": field, "error": str(e)})
    con.commit()
    return {"changed": changed, "results": results}


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
            con.execute(
                "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
                " VALUES (?,?,?,?,?,?,?)",
                (scene_id, "shots", r["id"], "shot_no", r["shot_no"], new_no, "system"))
            changes.append({"id": r["id"], "old": r["shot_no"], "new": new_no})
    con.commit()
    return changes


def _scene_beats(con, scene_id):
    return list(con.execute("SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def _scene_shots(con, scene_id):
    return list(con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def move_shot(con, shot_id, target_beat_id, index):
    """拖动落库：把镜头搬到目标节拍第 index 位（index 基于去掉自身后的目标序）。
    重排全场 position（0 基、致密）；镜号不动（整理是独立按钮的事）。"""
    shot = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
    if not shot:
        raise ValueError("镜头不存在：%s" % shot_id)
    scene_id = shot["scene_id"]
    beats = _scene_beats(con, scene_id)
    tgt = next((b for b in beats if b["id"] == target_beat_id), None)
    if not tgt:
        raise ValueError("目标节拍不存在或不属于本场")
    rows = [r for r in _scene_shots(con, scene_id) if r["id"] != shot_id]
    tgt_ids = [r["id"] for r in rows if r["beat_id"] == target_beat_id]
    idx = max(0, min(int(index), len(tgt_ids)))
    if tgt_ids:
        anchor = next(r for r in rows if r["id"] == (tgt_ids[idx] if idx < len(tgt_ids) else tgt_ids[-1]))
        pos = rows.index(anchor) + (0 if idx < len(tgt_ids) else 1)
    else:
        bi = beats.index(tgt)
        prev_ids = {b["id"] for b in beats[:bi]}
        pos = 0
        for i, r in enumerate(rows):
            if r["beat_id"] in prev_ids:
                pos = i + 1
    order = rows[:pos] + [shot] + rows[pos:]
    before = [r["id"] for r in _scene_shots(con, scene_id)]
    if [r["id"] for r in order] == before and shot["beat_id"] == target_beat_id:
        return {"changed": False, "id": shot_id}
    old_beat_no = next((b["beat_no"] for b in beats if b["id"] == shot["beat_id"]), "?")
    for i, r in enumerate(order):
        if r["id"] == shot_id:
            con.execute("UPDATE shots SET position=?, beat_id=?, updated_at=datetime('now','localtime') WHERE id=?",
                        (i, target_beat_id, shot_id))
        elif r["position"] != i:
            con.execute("UPDATE shots SET position=? WHERE id=?", (i, r["id"]))
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "shots", shot_id, "drag", "beat%s#%s" % (old_beat_no, shot["position"]),
         "beat%s#%s" % (tgt["beat_no"], idx), "manual"))
    con.commit()
    return {"changed": True, "id": shot_id, "beat_id": target_beat_id, "index": idx,
            "old_beat_id": shot["beat_id"], "old_index": shot["position"]}


def move_beat(con, beat_id, index):
    """节拍整体拖动：重排 beats.position（index 基于去掉自身后的节拍序），
    镜头 position 跟随节拍顺序重排（节拍内相对顺序不变）。"""
    beat = con.execute("SELECT * FROM beats WHERE id=?", (beat_id,)).fetchone()
    if not beat:
        raise ValueError("节拍不存在：%s" % beat_id)
    scene_id = beat["scene_id"]
    beats = _scene_beats(con, scene_id)
    others = [b for b in beats if b["id"] != beat_id]
    idx = max(0, min(int(index), len(others)))
    new_beats = others[:idx] + [beat] + others[idx:]
    if [b["id"] for b in new_beats] == [b["id"] for b in beats]:
        return {"changed": False, "id": beat_id}
    for i, b in enumerate(new_beats):
        if b["position"] != i:
            con.execute("UPDATE beats SET position=?, updated_at=datetime('now','localtime') WHERE id=?",
                        (i, b["id"]))
    shots = _scene_shots(con, scene_id)
    by_beat = {}
    for r in shots:
        by_beat.setdefault(r["beat_id"], []).append(r)
    flat = []
    for b in new_beats:
        flat.extend(by_beat.get(b["id"], []))
    known = {b["id"] for b in new_beats}
    flat.extend(r for r in shots if r["beat_id"] not in known)
    for i, r in enumerate(flat):
        if r["position"] != i:
            con.execute("UPDATE shots SET position=? WHERE id=?", (i, r["id"]))
    old_i = [b["id"] for b in beats].index(beat_id)
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "beats", beat_id, "drag", "#%s" % old_i, "#%s" % idx, "manual"))
    con.commit()
    return {"changed": True, "id": beat_id, "index": idx, "old_index": old_i}


COPY_COLS = ("camera_move", "spatial", "shot_size", "focal", "dof", "camera_pos",
             "blocking", "dialogue", "duration", "audio", "director_note", "shot_fn", "pov")


def _next_shot_no(con, scene_id, src_no):
    """副本镜号：数字基 + 首个空闲字母后缀（05→05A、17A→17B；A-Z 占满后 AA、AB…）。"""
    m = re.match(r"^(\d+)([A-Za-z]*)$", (src_no or "").strip())
    num = m.group(1) if m else (src_no or "").strip()
    taken = {(r["shot_no"] or "").strip().upper() for r in
             con.execute("SELECT shot_no FROM shots WHERE scene_id=?", (scene_id,))}
    sufs = list(string.ascii_uppercase)
    sufs += [a + b for a in string.ascii_uppercase for b in string.ascii_uppercase]
    for suf in sufs:
        cand = num + suf
        if cand.upper() not in taken:
            return cand
    return num + "A*"  # 理论不可达


def duplicate_shot(con, shot_id):
    """创建行副本：源行后插入（同场同节拍）；13 个内容列全拷（不含 id/position/shot_no/提示词归属）。
    镜号取字母后缀；位置致密后移；留一条 create 痕迹。返回新行 dict。"""
    src = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
    if not src:
        raise ValueError("镜头不存在：%s" % shot_id)
    scene_id = src["scene_id"]
    new_no = _next_shot_no(con, scene_id, src["shot_no"])
    pos = int(src["position"]) + 1
    con.execute("UPDATE shots SET position=position+1 WHERE scene_id=? AND position>=?",
                (scene_id, pos))
    cols = ", ".join(COPY_COLS)
    qs = ", ".join(["?"] * len(COPY_COLS))
    cur = con.execute(
        "INSERT INTO shots (scene_id, beat_id, position, shot_no, %s) VALUES (?,?,?,?,%s)"
        % (cols, qs),
        [scene_id, src["beat_id"], pos, new_no] + [src[c] for c in COPY_COLS])
    new_id = cur.lastrowid
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "shots", new_id, "create", src["shot_no"], new_no, "manual"))
    con.commit()
    return dict(con.execute("SELECT * FROM shots WHERE id=?", (new_id,)).fetchone())


def delete_shot(con, shot_id):
    """删除镜头行（当前用途：撤销「创建行副本」）；位置致密；留一条 delete 痕迹。"""
    row = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
    if not row:
        raise ValueError("镜头不存在：%s" % shot_id)
    scene_id = row["scene_id"]
    con.execute("DELETE FROM shots WHERE id=?", (shot_id,))
    con.execute("UPDATE shots SET position=position-1 WHERE scene_id=? AND position>?",
                (scene_id, row["position"]))
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "shots", shot_id, "delete", row["shot_no"], None, "manual"))
    con.commit()
    return {"id": shot_id, "shot_no": row["shot_no"]}


def history_of(con, scene_id=None, limit=100):
    q = "SELECT * FROM history"
    args = []
    if scene_id:
        q += " WHERE scene_id=?"
        args.append(scene_id)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    return [dict(r) for r in con.execute(q, args)]
