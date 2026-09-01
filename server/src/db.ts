import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.resolve(__dirname, '../../data')
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
export const REVIEWS_DIR = path.join(DATA_DIR, 'reviews')
export const KNOWLEDGE_IMAGES_DIR = path.join(DATA_DIR, 'knowledge_images')
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings')
export const AUTOMATION_DIR = path.join(DATA_DIR, 'automation')          // agent 运行截图等产物
export const APPLICATION_MATERIALS_DIR = path.join(DATA_DIR, 'application_materials')

for (const dir of [DATA_DIR, UPLOADS_DIR, REVIEWS_DIR, KNOWLEDGE_IMAGES_DIR, RECORDINGS_DIR, AUTOMATION_DIR, APPLICATION_MATERIALS_DIR]) {
  mkdirSync(dir, { recursive: true })
}

export const db = new Database(path.join(DATA_DIR, 'job-tracer.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company       TEXT NOT NULL,
  position      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'unsent',
  applied_at    TEXT,
  channel       TEXT DEFAULT '其他',
  location      TEXT,
  resume_id     INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  jd_link       TEXT,
  jd_text       TEXT,
  contact_name  TEXT,
  contact_info  TEXT,
  notes         TEXT,
  rejected_at   TEXT,
  reject_type   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_app_company ON applications(company);

CREATE TABLE IF NOT EXISTS resumes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  size          INTEGER NOT NULL,
  note          TEXT,
  uploaded_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  event_date      TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_app ON events(application_id);

CREATE TABLE IF NOT EXISTS interviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round           TEXT NOT NULL,
  scheduled_at    TEXT NOT NULL,
  location        TEXT,
  review_file     TEXT,
  done            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iv_app ON interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_iv_time ON interviews(scheduled_at);

CREATE TABLE IF NOT EXISTS checklist_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id    INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  done            INTEGER NOT NULL DEFAULT 0,
  sort            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner           TEXT NOT NULL CHECK(owner IN ('others','mine')),
  company         TEXT NOT NULL,
  position        TEXT,
  round           TEXT,
  source_type     TEXT NOT NULL DEFAULT 'manual',
  note            TEXT,
  application_id  INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ks_owner ON knowledge_sources(owner);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  answer          TEXT,
  category        TEXT NOT NULL DEFAULT '其他',
  sub_category    TEXT,
  mastery         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ki_source ON knowledge_items(source_id);
CREATE INDEX IF NOT EXISTS idx_ki_category ON knowledge_items(category);
CREATE INDEX IF NOT EXISTS idx_ki_mastery ON knowledge_items(mastery);

CREATE TABLE IF NOT EXISTS knowledge_images (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  stored_name     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id      INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  filename          TEXT NOT NULL,               -- 原始文件名
  stored_name       TEXT NOT NULL,               -- 存储文件名（data/recordings/）
  size              INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'uploading',
  -- uploading(转传OSS) / transcribing(转写中) / analyzing(分析中) / done / failed
  transcript        TEXT,                        -- ASR 转写全文（留存）
  knowledge_source_id INTEGER REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_iv ON recordings(interview_id);

CREATE TABLE IF NOT EXISTS tutor_sessions (      -- AI 助教会话（需求 3.9.4）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL DEFAULT '新对话',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tutor_messages (      -- 助教对话消息
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tm_session ON tutor_messages(session_id);

CREATE TABLE IF NOT EXISTS settings (                -- 运行时可变的杂项设置（如当前 AI 模型）
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (        -- agent 运行记录（一次总目标 = 一条）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  goal            TEXT NOT NULL,                    -- 总目标（启动时注入的自然语言指令）
  status          TEXT NOT NULL DEFAULT 'running',  -- running/done/aborted/failed/waiting_login
  steps           INTEGER NOT NULL DEFAULT 0,
  summary         TEXT,                             -- 模型 done 时汇报的总结
  error           TEXT,
  trigger         TEXT NOT NULL DEFAULT 'manual',   -- manual/schedule
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ar_status ON automation_runs(status);

CREATE TABLE IF NOT EXISTS automation_logs (        -- 每一步的截图/动作/推理（前端回放审计）
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  step            INTEGER NOT NULL,
  screenshot      TEXT,                             -- AUTOMATION_DIR 内的文件名
  tool_name       TEXT,
  tool_args       TEXT,                             -- JSON
  thought         TEXT,                             -- 模型这一步的分析摘要
  result          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_al_run ON automation_logs(run_id);

CREATE TABLE IF NOT EXISTS automation_counters (    -- 每日动作计数（硬限制依据）
  date            TEXT PRIMARY KEY,
  actions         INTEGER NOT NULL DEFAULT 0        -- click/type/scroll 等执行次数
);
`)

// 数据迁移：automation_logs 增加 url 列（记录每步页面地址，排查页面异常跳转用）
try { db.exec('ALTER TABLE automation_logs ADD COLUMN url TEXT') } catch { /* 列已存在 */ }

// Additive migration: existing application dates and records remain unchanged.
if (!(db.pragma('table_info(applications)') as { name: string }[]).some(column => column.name === 'applied_time')) {
  db.exec('ALTER TABLE applications ADD COLUMN applied_time TEXT')
}
db.exec(`
CREATE TABLE IF NOT EXISTS application_imports (
  id TEXT PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  analysis_json TEXT,
  confirmed_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_application_import_app ON application_imports(application_id);
CREATE TABLE IF NOT EXISTS application_materials (
  import_id TEXT NOT NULL REFERENCES application_imports(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text', 'image')),
  text TEXT,
  filename TEXT,
  stored_name TEXT,
  mime TEXT,
  captured_at TEXT,
  PRIMARY KEY (import_id, id)
);
`)

// 数据迁移：曾短暂把轮次状态合并为 interviewing，按最新面试记录恢复轮次（无记录则归为一面）
db.prepare(`UPDATE applications SET status = CASE
  (SELECT round FROM interviews WHERE application_id = applications.id ORDER BY scheduled_at DESC, id DESC LIMIT 1)
  WHEN '一面' THEN 'round1' WHEN '二面' THEN 'round2' WHEN '三面' THEN 'round3' WHEN 'HR面' THEN 'hr'
  ELSE 'round1' END
  WHERE status = 'interviewing'`).run()

export function now(): string {
  return new Date().toISOString()
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
