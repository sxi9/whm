-- Server Configuration ---------------------------------------------------------

-- Link Server Nodes: other panel instances this server talks to over their API.
-- The token is encrypted at rest and never returned by the API.
CREATE TABLE IF NOT EXISTS server_nodes (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  hostname          TEXT NOT NULL,
  port              INTEGER NOT NULL DEFAULT 2087,
  scheme            TEXT NOT NULL DEFAULT 'https' CHECK (scheme IN ('https', 'http')),
  username          TEXT NOT NULL DEFAULT 'root',
  api_token_enc     TEXT,
  verify_tls        INTEGER NOT NULL DEFAULT 1,
  roles_json        TEXT NOT NULL DEFAULT '[]',
  enabled           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'error')),
  last_checked_at   TEXT,
  last_error        TEXT,
  remote_json       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('profile.name', '"standard"'),
  ('analytics.participant_id', 'null'),
  ('analytics.share_usage', 'true'),
  ('analytics.share_errors', 'false'),
  ('analytics.updated_at', 'null'),
  ('stats.generators', '{"awstats":true,"webalizer":false,"analog":false}'),
  ('stats.default_generator', '"awstats"'),
  ('stats.allow_user_choice', 'true'),
  ('stats.include_suspended', 'false'),
  ('stats.last_run', 'null'),
  ('terminal.idle_minutes', '15'),
  ('terminal.max_sessions', '3'),
  ('updates.notify_contact', 'true');
