-- Plugin host ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plugins (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  version        TEXT NOT NULL,
  manifest_json  TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'installed' CHECK (state IN ('installed', 'enabled', 'disabled', 'errored')),
  last_error     TEXT,
  source         TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'path', 'bundled', 'marketplace')),
  signer         TEXT,
  package_sha256 TEXT,
  signed         INTEGER NOT NULL DEFAULT 0,
  installed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  enabled_at     TEXT
);

-- password-type values are encrypted with the panel master key before they are stored.
CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_id, key)
);

CREATE TABLE IF NOT EXISTS plugin_store (
  plugin_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_id, key)
);

CREATE TABLE IF NOT EXISTS plugin_docs (
  plugin_id  TEXT NOT NULL,
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc_json   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_id, collection, id)
);

-- Ring buffer: the host keeps the newest 1000 rows per plugin.
CREATE TABLE IF NOT EXISTS plugin_logs (
  id          INTEGER PRIMARY KEY,
  plugin_id   TEXT NOT NULL,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  level       TEXT NOT NULL,
  msg         TEXT NOT NULL,
  fields_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugin_logs_plugin ON plugin_logs (plugin_id, id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('plugins.require_signature', 'false');
