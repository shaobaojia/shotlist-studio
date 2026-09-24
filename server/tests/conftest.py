# -*- coding: utf-8 -*-
"""pytest 引导（P2·S4-P3）：把 server/ 与 tests/ 入 sys.path；测试文件不再手抄引导样板。"""
import sys
from pathlib import Path

_TESTS = Path(__file__).resolve().parent
_SERVER = _TESTS.parent
for _p in (str(_SERVER), str(_TESTS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
