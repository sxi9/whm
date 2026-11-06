-- Phase 8 P4-2 User Manager: sub-users of one hosting account (cPanel User
-- Manager). A sub-user is never a Linux user: it is a name on one of the
-- account's domains whose enabled services are the account's own mailbox
-- (mail_accounts) and FTP login (ftp_accounts), created and removed through
-- the panel services that own those rows. services_json:
-- { email: { enabled, quotaMb, mailboxId }, ftp: { enabled, homeDir, accountId }, dav: { enabled } }.
-- The password is never stored here; each service keeps its own hash.

CREATE TABLE IF NOT EXISTS panel_subusers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  username       TEXT NOT NULL,
  domain         TEXT NOT NULL,
  full_name      TEXT NOT NULL DEFAULT '',
  contact_email  TEXT,
  services_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (username, domain)
);
CREATE INDEX IF NOT EXISTS idx_panel_subusers_account ON panel_subusers (account_id);
