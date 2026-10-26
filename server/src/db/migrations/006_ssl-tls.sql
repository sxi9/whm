-- SSL/TLS -----------------------------------------------------------------------
-- ssl_certs and ssl_service_certs already exist (001_init.sql). ssl_certs.installed:
-- 0 = stored only, 1 = installed on the vhost, 2 = files written, vhost apply pending.

-- Accounts or domains AutoSSL must skip.
CREATE TABLE IF NOT EXISTS ssl_autossl_exclusions (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('account', 'domain')),
  value      TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);

-- One row per AutoSSL pass (scheduled or run-now) with its per-domain outcomes.
CREATE TABLE IF NOT EXISTS ssl_autossl_runs (
  id           INTEGER PRIMARY KEY,
  trigger      TEXT NOT NULL DEFAULT 'manual',
  provider     TEXT,
  job_id       INTEGER,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'skipped')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  entries_json TEXT NOT NULL DEFAULT '[]'
);

-- Purchase flow: an order placed with a market provider for a stored CSR.
CREATE TABLE IF NOT EXISTS ssl_orders (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,
  product     TEXT NOT NULL,
  domain      TEXT NOT NULL,
  account_id  INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  cert_id     INTEGER REFERENCES ssl_certs (id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'issued', 'installed', 'cancelled')),
  price       REAL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  order_ref   TEXT,
  notes       TEXT,
  created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ssl_orders_domain ON ssl_orders (domain);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('ssl.autossl.provider', '"disabled"'),
  ('ssl.autossl.email', '""'),
  ('ssl.autossl.method', '"webroot"'),
  ('ssl.autossl.staging', 'false'),
  ('ssl.autossl.key_type', '"ecdsa"'),
  ('ssl.autossl.renew_days', '30'),
  ('ssl.autossl.include_www', 'true'),
  ('ssl.autossl.replace_custom', 'false'),
  ('ssl.tls.preset', '"intermediate"'),
  ('ssl.tls.protocols', '["TLSv1.2","TLSv1.3"]'),
  ('ssl.tls.ciphers', '"ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384"'),
  ('ssl.tls.ciphersuites', '"TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256"'),
  ('ssl.tls.prefer_server_ciphers', 'true'),
  ('ssl.tls.hsts_enabled', 'false'),
  ('ssl.tls.hsts_max_age', '31536000'),
  ('ssl.tls.hsts_include_subdomains', 'true'),
  ('ssl.tls.hsts_preload', 'false'),
  ('ssl.tls.services', '["apache","exim","dovecot"]'),
  ('market.providers', '[{"name":"cpstore","displayName":"cPanel Store","enabled":false,"url":"https://store.cpanel.net","products":[{"id":"dv","name":"Domain Validated (DV)","price":9.99,"currency":"USD","termMonths":12},{"id":"ov","name":"Organization Validated (OV)","price":49.99,"currency":"USD","termMonths":12},{"id":"wildcard","name":"Wildcard DV","price":99.99,"currency":"USD","termMonths":12}]}]');
