# -*- coding: utf-8 -*-
"""写路径核心：字段更新 / 批量更新 / 痕迹（历史）/ 值校验（原 ops.py 拆分 · S1-L1）。"""
from datetime import date, datetime
from core import db, fields


# 表级差异位（spec 从 fields 派生；skip_types＝不进写白名单的类型，缺省无）——P0·S1-P1②
# S4-A1：虚拟列（fields.virtual=True）从字段表驱动，不再手抄类型名
def _virtual_types(spec):
    return tuple(f["type"] for f in spec if f.get("virtual"))


TABLES = {
    "shots":  {"skip_types": _virtual_types(fields.SHOT_FIELDS)},
    "beats":  {"skip_types": _virtual_types(fields.BEAT_FIELDS)},
    "scenes": {"skip_types": _virtual_types(fields.SCENE_FIELDS), "extra": ["script"]},   # 表级例外（台本：可写，但不进字段面/表头）
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


# 痕迹接口配额（单源：接口层只做类型解析；P0·S1-P2）
HISTORY_LIMIT_DEFAULT = 100
HISTORY_LIMIT_MAX = 500

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


_NO_EXPECT = object()   # expect 缺省哨兵（P0·S3-W14）


class _StaleError(ValueError):
    """期望现值不匹配（内部信号：批量侧转结果不中断，语义同 skipped）。"""


def _apply_field(con, table, row_id, field, value, source="manual", expect=_NO_EXPECT):
    """单字段更新（不 commit）：白名单 → 取行 → 域层值校验 → expect 裁决 → 写行 → 记痕迹。
    expect（可选）：期望现值——与写入同一次原子裁决（W14：替代「预检 SELECT + 写」两步）。
    返回 (row, changed)。"""
    if field not in write_keys(table):
        raise ValueError("字段不可写：%s.%s" % (table, field))
    row = con.execute("SELECT * FROM %s WHERE id=?" % table, (row_id,)).fetchone()
    if not row:
        raise ValueError("行不存在：%s #%s" % (table, row_id))
    value = _check_field_value(con, table, row_id, field, value)
    old = row[field]
    if expect is not _NO_EXPECT:
        cur = old if old is not None else ""
        e = expect if expect is not None else ""
        v = value if value is not None else ""
        if cur != e and cur != v:     # 等于期望（或已是目标值）才放行——同历史预检语义
            raise _StaleError("原值已变，跳过（不覆盖手工改动）")
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


def touch_row(con, table, row_id, **cols):
    """改列并触碰 updated_at（单点，P0·S3-W1/W10）：不记痕迹、不 commit、无白名单/守卫。
    ⚠ 与 _apply_field 不同：服务于「一次组操作一条聚合痕迹」的写路径（prompts 域）。
    row_id 传列表 → 一 条 IN 更新（同批时间戳取一次，免逐行重算）。"""
    sets = "".join("%s=?, " % c for c in cols) + "updated_at=datetime('now','localtime')"
    if isinstance(row_id, (list, tuple, set)):
        ids = list(row_id)
        if not ids:
            return
        con.execute("UPDATE %s SET %s WHERE id IN (%s)" % (table, sets, db.qmarks(len(ids))),
                    list(cols.values()) + ids)
    else:
        con.execute("UPDATE %s SET %s WHERE id=?" % (table, sets),
                    list(cols.values()) + [row_id])


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
            _row, did = _apply_field(con, table, rid, field, "" if value is None else str(value),
                                     source, expect=it.get("expect", _NO_EXPECT))    # W14：期望随条目
            results.append({"table": table, "id": rid, "field": field, "changed": did})
            if did:
                changed += 1
        except _StaleError as e:
            results.append({"table": table, "id": rid, "field": field,
                            "stale": True, "error": str(e)})
        except ValueError as e:
            results.append({"table": table, "id": rid, "field": field, "error": str(e)})
    con.commit()
    return {"changed": changed, "results": results}


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


def kv_set(con, key, value):
    """settings KV 写单点（P2·S4-C6）：upsert；调用方负责事务提交。"""
    con.execute(
        "INSERT INTO settings (key, value) VALUES (?,?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
    return value
