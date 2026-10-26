-- Service Configuration: databases created before web_php_pools was keyed by
-- (username, version) carry the old one-pool-per-account key; rebuild them.
-- A fresh database already has the new shape, so this only copies rows over.
CREATE TABLE IF NOT EXISTS web_php_pools_v2 (
  username      TEXT NOT NULL,
  version       TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  path          TEXT,
  socket        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('applied', 'pending', 'failed')),
  error         TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (username, version)
);
INSERT OR IGNORE INTO web_php_pools_v2 (username, version, settings_json, path, socket, status, error, updated_at)
  SELECT username, version, settings_json, path, socket, status, error, updated_at FROM web_php_pools;
DROP TABLE web_php_pools;
ALTER TABLE web_php_pools_v2 RENAME TO web_php_pools;
