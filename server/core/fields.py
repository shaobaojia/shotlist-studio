"""字段字典（单点定义）：驱动前端表格列 / 详情区 / 编辑控件 / 服务端写校验。

列序与宽度 = 老库（storyboard-shotlist）最终方案移植：
  # → 运镜 → 空间关系 → 摄影机 → 机位 → 动作调度 → 台词 → 时长 → 音频 → 导演备注 → 提示词
设计逻辑：「先看画面怎么动 → 再看什么镜头 → 再看干什么 → 最后技术和声音 → 喂给 AI 的提示词」
type 对应前端渲染器（web/js/cells.js）：text / spatial / camera / jiwei / duration / audio / dialogue / notes / prompt
options = 类型化控件的预设清单（下拉）：
  - shot_size：景别档位（★ 与档位一一对应，属编码非手填；前端摄影机列 = 两段景别 + 焦段复合控件）
  - focal：焦段档位；camera_pos：机位五色（单选）；shot_fn：镜头职能
  运镜（camera_move）不设 options（下拉锁创作）；配 presets 常用档——一键落值，仍可自由手写（自定义）。
写白名单由 core/ops.py 从各表清单派生（prompt 为虚拟列不进写白名单；position/id/时间戳不直改）。
multiline = 前端多行编辑判据（F1-P5：原前端白名单 Set 收进字典单源）；w / in_table = 列宽与全片表列（L3 派生用）。
"""
CAM_TIERS = ["全景 ★", "中全 ★★", "中景 ★★★", "中近 ★★★", "近景 ★★★★", "特写 ★★★★★", "极特 ★★★★★"]
CAM_FOCALS = ["24mm", "35mm", "50mm", "85mm", "100mm"]


def is_id(x):
    """行 id 判据（单点；P0·S3-B1）：非 bool 的 int——JSON true 不得当 1 用。"""
    return isinstance(x, int) and not isinstance(x, bool)


# 块库写白名单（M3 提示词域；块库不记痕迹、不进 /api/meta 的表格字段）
BLOCK_FIELDS = ["text", "category_id", "pinned", "position"]
BLOCK_WRITE_KEYS = set(BLOCK_FIELDS)

# batch = 可批量设值能力位（F2-W14）：选区条批量设值清单由前端手抄转字典单源；
# 镜号（唯一性）/ 提示词（虚拟列）/ 景深（归摄影机复合）无此位。排序即字典序（＝表列序）。
SHOT_FIELDS = [
    {"key": "shot_no",       "label": "#",        "type": "text",     "w": 42,  "in_table": True},
    {"key": "camera_move",   "label": "运镜",     "type": "text",     "w": 72,  "in_table": True, "batch": True,
     "presets": ["固定", "手持", "缓推", "微推", "拉跟", "上摇", "横移", "跟拍", "弧移", "环绕", "滑动变焦"]},
    {"key": "spatial",       "label": "空间关系", "type": "spatial",  "w": 160, "in_table": True, "multiline": True, "batch": True},
    {"key": "shot_size",     "label": "摄影机",   "type": "camera",   "w": 110, "in_table": True, "multiline": True, "batch": True, "options": CAM_TIERS},
    {"key": "camera_pos",    "label": "机位",     "type": "jiwei",    "w": 90,  "in_table": True, "batch": True, "options": ["🔴 正打", "🟡 反打", "🟢 第三人称", "🔵 空间环境", "🟣 插入/切出"]},
    {"key": "blocking",      "label": "动作调度", "type": "text",     "w": 300, "in_table": True, "multiline": True, "batch": True},
    {"key": "dialogue",      "label": "台词",     "type": "dialogue", "w": 180, "in_table": True, "multiline": True, "batch": True},
    {"key": "duration",      "label": "时长",     "type": "duration", "w": 44,  "in_table": True, "batch": True},
    {"key": "audio",         "label": "音频",     "type": "audio",    "w": 120, "in_table": True, "multiline": True, "batch": True},
    {"key": "director_note", "label": "导演备注", "type": "notes",    "w": 180, "in_table": True, "multiline": True, "batch": True},
    {"key": "prompt",        "label": "提示词",   "type": "prompt",   "w": 160, "in_table": True},
    {"key": "shot_fn",       "label": "职能",     "type": "text",     "w": 56,  "in_table": False, "batch": True, "options": ["建立", "动作镜", "反应镜", "触发", "插入"]},
    {"key": "focal",         "label": "焦段",     "type": "text",     "w": 58,  "in_table": False, "batch": True, "options": CAM_FOCALS},
    {"key": "dof",           "label": "景深",     "type": "text",     "w": 44,  "in_table": False},
    {"key": "pov",           "label": "视点",     "type": "text",     "w": 52,  "in_table": False, "batch": True},
]

SCENE_FIELDS = [
    {"key": "scene_no",   "label": "场号",     "type": "text", "w": 76,  "in_table": True},
    {"key": "title",      "label": "场景名",   "type": "text", "w": 120, "in_table": True, "batch": True},
    {"key": "value",      "label": "场景价值", "type": "text", "w": 76,  "in_table": True, "batch": True},
    {"key": "pole_start", "label": "起点极",   "type": "text", "w": 90,  "in_table": False, "batch": True},
    {"key": "pole_end",   "label": "终点极",   "type": "text", "w": 90,  "in_table": False, "batch": True},
    {"key": "turn",       "label": "翻转",     "type": "text", "w": 150, "in_table": True, "batch": True},
    {"key": "pov",        "label": "视点角色", "type": "text", "w": 64,  "in_table": True, "batch": True},
]

BEAT_FIELDS = [
    {"key": "beat_no",        "label": "节拍序号",     "type": "text"},
    {"key": "name",           "label": "节拍名称",     "type": "text", "batch": True},
    {"key": "kind",           "label": "类型",         "type": "text", "batch": True},
    {"key": "outside_action", "label": "外界动作",     "type": "text", "batch": True},
    {"key": "reaction",       "label": "人物反应",     "type": "text", "batch": True},
    {"key": "closed_loop",    "label": "闭环",         "type": "text", "batch": True},
    {"key": "note",           "label": "说明",         "type": "text", "batch": True},
    {"key": "rhythm_section", "label": "节奏段落",     "type": "text", "batch": True},
    {"key": "rhythm_note",    "label": "节奏描述",     "type": "text", "batch": True},
    {"key": "mood_temp",      "label": "情绪温度",     "type": "text", "batch": True},
    {"key": "shot_estimate",  "label": "预估总镜头数", "type": "text", "batch": True},
    {"key": "rhythm_density", "label": "节奏密度",     "type": "text", "batch": True},
    {"key": "beat_action",    "label": "节拍动作",     "type": "text", "multiline": True, "batch": True},
    {"key": "beat_attr",      "label": "节拍属性",     "type": "text", "batch": True},
    {"key": "pov",            "label": "视点角色",     "type": "text", "batch": True},
]


# AI 能力位（单源，批4/P8）：前端经 /api/meta 消费，勿在前端手抄字段名
AI_FIELDS = {
    "shots": ("blocking", "dialogue", "director_note"),
    "beats": ("beat_action",),
}
AI_MAX_TARGETS = 30

# 服务端写上限（单源；随 /api/meta 下发 limits，前端勿手抄）——P0·S1-W16
BATCH_MAX = 400
DELETE_MAX = 200


def meta():
    return {"shot_fields": SHOT_FIELDS, "scene_fields": SCENE_FIELDS, "beat_fields": BEAT_FIELDS,
            "ai_fields": [k for v in AI_FIELDS.values() for k in v],
            "ai_max_targets": AI_MAX_TARGETS,
            "limits": {"batch": BATCH_MAX, "delete": DELETE_MAX}}
