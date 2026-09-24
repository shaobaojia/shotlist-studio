#!/usr/bin/env python3
"""路由安全网（S1-L3）：① 前端 api.js 全部路径 → 服务端路由表命中（对账面）；
② ROUTES/POST_ROUTES 逐条契约（样例路径唯一命中 + handler 身份）；③ 分发形状（假 self：未命中 404 / bad json 400 / 非 dict 400 / 413）。"""
import io
import re
import unittest
from pathlib import Path

import _boot  # noqa: F401 — 直跑引导（pytest 下由 conftest 等价注入）
import app as app_mod  # noqa: E402
from api import ai as ai_api  # noqa: E402
from api import audit as audit_api  # noqa: E402
from api import draft as draft_api  # noqa: E402
from api import export as export_api  # noqa: E402
from api import handlers  # noqa: E402
from api import prompts as prompts_api  # noqa: E402
from api import recipes as recipes_api  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
API_JS = REPO / "web" / "js" / "api.js"

DYN_SEG = {"/api/scenes/": "s010", "/api/prompt/": "set_text"}   # 动态前缀 → 样例段

# 期望契约：样例路径 → handler（顺序无关；唯一命中）
CONTRACT_GET = [
    ("/api/health", handlers.health),
    ("/api/export", export_api.export_get),
    ("/api/meta", handlers.meta),
    ("/api/film", handlers.film),
    ("/api/scenes/s010", handlers.scene),
    ("/api/history", handlers.history),
    ("/api/blocks", prompts_api.blocks),
    ("/api/audit", audit_api.audit_get),
    ("/api/audit/rules", audit_api.rules_get),
    ("/api/audit/summary", audit_api.summary),
    ("/api/ai/settings", ai_api.settings_get),
    ("/api/ai/job", ai_api.job_get),
    ("/api/recipes", recipes_api.list_get),
    ("/api/recipes/get", recipes_api.get_get),
    ("/api/ai/draft/job", draft_api.job_get),
]
CONTRACT_POST = [
    ("/api/update", handlers.update),
    ("/api/batch", handlers.batch),
    ("/api/scenes/s010/renumber", handlers.renumber),
    ("/api/move", handlers.move),
    ("/api/duplicate", handlers.duplicate),
    ("/api/delete", handlers.delete_row),
    ("/api/create", handlers.create),
    ("/api/restore", handlers.restore),
    ("/api/lock", handlers.lock),
    ("/api/blocks", prompts_api.blocks_op),
    ("/api/prompt/set_text", prompts_api.prompt_op),
    ("/api/audit/run", audit_api.run),
    ("/api/audit/issue", audit_api.issue_op),
    ("/api/audit/rules", audit_api.rules_op),
    ("/api/ai/settings", ai_api.settings_set),
    ("/api/ai/test", ai_api.test),
    ("/api/ai/preview", ai_api.preview),
    ("/api/ai/apply", ai_api.apply_op),
    ("/api/recipes/save", recipes_api.save_post),
    ("/api/recipes/default", recipes_api.default_post),
    ("/api/ai/draft", draft_api.start),
    ("/api/ai/draft/prompt", draft_api.prompt),
    ("/api/ai/draft/apply", draft_api.apply_op),
]


def _frontend_paths():
    """从 api.js 提取全部 /api/ 路径（去 query；动态前缀补样例段）。"""
    text = API_JS.read_text(encoding="utf-8")
    out = set()
    for m in re.finditer(r"'((?:/api/)[^']*)'", text):
        raw = m.group(1).split("?")[0]
        if raw.endswith("/"):
            seg = DYN_SEG.get(raw)
            if seg is None:
                continue
            base = raw + seg
            out.add(base)
            if raw == "/api/scenes/" and "'/renumber'" in text:
                out.add(base + "/renumber")
        else:
            out.add(raw)
    return out


def _match(routes, path):
    return [(rx, fn) for rx, fn in routes if rx.match(path)]


class TestFrontendAlignment(unittest.TestCase):
    """① 前后端对账：api.js 的每个路径都能在服务端命中。"""

    def test_frontend_path_count(self):
        """提取防回归：api.js 34 个 unique 路径（blocks / audit/rules / ai/settings 三对 GET/POST 同路径）。"""
        self.assertEqual(len(_frontend_paths()), 34)

    def test_frontend_paths_all_resolve(self):
        for p in sorted(_frontend_paths()):
            hits = _match(app_mod.ROUTES, p) or _match(app_mod.POST_ROUTES, p)
            self.assertTrue(hits, "前端路径无服务端路由：%s" % p)

    def test_server_routes_all_covered(self):
        """反向：除白名单（health）外，每条服务端路由都有前端使用点。"""
        front = _frontend_paths()
        front.add("/api/health")            # 白名单：服务自检端点
        missing = []
        for routes in (app_mod.ROUTES, app_mod.POST_ROUTES):
            for rx, _fn in routes:
                if not any(rx.match(p) for p in front):
                    missing.append(rx.pattern)
        self.assertEqual(missing, [])


class TestRouteContract(unittest.TestCase):
    """② 逐条契约：样例路径唯一命中且绑定的 handler 身份正确。"""

    def _check(self, routes, table, label):
        for path, fn in table:
            hits = _match(routes, path)
            self.assertEqual(len(hits), 1, "%s 应唯一命中：%s（%d）" % (label, path, len(hits)))
            self.assertIs(hits[0][1], fn, "%s 绑定错配：%s" % (label, path))

    def test_get_contract(self):
        self._check(app_mod.ROUTES, CONTRACT_GET, "GET")

    def test_post_contract(self):
        self._check(app_mod.POST_ROUTES, CONTRACT_POST, "POST")

    def test_table_sizes(self):
        self.assertEqual(len(app_mod.ROUTES), 15)
        self.assertEqual(len(app_mod.POST_ROUTES), 23)


class _FakeHandler:
    """假 self：只提供 do_GET/do_POST/_dispatch 所需的表面。"""

    _dispatch = None                       # 实例化后绑真方法

    def __init__(self, path):
        self.path = path
        self.sent = []
        self.headers = {}
        self.rfile = io.BytesIO(b"")

    def _json(self, obj, status=200):
        self.sent.append((obj, status))

    def _send(self, body, status=200, ctype=None, extra=None):
        self.sent.append((body, status))


class TestDispatchShapes(unittest.TestCase):
    """③ 分发形状（P0·S1-W18 / S1-L3）：未命中 404 / bad json 400 / 非 dict 400 / 413。"""

    def _fake(self, path):
        f = _FakeHandler(path)
        f._dispatch = app_mod.Handler._dispatch.__get__(f)
        return f

    def test_get_unmatched_404(self):
        f = self._fake("/api/nope")
        app_mod.Handler.do_GET(f)
        self.assertEqual(f.sent, [({"error": "not found"}, 404)])

    def test_post_unmatched_404(self):
        f = self._fake("/api/nope")
        app_mod.Handler.do_POST(f)         # length 0 → body {} → 未命中
        self.assertEqual(f.sent, [({"error": "not found"}, 404)])

    def test_post_bad_json_400(self):
        f = self._fake("/api/update")
        f.headers = {"Content-Length": "5"}
        f.rfile = io.BytesIO(b"xxxxx")
        app_mod.Handler.do_POST(f)
        self.assertEqual(f.sent, [({"error": "bad json"}, 400)])

    def test_post_non_dict_400(self):
        f = self._fake("/api/update")
        f.headers = {"Content-Length": "5"}
        f.rfile = io.BytesIO(b"[1,2]")
        app_mod.Handler.do_POST(f)
        self.assertEqual(f.sent, [({"error": "body 必须为 JSON 对象"}, 400)])

    def test_post_body_too_large_413(self):
        f = self._fake("/api/update")
        f.headers = {"Content-Length": str(2 * 1024 * 1024 + 1)}
        app_mod.Handler.do_POST(f)
        self.assertEqual(f.sent, [({"error": "body too large"}, 413)])

    def test_hit_dispatches_via_json(self):
        """命中链路（自造 route，不触真 handler）：match → fn 调用 → _json 回包。"""
        route = [(re.compile(r"^/api/probe$"), lambda m, q: ({"ok": True}, 200))]
        f = self._fake("/api/probe")
        ok = app_mod.Handler._dispatch(f, route, "/api/probe", {})
        self.assertTrue(ok)
        self.assertEqual(f.sent, [({"ok": True}, 200)])
