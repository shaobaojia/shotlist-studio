"""提示词域操作（M3）：提示词组（改文 / 并组 / 独立成组 / 拆组 / 状态还原）+ 块库（积木块与分类）。

规则与 core/ops.py 一致：写路径带痕迹（history）、提交在函数内、逻辑为主可单测（tests/test_prompts.py）。
分组模型：一个提示词组（prompt_groups）覆盖 N 个镜头；shots.prompt_group_id 指向组；正文存组上。
并组口径：保留「首个来源组」（按镜头位置先后）的文本；其余来源组文本进痕迹可找回；组空了即删。
独立成组：选中镜头各得一个新空组；原组全文拆出时，文本跟随首个被拆镜头（不丢字）。
"""
import sqlite3


def _hist(con, scene_id, entity, entity_id, field, old, new, source="manual"):
    con.execute(
        "INSERT INTO history (scene_id, entity, entity_id, field, old_value, new_value, source)"
        " VALUES (?,?,?,?,?,?,?)",
        (scene_id, entity, entity_id, field, old, new, source))


def _scene_groups(con, scene_id):
    return [dict(r) for r in con.execute(
        "SELECT * FROM prompt_groups WHERE scene_id=? ORDER BY position, id", (scene_id,))]


def _scene_shots(con, scene_id):
    return [dict(r) for r in con.execute(
        "SELECT * FROM shots WHERE scene_id=? ORDER BY position, id", (scene_id,))]


def _members(con, group_id):
    return [dict(r) for r in con.execute(
        "SELECT id, shot_no, position FROM shots WHERE prompt_group_id=? ORDER BY position, id",
        (group_id,))]


def _labels(members):
    return "镜" + " / ".join(str(m["shot_no"]) for m in members)


def _new_group(con, scene_id):
    cur = con.execute(
        "INSERT INTO prompt_groups (scene_id, position, text) VALUES (?, 0, NULL)", (scene_id,))
    return cur.lastrowid


def prompt_state(con, scene_id):
    """场次提示词分组完整状态（含成员镜号），供前端刷新 / 还原对账。"""
    groups = _scene_groups(con, scene_id)
    shots = _scene_shots(con, scene_id)
    for g in groups:
        mem = [s for s in shots if s["prompt_group_id"] == g["id"]]
        g["member_shots"] = [s["shot_no"] for s in mem]
        g["member_ids"] = [s["id"] for s in mem]
    return groups


def _normalize_positions(con, scene_id):
    """组顺序落定 = 首个成员镜的位置顺序；无成员组排到最后（随后会被清）。"""
    shots = _scene_shots(con, scene_id)
    groups = _scene_groups(con, scene_id)
    first = {}
    for s in shots:
        gid = s["prompt_group_id"]
        if gid is not None and gid not in first:
            first[gid] = (int(s["position"] or 0), s["id"])
    ordered = sorted(groups, key=lambda g: first.get(g["id"], (10 ** 9, g["id"])))
    for i, g in enumerate(ordered):
        if g["position"] != i:
            con.execute("UPDATE prompt_groups SET position=? WHERE id=?", (i, g["id"]))


def _load_shots(con, shot_ids):
    """读取镜头（校验：整数、存在、同一场次），按位置排序返回。"""
    if not isinstance(shot_ids, list) or not shot_ids or not all(isinstance(x, int) for x in shot_ids):
        raise ValueError("参数不完整（shot_ids）")
    ids = list(dict.fromkeys(shot_ids))
    if len(ids) > 500:
        raise ValueError("一次最多 500 镜")
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
    g = con.execute("SELECT * FROM prompt_groups WHERE id=?", (group_id,)).fetchone()
    if not g:
        raise ValueError("提示词组不存在：#%s" % group_id)
    text = "" if text is None else str(text)
    if len(text) > 50000:
        raise ValueError("提示词过长（上限 50000 字）")
    old = g["text"]
    if (old if old is not None else "") == text:
        return {"id": group_id, "text": old, "changed": False}
    con.execute(
        "UPDATE prompt_groups SET text=?, updated_at=datetime('now','localtime') WHERE id=?",
        (text, group_id))
    _hist(con, g["scene_id"], "prompt_groups", group_id, "text", old, text)
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
        con.execute(
            "UPDATE shots SET prompt_group_id=?, updated_at=datetime('now','localtime') WHERE id=?",
            (nid, s["id"]))
        _hist(con, s["scene_id"], "prompt_groups", nid, "create", None, "新建组 · 镜%s" % s["shot_no"])
        _normalize_positions(con, s["scene_id"])
        con.commit()
        return prompt_state(con, s["scene_id"])
    scene_id = shots[0]["scene_id"]
    seen = []
    for s in shots:
        gid = s["prompt_group_id"]
        if gid is not None and gid not in seen:
            seen.append(gid)
    before = {gid: _members(con, gid) for gid in seen}
    target = con.execute("SELECT * FROM prompt_groups WHERE id=?", (seen[0],)).fetchone() if seen else None
    made_new = target is None
    target_id = _new_group(con, scene_id) if made_new else target["id"]
    if not made_new and all(s["prompt_group_id"] == target_id for s in shots):
        return prompt_state(con, scene_id)  # 全员已在一组：无操作
    moved = []
    for s in shots:
        if s["prompt_group_id"] == target_id:
            continue
        con.execute(
            "UPDATE shots SET prompt_group_id=?, updated_at=datetime('now','localtime') WHERE id=?",
            (target_id, s["id"]))
        moved.append(s)
    for gid in seen:
        if gid == target_id or _members(con, gid):
            continue
        g = con.execute("SELECT * FROM prompt_groups WHERE id=?", (gid,)).fetchone()
        if g and (g["text"] or "").strip():
            _hist(con, scene_id, "prompt_groups", gid, "merge",
                  g["text"], "已并入：%s（原 %s）" % (_labels(moved), _labels(before[gid])))
        con.execute("DELETE FROM prompt_groups WHERE id=?", (gid,))
    _hist(con, scene_id, "prompt_groups", target_id, "merge_in", None,
          ("新建组 · " if made_new else "") + "＋" + _labels(moved))
    _normalize_positions(con, scene_id)
    con.commit()
    return prompt_state(con, scene_id)


def detach_shots(con, shot_ids):
    """选中镜头各自独立成组（原组保留其余成员与文本）；已独立 / 未组镜头跳过。"""
    shots = _load_shots(con, shot_ids)
    scene_id = shots[0]["scene_id"]
    before = {}
    made = []  # [(shot, 原组 id)]
    for s in shots:
        gid = s["prompt_group_id"]
        if gid is None:
            continue
        if gid not in before:
            before[gid] = _members(con, gid)
        if len(before[gid]) <= 1:
            continue
        nid = _new_group(con, scene_id)
        con.execute(
            "UPDATE shots SET prompt_group_id=?, updated_at=datetime('now','localtime') WHERE id=?",
            (nid, s["id"]))
        made.append((s, gid))
    if made:
        for gid, mem in before.items():
            left = _members(con, gid)
            if len(left) >= len(mem):
                continue
            out = " / ".join(str(x[0]["shot_no"]) for x in made if x[1] == gid)
            note = ("现 %s · 拆出 %s" % (_labels(left), out)) if left else "全部拆出"
            if not left:
                g = con.execute("SELECT * FROM prompt_groups WHERE id=?", (gid,)).fetchone()
                heir = [x for x in made if x[1] == gid][0][0]
                heir_new = con.execute(
                    "SELECT prompt_group_id FROM shots WHERE id=?", (heir["id"],)).fetchone()
                if g and (g["text"] or "").strip():
                    con.execute(
                        "UPDATE prompt_groups SET text=?, updated_at=datetime('now','localtime')"
                        " WHERE id=?", (g["text"], heir_new["prompt_group_id"]))
                    note += " · 文本随镜%s保留" % heir["shot_no"]
                if g:
                    con.execute("DELETE FROM prompt_groups WHERE id=?", (gid,))
            _hist(con, scene_id, "prompt_groups", gid, "detach", _labels(mem), note)
        _normalize_positions(con, scene_id)
        con.commit()
    return prompt_state(con, scene_id)


def split_group(con, group_id):
    """整组拆开：每镜各自成组；正文留在首镜的原组上，其余新组为空。"""
    g = con.execute("SELECT * FROM prompt_groups WHERE id=?", (group_id,)).fetchone()
    if not g:
        raise ValueError("提示词组不存在：#%s" % group_id)
    members = _members(con, group_id)
    if len(members) <= 1:
        return prompt_state(con, g["scene_id"])
    for m in members[1:]:
        nid = _new_group(con, g["scene_id"])
        con.execute(
            "UPDATE shots SET prompt_group_id=?, updated_at=datetime('now','localtime') WHERE id=?",
            (nid, m["id"]))
    _hist(con, g["scene_id"], "prompt_groups", group_id, "split",
          _labels(members),
          "%s（拆出 %s）" % (_labels(members[:1]), " / ".join(str(m["shot_no"]) for m in members[1:])))
    _normalize_positions(con, g["scene_id"])
    con.commit()
    return prompt_state(con, g["scene_id"])


def restore_state(con, scene_id, groups):
    """撤销/还原：把场次提示词分组整体还原到给定状态。
    groups = [{id?, text, shot_ids:[...]}]（id 缺省=新建；未列出的既有组将删除）。"""
    if not con.execute("SELECT id FROM scenes WHERE id=?", (scene_id,)).fetchone():
        raise ValueError("场景不存在：#%s" % scene_id)
    if not isinstance(groups, list) or len(groups) > 500:
        raise ValueError("参数不完整（groups）")
    all_ids = []
    for g in groups:
        if not isinstance(g, dict):
            raise ValueError("groups 项格式错误")
        ids = g.get("shot_ids") or []
        if not isinstance(ids, list) or not all(isinstance(x, int) for x in ids):
            raise ValueError("shot_ids 格式错误")
        all_ids.extend(ids)
    if all_ids:
        q = ",".join("?" * len(all_ids))
        valid = {r["id"] for r in con.execute(
            "SELECT id FROM shots WHERE scene_id=? AND id IN (%s)" % q, [scene_id] + all_ids)}
        for x in all_ids:
            if x not in valid:
                raise ValueError("镜头不在该场次：#%s" % x)
    keep_ids = set()
    for i, g in enumerate(groups):
        gid = g.get("id")
        row = None
        if isinstance(gid, int):
            row = con.execute(
                "SELECT id FROM prompt_groups WHERE id=? AND scene_id=?", (gid, scene_id)).fetchone()
        if row:
            keep_ids.add(gid)
            con.execute("UPDATE prompt_groups SET text=?, position=? WHERE id=?",
                        (g.get("text"), i, gid))
        else:
            cur = None
            if isinstance(gid, int):
                try:  # 原 id 已被删：复用它（撤销的「完整还原」）
                    cur = con.execute(
                        "INSERT INTO prompt_groups (id, scene_id, position, text) VALUES (?,?,?,?)",
                        (gid, scene_id, i, g.get("text")))
                    keep_ids.add(gid)
                except sqlite3.IntegrityError:
                    cur = None
            if cur is None:
                cur = con.execute(
                    "INSERT INTO prompt_groups (scene_id, position, text) VALUES (?,?,?)",
                    (scene_id, i, g.get("text")))
                g["id"] = cur.lastrowid
                keep_ids.add(cur.lastrowid)
    con.execute("UPDATE shots SET prompt_group_id=NULL WHERE scene_id=?", (scene_id,))
    for g in groups:
        for sid in (g.get("shot_ids") or []):
            con.execute("UPDATE shots SET prompt_group_id=? WHERE id=?", (g["id"], sid))
    for g in _scene_groups(con, scene_id):
        if g["id"] not in keep_ids:
            con.execute("DELETE FROM prompt_groups WHERE id=?", (g["id"],))
    _hist(con, scene_id, "prompt_groups", None, "restore", None, "分组状态还原（%d 组）" % len(groups))
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
    if len(t) > 20000:
        raise ValueError("块过长（上限 20000 字）")
    return t


def _check_cat(con, category_id):
    if category_id is None:
        return
    if not isinstance(category_id, int) or not con.execute(
            "SELECT id FROM block_categories WHERE id=?", (category_id,)).fetchone():
        raise ValueError("分类不存在：#%s" % category_id)


def block_create(con, text, category_id=None):
    t = _check_text(text)
    _check_cat(con, category_id)
    sib = _cat_blocks(con, category_id)
    pos = (sib[-1]["position"] + 1) if sib else 0
    cur = con.execute(
        "INSERT INTO blocks (category_id, text, position, pinned) VALUES (?,?,?,0)",
        (category_id, t, pos))
    con.commit()
    return dict(con.execute("SELECT * FROM blocks WHERE id=?", (cur.lastrowid,)).fetchone())


def block_update(con, block_id, fields):
    """改文本 / 换分类 / 置顶 / 定位（text、category_id、pinned、position；其余键忽略）。

    category_id 或 position 给出时：把块放进目标分类的指定位置——
    position 缺省＝末尾（兼容旧行为）；索引按「去掉自身后的顺序」夹取到 [0, len]。"""
    b = con.execute("SELECT * FROM blocks WHERE id=?", (block_id,)).fetchone()
    if not b:
        raise ValueError("块不存在：#%s" % block_id)
    fields = fields or {}
    if "text" in fields:
        con.execute("UPDATE blocks SET text=? WHERE id=?", (_check_text(fields["text"]), block_id))
    if "pinned" in fields:
        con.execute("UPDATE blocks SET pinned=? WHERE id=?", (1 if fields["pinned"] else 0, block_id))
    if "category_id" in fields or "position" in fields:
        cid = fields.get("category_id", b["category_id"])
        _check_cat(con, cid)
        pos = fields.get("position", None)
        if cid != b["category_id"] or pos is not None:
            try:
                pos = None if pos is None else int(pos)
            except (TypeError, ValueError):
                raise ValueError("position 参数错误")
            tgt = [x for x in _cat_blocks(con, cid) if x["id"] != block_id]
            idx = len(tgt) if pos is None else max(0, min(pos, len(tgt)))
            tgt.insert(idx, {"id": block_id})
            con.execute("UPDATE blocks SET category_id=? WHERE id=?", (cid, block_id))
            for i, x in enumerate(tgt):
                con.execute("UPDATE blocks SET position=? WHERE id=?", (i, x["id"]))
            if b["category_id"] != cid:
                src = [x for x in _cat_blocks(con, b["category_id"]) if x["id"] != block_id]
                for i, x in enumerate(src):
                    con.execute("UPDATE blocks SET position=? WHERE id=?", (i, x["id"]))
    con.commit()
    return dict(con.execute("SELECT * FROM blocks WHERE id=?", (block_id,)).fetchone())


def block_delete(con, block_id):
    b = con.execute("SELECT * FROM blocks WHERE id=?", (block_id,)).fetchone()
    if not b:
        raise ValueError("块不存在：#%s" % block_id)
    con.execute("DELETE FROM blocks WHERE id=?", (block_id,))
    con.commit()
    return dict(b)


def block_move(con, block_id, direction):
    """同分类内与相邻块换位（direction = -1 上移 / 1 下移）。"""
    b = con.execute("SELECT * FROM blocks WHERE id=?", (block_id,)).fetchone()
    if not b:
        raise ValueError("块不存在：#%s" % block_id)
    if direction not in (-1, 1):
        raise ValueError("方向参数错误")
    sib = _cat_blocks(con, b["category_id"])
    idx = next(i for i, x in enumerate(sib) if x["id"] == block_id)
    j = idx + direction
    if j < 0 or j >= len(sib):
        raise ValueError("已经到头了")
    sib[idx], sib[j] = sib[j], sib[idx]
    for i, x in enumerate(sib):
        con.execute("UPDATE blocks SET position=? WHERE id=?", (i, x["id"]))
    con.commit()


def cat_create(con, name):
    n = ("" if name is None else str(name)).strip()
    if not n:
        raise ValueError("分类名不能为空")
    if len(n) > 40:
        raise ValueError("分类名过长（上限 40 字）")
    row = con.execute("SELECT MAX(position) AS p FROM block_categories").fetchone()
    pos = (row["p"] + 1) if row and row["p"] is not None else 0
    cur = con.execute("INSERT INTO block_categories (name, position) VALUES (?,?)", (n, pos))
    con.commit()
    return dict(con.execute("SELECT * FROM block_categories WHERE id=?", (cur.lastrowid,)).fetchone())


def cat_update(con, cat_id, name):
    n = ("" if name is None else str(name)).strip()
    if not n:
        raise ValueError("分类名不能为空")
    if len(n) > 40:
        raise ValueError("分类名过长（上限 40 字）")
    if not con.execute("SELECT id FROM block_categories WHERE id=?", (cat_id,)).fetchone():
        raise ValueError("分类不存在：#%s" % cat_id)
    con.execute("UPDATE block_categories SET name=? WHERE id=?", (n, cat_id))
    con.commit()
    return dict(con.execute("SELECT * FROM block_categories WHERE id=?", (cat_id,)).fetchone())


def cat_delete(con, cat_id):
    """删分类：其下块落「未分类」（category_id=NULL），不连带删块。"""
    if not con.execute("SELECT id FROM block_categories WHERE id=?", (cat_id,)).fetchone():
        raise ValueError("分类不存在：#%s" % cat_id)
    con.execute("UPDATE blocks SET category_id=NULL WHERE category_id=?", (cat_id,))
    con.execute("DELETE FROM block_categories WHERE id=?", (cat_id,))
    con.commit()


def cat_move(con, cat_id, direction):
    if direction not in (-1, 1):
        raise ValueError("方向参数错误")
    cats = [dict(r) for r in con.execute("SELECT * FROM block_categories ORDER BY position, id")]
    idx = next((i for i, x in enumerate(cats) if x["id"] == cat_id), None)
    if idx is None:
        raise ValueError("分类不存在：#%s" % cat_id)
    j = idx + direction
    if j < 0 or j >= len(cats):
        raise ValueError("已经到头了")
    cats[idx], cats[j] = cats[j], cats[idx]
    for i, x in enumerate(cats):
        con.execute("UPDATE block_categories SET position=? WHERE id=?", (i, x["id"]))
    con.commit()
