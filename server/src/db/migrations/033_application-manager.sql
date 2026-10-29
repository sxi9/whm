-- Application Manager: Node.js / Python / static-frontend applications run as
-- per-account systemd units (or served by Apache) and published through the
-- account's vhost via <apache root>/whm-apps/<domain>.conf.
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('node','python','static')),
  preset TEXT,
  domain TEXT NOT NULL,
  base_path TEXT NOT NULL DEFAULT '/',
  root TEXT NOT NULL,
  start_json TEXT NOT NULL DEFAULT '{}',        -- { mode, entry|script|module, workers }
  build_json TEXT NOT NULL DEFAULT '{}',        -- { install: 'npm'|'pip'|null, script: 'build'|null, outputDir, extraPackages: [] }
  runtime_kind TEXT,                            -- 'node' | 'python' | NULL (static-files)
  runtime_version TEXT,                         -- requested version ('20.11.0', 'system', '3.12')
  runtime_bin TEXT,                             -- resolved at deploy
  port INTEGER UNIQUE,
  mode TEXT NOT NULL DEFAULT 'production' CHECK (mode IN ('development','production')),
  env_enc TEXT,                                 -- ctx.crypto.encrypt(JSON of env)
  websockets INTEGER NOT NULL DEFAULT 1,
  spa_fallback INTEGER NOT NULL DEFAULT 1,
  memory_max_mb INTEGER NOT NULL DEFAULT 512,
  tasks_max INTEGER NOT NULL DEFAULT 256,
  cpu_quota_percent INTEGER NOT NULL DEFAULT 100,
  source_json TEXT,                             -- { type: 'git', url, ref } | { type: 'upload' } | { type: 'scaffold', template }
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','deploying','running','stopped','failed','built')),
  last_error TEXT,
  last_job_id INTEGER,
  unit TEXT,                                    -- 'whm-app-<id>' once written
  proxy_path TEXT,                              -- include file written for the domain
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (domain, base_path)
);
CREATE INDEX IF NOT EXISTS idx_apps_account ON apps (account_id);
CREATE INDEX IF NOT EXISTS idx_apps_domain ON apps (domain);

-- Managed Node installs under /opt/whm/runtimes; system runtimes are detected live.
CREATE TABLE IF NOT EXISTS app_runtimes (
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL,
  bin TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, version)
);

-- Custom presets; the built-ins live in services/application-manager.js.
CREATE TABLE IF NOT EXISTS app_templates (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('node','python','static')),
  preset_json TEXT NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('apps.port_range', '[30000,39999]'),
  ('apps.default_node', '"system"'),
  ('apps.default_python', '"system"'),
  ('apps.default_memory_mb', '512'),
  ('apps.allow_resellers', 'true');
