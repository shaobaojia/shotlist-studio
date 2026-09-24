# -*- coding: utf-8 -*-
"""文本检校与共用判据单点：长度 / 空值 / 分类名 / 上限常量 / is_id（原 prompts.py 拆分 · S3-L1）。"""
from core import fields


MAX_BLOCK_TEXT = 20000   # 块正文长度上限
MAX_CAT_NAME = 40        # 分类名长度上限


is_id = fields.is_id   # 判据已上移 core/fields（P0·S3-B1）；别名保留，旧引用照常。


def _check_len(value, label, max_len):
    """长度校验（返回字符串化的值；None→''）。超限报「{label}过长（上限 N 字）」。"""
    t = "" if value is None else str(value)
    if len(t) > max_len:
        raise ValueError("%s过长（上限 %d 字）" % (label, max_len))
    return t


def _check_text(text):
    t = ("" if text is None else str(text)).strip()
    if not t:
        raise ValueError("块内容不能为空")
    return _check_len(t, "块", MAX_BLOCK_TEXT)


def _check_cat_name(name):
    n = ("" if name is None else str(name)).strip()
    if not n:
        raise ValueError("分类名不能为空")
    if len(n) > MAX_CAT_NAME:
        raise ValueError("分类名过长（上限 %d 字）" % MAX_CAT_NAME)
    return n


