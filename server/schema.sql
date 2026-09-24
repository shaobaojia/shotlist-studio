-- shotlist-studio · schema v1
-- 依据：DESIGN.md §3（数据层设计）。单库装全部工程；排序一律按 position；
-- 镜号是标签不是排序依据（§3.3）。连接时开 PRAGMA foreign_keys=ON。
-- 时间戳：本地时间 ISO 字符串。枚举存英文小写，界面层渲染中文。

PRAGMA user_version = 1;

-- 工程（片）
CREATE TABLE films (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0,   -- 预留·暂无读写（P0·S1-W14）
  meta       TEXT,                         -- 预留·暂无读写（仅迁移脚本写入；P0·S1-W14）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 场：价值追踪四件套 + 台本 + 锁定标记
CREATE TABLE scenes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id    INTEGER NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  scene_no   TEXT,
  title      TEXT,
  value      TEXT,
  pole_start TEXT,
  pole_end   TEXT,
  turn       TEXT,
  pov        TEXT,
  duration   TEXT,                       -- 预留·暂无读写（场级时长未启用；P0·S1-W14）
  script     TEXT,
  locked     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 节拍（beat 明细集中在此；镜头侧去冗余）
CREATE TABLE beats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id       INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  beat_no        TEXT,
  name           TEXT,
  outside_action TEXT,
  reaction       TEXT,
  kind           TEXT,
  closed_loop    TEXT,
  note           TEXT,
  rhythm_section TEXT,
  rhythm_note    TEXT,
  mood_temp      TEXT,
  shot_estimate  TEXT,
  rhythm_density TEXT,
  beat_action    TEXT,
  beat_attr      TEXT,
  pov            TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 提示词组（多镜合并 = 一等公民；单镜 = 隐式一组）
CREATE TABLE prompt_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  text       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 镜头
CREATE TABLE shots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id        INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  beat_id         INTEGER REFERENCES beats(id) ON DELETE SET NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  shot_no         TEXT,
  camera_move     TEXT,
  spatial         TEXT,
  shot_size       TEXT,
  focal           TEXT,
  dof             TEXT,
  camera_pos      TEXT,
  blocking        TEXT,
  dialogue        TEXT,
  duration        TEXT,
  audio           TEXT,
  director_note   TEXT,
  shot_fn         TEXT,                      -- 镜头职能：建立/触发/动作镜/反应镜/插入（原「节拍属性」列）
  pov             TEXT,
  prompt_group_id INTEGER REFERENCES prompt_groups(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 热盒积木块
CREATE TABLE block_categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES block_categories(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0
);

-- 审计：规则 + 问题（注解层三态）
CREATE TABLE audit_rules (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key     TEXT,                                            -- slug 键（老库由种子迁移回填）
  kind    TEXT NOT NULL CHECK (kind IN ('program','llm')),
  title   TEXT NOT NULL,
  params  TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE audit_issues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id   INTEGER REFERENCES scenes(id) ON DELETE CASCADE,
  carrier    TEXT NOT NULL CHECK (carrier IN ('scene','beat','shot','seam')),
  target_id  TEXT,
  rule_id    INTEGER REFERENCES audit_rules(id) ON DELETE SET NULL,
  message    TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','waived')),
  waive_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 痕迹（全操作留痕）
CREATE TABLE history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  scene_id  INTEGER,
  entity    TEXT NOT NULL,
  entity_id INTEGER,
  field     TEXT,
  old_value TEXT,
  new_value TEXT,
  source    TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','system'))
);

-- 快照
CREATE TABLE snapshots (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('film','scene')),           -- 实写仅 'scene'；'film' 预留（P0·S1-W14）
  kind  TEXT NOT NULL CHECK (kind IN ('daily','locked','manual')),  -- 实写仅 'locked'；daily/manual 预留（P0·S1-W14）
  label TEXT,
  path  TEXT NOT NULL,
  at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 设置（AI provider/model/key 等；本地存，不入 git）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 索引
CREATE INDEX idx_scenes_film   ON scenes(film_id, position);
CREATE INDEX idx_beats_scene   ON beats(scene_id, position);
CREATE INDEX idx_shots_scene   ON shots(scene_id, position);
CREATE INDEX idx_shots_group   ON shots(prompt_group_id);
CREATE INDEX idx_pgroups_scene ON prompt_groups(scene_id, position);
CREATE INDEX idx_audit_scene   ON audit_issues(scene_id, status);
CREATE UNIQUE INDEX idx_audit_rules_key ON audit_rules(key);   -- S2-L1：key 单源唯一（NULL 行豁免）
CREATE INDEX idx_history_scene ON history(scene_id, id);   -- 列序换 id：痕迹面板 ORDER BY id DESC 免临时排序（P0·S1-P8④）
