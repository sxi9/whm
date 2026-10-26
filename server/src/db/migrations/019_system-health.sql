-- System Health: Background Process Killer ----------------------------------------
CREATE TABLE IF NOT EXISTS bpk_patterns (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bpk_runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  trigger       TEXT NOT NULL DEFAULT 'scheduled',
  principal     TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  scanned       INTEGER NOT NULL DEFAULT 0,
  matched       INTEGER NOT NULL DEFAULT 0,
  killed        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  notified      INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS bpk_kills (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER REFERENCES bpk_runs (id) ON DELETE SET NULL,
  killed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  pid         INTEGER NOT NULL,
  user        TEXT NOT NULL,
  command     TEXT NOT NULL,
  args        TEXT,
  pattern     TEXT NOT NULL,
  signal      TEXT NOT NULL,
  result      TEXT NOT NULL DEFAULT 'killed',
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bpk_kills_killed_at ON bpk_kills (killed_at);
CREATE INDEX IF NOT EXISTS idx_bpk_kills_user ON bpk_kills (user);

-- The classic WHM disallowed-process list.
INSERT OR IGNORE INTO bpk_patterns (name, builtin, note) VALUES
  ('BitchX', 1, 'IRC client'),
  ('bnc', 1, 'IRC bouncer'),
  ('eggdrop', 1, 'IRC bot'),
  ('generic-sniffers', 1, 'Packet sniffers (tcpdump, ngrep, dsniff, ettercap)'),
  ('guardservices', 1, 'IRC services daemon'),
  ('ircd', 1, 'IRC server'),
  ('psyBNC', 1, 'IRC bouncer'),
  ('ptlink', 1, 'IRC server'),
  ('services', 1, 'IRC services daemon');

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('system_health.bpk.enabled', 'true'),
  ('system_health.bpk.signal', '"SIGKILL"'),
  ('system_health.bpk.notify', 'true'),
  ('system_health.bpk.scope', '"non-root"'),
  ('system_health.bpk.exempt_users', '[]'),
  ('system_health.bpk.retention_days', '90');
