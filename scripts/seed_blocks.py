#!/usr/bin/env python3
"""M3 种子块库：从 s010 现有提示词 + 老库 M4 模板提炼的积木块。

用法：
  python3 scripts/seed_blocks.py            # 幂等载入：缺什么补什么（按正文查重，半载可续）
  python3 scripts/seed_blocks.py --reset    # 清空块库并重载种子（连接时自动留当日快照）
  python3 scripts/seed_blocks.py --md OUT   # 生成清单 Markdown 到 OUT（不写库；仓库根 种子块库.md 即此产物）

块 = 一段可直接插入提示词的积木文字（插入即固化）；{占位符} 在插入时自动代入当前镜的值。
块名仅用于本脚本与清单说明；块库里以正文识别（热盒 chip 显示正文前 18 字）。
占位符清单与前端 web/js/blocks.js 的 PLACEHOLDERS 双语对齐（P2·S4-C7：改一处必须同步另一处）。
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from core import db, ops, prompts  # noqa: E402

STYLE_BLOCK = """风格块：
整体风格：8K IMAX。超写实——禁3D渲染，禁游戏引擎，禁游戏CG过场质感。
摄影风格：Emmanuel Lubezki × Roger Deakins。
灯光风格：严格仅使用场景内实际存在的光源（practicals）。禁止一切电影补光——禁正面光、禁侧面补光、禁顶光、禁底光、禁反光板、禁柔光箱、禁LED灯带、禁霓虹、禁任何画面外光源。摄影机始终在人物的阴影侧（shadow side）拍摄。全程大气薄雾haze——禁止上帝光（god rays）。
色彩风格：60:30:10——主色/辅色/点缀色。
镜头风格：物理电影镜头。180°快门运动模糊。
皮肤风格：毛孔级写实——汗毛、不对称痣、毛细血管潮红、毛孔阴影匹配现场光源。
表演风格：好莱坞级——反应前微停顿、精准视线、湿润活眼带眼神光、可见呼吸和胸腔起伏。
物理风格：重力惯性真实——质量有真实重量、正确接触阴影。禁漂浮道具。
构图风格：三分法+黄金比例。每人从第一帧开始运动。
连续性：角色、道具、环境每个镜头完全一致。禁身份漂移。
技术：标准电影帧率24帧每秒。8K细节。禁抖动（除手持呼吸感）。
音频：仅环境音效。禁音乐。禁字幕。"""

# (分类, [(块名（仅清单用）, 正文), ...])
SEED = [
    ("骨架", [
        ("镜头段·五行骨架",
         "镜头一：[镜{镜号}]（{景别}·{焦段}·{运镜}）\n空间关系：\n动作表演：\n拍摄方式：\n画面动态：\n主光方位："),
        ("起幅落幅·三段式",
         "画面动态：\n起幅——（起始构图）\n（运镜动作：从哪到哪、焦点如何转移）\n落幅——（结束构图）"),
        ("声明区·首组模板",
         "人物：@图片1 — （角色速写：年龄、体型、发型、服装）\n\n场景：（地点，时间。2-3 个关键环境元素。）\n\n空间锚：（t0 静态布局：谁在哪、朝向、关键道具位置）"),
        ("空间锚·行",
         "空间锚：（t0 静态布局——谁在哪、朝向、关键道具位置；只写静态，不写动态事件）"),
    ]),
    ("声明·人物", [
        ("人物·男人（实拍）",
         "人物：@图片1 — 男人，38-42岁，微胖，银框眼镜，深色夹克"),
        ("人物·男人+小孩+奶奶（实拍）",
         "人物：@图片1 — 男人，38-42岁，微胖，银框眼镜，深色夹克。@图片2 — 小孩，5-6岁，哭泣，站在过道中。奶奶，60岁左右，蹲身哄小孩。"),
        ("人物·模板行",
         "人物：@图片N — （角色速写：年龄、体型、发型、服装特征；一人一行）"),
    ]),
    ("声明·场景道具", [
        ("场景·萌宠小镇门前",
         "场景：商场过道，萌宠小镇商铺门前，白天。过道深处延伸向商场内部。中庭天光从过道右侧照入。"),
        ("场景·电玩城门前",
         "场景：商场过道，电玩城店铺门前，白天。过道深处延伸向商场内部。中庭天光从过道右侧照入。"),
        ("场景·取币机附近",
         "场景：商场过道，取币机附近，白天。地面铺浅色地砖。取币机币筐堆满游戏币。"),
        ("道具·模板行",
         "道具：@图片N — （关键道具速写；无则整行省略）"),
    ]),
    ("镜头段·句式", [
        ("拍摄·正打绑定机位帧",
         "拍摄方式：基于@图片，正面拍摄（主体）。"),
        ("拍摄·POV反打",
         "拍摄方式：（角色）POV——透过（角色）的眼睛看（对象）。固定机位。"),
        ("拍摄·侧面物理机位",
         "拍摄方式：基于@图片，侧面拍摄（主体）——写物理机位，不写「第三人称」。"),
        ("拍摄·空间环境交代",
         "拍摄方式：基于@图片，空间环境交代。"),
        ("拍摄·手持近景",
         "拍摄方式：{景别}，{焦段}，手持轻微呼吸感摇晃，中景深。"),
        ("拍摄·缓拉微摇",
         "拍摄方式：（机位），镜头缓拉+微摇，从（起幅）拉到（落幅）。"),
    ]),
    ("主光·灯光", [
        ("主光·剪影背光（走廊）",
         "主光方位：所有人物的亮度呈剪影状，光线从画面{左/右}的（具体光源）打来，在人物身上产生柔和的轮廓光。"),
        ("主光·商场顶光",
         "主光方位：商场顶光自上而下。（前景物体）在（左/右）前景投下阴影。"),
        ("主光·手机屏幕冷光",
         "主光方位：手机屏幕自身发光——冷白调。（屏幕内容）色彩刺眼。"),
        ("主光·屏幕补脸",
         "主光方位：商场顶光。手机屏幕微弱的冷光从下方补了一点脸部阴影。"),
    ]),
    ("风格·固定件", [
        ("风格块·全局（固定件）", STYLE_BLOCK),
        ("音频·环境音效行", "音频：仅环境音效。禁音乐。禁字幕。"),
    ]),
    ("运镜·节奏", [
        ("运镜·上摇", "上摇：从（起点）到（终点）依次入画，焦点随之转移。"),
        ("运镜·缓拉", "缓拉：从（起幅区域）拉到（落幅区域），落幅停稳。"),
    ]),
]


SEED_VERSION = "2026-09-19.1"  # 种子批号（写入 settings.seed_blocks_version）


def load(reset=False):
    """内容级幂等：按正文查重、缺什么补什么（半载可续）；全程一个事务、末尾一次 commit。"""
    con = db.open_rw()  # 写边界自带每日快照（core/db.open_rw 下沉 · S1-L4）
    try:
        # 域外特权（P2·S4-C8）：整表删除不走 prompts 域层单点；安全网 = rw 连接的每日快照
        if reset:
            con.execute("DELETE FROM blocks")
            con.execute("DELETE FROM block_categories")
        have = {str(r["text"]).strip() for r in con.execute("SELECT text FROM blocks")}
        cats = {r["name"]: r["id"] for r in con.execute("SELECT id, name FROM block_categories")}
        ncat = nblk = 0
        for cat, blocks in SEED:
            cid = cats.get(cat)
            if cid is None:
                cid = prompts.cat_create(con, cat, commit=False)["id"]
                ncat += 1
            for _name, text in blocks:
                if str(text).strip() in have:
                    continue
                prompts.block_create(con, text, cid, commit=False)
                nblk += 1
                have.add(str(text).strip())
        ops.kv_set(con, "seed_blocks_version", SEED_VERSION)   # KV 写单点（P2·S4-C6）
        con.commit()
        total = con.execute("SELECT COUNT(*) AS n FROM blocks").fetchone()["n"]
        print("种子载入：新增 %d 分类 / %d 块（库内共 %d 块）" % (ncat, nblk, total))
    finally:
        con.close()


def render_md(out_path):
    lines = [
        "# 种子块库 · 清单（M3 首轮）",
        "",
        "> 来源：s010 现有 14 组提示词 + 老库 M4 模板提炼。**已载入块库**；直接在「管理块库」里改 / 删 / 加即可，也可以喊 Hermes 批量调。",
        "> 块名仅用于本清单说明；块库里以正文识别（热盒 chip 显示正文前 18 字）。",
        "",
        "可用占位符（插入提示词时自动代入当前镜的值）：`{镜号} {景别} {焦段} {运镜} {机位} {时长} {台词} {音频} {场景}`",
        "",
    ]
    for cat, blocks in SEED:
        lines.append("## " + cat)
        lines.append("")
        for name, text in blocks:
            lines.append("### " + name)
            lines.append("")
            lines.append("```")
            lines.append(text)
            lines.append("```")
            lines.append("")
    Path(out_path).write_text("\n".join(lines), encoding="utf-8")
    print("清单已写出：%s" % out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="清空块库并重载种子")
    ap.add_argument("--md", metavar="OUT", help="生成清单 Markdown 到 OUT（不写库）")
    args = ap.parse_args()
    if args.md:
        render_md(args.md)
        return
    load(reset=args.reset)


if __name__ == "__main__":
    main()
