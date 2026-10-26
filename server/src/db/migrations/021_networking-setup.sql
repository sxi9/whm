-- Networking Setup: hostname and resolver change history ---------------------------
CREATE TABLE IF NOT EXISTS networking_changes (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('hostname', 'resolvers')),
  principal    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_networking_changes_kind ON networking_changes (kind, id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('networking.resolvers.search', '[]'),
  ('networking.hostname.update_hosts', 'true'),
  ('networking.hostname.add_dns_record', 'true');
