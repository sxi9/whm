-- Security Center amendment: objects added to 002 after it had already been
-- applied on early installs. The runner skips applied files by name, so they
-- are repeated here; both files are idempotent.

-- Addresses the panel itself put into the WHM_BLOCK firewall chain, so they can
-- be restored after a reboot and told apart from rules added by other tools.
-- 'manual' rows come from the Firewall block action (an operator or another
-- category); 'cphulk' rows mirror active cPHulk blocks / denylist entries.
CREATE TABLE IF NOT EXISTS firewall_entries (
  id         INTEGER PRIMARY KEY,
  ip         TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('manual', 'cphulk')),
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ip, source)
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('security.smtp_restrictions.enabled', 'false');
