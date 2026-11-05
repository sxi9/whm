-- Account panel preferences (Phase 8 P1-8): the login's interface language and
-- the account's secondary contact address + notification switches. The locale
-- column lands on users (the setting belongs to the login, like the admin
-- console's); the rest is per hosting account and cascades with it.
ALTER TABLE users ADD COLUMN locale TEXT;

CREATE TABLE IF NOT EXISTS panel_account_prefs (
  account_id              INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  email2                  TEXT,
  notify_quota            INTEGER NOT NULL DEFAULT 1,
  notify_bandwidth        INTEGER NOT NULL DEFAULT 1,
  notify_password_change  INTEGER NOT NULL DEFAULT 1,
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
