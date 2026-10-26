-- Server Status: Daily Process Log sampler storage -------------------------------
CREATE TABLE IF NOT EXISTS process_log_samples (
  id              INTEGER PRIMARY KEY,
  sampled_at      TEXT NOT NULL DEFAULT (datetime('now')),
  day             TEXT NOT NULL,
  load1           REAL,
  load5           REAL,
  load15          REAL,
  mem_used_bytes  INTEGER,
  mem_total_bytes INTEGER,
  process_count   INTEGER NOT NULL DEFAULT 0,
  cpu_percent     REAL NOT NULL DEFAULT 0,
  mem_percent     REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_process_log_samples_day ON process_log_samples (day, sampled_at);

CREATE TABLE IF NOT EXISTS process_log_entries (
  sample_id       INTEGER NOT NULL REFERENCES process_log_samples (id) ON DELETE CASCADE,
  pid             INTEGER NOT NULL,
  user            TEXT NOT NULL,
  command         TEXT NOT NULL,
  args            TEXT,
  cpu_percent     REAL NOT NULL DEFAULT 0,
  mem_percent     REAL NOT NULL DEFAULT 0,
  rss_bytes       INTEGER NOT NULL DEFAULT 0,
  elapsed_seconds INTEGER,
  PRIMARY KEY (sample_id, pid)
);
CREATE INDEX IF NOT EXISTS idx_process_log_entries_user ON process_log_entries (user);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('server_status.process_log.enabled', 'true'),
  ('server_status.process_log.top_n', '25'),
  ('server_status.process_log.retention_days', '14');
