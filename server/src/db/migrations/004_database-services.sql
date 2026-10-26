-- Database Services ----------------------------------------------------------

-- Outcome of the last connection test per profile (Manage Database Profiles).
CREATE TABLE IF NOT EXISTS db_instance_status (
  instance_id INTEGER PRIMARY KEY REFERENCES db_instances (id) ON DELETE CASCADE,
  ok          INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  version     TEXT,
  tested_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hosts a panel-created user was provisioned at, so access-host changes can be
-- reconciled against what the server really has.
CREATE TABLE IF NOT EXISTS db_user_hosts (
  db_user_id INTEGER NOT NULL REFERENCES db_users (id) ON DELETE CASCADE,
  host       TEXT NOT NULL,
  PRIMARY KEY (db_user_id, host)
);

-- Repair / check runs (Repair Databases history).
CREATE TABLE IF NOT EXISTS db_repair_runs (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  databases   TEXT NOT NULL DEFAULT '[]',
  summary     TEXT,
  started_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_databases_account ON databases (account_id);
CREATE INDEX IF NOT EXISTS idx_db_users_account ON db_users (account_id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('db.prefixing', 'true'),
  ('db.default_charset', '"utf8mb4"'),
  ('db.default_collation', '"utf8mb4_unicode_ci"'),
  ('db.default_privileges', '["ALL PRIVILEGES"]'),
  ('db.phpmyadmin.url', '""'),
  ('db.upgrade.backup_dir', '"/var/backups/whm/db"');
