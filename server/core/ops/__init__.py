# -*- coding: utf-8 -*-
"""领域操作包（原 core/ops.py 拆分 · S1-L1：write / snapshot / structure / numbering / restore）。
对外保持 `from core import ops` 与 `ops.X` 全量兼容（重导出）。"""
from core import db  # noqa: F401 — 历史访问面兼容（test_ops 经 ops.db 取 DB_PATH）

from .write import (_apply_field, _check_field_value, _guarded_set, _NO_EXPECT, _row_or_raise, _StaleError, batch_update, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX, history_of, record_history, scene_no_taken, SPECS, TABLES, TABLES_ALLOWED, touch_row, update_field, write_keys)  # noqa: F401
from .snapshot import (_prune_snapshots, _snapshot_date, _snapshot_done, _snapshot_lock, ensure_daily_snapshot, kv_set, lock_scene, SNAPSHOT_RETAIN_DAYS)  # noqa: F401
from .structure import (_copy_row, _insert_dict, _make_room, _reseq_survivors, _scene_beats, _scene_payload, _scene_shots, _table_cols, append_beats, append_shots, BEAT_KIND_DEFAULT, create_beat, create_blank_shot, create_scene, delete_beat, delete_scene, delete_shots, duplicate_beat, duplicate_scene, duplicate_shot, move_beat, move_scene, move_shot, move_shots, renumber_scene, reseq)  # noqa: F401
from .numbering import (_max_num, _next_beat_no, _next_letter_no, _next_scene_no, _next_shot_no, _SUFFIXES, COPY_COLS)  # noqa: F401
from .restore import (insert_restore, restore_beat, restore_scene_full, restore_shots)  # noqa: F401
