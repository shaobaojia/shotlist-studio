"""字段字典（单点定义）：驱动前端表格列 / 详情区 / 将来的编辑控件。
type: text | prompt（prompt 为虚拟列：展示提示词组信息，落地在 prompt_groups 表）。
w: 列宽（px）。
"""
SHOT_FIELDS = [
    {"key": "shot_no",       "label": "镜号",     "type": "text",   "w": 52,  "in_table": True},
    {"key": "shot_fn",       "label": "职能",     "type": "text",   "w": 62,  "in_table": True},
    {"key": "shot_size",     "label": "景别",     "type": "text",   "w": 62,  "in_table": True},
    {"key": "focal",         "label": "焦段",     "type": "text",   "w": 58,  "in_table": True},
    {"key": "camera_move",   "label": "运镜",     "type": "text",   "w": 92,  "in_table": True},
    {"key": "camera_pos",    "label": "机位",     "type": "text",   "w": 88,  "in_table": True},
    {"key": "blocking",      "label": "动作调度", "type": "text",   "w": 180, "in_table": True},
    {"key": "dialogue",      "label": "台词",     "type": "text",   "w": 150, "in_table": True},
    {"key": "duration",      "label": "时长",     "type": "text",   "w": 52,  "in_table": True},
    {"key": "audio",         "label": "音频",     "type": "text",   "w": 150, "in_table": True},
    {"key": "director_note", "label": "导演备注", "type": "text",   "w": 220, "in_table": True},
    {"key": "prompt",        "label": "提示词",   "type": "prompt", "w": 110, "in_table": True},
    {"key": "dof",           "label": "景深",     "type": "text",   "w": 44,  "in_table": False},
    {"key": "spatial",       "label": "空间关系", "type": "text",   "w": 160, "in_table": False},
    {"key": "pov",           "label": "视点",     "type": "text",   "w": 52,  "in_table": False},
]


def meta():
    return {"shot_fields": SHOT_FIELDS}
