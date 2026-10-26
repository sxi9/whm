-- System Reboot: a request is now recorded before the reboot command runs
-- (the command kills the panel, so a row written afterwards would be lost).
-- 'requested' marks a row whose outcome the panel never got to record.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt in place.
CREATE TABLE IF NOT EXISTS reboot_requests_v2 (
  id              INTEGER PRIMARY KEY,
  mode            TEXT NOT NULL CHECK (mode IN ('graceful', 'forceful')),
  principal       TEXT,
  ip              TEXT,
  reason          TEXT,
  preflight_json  TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'triggered', 'failed')),
  error           TEXT,
  boot_id         TEXT,
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  triggered_at    TEXT
);
INSERT OR IGNORE INTO reboot_requests_v2 (id, mode, principal, ip, reason, preflight_json, status, error, boot_id, requested_at)
  SELECT id, mode, principal, ip, reason, preflight_json, status, error, boot_id, requested_at FROM reboot_requests;
DROP TABLE reboot_requests;
ALTER TABLE reboot_requests_v2 RENAME TO reboot_requests;
CREATE INDEX IF NOT EXISTS idx_reboot_requests_requested_at ON reboot_requests (requested_at);
