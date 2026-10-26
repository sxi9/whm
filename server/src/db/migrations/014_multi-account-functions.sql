-- Multi Account Functions: every bulk run (IP change / modify-upgrade) is kept
-- with one row per account so the result can be reviewed and downloaded later.
CREATE TABLE IF NOT EXISTS multi_account_runs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('change_ip', 'modify')),
  job_id        INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  requested_by  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  params_json   TEXT NOT NULL DEFAULT '{}',
  totals_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_multi_account_runs_kind ON multi_account_runs (kind, id);

CREATE TABLE IF NOT EXISTS multi_account_run_items (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES multi_account_runs (id) ON DELETE CASCADE,
  account_id   INTEGER,
  username     TEXT NOT NULL,
  domain       TEXT,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'pending', 'failed', 'skipped', 'unchanged')),
  detail       TEXT,
  before_json  TEXT NOT NULL DEFAULT '{}',
  after_json   TEXT NOT NULL DEFAULT '{}',
  steps_json   TEXT NOT NULL DEFAULT '{}',
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_multi_account_run_items_run ON multi_account_run_items (run_id, id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('multi_account.max_batch', '500');
INSERT OR IGNORE INTO settings (key, value) VALUES ('multi_account.run_retention_days', '90');
