-- A grant whose root SSH key could not be removed when its time box ended
-- (agent unavailable, sshd gone) stays in 'cleanup_pending' so the expiry job
-- keeps retrying and the UI flags it; it only becomes 'expired'/'revoked' once
-- the host is clean. SQLite cannot widen a CHECK in place, so the table is
-- rebuilt with its rows carried over.
CREATE TABLE IF NOT EXISTS support_access_grants_v2 (
  id               INTEGER PRIMARY KEY,
  label            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleanup_pending', 'expired', 'revoked')),
  ssh_fingerprint  TEXT,
  ssh_key_type     TEXT,
  ssh_comment      TEXT,
  ssh_expiry       TEXT,
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
INSERT OR IGNORE INTO support_access_grants_v2 (id, label, status, ssh_fingerprint, ssh_key_type, ssh_comment, api_token_id, api_token_prefix, granted_by, granted_ip, note, expires_at, created_at, ended_at, ended_by, cleanup_json)
  SELECT id, label, status, ssh_fingerprint, ssh_key_type, ssh_comment, api_token_id, api_token_prefix, granted_by, granted_ip, note, expires_at, created_at, ended_at, ended_by, cleanup_json FROM support_access_grants;
DROP TABLE IF EXISTS support_access_grants;
ALTER TABLE support_access_grants_v2 RENAME TO support_access_grants;
CREATE INDEX IF NOT EXISTS idx_support_access_status ON support_access_grants (status, expires_at);
