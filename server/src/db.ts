import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.resolve(__dirname, '../../data')
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
export const REVIEWS_DIR = path.join(DATA_DIR, 'reviews')
export const KNOWLEDGE_IMAGES_DIR = path.join(DATA_DIR, 'knowledge_images')

for (const dir of [DATA_DIR, UPLOADS_DIR, REVIEWS_DIR, KNOWLEDGE_IMAGES_DIR]) {
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

export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
