# -*- coding: utf-8 -*-
"""编号策略单点（W6）：镜号 / 节拍号 / 场号 / 字母后缀（原 ops.py 拆分 · S1-L1）。"""
import re
import string


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


def follow_no(mx, k, width=0):
    """追号单点（M8 清理刀）：最大数字 mx 起，顺延第 k 个（0 基）。
    width=2 → %02d 补零（01、02…）；0 → 纯数字（1、2…）。"""
    n = mx + 1 + k
    return ("%0*d" % (width, n)) if width else str(n)


def _next_scene_no(con, film_id):
    """下一个场号：本工程内最大数字 +10，步进风格 sNNN（s010→s090；冲突顺延）。
    唯一性按工程（M8 清理刀：跨工程互不影响）。"""
    mx = 0
    for r in con.execute("SELECT scene_no FROM scenes WHERE film_id=?", (film_id,)):
        m = re.match(r"^s(\d+)$", (r["scene_no"] or "").strip())
        if m:
            mx = max(mx, int(m.group(1)))
    n = (mx + 10) if mx else 10
    taken = {(r["scene_no"] or "") for r in con.execute(
        "SELECT scene_no FROM scenes WHERE film_id=?", (film_id,))}
    while ("s%03d" % n) in taken:
        n += 10
    return "s%03d" % n


def _next_beat_no(con, scene_id, base):
    """单件调用（查库版）：duplicate_beat 用（大小写统一归一对标）。"""
    taken = {(r["beat_no"] or "").strip().upper() for r in
             con.execute("SELECT beat_no FROM beats WHERE scene_id=?", (scene_id,))}
    return _next_letter_no(taken, base)


