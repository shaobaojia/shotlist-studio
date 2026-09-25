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

from core import db, fsutil, paths
from .structure import _copy_row, _scene_shots, _table_cols
from .numbering import _max_num
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


def _film_row(con, film_id):
    return _row_or_raise(con, "films", film_id, "工程")


def _film_out(con, film_id):
    return dict(con.execute("SELECT * FROM films WHERE id=?", (film_id,)).fetchone())


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
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
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
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        con.execute("UPDATE films SET title=?, updated_at=? WHERE id=?", (t, now, film_id))
        record_history(con, None, "films", film_id, field="title", old_value=f["title"], new_value=t)
        con.commit()
    return {"film": _film_out(con, film_id), "changed": changed}


def archive_film(con, film_id, archived=True):
    """归档/取消归档（archived 0/1）。写痕迹 + 更 updated_at。"""
    f = _film_row(con, film_id)
    arch = 1 if archived else 0
    if arch != f["archived"]:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        con.execute("UPDATE films SET archived=?, updated_at=? WHERE id=?", (arch, now, film_id))
        record_history(con, None, "films", film_id, field="archived",
                       old_value=str(f["archived"]), new_value=str(arch))
        con.commit()
    return {"film": _film_out(con, film_id)}


def _safe_name(title):
    """留底文件名安全化：非法字符与空白归一为 -，长度截断；空回退 'film'。"""
    s = re.sub(r'[\\/:*?"<>|\s]+', "-", title).strip("-")
    s = s[:_SNAP_NAME_MAX].strip("-")
    return s or "film"


def _film_payload(con, film_id):
    """整片载荷（留底/未来导入通用）：film + scenes（逐场带 beats/shots/prompt_groups）。"""
    f = dict(_film_row(con, film_id))      # Row → dict（dump_json 序列化要求）
    scenes = []
    for sc in db.scenes(con, film_id):
        sc = dict(sc)
        sc.pop("shot_count", None)      # 统计列不入留底（db.scenes 投影）
        sc.pop("beat_count", None)
        sc["beats"] = db.beats(con, sc["id"])
        sc["shots"] = db.shots(con, sc["id"])
        sc["prompt_groups"] = db.prompt_groups(con, sc["id"])
        scenes.append(sc)
    return {"film": f, "scenes": scenes}


def delete_film(con, film_id, snap_root=None):
    """删除工程（级联）：删前整片 JSON 留底（fsutil 原子写）+ snapshots 记录；写痕迹后 DELETE 级联。
    snap_root 仅测试注入（路径列恒仓库相对，同 lock_scene 口径）。返回 {film, snapshot:{path,at}}。"""
    f = _film_row(con, film_id)
    now = datetime.now()
    root = Path(snap_root) if snap_root else paths.SNAP_FILMS_DIR
    root.mkdir(parents=True, exist_ok=True)
    fname = "%s-%s.json" % (_safe_name(f["title"]), now.strftime("%Y%m%d-%H%M%S"))
    fpath = root / fname
    fsutil.dump_json(fpath, {"saved_at": now.strftime("%Y-%m-%d %H:%M:%S"), **_film_payload(con, film_id)})
    rel = str(fpath.relative_to(paths.ROOT))    # 恒仓库相对（P0·S1-W15 口径）
    con.execute("INSERT INTO snapshots (scope, kind, label, path) VALUES ('film','manual',?,?)",
                (f["title"], rel))
    record_history(con, None, "films", film_id, field="delete", old_value=f["title"], new_value="")
    con.execute("DELETE FROM films WHERE id=?", (film_id,))
    con.commit()
    return {"film": dict(f),
            "snapshot": {"path": rel, "at": now.strftime("%Y-%m-%d %H:%M:%S")}}


def paste_shots(con, src_ids, target_scene_id):
    """跨工程/跨场粘贴（M8 刀B）：把源镜头深拷到目标场表尾（未归节拍·无组；编号数字顺延）。
    素材不限工程（同库 id 寻址）；逐行痕迹；一次事务。返回新行列表（含新 id/编号）。"""
    _row_or_raise(con, "scenes", target_scene_id, "场景")
    rows = []
    for sid in src_ids:
        r = con.execute("SELECT * FROM shots WHERE id=?", (sid,)).fetchone()
        if not r:
            raise ValueError("源镜头不存在：%s" % sid)
        rows.append(r)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cols = _table_cols(con, "shots") - {"id"}
    existing = _scene_shots(con, target_scene_id)
    mx = _max_num(existing, "shot_no")
    out = []
    for i, r in enumerate(rows):
        no = "%02d" % (mx + 1 + i)          # 追加顺延（同 create_blank_shot 口径）
        new_id = _copy_row(con, "shots", r, {
            "scene_id": target_scene_id, "beat_id": None, "prompt_group_id": None,
            "shot_no": no, "position": len(existing) + i, "created_at": now, "updated_at": now}, cols)
        record_history(con, target_scene_id, "shots", new_id, field="create",
                       old_value=None, new_value=no)
        out.append(dict(con.execute("SELECT * FROM shots WHERE id=?", (new_id,)).fetchone()))
    con.commit()
    return out

