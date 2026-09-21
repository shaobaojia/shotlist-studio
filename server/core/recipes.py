"""配方中心核心（M4b-3）：注册表 / 读 / 保存（自动备份）/ 恢复默认。

白名单口径：只有注册表内的配方可读可写——名不在表内即拒；路径再经 resolve
前缀双保险（防穿越）。保存 = 先备份现版到 data/recipe-backups/ 再落盘；
恢复默认 = 从 data/recipe-defaults/（构建时落盘的出厂拷贝）回写。
根目录可注入（root 参数，测试用），默认 db.ROOT。
"""
import os
import shutil
import time
from pathlib import Path

from . import db

# group -> [(文件, 标题)]；顺序即展示序
REGISTRY = {
    "audit": [
        ("axis.md", "轴线"),
        ("space.md", "空间一致性"),
        ("camera.md", "机位一致性"),
        ("rhythm.md", "节奏曲线"),
        ("concrete.md", "动作具象化"),
    ],
    "ai": [
        ("rewrite.md", "改写"),
        ("concretize.md", "具象化"),
        ("strengthen.md", "强化"),
        ("expand.md", "扩写"),
        ("cmdbar.md", "指挥条"),
        ("draft_beats.md", "草稿·节拍骨架"),
        ("draft_shots.md", "草稿·镜头行"),
        ("draft_prompt.md", "草稿·组级初稿"),
    ],
}
GROUP_CN = {
    "audit": "审计配方 · 十规则里用 AI 的 5 项",
    "ai": "创作配方 · 四动作 + 指挥条 + 草稿档×3",
}
MAX_BYTES = 200_000     # 单份上限 200KB
KEEP_BACKUPS = 30       # 每份保留最近 N 个备份


class RecipeError(ValueError):
    pass


def _base(root):
    return Path(root) if root else db.ROOT


def _entry(name):
    for g, rows in REGISTRY.items():
        for n, t in rows:
            if n == name:
                return g, n, t
    raise RecipeError("未注册的配方：%s" % name)


def _path(base, group, name):
    p = (base / "recipes" / group / name).resolve()
    safe = (base / "recipes").resolve()
    if not str(p).startswith(str(safe) + os.sep):
        raise RecipeError("非法路径")
    return p


def listing(root=None):
    """列表：分组 + 每份的存在性 / 大小 / 修改时间。"""
    base = _base(root)
    out = []
    for g, rows in REGISTRY.items():
        items = []
        for n, t in rows:
            p = _path(base, g, n)
            st = p.stat() if p.is_file() else None
            items.append({"name": n, "title": t, "exists": bool(st),
                          "size": st.st_size if st else 0,
                          "mtime": int(st.st_mtime) if st else 0})
        out.append({"group": g, "label": GROUP_CN[g], "items": items})
    return out


def read(name, root=None):
    base = _base(root)
    g, n, t = _entry(name)
    p = _path(base, g, n)
    if not p.is_file():
        raise RecipeError("配方文件不存在：%s/%s" % (g, n))
    st = p.stat()
    return {"name": n, "group": g, "title": t,
            "content": p.read_text(encoding="utf-8"),
            "size": st.st_size, "mtime": int(st.st_mtime)}


def _backup(base, g, n, p):
    """现版进 data/recipe-backups/；每份只留最近 KEEP_BACKUPS 个。"""
    if not p.is_file():
        return None
    d = base / "data" / "recipe-backups"
    d.mkdir(parents=True, exist_ok=True)
    ns = time.time_ns()
    ts = (time.strftime("%Y%m%d_%H%M%S", time.localtime(ns // 1_000_000_000))
          + "_%06d" % ((ns % 1_000_000_000) // 1000))
    stem = n[:-3] if n.endswith(".md") else n
    dst = d / ("%s__%s.%s.md" % (g, stem, ts))
    shutil.copyfile(p, dst)
    olds = sorted(d.glob("%s__%s.*.md" % (g, stem)), key=lambda x: x.name)
    for x in olds[:-KEEP_BACKUPS]:
        try:
            x.unlink()
        except OSError:
            pass
    return dst.name


def _write_atomic(p, text):
    """原子落盘（同目录临时文件 + os.replace）——并发生成线程读配方永远读到完整版本（M11）。"""
    tmp = p.with_name(p.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, p)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def save(name, content, root=None):
    base = _base(root)
    g, n, t = _entry(name)
    if not isinstance(content, str):
        raise RecipeError("内容必须是文本")
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise RecipeError("内容过大（上限 200KB）")
    if not content.strip():
        raise RecipeError("内容不能为空")
    p = _path(base, g, n)
    p.parent.mkdir(parents=True, exist_ok=True)
    bak = _backup(base, g, n, p)
    _write_atomic(p, content)
    st = p.stat()
    return {"name": n, "group": g, "title": t,
            "size": st.st_size, "mtime": int(st.st_mtime), "backup": bak}


def restore_default(name, root=None):
    base = _base(root)
    g, n, t = _entry(name)
    src = base / "data" / "recipe-defaults" / g / n
    if not src.is_file():
        raise RecipeError("没有出厂副本（data/recipe-defaults 缺失）")
    p = _path(base, g, n)
    bak = _backup(base, g, n, p)
    p.parent.mkdir(parents=True, exist_ok=True)
    _write_atomic(p, src.read_text(encoding="utf-8"))
    st = p.stat()
    return {"name": n, "group": g, "title": t,
            "content": p.read_text(encoding="utf-8"),
            "size": st.st_size, "mtime": int(st.st_mtime), "backup": bak}
