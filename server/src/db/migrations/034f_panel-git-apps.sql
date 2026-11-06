-- Phase 8 P3: shared by P3-1 (Git Version Control) and P3-2 (Application
-- Manager). Each unit appends its own idempotent block.

-- P3-1 Git Version Control: one row per repository the account registered
-- through the panel (created, cloned or adopted); the directory is relative
-- to the home and the agent re-pins it there at every call.
CREATE TABLE IF NOT EXISTS panel_git_repos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  dir            TEXT NOT NULL,
  url            TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_pull_at   TEXT,
  last_deploy_at TEXT,
  UNIQUE (account_id, name),
  UNIQUE (account_id, dir)
);
CREATE INDEX IF NOT EXISTS idx_panel_git_repos_account ON panel_git_repos(account_id);

-- P3-2 Application Manager: one row per Node.js/Python app the account runs as
-- a systemd service (unit keel-app-<username>.<name> under /etc/whm/apps) and
-- publishes on one of its domains through the vhost proxies.
CREATE TABLE IF NOT EXISTS panel_apps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  dir         TEXT NOT NULL,
  entry       TEXT NOT NULL,
  runtime     TEXT NOT NULL,
  port        INTEGER NOT NULL UNIQUE,
  domain      TEXT NOT NULL,
  mount       TEXT NOT NULL DEFAULT '/',
  websocket   INTEGER NOT NULL DEFAULT 1,
  env_json    TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, name),
  UNIQUE (account_id, domain, mount)
);
CREATE INDEX IF NOT EXISTS idx_panel_apps_account ON panel_apps(account_id);
-- The vhost's reverse-proxy mounts ([{ path, port, websocket }]). Runs once
-- (schema_migrations), so the non-idempotent ADD COLUMN is safe.
ALTER TABLE web_vhosts ADD COLUMN proxies_json TEXT;
