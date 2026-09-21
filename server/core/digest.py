"""digest 共享模块（L8）：场线 / 行集速览 / 短标签表——audit / rewrite / draft 三域单点。

口径（与历史实现逐字节对拍过，勿轻改）：
- scene_line：terse=False 恒定四段（审计/创作体，缺省「—」）；terse=True 省略空段（草稿体）。
- shots_lines：spec=[(field, width), …]；空值跳过、换行折空格、按 width 截断；
  colon 区分审计体「: 」与创作体「:」（历史口径差异，原样保留）。
- LABELS = 短标签表单点；「空间关系 → 空间」一处已归一（审计口径为准，草稿侧同步）。
"""
LABELS = {
    "shot_size": "景别", "focal": "焦段", "camera_move": "运镜", "camera_pos": "机位",
    "spatial": "空间", "blocking": "动作", "dialogue": "台词", "shot_fn": "职能",
}


def scene_line(sc, terse=False):
    """场线（单点）。terse=False → 恒定四段；terse=True → 省略空段（草稿口径）。"""
    if terse:
        parts = ["场：%s %s" % (sc.get("scene_no") or "?", sc.get("title") or "")]
        if sc.get("value"):
            parts.append("价值：%s" % sc["value"])
        if sc.get("pole_start") or sc.get("pole_end"):
            parts.append("弧线：%s → %s" % (sc.get("pole_start") or "—", sc.get("pole_end") or "—"))
        return " ｜ ".join(parts)
    return "场：%s %s ｜ 价值：%s ｜ 弧线：%s → %s" % (
        sc.get("scene_no") or "?", sc.get("title") or "",
        sc.get("value") or "—", sc.get("pole_start") or "—", sc.get("pole_end") or "—")


def shots_lines(rows, spec, colon=":"):
    """行集速览（单点）：每行「镜NN ｜ 标签值 ｜ …」；spec 控制字段、顺序、截宽与标签（LABELS）。"""
    lines = []
    for s in rows:
        parts = ["镜%s" % s.get("shot_no")]
        for f, w in spec:
            v = (s.get(f) or "").strip().replace("\n", " ")
            if v:
                parts.append("%s%s%s" % (LABELS.get(f, f), colon, v[:w]))
        lines.append(" ｜ ".join(parts))
    return lines
