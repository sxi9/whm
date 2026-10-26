-- Email ---------------------------------------------------------------------

-- Country filter: one row per country with the action to take, plus the CIDR
-- blocks uploaded/fetched for it. Rendered into an Exim host list.
CREATE TABLE IF NOT EXISTS mail_country_filters (
  code       TEXT PRIMARY KEY,
  name       TEXT,
  action     TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'allow')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  source     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mail_country_cidrs (
  id   INTEGER PRIMARY KEY,
  code TEXT NOT NULL REFERENCES mail_country_filters (code) ON DELETE CASCADE,
  cidr TEXT NOT NULL,
  UNIQUE (code, cidr)
);
CREATE INDEX IF NOT EXISTS idx_mail_country_cidrs_code ON mail_country_cidrs (code);

-- Sender-domain block/allow list rendered into Exim sender lists.
CREATE TABLE IF NOT EXISTS mail_domain_filters (
  id         INTEGER PRIMARY KEY,
  domain     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('block', 'allow')),
  comment    TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (domain, kind)
);

-- Hosts, sender domains and recipient domains exempt from greylisting.
CREATE TABLE IF NOT EXISTS mail_greylist_trusted (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('host', 'sender_domain', 'recipient_domain')),
  value      TEXT NOT NULL,
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);

-- Last applied filter configuration (what was rendered into Exim and when).
CREATE TABLE IF NOT EXISTS mail_filter_applies (
  id         INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  ok         INTEGER NOT NULL DEFAULT 1,
  summary    TEXT,
  error      TEXT
);

-- Settings defaults ---------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('mail.notification_from', '""'),
  ('mail.country_filter.source_url', '"https://www.ipdeny.com/ipblocks/data/aggregated/{cc}-aggregated.zone"'),
  ('mail.country_filter.message', '"Mail from your country is not accepted by this server"'),
  ('mail.domain_filter.message', '"Mail from your domain is not accepted by this server"'),
  ('mail.greylist.enabled', 'false'),
  ('mail.greylist.initial_delay_minutes', '5'),
  ('mail.greylist.must_retry_hours', '4'),
  ('mail.greylist.record_expires_days', '35'),
  ('mail.greylist.message', '"Greylisted: please try again later"'),
  ('mail.log.default_window_hours', '24');
