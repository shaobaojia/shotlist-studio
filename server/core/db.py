"""数据层：SQLite 连接（schema v1）。连接器只做连接——只读 open_ro / 写入口 open_rw
（写前每日快照下沉至写边界；S1-L4）。"""
import contextlib
import sqlite3
from pathlib import Path

from core import paths
from core.snapshot import ensure_daily_snapshot

ROOT = paths.ROOT        # 兼容保留（旧引用面）
DB_PATH = paths.DB_PATH


def open_ro(db_path=None):
    """只读连接（显式入口 · S1-L4）：库缺失 → FileNotFoundError（与 open_rw 同型）。"""
    p = Path(db_path) if db_path else DB_PATH
    if not p.exists():
        raise FileNotFoundError("数据库不存在：%s" % p)
    con = sqlite3.connect("file:%s?mode=ro" % p, uri=True)
    con.row_factory = sqlite3.Row
    return con


def open_rw(db_path=None):
    """写连接（显式入口 · S1-L4）：写前每日快照（写边界语义，幂等）+ 外键约束。"""
    p = Path(db_path) if db_path else DB_PATH
    if not p.exists():
        raise FileNotFoundError("数据库不存在：%s" % p)
    ensure_daily_snapshot(db_path=str(p))
    con = sqlite3.connect(str(p), timeout=10)
    con.execute("PRAGMA foreign_keys=ON")
    con.row_factory = sqlite3.Row
    return con


@contextlib.contextmanager
def conn_ro(db_path=None):
    """只读连接（with 版 · S1-L2）：出 with 自动 close。"""
    con = open_ro(db_path)
    try:
        yield con
    finally:
        con.close()


@contextlib.contextmanager
def conn_rw(db_path=None):
    """写连接（with 版 · S1-L2）：出 with 自动 close。"""
    con = open_rw(db_path)
    try:
        yield con
    finally:
        con.close()


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


_RESOLVE_CACHE = {}     # base → resolve 结果（P0·S3-W31：每请求常量不重算）


def resolved_base(base):
    """base 的 resolve 缓存（P0·S3-W31）。"""
    k = str(base)
    if k not in _RESOLVE_CACHE:
        _RESOLVE_CACHE[k] = Path(base).resolve()
    return _RESOLVE_CACHE[k]


def safe_join(base, *parts):
    """解析并校验路径仍在 base 内（单点，P0·S3-W32）：resolve + is_relative_to；越界 raise ValueError。"""
    b = resolved_base(base)
    p = b.joinpath(*parts).resolve()
    if not p.is_relative_to(b):
        raise ValueError("非法路径")
    return p


def qmarks(n):
    """占位串：n 个「?」逗号相连（单点，P0·S3-W7）。"""
    return ",".join("?" * n)


def row(con, table, row_id, msg="行不存在"):
    """取行否则 raise（单点，P0·S3-W8）：文案可定制（场景/镜头/节拍/块）。"""
    r = con.execute("SELECT * FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    if not r:
        raise ValueError(msg)
    return dict(r)


def attach_shots_by_beat(beats, shots):
    """镜头按 beat_id 分桶挂到 beats（单点，P2·S4-A9）：返回未归节拍行。
    含残留键兜底（P1·S4-B4 同口径）：beat_id 指向别场/悬空时不静默丢镜。"""
    by_beat = {}
    for s in shots:
        by_beat.setdefault(s.get("beat_id"), []).append(s)
    for b in beats:
        b["shots"] = by_beat.pop(b["id"], [])
    orphan = by_beat.pop(None, [])
    orphan += [s for mem in by_beat.values() for s in mem]
    return orphan


def group_members(con, group_ids):
    """组成员（多组）：{gid: [行]}，组内按 (position, id)——P0·S3-W2 单点。"""
    out = {gid: [] for gid in group_ids}
    group_ids = [g for g in group_ids if g is not None]
    if not group_ids:
        return out
    q = qmarks(len(group_ids))
    for r in con.execute(
            "SELECT * FROM shots WHERE prompt_group_id IN (%s)"
            " ORDER BY prompt_group_id, position, id" % q, group_ids):
        out.setdefault(r["prompt_group_id"], []).append(dict(r))
    return out


def load_scene(con, scene_no):
    """按场号装载（单点，P1·S4-A8）：返回 (film, scene)；影片缺或场缺时对应项为 None。"""
    f = film(con)
    if not f:
        return None, None
    return f, scene_by_no(con, f["id"], scene_no)


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
