-- cPanel follow-ups.
--
-- News gains the `own` audience (accounts owned by the item's author) and an
-- owner_id so resellers holding the `news` ACL can publish to their own
-- customers; SQLite cannot widen a CHECK in place, so the table is rebuilt.
CREATE TABLE IF NOT EXISTS news_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL DEFAULT '',
  audience    TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('root', 'resellers', 'all', 'own')),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  starts_at   TEXT,
  ends_at     TEXT,
  owner_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO news_v2 (id, title, body_md, audience, severity, enabled, starts_at, ends_at, owner_id, created_by, created_at, updated_at)
  SELECT id, title, body_md, audience, severity, enabled, starts_at, ends_at, NULL, created_by, created_at, updated_at FROM news;
DROP TABLE news;
ALTER TABLE news_v2 RENAME TO news;
CREATE INDEX IF NOT EXISTS news_active ON news (enabled, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS news_owner ON news (owner_id);

-- The release check belongs to Software (software.panel.last_check); cPanel
-- keeps only the upgrade-run record. news.html predates the news table and has
-- no reader (the core seed still lists it; the key is unused).
DELETE FROM settings WHERE key IN ('cpanel.upgrade.last_check', 'news.html');
