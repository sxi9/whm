-- Customer panel dynamic DNS (P2-8): one long-lived token per A/AAAA record
-- that a router or a script calls to move the record to its current address.
-- Only the SHA-256 of a token is stored; the record row going away (zone
-- rewrite, record deleted) takes the token with it.
CREATE TABLE IF NOT EXISTS panel_ddns_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  zone_id      INTEGER NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  record_id    INTEGER NOT NULL REFERENCES dns_records(id) ON DELETE CASCADE,
  label        TEXT,
  token_hash   TEXT NOT NULL UNIQUE,
  last_ip      TEXT,
  last_used_at TEXT,
  updates      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_panel_ddns_tokens_account ON panel_ddns_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_panel_ddns_tokens_record ON panel_ddns_tokens(record_id);
