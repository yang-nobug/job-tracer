import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.resolve(__dirname, '../../data')
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
export const REVIEWS_DIR = path.join(DATA_DIR, 'reviews')

for (const dir of [DATA_DIR, UPLOADS_DIR, REVIEWS_DIR]) {
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
`)

export function now(): string {
  return new Date().toISOString()
}

export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
