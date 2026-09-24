"""提示词域操作（M3）：提示词组（改文 / 并组 / 独立成组 / 拆组 / 状态还原）+ 块库（积木块与分类）。

规则与 core/ops.py 一致：写路径带痕迹（history，经 ops.record_history 单点）、提交在函数内、可单测。
例外：块库写路径刻意不记 history（库不是场数据，恢复靠每日快照 / 前端撤销栈），提示词组写路径全记。
分组模型：一个提示词组（prompt_groups）覆盖 N 个镜头；shots.prompt_group_id 指向组；正文存组上。
并组口径：保留「首个来源组」（按镜头位置先后）的文本；其余来源组文本进痕迹可找回；组空了即删。
独立成组：选中镜头各得一个新空组；原组全文拆出时，文本跟随首个被拆镜头（不丢字）。
空组语义：无成员组是撤销链的载体（删镜撤销带组回插），刻意不剪、排到最后。
"""
from core import db, fields, ops

# ── 上限常量（单点定义；错误文案由它们拼出） ──
MAX_SHOTS = 500          # 一次操作最多涉及镜头数
MAX_GROUPS = 500         # 一次还原最多组数
MAX_GROUP_TEXT = 50000   # 组正文长度上限
MAX_BLOCK_TEXT = 20000   # 块正文长度上限
MAX_CAT_NAME = 40        # 分类名长度上限


is_id = fields.is_id   # 判据已上移 core/fields（P0·S3-B1）；别名保留，旧引用照常。


def _check_len(value, label, max_len):
    """长度校验（返回字符串化的值；None→''）。超限报「{label}过长（上限 N 字）」。"""
    t = "" if value is None else str(value)
    if len(t) > max_len:
        raise ValueError("%s过长（上限 %d 字）" % (label, max_len))
    return t


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


# ── 块库（积木块与分类） ──

def blocks_state(con):
    return {
        "categories": [dict(r) for r in con.execute(
            "SELECT * FROM block_categories ORDER BY position, id")],
        "blocks": [dict(r) for r in con.execute(
            "SELECT * FROM blocks ORDER BY position, id")],
    }


def _cat_blocks(con, category_id):
    if category_id is None:
        return [dict(r) for r in con.execute(
            "SELECT * FROM blocks WHERE category_id IS NULL ORDER BY position, id")]
    return [dict(r) for r in con.execute(
        "SELECT * FROM blocks WHERE category_id=? ORDER BY position, id", (category_id,))]


def _check_text(text):
    t = ("" if text is None else str(text)).strip()
    if not t:
        raise ValueError("块内容不能为空")
    return _check_len(t, "块", MAX_BLOCK_TEXT)


def _check_cat(con, category_id):
    if category_id is None:
        return
    if not is_id(category_id):
        raise ValueError("分类参数错误：%r" % (category_id,))
    if not con.execute("SELECT id FROM block_categories WHERE id=?", (category_id,)).fetchone():
        raise ValueError("分类不存在：#%s" % category_id)


def _check_cat_name(name):
    n = ("" if name is None else str(name)).strip()
    if not n:
        raise ValueError("分类名不能为空")
    if len(n) > MAX_CAT_NAME:
        raise ValueError("分类名过长（上限 %d 字）" % MAX_CAT_NAME)
    return n


def _load_block(con, block_id):
    """取块行（id 类型不对直接报参数错误；不存在报「块不存在」）。"""
    if not is_id(block_id):
        raise ValueError("块参数错误：%r" % (block_id,))
    b = con.execute("SELECT * FROM blocks WHERE id=?", (block_id,)).fetchone()
    if not b:
        raise ValueError("块不存在：#%s" % block_id)
    return b


def block_create(con, text, category_id=None, commit=True):
    t = _check_text(text)
    _check_cat(con, category_id)
    if category_id is None:
        row = con.execute("SELECT MAX(position) AS p FROM blocks WHERE category_id IS NULL").fetchone()
    else:
        row = con.execute("SELECT MAX(position) AS p FROM blocks WHERE category_id=?", (category_id,)).fetchone()
    pos = (row["p"] + 1) if row and row["p"] is not None else 0
    cur = con.execute(
        "INSERT INTO blocks (category_id, text, position, pinned) VALUES (?,?,?,0)",
        (category_id, t, pos))
    if commit:
        con.commit()
    return dict(con.execute("SELECT * FROM blocks WHERE id=?", (cur.lastrowid,)).fetchone())


def _place_block(con, b, cid, pos):
    """把块放进 cid 分类的第 pos 位（None=末尾，越界夹取）；跨类时源分类同步致密。"""
    tgt = [x["id"] for x in _cat_blocks(con, cid) if x["id"] != b["id"]]
    idx = len(tgt) if pos is None else max(0, min(pos, len(tgt)))
    tgt.insert(idx, b["id"])
    con.execute("UPDATE blocks SET category_id=? WHERE id=?", (cid, b["id"]))
    ops.reseq(con, "blocks", tgt)
    if b["category_id"] != cid:
        src = [x["id"] for x in _cat_blocks(con, b["category_id"]) if x["id"] != b["id"]]
        ops.reseq(con, "blocks", src)


def block_update(con, block_id, data):
    """改文本 / 换分类 / 置顶 / 定位（仅接受 text、category_id、pinned、position，其余键拒绝）。

    category_id 或 position 给出时：把块放进目标分类的指定位置——
    position 缺省＝末尾（兼容旧行为）；索引按「去掉自身后的顺序」夹取到 [0, len]。"""
    b = _load_block(con, block_id)
    data = data or {}
    unknown = [k for k in data if k not in fields.BLOCK_WRITE_KEYS]
    if unknown:
        raise ValueError("字段不可写：blocks.%s" % unknown[0])
    if "text" in data:
        con.execute("UPDATE blocks SET text=? WHERE id=?", (_check_text(data["text"]), block_id))
    if "pinned" in data:
        con.execute("UPDATE blocks SET pinned=? WHERE id=?", (1 if data["pinned"] else 0, block_id))
    if "category_id" in data or "position" in data:
        cid = data.get("category_id", b["category_id"])
        _check_cat(con, cid)
        pos = data.get("position", None)
        if pos is not None and not is_id(pos):
            raise ValueError("position 参数错误")
        if cid != b["category_id"] or pos is not None:
            _place_block(con, b, cid, pos)
    con.commit()
    return dict(con.execute("SELECT * FROM blocks WHERE id=?", (block_id,)).fetchone())


def block_delete(con, block_id):
    b = _load_block(con, block_id)
    con.execute("DELETE FROM blocks WHERE id=?", (block_id,))
    con.commit()
    return dict(b)


def _neighbor_swap(con, rows, row_id, direction):
    """同级相邻换位判定（单点，P0·S3-W9）：方向守卫 → 定位 → 越界。返回 (moved, idx, j)。
    落位手段由调用方决定（块走 position / 分类走 reseq）。"""
    if direction not in (-1, 1):
        raise ValueError("方向参数错误")
    idx = next(i for i, x in enumerate(rows) if x["id"] == row_id)
    j = idx + direction
    if j < 0 or j >= len(rows):
        return False, idx, j
    return True, idx, j


def block_move(con, block_id, direction):
    """同分类内与相邻块换位（direction = -1 上移 / 1 下移）；到头不抛错，返回 moved: False。"""
    b = _load_block(con, block_id)
    sib = _cat_blocks(con, b["category_id"])
    moved, idx, j = _neighbor_swap(con, sib, block_id, direction)
    if not moved:
        return {"moved": False, "id": block_id}
    block_update(con, block_id, {"position": j})
    return {"moved": True, "id": block_id, "index": j, "old_index": idx}


def cat_create(con, name, commit=True):
    n = _check_cat_name(name)
    row = con.execute("SELECT MAX(position) AS p FROM block_categories").fetchone()
    pos = (row["p"] + 1) if row and row["p"] is not None else 0
    cur = con.execute("INSERT INTO block_categories (name, position) VALUES (?,?)", (n, pos))
    if commit:
        con.commit()
    return dict(con.execute("SELECT * FROM block_categories WHERE id=?", (cur.lastrowid,)).fetchone())


def cat_update(con, cat_id, name):
    n = _check_cat_name(name)
    _check_cat(con, cat_id)
    con.execute("UPDATE block_categories SET name=? WHERE id=?", (n, cat_id))
    con.commit()
    return dict(con.execute("SELECT * FROM block_categories WHERE id=?", (cat_id,)).fetchone())


def cat_delete(con, cat_id):
    """删分类：其下块落「未分类」（category_id=NULL），不连带删块。并入后未分类池致密化（W11②）。"""
    _check_cat(con, cat_id)
    con.execute("UPDATE blocks SET category_id=NULL WHERE category_id=?", (cat_id,))
    con.execute("DELETE FROM block_categories WHERE id=?", (cat_id,))
    pool = [r["id"] for r in con.execute(
        "SELECT id FROM blocks WHERE category_id IS NULL ORDER BY position, id")]
    if pool:
        ops.reseq(con, "blocks", pool)
    con.commit()


def cat_move(con, cat_id, direction):
    """分类上下移；到头不抛错，返回 moved: False。"""
    _check_cat(con, cat_id)
    cats = [dict(r) for r in con.execute("SELECT * FROM block_categories ORDER BY position, id")]
    moved, idx, j = _neighbor_swap(con, cats, cat_id, direction)   # W9 单点
    if not moved:
        return {"moved": False, "id": cat_id}
    cats[idx], cats[j] = cats[j], cats[idx]
    ops.reseq(con, "block_categories", [x["id"] for x in cats])
    con.commit()
    return {"moved": True, "id": cat_id, "index": j, "old_index": idx}
