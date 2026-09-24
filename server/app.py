#!/usr/bin/env python3
"""shotlist-studio 服务：路由（薄，GET 读 + POST 写）+ 静态托管。运行：python3 server/app.py [--port 8094]"""
import argparse
import json
import os
import re
import sys
import traceback
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
from api import handlers  # noqa: E402
from api import prompts as prompts_api  # noqa: E402
from api import audit as audit_api  # noqa: E402
from api import ai as ai_api  # noqa: E402
from api import recipes as recipes_api  # noqa: E402
from api import draft as draft_api  # noqa: E402
from api import export as export_api  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = (ROOT / "web").resolve()

ROUTES = [
    (re.compile(r"^/api/health$"), handlers.health),
    (re.compile(r"^/api/export$"), export_api.export_get),   # 统一路由表（原 do_GET 特判退役）——P0·S1-W18
    (re.compile(r"^/api/meta$"), handlers.meta),
    (re.compile(r"^/api/film$"), handlers.film),
    (re.compile(r"^/api/scenes/([^/]+)$"), handlers.scene),
    (re.compile(r"^/api/history$"), handlers.history),
    (re.compile(r"^/api/blocks$"), prompts_api.blocks),
    (re.compile(r"^/api/audit$"), audit_api.audit_get),
    (re.compile(r"^/api/audit/rules$"), audit_api.rules_get),
    (re.compile(r"^/api/audit/summary$"), audit_api.summary),
    (re.compile(r"^/api/ai/settings$"), ai_api.settings_get),
    (re.compile(r"^/api/ai/job$"), ai_api.job_get),
    (re.compile(r"^/api/recipes$"), recipes_api.list_get),
    (re.compile(r"^/api/recipes/get$"), recipes_api.get_get),
    (re.compile(r"^/api/ai/draft/job$"), draft_api.job_get),
]

POST_ROUTES = [
    (re.compile(r"^/api/update$"), handlers.update),
    (re.compile(r"^/api/batch$"), handlers.batch),
    (re.compile(r"^/api/scenes/([^/]+)/renumber$"), handlers.renumber),
    (re.compile(r"^/api/move$"), handlers.move),
    (re.compile(r"^/api/duplicate$"), handlers.duplicate),
    (re.compile(r"^/api/delete$"), handlers.delete_row),
    (re.compile(r"^/api/create$"), handlers.create),
    (re.compile(r"^/api/restore$"), handlers.restore),
    (re.compile(r"^/api/lock$"), handlers.lock),
    (re.compile(r"^/api/blocks$"), prompts_api.blocks_op),
    (re.compile(r"^/api/prompt/([a-z_]+)$"), prompts_api.prompt_op),
    (re.compile(r"^/api/audit/run$"), audit_api.run),
    (re.compile(r"^/api/audit/issue$"), audit_api.issue_op),
    (re.compile(r"^/api/audit/rules$"), audit_api.rules_op),
    (re.compile(r"^/api/ai/settings$"), ai_api.settings_set),
    (re.compile(r"^/api/ai/test$"), ai_api.test),
    (re.compile(r"^/api/ai/preview$"), ai_api.preview),
    (re.compile(r"^/api/ai/apply$"), ai_api.apply_op),
    (re.compile(r"^/api/recipes/save$"), recipes_api.save_post),
    (re.compile(r"^/api/recipes/default$"), recipes_api.default_post),
    (re.compile(r"^/api/ai/draft$"), draft_api.start),
    (re.compile(r"^/api/ai/draft/prompt$"), draft_api.prompt),
    (re.compile(r"^/api/ai/draft/apply$"), draft_api.apply_op),
]

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, body, status=200, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, status=200):
        self._send(json.dumps(obj, ensure_ascii=False).encode("utf-8"), status)

    def _dispatch(self, routes, path, *args):
        """路由分发单点（GET/POST 共用；P0·S1-W18）。返回是否命中。"""
        for rx, fn in routes:
            m = rx.match(path)
            if m:
                obj, status = fn(m, *args)
                att = obj.get("__attachment__") if isinstance(obj, dict) else None
                if att:                                # 原始字节响应（export）：仍留在 app 层用 _send 发出
                    self._send(att["body"], status, att["ctype"], att.get("extra"))
                else:
                    self._json(obj, status)
                return True
        return False

    def do_GET(self):
        try:
            url = urlparse(self.path)
            if url.path.startswith("/api/"):
                if not self._dispatch(ROUTES, url.path, parse_qs(url.query)):
                    self._json({"error": "not found"}, 404)
                return
            self._static(url.path)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # 单请求异常不拖垮服务
            traceback.print_exc()                      # 现场留痕（P0·S1-P5②）
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        try:
            url = urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            if length > 2 * 1024 * 1024:
                self._json({"error": "body too large"}, 413)
                return
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                self._json({"error": "bad json"}, 400)
                return
            if not isinstance(body, dict):             # 边界归一：body 必须是 JSON 对象（P0·S1-P4②）
                self._json({"error": "body 必须为 JSON 对象"}, 400)
                return
            if not self._dispatch(POST_ROUTES, url.path, body, parse_qs(url.query)):
                self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # 单请求异常不拖垮服务
            traceback.print_exc()                      # 现场留痕（P0·S1-P5②）
            self._json({"error": str(e)}, 500)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        target = (WEB_DIR / path.lstrip("/")).resolve()
        if not target.is_relative_to(WEB_DIR) or not target.is_file():   # 健全性守卫（不再前缀近似）——P0·S1-B4
            self._json({"error": "not found"}, 404)
            return
        st = target.stat()
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        if self.headers.get("If-None-Match") == etag:                    # 协商缓存命中——P0·S1-P8②
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send(target.read_bytes(), 200, ctype,
                   {"ETag": etag, "Last-Modified": formatdate(st.st_mtime, usegmt=True)})

    def log_message(self, fmt, *args):
        # 静态资源与健康检查不记（降噪；P0·S1-P8③）；API 请求与错误照记
        req = getattr(self, "requestline", "") or ""
        if "/api/health" in req or (req.startswith("GET /") and "/api/" not in req):
            return
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("SHOTLIST_PORT", "8094")))
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("shotlist-studio on http://%s:%d  (web=%s)" % (args.host, args.port, WEB_DIR), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
