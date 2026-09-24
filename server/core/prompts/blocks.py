# -*- coding: utf-8 -*-
"""块库域：块 CRUD / 分类 CRUD / 移动（原 prompts.py 拆分 · S3-L1）。"""
from core import fields, ops
from .text import is_id, _check_text, _check_cat_name


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


def _check_cat(con, category_id):
    if category_id is None:
        return
    if not is_id(category_id):
        raise ValueError("分类参数错误：%r" % (category_id,))
    if not con.execute("SELECT id FROM block_categories WHERE id=?", (category_id,)).fetchone():
        raise ValueError("分类不存在：#%s" % category_id)


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

