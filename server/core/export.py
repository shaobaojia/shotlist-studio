#!/usr/bin/env python3
"""导出（批6-2）：静态分享页 / A4 打印版。

设计：
- 单源自 core/fields.py 的 in_table 列定义（driven by schema，不手抄列名；prompt 虚拟列除外——组文本非逐镜，暂不进表）。
- DB 直读：导出不受当前视图筛选/排序影响；节拍分组结构保留（beat 行 + 未归节拍）。
- 产物 = 单文件 HTML（内联 CSS、零外部依赖、零 JS），浏览器打开即看、Ctrl+P 即打。
- format=page：屏幕阅读优先（宽版、大留白）；format=print：紧凑 + @page A4 横向（页头重复、行不跨页）。
"""
import html
import re
import time
from collections import namedtuple

from core import db, digest, fields

# 导出列（顺序 = fields.py 声明序，prompt 虚拟列除外——组文本非逐镜，暂不进表）
EXPORT_COLS = [c for c in fields.SHOT_FIELDS if c["in_table"] and c["key"] != "prompt"]

_BASE_CSS = """
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: #f3eee3; color: #2c2721; padding: 26px 30px 42px;
  font: 13.5px/1.6 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
.page { max-width: 1180px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0 0 5px; font-weight: 700; }
.meta { color: #8b8371; font-size: 12.5px; margin: 0 0 15px; }
table { width: 100%; border-collapse: collapse; background: #fffdf6;
  box-shadow: 0 1px 4px rgba(70,58,32,.10); }
th, td { border: 1px solid #ddd2b8; padding: 6px 8px; vertical-align: top; text-align: left;
  font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
th { background: #ece3cd; font-weight: 600; font-size: 12px; white-space: nowrap; }
td.no { font-weight: 700; text-align: center; white-space: nowrap; }
td.dur { text-align: right; white-space: nowrap; }
tr.beat td { background: #e7dcc2; font-weight: 600; }
footer { margin-top: 13px; color: #9a917d; font-size: 11.5px; text-align: right; }
"""

_PAGE_PRINT = """
@media print { body { background: #fff; padding: 0; } table { box-shadow: none; }
  tr { break-inside: avoid; } thead { display: table-header-group; } }
"""

_PRINT_ONLY = """
@page { size: A4 landscape; margin: 9mm; }
body { padding: 0; background: #fff; }
.page { max-width: none; }
table { box-shadow: none; }
h1 { font-size: 15px; margin-bottom: 3px; }
.meta { font-size: 10.5px; margin-bottom: 8px; }
th, td { font-size: 9.5px; padding: 3px 5px; line-height: 1.45; }
th { font-size: 9px; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
tr.beat td { font-size: 10px; }
footer { font-size: 9px; margin-top: 6px; }
"""

# 导出格式表（P1·S4-A1）：css 附加段 + 文件名模板 单点；page=屏幕阅读优先 / print=A4 横向
FORMATS = {
    "page": {"css": _PAGE_PRINT, "name_utf8": "%s 分镜表·静态页.html",
             "name_ascii": "%s-storyboard.html"},
    "print": {"css": _PRINT_ONLY, "name_utf8": "%s 分镜表·A4打印版.html",
              "name_ascii": "%s-storyboard-A4.html"},
}


class SceneNotFound(Exception):
    """场不存在（P1·S4-A2）：接口层转 404。"""


SceneExport = namedtuple("SceneExport", "html name_utf8 name_ascii")


def _esc(v):
    return html.escape(str(v)) if v is not None else ""


def _nl2br(v):
    if v is None or str(v).strip() == "":
        return "—"
    return "<br>".join(html.escape(str(v)).split("\n"))


def _fmt_dur(v):
    if v is None or str(v).strip() == "":
        return "—"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return html.escape(str(v))
    return "%gs" % f


_NUM_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")


def _num(v):
    """时长文本 → 数值（前缀口径，与图面 parseFloat 同族；P1·S4-B6）。不可解析 → None。
    注：audit 均值口径走 digest.dur_num（纯数才认），两者刻意不同——此处对齐图面展示。"""
    if v is None:
        return None
    m = _NUM_RE.match(str(v).lstrip())
    return float(m.group()) if m else None


def _total_sec(shots):
    """总时长数值（P1·S4-A3）：逐镜 _num 求和；展示格式化归 digest.fmt_dur。"""
    tot = 0.0
    for s in shots:
        v = _num(s.get("duration"))
        if v is not None:
            tot += v
    return tot


def _meta_line(sc, n_shots, n_beats, total):
    parts = []
    if sc.get("value"):
        parts.append("价值 " + str(sc["value"]))
    if sc.get("pole_start") or sc.get("pole_end"):
        parts.append("弧线 %s → %s" % (sc.get("pole_start") or "?", sc.get("pole_end") or "?"))
    if sc.get("turn"):
        parts.append("翻转 " + str(sc["turn"]))
    if sc.get("pov"):
        parts.append("视点 " + str(sc["pov"]))
    parts.append(digest.stats_line(n_shots, n_beats, total))
    return " · ".join(parts)


def _cell(col, s):
    key = col["key"]
    v = s.get(key)
    if key == "shot_no":
        return '<td class="no">%s</td>' % _esc(v or "")
    if key == "duration":
        return '<td class="dur">%s</td>' % _fmt_dur(v)
    return "<td>%s</td>" % _nl2br(v)


def _col_w(col):
    """列宽兜底单点（P1·S4-A4）：声明 w 缺失按 100（fields 全带 w，此兜底为死保险）。"""
    return col.get("w") or 100


def build_scene_html(con, scene_no, fmt="page"):
    """构场导出件（P1·S4-A2）：返回 SceneExport(html/name_utf8/name_ascii)。
    场不存在 raise SceneNotFound；未知格式 raise ValueError。"""
    if fmt not in FORMATS:
        raise ValueError("未知导出格式：%s" % fmt)
    _film, sc = db.load_scene(con, scene_no)
    if not sc:
        raise SceneNotFound(scene_no)
    beats = db.beats(con, sc["id"])
    shots = db.shots(con, sc["id"])
    orphan = db.attach_shots_by_beat(beats, shots)   # 分桶单点（P2·S4-A9；含残留键兜底）

    ncol = len(EXPORT_COLS)
    total_w = sum(_col_w(c) for c in EXPORT_COLS)
    cols_html = "".join('<col style="width:%.1f%%">' % (_col_w(c) * 100.0 / total_w)
                        for c in EXPORT_COLS)
    head_html = "".join("<th>%s</th>" % _esc(c["label"]) for c in EXPORT_COLS)

    rows = []
    for b in beats:
        mem = b["shots"]
        label = "beat %s：%s (%d 镜)" % (b.get("beat_no") or "?", b.get("name") or "未名", len(mem))
        if b.get("kind"):
            label += " · " + str(b["kind"])
        rows.append('<tr class="beat"><td colspan="%d">%s</td></tr>' % (ncol, _esc(label)))
        for s in mem:
            rows.append("<tr>" + "".join(_cell(c, s) for c in EXPORT_COLS) + "</tr>")
    if orphan:
        rows.append('<tr class="beat"><td colspan="%d">%s</td></tr>'
                    % (ncol, _esc("未归节拍 (%d 镜)" % len(orphan))))
        for s in orphan:
            rows.append("<tr>" + "".join(_cell(c, s) for c in EXPORT_COLS) + "</tr>")

    css = _BASE_CSS + FORMATS[fmt]["css"]
    title = "%s · %s" % (sc.get("scene_no") or "", sc.get("title") or "")
    title_html = _esc(title)
    stamp = time.strftime("%Y-%m-%d %H:%M")
    html_text = (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>%s · 分镜表</title>\n<style>%s</style>\n</head>\n<body>\n<div class=\"page\">\n"
        "<h1>%s</h1>\n<div class=\"meta\">%s</div>\n"
        "<table>\n<colgroup>%s</colgroup>\n<thead><tr>%s</tr></thead>\n<tbody>\n%s\n</tbody>\n</table>\n"
        "<footer>分镜表 · 导出于 %s</footer>\n</div>\n</body>\n</html>\n"
        % (title_html, css, title_html,
           _esc(_meta_line(sc, len(shots), len(beats), _total_sec(shots))),
           cols_html, head_html, "\n".join(rows), stamp)
    )

    no = sc.get("scene_no") or "scene"
    tpl = FORMATS[fmt]
    return SceneExport(html_text, tpl["name_utf8"] % no, tpl["name_ascii"] % no)
