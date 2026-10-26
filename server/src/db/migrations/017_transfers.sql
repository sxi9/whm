-- Transfers: remote server connections used by the Transfer Tool (secret kept
-- encrypted), one run per transfer / cpmove restore / addon conversion, and one
-- item per account so Review Transfers and Restores can show what happened.
CREATE TABLE IF NOT EXISTS transfer_sessions (
  id             INTEGER PRIMARY KEY,
  host           TEXT NOT NULL,
  port           INTEGER NOT NULL DEFAULT 22,
  user           TEXT NOT NULL DEFAULT 'root',
  auth_type      TEXT NOT NULL CHECK (auth_type IN ('password', 'key')),
  secret_enc     TEXT NOT NULL,
  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  probe_json     TEXT NOT NULL DEFAULT '{}',
  accounts_json  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transfer_runs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('transfer', 'restore', 'convert_addon')),
  session_id    INTEGER REFERENCES transfer_sessions (id) ON DELETE SET NULL,
  job_id        INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  requested_by  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  source        TEXT,
  params_json   TEXT NOT NULL DEFAULT '{}',
  totals_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_runs_kind ON transfer_runs (kind, id);

CREATE TABLE IF NOT EXISTS transfer_run_items (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER NOT NULL REFERENCES transfer_runs (id) ON DELETE CASCADE,
  source_username  TEXT,
  username         TEXT NOT NULL,
  domain           TEXT,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'pending', 'failed', 'skipped')),
  detail           TEXT,
  steps_json       TEXT NOT NULL DEFAULT '{}',
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_run_items_run ON transfer_run_items (run_id, id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('transfers.staging_dir', '"/var/lib/whm/transfers"');
INSERT OR IGNORE INTO settings (key, value) VALUES ('transfers.run_retention_days', '90');
INSERT OR IGNORE INTO settings (key, value) VALUES ('transfers.session_ttl_hours', '24');
INSERT OR IGNORE INTO settings (key, value) VALUES ('transfers.rsync_bwlimit_kbps', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('transfers.archive_dirs', '["/var/lib/whm/transfers/uploads", "/backup", "/home"]');
