#!/usr/bin/env python3
"""共享测试夹具（审计 §三-1）：test_ops / test_prompts 同源——手写 SQL 建状态，不用被测代码搭夹具。"""
import sqlite3
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
SCHEMA = (SERVER / "schema.sql").read_text(encoding="utf-8")


def _conn(db_path=None):
    con = sqlite3.connect(db_path or ":memory:")
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")  # 与生产 rw 连接一致（删场级联依赖它）
    con.executescript(SCHEMA)
    return con


def make_ops_db():
    """ops 基准库：1 场（s010）1 节拍 3 镜 [03, 01, 17A]（位 1-3，非 0 基）。"""
    con = _conn()
    con.execute("INSERT INTO films (title) VALUES ('t')")
    con.execute("INSERT INTO scenes (film_id, scene_no, title, value) VALUES (1, 's010', '第一场', '控制')")
    con.execute("INSERT INTO beats (scene_id, beat_no, name, kind) VALUES (1, '1', '被领导打压', '⚪ 填充')")
    for i, no in enumerate(["03", "01", "17A"], start=1):
        con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no, blocking) VALUES (1, 1, ?, ?, ?)",
                    (i, no, "动作%d" % i))
    con.commit()
    return con


def make_ops_db0():
    """ops 基准库 + position 规整为 0 基（结构操作 index 语义 = 0 基场序）。"""
    con = make_ops_db()
    ids = [r["id"] for r in con.execute("SELECT id FROM shots WHERE scene_id=1 ORDER BY position")]
    for i, sid in enumerate(ids):
        con.execute("UPDATE shots SET position=? WHERE id=?", (i, sid))
    con.commit()
    return con


def make_prompts_db():
    """提示词域基准库：1 场 7 镜（位 1-7）；组 g1=01/02、g2=03/04、g3=05；06/07 无组。"""
    con = _conn()
    con.execute("INSERT INTO films (title) VALUES ('t')")
    con.execute("INSERT INTO scenes (film_id, scene_no, title) VALUES (1, 's010', '第一场')")
    con.execute("INSERT INTO beats (scene_id, beat_no, name) VALUES (1, '1', 'b1')")
    for i, no in enumerate(["01", "02", "03", "04", "05", "06", "07"], start=1):
        con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no) VALUES (1, 1, ?, ?)", (i, no))
    con.execute("INSERT INTO prompt_groups (id, scene_id, position, text) VALUES (1, 1, 0, '组一文本')")
    con.execute("INSERT INTO prompt_groups (id, scene_id, position, text) VALUES (2, 1, 1, '组二文本')")
    con.execute("INSERT INTO prompt_groups (id, scene_id, position, text) VALUES (3, 1, 2, '组五文本')")
    con.execute("UPDATE shots SET prompt_group_id=1 WHERE id IN (1,2)")
    con.execute("UPDATE shots SET prompt_group_id=2 WHERE id IN (3,4)")
    con.execute("UPDATE shots SET prompt_group_id=3 WHERE id=5")
    con.commit()
    return con


def conn_factory(db_path):
    """临时库连接工厂（与生产 rw 连接同形；注入 job 类 connect_factory 用，批4/P12）。"""
    def f():
        con = sqlite3.connect(db_path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        return con
    return f


def make_base_db(db_path=None):
    """通用基准库（审计/创作/草稿共用）：1 场 2 节拍 4 镜。
    基线问题：景别空×1（镜02）、声音空带台词×1（镜02）、戏点密度×1、戏点缺特写×1。"""
    con = _conn(db_path)
    con.execute("INSERT INTO films (title) VALUES ('t')")
    con.execute("INSERT INTO scenes (film_id, scene_no, title, value, pole_start, pole_end)"
                " VALUES (1, 's010', '第一场', '控制', '维持', '失控')")
    con.execute("INSERT INTO beats (scene_id, beat_no, kind, name, outside_action, reaction, closed_loop)"
                " VALUES (1, '1', '⚪ 填充', '被领导打压', '领导来电话吼骂', '男人僵住', '是')")
    con.execute("INSERT INTO beats (scene_id, beat_no, kind, name, outside_action, reaction, closed_loop)"
                " VALUES (1, '2', '🔴 戏点', '误发消息', '消息误发', '男人瞳孔收缩', '是')")
    rows = [("01", 1, "中景", "—", ""), ("02", 1, "", "", "「喂？」"),
            ("03", 2, "近景", "—", ""), ("04", 2, "近景", "—", "")]
    for i, (no, bid, size, audio, dlg) in enumerate(rows, start=1):
        con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no, shot_size, audio, dialogue)"
                    " VALUES (1,?,?,?,?,?,?)", (bid, i, no, size, audio, dlg))
    con.commit()
    return con
