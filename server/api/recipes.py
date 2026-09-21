"""配方中心接口（M4b-3）：列表 / 读 / 保存 / 恢复默认。薄层，逻辑在 core/recipes。"""
from core import recipes


def list_get(m, q):
    return {"ok": True, "groups": recipes.listing()}, 200


def get_get(m, q):
    name = (q.get("name") or [""])[0]
    try:
        return {"ok": True, "recipe": recipes.read(name)}, 200
    except recipes.RecipeError as e:
        return {"error": str(e)}, 400


def save_post(m, body, q):
    body = body or {}
    name = body.get("name")
    if not isinstance(name, str) or not name:
        return {"error": "参数不完整（name）"}, 400
    try:
        return {"ok": True, "recipe": recipes.save(name, body.get("content"))}, 200
    except recipes.RecipeError as e:
        return {"error": str(e)}, 400


def default_post(m, body, q):
    body = body or {}
    name = body.get("name")
    if not isinstance(name, str) or not name:
        return {"error": "参数不完整（name）"}, 400
    try:
        return {"ok": True, "recipe": recipes.restore_default(name)}, 200
    except recipes.RecipeError as e:
        return {"error": str(e)}, 400
