"""领域操作（写路径的唯一实现）：字段更新 / 批量更新 / 整理镜号 / 痕迹 / 每日快照。
逻辑为主、可单测（tests/test_ops.py）。改动维护：写白名单从 fields.py 派生，不另写一份。"""
import json
import os
import re
import sqlite3
import string
import threading
from datetime import date, datetime
from pathlib import Path

from core import db, fields

# 表级差异位（spec 从 fields 派生；skip_types＝不进写白名单的类型，缺省无）——P0·S1-P1②
TABLES = {
    "shots":  {"skip_types": ("prompt",)},
    "beats":  {},
    "scenes": {"extra": ["script"]},   # 表级例外（台本：可写，但不进字段面/表头）
}
SPECS = {"shots": fields.SHOT_FIELDS, "beats": fields.BEAT_FIELDS, "scenes": fields.SCENE_FIELDS}
TABLES_ALLOWED = tuple(TABLES)   # 接口层表名校验单点（handlers 引用）——P0·S1-P1③


def write_keys(table):
    """该表允许直改的字段白名单（prompt 为虚拟列，position/id/时间戳不在清单）。"""
    t = TABLES.get(table)
    if t is None:
        return []
    keys = [f["key"] for f in SPECS[table] if f["type"] not in t.get("skip_types", ())]
    keys.extend(t.get("extra", []))
    return keys


BEAT_KIND_DEFAULT = "⚪ 填充"   # 新建节拍默认类型（P0·S1-W7；测试引用，勿手抄）


def record_history(con, scene_id, table, entity_id, field, old_value, new_value, source="manual"):
    """写一条痕迹（写保护唯一入口；不 commit）。列序只在这里定义（实体列名 entity＝表名，schema v1 口径）。"""
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, table, entity_id, field, old_value, new_value, source))



def _row_or_raise(con, table, row_id, what):
    """取行否则 ValueError（文案统一：what不存在：id）——P0·S1-W3。"""
    row = con.execute("SELECT * FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    if not row:
        raise ValueError("%s不存在：%s" % (what, row_id))
    return row


SNAPSHOT_RETAIN_DAYS = 30

# 痕迹接口配额（单源：接口层只做类型解析；P0·S1-P2）
HISTORY_LIMIT_DEFAULT = 100
HISTORY_LIMIT_MAX = 500

# 每日快照：并发锁 + 进程内「今日已做」幂等键（P0·S1-B2）
_snapshot_lock = threading.Lock()
_snapshot_done = None   # (src, root, ymd)：做完才置位；免每次写连接的 stat+glob


def ensure_daily_snapshot(db_path=None, snap_root=None):
    """每日快照：当天首次写操作前整库备份一份（幂等，已存在则跳过）。
    用 SQLite 备份接口落 .tmp 再原子改名——不裸拷 live 文件（避免拷到事务半写态），
    中断只留 .tmp、不留半截正式备份；顺带清理超过 SNAPSHOT_RETAIN_DAYS 天的旧档。
    并发安全：锁内复查 + tmp 名带 pid（P0·S1-B2）；进程内「今日已做」免重复 stat+glob。"""
    global _snapshot_done
    src = Path(db_path) if db_path else db.DB_PATH
    root = Path(snap_root) if snap_root else src.parent / "snapshots" / "daily"
    if not src.exists():
        return None
    key = (str(src), str(root), date.today().strftime("%Y%m%d"))
    if _snapshot_done == key:
        return None
    root.mkdir(parents=True, exist_ok=True)
    dest = root / ("studio-%s.db" % key[2])
    made = None
    with _snapshot_lock:
        if _snapshot_done == key:   # 等锁期间已被别的线程做完
            return None
        if not dest.exists():
            tmp = root / (dest.name + ".%d.tmp" % os.getpid())
            src_con = sqlite3.connect("file:%s?mode=ro" % src, uri=True)
            try:
                dst_con = sqlite3.connect(str(tmp))
                try:
                    src_con.backup(dst_con)
                finally:
                    dst_con.close()
            finally:
                src_con.close()
            os.replace(tmp, dest)
            made = str(dest)
        _prune_snapshots(root)
        _snapshot_done = key
    return made


def _snapshot_date(path):
    """存档名中的日期（studio-YYYYMMDD.db）；不匹配/非法 → None——P0·S1-P6③。"""
    m = re.match(r"^studio-(\d{8})\.db$", path.name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d").date()
    except ValueError:
        return None


def _prune_snapshots(root):
    """保留最近 SNAPSHOT_RETAIN_DAYS 天的每日快照，过期删除（失败静默）。"""
    cutoff = date.today().toordinal() - SNAPSHOT_RETAIN_DAYS
    try:
        for f in root.glob("studio-*.db"):
            d = _snapshot_date(f)
            if d and d.toordinal() < cutoff:
                f.unlink()
    except OSError:
        pass


def lock_scene(con, scene_id, lock=True, snap_root=None):
    """锁定本场（M2-7）：留底 = 场次版本快照（JSON 落盘 + snapshots 记录）+ 锁定标记。
    锁定 ≠ 禁止编辑（设计稿 §128）；解锁只清标记，不动已留底文件。"""
    sc = _row_or_raise(con, "scenes", scene_id, "场景")
    snap = None
    if lock:
        payload = {"saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                   **_scene_payload(con, scene_id)}
        root = Path(snap_root) if snap_root else db.DB_PATH.parent / "snapshots" / "scenes"
        root.mkdir(parents=True, exist_ok=True)
        fname = "%s-%s.json" % (sc["scene_no"] or ("scene%d" % scene_id),
                                datetime.now().strftime("%Y%m%d-%H%M%S"))
        fpath = root / fname
        fpath.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        rel = str(fpath.relative_to(db.DB_PATH.parent.parent))   # 恒仓库相对（snap_root 只决定文件落哪）——P0·S1-W15
        con.execute("INSERT INTO snapshots (scope, kind, label, path) VALUES ('scene','locked',?,?)",
                    (sc["scene_no"], rel))
        snap = {"path": rel, "at": payload["saved_at"]}
    con.execute("UPDATE scenes SET locked=? WHERE id=?", (1 if lock else 0, scene_id))
    record_history(con, scene_id, "scenes", scene_id, field="locked",
                   old_value="1" if sc["locked"] else "0", new_value="1" if lock else "0")
    con.commit()
    return {"scene": dict(con.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()),
            "snapshot": snap}


def _guarded_set(con, table, field, row_id, old, value):
    """条件写：仅当现值仍等于 old 才落笔（防 check-then-act 丢更新）。返回是否写入。"""
    cur = con.execute(
        "UPDATE %s SET %s=?, updated_at=datetime('now','localtime') "
        "WHERE id=? AND ifnull(%s,'')=?" % (table, field, field),
        (value, row_id, "" if old is None else old))
    return cur.rowcount > 0



def scene_no_taken(con, scene_no, exclude_id=None):
    """场号唯一性单点（写路径不变量；trim/唯一校验共用）——P0·S1-W12。"""
    if exclude_id is None:
        row = con.execute("SELECT id FROM scenes WHERE scene_no=?", (scene_no,)).fetchone()
    else:
        row = con.execute("SELECT id FROM scenes WHERE scene_no=? AND id<>?", (scene_no, exclude_id)).fetchone()
    return row is not None


def _check_field_value(con, table, row_id, field, value):
    """per-field 域层校验（update / batch 同源；P0·S1-B1）：返回规整后的值。
    场号：trim + 非空 + 唯一（唯一性检查与写入同连接、同事务收口）。"""
    if table == "scenes" and field == "scene_no":
        v = ("" if value is None else str(value)).strip()
        if not v:
            raise ValueError("场号不能为空")
        if scene_no_taken(con, v, exclude_id=row_id):
            raise ValueError("场号已存在：%s" % v)
        return v
    return value


def _apply_field(con, table, row_id, field, value, source="manual"):
    """单字段更新（不 commit）：白名单校验 → 域层值校验 → 写行 → 记痕迹。返回 (row, changed)。"""
    if field not in write_keys(table):
        raise ValueError("字段不可写：%s.%s" % (table, field))
    row = con.execute("SELECT * FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    if not row:
        raise ValueError("行不存在：%s #%s" % (table, row_id))
    value = _check_field_value(con, table, row_id, field, value)
    old = row[field]
    if (old if old is not None else "") == (value if value is not None else ""):
        return dict(row), False
    if not _guarded_set(con, table, field, row_id, old, value):
        raise ValueError("该字段已被其他操作修改（%s #%s），请刷新后重试" % (table, row_id))
    record_history(con, row_id if table == "scenes" else row["scene_id"], table, row_id, field=field, old_value=old, new_value=value, source=source)
    fresh = dict(row)   # 内存改写（值已知；免回读一次 SELECT）——P0·S1-W10
    fresh[field] = value
    fresh["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return fresh, True


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
            record_history(con, scene_id, "shots", r["id"], field="shot_no",
                           old_value=r["shot_no"], new_value=new_no, source="system")
            changes.append({"id": r["id"], "old": r["shot_no"], "new": new_no})
    con.commit()
    return changes


def _scene_beats(con, scene_id):
    return list(con.execute("SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def _scene_shots(con, scene_id):
    return list(con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def _scene_payload(con, scene_id):
    """场次完整载荷：{scene, beats, shots, groups}（锁底/删场撤销共用单点）——P0·S1-W4。"""
    return {
        "scene": dict(_row_or_raise(con, "scenes", scene_id, "场景")),
        "beats": [dict(b) for b in _scene_beats(con, scene_id)],
        "shots": [dict(s) for s in _scene_shots(con, scene_id)],
        "groups": [dict(g) for g in con.execute(
            "SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,))],
    }


def reseq(con, table, ids, touch=False):
    """把 ids 按列表顺序重写为 0 基致密 position（仅变更行落库，不 commit）。
    touch=True 时同步更新 updated_at（beats 等既有口径）。先读现值、只更真变行——P0·S1-W11。"""
    set_cols = "position=?, updated_at=datetime('now','localtime')" if touch else "position=?"
    cur = {r["id"]: r["position"] for r in con.execute(
        "SELECT id, position FROM %s WHERE id IN (%s)" % (table, ", ".join("?" * len(ids))), ids)} if ids else {}
    for i, _id in enumerate(ids):
        if cur.get(_id) != i:
            con.execute("UPDATE %s SET %s WHERE id=?" % (table, set_cols), (i, _id))


def _make_room(con, table, scope, scope_val, pos, n=1, after=False):
    """让位：scope 内 position >= pos（after=True 则 > pos）的行整体 +n——P0·S1-W2。"""
    con.execute("UPDATE %s SET position=position+? WHERE %s=? AND position%s?" % (
        table, scope, ">" if after else ">="), (n, scope_val, pos))


def _reseq_survivors(con, table, scope, scope_val):
    """删后致密：scope 内存活行按 (position, id) 重排为 0 基——P0·S1-W2。"""
    surv = [r["id"] for r in con.execute(
        "SELECT id FROM %s WHERE %s=? ORDER BY position, id" % (table, scope), (scope_val,))]
    reseq(con, table, surv)


def move_shot(con, shot_id, target_beat_id, index):
    """拖动落库（单镜）：move_shots 的单元素包装，返回形状保持——P0·S1-P7①。"""
    pre = con.execute("SELECT beat_id, position FROM shots WHERE id=?", (shot_id,)).fetchone()
    if not pre:
        raise ValueError("镜头不存在：%s" % shot_id)
    res = move_shots(con, [shot_id], target_beat_id, index)
    if not res["changed"]:
        return {"changed": False, "id": shot_id}
    return {"changed": True, "id": shot_id, "beat_id": res["beat_id"], "index": res["index"],
            "old_beat_id": pre["beat_id"], "old_index": pre["position"]}


def move_shots(con, shot_ids, target_beat_id, index):
    """多行整组搬家（M5 批2）：连续块整体搬到目标节拍第 index 位（index 基于去掉整组后的目标序）。
    组按当前场序去重排列（入参顺序无关）；镜号不动；逐行留痕（drag）。"""
    want = []
    for x in shot_ids:
        xi = int(x)
        if xi not in want:
            want.append(xi)
    if not want:
        raise ValueError("未指定要搬家的镜头")
    scene_ids = set()
    for sid in want:
        scene_ids.add(_row_or_raise(con, "shots", sid, "镜头")["scene_id"])
    if len(scene_ids) > 1:
        raise ValueError("不能跨场搬家")
    scene_id = scene_ids.pop()
    beats = _scene_beats(con, scene_id)
    tgt = next((b for b in beats if b["id"] == target_beat_id), None)
    if not tgt:
        raise ValueError("目标节拍不存在或不属于本场")
    want_set = set(want)
    all_rows = _scene_shots(con, scene_id)
    group = [r for r in all_rows if r["id"] in want_set]
    rows = [r for r in all_rows if r["id"] not in want_set]
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
    order = rows[:pos] + group + rows[pos:]
    before = [r["id"] for r in all_rows]
    if [r["id"] for r in order] == before and all(r["beat_id"] == target_beat_id for r in group):
        return {"changed": False, "ids": [r["id"] for r in group]}
    for r in group:
        old_beat_no = next((b["beat_no"] for b in beats if b["id"] == r["beat_id"]), "?")
        record_history(con, scene_id, "shots", r["id"], field="drag",
                       old_value="beat%s#%s" % (old_beat_no, r["position"]),
                       new_value="beat%s#%s" % (tgt["beat_no"], idx))
    con.execute("UPDATE shots SET beat_id=?, updated_at=datetime('now','localtime') WHERE id IN (%s)"
                % ",".join("?" * len(want)), [target_beat_id] + want)
    reseq(con, "shots", [r["id"] for r in order])
    con.commit()
    return {"changed": True, "ids": [r["id"] for r in group], "beat_id": target_beat_id, "index": idx}


def move_beat(con, beat_id, index):
    """节拍整体拖动：重排 beats.position（index 基于去掉自身后的节拍序），
    镜头 position 跟随节拍顺序重排（节拍内相对顺序不变）。"""
    beat = _row_or_raise(con, "beats", beat_id, "节拍")
    scene_id = beat["scene_id"]
    beats = _scene_beats(con, scene_id)
    others = [b for b in beats if b["id"] != beat_id]
    idx = max(0, min(int(index), len(others)))
    new_beats = others[:idx] + [beat] + others[idx:]
    if [b["id"] for b in new_beats] == [b["id"] for b in beats]:
        return {"changed": False, "id": beat_id}
    reseq(con, "beats", [b["id"] for b in new_beats], touch=True)
    shots = _scene_shots(con, scene_id)
    by_beat = {}
    for r in shots:
        by_beat.setdefault(r["beat_id"], []).append(r)
    flat = []
    for b in new_beats:
        flat.extend(by_beat.get(b["id"], []))
    known = {b["id"] for b in new_beats}
    flat.extend(r for r in shots if r["beat_id"] not in known)
    reseq(con, "shots", [r["id"] for r in flat])
    old_i = [b["id"] for b in beats].index(beat_id)
    record_history(con, scene_id, "beats", beat_id, field="drag", old_value="#%s" % old_i, new_value="#%s" % idx)
    con.commit()
    return {"changed": True, "id": beat_id, "index": idx, "old_index": old_i}


COPY_COLS = ("camera_move", "spatial", "shot_size", "focal", "dof", "camera_pos",
             "blocking", "dialogue", "duration", "audio", "director_note", "shot_fn", "pov")


_SUFFIXES = tuple(string.ascii_uppercase) + tuple(
    a + b for a in string.ascii_uppercase for b in string.ascii_uppercase)   # A–Z、AA–ZZ（模块级一次）——P0·S1-W6


def _next_letter_no(taken, base):
    """号码单点：数字基 + 首个空闲字母后缀（05→05A、17A→17B；A–Z 占满后 AA、AB…）。
    taken＝已占用编号集合（统一大写归一对标）——P0·S1-W6。"""
    m = re.match(r"^(\d+)([A-Za-z]*)$", (base or "").strip())
    root = m.group(1) if m else (base or "").strip()
    for suf in _SUFFIXES:
        cand = root + suf
        if cand.upper() not in taken:
            return cand
    return root + "A*"  # 理论不可达


def _next_shot_no(con, scene_id, base):
    """单件调用（查库版）：duplicate_shot / create_blank_shot 用。"""
    taken = {(r["shot_no"] or "").strip().upper() for r in
             con.execute("SELECT shot_no FROM shots WHERE scene_id=?", (scene_id,))}
    return _next_letter_no(taken, base)


def _max_num(rows, key):
    """行的编号列最大数字前缀（01→1；17A→17）；无数字前缀 → 0——P0·S1-W6。"""
    mx = 0
    for r in rows:
        m = re.match(r"^(\d+)", str(r[key] or ""))
        if m:
            mx = max(mx, int(m.group(1)))
    return mx


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
    record_history(con, scene_id, "shots", new_id, field="create", old_value=src["shot_no"], new_value=new_no)
    con.commit()
    return dict(con.execute("SELECT * FROM shots WHERE id=?", (new_id,)).fetchone())



def history_of(con, scene_id=None, limit=HISTORY_LIMIT_DEFAULT):
    limit = min(HISTORY_LIMIT_MAX, max(1, int(limit)))   # 上限钳制下沉域层（接口层只做类型解析）——P0·S1-P2④
    q = "SELECT * FROM history"
    args = []
    if scene_id is not None:
        q += " WHERE scene_id=?"
        args.append(scene_id)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    return [dict(r) for r in con.execute(q, args)]

# ── M2-6 结构操作：三层（场次/节拍/镜头）增删插复移 + 完整还原 ──

def _table_cols(con, name):
    """表列名集合（还原白名单用，防注入列名）。"""
    return {r[1] for r in con.execute("PRAGMA table_info(%s)" % name)}


def _insert_dict(con, table, d):
    """按 {列: 值} 插入一行，返回新 id（INSERT 拼串单点）——P0·S1-W9。"""
    cur = con.execute(
        "INSERT INTO %s (%s) VALUES (%s)" % (table, ", ".join(d), ", ".join(["?"] * len(d))),
        list(d.values()))
    return cur.lastrowid


def _copy_row(con, table, src, overrides, cols):
    """行深拷单点（P0·S1-W9）：overrides 显式列 + cols 子集（cols 由调用方循环外备好）。"""
    d = dict(overrides)
    for k in cols:
        if k not in d and k in src.keys():
            d[k] = src[k]
    return _insert_dict(con, table, d)


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
    """单件调用（查库版）：duplicate_beat 用（大小写统一归一对标）。"""
    taken = {(r["beat_no"] or "").strip().upper() for r in
             con.execute("SELECT beat_no FROM beats WHERE scene_id=?", (scene_id,))}
    return _next_letter_no(taken, base)


def create_blank_shot(con, scene_id, beat_id, index):
    """插入空行：index=0 基场序位。编号：追加（末尾）=数字顺延；中插=前邻字母后缀。
    idx=0 队首中插：以原首行为基生成后缀（编号序与位置序相反属标签语义——DO_NOT_FLAG A3）。"""
    _row_or_raise(con, "scenes", scene_id, "场景")
    if beat_id is not None:
        b = con.execute("SELECT * FROM beats WHERE id=?", (beat_id,)).fetchone()
        if not b or b["scene_id"] != scene_id:
            raise ValueError("节拍不存在或不属于本场：%s" % beat_id)
    rows = _scene_shots(con, scene_id)
    idx = max(0, min(int(index), len(rows)))
    if not rows:
        new_no = "01"
    elif idx == len(rows):
        mx = _max_num(rows, "shot_no")
        new_no = "%02d" % (mx + 1) if mx else "01"
    else:
        base = rows[idx - 1]["shot_no"] if idx > 0 else rows[0]["shot_no"]
        new_no = _next_shot_no(con, scene_id, base or "01")
    _make_room(con, "shots", "scene_id", scene_id, idx)
    cur = con.execute(
        "INSERT INTO shots (scene_id, beat_id, position, shot_no) VALUES (?,?,?,?)",
        (scene_id, beat_id, idx, new_no))
    new_id = cur.lastrowid
    record_history(con, scene_id, "shots", new_id, field="create",
                   old_value=(rows[idx - 1]["shot_no"] if idx > 0 and rows else None), new_value=new_no)
    con.commit()
    return dict(con.execute("SELECT * FROM shots WHERE id=?", (new_id,)).fetchone())


def delete_shots(con, ids):
    """多行删除（一次事务）：位置致密；逐行 delete 痕迹。返回全量行快照（按原序升序，供撤销）。"""
    rows = [_row_or_raise(con, "shots", i, "镜头") for i in ids]
    scene_ids = {r["scene_id"] for r in rows}
    if len(scene_ids) != 1:
        raise ValueError("只能批量删除同一场的镜头")
    scene_id = rows[0]["scene_id"]
    rows.sort(key=lambda r: (r["position"], r["id"]))
    for r in rows:
        con.execute("DELETE FROM shots WHERE id=?", (r["id"],))
        record_history(con, scene_id, "shots", r["id"], field="delete", old_value=r["shot_no"], new_value=None)
    _reseq_survivors(con, "shots", "scene_id", scene_id)
    con.commit()
    return [dict(r) for r in rows]


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


def create_beat(con, scene_id):
    """场景末尾追加空节拍（编号 = 最大数字 +1）。"""
    _row_or_raise(con, "scenes", scene_id, "场景")
    beats = _scene_beats(con, scene_id)
    mx = _max_num(beats, "beat_no")
    cur = con.execute(
        "INSERT INTO beats (scene_id, position, beat_no, name, kind) VALUES (?,?,?,?,?)",
        (scene_id, len(beats), str(mx + 1), "新节拍", BEAT_KIND_DEFAULT))
    new_id = cur.lastrowid
    record_history(con, scene_id, "beats", new_id, field="create", old_value=None, new_value=str(mx + 1))
    con.commit()
    return dict(con.execute("SELECT * FROM beats WHERE id=?", (new_id,)).fetchone())


def append_beats(con, scene_id, rows, source="ai"):
    """追加行原语（L4）：场尾按序落节拍——编号 = 既有最大数字顺延；position 续尾；逐行 create 痕迹。
    rows = [{name, kind, outside_action, reaction, closed_loop}]；不 commit（调用方收尾保一步事务）。
    返回新建 id 列表。"""
    ex = list(con.execute("SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,)))
    mx = _max_num(ex, "beat_no")
    pos0 = max([b["position"] for b in ex]) + 1 if ex else 0
    ids = []
    for i, r in enumerate(rows):
        r = r or {}
        no = str(mx + 1 + i)
        cur = con.execute(
            "INSERT INTO beats (scene_id, position, beat_no, name, kind,"
            " outside_action, reaction, closed_loop) VALUES (?,?,?,?,?,?,?,?)",
            (scene_id, pos0 + i, no, r.get("name"), r.get("kind"),
             r.get("outside_action"), r.get("reaction"), r.get("closed_loop")))
        ids.append(cur.lastrowid)
        record_history(con, scene_id, "beats", cur.lastrowid, field="create", old_value=None, new_value=no, source=source)
    return ids


def append_shots(con, scene_id, rows, source="ai"):
    """追加行原语（L4）：场尾按序落镜头——编号 %02d 顺延；position 续尾；逐行 create 痕迹。
    rows = [{beat_id, camera_move, camera_pos, blocking, dialogue, duration}]；不 commit（同 append_beats）。
    返回新建 id 列表。"""
    ex = list(con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))
    mx = _max_num(ex, "shot_no")
    pos0 = max([s["position"] for s in ex]) + 1 if ex else 0
    ids = []
    for k, r in enumerate(rows):
        r = r or {}
        no = "%02d" % (mx + 1 + k)
        cur = con.execute(
            "INSERT INTO shots (scene_id, beat_id, position, shot_no, camera_move,"
            " camera_pos, blocking, dialogue, duration) VALUES (?,?,?,?,?,?,?,?,?)",
            (scene_id, r.get("beat_id"), pos0 + k, no, r.get("camera_move"),
             r.get("camera_pos"), r.get("blocking"), r.get("dialogue"), r.get("duration")))
        ids.append(cur.lastrowid)
        record_history(con, scene_id, "shots", cur.lastrowid, field="create", old_value=None, new_value=no, source=source)
    return ids


def duplicate_beat(con, beat_id):
    """节拍深拷：副本节拍紧跟源节拍；其下镜头连内容一起拷（字母后缀编号），插在其后连续块。"""
    src = _row_or_raise(con, "beats", beat_id, "节拍")
    scene_id = src["scene_id"]
    beats = _scene_beats(con, scene_id)
    bi = [b["id"] for b in beats].index(beat_id)
    new_no = _next_beat_no(con, scene_id, src["beat_no"])
    _make_room(con, "beats", "scene_id", scene_id, src["position"], after=True)
    bcols = _table_cols(con, "beats")
    bkeys = [k for k in src.keys() if k in bcols and k not in ("id", "position", "beat_no", "scene_id")]
    new_bid = _copy_row(con, "beats", src,
                        {"scene_id": scene_id, "position": bi + 1, "beat_no": new_no}, bkeys)
    block = [s for s in _scene_shots(con, scene_id) if s["beat_id"] == beat_id]
    if block:
        last_pos = block[-1]["position"]
        _make_room(con, "shots", "scene_id", scene_id, last_pos, n=len(block), after=True)
        taken = {(r["shot_no"] or "").strip().upper() for r in
                 con.execute("SELECT shot_no FROM shots WHERE scene_id=?", (scene_id,))}
        cursor = last_pos + 1
        for src_s in block:
            new_s_no = _next_letter_no(taken, src_s["shot_no"])
            taken.add(new_s_no.upper())
            _copy_row(con, "shots", src_s,
                      {"scene_id": scene_id, "beat_id": new_bid, "position": cursor, "shot_no": new_s_no},
                      COPY_COLS)
            cursor += 1
    record_history(con, scene_id, "beats", new_bid, field="create", old_value=src["beat_no"],
                   new_value="%s（含 %d 镜）" % (new_no, len(block)))
    con.commit()
    return dict(con.execute("SELECT * FROM beats WHERE id=?", (new_bid,)).fetchone())


def delete_beat(con, beat_id, with_shots=False):
    """删除节拍：默认其下镜头落「未归节拍」（beat_id=NULL）；with_shots=True 连镜头删除（副本撤销用）。"""
    beat = _row_or_raise(con, "beats", beat_id, "节拍")
    scene_id = beat["scene_id"]
    block = [s for s in _scene_shots(con, scene_id) if s["beat_id"] == beat_id]
    if with_shots:
        for s in block:
            con.execute("DELETE FROM shots WHERE id=?", (s["id"],))
            record_history(con, scene_id, "shots", s["id"], field="delete", old_value=s["shot_no"], new_value=None)
        _reseq_survivors(con, "shots", "scene_id", scene_id)
    else:
        for s in block:
            con.execute("UPDATE shots SET beat_id=NULL WHERE id=?", (s["id"],))
    con.execute("DELETE FROM beats WHERE id=?", (beat_id,))
    _reseq_survivors(con, "beats", "scene_id", scene_id)
    record_history(con, scene_id, "beats", beat_id, field="delete", old_value=beat["beat_no"], new_value=None)
    con.commit()
    return {"beat": dict(beat), "shot_ids": [s["id"] for s in block]}


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
