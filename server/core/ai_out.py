# -*- coding: utf-8 -*-
"""模型输出解析单点（P0·S3-L3 归位）：三域（rewrite/draft/audit）共用。

「模型吐了不该吐的东西」的口径在此显式声明：
- on_fail="raise"：调用方必须当回事（audit——B1 回包有不可解析条目走规则级 error）
- on_fail="empty"：宁缺毋滥（rewrite/draft——失败回 {}，由调用侧决定后续）
失败留痕：fail_note（错误 + 原文长度 + 首 200 字——P0·S3-P5③）。
"""
import json

ITEM_TEXT_MAX = 2000     # 单条改写结果上限（P6①）


def extract_json(text, on_fail="raise"):
    """AI 回包 → dict（取首尾花括号切片解析）。
    on_fail="raise"（缺省）：不可解析抛 ValueError；"empty"：回 {}（P0·S2-§7 自 audit 上收）。"""
    t = (text or "").strip()
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        if on_fail == "empty":
            return {}
        raise ValueError("回包无 JSON 对象（%.60s）" % (t or "空"))
    try:
        obj = json.loads(t[i:j + 1])
    except Exception as e:
        if on_fail == "empty":
            return {}
        raise ValueError("回包 JSON 解析失败：%s" % e)
    if not isinstance(obj, dict):
        if on_fail == "empty":
            return {}
        raise ValueError("回包 JSON 不是对象")
    return obj


def fail_note(text, err):
    """解析失败留痕（P0·S3-P5③）：错误 + 原文长度 + 首 200 字。"""
    t = text or ""
    return "回包不可解析（%s；原文 %d 字：%.200s）" % (err, len(t), t)


def parse_items(text, want):
    """模型输出 → {i: after}；want = 允许的序号集合。严格 JSON；宁缺毋滥。
    §7：解析走 extract_json(on_fail="empty")；失败回 {}（本域「宁缺毋滥」语义）。"""
    data = extract_json(text, on_fail="empty")
    out = {}
    for x in data.get("items") or []:
        if not isinstance(x, dict):
            continue
        try:
            i = int(x.get("i"))
        except (TypeError, ValueError):
            continue
        after = str(x.get("after") or "").strip()
        if i in want and after:
            out[i] = after[:ITEM_TEXT_MAX]
    return out


def norm_option(v, options):
    """裸值归一（P0·S3-P3③）：命中选项全称（先精确、再「选项含裸值」容错——声明序首个）；
    无命中 → None（调用侧决定保底——不再对 options 改标点/字序静默失配）。"""
    t = (v or "").strip()
    if not t:
        return None
    if t in options:
        return t
    for o in options:
        if t in o:
            return o
    return None


def strip_fence(t):
    """剥 ``` 围栏（自 draft 迁入）。"""
    t = (t or "").strip()
    if t.startswith("```"):
        lines = t.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    return t


def clip(s, n):
    """截断单点（超长消息/回包收敛用）。"""
    return (s or "")[:n]
