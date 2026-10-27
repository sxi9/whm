-- Panel marketplace client (§18.6): what was installed from the hub and under
-- which consent, the revocations the hub pushed and the feed/update state.
CREATE TABLE IF NOT EXISTS marketplace_installs (
  plugin_id                  TEXT PRIMARY KEY,
  version                    TEXT NOT NULL,
  channel                    TEXT NOT NULL DEFAULT 'stable',
  package_sha256             TEXT,
  hub_kid                    TEXT,
  consented_permissions_json TEXT NOT NULL DEFAULT '[]',
  consented_by               TEXT,
  consented_at               TEXT,
  consent_state              TEXT NOT NULL DEFAULT 'pending' CHECK (consent_state IN ('consented', 'pending')),
  was_enabled                INTEGER NOT NULL DEFAULT 0,
  installed_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS marketplace_revocations (
  id              TEXT PRIMARY KEY,
  plugin_id       TEXT NOT NULL,
  version         TEXT,
  severity        TEXT NOT NULL,
  action          TEXT NOT NULL,
  reason          TEXT,
  ts              INTEGER NOT NULL,
  applied_at      TEXT,
  applied_to_json TEXT NOT NULL DEFAULT '[]',
  acknowledged_by TEXT,
  acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_revocations_plugin ON marketplace_revocations (plugin_id, ts);

CREATE TABLE IF NOT EXISTS marketplace_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_catalog_sync_at  TEXT,
  last_revocation_ts    INTEGER NOT NULL DEFAULT 0,
  last_revocation_now   INTEGER NOT NULL DEFAULT 0,
  revocations_head_ts   INTEGER NOT NULL DEFAULT 0,
  last_update_check_at  TEXT,
  pending_updates_json  TEXT NOT NULL DEFAULT '[]',
  fail_count            INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO marketplace_state (id) VALUES (1);

-- Sideloading while the hub is enabled is a developer escape hatch (§18.6).
INSERT OR IGNORE INTO settings (key, value) VALUES ('plugins.developer_mode', 'false');
