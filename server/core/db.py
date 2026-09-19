"""数据层：只读 SQLite 连接与查询（schema v1）。服务只读打开，写操作走独立脚本。"""
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "studio.db"


def connect(db_path=None):
    p = Path(db_path) if db_path else DB_PATH
    con = sqlite3.connect("file:%s?mode=ro" % p, uri=True)
    con.row_factory = sqlite3.Row
    return con


def _dicts(rows):
    return [dict(r) for r in rows]


def film(con):
    rows = _dicts(con.execute("SELECT * FROM films ORDER BY id LIMIT 1"))
    return rows[0] if rows else None


def scenes(con, film_id):
    return _dicts(con.execute(
        "SELECT sc.*,"
        " (SELECT COUNT(*) FROM shots s WHERE s.scene_id=sc.id) AS shot_count,"
        " (SELECT COUNT(*) FROM beats b WHERE b.scene_id=sc.id) AS beat_count"
        " FROM scenes sc WHERE sc.film_id=? ORDER BY sc.position", (film_id,)))


def scene_by_no(con, film_id, scene_no):
    rows = _dicts(con.execute(
        "SELECT * FROM scenes WHERE film_id=? AND scene_no=?", (film_id, scene_no)))
    return rows[0] if rows else None


def beats(con, scene_id):
    return _dicts(con.execute(
        "SELECT * FROM beats WHERE scene_id=? ORDER BY position", (scene_id,)))


def shots(con, scene_id):
    return _dicts(con.execute(
        "SELECT * FROM shots WHERE scene_id=? ORDER BY position", (scene_id,)))


def prompt_groups(con, scene_id):
    return _dicts(con.execute(
        "SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position", (scene_id,)))
