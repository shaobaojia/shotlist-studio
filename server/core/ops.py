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

# ── M2-6 结构操作：三层（场次/节拍/镜头）增删插复移 + 完整还原 ──

def _table_cols(con, name):
    """表列名集合（还原白名单用，防注入列名）。"""
    return {r[1] for r in con.execute("PRAGMA table_info(%s)" % name)}


def _insert_restore(con, table, row, replace=None):
    """还原回插（撤销专用）：优先带原 id——撤销栈里更早的闭包都按原 id 记的，id 稳定才不悬空；
    id 已被占用时退回自增。replace 覆盖指定列（position / scene_id 等）。"""
    cols_all = _table_cols(con, table)
    rep = replace or {}
    d = {k: rep.get(k, row.get(k)) for k in row.keys() if k in cols_all}
    if d.get("id") is not None:
        occupied = con.execute("SELECT 1 FROM %s WHERE id=?" % table, (d["id"],)).fetchone()
        if occupied is not None:
            d.pop("id", None)
    cols = list(d.keys())
    vals = [d[k] for k in cols]
    cur = con.execute(
        "INSERT INTO %s (%s) VALUES (%s)" % (table, ", ".join(cols), ", ".join(["?"] * len(cols))),
        vals)
    return cur.lastrowid


def _next_scene_no(con):
    """下一个场号：最大数字 +10，步进风格 sNNN（s010→s090；冲突顺延）。"""
    mx = 0
    for r in con.execute("SELECT scene_no FROM scenes"):
        m = re.match(r"^s(\d+)$", (r["scene_no"] or "").strip())
        if m:
            mx = max(mx, int(m.group(1)))
    n = (mx + 10) if mx else 10
    taken = {(r["scene_no"] or "") for r in con.execute("SELECT scene_no FROM scenes")}
    while ("s%03d" % n) in taken:
        n += 10
    return "s%03d" % n


def _next_beat_no(con, scene_id, base):
    """节拍副本编号：数字基 + 首个空闲字母（1→1A；A-Z 占满后 AA…）。"""
    taken = {(r["beat_no"] or "").strip() for r in
             con.execute("SELECT beat_no FROM beats WHERE scene_id=?", (scene_id,))}
    m = re.match(r"^(\d+)([A-Za-z]*)$", (base or "").strip())
    root = m.group(1) if m else (base or "").strip()
    sufs = list(string.ascii_uppercase)
    sufs += [a + b for a in string.ascii_uppercase for b in string.ascii_uppercase]
    for suf in sufs:
        cand = root + suf
        if cand not in taken:
            return cand
    return root + "A*"


def create_blank_shot(con, scene_id, beat_id, index):
    """插入空行：index=0 基场序位。编号：追加（末尾）=数字顺延；中插=前邻字母后缀。"""
    sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if not sc:
        raise ValueError("场景不存在：%s" % scene_id)
    if beat_id is not None:
        b = con.execute("SELECT * FROM beats WHERE id=?", (beat_id,)).fetchone()
        if not b or b["scene_id"] != scene_id:
            raise ValueError("节拍不存在或不属于本场：%s" % beat_id)
    rows = _scene_shots(con, scene_id)
    idx = max(0, min(int(index), len(rows)))
    if not rows:
        new_no = "01"
    elif idx == len(rows):
        mx = 0
        for r in rows:
            m = re.match(r"^(\d+)", (r["shot_no"] or ""))
            if m:
                mx = max(mx, int(m.group(1)))
        new_no = "%02d" % (mx + 1) if mx else "01"
    else:
        base = rows[idx - 1]["shot_no"] if idx > 0 else rows[0]["shot_no"]
        new_no = _next_shot_no(con, scene_id, base or "01")
    con.execute("UPDATE shots SET position=position+1 WHERE scene_id=? AND position>=?", (scene_id, idx))
    cur = con.execute(
        "INSERT INTO shots (scene_id, beat_id, position, shot_no) VALUES (?,?,?,?)",
        (scene_id, beat_id, idx, new_no))
    new_id = cur.lastrowid
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "shots", new_id, "create",
         (rows[idx - 1]["shot_no"] if idx > 0 and rows else None), new_no, "manual"))
    con.commit()
    return dict(con.execute("SELECT * FROM shots WHERE id=?", (new_id,)).fetchone())


def delete_shots(con, ids):
    """多行删除（一次事务）：位置致密；逐行 delete 痕迹。返回全量行快照（按原序升序，供撤销）。"""
    rows = []
    for i in ids:
        r = con.execute("SELECT * FROM shots WHERE id=?", (i,)).fetchone()
        if not r:
            raise ValueError("镜头不存在：%s" % i)
        rows.append(r)
    scene_ids = {r["scene_id"] for r in rows}
    if len(scene_ids) != 1:
        raise ValueError("只能批量删除同一场的镜头")
    scene_id = rows[0]["scene_id"]
    rows.sort(key=lambda r: (r["position"], r["id"]))
    for r in rows:
        con.execute("DELETE FROM shots WHERE id=?", (r["id"],))
        con.execute(
            "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
            " VALUES (?,?,?,?,?,?,?)",
            (scene_id, "shots", r["id"], "delete", r["shot_no"], None, "manual"))
    surv = list(con.execute("SELECT id, position FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))
    for i, r in enumerate(surv):
        if r["position"] != i:
            con.execute("UPDATE shots SET position=? WHERE id=?", (i, r["id"]))
    con.commit()
    return [dict(r) for r in rows]


def restore_shots(con, rows_):
    """撤销删除：按原序（position 升序）插回原位；原编号/内容/提示词归属全带回（新 id）。"""
    rows_ = sorted(rows_, key=lambda r: (r.get("position") or 0))
    cols = _table_cols(con, "shots")
    out = []
    for r in rows_:
        scene_id = r.get("scene_id")
        if not isinstance(scene_id, int):
            raise ValueError("恢复行缺 scene_id")
        cnt = con.execute("SELECT COUNT(*) c FROM shots WHERE scene_id=?", (scene_id,)).fetchone()["c"]
        idx = max(0, min(int(r.get("position") or 0), cnt))
        con.execute("UPDATE shots SET position=position+1 WHERE scene_id=? AND position>=?", (scene_id, idx))
        new_id = _insert_restore(con, "shots", r, {"position": idx})
        con.execute(
            "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
            " VALUES (?,?,?,?,?,?,?)",
            (scene_id, "shots", new_id, "create", None, r.get("shot_no"), "manual"))
        out.append(dict(con.execute("SELECT * FROM shots WHERE id=?", (new_id,)).fetchone()))
    con.commit()
    return out


def create_beat(con, scene_id):
    """场景末尾追加空节拍（编号 = 最大数字 +1）。"""
    sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if not sc:
        raise ValueError("场景不存在：%s" % scene_id)
    beats = _scene_beats(con, scene_id)
    mx = 0
    for b in beats:
        m = re.match(r"^(\d+)", str(b["beat_no"] or ""))
        if m:
            mx = max(mx, int(m.group(1)))
    cur = con.execute(
        "INSERT INTO beats (scene_id, position, beat_no, name, kind) VALUES (?,?,?,?,?)",
        (scene_id, len(beats), str(mx + 1), "新节拍", "\u26aa 填充"))
    new_id = cur.lastrowid
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "beats", new_id, "create", None, str(mx + 1), "manual"))
    con.commit()
    return dict(con.execute("SELECT * FROM beats WHERE id=?", (new_id,)).fetchone())


def duplicate_beat(con, beat_id):
    """节拍深拷：副本节拍紧跟源节拍；其下镜头连内容一起拷（字母后缀编号），插在其后连续块。"""
    src = con.execute("SELECT * FROM beats WHERE id=?", (beat_id,)).fetchone()
    if not src:
        raise ValueError("节拍不存在：%s" % beat_id)
    scene_id = src["scene_id"]
    beats = _scene_beats(con, scene_id)
    bi = [b["id"] for b in beats].index(beat_id)
    new_no = _next_beat_no(con, scene_id, src["beat_no"])
    con.execute("UPDATE beats SET position=position+1 WHERE scene_id=? AND position>?", (scene_id, src["position"]))
    bcols = _table_cols(con, "beats")
    bkeys = [k for k in src.keys() if k in bcols and k not in ("id", "position", "beat_no", "scene_id")]
    bvals = [src[k] for k in bkeys]
    cur = con.execute(
        "INSERT INTO beats (scene_id, position, beat_no, %s) VALUES (?,?,?,%s)"
        % (", ".join(bkeys), ", ".join(["?"] * len(bkeys))),
        [scene_id, bi + 1, new_no] + bvals)
    new_bid = cur.lastrowid
    block = [s for s in _scene_shots(con, scene_id) if s["beat_id"] == beat_id]
    if block:
        last_pos = block[-1]["position"]
        con.execute("UPDATE shots SET position=position+? WHERE scene_id=? AND position>?",
                    (len(block), scene_id, last_pos))
        cursor = last_pos + 1
        for src_s in block:
            new_s_no = _next_shot_no(con, scene_id, src_s["shot_no"])
            cols = ", ".join(COPY_COLS)
            con.execute(
                "INSERT INTO shots (scene_id, beat_id, position, shot_no, %s) VALUES (?,?,?,?,%s)"
                % (cols, ", ".join(["?"] * len(COPY_COLS))),
                [scene_id, new_bid, cursor, new_s_no] + [src_s[c] for c in COPY_COLS])
            cursor += 1
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "beats", new_bid, "create", src["beat_no"],
         "%s（含 %d 镜）" % (new_no, len(block)), "manual"))
    con.commit()
    return dict(con.execute("SELECT * FROM beats WHERE id=?", (new_bid,)).fetchone())


def delete_beat(con, beat_id, with_shots=False):
    """删除节拍：默认其下镜头落「未归节拍」（beat_id=NULL）；with_shots=True 连镜头删除（副本撤销用）。"""
    beat = con.execute("SELECT * FROM beats WHERE id=?", (beat_id,)).fetchone()
    if not beat:
        raise ValueError("节拍不存在：%s" % beat_id)
    scene_id = beat["scene_id"]
    block = [s for s in _scene_shots(con, scene_id) if s["beat_id"] == beat_id]
    if with_shots:
        for s in block:
            con.execute("DELETE FROM shots WHERE id=?", (s["id"],))
            con.execute(
                "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
                " VALUES (?,?,?,?,?,?,?)",
                (scene_id, "shots", s["id"], "delete", s["shot_no"], None, "manual"))
        surv = list(con.execute("SELECT id, position FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))
        for i, r in enumerate(surv):
            if r["position"] != i:
                con.execute("UPDATE shots SET position=? WHERE id=?", (i, r["id"]))
    else:
        for s in block:
            con.execute("UPDATE shots SET beat_id=NULL WHERE id=?", (s["id"],))
    con.execute("DELETE FROM beats WHERE id=?", (beat_id,))
    bsurv = list(con.execute("SELECT id, position FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,)))
    for i, b in enumerate(bsurv):
        if b["position"] != i:
            con.execute("UPDATE beats SET position=? WHERE id=?", (i, b["id"]))
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "beats", beat_id, "delete", beat["beat_no"], None, "manual"))
    con.commit()
    return {"beat": dict(beat), "shot_ids": [s["id"] for s in block]}


def restore_beat(con, beat_row, shot_ids):
    """撤销删除：重建节拍（原位）并认领镜头（按 id 重挂）。"""
    scene_id = beat_row.get("scene_id")
    if not isinstance(scene_id, int):
        raise ValueError("恢复节拍缺 scene_id")
    bs = _scene_beats(con, scene_id)
    idx = max(0, min(int(beat_row.get("position") or 0), len(bs)))
    con.execute("UPDATE beats SET position=position+1 WHERE scene_id=? AND position>=?", (scene_id, idx))
    new_id = _insert_restore(con, "beats", beat_row, {"position": idx})
    for sid in (shot_ids or []):
        if isinstance(sid, int):
            con.execute("UPDATE shots SET beat_id=? WHERE id=?", (new_id, sid))
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "beats", new_id, "create", None, beat_row.get("beat_no"), "manual"))
    con.commit()
    return dict(con.execute("SELECT * FROM beats WHERE id=?", (new_id,)).fetchone())


def create_scene(con):
    """在影片末尾追加空场（场号自动）。"""
    f = db.film(con)
    if not f:
        raise ValueError("还没有影片")
    scenes = list(con.execute("SELECT * FROM scenes WHERE film_id=? ORDER BY position, id", (f["id"],)))
    no = _next_scene_no(con)
    cur = con.execute(
        "INSERT INTO scenes (film_id, position, scene_no, title) VALUES (?,?,?,?)",
        (f["id"], len(scenes), no, "新场"))
    new_id = cur.lastrowid
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (new_id, "scenes", new_id, "create", None, no, "manual"))
    con.commit()
    return dict(con.execute("SELECT * FROM scenes WHERE id=?", (new_id,)).fetchone())


def move_scene(con, scene_id, index):
    """场次排序：重排 scenes.position（index 基于去掉自身后的场序）。"""
    sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if not sc:
        raise ValueError("场景不存在：%s" % scene_id)
    scenes = list(con.execute("SELECT * FROM scenes WHERE film_id=? ORDER BY position, id", (sc["film_id"],)))
    others = [s for s in scenes if s["id"] != scene_id]
    idx = max(0, min(int(index), len(others)))
    new_order = others[:idx] + [sc] + others[idx:]
    if [s["id"] for s in new_order] == [s["id"] for s in scenes]:
        return {"changed": False, "id": scene_id}
    old_i = [s["id"] for s in scenes].index(scene_id)
    for i, s in enumerate(new_order):
        if s["position"] != i:
            con.execute("UPDATE scenes SET position=? WHERE id=?", (i, s["id"]))
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "scenes", scene_id, "drag", "#%s" % old_i, "#%s" % idx, "manual"))
    con.commit()
    return {"changed": True, "id": scene_id, "index": idx, "old_index": old_i}


def duplicate_scene(con, scene_id):
    """场次深拷：场 + 节拍 + 镜头 + 提示词组；新场紧跟源场；场号自动；镜号原样（新场不冲突）。"""
    src = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if not src:
        raise ValueError("场景不存在：%s" % scene_id)
    film_id = src["film_id"]
    new_no = _next_scene_no(con)
    con.execute("UPDATE scenes SET position=position+1 WHERE film_id=? AND position>?", (film_id, src["position"]))
    scols = _table_cols(con, "scenes")
    skeys = [k for k in src.keys() if k in scols and k not in ("id", "position", "scene_no", "locked", "film_id")]
    con.execute(
        "INSERT INTO scenes (film_id, position, scene_no, locked, %s) VALUES (?,?,?,0,%s)"
        % (", ".join(skeys), ", ".join(["?"] * len(skeys))),
        [film_id, src["position"] + 1, new_no] + [src[k] for k in skeys])
    new_sid = con.execute("SELECT last_insert_rowid() x").fetchone()["x"]
    bmap = {}
    for b in _scene_beats(con, scene_id):
        bcols = _table_cols(con, "beats")
        bkeys = [k for k in b.keys() if k in bcols and k not in ("id", "scene_id")]
        con.execute(
            "INSERT INTO beats (scene_id, %s) VALUES (?,%s)" % (", ".join(bkeys), ", ".join(["?"] * len(bkeys))),
            [new_sid] + [b[k] for k in bkeys])
        bmap[b["id"]] = con.execute("SELECT last_insert_rowid() x").fetchone()["x"]
    gmap = {}
    for g in con.execute("SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,)):
        gcols = _table_cols(con, "prompt_groups")
        gkeys = [k for k in g.keys() if k in gcols and k not in ("id", "scene_id")]
        con.execute(
            "INSERT INTO prompt_groups (scene_id, %s) VALUES (?,%s)" % (", ".join(gkeys), ", ".join(["?"] * len(gkeys))),
            [new_sid] + [g[k] for k in gkeys])
        gmap[g["id"]] = con.execute("SELECT last_insert_rowid() x").fetchone()["x"]
    s2 = _scene_shots(con, scene_id)
    for shot in s2:
        bid = bmap.get(shot["beat_id"]) if shot["beat_id"] is not None else None
        gid = gmap.get(shot["prompt_group_id"]) if shot["prompt_group_id"] is not None else None
        con.execute(
            "INSERT INTO shots (scene_id, beat_id, position, shot_no, prompt_group_id, %s) VALUES (?,?,?,?,?,%s)"
            % (", ".join(COPY_COLS), ", ".join(["?"] * len(COPY_COLS))),
            [new_sid, bid, shot["position"], shot["shot_no"], gid] + [shot[c] for c in COPY_COLS])
    nbeats = len(bmap)
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (new_sid, "scenes", new_sid, "create", src["scene_no"],
         "%s（%d 节拍 / %d 镜）" % (new_no, nbeats, len(s2)), "manual"))
    con.commit()
    return {"id": new_sid, "scene_no": new_no, "beats": nbeats, "shots": len(s2)}


def delete_scene(con, scene_id):
    """删场：整场级联（节拍/镜头/提示词组随删）；返回全量快照供撤销。"""
    sc = con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if not sc:
        raise ValueError("场景不存在：%s" % scene_id)
    film_id = sc["film_id"]
    payload = {
        "scene": dict(sc),
        "beats": [dict(b) for b in _scene_beats(con, scene_id)],
        "shots": [dict(s) for s in _scene_shots(con, scene_id)],
        "groups": [dict(g) for g in con.execute("SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,))],
    }
    con.execute("DELETE FROM scenes WHERE id=?", (scene_id,))
    surv = list(con.execute("SELECT id, position FROM scenes WHERE film_id=? ORDER BY position, id", (film_id,)))
    for i, r in enumerate(surv):
        if r["position"] != i:
            con.execute("UPDATE scenes SET position=? WHERE id=?", (i, r["id"]))
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, "scenes", scene_id, "delete", sc["scene_no"], None, "manual"))
    con.commit()
    return payload


def restore_scene_full(con, payload):
    """撤销删场：重建整场（新 id；场号/顺序原样；节拍/镜头/提示词组外键重连）。"""
    sc = dict(payload.get("scene") or {})
    film_id = sc.get("film_id")
    if not isinstance(film_id, int):
        raise ValueError("恢复场次缺 film_id")
    scenes = list(con.execute("SELECT id, position FROM scenes WHERE film_id=? ORDER BY position, id", (film_id,)))
    idx = max(0, min(int(sc.get("position") or 0), len(scenes)))
    con.execute("UPDATE scenes SET position=position+1 WHERE film_id=? AND position>=?", (film_id, idx))
    new_sid = _insert_restore(con, "scenes", sc, {"position": idx})
    bmap = {}
    for b in payload.get("beats") or []:
        bmap[b["id"]] = _insert_restore(con, "beats", b, {"scene_id": new_sid})
    gmap = {}
    for g in payload.get("groups") or []:
        gmap[g["id"]] = _insert_restore(con, "prompt_groups", g, {"scene_id": new_sid})
    for shot in payload.get("shots") or []:
        bid = bmap.get(shot.get("beat_id")) if shot.get("beat_id") is not None else None
        gid = gmap.get(shot.get("prompt_group_id")) if shot.get("prompt_group_id") is not None else None
        _insert_restore(con, "shots", shot,
                        {"scene_id": new_sid, "beat_id": bid, "prompt_group_id": gid})
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (new_sid, "scenes", new_sid, "create", None, sc.get("scene_no"), "manual"))
    con.commit()
    return {"id": new_sid, "scene_no": sc.get("scene_no")}
