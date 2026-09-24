#!/usr/bin/env python3
"""出厂副本自举（P6）：把 recipes/ 下注册配方拷进 data/recipe-defaults/。

用法：
  python3 scripts/seed_recipe_defaults.py          # 只补缺失（已有出厂副本不覆盖）
  python3 scripts/seed_recipe_defaults.py --force  # 全量重写（下发新出厂版时用）
  python3 scripts/seed_recipe_defaults.py --list   # 只列差异（只读）

口径：「恢复默认」读的就是 data/recipe-defaults/——常规运行只补缺；
--force 会把用户改过的 recipes/ 也写成出厂版，只在明确要重发时用。
"""
import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from core import db, recipes  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    root = Path(db.ROOT)
    plan = []
    for g, items in recipes.REGISTRY.items():
        for n, t in items:
            plan.append({"g": g, "n": n,
                         "src": recipes.source_path(root, g, n),    # P8①/W34：布局单点 + dict
                         "dst": recipes.default_path(root, g, n)})
    if args.list:
        for it in plan:
            src, dst = it["src"], it["dst"]
            if not src.is_file():
                state = "缺源文件"
            elif not dst.is_file():
                state = "缺出厂副本"
            elif src.read_bytes() == dst.read_bytes():              # W34②：same 只在 --list 算
                state = "一致"
            else:
                state = "内容不同"
            print("[%s] %s/%s" % (state, it["g"], it["n"]))
        return
    written = kept = 0
    for it in plan:
        src, dst = it["src"], it["dst"]
        if not src.is_file():
            print("跳过（源缺失）：%s/%s" % (it["g"], it["n"]))
            continue
        if dst.is_file() and not args.force:
            kept += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        written += 1
    print("出厂副本：写入 %d 份，保留 %d 份%s" % (
        written, kept, "" if written else "（已齐）"))


if __name__ == "__main__":
    main()
