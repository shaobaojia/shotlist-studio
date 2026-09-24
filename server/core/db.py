"""数据层：SQLite 连接与查询（schema v1）。默认只读；写操作经 rw=True（配套 core/ops.py）。"""
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "studio.db"


def connect(db_path=None, rw=False):
    """默认只读（GET 路径）；rw=True 给写路径（M2 编辑），开外键约束。
    写连接统一先过每日快照（写保护下沉到写边界，脚本/新写者天然覆盖）。"""
    p = Path(db_path) if db_path else DB_PATH
    if rw:
        if not p.exists():
            raise FileNotFoundError("数据库不存在：%s" % p)
        from core import ops  # 延迟导入：ops 顶层 import db，避免循环
        ops.ensure_daily_snapshot(db_path=str(p))
        con = sqlite3.connect(str(p), timeout=10)
        con.execute("PRAGMA foreign_keys=ON")
    else:
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
        "SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def shots(con, scene_id):
    return _dicts(con.execute(
        "SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def prompt_groups(con, scene_id):
    return _dicts(con.execute(
        "SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def beat_kinds(con):
    """节拍类型值域（去重去空；读库单点——接口层 DISTINCT 下沉）——P0·S1-W12。"""
    return [r["kind"] for r in con.execute(
        "SELECT DISTINCT kind FROM beats WHERE kind IS NOT NULL AND kind<>'' ORDER BY kind")]


def attach_group_members(groups, shots):
    """把镜头按 prompt_group_id 挂到组上（单趟分桶）：原地补 member_shots / member_ids。
    纯命令（无返回值）；传入的 groups 与 shots 均须已按 (position, id) 排序（本模块各查询保证）——P0·S1-W13。"""
    buckets = {}
    for s in shots:
        buckets.setdefault(s["prompt_group_id"], []).append(s)
    for g in groups:
        mem = buckets.get(g["id"], [])
        g["member_shots"] = [s["shot_no"] for s in mem]
        g["member_ids"] = [s["id"] for s in mem]


def scene_ctx(con, scene_id, cols=None):
    """整场装载（单点）：(场行 dict, beats, shots)，均位置序；场不存在 → None——P0·S1-W1。
    cols：shots 列投影（None = 全列）——P0·S2-W13。"""
    sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if not sc:
        return None
    scols = ", ".join(cols) if cols else "*"
    return (dict(sc),
            _dicts(con.execute("SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,))),
            _dicts(con.execute("SELECT %s FROM shots WHERE scene_id=? ORDER BY position, id" % scols, (scene_id,))))
