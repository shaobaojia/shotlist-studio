"""AI 设置接口（M4a）：GET/POST /api/ai/settings；POST /api/ai/test。

安全口径：key 明文永不回传前端（public_config 只有 has_key 布尔）；api_key 留空 = 不改动。
"""
from core import ai, db


def settings_get(m, q):
    con = db.connect()
    try:
        return {"ok": True, "config": ai.public_config(ai.get_config(con))}, 200
    finally:
        con.close()


def settings_set(m, body, q):
    body = body or {}
    if not any(k in body for k in ("provider", "model", "base_url", "api_key")):
        return {"error": "参数不完整（无可写字段）"}, 400
    data = {}
    for src, dst in (("provider", "ai_provider"), ("model", "ai_model"),
                     ("base_url", "ai_base_url")):
        if src in body:
            data[dst] = body[src]
    if "api_key" in body:
        data["api_key"] = body["api_key"]
    con = db.connect(rw=True)
    try:
        cfg = ai.save_config(con, data)
        return {"ok": True, "config": ai.public_config(cfg)}, 200
    finally:
        con.close()


def test(m, body, q):
    con = db.connect()
    try:
        cfg = ai.get_config(con)
    finally:
        con.close()
    try:
        res = ai.test(cfg)
        return {"ok": True, "ms": res["ms"], "model": res["model"],
                "reply": (res["text"] or "").strip()[:50]}, 200
    except ai.AiError as e:
        return {"ok": False, "error": str(e)}, 200
