-- cPanel category: news items shown on the dashboard, branding defaults and
-- the panel-upgrade bookkeeping. Branding images live as files under
-- $WHM_DATA_DIR/branding/ and are described by the branding.logo / branding.favicon settings.

CREATE TABLE IF NOT EXISTS news (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL DEFAULT '',
  audience    TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('root', 'resellers', 'all')),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  starts_at   TEXT,
  ends_at     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS news_active ON news (enabled, starts_at, ends_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('branding.company_name', '"WHM"'),
  ('branding.tagline', '"WebHost Manager"'),
  ('branding.primary_color', '""'),
  ('branding.chrome_color', '""'),
  ('branding.help_url', '""'),
  ('branding.docs_url', '""'),
  ('branding.support_url', '""'),
  ('branding.login_notice', '""'),
  ('branding.footer_text', '""'),
  ('branding.logo', 'null'),
  ('branding.favicon', 'null'),
  ('cpanel.upgrade.last_check', 'null'),
  ('cpanel.upgrade.last', 'null');
