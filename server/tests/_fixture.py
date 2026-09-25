#!/usr/bin/env python3
"""共享测试夹具（审计 §三-1）：test_ops / test_prompts 同源——手写 SQL 建状态，不用被测代码搭夹具。"""
import sqlite3
import time
from contextlib import contextmanager

import _boot   # 引导单点（P2·S4-P3）

SCHEMA = (_boot.SERVER / "schema.sql").read_text(encoding="utf-8")

from core import ops as _ops   # noqa: E402  只借常量（BEAT_KIND_DEFAULT）；夹具仍手写 SQL


def wait_job(m, jid, timeout=15):
    """轮询到任务终态（单点，P2·S4-P4）：非 running 即返回；超时抛断言。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = m.get(jid)
        if j and not j["running"]:
            return j
        time.sleep(0.05)
    raise AssertionError("job 未在限时内完成")


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
    con.execute("INSERT INTO beats (scene_id, beat_no, name, kind) VALUES (1, '1', '被领导打压', ?)",
                (_ops.BEAT_KIND_DEFAULT,))
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


def conn_factory(db_path, timeout=10):
    """临时库连接工厂（与生产 rw 连接同形；注入 job 类 connect_factory 用，批4/P12；
    P0·S1-P3④ 上收 test_audit 三处手抄）。"""
    def f():
        con = sqlite3.connect(db_path, timeout=timeout)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        return con
    return f


def make_conn(db_path=None):
    """schema 载入的标准连接（公开别名 · M8 清理刀）：内存库或文件库，生产同款 PRAGMA。"""
    return _conn(db_path)


def fake_rw(con):
    """假写连接工厂（M8 清理刀；envelope 测试用）：`with mock.patch("core.db.conn_rw", fake_rw(con)):`。"""
    @contextmanager
    def f(db_path=None):
        yield con
    return f


def make_base_db(db_path=None):
    """通用基准库（审计/创作/草稿共用）：1 场 2 节拍 4 镜。
    基线问题：景别空×1（镜02）、声音空带台词×1（镜02）、戏点密度×1、戏点缺特写×1。"""
    con = _conn(db_path)
    con.execute("INSERT INTO films (title) VALUES ('t')")
    con.execute("INSERT INTO scenes (film_id, scene_no, title, value, pole_start, pole_end)"
                " VALUES (1, 's010', '第一场', '控制', '维持', '失控')")
    con.execute("INSERT INTO beats (scene_id, beat_no, kind, name, outside_action, reaction, closed_loop)"
                " VALUES (1, '1', ?, '被领导打压', '领导来电话吼骂', '男人僵住', '是')",
                (_ops.BEAT_KIND_DEFAULT,))
    con.execute("INSERT INTO beats (scene_id, beat_no, kind, name, outside_action, reaction, closed_loop)"
                " VALUES (1, '2', '🔴 戏点', '误发消息', '消息误发', '男人瞳孔收缩', '是')")
    rows = [("01", 1, "中景", "—", ""), ("02", 1, "", "", "「喂？」"),
            ("03", 2, "近景", "—", ""), ("04", 2, "近景", "—", "")]
    for i, (no, bid, size, audio, dlg) in enumerate(rows, start=1):
        con.execute("INSERT INTO shots (scene_id, beat_id, position, shot_no, shot_size, audio, dialogue)"
                    " VALUES (1,?,?,?,?,?,?)", (bid, i, no, size, audio, dlg))
    con.commit()
    return con
