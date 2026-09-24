"""导出接口（批6-2）：GET /api/export?scene=s010&format=page|print。

服务端生成自含 HTML → 附件下载（Content-Disposition）。走统一 ROUTES 机制（P0·S1-W18）：
返回 __attachment__ 包装，由 app._dispatch 用 _send 发出（api 层不触框架细节）。
"""
import re
from urllib.parse import quote

from core import db
from core import export as core_export


def _disp(name_ascii, name_utf8):
    """Content-Disposition 单点（P1·S4-B5）：ASCII 段落消毒（剥 CR/LF/引号/反斜杠），UTF-8 段走 RFC 5987。"""
    safe = re.sub(r'[\r\n"\\]', "_", name_ascii)
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (safe, quote(name_utf8))


def export_get(m, q):
    """GET /api/export：(match, query) → (obj, status)；成功为 __attachment__（HTML 附件），失败为 JSON 错误。"""
    scene_no = (q.get("scene") or [""])[0].strip()
    fmt = (q.get("format") or ["page"])[0].strip()
    if fmt not in core_export.FORMATS:
        return {"error": "format 只支持 %s" % " / ".join(sorted(core_export.FORMATS))}, 400
    if not scene_no:
        return {"error": "缺 scene 参数"}, 400
    con = db.connect()
    try:
        ex = core_export.build_scene_html(con, scene_no, fmt)
    except core_export.SceneNotFound:
        return {"error": "场景不存在：%s" % scene_no}, 404
    finally:
        con.close()
    body = ex.html.encode("utf-8")
    return {"__attachment__": {"body": body, "ctype": "text/html; charset=utf-8",
                               "extra": {"Content-Disposition": _disp(ex.name_ascii, ex.name_utf8)}}}, 200
