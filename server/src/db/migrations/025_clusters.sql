-- Clusters -----------------------------------------------------------------------
-- Peer options live beside dns_clusters (owned by the core schema) so the peer
-- table itself never changes: TLS verification, whether the peer takes part in
-- the configuration cluster, and the outcome of the last connectivity check.
CREATE TABLE IF NOT EXISTS cluster_peer_options (
  cluster_id      INTEGER PRIMARY KEY REFERENCES dns_clusters (id) ON DELETE CASCADE,
  verify_tls      INTEGER NOT NULL DEFAULT 1,
  config_enabled  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'error')),
  last_checked_at TEXT,
  last_error      TEXT,
  remote_json     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every exchange with a peer, in either direction: DNS pushes received,
-- configuration pushed, pulled or received, connectivity tests.
CREATE TABLE IF NOT EXISTS cluster_events (
  id           INTEGER PRIMARY KEY,
  cluster_id   INTEGER REFERENCES dns_clusters (id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('peer.test', 'dns.receive', 'config.push', 'config.pull', 'config.receive', 'config.export')),
  direction    TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  source       TEXT,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  message      TEXT,
  details_json TEXT,
  ts           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cluster_events_ts ON cluster_events (ts DESC);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('clusters.config.groups', '["basic","tweak","security","dns","mail","ssl","backup","software"]'),
  ('clusters.config.auto_push', 'false'),
  ('clusters.config.last_push_at', 'null'),
  ('clusters.config.last_pull_at', 'null'),
  ('clusters.config.accept_pushes', 'true'),
  ('clusters.dns.accept_pushes', 'true'),
  ('clusters.events.retention_days', '90');
