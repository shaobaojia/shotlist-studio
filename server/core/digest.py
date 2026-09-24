"""digest 共享模块（L8）：场线 / 行集速览 / 短标签表——audit / rewrite / draft 三域单点。

口径（与历史实现逐字节对拍过，勿轻改；P0·S1-W22 只动命名/接口，不动字节输出）：
- scene_line 恒定四段（审计/创作体，缺省「—」）；scene_line_terse 省略空段（草稿体）。
- shots_lines：spec=[(field, width), …]；空值跳过、换行折空格、按 width 截断；
  style="audit" → 「: 」分隔；"draft" → 「:」（历史口径差异，原样保留）。
- LABELS = 短标签表单点；「空间关系 → 空间」一处已归一（审计口径为准，草稿侧同步）。
"""
SEP = " ｜ "

LABELS = {
    "shot_size": "景别", "focal": "焦段", "camera_move": "运镜", "camera_pos": "机位",
    "spatial": "空间", "blocking": "动作", "dialogue": "台词", "shot_fn": "职能",
}


def scene_line(sc):
    """场线（审计/创作体）：恒定四段，缺省「—」。"""
    return "场：%s %s%s价值：%s%s弧线：%s → %s" % (
        sc.get("scene_no") or "?", sc.get("title") or "", SEP,
        sc.get("value") or "—", SEP, sc.get("pole_start") or "—", sc.get("pole_end") or "—")


def scene_line_terse(sc):
    """场线（草稿体）：省略空段。"""
    parts = ["场：%s %s" % (sc.get("scene_no") or "?", sc.get("title") or "")]
    if sc.get("value"):
        parts.append("价值：%s" % sc["value"])
    if sc.get("pole_start") or sc.get("pole_end"):
        parts.append("弧线：%s → %s" % (sc.get("pole_start") or "—", sc.get("pole_end") or "—"))
    return SEP.join(parts)


def shots_lines(rows, spec, style="draft"):
    """行集速览（单点）：每行「镜NN ｜ 标签值 ｜ …」；spec 控制字段、顺序、截宽与标签（LABELS）。"""
    colon = ": " if style == "audit" else ":"
    lines = []
    for s in rows:
        parts = ["镜%s" % s.get("shot_no")]
        for f, w in spec:
            v = (s.get(f) or "").strip().replace("\n", " ")
            if v:
                parts.append("%s%s%s" % (LABELS.get(f, f), colon, v[:w]))
        lines.append(SEP.join(parts))
    return lines
