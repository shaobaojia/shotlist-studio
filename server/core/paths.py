# -*- coding: utf-8 -*-
"""路径单点（S1-L4）：仓库根 / 数据目录 / 数据库 / 快照目录——db 与 ops 共同依赖。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "studio.db"
SNAP_DAILY_DIR = DATA_DIR / "snapshots" / "daily"
SNAP_SCENES_DIR = DATA_DIR / "snapshots" / "scenes"
SNAP_FILMS_DIR = DATA_DIR / "snapshots" / "films"
