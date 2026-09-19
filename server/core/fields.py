"""字段字典（单点定义）：驱动前端表格列 / 详情区 / 将来的编辑控件。

列序与宽度 = 老库（storyboard-shotlist）最终方案移植：
  # → 运镜 → 空间关系 → 摄影机 → 机位 → 动作调度 → 台词 → 时长 → 音频 → 导演备注 → 提示词
设计逻辑：「先看画面怎么动 → 再看什么镜头 → 再看干什么 → 最后技术和声音 → 喂给 AI 的提示词」
type 对应前端渲染器（web/js/cells.js）：text / spatial / camera / jiwei / duration / audio / dialogue / notes / prompt
"""
SHOT_FIELDS = [
    {"key": "shot_no",       "label": "#",        "type": "text",     "w": 42,  "in_table": True},
    {"key": "camera_move",   "label": "运镜",     "type": "text",     "w": 72,  "in_table": True},
    {"key": "spatial",       "label": "空间关系", "type": "spatial",  "w": 160, "in_table": True},
    {"key": "shot_size",     "label": "摄影机",   "type": "camera",   "w": 110, "in_table": True},
    {"key": "camera_pos",    "label": "机位",     "type": "jiwei",    "w": 90,  "in_table": True},
    {"key": "blocking",      "label": "动作调度", "type": "text",     "w": 300, "in_table": True},
    {"key": "dialogue",      "label": "台词",     "type": "dialogue", "w": 180, "in_table": True},
    {"key": "duration",      "label": "时长",     "type": "duration", "w": 44,  "in_table": True},
    {"key": "audio",         "label": "音频",     "type": "audio",    "w": 120, "in_table": True},
    {"key": "director_note", "label": "导演备注", "type": "notes",    "w": 180, "in_table": True},
    {"key": "prompt",        "label": "提示词",   "type": "prompt",   "w": 160, "in_table": True},
    {"key": "shot_fn",       "label": "职能",     "type": "text",     "w": 56,  "in_table": False},
    {"key": "focal",         "label": "焦段",     "type": "text",     "w": 58,  "in_table": False},
    {"key": "dof",           "label": "景深",     "type": "text",     "w": 44,  "in_table": False},
    {"key": "pov",           "label": "视点",     "type": "text",     "w": 52,  "in_table": False},
]


def meta():
    return {"shot_fields": SHOT_FIELDS}
