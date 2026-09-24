# -*- coding: utf-8 -*-
"""接口层参数单点（P0·S1-P4③）：query 单值 / 整数解析 / 表名校验。"""
from core import ops


def q1(q, name):
    """query 单值（缺省 None）。"""
    return (q.get(name) or [None])[0]


def as_int(raw, name):
    """query 字符串 → int；非法 → ValueError（400 文案由调用方回包）。"""
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError("参数不完整（%s）" % name)


def req_table(body):
    """POST body 的表名（合法域＝ops.TABLES_ALLOWED）；非法 → ValueError。"""
    table = body.get("table")
    if table not in ops.TABLES_ALLOWED:
        raise ValueError("参数不完整（table）")
    return table
