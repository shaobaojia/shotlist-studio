#!/usr/bin/env python3
"""飞书两表全量导出留档（纯保险）。

用法：python3 scripts/archive/export_feishu_raw.py [--config PATH] [--out DIR]
（归档工具：保险性原始数据导出，人工运行；已从一条命令管线除名）

- 凭证读库外配置（默认老库目录 feishu_config.json），不打印、不入库
- 分页拉取 分镜表 / 分析表 全部记录 + 字段定义，原样 JSON 落盘
"""
import argparse, json, sys, urllib.request
from datetime import datetime, date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # scripts/archive/ 深一层（归档后修正）
sys.path.insert(0, str(ROOT / "server"))

from core import fsutil  # noqa: E402

DEFAULT_CONFIG = "/opt/data/skills/scriptwriting/storyboard-shotlist/feishu_config.json"
API = "https://open.feishu.cn/open-apis"

def api(url, token=None, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def get_token(cfg):
    r = api(API + "/auth/v3/tenant_access_token/internal",
            payload={"app_id": cfg["app_id"], "app_secret": cfg["app_secret"]})
    if r.get("code") != 0:
        raise SystemExit("token failed: %s %s" % (r.get("code"), r.get("msg")))
    return r["tenant_access_token"]

def fetch_all_records(app, table, token):
    items, page = [], ""
    while True:
        url = "%s/bitable/v1/apps/%s/tables/%s/records?page_size=500" % (API, app, table)
        if page:
            url += "&page_token=" + page
        r = api(url, token)
        if r.get("code") != 0:
            raise SystemExit("records failed: %s %s" % (r.get("code"), r.get("msg")))
        d = r["data"]
        items += d.get("items", [])
        if not d.get("has_more"):
            break
        nxt = d.get("page_token", "")
        if not nxt or nxt == page:
            break   # 兜底：has_more 却无/重复 token 时不打转（P1·S4-C4）
        page = nxt
    return items

def fetch_fields(app, table, token):
    """字段定义全量拉取（P1·S4-C4：补翻页，>100 字段不再静默少写）。"""
    items, page = [], ""
    while True:
        url = "%s/bitable/v1/apps/%s/tables/%s/fields?page_size=100" % (API, app, table)
        if page:
            url += "&page_token=" + page
        r = api(url, token)
        if r.get("code") != 0:
            raise SystemExit("fields failed: %s %s" % (r.get("code"), r.get("msg")))
        d = r["data"]
        items += d.get("items", [])
        if not d.get("has_more"):
            break
        nxt = d.get("page_token", "")
        if not nxt or nxt == page:
            break   # 兜底（P1·S4-C4）
        page = nxt
    return items

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    app = cfg["app_token"]
    tables = {"storyboard": cfg["table_id"], "analysis": cfg["analysis_table_id"]}
    out = Path(args.out) if args.out else Path(__file__).resolve().parents[2] / "data" / "archive" / ("feishu-" + date.today().isoformat())
    out.mkdir(parents=True, exist_ok=True)

    token = get_token(cfg)
    meta = {"fetched_at": datetime.now().isoformat(timespec="seconds"),
            "app_token": app, "tables": {}}
    for label, tid in tables.items():
        recs = fetch_all_records(app, tid, token)
        fields = fetch_fields(app, tid, token)
        fsutil.dump_json(out / (label + ".json"), recs)          # 原子写单点（P1·S4-P5）
        fsutil.dump_json(out / (label + "_fields.json"), fields)
        meta["tables"][label] = {"table_id": tid, "record_count": len(recs), "field_count": len(fields)}
        print("%s: %d records / %d fields" % (label, len(recs), len(fields)))
    fsutil.dump_json(out / "meta.json", meta)   # 原子写单点（P1·S4-P5）
    print("saved:", out)

if __name__ == "__main__":
    main()
