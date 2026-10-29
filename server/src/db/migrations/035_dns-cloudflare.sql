-- DNS Functions: Cloudflare DNS management -------------------------------------
-- One row (id = 1): the API token is encrypted with the panel master key; it is
-- kept out of the settings table so /system/settings and the config-cluster
-- push can never carry it.
CREATE TABLE IF NOT EXISTS dns_cloudflare_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  api_token_enc  TEXT NOT NULL,
  token_id       TEXT,
  account_id     TEXT,
  account_name   TEXT,
  verified_at    TEXT,
  created_by     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A zone is served by BIND ('bind') or mirrored to Cloudflare ('cloudflare').
ALTER TABLE dns_zones ADD COLUMN provider TEXT NOT NULL DEFAULT 'bind';
ALTER TABLE dns_zones ADD COLUMN cloudflare_zone_id TEXT;
ALTER TABLE dns_zones ADD COLUMN cloudflare_status TEXT;
ALTER TABLE dns_zones ADD COLUMN cloudflare_synced_at TEXT;
ALTER TABLE dns_zones ADD COLUMN cloudflare_last_error TEXT;
CREATE INDEX IF NOT EXISTS idx_dns_zones_provider ON dns_zones (provider);

-- Every link / import / push attempt, newest first in the UI.
CREATE TABLE IF NOT EXISTS dns_cloudflare_sync (
  id          INTEGER PRIMARY KEY,
  zone_id     INTEGER NOT NULL REFERENCES dns_zones (id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('link', 'unlink', 'import', 'push')),
  status      TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  attempt     INTEGER NOT NULL DEFAULT 1,
  summary     TEXT,
  message     TEXT,
  job_id      INTEGER,
  principal   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dns_cloudflare_sync_zone ON dns_cloudflare_sync (zone_id, id);
