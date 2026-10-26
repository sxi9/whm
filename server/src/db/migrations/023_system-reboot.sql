-- System Reboot: every reboot requested through the panel, with the pre-flight
-- snapshot the operator saw, so the history survives the reboot itself.
CREATE TABLE IF NOT EXISTS reboot_requests (
  id              INTEGER PRIMARY KEY,
  mode            TEXT NOT NULL CHECK (mode IN ('graceful', 'forceful')),
  principal       TEXT,
  ip              TEXT,
  reason          TEXT,
  preflight_json  TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'triggered' CHECK (status IN ('triggered', 'failed')),
  error           TEXT,
  boot_id         TEXT,
  requested_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reboot_requests_requested_at ON reboot_requests (requested_at);
