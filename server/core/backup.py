# -*- coding: utf-8 -*-
"""备份能力（自 scripts/export_json.py 迁入 · S4-L2）：全库 JSON 快照 + 导出件剪枝 + 脱敏。

脚本侧只留 CLI 壳（参数/退出码）；写盘走 fsutil 原子写单点。
"""
import time
from pathlib import Path

from core import ai as core_ai
from core import db as core_db
from core import fsutil


def dump_db(con, mask_keys=False):
    """把整库转成可 JSON 化的 dict：meta + schema（建表语句）+ tables（逐表逐行）。
    mask_keys=True：命中 ai.KEY_FIELD 的设置行写 <redacted>，meta.masked_fields 记账（P0·S4-B1）。"""
    names = [r["name"] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    tables = {}
    masked = []
    for n in names:
        rows = [dict(r) for r in con.execute('SELECT * FROM "%s" ORDER BY rowid' % n)]
        if mask_keys:
            for r in rows:
                if r.get("key") == core_ai.KEY_FIELD:
                    r["value"] = "<redacted>"
                    masked.append("%s.%s" % (n, r["key"]))
        tables[n] = rows
    schema = [r["sql"] for r in con.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")]
    return {
        "meta": {
            "app": "shotlist-studio",
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source_db": str(core_db.DB_PATH),
            "masked_fields": masked,
        },
        "schema": schema,
        "tables": tables,
    }


def prune_exports(outdir, keep=20):
    """导出件保留最近 keep 份（P2·S4-C3；失败静默）——与 snapshots 留底思路对齐。"""
    try:
        files = sorted(outdir.glob("studio-*.json"),
                       key=lambda p: (p.stat().st_mtime, p.name))   # 同 mtime 以名定序（FS 粒度兜底）
        for f in files[:-keep]:
            f.unlink()
    except OSError:
        pass


def dump_to(outdir, keep=20, db_path=None):
    """全库导出一击（S4-L2）：只读连接 → dump（脱敏）→ 原子写 → 剪枝。返回 (落盘路径, data)。
    db_path 供测试注入（缺省真库）。"""
    con = core_db.open_ro(db_path)
    try:
        data = dump_db(con, mask_keys=True)
    finally:
        con.close()
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    # 毫秒后缀：同秒两次导出不再静默覆盖（P1·S4-C2）
    ts = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % int(time.time() * 1000 % 1000)
    fname = outdir / ("studio-%s.json" % ts)
    fsutil.dump_json(fname, data, mode=0o664)   # 原子写单点（P1·S4-P5）
    prune_exports(outdir, keep=keep)
    return fname, data
