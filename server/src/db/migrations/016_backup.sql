-- Backup -----------------------------------------------------------------------

-- Per-account include/exclude (Backup User Selection). Accounts without a row
-- follow the backup.default_include setting.
CREATE TABLE IF NOT EXISTS backup_user_selection (
  account_id INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per backup run (scheduled or manual), summarising the per-account outcome.
CREATE TABLE IF NOT EXISTS backup_runs (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('scheduled', 'manual')),
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  accounts_total  INTEGER NOT NULL DEFAULT 0,
  accounts_ok     INTEGER NOT NULL DEFAULT 0,
  accounts_failed INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  summary_json  TEXT NOT NULL DEFAULT '{}',
  error         TEXT,
  started_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

-- Where each archive was copied, per destination.
CREATE TABLE IF NOT EXISTS backup_uploads (
  id             INTEGER PRIMARY KEY,
  backup_id      INTEGER NOT NULL REFERENCES backups (id) ON DELETE CASCADE,
  destination_id INTEGER REFERENCES backup_destinations (id) ON DELETE SET NULL,
  destination_name TEXT,
  remote_path    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('done', 'failed', 'removed')),
  error          TEXT,
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backup_uploads_backup ON backup_uploads (backup_id);

-- Restore history (full account and file/directory restores).
CREATE TABLE IF NOT EXISTS backup_restores (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  backup_id    INTEGER REFERENCES backups (id) ON DELETE SET NULL,
  account_name TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('account', 'files')),
  options_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  error        TEXT,
  started_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

ALTER TABLE backups ADD COLUMN run_id INTEGER REFERENCES backup_runs (id) ON DELETE SET NULL;
ALTER TABLE backups ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE backups ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backups ADD COLUMN local_present INTEGER NOT NULL DEFAULT 1;
ALTER TABLE backups ADD COLUMN components_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE backups ADD COLUMN error TEXT;
CREATE INDEX IF NOT EXISTS idx_backups_account ON backups (account_name, created_at);

ALTER TABLE backup_destinations ADD COLUMN last_test_at TEXT;
ALTER TABLE backup_destinations ADD COLUMN last_test_ok INTEGER;
ALTER TABLE backup_destinations ADD COLUMN last_test_message TEXT;
ALTER TABLE backup_destinations ADD COLUMN updated_at TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('backup.enabled', 'false'),
  ('backup.schedule', '"0 2 * * *"'),
  ('backup.retention_daily', '7'),
  ('backup.retention_weekly', '4'),
  ('backup.retention_monthly', '3'),
  ('backup.local_dir', '"/backup"'),
  ('backup.include_home', 'true'),
  ('backup.include_mail', 'true'),
  ('backup.include_dbs', 'true'),
  ('backup.include_dns', 'true'),
  ('backup.include_metadata', 'true'),
  ('backup.compression_level', '6'),
  ('backup.strict', 'false'),
  ('backup.keep_local', 'true'),
  ('backup.prune_remote', 'true'),
  ('backup.default_include', 'true'),
  ('backup.skip_suspended', 'false'),
  ('backup.excludes', '["tmp", "logs", ".cache"]'),
  ('backup.notify_on_failure', 'true');
