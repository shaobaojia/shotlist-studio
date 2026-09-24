# -*- coding: utf-8 -*-
"""提示词域包（原 core/prompts.py 拆分 · S3-L1：groups / blocks / text）。
对外保持 `from core import prompts` 与 `prompts.X` 全量兼容（重导出）。"""

from .groups import (_load_shots, _new_group, _normalize_positions, _shot_refs, detach_shots, MAX_GROUP_TEXT, MAX_GROUPS, MAX_SHOTS, merge_shots, prompt_state, restore_state, set_group_text, split_group)  # noqa: F401
from .blocks import (_cat_blocks, _check_cat, _load_block, _neighbor_swap, _place_block, block_create, block_delete, block_move, block_update, blocks_state, cat_create, cat_delete, cat_move, cat_update)  # noqa: F401
from .text import (_check_cat_name, _check_len, _check_text, is_id, MAX_BLOCK_TEXT, MAX_CAT_NAME)  # noqa: F401
