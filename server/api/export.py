"""导出接口（批6-2）：GET /api/export?scene=s010&format=page|print。

服务端生成自含 HTML → 附件下载（Content-Disposition）。route 特case 在 app.py 的 do_GET 里直接分发到此
（返回原始字节而非 JSON，不走 ROUTES 机制）。
"""
from urllib.parse import quote

from core import db
from core import export as core_export


def handle(handler, q):
    scene_no = (q.get("scene") or [""])[0].strip()
    fmt = (q.get("format") or ["page"])[0].strip()
    if fmt not in ("page", "print"):
        handler._json({"error": "format 只支持 page / print"}, 400)
        return
    if not scene_no:
        handler._json({"error": "缺 scene 参数"}, 400)
        return
    con = db.connect()
    try:
        html_text, name_utf8, name_ascii = core_export.build_scene_html(con, scene_no, fmt)
    finally:
        con.close()
    if html_text is None:
        handler._json({"error": "场景不存在：%s" % scene_no}, 404)
        return
    body = html_text.encode("utf-8")
    disp = 'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (name_ascii, quote(name_utf8))
    handler._send(body, 200, "text/html; charset=utf-8", {"Content-Disposition": disp})
