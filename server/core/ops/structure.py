# -*- coding: utf-8 -*-
"""结构操作：镜头/节拍级——序号重排 / 移动 / 增删拷贝（原 ops.py 拆分 · S1-L1）。"""
from core import db
from .write import record_history, _row_or_raise
from .numbering import COPY_COLS, _next_letter_no, _next_shot_no, _max_num, _next_beat_no, follow_no


BEAT_KIND_DEFAULT = "⚪ 填充"   # 新建节拍默认类型（P0·S1-W7；测试引用，勿手抄）


def _scene_beats(con, scene_id):
    return list(con.execute("SELECT * FROM beats WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def _scene_shots(con, scene_id):
    return list(con.execute("SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,)))


def reseq(con, table, ids, touch=False):
    """把 ids 按列表顺序重写为 0 基致密 position（仅变更行落库，不 commit）。
    touch=True 时同步更新 updated_at（beats 等既有口径）。先读现值、只更真变行——P0·S1-W11。"""
    set_cols = "position=?, updated_at=datetime('now','localtime')" if touch else "position=?"
    cur = {r["id"]: r["position"] for r in con.execute(
        "SELECT id, position FROM %s WHERE id IN (%s)" % (table, db.qmarks(len(ids))), ids)} if ids else {}
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


def copy_scene_children(con, scene_id, new_scene_id, *, s_cols, s_extra,
                        b_cols=None, g_cols=None, b_extra=None, g_extra=None):
    """场子树深拷单点（M8 清理刀）：提示词组 / 节拍 / 镜 → 新场；ID 全重映射（镜的节拍/组归属随映射）。
    b/g/s_cols：列集（None → 动态全列 − id）；b/g_extra：常量 overrides；s_extra：每行回调 (src_row, bmap, gmap) → overrides。
    不 commit（调用方收尾）。返回 (bmap, gmap, n_shots)。"""
    b_cols = b_cols if b_cols is not None else (_table_cols(con, "beats") - {"id"})
    g_cols = g_cols if g_cols is not None else (_table_cols(con, "prompt_groups") - {"id"})
    bmap = {}
    for b in _scene_beats(con, scene_id):
        bmap[b["id"]] = _copy_row(con, "beats", b,
                                  {"scene_id": new_scene_id, **(b_extra or {})}, b_cols)
    gmap = {}
    for g in con.execute("SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,)):
        gmap[g["id"]] = _copy_row(con, "prompt_groups", g,
                                  {"scene_id": new_scene_id, **(g_extra or {})}, g_cols)
    shots = _scene_shots(con, scene_id)
    for s in shots:
        bid = bmap.get(s["beat_id"]) if s["beat_id"] is not None else None
        gid = gmap.get(s["prompt_group_id"]) if s["prompt_group_id"] is not None else None
        ov = {"scene_id": new_scene_id, "beat_id": bid, "prompt_group_id": gid}
        ov.update(s_extra(s, bmap, gmap))
        _copy_row(con, "shots", s, ov, s_cols)
    return bmap, gmap, len(shots)


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
        new_no = follow_no(_max_num(rows, "shot_no"), 0, 2)
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


def create_beat(con, scene_id):
    """场景末尾追加空节拍（编号 = 最大数字 +1）。"""
    _row_or_raise(con, "scenes", scene_id, "场景")
    beats = _scene_beats(con, scene_id)
    no = follow_no(_max_num(beats, "beat_no"), 0)
    cur = con.execute(
        "INSERT INTO beats (scene_id, position, beat_no, name, kind) VALUES (?,?,?,?,?)",
        (scene_id, len(beats), no, "新节拍", BEAT_KIND_DEFAULT))
    new_id = cur.lastrowid
    record_history(con, scene_id, "beats", new_id, field="create", old_value=None, new_value=no)
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
        no = follow_no(mx, i)
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
        no = follow_no(mx, k, 2)
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


