-- Server Contacts: Contact Manager + Edit System Mail Preferences -----------------
-- The contacts table (001) gains a display name, per-channel configuration
-- (secrets encrypted with lib/crypto.js), a severity threshold and delivery state.
ALTER TABLE contacts ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN min_severity TEXT NOT NULL DEFAULT 'info';
ALTER TABLE contacts ADD COLUMN last_sent_at TEXT;
ALTER TABLE contacts ADD COLUMN last_error TEXT;
ALTER TABLE contacts ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS contact_deliveries (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  contact_id   INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  contact_name TEXT,
  channel      TEXT NOT NULL,
  address      TEXT NOT NULL,
  event        TEXT NOT NULL,
  severity     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  transport    TEXT,
  error        TEXT,
  test         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_contact_deliveries_ts ON contact_deliveries (ts);
CREATE INDEX IF NOT EXISTS idx_contact_deliveries_event ON contact_deliveries (event);

-- Open alerts raised by the scheduled check (service down, disk full) so a
-- condition is reported when it starts and when it clears, not every run.
CREATE TABLE IF NOT EXISTS contact_alert_state (
  key              TEXT PRIMARY KEY,
  state            TEXT NOT NULL,
  detail           TEXT,
  since            TEXT NOT NULL DEFAULT (datetime('now')),
  last_notified_at TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('contacts.enabled', 'true'),
  ('contacts.from_address', '""'),
  ('contacts.retention_days', '90'),
  ('contacts.smtp.host', '""'),
  ('contacts.smtp.port', '587'),
  ('contacts.smtp.security', '"starttls"'),
  ('contacts.smtp.username', '""'),
  ('contacts.smtp.password_enc', '""'),
  ('contacts.smtp.allow_self_signed', 'false'),
  ('contacts.smtp.prefer', 'false'),
  ('contacts.check.enabled', 'true'),
  ('contacts.check.disk_threshold_percent', '90'),
  ('contacts.check.cooldown_minutes', '360'),
  ('contacts.check.ssl_days', '14'),
  ('contacts.root_mail_events', '["service.down","disk.space.low","backup.failed","login.failed.blocked","ssl.expiring","license.invalid"]'),
  ('contacts.root_forward', '[]');
