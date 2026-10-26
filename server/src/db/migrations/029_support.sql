-- Support: Create Support Ticket, Grant cPanel Support Access, Support Center ----
CREATE TABLE IF NOT EXISTS support_tickets (
  id              INTEGER PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  subject         TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  severity        TEXT NOT NULL DEFAULT 'normal',
  description     TEXT NOT NULL,
  contact_email   TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  snapshot_json   TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (delivery_status IN ('sent', 'failed', 'not_sent')),
  delivery_detail TEXT,
  sent_to         TEXT,
  sent_at         TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, created_at);

-- A grant is the time box: the authorized root key and the API token it created
-- are removed by the scheduled expiry job (or by hand) and the row keeps the record.
CREATE TABLE IF NOT EXISTS support_access_grants (
  id               INTEGER PRIMARY KEY,
  label            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  ssh_fingerprint  TEXT,
  ssh_key_type     TEXT,
  ssh_comment      TEXT,
  api_token_id     INTEGER,
  api_token_prefix TEXT,
  granted_by       TEXT,
  granted_ip       TEXT,
  note             TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at         TEXT,
  ended_by         TEXT,
  cleanup_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_access_status ON support_access_grants (status, expires_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('support.email', '""'),
  ('support.provider_name', '"cPanel Support"'),
  ('support.portal_url', '"https://support.cpanel.net/"'),
  ('support.access.default_hours', '24'),
  ('support.access.max_hours', '168');
