-- Phase 8 P4-3 Calendars and Contacts: which DAV logins of an account carry a
-- password in Radicale's htpasswd file (/etc/radicale/users, written by the
-- agent). The hash lives only on the host; this row records that one was set,
-- for whom (the account itself or a P4-2 sub-user) and when.
CREATE TABLE IF NOT EXISTS panel_dav_logins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  login       TEXT NOT NULL UNIQUE,
  subuser_id  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_panel_dav_logins_account ON panel_dav_logins (account_id);
