# -*- coding: utf-8 -*-
"""配方中心接口（M4b-3）：列表 / 读 / 保存 / 恢复默认。薄层，逻辑在 core/recipes。"""
from api import _guard as guard
from api import params
from core import recipes


def list_get(m, q):
    return {"ok": True, "groups": recipes.listing()}, 200


def get_get(m, q):
    name = (q.get("name") or [""])[0]
    try:
        return {"ok": True, "recipe": recipes.read(name)}, 200
    except recipes.RecipeError as e:
        return guard.err(str(e))


def save_post(m, body, q):
    try:
        name = params.req_str(body, "name")             # P7①：name 守卫单点
    except ValueError as e:
        return guard.err(str(e))
    try:
        return {"ok": True, "recipe": recipes.save(name, body.get("content"))}, 200
    except recipes.RecipeError as e:
        return guard.err(str(e))


def default_post(m, body, q):
    try:
        name = params.req_str(body, "name")             # P7①：name 守卫单点
    except ValueError as e:
        return guard.err(str(e))
    try:
        return {"ok": True, "recipe": recipes.restore_default(name)}, 200
    except recipes.RecipeError as e:
        return guard.err(str(e))
