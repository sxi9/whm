-- Market: providers the panel can purchase from or publish through. SSL providers
-- feed Purchase and Install an SSL Certificate (mirrored into the market.providers
-- setting that SSL/TLS reads); the plugin provider is the Phase 5 marketplace hub.
-- ACME clients are not rows: they are reflected read-only from AutoSSL at list time.
CREATE TABLE IF NOT EXISTS market_providers (
  name               TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('ssl', 'plugin')),
  adapter            TEXT NOT NULL,
  builtin            INTEGER NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 0,
  url                TEXT,
  config_enc         TEXT,
  commission_percent REAL NOT NULL DEFAULT 0,
  products_json      TEXT NOT NULL DEFAULT '[]',
  last_test_at       TEXT,
  last_test_ok       INTEGER,
  last_test_message  TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO market_providers (name, display_name, type, adapter, builtin, enabled, url, products_json) VALUES
  ('cpstore', 'cPanel Store', 'ssl', 'manual', 1, 0, 'https://store.cpanel.net',
   '[{"id":"dv","name":"Domain Validated (DV)","price":9.99,"currency":"USD","termMonths":12,"wildcard":false},{"id":"ov","name":"Organization Validated (OV)","price":49.99,"currency":"USD","termMonths":12,"wildcard":false},{"id":"wildcard","name":"Wildcard DV","price":99.99,"currency":"USD","termMonths":12,"wildcard":true}]'),
  ('whm-hub', 'WHM Marketplace (plugin hub)', 'plugin', 'hub', 1, 0, NULL, '[]');
