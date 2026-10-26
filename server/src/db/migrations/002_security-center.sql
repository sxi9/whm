-- Security Center ------------------------------------------------------------

-- cPHulk allow/deny lists. Exact-IP allowlist entries are enforced at the DB
-- level by the trigger below so the login path never has to know about them;
-- CIDR entries are enforced by the maintenance job and the service.
CREATE TABLE IF NOT EXISTS cphulk_lists (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('allow', 'deny')),
  ip         TEXT NOT NULL,
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, ip)
);

CREATE TRIGGER IF NOT EXISTS cphulk_allowlist_guard
BEFORE INSERT ON cphulk_blocks
WHEN EXISTS (SELECT 1 FROM cphulk_lists WHERE kind = 'allow' AND ip = NEW.ip)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- Rules disabled from ModSecurity Tools (any vendor or the base rule set).
CREATE TABLE IF NOT EXISTS modsec_disabled_rules (
  rule_id    INTEGER PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External (OpenID Connect) identity providers for panel login.
CREATE TABLE IF NOT EXISTS external_auth_providers (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  issuer_url        TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT,
  scopes            TEXT NOT NULL DEFAULT 'openid email profile',
  discovery_json    TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS external_auth_links (
  id          INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES external_auth_providers (id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  email       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_id, subject)
);

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

-- Security Advisor scan history (latest run is what the page shows).
CREATE TABLE IF NOT EXISTS security_advisor_runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  trigger       TEXT NOT NULL DEFAULT 'manual',
  summary_json  TEXT NOT NULL DEFAULT '{}',
  findings_json TEXT NOT NULL DEFAULT '[]'
);

-- Settings defaults ---------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('security.cphulk.firewall_sync', 'false'),
  ('security.cphulk.history_retention_days', '30'),
  ('security.cphulk.block_denylist_permanently', 'true'),
  ('security.smtp_restrictions.enabled', 'false'),
  ('security.policy.verified_ip_login', 'false'),
  ('security.policy.password_max_age_days', '0'),
  ('security.policy.require_2fa_for_resellers', 'false'),
  ('security.policy.session_timeout_minutes', '0'),
  ('security.policy.disallow_concurrent_sessions', 'false'),
  ('security.policy.api_tokens_require_2fa', 'false'),
  ('security.password.strength.account', 'null'),
  ('security.password.strength.email', 'null'),
  ('security.password.strength.ftp', 'null'),
  ('security.password.strength.mysql', 'null'),
  ('security.password.strength.panel', 'null'),
  ('security.password.strength.ssh', 'null'),
  ('security.questions.enabled', 'false'),
  ('security.questions.required_count', '3'),
  ('security.questions.min_answer_length', '4'),
  ('security.questions.allow_custom', 'true'),
  ('security.questions.pool', '["What was the name of your first pet?","What is the name of the street you grew up on?","What was the make of your first car?","What is your mother''s maiden name?","In which city were you born?","What was the name of your primary school?","What is your favourite book?","What was your childhood nickname?"]'),
  ('security.external_auth.enabled', 'false'),
  ('security.external_auth.auto_link_by_email', 'false');
