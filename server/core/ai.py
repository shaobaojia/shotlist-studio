"""AI 通道（M4）：设置存 settings 表（本地库、不入 git）；OpenAI 兼容 chat/completions 直连。零依赖（urllib）。

约定：key 明文永不出后端——api 层只回传 public_config()（has_key 布尔）。
"""
import json
import time
import urllib.error
import urllib.request

DEFAULTS = {
    "ai_provider": "deepseek",
    "ai_model": "deepseek-flash",
    "ai_base_url": "https://api.deepseek.com",
}
KEY_FIELD = "ai_api_key"
CONFIG_FIELDS = ("ai_provider", "ai_model", "ai_base_url")


class AiError(RuntimeError):
    pass


def get_config(con):
    """读 AI 配置；key 缺省为空串。"""
    rows = {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM settings")}
    cfg = {k: (rows.get(k) or DEFAULTS[k]) for k in CONFIG_FIELDS}
    cfg["api_key"] = rows.get(KEY_FIELD) or ""
    cfg["has_key"] = bool(cfg["api_key"])
    return cfg


def save_config(con, data):
    """更新配置：文本字段传空串 = 清回默认（M14）；api_key 传非空才落（空 = 不改）。
    返回最新配置（含明文 key——仅限进程内使用；对前端一律走 public_config）。"""
    for k in CONFIG_FIELDS:
        if k not in (data or {}):
            continue
        v = str((data or {}).get(k) or "").strip()
        if v:
            con.execute(
                "INSERT INTO settings (key, value) VALUES (?,?)"
                " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
        else:
            con.execute("DELETE FROM settings WHERE key=?", (k,))
    key = (data or {}).get("api_key")
    if isinstance(key, str) and key.strip():
        con.execute(
            "INSERT INTO settings (key, value) VALUES (?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (KEY_FIELD, key.strip()))
    con.commit()
    return get_config(con)


def public_config(cfg):
    """给前端的脱敏视图（永不回传 key 明文）。"""
    return {"provider": cfg["ai_provider"], "model": cfg["ai_model"],
            "base_url": cfg["ai_base_url"], "has_key": cfg["has_key"]}


def chat(cfg, messages, temperature=0.2, timeout=180):
    """一次对话调用（非流式）。失败抛 AiError。返回 {text, ms, model}。"""
    if not cfg.get("api_key"):
        raise AiError("未配置 API Key")
    url = cfg["ai_base_url"].rstrip("/") + "/chat/completions"
    body = json.dumps({"model": cfg["ai_model"], "messages": messages,
                       "temperature": temperature, "stream": False}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg["api_key"],
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise AiError("HTTP %s：%s" % (e.code, detail))
    except Exception as e:
        raise AiError("网络错误：%s" % e)
    try:
        obj = json.loads(raw)
        text = obj["choices"][0]["message"]["content"]
    except Exception:
        raise AiError("响应解析失败：%s" % raw[:300])
    return {"text": text, "ms": int((time.time() - t0) * 1000), "model": cfg["ai_model"]}


def probe(cfg):
    """连通性小测：一句话往返（原名 test——与接口层 handler 重名易混，批3 改名）。"""
    return chat(cfg, [{"role": "user", "content": "只回复两个字：在的"}], temperature=0, timeout=30)
