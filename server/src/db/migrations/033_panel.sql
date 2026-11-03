-- Customer panel: account users, "log in as" sessions and panel settings.
CREATE TABLE IF NOT EXISTS account_users (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id         INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  password_synced_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_account_users_account ON account_users(account_id);

CREATE TABLE IF NOT EXISTS panel_login_as (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ended_at    TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_panel_login_as_actor ON panel_login_as(actor_id, ended_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('panel.enabled', 'true'),
  ('panel.require_2fa_for_users', 'false'),
  ('panel.login_as_ttl_minutes', '60'),
  ('panel.login_as_acl', '"login-as"'),
  ('panel.webmail_url', '""'),
  ('panel.upload_chunk_bytes', '1310720');
