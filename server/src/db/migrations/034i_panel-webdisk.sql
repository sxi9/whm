-- Phase 8 P5-1 Web Disk: one row per account that ever set a Web Disk
-- password or switched Web Disk on. The daemon (rclone serve webdav as the
-- account, unit keel-webdisk-<username>) listens on `port` from the apps pool;
-- `login` is the account's own name and is unique across accounts; the bcrypt
-- hash lives only in the account's ~/.keel/webdisk.htpasswd.
CREATE TABLE IF NOT EXISTS panel_webdisk (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  enabled          INTEGER NOT NULL DEFAULT 0,
  port             INTEGER NOT NULL UNIQUE,
  login            TEXT NOT NULL UNIQUE,
  has_password     INTEGER NOT NULL DEFAULT 0,
  password_set_at  TEXT,
  status           TEXT NOT NULL DEFAULT 'disabled',
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_panel_webdisk_enabled ON panel_webdisk(enabled);
