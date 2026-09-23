#!/usr/bin/env python3
"""导出（批6-2）：静态分享页 / A4 打印版。

设计：
- 单源自 core/fields.py 的 in_table 列定义（driven by schema，不手抄列名；prompt 虚拟列除外——组文本非逐镜，暂不进表）。
- DB 直读：导出不受当前视图筛选/排序影响；节拍分组结构保留（beat 行 + 未归节拍）。
- 产物 = 单文件 HTML（内联 CSS、零外部依赖、零 JS），浏览器打开即看、Ctrl+P 即打。
- format=page：屏幕阅读优先（宽版、大留白）；format=print：紧凑 + @page A4 横向（页头重复、行不跨页）。
"""
import html
import time

from core import db, fields

# 导出列（顺序 = fields.py 声明序）：# 运镜 空间关系 摄影机 机位 动作调度 台词 时长 音频 导演备注
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


def _fmt_total(shots):
    tot = 0.0
    for s in shots:
        try:
            tot += float(s.get("duration") or 0)
        except (TypeError, ValueError):
            pass
    m = int(tot // 60)
    sec = int(tot % 60)
    return "%d′%02d″" % (m, sec)


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
    parts.append("%d 镜 / %d 节拍 / 总时长 %s" % (n_shots, n_beats, total))
    return " · ".join(parts)


def _cell(col, s):
    key = col["key"]
    v = s.get(key)
    if key == "shot_no":
        return '<td class="no">%s</td>' % _esc(v or "")
    if key == "duration":
        return '<td class="dur">%s</td>' % _fmt_dur(v)
    return "<td>%s</td>" % _nl2br(v)


def build_scene_html(con, scene_no, fmt="page"):
    """返回 (html_text, utf8_filename, ascii_filename)；场景不存在返回 (None, None, None)。"""
    film = db.film(con)
    if not film:
        return None, None, None
    sc = db.scene_by_no(con, film["id"], scene_no)
    if not sc:
        return None, None, None
    beats = db.beats(con, sc["id"])
    shots = db.shots(con, sc["id"])

    by_beat = {}
    for s in shots:
        by_beat.setdefault(s.get("beat_id"), []).append(s)

    ncol = len(EXPORT_COLS)
    total_w = sum(c.get("w") or 100 for c in EXPORT_COLS)
    cols_html = "".join('<col style="width:%.1f%%">' % ((c.get("w") or 100) * 100.0 / total_w)
                        for c in EXPORT_COLS)
    head_html = "".join("<th>%s</th>" % _esc(c["label"]) for c in EXPORT_COLS)

    rows = []
    for b in beats:
        mem = by_beat.pop(b["id"], [])
        label = "beat %s：%s（%d 镜）" % (b.get("beat_no") or "?", b.get("name") or "未名", len(mem))
        if b.get("kind"):
            label += " · " + str(b["kind"])
        rows.append('<tr class="beat"><td colspan="%d">%s</td></tr>' % (ncol, _esc(label)))
        for s in mem:
            rows.append("<tr>" + "".join(_cell(c, s) for c in EXPORT_COLS) + "</tr>")
    orphan = by_beat.pop(None, [])
    if orphan:
        rows.append('<tr class="beat"><td colspan="%d">%s</td></tr>'
                    % (ncol, _esc("未归节拍（%d 镜）" % len(orphan))))
        for s in orphan:
            rows.append("<tr>" + "".join(_cell(c, s) for c in EXPORT_COLS) + "</tr>")

    css = _BASE_CSS + (_PRINT_ONLY if fmt == "print" else _PAGE_PRINT)
    title = "%s · %s" % (sc.get("scene_no") or "", sc.get("title") or "")
    stamp = time.strftime("%Y-%m-%d %H:%M")
    html_text = (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>%s · 分镜表</title>\n<style>%s</style>\n</head>\n<body>\n<div class=\"page\">\n"
        "<h1>%s</h1>\n<div class=\"meta\">%s</div>\n"
        "<table>\n<colgroup>%s</colgroup>\n<thead><tr>%s</tr></thead>\n<tbody>\n%s\n</tbody>\n</table>\n"
        "<footer>分镜表 · 导出于 %s</footer>\n</div>\n</body>\n</html>\n"
        % (_esc(title), css, _esc(title),
           _esc(_meta_line(sc, len(shots), len(beats), _fmt_total(shots))),
           cols_html, head_html, "\n".join(rows), stamp)
    )

    if fmt == "print":
        name_utf8 = "%s 分镜表·A4打印版.html" % (sc.get("scene_no") or "scene")
        name_ascii = "%s-storyboard-A4.html" % (sc.get("scene_no") or "scene")
    else:
        name_utf8 = "%s 分镜表·静态页.html" % (sc.get("scene_no") or "scene")
        name_ascii = "%s-storyboard.html" % (sc.get("scene_no") or "scene")
    return html_text, name_utf8, name_ascii
