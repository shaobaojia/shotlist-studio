# -*- coding: utf-8 -*-
"""工程（films）域操作（工程库 · M8）：列表 / 新建（空白·复制深拷）/ 重命名 / 归档 / 删除（留底兜底）。

纪律：痕迹经 record_history 单点；本模块不开连接（在调用方连接内完成）。
删除留底 = 整片 JSON（fsutil 原子写）+ snapshots 记录（scope='film', kind='manual'）；
级联依赖连接层 PRAGMA foreign_keys=ON（scenes→beats/shots/prompt_groups 全链，M8 核查）。
"""
import json
import re
from datetime import datetime
from pathlib import Path

from core import db, paths
from . import snapshot_io
from .structure import _copy_row, _scene_shots, _table_cols
from .numbering import _max_num, follow_no
from .scenes import _scene_children
from .write import _row_or_raise, record_history

FILM_TITLE_MAX = 60
_SNAP_NAME_MAX = 20


def _clean_title(t):
    """工程名清洗（单点）：strip + 非空 + 长度上限。"""
    s = (t or "").strip()
    if not s:
        raise ValueError("工程名不能为空")
    if len(s) > FILM_TITLE_MAX:
        raise ValueError("工程名过长（上限 %d 字）" % FILM_TITLE_MAX)
    return s


def _now():
    """时间戳单点（本模块）。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _film_row(con, film_id):
    return _row_or_raise(con, "films", film_id, "工程")


def _film_out(con, film_id):
    """工程行 → dict（出参形状单点）。"""
    return dict(_film_row(con, film_id))


def _film_touch(con, f, field, old, new):
    """工程条件写单点（rename/archive 共用）：UPDATE films.field + updated_at；写痕迹；不 commit。"""
    con.execute("UPDATE films SET %s=?, updated_at=? WHERE id=?" % field, (new, _now(), f["id"]))
    record_history(con, None, "films", f["id"], field=field, old_value=old, new_value=new)


def list_films(con):
    """工程列表（含统计：场数/镜数/最近编辑；归档排后）。
    最近编辑＝该工程场内最近一条痕迹（无则回退 updated_at）。"""
    films = [dict(r) for r in con.execute("SELECT * FROM films ORDER BY archived, id")]
    for f in films:
        f["scene_count"] = con.execute(
            "SELECT COUNT(*) FROM scenes WHERE film_id=?", (f["id"],)).fetchone()[0]
        f["shot_count"] = con.execute(
            "SELECT COUNT(*) FROM shots s JOIN scenes sc ON s.scene_id=sc.id WHERE sc.film_id=?",
            (f["id"],)).fetchone()[0]
        f["last_edit"] = con.execute(
            "SELECT MAX(h.at) FROM history h JOIN scenes sc ON h.scene_id=sc.id WHERE sc.film_id=?",
            (f["id"],)).fetchone()[0] or f["updated_at"]
    return films


def _copy_children(con, src_fid, dst_fid, now):
    """深拷工程子链：场→（提示词组/节拍/镜），id 全重映射；时间戳刷新为 now。
    列集 = 表列 − id（PRAGMA 动态；未来加列自动随拷）；引用字段走 overrides 显式替换。"""
    sc_cols = _table_cols(con, "scenes") - {"id"}
    b_cols = _table_cols(con, "beats") - {"id"}
    s_cols = _table_cols(con, "shots") - {"id"}
    g_cols = _table_cols(con, "prompt_groups") - {"id"}
    src_scenes = con.execute(
        "SELECT * FROM scenes WHERE film_id=? ORDER BY position, id", (src_fid,)).fetchall()
    for sc in src_scenes:
        nsc = _copy_row(con, "scenes", sc,
                        {"film_id": dst_fid, "created_at": now, "updated_at": now}, sc_cols)
        gmap = {}
        for g in con.execute("SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (sc["id"],)):
            gmap[g["id"]] = _copy_row(con, "prompt_groups", g,
                                      {"scene_id": nsc, "created_at": now, "updated_at": now}, g_cols)
        bmap = {}
        for b in con.execute("SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (sc["id"],)):
            bmap[b["id"]] = _copy_row(con, "beats", b,
                                      {"scene_id": nsc, "created_at": now, "updated_at": now}, b_cols)
        for s in con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (sc["id"],)):
            _copy_row(con, "shots", s,
                      {"scene_id": nsc, "beat_id": bmap.get(s["beat_id"]),
                       "prompt_group_id": gmap.get(s["prompt_group_id"]),
                       "created_at": now, "updated_at": now}, s_cols)


def create_film(con, title, copy_from=None):
    """新建工程（空白或复制现有）。复制＝深拷场/节拍/镜/提示词组（不拷痕迹与审计）；blocks 全局共享。
    复制来源记 meta.copied_from*；痕迹 field=create/copy。返回新工程行（dict）。"""
    t = _clean_title(title)
    now = _now()
    src = _film_row(con, copy_from) if copy_from is not None else None
    meta = None
    if src:
        meta = json.dumps({"copied_from": src["id"], "copied_from_title": src["title"], "copied_at": now},
                          ensure_ascii=False)
    cur = con.execute(
        "INSERT INTO films (title, archived, meta, created_at, updated_at) VALUES (?,0,?,?,?)",
        (t, meta, now, now))
    fid = cur.lastrowid
    if src:
        _copy_children(con, src["id"], fid, now)
    record_history(con, None, "films", fid, field="copy" if src else "create",
                   old_value=src["title"] if src else "", new_value=t)
    con.commit()
    return _film_out(con, fid)


def rename_film(con, film_id, title):
    """重命名（同回 changed 语义）：写痕迹 + 更 updated_at。"""
    f = _film_row(con, film_id)
    t = _clean_title(title)
    changed = t != f["title"]
    if changed:
        _film_touch(con, f, "title", f["title"], t)
        con.commit()
    return {"film": _film_out(con, film_id), "changed": changed}


def archive_film(con, film_id, archived=True):
    """归档/取消归档（archived 0/1）。写痕迹 + 更 updated_at。"""
    f = _film_row(con, film_id)
    arch = 1 if archived else 0
    if arch != f["archived"]:
        _film_touch(con, f, "archived", str(f["archived"]), str(arch))
        con.commit()
    return {"film": _film_out(con, film_id)}


def _safe_name(title):
    """留底文件名安全化：非法字符与空白归一为 -，长度截断；空回退 'film'。"""
    s = re.sub(r'[\\/:*?"<>|\s]+', "-", title).strip("-")
    s = s[:_SNAP_NAME_MAX].strip("-")
    return s or "film"


def _film_payload(con, film_id):
    """整片载荷（留底/未来导入通用）：film + scenes（逐场带 beats/shots/prompt_groups）。
    场子树装载走 scenes._scene_children（与 _scene_payload 同单点）；键名保持 prompt_groups 形状。"""
    f = dict(_film_row(con, film_id))      # Row → dict（dump_json 序列化要求）
    scenes = []
    for sc in db.scenes(con, film_id):
        sc = dict(sc)
        sc.pop("shot_count", None)      # 统计列不入留底（db.scenes 投影）
        sc.pop("beat_count", None)
        ch = _scene_children(con, sc["id"])
        sc["beats"] = ch["beats"]
        sc["shots"] = ch["shots"]
        sc["prompt_groups"] = ch["groups"]
        scenes.append(sc)
    return {"film": f, "scenes": scenes}


def delete_film(con, film_id, snap_root=None):
    """删除工程（级联）：删前整片 JSON 留底 + snapshots 记录（snapshot_io 单点）；写痕迹后 DELETE 级联。
    snap_root 仅测试注入（路径列恒仓库相对，同 lock_scene 口径）。返回 {film, snapshot:{path,at}}。"""
    f = _film_row(con, film_id)
    root = Path(snap_root) if snap_root else paths.SNAP_FILMS_DIR
    name_base = "%s-f%d" % (_safe_name(f["title"]), film_id)    # 名尾补 id：防同秒同名互盖（M8 清理刀）
    snap = snapshot_io.write_snapshot(con, root, name_base, _film_payload(con, film_id),
                                      "film", "manual", f["title"])
    record_history(con, None, "films", film_id, field="delete", old_value=f["title"], new_value="")
    con.execute("DELETE FROM films WHERE id=?", (film_id,))
    con.commit()
    return {"film": dict(f), "snapshot": snap}


def paste_shots(con, src_ids, target_scene_id):
    """跨工程/跨场粘贴（M8 刀B）：把源镜头深拷到目标场表尾（未归节拍·无组；编号数字顺延）。
    素材不限工程（同库 id 寻址）；源 id 去重保序；逐行痕迹；一次事务。返回 {count, shot_nos}（瘦身：全行载荷前端不用）。"""
    _row_or_raise(con, "scenes", target_scene_id, "场景")
    want = []
    for sid in src_ids:
        if sid not in want:
            want.append(sid)
    rows = []
    for sid in want:
        r = con.execute("SELECT * FROM shots WHERE id=?", (sid,)).fetchone()
        if not r:
            raise ValueError("源镜头不存在：%s" % sid)
        rows.append(r)
    now = _now()
    cols = _table_cols(con, "shots") - {"id"}
    existing = _scene_shots(con, target_scene_id)
    mx = _max_num(existing, "shot_no")
    pos0 = max([s["position"] for s in existing]) + 1 if existing else 0    # max+1 续尾（同 append_shots 口径）
    nos = []
    for i, r in enumerate(rows):
        no = follow_no(mx, i, 2)
        new_id = _copy_row(con, "shots", r, {
            "scene_id": target_scene_id, "beat_id": None, "prompt_group_id": None,
            "shot_no": no, "position": pos0 + i, "created_at": now, "updated_at": now}, cols)
        record_history(con, target_scene_id, "shots", new_id, field="create",
                       old_value=None, new_value=no)
        nos.append(no)
    con.commit()
    return {"count": len(nos), "shot_nos": nos}

