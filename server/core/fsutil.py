#!/usr/bin/env python3
"""写盘单点（P1·S4-P5）：原子写 + JSON dump。

纪律：tmp 同目录 → os.replace；失败清 .tmp 残留（finally）。
四站收编：export_json / export_feishu_raw / ops.lock_scene（recipes._write_atomic 为同族真源）。
"""
import json
import os
from pathlib import Path


def atomic_write(path, text, mode=None):
    """原子写文本（tmp + os.replace，同目录）；任何失败都清 .tmp 残留。"""
    p = Path(path)
    tmp = p.with_name(p.name + ".tmp")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, p)
        if mode is not None:
            os.chmod(p, mode)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def dump_json(path, obj, indent=1, mode=None):
    """原子写 JSON（ensure_ascii=False；indent 口径内嵌）。"""
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=indent), mode=mode)
