"""领域操作（写路径的唯一实现）：字段更新 / 整理镜号 / 痕迹 / 每日快照。
逻辑为主、可单测（tests/test_ops.py）。改动维护：写白名单从 fields.py 派生，不另写一份。"""
import shutil
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


def update_field(con, table, row_id, field, value, source="manual"):
    """更新单字段：白名单校验 → 写行 → 记痕迹。返回 (row, changed)。"""
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
    con.commit()
    fresh = con.execute("SELECT * FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    return dict(fresh), True


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


def history_of(con, scene_id=None, limit=100):
    q = "SELECT * FROM history"
    args = []
    if scene_id:
        q += " WHERE scene_id=?"
        args.append(scene_id)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    return [dict(r) for r in con.execute(q, args)]
