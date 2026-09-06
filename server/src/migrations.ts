import type Database from 'better-sqlite3'

type SqliteDatabase = Database.Database

interface Migration {
  version: number
  name: string
  optional?: boolean
  up: (db: SqliteDatabase) => void
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some(item => item.name === column)
}

function addColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'legacy_reliability_columns',
    up(db) {
      addColumn(db, 'tutor_messages', 'request_id', 'TEXT')
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_request_role
        ON tutor_messages(request_id, role) WHERE request_id IS NOT NULL`)
    }
  },
  {
    version: 2,
    name: 'application_import_materials',
    up(db) {
      addColumn(db, 'applications', 'applied_time', 'TEXT')
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
    }
  },
  {
    version: 3,
    name: 'ai_observability_inference_copies_recording_resume',
    up(db) {
      addColumn(db, 'application_materials', 'inference_stored_name', 'TEXT')
      addColumn(db, 'application_materials', 'inference_mime', 'TEXT')
      addColumn(db, 'knowledge_images', 'inference_stored_name', 'TEXT')
      addColumn(db, 'knowledge_images', 'inference_mime', 'TEXT')
      addColumn(db, 'recordings', 'analysis_json', 'TEXT')
      addColumn(db, 'recordings', 'analysis_stage', "TEXT NOT NULL DEFAULT 'pending'")
      addColumn(db, 'recordings', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          model TEXT,
          prompt_hash TEXT NOT NULL,
          request_id TEXT,
          duration_ms INTEGER NOT NULL,
          finish_reason TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          total_tokens INTEGER,
          status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
          error_type TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_runs_task_created ON ai_runs(task, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_runs_status_created ON ai_runs(status, created_at DESC);
        CREATE TABLE IF NOT EXISTS recording_analysis_chunks (
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          start_offset INTEGER NOT NULL,
          end_offset INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','analyzing','done','failed')),
          result_json TEXT,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(recording_id, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_recording_chunks_status ON recording_analysis_chunks(recording_id, status);
      `)
    }
  },
  {
    version: 4,
    name: 'restore_interview_round_statuses',
    up(db) {
      db.prepare(`UPDATE applications SET status = CASE
        (SELECT round FROM interviews WHERE application_id = applications.id ORDER BY scheduled_at DESC, id DESC LIMIT 1)
        WHEN '一面' THEN 'round1' WHEN '二面' THEN 'round2' WHEN '三面' THEN 'round3' WHEN 'HR面' THEN 'hr'
        ELSE 'round1' END
        WHERE status = 'interviewing'`).run()
    }
  },
  {
    version: 5,
    name: 'knowledge_retrieval_audit_citations_feedback',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_retrieval_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL UNIQUE,
          session_id INTEGER REFERENCES tutor_sessions(id) ON DELETE SET NULL,
          assistant_message_id INTEGER REFERENCES tutor_messages(id) ON DELETE CASCADE,
          query_hash TEXT NOT NULL,
          mode TEXT NOT NULL,
          result_ids_json TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_created ON knowledge_retrieval_runs(created_at DESC);
        CREATE TABLE IF NOT EXISTS tutor_message_citations (
          message_id INTEGER NOT NULL REFERENCES tutor_messages(id) ON DELETE CASCADE,
          knowledge_item_id INTEGER NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
          citation_key TEXT NOT NULL,
          rank INTEGER NOT NULL,
          score REAL NOT NULL,
          PRIMARY KEY(message_id, knowledge_item_id),
          UNIQUE(message_id, citation_key)
        );
        CREATE INDEX IF NOT EXISTS idx_tutor_citations_item ON tutor_message_citations(knowledge_item_id);
        CREATE TABLE IF NOT EXISTS tutor_message_feedback (
          message_id INTEGER PRIMARY KEY REFERENCES tutor_messages(id) ON DELETE CASCADE,
          value INTEGER NOT NULL CHECK(value IN (-1, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 6,
    name: 'knowledge_fts5_trigram_bm25',
    optional: true,
    up(db) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_fts USING fts5(
          question, answer, category, company, position, round,
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ai AFTER INSERT ON knowledge_items BEGIN
          INSERT INTO knowledge_items_fts(rowid, question, answer, category, company, position, round)
          VALUES (
            new.id, new.question, COALESCE(new.answer,''), new.category,
            COALESCE((SELECT company FROM knowledge_sources WHERE id=new.source_id),''),
            COALESCE((SELECT position FROM knowledge_sources WHERE id=new.source_id),''),
            COALESCE((SELECT round FROM knowledge_sources WHERE id=new.source_id),'')
          );
        END;
        CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ad AFTER DELETE ON knowledge_items BEGIN
          DELETE FROM knowledge_items_fts WHERE rowid=old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_au AFTER UPDATE ON knowledge_items BEGIN
          DELETE FROM knowledge_items_fts WHERE rowid=old.id;
          INSERT INTO knowledge_items_fts(rowid, question, answer, category, company, position, round)
          VALUES (
            new.id, new.question, COALESCE(new.answer,''), new.category,
            COALESCE((SELECT company FROM knowledge_sources WHERE id=new.source_id),''),
            COALESCE((SELECT position FROM knowledge_sources WHERE id=new.source_id),''),
            COALESCE((SELECT round FROM knowledge_sources WHERE id=new.source_id),'')
          );
        END;
        CREATE TRIGGER IF NOT EXISTS knowledge_sources_fts_au AFTER UPDATE OF company, position, round ON knowledge_sources BEGIN
          DELETE FROM knowledge_items_fts WHERE rowid IN (SELECT id FROM knowledge_items WHERE source_id=new.id);
          INSERT INTO knowledge_items_fts(rowid, question, answer, category, company, position, round)
          SELECT id, question, COALESCE(answer,''), category, new.company, COALESCE(new.position,''), COALESCE(new.round,'')
          FROM knowledge_items WHERE source_id=new.id;
        END;
        DELETE FROM knowledge_items_fts;
        INSERT INTO knowledge_items_fts(rowid, question, answer, category, company, position, round)
        SELECT i.id, i.question, COALESCE(i.answer,''), i.category,
               COALESCE(s.company,''), COALESCE(s.position,''), COALESCE(s.round,'')
        FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id;
      `)
    }
  },
  {
    version: 7,
    name: 'interview_prep_agent',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prep_agent_runs (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL UNIQUE,
          request_id TEXT NOT NULL UNIQUE,
          application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_review','committing','completed','failed','cancelled')),
          goal TEXT NOT NULL,
          constraints_json TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          snapshot_hash TEXT,
          current_node TEXT,
          plan_json TEXT,
          evidence_json TEXT,
          warnings_json TEXT NOT NULL DEFAULT '[]',
          error_type TEXT,
          error_message TEXT,
          model_calls INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_prep_agent_interview_created
          ON prep_agent_runs(interview_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_prep_agent_status_updated
          ON prep_agent_runs(status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS prep_agent_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES prep_agent_runs(id) ON DELETE CASCADE,
          node TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
          summary TEXT,
          duration_ms INTEGER,
          input_hash TEXT,
          output_hash TEXT,
          error_type TEXT,
          created_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_prep_agent_steps_run
          ON prep_agent_steps(run_id, id);

        CREATE TABLE IF NOT EXISTS prep_agent_plan_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES prep_agent_runs(id) ON DELETE CASCADE,
          checklist_id INTEGER UNIQUE REFERENCES checklist_items(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          priority TEXT NOT NULL,
          estimated_minutes INTEGER NOT NULL,
          reason TEXT NOT NULL,
          success_criteria TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          sort INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prep_agent_plan_run_sort
          ON prep_agent_plan_items(run_id, sort);
      `)
    }
  },
  {
    version: 8,
    name: 'prep_task_execution',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prep_task_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_item_id INTEGER NOT NULL UNIQUE REFERENCES prep_agent_plan_items(id) ON DELETE CASCADE,
          guide_json TEXT,
          progress_json TEXT NOT NULL DEFAULT '{"steps":[],"checks":[]}',
          guide_model TEXT,
          guide_generated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_prep_task_sessions_updated
          ON prep_task_sessions(updated_at DESC);

        CREATE TABLE IF NOT EXISTS prep_task_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES prep_task_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL,
          request_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_prep_task_messages_session
          ON prep_task_messages(session_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prep_task_messages_request_role
          ON prep_task_messages(session_id, request_id, role) WHERE request_id IS NOT NULL;
      `)
    }
  },
  {
    version: 9,
    name: 'prep_task_course_guides',
    up(db) {
      db.exec(`
        ALTER TABLE prep_task_sessions ADD COLUMN guide_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'idle';
        ALTER TABLE prep_task_sessions ADD COLUMN generation_stage TEXT;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_progress INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_error TEXT;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_started_at TEXT;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_model_calls INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_prompt_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_completion_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE prep_task_sessions ADD COLUMN generation_total_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE prep_task_sessions ADD COLUMN quality_json TEXT;
      `)
    }
  },
  {
    version: 10,
    name: 'mail_accounts',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          secure INTEGER NOT NULL DEFAULT 1 CHECK(secure IN (0, 1)),
          mailbox TEXT NOT NULL DEFAULT 'INBOX',
          credential_ref TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','error')),
          last_tested_at TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_provider
          ON mail_accounts(provider);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_email
          ON mail_accounts(email);
      `)
    }
  },
  {
    version: 11,
    name: 'mail_envelope_scans',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_sync_state (
          account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
          mailbox TEXT NOT NULL,
          uid_validity TEXT NOT NULL,
          last_uid INTEGER NOT NULL DEFAULT 0,
          last_scanned_at TEXT NOT NULL,
          PRIMARY KEY(account_id, mailbox)
        );

        CREATE TABLE IF NOT EXISTS mail_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
          mailbox TEXT NOT NULL,
          uid_validity TEXT NOT NULL,
          uid INTEGER NOT NULL,
          subject TEXT NOT NULL,
          sender TEXT NOT NULL,
          sent_at TEXT,
          is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0, 1)),
          score INTEGER NOT NULL,
          matched_terms_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','ignored')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(account_id, mailbox, uid_validity, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_mail_candidates_status_sent
          ON mail_candidates(account_id, status, sent_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS mail_scan_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
          scanned_count INTEGER NOT NULL DEFAULT 0,
          candidate_count INTEGER NOT NULL DEFAULT 0,
          new_candidate_count INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mail_scan_runs_started
          ON mail_scan_runs(account_id, started_at DESC);
      `)
    }
  },
  {
    version: 12,
    name: 'mail_candidate_analyses',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_candidate_analyses (
          candidate_id INTEGER PRIMARY KEY REFERENCES mail_candidates(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
          extraction_json TEXT,
          body_hash TEXT,
          body_truncated INTEGER NOT NULL DEFAULT 0 CHECK(body_truncated IN (0, 1)),
          model TEXT,
          prompt_version TEXT,
          error_code TEXT,
          analyzed_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mail_candidate_analyses_status
          ON mail_candidate_analyses(status, updated_at DESC);
      `)
    }
  },
  {
    version: 13,
    name: 'recruitment_schedule_items',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS recruitment_schedule_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
          source_mail_candidate_id INTEGER REFERENCES mail_candidates(id) ON DELETE SET NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('assessment','written_test','interview','ai_interview','offer','other')),
          title TEXT NOT NULL,
          company TEXT NOT NULL DEFAULT '',
          position TEXT NOT NULL DEFAULT '',
          time_mode TEXT NOT NULL CHECK(time_mode IN ('fixed','window','deadline','duration_after_open','flexible','unknown')),
          scheduled_at TEXT,
          window_start_at TEXT,
          window_end_at TEXT,
          deadline_at TEXT,
          duration_minutes INTEGER,
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          location TEXT NOT NULL DEFAULT '',
          meeting_link TEXT NOT NULL DEFAULT '',
          action_link TEXT NOT NULL DEFAULT '',
          contact TEXT NOT NULL DEFAULT '',
          instructions_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recruitment_schedule_mail_candidate
          ON recruitment_schedule_items(source_mail_candidate_id)
          WHERE source_mail_candidate_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_recruitment_schedule_status_time
          ON recruitment_schedule_items(status, scheduled_at, window_end_at, deadline_at);
        CREATE INDEX IF NOT EXISTS idx_recruitment_schedule_application
          ON recruitment_schedule_items(application_id, status);
      `)
    }
  },
  {
    version: 14,
    name: 'mail_automation_settings',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_automation_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          run_time TEXT NOT NULL DEFAULT '09:00',
          last_run_at TEXT,
          last_status TEXT NOT NULL DEFAULT 'idle' CHECK(last_status IN ('idle','running','succeeded','failed')),
          last_error_code TEXT,
          last_error_message TEXT,
          last_scanned_count INTEGER NOT NULL DEFAULT 0,
          last_analyzed_count INTEGER NOT NULL DEFAULT 0,
          last_confirmed_count INTEGER NOT NULL DEFAULT 0,
          last_review_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO mail_automation_settings (id, enabled, run_time, updated_at)
        VALUES (1, 0, '09:00', datetime('now'));
      `)
    }
  },
  {
    version: 15,
    name: 'mail_schedule_reviews',
    up(db) {
      db.exec(`
        ALTER TABLE mail_candidate_analyses ADD COLUMN schedule_review_json TEXT;
        ALTER TABLE mail_candidate_analyses ADD COLUMN review_model TEXT;
        ALTER TABLE mail_candidate_analyses ADD COLUMN review_prompt_version TEXT;
        ALTER TABLE mail_candidate_analyses ADD COLUMN review_error_code TEXT;
      `)
    }
  },
  {
    version: 16,
    name: 'prep_agent_analysis_snapshots',
    up(db) {
      addColumn(db, 'prep_agent_runs', 'role_profile_json', 'TEXT')
      addColumn(db, 'prep_agent_runs', 'gap_analysis_json', 'TEXT')
      addColumn(db, 'prep_agent_runs', 'critic_json', 'TEXT')
    }
  },
  {
    version: 17,
    name: 'ai_call_audit_records',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_call_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ai_run_id INTEGER REFERENCES ai_runs(id) ON DELETE SET NULL,
          retry_of_call_id INTEGER REFERENCES ai_call_records(id) ON DELETE SET NULL,
          task TEXT NOT NULL,
          stage TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          model TEXT,
          prompt_hash TEXT NOT NULL,
          provider_request_id TEXT,
          request_messages_json TEXT NOT NULL,
          response_schema_json TEXT,
          request_options_json TEXT NOT NULL,
          raw_response TEXT,
          parsed_response_json TEXT,
          validated_response_json TEXT,
          status TEXT NOT NULL CHECK(status IN ('succeeded','validation_failed','provider_failed')),
          error_type TEXT,
          error_message TEXT,
          duration_ms INTEGER NOT NULL,
          finish_reason TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          total_tokens INTEGER,
          created_at TEXT NOT NULL,
          finished_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_call_records_created
          ON ai_call_records(id DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_call_records_task_stage
          ON ai_call_records(task, stage, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_call_records_retry
          ON ai_call_records(retry_of_call_id);
      `)
    }
  },
  {
    version: 18,
    name: 'operation_observability',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS operation_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual','scheduled','retry','system')),
          status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial_success','failed','cancelled')),
          parent_entity_type TEXT,
          parent_entity_id TEXT,
          input_summary_json TEXT,
          result_summary_json TEXT,
          retry_of_run_id INTEGER REFERENCES operation_runs(id) ON DELETE SET NULL,
          error_code TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_operation_runs_created ON operation_runs(id DESC);
        CREATE INDEX IF NOT EXISTS idx_operation_runs_trace ON operation_runs(trace_id, id);
        CREATE INDEX IF NOT EXISTS idx_operation_runs_status ON operation_runs(status, started_at DESC);
        CREATE TABLE IF NOT EXISTS operation_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_run_id INTEGER NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
          parent_step_id INTEGER REFERENCES operation_steps(id) ON DELETE SET NULL,
          step_name TEXT NOT NULL,
          sequence INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('running','succeeded','skipped','failed')),
          input_summary_json TEXT,
          output_summary_json TEXT,
          error_code TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_operation_steps_run ON operation_steps(operation_run_id, id);
        CREATE TABLE IF NOT EXISTS app_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
          source TEXT NOT NULL,
          event_name TEXT NOT NULL,
          trace_id TEXT,
          operation_run_id INTEGER REFERENCES operation_runs(id) ON DELETE SET NULL,
          operation_step_id INTEGER REFERENCES operation_steps(id) ON DELETE SET NULL,
          entity_type TEXT,
          entity_id TEXT,
          message TEXT NOT NULL,
          context_json TEXT,
          error_code TEXT,
          error_stack TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(id DESC);
        CREATE INDEX IF NOT EXISTS idx_app_logs_trace ON app_logs(trace_id, id);
        CREATE INDEX IF NOT EXISTS idx_app_logs_run ON app_logs(operation_run_id, id);
        CREATE INDEX IF NOT EXISTS idx_app_logs_error ON app_logs(level, error_code, id DESC);
      `)
      addColumn(db, 'ai_call_records', 'trace_id', 'TEXT')
      addColumn(db, 'ai_call_records', 'operation_run_id', 'INTEGER REFERENCES operation_runs(id) ON DELETE SET NULL')
      addColumn(db, 'ai_call_records', 'operation_step_id', 'INTEGER REFERENCES operation_steps(id) ON DELETE SET NULL')
      addColumn(db, 'ai_call_records', 'parent_entity_type', 'TEXT')
      addColumn(db, 'ai_call_records', 'parent_entity_id', 'TEXT')
      addColumn(db, 'ai_call_records', 'provider_attempts', 'INTEGER')
      addColumn(db, 'prep_agent_runs', 'trace_id', 'TEXT')
      addColumn(db, 'prep_agent_runs', 'operation_run_id', 'INTEGER REFERENCES operation_runs(id) ON DELETE SET NULL')
      addColumn(db, 'prep_agent_steps', 'operation_step_id', 'INTEGER REFERENCES operation_steps(id) ON DELETE SET NULL')
      addColumn(db, 'mail_scan_runs', 'operation_run_id', 'INTEGER REFERENCES operation_runs(id) ON DELETE SET NULL')
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_call_records_trace ON ai_call_records(trace_id, id);
        CREATE INDEX IF NOT EXISTS idx_ai_call_records_operation ON ai_call_records(operation_run_id, id);
      `)
    }
  },
  {
    version: 19,
    name: 'prep_task_operation_observability',
    up(db) {
      addColumn(db, 'prep_task_sessions', 'trace_id', 'TEXT')
      addColumn(db, 'prep_task_sessions', 'operation_run_id', 'INTEGER REFERENCES operation_runs(id) ON DELETE SET NULL')
      db.exec(`CREATE INDEX IF NOT EXISTS idx_prep_task_sessions_operation ON prep_task_sessions(operation_run_id)`)
    }
  },
  {
    version: 20,
    name: 'project_code_archives',
    up(db) {
      // 被分析的代码仓库始终是外部只读来源；这里仅保存 job-tracer 自己的索引和用户确认的信息。
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          source_path TEXT NOT NULL,
          root_realpath TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','scanning','failed','archived')),
          last_scan_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_profiles_root ON project_profiles(root_realpath);
        CREATE TABLE IF NOT EXISTS project_repo_scans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project_profiles(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial_success','failed')),
          root_realpath TEXT NOT NULL,
          file_limit INTEGER NOT NULL,
          byte_limit INTEGER NOT NULL,
          files_seen INTEGER NOT NULL DEFAULT 0,
          files_indexed INTEGER NOT NULL DEFAULT 0,
          files_skipped INTEGER NOT NULL DEFAULT 0,
          bytes_read INTEGER NOT NULL DEFAULT 0,
          truncated INTEGER NOT NULL DEFAULT 0,
          skipped_json TEXT NOT NULL DEFAULT '[]',
          error_message TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_project_scans_project ON project_repo_scans(project_id, id DESC);
        CREATE TABLE IF NOT EXISTS project_code_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project_profiles(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          language TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          line_count INTEGER NOT NULL,
          is_generated INTEGER NOT NULL DEFAULT 0,
          last_seen_scan_id INTEGER NOT NULL REFERENCES project_repo_scans(id) ON DELETE CASCADE,
          indexed_at TEXT NOT NULL,
          UNIQUE(project_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_code_files_project ON project_code_files(project_id, relative_path);
        CREATE TABLE IF NOT EXISTS project_code_symbols (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project_profiles(id) ON DELETE CASCADE,
          file_id INTEGER NOT NULL REFERENCES project_code_files(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          exported INTEGER NOT NULL DEFAULT 0,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          signature TEXT NOT NULL DEFAULT '',
          last_seen_scan_id INTEGER NOT NULL REFERENCES project_repo_scans(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_symbols_project ON project_code_symbols(project_id, name);
        CREATE TABLE IF NOT EXISTS project_code_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project_profiles(id) ON DELETE CASCADE,
          file_id INTEGER NOT NULL REFERENCES project_code_files(id) ON DELETE CASCADE,
          symbol_id INTEGER REFERENCES project_code_symbols(id) ON DELETE SET NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          last_seen_scan_id INTEGER NOT NULL REFERENCES project_repo_scans(id) ON DELETE CASCADE,
          UNIQUE(project_id, file_id, start_line, end_line)
        );
        CREATE INDEX IF NOT EXISTS idx_project_chunks_project ON project_code_chunks(project_id, file_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS project_code_chunks_fts USING fts5(content, relative_path UNINDEXED, project_id UNINDEXED, chunk_id UNINDEXED);
        CREATE TABLE IF NOT EXISTS project_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project_profiles(id) ON DELETE CASCADE,
          fact_type TEXT NOT NULL CHECK(fact_type IN ('architecture','responsibility','technology','decision','metric','risk')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          evidence_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
          confidence TEXT NOT NULL DEFAULT 'user_confirmed' CHECK(confidence IN ('inferred','user_confirmed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_facts_project ON project_facts(project_id, fact_type, id DESC);
      `)
    }
  },
  {
    version: 21,
    name: 'project_code_incremental_scopes',
    up(db) {
      // 增量判断只使用源码文件元数据；不会运行 Git 命令，也不会改动源码仓库的索引或工作区。
      addColumn(db, 'project_profiles', 'scan_scopes_json', "TEXT NOT NULL DEFAULT '[]'")
      addColumn(db, 'project_code_files', 'mtime_ms', 'REAL')
      addColumn(db, 'project_repo_scans', 'files_reused', 'INTEGER NOT NULL DEFAULT 0')
    }
  },
  {
    version: 22,
    name: 'code_reading_agent_sessions',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_reading_sessions (
          id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES project_profiles(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          output_mode TEXT NOT NULL CHECK(output_mode IN ('explain','architecture','interview_story')),
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
          model TEXT,
          tool_calls_used INTEGER NOT NULL DEFAULT 0,
          bytes_read INTEGER NOT NULL DEFAULT 0,
          max_tool_calls INTEGER NOT NULL,
          max_bytes_read INTEGER NOT NULL,
          final_json TEXT,
          error_code TEXT,
          error_message TEXT,
          trace_id TEXT,
          operation_run_id INTEGER REFERENCES operation_runs(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_code_reading_sessions_project ON code_reading_sessions(project_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS code_reading_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES code_reading_sessions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('model','tool','final')),
          tool_name TEXT,
          input_json TEXT,
          output_json TEXT,
          status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
          error_message TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_code_reading_steps_session ON code_reading_steps(session_id, sequence);
        CREATE TABLE IF NOT EXISTS code_reading_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES code_reading_sessions(id) ON DELETE CASCADE,
          evidence_ref TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          excerpt TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, evidence_ref)
        );
        CREATE INDEX IF NOT EXISTS idx_code_reading_evidence_session ON code_reading_evidence(session_id, id);
        CREATE TABLE IF NOT EXISTS code_reading_claims (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES code_reading_sessions(id) ON DELETE CASCADE,
          claim_kind TEXT NOT NULL CHECK(claim_kind IN ('code_fact','inference','user_confirmation_required')),
          statement TEXT NOT NULL,
          confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
          evidence_refs_json TEXT NOT NULL DEFAULT '[]',
          caveat TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_code_reading_claims_session ON code_reading_claims(session_id, id);
      `)
    }
  },
  {
    version: 23,
    name: 'resume_text_for_prep_agent',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS resume_texts (
          resume_id INTEGER PRIMARY KEY REFERENCES resumes(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('pending','extracting','completed','failed','unsupported')),
          text_content TEXT,
          content_hash TEXT,
          error_message TEXT,
          extracted_at TEXT,
          updated_at TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 24,
    name: 'resume_async_vision_extraction',
    up(db) {
      addColumn(db, 'resume_texts', 'extraction_method', 'TEXT')
      addColumn(db, 'resume_texts', 'model', 'TEXT')
      addColumn(db, 'resume_texts', 'page_count', 'INTEGER')
      addColumn(db, 'resume_texts', 'pages_completed', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'resume_texts', 'started_at', 'TEXT')
    }
  },
  {
    version: 25,
    name: 'application_progress_link',
    up(db) {
      // jd_link 保持岗位 JD / 职位来源语义；投递后的查询入口单独保存，避免两者互相覆盖。
      addColumn(db, 'applications', 'application_link', 'TEXT')
    }
  },
  {
    version: 26,
    name: 'split_legacy_links_by_status',
    up(db) {
      // 历史只有 jd_link 一个字段：未投递记录保存职位 JD，已投递及后续状态保存进度查询入口。
      db.prepare(`UPDATE applications
        SET application_link = jd_link, jd_link = NULL
        WHERE status <> 'unsent'
          AND trim(coalesce(jd_link, '')) <> ''`).run()
    }
  }
]

export function runMigrations(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(row => row.version))
  const record = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    try {
      db.transaction(() => {
        migration.up(db)
        record.run(migration.version, migration.name, new Date().toISOString())
      })()
      console.log(`[db] migration ${String(migration.version).padStart(3, '0')} ${migration.name}`)
    } catch (error) {
      if (!migration.optional) throw error
      console.warn(`[db] optional migration ${String(migration.version).padStart(3, '0')} skipped:`, (error as Error).message)
    }
  }
}
