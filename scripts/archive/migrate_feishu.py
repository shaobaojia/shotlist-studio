#!/usr/bin/env python3
"""电玩城全量迁入：飞书导出 + 价值弧线 + s010 分析稿 → data/studio.db（schema v1）。

用法：python3 scripts/archive/migrate_feishu.py [--reset] [--export DIR] [--db PATH]
（归档工具：一次性迁移，人工运行；已从一条命令管线除名——见 scripts/archive/README.md）
说明：
  - 输入默认取 data/archive/feishu-<最新>/ 的 storyboard.json / analysis.json
  - 场景价值字段来自 价值弧线_s010-s080.md；s010 节拍明细来自 s010_第一场_分析.md
  - 提示词：↑sNNN-NN 引用 → 链式解析并组；直接文本 → 立组（DESIGN §3.4）
"""
import argparse, json, re, shutil, sqlite3, sys
from datetime import datetime
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[2]  # scripts/archive/ 深一层（归档后修正）
DEFAULT_ARC = "/volume1/主目录/Hermes/read/Vault/分镜/电玩城的大小孩/价值弧线_s010-s080.md"
DEFAULT_S010 = "/volume1/主目录/Hermes/read/Vault/分镜/电玩城的大小孩/s010_第一场_分析.md"
FILM_TITLE = "电玩城的大小孩"
SCENE_TITLES = {"s010": "商场过道", "s020": "电玩城门口", "s030": "电玩城环游", "s040": "赛车区",
                "s050": "摩托车机台", "s060": "推币机", "s070": "精神世界", "s080": "门口"}

def latest_export():
    dirs = sorted((ROOT / "data" / "archive").glob("feishu-*"))
    if not dirs:
        sys.exit("找不到 data/archive/feishu-* 导出")
    return dirs[-1]

def parse_arc_table(path):
    out, in_table = {}, False
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("| :"):
            in_table = True
            continue
        if not in_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells and re.fullmatch(r"s\d{3}", cells[0]):
            out[cells[0]] = {"summary": cells[1], "value": cells[2], "pole_start": cells[3],
                             "pole_end": cells[4], "turn": cells[5]}
    return out

def parse_s010_analysis(path):
    out, in_table = {}, False
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("| :"):
            in_table = True
            continue
        if not in_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) >= 7 and re.fullmatch(r"\d+", cells[0]):
            out[cells[0]] = {"name": cells[1], "outside_action": cells[2], "reaction": cells[3],
                             "kind": cells[4], "closed_loop": cells[5], "note": cells[6]}
    return out

def norm(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v if v else None
    return str(v)

def norm_pov(v):
    v = norm(v)
    return v.replace("👤", "").strip() if v else None

def shot_sort_no(f):
    m = re.search(r"(\d+)", str(f.get("镜号", "")))
    return int(m.group(1)) if m else 10 ** 9

REF_RE = re.compile(r"^[↑←]\s*(?:([sS]\d{3})\s*[-–]\s*)?(\d{1,3})\s*$")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("--arc", default=DEFAULT_ARC)
    ap.add_argument("--s010-analysis", default=DEFAULT_S010)
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    export = Path(args.export) if args.export else latest_export()
    db_path = Path(args.db) if args.db else ROOT / "data" / "studio.db"

    # 输入读取与解析全部前置：任一失败即退出，旧库分毫不动（P0·S4-B2）
    sb = json.loads((export / "storyboard.json").read_text(encoding="utf-8"))
    an = json.loads((export / "analysis.json").read_text(encoding="utf-8"))
    arc = parse_arc_table(args.arc)
    s010a = parse_s010_analysis(args.s010_analysis)

    if db_path.exists():
        if not args.reset:
            sys.exit("db 已存在，用 --reset 重建：%s" % db_path)
        bak = db_path.with_name(db_path.name + ".bak-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(db_path, bak)   # 删前留底（P0·S4-B2）
        db_path.unlink()
    warnings = []

    con = sqlite3.connect(db_path)
    con.executescript((ROOT / "server" / "schema.sql").read_text(encoding="utf-8"))
    con.execute("PRAGMA foreign_keys = ON")

    cur = con.execute("INSERT INTO films (title, meta) VALUES (?, ?)",
                      (FILM_TITLE, json.dumps({"source": "feishu:OwBSbEQS5aY9HksVVBYcYUnVnlg",
                                               "export": export.name,
                                               "migrated_at": datetime.now().isoformat(timespec="seconds")},
                                              ensure_ascii=False)))
    film_id = cur.lastrowid

    # ---- 场（8 场，价值弧线为纲）----
    scene_ids = {}
    for pos, (sno, info) in enumerate(sorted(arc.items())):
        pov = "男人" if sno in ("s010", "s020") else None
        cur = con.execute(
            "INSERT INTO scenes (film_id, position, scene_no, title, value, pole_start, pole_end, turn, pov)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (film_id, pos, sno, SCENE_TITLES.get(sno), info["value"], info["pole_start"],
             info["pole_end"], info["turn"], pov))
        scene_ids[sno] = cur.lastrowid

    # ---- 分镜行整理 ----
    rows_by_scene = {}
    for r in sb:
        f = r["fields"]
        rows_by_scene.setdefault(str(f.get("场次")), []).append(f)
    for sno in rows_by_scene:
        rows_by_scene[sno].sort(key=shot_sort_no)

    # ---- 节拍 ----
    beat_ids = {}
    # s010：由分镜行归组（空间 + 1..6），明细补自分析稿
    for pos, (key, rows) in enumerate(_group(rows_by_scene.get("s010", [])).items()):
        titles = Counter(norm(r.get("beat标题")) for r in rows if norm(r.get("beat标题")))
        name = titles.most_common(1)[0][0] if titles else None
        for r in rows:
            if norm(r.get("beat标题")) and norm(r.get("beat标题")) != name:
                warnings.append("s010 镜%s：beat标题「%s」与序号 %s 不一致（按序号归组，标题取组内多数）"
                                % (r.get("镜号"), r.get("beat标题"), key))
        kinds = Counter(norm(r.get("beat类型")) for r in rows if norm(r.get("beat类型")))
        kind = kinds.most_common(1)[0][0] if kinds else None
        action = next((norm(r.get("节拍动作")) for r in rows if norm(r.get("节拍动作"))), None)
        pov = next((norm_pov(r.get("视点角色")) for r in rows if norm_pov(r.get("视点角色"))), None)
        md = s010a.get(key) if key.isdigit() else None
        cur = con.execute(
            "INSERT INTO beats (scene_id, position, beat_no, name, kind, beat_action, pov,"
            " outside_action, reaction, closed_loop, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (scene_ids["s010"], pos, key, name, kind, action, pov,
             md["outside_action"] if md else None, md["reaction"] if md else None,
             md["closed_loop"] if md else None, md["note"] if md else None))
        beat_ids[("s010", key)] = cur.lastrowid
    # s020：分析表为纲（3 节拍），beat_action 从分镜行取
    for pos, r in enumerate(sorted(an, key=lambda x: int(x["fields"].get("节拍序号", 0)))):
        f = r["fields"]
        key = str(f.get("节拍序号"))
        group_rows = _group(rows_by_scene.get("s020", [])).get(key, [])
        action = next((norm(x.get("节拍动作")) for x in group_rows if norm(x.get("节拍动作"))), None)
        cur = con.execute(
            "INSERT INTO beats (scene_id, position, beat_no, name, kind, outside_action, reaction,"
            " closed_loop, note, rhythm_section, rhythm_note, mood_temp, shot_estimate,"
            " rhythm_density, beat_action, pov) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (scene_ids["s020"], pos, key, norm(f.get("节拍名称")), norm(f.get("类型")),
             norm(f.get("外界动作")), norm(f.get("人物反应")), norm(f.get("闭环")), norm(f.get("说明")),
             norm(f.get("节奏段落")), norm(f.get("节奏描述")), norm(f.get("情绪温度")),
             norm(f.get("预估总镜头数")), norm(f.get("节奏密度")), action, norm(f.get("视点角色"))))
        beat_ids[("s020", key)] = cur.lastrowid

    # ---- 镜头 ----
    shot_ids, shot_order = {}, {}
    for sno, rows in rows_by_scene.items():
        scene_id = scene_ids.get(sno)
        if scene_id is None:
            warnings.append("分镜行场次 %s 不在价值弧线表中，跳过" % sno)
            continue
        for pos, f in enumerate(rows):
            shot_no = str(f.get("镜号"))
            cur = con.execute(
                "INSERT INTO shots (scene_id, beat_id, position, shot_no, camera_move, spatial,"
                " shot_size, focal, dof, camera_pos, blocking, dialogue, duration, audio,"
                " director_note, shot_fn, pov) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (scene_id, beat_ids.get((sno, str(f.get("beat序号")))), pos, shot_no,
                 norm(f.get("运镜")), norm(f.get("空间关系")), norm(f.get("景别")), norm(f.get("焦段")),
                 norm(f.get("景深")), norm(f.get("机位")), norm(f.get("动作调度")), norm(f.get("台词")),
                 norm(f.get("时长(秒)")), norm(f.get("音频")), norm(f.get("导演备注")),
                 norm(f.get("节拍属性")), norm_pov(f.get("视点角色"))))
            shot_ids[(sno, shot_no)] = cur.lastrowid
            shot_order[(sno, shot_no)] = pos

    # ---- 提示词组（↑引用链式解析）----
    cells = {}
    for sno, rows in rows_by_scene.items():
        for f in rows:
            t = f.get("提示词")
            if isinstance(t, str) and t.strip():
                cells[(sno, str(f.get("镜号")))] = t.strip()

    memo = {}
    def resolve(key, stack):
        if key in memo:
            return memo[key]
        t = cells[key]
        ref = REF_RE.match(t)
        if ref:
            tsno = ref.group(1) or key[0]
            tkey = (tsno, "%02d" % int(ref.group(2)))
            if tkey not in cells:
                warnings.append("引用悬空：%s-%s → %s" % (key[0], key[1], t))
                memo[key] = (key, t)
                return memo[key]
            if tkey in stack:
                warnings.append("引用成环：%s-%s → %s" % (key[0], key[1], t))
                memo[key] = (key, t)
                return memo[key]
            root, text = resolve(tkey, stack | {key})
            memo[key] = (root, text)
        else:
            memo[key] = (key, t)
        return memo[key]

    groups = {}
    for key in sorted(cells, key=lambda k: shot_order.get(k, 10 ** 9)):
        root, text = resolve(key, set())
        groups.setdefault(root, []).append(key)

    for gpos, (root, members) in enumerate(groups.items()):
        text = memo[root][1]
        cur = con.execute("INSERT INTO prompt_groups (scene_id, position, text) VALUES (?,?,?)",
                          (scene_ids[root[0]], gpos, text))
        gid = cur.lastrowid
        for m in members:
            con.execute("UPDATE shots SET prompt_group_id=? WHERE id=?", (gid, shot_ids[m]))

    con.commit()

    # ---- 报告 ----
    print("== 迁移完成 ==")
    print("film:", FILM_TITLE, "| scenes:", con.execute("SELECT COUNT(*) FROM scenes").fetchone()[0],
          "| beats:", con.execute("SELECT COUNT(*) FROM beats").fetchone()[0],
          "| shots:", con.execute("SELECT COUNT(*) FROM shots").fetchone()[0],
          "| prompt_groups:", con.execute("SELECT COUNT(*) FROM prompt_groups").fetchone()[0])
    for row in con.execute("SELECT sc.scene_no, sc.title,"
                           " (SELECT COUNT(*) FROM shots s WHERE s.scene_id=sc.id),"
                           " (SELECT COUNT(*) FROM beats b WHERE b.scene_id=sc.id),"
                           " (SELECT COUNT(*) FROM prompt_groups p WHERE p.scene_id=sc.id)"
                           " FROM scenes sc ORDER BY sc.position"):
        print("  %s %s | 镜 %s | 节拍 %s | 提示词组 %s" % row)
    if warnings:
        print("warnings:")
        for w in warnings:
            print("  -", w)
    print("db:", db_path, "(", db_path.stat().st_size, "bytes )")

    # 硬断言
    assert con.execute("SELECT COUNT(*) FROM shots").fetchone()[0] == 46
    assert con.execute("SELECT COUNT(*) FROM prompt_groups").fetchone()[0] == 14
    assert con.execute("SELECT COUNT(*) FROM beats").fetchone()[0] == 10
    print("ALL OK")

def _group(rows):
    g = {}
    for r in rows:
        g.setdefault(str(r.get("beat序号")), []).append(r)
    return g

if __name__ == "__main__":
    main()
