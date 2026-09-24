# -*- coding: utf-8 -*-
"""直跑引导（P2·S4-P3）：python3 tests/test_x.py 时 import 本模块即等价 conftest 注入。"""
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent
SERVER = TESTS.parent
for _p in (str(SERVER), str(TESTS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
