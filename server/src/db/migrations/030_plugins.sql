-- Plugins category: which bundled plugins (plugins/bundled/<id>) the panel has
-- installed into the plugin host at boot, so an upgrade of the panel upgrades
-- the plugin exactly once and a plugin the operator removed is reported, not
-- silently re-installed.
CREATE TABLE IF NOT EXISTS bundled_plugins (
  id TEXT PRIMARY KEY,
  bundled_version TEXT NOT NULL,
  installed_version TEXT,
  action TEXT NOT NULL DEFAULT 'kept',
  last_error TEXT,
  installed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-click WordPress installs run by the Plugins category (WP Toolkit).
CREATE TABLE IF NOT EXISTS wp_installs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT NOT NULL,
  db_name TEXT,
  db_user TEXT,
  job_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  requested_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wp_installs_username ON wp_installs (username, created_at);
