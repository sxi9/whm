-- Account Information -------------------------------------------------------

-- Add-on entitlements (WHM "account enhancements"): a named bundle of limits
-- that is assigned to accounts on top of their package.
CREATE TABLE IF NOT EXISTS account_enhancements (
  id             INTEGER PRIMARY KEY,
  enhancement_id TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL UNIQUE,
  description    TEXT NOT NULL DEFAULT '',
  limits_json    TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_enhancement_assignments (
  account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  enhancement_id INTEGER NOT NULL REFERENCES account_enhancements (id) ON DELETE CASCADE,
  assigned_by    TEXT,
  assigned_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, enhancement_id)
);
CREATE INDEX IF NOT EXISTS idx_enhancement_assignments_enh ON account_enhancement_assignments (enhancement_id);

-- Per access-log bookkeeping for the bandwidth collector: how far into each
-- file the parser got, so hourly runs only read the bytes appended since.
CREATE TABLE IF NOT EXISTS account_bandwidth_sources (
  account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  bytes_processed INTEGER NOT NULL DEFAULT 0,
  size            INTEGER NOT NULL DEFAULT 0,
  lines           INTEGER NOT NULL DEFAULT 0,
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, path)
);

-- Settings defaults ---------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('account_info.bandwidth', '{"suspendOnExceed":false,"suspendReason":"Bandwidth limit exceeded","warnPercent":80,"maxLogBytes":33554432,"extraLogDirs":[]}'),
  ('account_info.quota', '{"warnPercent":90,"filesystem":"/"}');
