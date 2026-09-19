#!/usr/bin/env python3
"""shotlist-studio 服务：路由（薄）+ 静态托管。运行：python3 server/app.py [--port 8094]"""
import argparse
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
from api import handlers  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = (ROOT / "web").resolve()

ROUTES = [
    (re.compile(r"^/api/health$"), handlers.health),
    (re.compile(r"^/api/meta$"), handlers.meta),
    (re.compile(r"^/api/film$"), handlers.film),
    (re.compile(r"^/api/scenes/([a-zA-Z0-9]+)$"), handlers.scene),
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

    def _send(self, body, status=200, ctype="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, status=200):
        self._send(json.dumps(obj, ensure_ascii=False).encode("utf-8"), status)

    def do_GET(self):
        try:
            url = urlparse(self.path)
            if url.path.startswith("/api/"):
                for rx, fn in ROUTES:
                    m = rx.match(url.path)
                    if m:
                        obj, status = fn(m, parse_qs(url.query))
                        self._json(obj, status)
                        return
                self._json({"error": "not found"}, 404)
                return
            self._static(url.path)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # 单请求异常不拖垮服务
            self._json({"error": str(e)}, 500)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        target = (WEB_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(WEB_DIR)) or not target.is_file():
            self._json({"error": "not found"}, 404)
            return
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send(target.read_bytes(), 200, ctype)

    def log_message(self, fmt, *args):
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
