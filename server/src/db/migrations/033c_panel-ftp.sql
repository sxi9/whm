-- Customer panel: FTP virtual users (pure-ftpd PureDB / proftpd AuthUserFile).
-- `login` is the daemon-side name (<name>@<domain> on pure-ftpd, <name>_<account>
-- on proftpd); `name` is what the customer typed. The uid/gid/home of the system
-- user behind a virtual login are derived by the agent from /etc/passwd at every
-- call and never stored here.

CREATE TABLE IF NOT EXISTS ftp_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  login       TEXT NOT NULL UNIQUE,
  daemon      TEXT NOT NULL CHECK (daemon IN ('pure-ftpd', 'proftpd')),
  dir         TEXT NOT NULL,
  quota_mb    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ftp_accounts_account ON ftp_accounts (account_id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('panel.ftp.port', '21');
