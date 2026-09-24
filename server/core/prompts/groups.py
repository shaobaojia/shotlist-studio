# -*- coding: utf-8 -*-
"""提示词组域：组状态 / 并组拆组 / 分离 / 还原（原 prompts.py 拆分 · S3-L1）。"""
from core import db, ops
from .text import is_id, _check_len


# ── 上限常量（单点定义；错误文案由它们拼出） ──
MAX_SHOTS = 500          # 一次操作最多涉及镜头数
MAX_GROUPS = 500         # 一次还原最多组数
MAX_GROUP_TEXT = 50000   # 组正文长度上限
def _shot_refs(members):
    return "镜" + " / ".join(str(m["shot_no"]) for m in members)


def _new_group(con, scene_id):
    cur = con.execute(
        "INSERT INTO prompt_groups (scene_id, position, text) VALUES (?, 0, NULL)", (scene_id,))
    return cur.lastrowid


def prompt_state(con, scene_id, shots=None):
    """场次提示词分组完整状态（含成员镜号；empty=无成员空组标记），供前端刷新 / 还原对账。
    shots（W5 接口）：本场全部镜头行（须已同步最新 prompt_group_id）——仅在调用方持有完整
    行集时传；子集会致成员装配不全，勿传。"""
    groups = db.prompt_groups(con, scene_id)
    if shots is None:
        shots = db.shots(con, scene_id)
    db.attach_group_members(groups, shots)
    for g in groups:
        g["empty"] = not g["member_ids"]
    return groups


def _normalize_positions(con, scene_id, shots=None):
    """组顺序落定 = 首个成员镜的位置顺序；无成员组排到最后（空组是撤销链的载体，刻意不剪）。
    shots（W4 接口）：本场全部镜头行（含 position/prompt_group_id，序同真表）——仅在调用方
    持有完整行集时传；子集缺组首会致排序错，勿传。"""
    if shots is None:
        shots = con.execute(
            "SELECT id, position, prompt_group_id FROM shots WHERE scene_id=? ORDER BY position, id",
            (scene_id,)).fetchall()
    rows = con.execute("SELECT id FROM prompt_groups WHERE scene_id=?", (scene_id,)).fetchall()
    first = {}
    for s in shots:
        gid = s["prompt_group_id"]
        if gid is not None and gid not in first:
            first[gid] = (int(s["position"] or 0), s["id"])
    ordered = sorted((r["id"] for r in rows), key=lambda gid: first.get(gid, (10 ** 9, gid)))
    ops.reseq(con, "prompt_groups", ordered)


def _load_shots(con, shot_ids):
    """读取镜头（校验：整数、存在、同一场次），按位置排序返回。"""
    if not isinstance(shot_ids, list) or not shot_ids or not all(is_id(x) for x in shot_ids):
        raise ValueError("参数不完整（shot_ids）")
    ids = list(dict.fromkeys(shot_ids))
    if len(ids) > MAX_SHOTS:
        raise ValueError("一次最多 %d 镜" % MAX_SHOTS)
    q = ",".join("?" * len(ids))
    rows = [dict(r) for r in con.execute("SELECT * FROM shots WHERE id IN (%s)" % q, ids)]
    if len(rows) != len(ids):
        raise ValueError("有镜头不存在")
    if len({r["scene_id"] for r in rows}) != 1:
        raise ValueError("提示词组操作需在同一场次内")
    rows.sort(key=lambda r: (r["position"], r["id"]))
    return rows


def set_group_text(con, group_id, text):
    """改写组正文（空串=清空）。无变化不记痕。"""
    g = db.row(con, "prompt_groups", group_id, "提示词组不存在：#%s" % group_id)   # W8 取组单点
    text = _check_len(text, "提示词", MAX_GROUP_TEXT)
    old = g["text"]
    if (old if old is not None else "") == text:
        return {"id": group_id, "text": old, "changed": False}
    ops.touch_row(con, "prompt_groups", group_id, text=text)                       # W1/W10
    ops.record_history(con, g["scene_id"], "prompt_groups", group_id, field="text", old_value=old, new_value=text)
    con.commit()
    return {"id": group_id, "text": text, "changed": True}


def merge_shots(con, shot_ids):
    """选中的镜头并为一个提示词组（保留首个来源组文本；其余来源组文本入痕迹）。
    单镜特例：为未组镜头建自己的组（前端「保存时自动建组」用）；已有组的单镜 = 无操作。"""
    shots = _load_shots(con, shot_ids)
    if len(shots) == 1:
        s = shots[0]
        if s["prompt_group_id"] is not None:
            return prompt_state(con, s["scene_id"])
        nid = _new_group(con, s["scene_id"])
        ops.touch_row(con, "shots", s["id"], prompt_group_id=nid)                  # W1/W10
        ops.record_history(con, s["scene_id"], "prompt_groups", nid, field="create", old_value=None,
                           new_value="新建组 · 镜%s" % s["shot_no"])
        _normalize_positions(con, s["scene_id"])
        con.commit()
        return prompt_state(con, s["scene_id"])
    scene_id = shots[0]["scene_id"]
    seen = []
    for s in shots:
        gid = s["prompt_group_id"]
        if gid is not None and gid not in seen:
            seen.append(gid)
    before = db.group_members(con, seen)   # W2：组成员单点（一次取全部来源组）
    target = con.execute("SELECT * FROM prompt_groups WHERE id=?", (seen[0],)).fetchone() if seen else None
    made_new = target is None
    target_id = _new_group(con, scene_id) if made_new else target["id"]
    if not made_new and all(s["prompt_group_id"] == target_id for s in shots):
        return prompt_state(con, scene_id)  # 全员已在一组：无操作
    moved = []
    moved_by = {}
    for s in shots:
        src = s["prompt_group_id"]
        if src == target_id:
            continue
        moved.append(s)
        if src is not None:
            moved_by[src] = moved_by.get(src, 0) + 1
    if moved:
        ops.touch_row(con, "shots", [s["id"] for s in moved], prompt_group_id=target_id)  # W1/W10
        for s in moved:
            s["prompt_group_id"] = target_id      # 内存同步（行集合后续复用）
    empties = [gid for gid in seen
               if gid != target_id and moved_by.get(gid, 0) >= len(before.get(gid, []))]
    if empties:
        q = ",".join(["?"] * len(empties))
        texts = {r["id"]: r["text"] for r in con.execute(
            "SELECT id, text FROM prompt_groups WHERE id IN (%s)" % q, empties)}
        for gid in empties:
            if (texts.get(gid) or "").strip():
                ops.record_history(con, scene_id, "prompt_groups", gid, field="merge", old_value=texts[gid],
                                   new_value="已并入：%s（原 %s）" % (_shot_refs(moved), _shot_refs(before[gid])))
            con.execute("DELETE FROM prompt_groups WHERE id=?", (gid,))
    ops.record_history(con, scene_id, "prompt_groups", target_id, field="merge_in", old_value=None,
                       new_value=("新建组 · " if made_new else "") + "＋" + _shot_refs(moved))
    _normalize_positions(con, scene_id)
    con.commit()
    return prompt_state(con, scene_id)


def detach_shots(con, shot_ids):
    """选中镜头各自独立成组（原组保留其余成员与文本）；已独立 / 未组镜头跳过。"""
    shots = _load_shots(con, shot_ids)
    scene_id = shots[0]["scene_id"]
    gids = [gid for gid in {s["prompt_group_id"] for s in shots} if gid is not None]
    before = db.group_members(con, gids)   # W3：一次取全部来源组成员（原逐组 _members）
    made = []       # [(shot, 原组 id, 新组 id)]
    moved_ids = {}  # 原组 id -> 本组被拆出的 shot id 集合
    for s in shots:
        gid = s["prompt_group_id"]
        if gid is None:
            continue
        if len(before.get(gid, [])) <= 1:
            continue
        nid = _new_group(con, scene_id)
        ops.touch_row(con, "shots", s["id"], prompt_group_id=nid)                  # W1/W10
        s["prompt_group_id"] = nid              # 内存同步
        made.append((s, gid, nid))
        moved_ids.setdefault(gid, set()).add(s["id"])
    if made:
        by_gid = {}                             # W11①：一次分桶（原逐组重建列表）
        for x in made:
            by_gid.setdefault(x[1], []).append(x)
        for gid, mem in before.items():
            out_made = by_gid.get(gid)
            if not out_made:
                continue
            left = [m for m in mem if m["id"] not in moved_ids[gid]]
            out = " / ".join(str(x[0]["shot_no"]) for x in out_made)
            note = ("现 %s · 拆出 %s" % (_shot_refs(left), out)) if left else "全部拆出"
            if not left:
                heir, heir_new = out_made[0][0], out_made[0][2]
                g = con.execute("SELECT * FROM prompt_groups WHERE id=?", (gid,)).fetchone()
                if g and (g["text"] or "").strip():
                    ops.touch_row(con, "prompt_groups", heir_new, text=g["text"])  # W1/W10
                    note += " · 文本随镜%s保留" % heir["shot_no"]
                if g:
                    con.execute("DELETE FROM prompt_groups WHERE id=?", (gid,))
            ops.record_history(con, scene_id, "prompt_groups", gid, field="detach", old_value=_shot_refs(mem), new_value=note)
        _normalize_positions(con, scene_id)
        con.commit()
    return prompt_state(con, scene_id)


def split_group(con, group_id):
    """整组拆开：每镜各自成组；正文留在首镜的原组上，其余新组为空。"""
    g = db.row(con, "prompt_groups", group_id, "提示词组不存在：#%s" % group_id)   # W8 取组单点
    members = db.group_members(con, [group_id])[group_id]                           # W2 组员单点
    if len(members) <= 1:
        return prompt_state(con, g["scene_id"])
    for m in members[1:]:
        nid = _new_group(con, g["scene_id"])
        ops.touch_row(con, "shots", m["id"], prompt_group_id=nid)                   # W1/W10
        m["prompt_group_id"] = nid      # 内存同步
    ops.record_history(con, g["scene_id"], "prompt_groups", group_id, field="split",
          old_value=_shot_refs(members),
          new_value="%s（拆出 %s）" % (_shot_refs(members[:1]), " / ".join(str(m["shot_no"]) for m in members[1:])))
    _normalize_positions(con, g["scene_id"])
    con.commit()
    return prompt_state(con, g["scene_id"])


def restore_state(con, scene_id, groups):
    """撤销/还原：把场次提示词分组整体还原到给定状态。
    groups = [{id?, text, shot_ids:[...]}]（id 缺省=新建；未列出的既有组将删除）。
    原 id 优先复用（撤销的「完整还原」；被占则退回自增，经 ops.insert_restore 单点语义）。"""
    if not is_id(scene_id):
        raise ValueError("参数不完整（scene_id）")
    if not con.execute("SELECT id FROM scenes WHERE id=?", (scene_id,)).fetchone():
        raise ValueError("场景不存在：#%s" % scene_id)
    if not isinstance(groups, list) or len(groups) > MAX_GROUPS:
        raise ValueError("参数不完整（groups）")
    all_ids = []
    for g in groups:
        if not isinstance(g, dict):
            raise ValueError("groups 项格式错误")
        ids = g.get("shot_ids") or []
        if not isinstance(ids, list) or not all(is_id(x) for x in ids):
            raise ValueError("shot_ids 格式错误")
        all_ids.extend(ids)
    all_ids = list(dict.fromkeys(all_ids))
    if all_ids:
        q = ",".join(["?"] * len(all_ids))
        valid = {r["id"] for r in con.execute(
            "SELECT id FROM shots WHERE scene_id=? AND id IN (%s)" % q, [scene_id] + all_ids)}
        for x in all_ids:
            if x not in valid:
                raise ValueError("镜头不在该场次：#%s" % x)
    existing = {r["id"] for r in con.execute(
        "SELECT id FROM prompt_groups WHERE scene_id=?", (scene_id,))}
    keep_ids = set()
    resolved = []  # [(落定组 id, payload 组)]
    for i, g in enumerate(groups):
        gid = g.get("id")
        text = g.get("text")
        if text is not None:
            text = _check_len(text, "提示词", MAX_GROUP_TEXT)
        if is_id(gid) and gid in existing:
            keep_ids.add(gid)
            ops.touch_row(con, "prompt_groups", gid, text=text, position=i)         # W1/W10
        else:
            row = {"scene_id": scene_id, "position": i, "text": text}
            if is_id(gid):
                row["id"] = gid
            new_id = ops.insert_restore(con, "prompt_groups", row)
            keep_ids.add(new_id)
            gid = new_id
        resolved.append((gid, g))
    # W6：全场置空 + 按组回填（每组一 条 IN）——行集合一次取
    scene_rows = [r["id"] for r in con.execute(
        "SELECT id FROM shots WHERE scene_id=?", (scene_id,))]
    if scene_rows:
        ops.touch_row(con, "shots", scene_rows, prompt_group_id=None)               # W1/W10
    for gid, g in resolved:
        ids = g.get("shot_ids") or []
        if ids:
            ops.touch_row(con, "shots", ids, prompt_group_id=gid)                   # W1/W10
    for gid in existing - keep_ids:     # W6：删除集 = existing - keep_ids（原重读全表）
        con.execute("DELETE FROM prompt_groups WHERE id=?", (gid,))
    ops.record_history(con, scene_id, "prompt_groups", None, field="restore", old_value=None,
                       new_value="分组状态还原（%d 组）" % len(groups))
    con.commit()
    return prompt_state(con, scene_id)


