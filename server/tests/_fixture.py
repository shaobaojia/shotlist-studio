#!/usr/bin/env python3
"""共享测试夹具（审计 §三-1）：test_ops / test_prompts 同源——手写 SQL 建状态，不用被测代码搭夹具。"""
import sqlite3
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
SCHEMA = (SERVER / "schema.sql").read_text(encoding="utf-8")


def _conn():
    con = sqlite3.connect(":memory:")
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
