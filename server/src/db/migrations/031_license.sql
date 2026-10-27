-- Panel-side license client (§16.8): one row of state for this server plus the
-- event timeline that feeds audit_log and the Contact Manager.
CREATE TABLE IF NOT EXISTS license_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_enc TEXT,
  token TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  activation_id TEXT,
  status TEXT NOT NULL DEFAULT 'unlicensed',
  last_checkin_at TEXT,
  last_ok_at TEXT,
  next_checkin_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  messages_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO license_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS license_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_license_events_ts ON license_events (ts);
