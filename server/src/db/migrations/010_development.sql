-- Development: API tokens (extra metadata), hooks (runs + options), AppConfig apps.
ALTER TABLE api_tokens ADD COLUMN prefix TEXT;
ALTER TABLE api_tokens ADD COLUMN description TEXT;
ALTER TABLE api_tokens ADD COLUMN created_ip TEXT;
ALTER TABLE api_tokens ADD COLUMN revoked_at TEXT;

ALTER TABLE hooks ADD COLUMN name TEXT;
ALTER TABLE hooks ADD COLUMN description TEXT;
ALTER TABLE hooks ADD COLUMN blocking INTEGER NOT NULL DEFAULT 1;
ALTER TABLE hooks ADD COLUMN timeout_sec INTEGER NOT NULL DEFAULT 30;
ALTER TABLE hooks ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hooks ADD COLUMN last_run_at TEXT;
ALTER TABLE hooks ADD COLUMN last_status TEXT;
ALTER TABLE hooks ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hooks ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_hooks_event_stage ON hooks (event, stage, enabled);

CREATE TABLE IF NOT EXISTS hook_runs (
  id          INTEGER PRIMARY KEY,
  hook_id     INTEGER REFERENCES hooks (id) ON DELETE CASCADE,
  hook_name   TEXT,
  event       TEXT NOT NULL,
  stage       TEXT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT 'event',
  status      TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'error', 'skipped')),
  exit_code   INTEGER,
  duration_ms INTEGER,
  stdout      TEXT,
  stderr      TEXT,
  payload     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hook_runs_hook ON hook_runs (hook_id, id);

CREATE TABLE IF NOT EXISTS appconfig_apps (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  url          TEXT NOT NULL,
  service      TEXT NOT NULL DEFAULT 'whm' CHECK (service IN ('whm', 'cpanel', 'webmail')),
  description  TEXT,
  icon         TEXT,
  acls_json    TEXT NOT NULL DEFAULT '["all"]',
  features_json TEXT NOT NULL DEFAULT '[]',
  display      INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  entry_url    TEXT,
  phpopts_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('development.hooks.enabled', 'true'),
  ('development.hooks.default_timeout_sec', '30'),
  ('development.hooks.keep_runs', '500'),
  ('development.tokens.default_expiry_days', '90'),
  ('development.tokens.max_per_user', '50');
