"""接口层：组装 JSON 载荷。GET handler：(match, query)；POST handler：(match, body, query)。"""
import sqlite3
import sys
from urllib.parse import unquote

from api import _guard as guard
from api import params
from core import db, fields, ops


def health(m, q):
    return {"ok": True, "service": "shotlist-studio"}, 200


def meta(m, q):
    obj = fields.meta()

    def run(con):
        obj["beat_kinds"] = db.beat_kinds(con)   # 读库单点（P0·S1-W12）
        return obj, 200

    try:
        return guard.read(run)
    except (sqlite3.Error, OSError) as e:            # 收窄兜底 + 留痕（P0·S1-P5①）
        sys.stderr.write("meta: beat_kinds 读取失败：%s\n" % e)
        obj["beat_kinds"] = []
        return obj, 200


def film(m, q):
    def run(con):
        f = db.film(con)
        if not f:
            return guard.err("库里还没有影片—先跑迁移脚本", 404)
        return {"film": {"id": f["id"], "title": f["title"]},
                "scenes": db.scenes(con, f["id"])}, 200

    return guard.read(run)


def scene(m, q):
    scene_no = unquote(m.group(1))

    def run(con):
        sc, gone = guard.scene_or_404(con, scene_no)
        if gone:
            return gone
        _, beats, shots = db.scene_ctx(con, sc["id"])   # 整场装载单点（P0·S1-W1）
        groups = db.prompt_groups(con, sc["id"])

        orphan = db.attach_shots_by_beat(beats, shots)   # 分桶单点（P2·S4-A9；含残留键兜底）

        db.attach_group_members(groups, shots)

        payload = {"scene": sc, "beats": beats, "prompt_groups": groups}
        if orphan:
            payload["orphan_shots"] = orphan
        return payload, 200

    return guard.read(run)


def history(m, q):
    sid_raw = params.q1(q, "scene_id")
    sid = None
    if sid_raw not in (None, ""):
        try:
            sid = params.as_int(sid_raw, "scene_id")
        except ValueError as e:
            return guard.err(str(e))   # 非数字 → 400（不再 500；P0·S1-B3）
    try:
        limit = params.as_int(params.q1(q, "limit") or str(ops.HISTORY_LIMIT_DEFAULT), "limit")
    except ValueError:
        limit = ops.HISTORY_LIMIT_DEFAULT

    def run(con):
        return {"history": ops.history_of(con, sid, limit)}, 200   # 上限钳制在 ops（P0·S1-P2④）

    return guard.read(run)


def update(m, body, q):
    """M2 写路径：单字段更新（白名单 + 痕迹）。"""
    table = body.get("table")
    row_id = body.get("id")
    field = body.get("field")
    value = body.get("value")
    if table not in ops.TABLES_ALLOWED or not fields.is_id(row_id) or not field:
        return guard.err("参数不完整（table/id/field）")
    # 场号 trim/非空/唯一校验已下沉 ops._apply_field（update / batch 同源；P0·S1-B1）

    def run(con):
        row, changed = ops.update_field(con, table, row_id, field,
                                        "" if value is None else str(value))
        return {"ok": True, "changed": changed, "row": row}, 200

    return guard.write(run)


def batch(m, body, q):
    """M2-4 写路径：批量单字段更新（逐项白名单 + 痕迹；上限 400 项）。"""
    items = body.get("ops")
    if not isinstance(items, list) or not items:
        return guard.err("参数不完整（ops）")
    if len(items) > fields.BATCH_MAX:
        return guard.err("一次最多 %d 项" % fields.BATCH_MAX)

    def run(con):
        res = ops.batch_update(con, items)
        return {"ok": True, "changed": res["changed"], "results": res["results"]}, 200

    return guard.write(run)


def move(m, body, q):
    table = body.get("table")
    rid = body.get("id")
    ids = body.get("ids")
    index = body.get("index", 0)
    ok_ids = isinstance(ids, list) and len(ids) >= 1 and all(fields.is_id(x) for x in ids)
    err_params = guard.err("参数不完整（table/id/index）")   # 同函数三处同文案（P0·S1-P4④）
    if table not in ops.TABLES_ALLOWED or not (fields.is_id(rid) or ok_ids):
        return err_params

    def run(con):
        if table == "shots":
            bid = body.get("beat_id")
            if not fields.is_id(bid):
                return guard.err("缺少目标节拍 beat_id")
            if ok_ids:
                res = ops.move_shots(con, ids, bid, index)   # 多行整组（M5 批2）
            else:
                res = ops.move_shot(con, rid, bid, index)
        elif table == "beats":
            if not fields.is_id(rid):
                return err_params
            res = ops.move_beat(con, rid, index)
        else:
            if not fields.is_id(rid):
                return err_params
            res = ops.move_scene(con, rid, index)
        return {"ok": True, "moved": res}, 200

    return guard.write(run)


def renumber(m, body, q):
    """M2 整理镜号：按当前顺序整场顺排；旧号入痕迹。"""
    scene_no = unquote(m.group(1))

    def run(con):
        sc, gone = guard.scene_or_404(con, scene_no)
        if gone:
            return gone
        return {"ok": True, "changes": ops.renumber_scene(con, sc["id"])}, 200

    return guard.write(run)


def duplicate(m, body, q):
    """M2-5/6 副本：镜头行 / 节拍（连镜头）/ 场次（整场）深拷。table 必填显式（不再默认 shots；P0·S1-P1④）。"""
    table = body.get("table")
    rid = body.get("id")
    if table not in ops.TABLES_ALLOWED or not fields.is_id(rid):
        return guard.err("参数不完整（table/id）")

    def run(con):
        if table == "shots":
            return {"ok": True, "shot": ops.duplicate_shot(con, rid)}, 200
        if table == "beats":
            return {"ok": True, "beat": ops.duplicate_beat(con, rid)}, 200
        return {"ok": True, "scene": ops.duplicate_scene(con, rid)}, 200

    return guard.write(run)


def delete_row(m, body, q):
    """M2-6 删除：镜头行（可多行）/ 节拍（镜头落未归或连删）/ 场次（整场级联）；返回快照供撤销。
    防呆：table 必填显式（不再默认 shots——误删事故根因，2026-09-22 收口）。"""
    table = body.get("table")
    if table not in ops.TABLES_ALLOWED:
        return guard.err("缺少或非法 table（不默认 shots）")
    ids = body.get("ids")
    if ids is None and fields.is_id(body.get("id")):
        ids = [body.get("id")]
    if not isinstance(ids, list) or not ids \
            or not all(fields.is_id(x) for x in ids):
        return guard.err("参数不完整（table + id/ids）")
    if len(ids) > fields.DELETE_MAX:
        return guard.err("一次最多 %d 行" % fields.DELETE_MAX)

    def run(con):
        if table == "shots":
            return {"ok": True, "deleted": {"rows": ops.delete_shots(con, ids)}}, 200
        if len(ids) != 1:
            return guard.err("该删除一次只能一项")
        if table == "beats":
            res = ops.delete_beat(con, ids[0], with_shots=bool(body.get("with_shots")))
            return {"ok": True, "deleted": res}, 200
        return {"ok": True, "deleted": ops.delete_scene(con, ids[0])}, 200

    return guard.write(run)


def create(m, body, q):
    """M2-6 创建：空镜头（可指定插入位）/ 空节拍（末尾）/ 空场（末尾）。守卫先于写连接（P0·S1-P4①）。"""
    kind = body.get("kind")
    if kind not in ("shot", "beat", "scene"):
        return guard.err("未知 kind：%s" % kind)
    scene_id = body.get("scene_id")
    beat_id = body.get("beat_id")
    index = body.get("index", 0)
    if kind == "shot":
        if not fields.is_id(scene_id) or not fields.is_id(index) \
                or (beat_id is not None and not fields.is_id(beat_id)):
            return guard.err("参数不完整（scene_id/beat_id/index）")
    elif kind == "beat":
        if not fields.is_id(scene_id):
            return guard.err("参数不完整（scene_id）")

    def run(con):
        if kind == "shot":
            return {"ok": True, "shot": ops.create_blank_shot(con, scene_id, beat_id, index)}, 200
        if kind == "beat":
            return {"ok": True, "beat": ops.create_beat(con, scene_id)}, 200
        return {"ok": True, "scene": ops.create_scene(con)}, 200

    return guard.write(run)


def restore(m, body, q):
    """M2-6 撤销专用还原：删行 / 删节拍 / 删场 的完整回插。守卫先于写连接（P0·S1-P4①）。"""
    kind = body.get("kind")
    if kind not in ("shots", "beat", "scene"):
        return guard.err("未知 kind：%s" % kind)
    rows = body.get("rows")
    beat = body.get("beat")
    shot_ids = body.get("shot_ids") or []
    payload = body.get("payload")
    if kind == "shots":
        if not isinstance(rows, list) or not rows:
            return guard.err("参数不完整（rows）")
    elif kind == "beat":
        if not isinstance(beat, dict):
            return guard.err("参数不完整（beat）")
    else:
        if not isinstance(payload, dict) or not isinstance(payload.get("scene"), dict):
            return guard.err("参数不完整（payload）")

    def run(con):
        if kind == "shots":
            return {"ok": True, "shots": ops.restore_shots(con, rows)}, 200
        if kind == "beat":
            return {"ok": True, "beat": ops.restore_beat(con, beat, shot_ids)}, 200
        return {"ok": True, "scene": ops.restore_scene_full(con, payload)}, 200

    return guard.write(run)


def lock(m, body, q):
    """M2-7 锁定本场：场次版本快照（落盘 + snapshots 记录）+ 锁定标记（锁定 ≠ 禁止编辑）。"""
    rid = body.get("id")
    lock_flag = bool(body.get("lock", True))
    if not fields.is_id(rid):
        return guard.err("参数不完整（id）")

    def run(con):
        return {"ok": True, **ops.lock_scene(con, rid, lock_flag)}, 200

    return guard.write(run)
