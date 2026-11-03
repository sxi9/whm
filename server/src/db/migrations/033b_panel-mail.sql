-- Customer panel: virtual mail objects of one hosting account. Mailboxes reuse
-- mail_accounts/mail_domains (001); everything here is pinned by account_id so
-- the panel never has to trust a domain name the client sent.

-- Forwarders: local_part NULL is the domain's default (catch-all) address.
-- destination is an email address, ':fail:' or ':blackhole:' (never a pipe or a file).
CREATE TABLE IF NOT EXISTS mail_forwarders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  local_part  TEXT,
  destination TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_forwarders_account ON mail_forwarders (account_id);
CREATE INDEX IF NOT EXISTS idx_mail_forwarders_domain ON mail_forwarders (domain);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_forwarders_entry ON mail_forwarders (domain, COALESCE(local_part, '*'), destination);

-- Domain forwarders: every address at `domain` is forwarded to the same local part at `target_domain`.
CREATE TABLE IF NOT EXISTS mail_domain_forwarders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  domain        TEXT NOT NULL UNIQUE,
  target_domain TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_domain_forwarders_account ON mail_domain_forwarders (account_id);

CREATE TABLE IF NOT EXISTS mail_autoresponders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  domain         TEXT NOT NULL,
  local_part     TEXT NOT NULL,
  from_name      TEXT NOT NULL DEFAULT '',
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  charset        TEXT NOT NULL DEFAULT 'utf-8',
  interval_hours INTEGER NOT NULL DEFAULT 24,
  start_at       TEXT,
  stop_at        TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (domain, local_part)
);
CREATE INDEX IF NOT EXISTS idx_mail_autoresponders_account ON mail_autoresponders (account_id);

-- One SpamAssassin preference set per account (rendered into ~/.spamassassin/user_prefs
-- as the account, and into the Exim per-domain spam list by the agent).
CREATE TABLE IF NOT EXISTS mail_spam_settings (
  account_id        INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  enabled           INTEGER NOT NULL DEFAULT 0,
  required_score    REAL NOT NULL DEFAULT 5.0,
  auto_delete       INTEGER NOT NULL DEFAULT 0,
  auto_delete_score REAL,
  whitelist_json    TEXT NOT NULL DEFAULT '[]',
  blacklist_json    TEXT NOT NULL DEFAULT '[]',
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('panel.mail.default_quota_mb', '1024'),
  ('panel.mail.max_forwarders_per_domain', '200');
