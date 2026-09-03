import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { runMigrations } from './migrations.js'
import {
  APPLICATION_MATERIALS_DIR, DATA_DIR, KNOWLEDGE_IMAGES_DIR,
  RECORDINGS_DIR, REVIEWS_DIR, UPLOADS_DIR
} from './data-paths.js'

export {
  APPLICATION_MATERIALS_DIR, DATA_DIR, KNOWLEDGE_IMAGES_DIR,
  RECORDINGS_DIR, REVIEWS_DIR, UPLOADS_DIR
}

for (const dir of [DATA_DIR, UPLOADS_DIR, REVIEWS_DIR, KNOWLEDGE_IMAGES_DIR, RECORDINGS_DIR, APPLICATION_MATERIALS_DIR]) {
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

CREATE TABLE IF NOT EXISTS ai_runs (                 -- AI 请求元数据；不保存提示词和原始响应
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task              TEXT NOT NULL,
  model             TEXT,
  prompt_hash       TEXT NOT NULL,
  request_id        TEXT,
  duration_ms       INTEGER NOT NULL,
  finish_reason     TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  status            TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
  error_type        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_task_created ON ai_runs(task, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_status_created ON ai_runs(status, created_at DESC);
`)

// 所有增量升级按编号执行并记录在 schema_migrations；旧数据库可直接跨版本升级。
runMigrations(db)

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
