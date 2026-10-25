-- DNS Functions ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domain_forwarding (
  id          INTEGER PRIMARY KEY,
  domain      TEXT NOT NULL UNIQUE,
  account_id  INTEGER REFERENCES accounts (id) ON DELETE CASCADE,
  target_url  TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'permanent' CHECK (type IN ('permanent', 'temporary')),
  match_www   INTEGER NOT NULL DEFAULT 1,
  keep_path   INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per zone / per peer outcome of the last cluster push.
CREATE TABLE IF NOT EXISTS dns_zone_sync (
  zone_id    INTEGER NOT NULL REFERENCES dns_zones (id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL REFERENCES dns_clusters (id) ON DELETE CASCADE,
  serial     INTEGER,
  status     TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  message    TEXT,
  synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (zone_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_dns_zones_account ON dns_zones (account_id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('dns.default_ttl', '14400'),
  ('dns.soa_refresh', '3600'),
  ('dns.soa_retry', '1800'),
  ('dns.soa_expire', '1209600'),
  ('dns.soa_minimum', '86400'),
  ('dns.spf_default', '"v=spf1 +mx +a ~all"'),
  ('dns.dmarc_default', '"v=DMARC1; p=none; sp=none; adkim=r; aspf=r"'),
  ('dns.dkim_selector', '"default"'),
  ('dns.dkim_bits', '2048'),
  ('dns.allow_transfer', '[]'),
  ('dns.resolvers', '[]'),
  ('dns.cluster_verify_tls', 'true');

INSERT OR IGNORE INTO zone_templates (name, body) VALUES ('minimal', '; Zone template: %domain% (minimal: NS + apex A only)
$TTL %ttl%
@   IN  SOA %ns1%. hostmaster.%domain%. (
        %serial%  ; serial
        3600      ; refresh
        1800      ; retry
        1209600   ; expire
        86400 )   ; minimum
@       IN  NS    %ns1%.
@       IN  NS    %ns2%.
@       IN  A     %ip%
www     IN  A     %ip%
');
