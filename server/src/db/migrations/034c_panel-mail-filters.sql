-- Customer panel: Sieve mail filters (Phase 8 P1-3). One row per rule; the
-- Sieve script itself is rendered by panel-email.js from rules_json (never
-- stored or accepted as free text) and written as the account by
-- vmail.sieve.write. scope 'mailbox' rows belong to one mailbox (the personal
-- script under ~/mail/<domain>/<local>/sieve), scope 'account' rows render the
-- account-wide script (~/mail/sieve-global/keel.sieve, Dovecot's sieve_before).
CREATE TABLE IF NOT EXISTS panel_mail_filters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('mailbox', 'account')),
  mailbox_id  INTEGER REFERENCES mail_accounts (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  rules_json  TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope = 'mailbox') = (mailbox_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_panel_mail_filters_scope ON panel_mail_filters (account_id, scope, mailbox_id, position);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('panel.mail.max_filters_per_scope', '100');
