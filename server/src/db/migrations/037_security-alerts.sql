-- Security alerts ("emergency update" notices) ------------------------------
-- One row per alert raised by the Security Advisor, the OS update check, an
-- applied security update, the panel release feed or an administrator. The
-- dedupe key is unique: a key reused after the 24 h window is retired on the
-- old row (suffixed with "#<id>") so the new alert keeps the clean key.
CREATE TABLE IF NOT EXISTS security_alerts (
  id                   INTEGER PRIMARY KEY,
  kind                 TEXT NOT NULL,
  severity             TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  title                TEXT NOT NULL,
  body                 TEXT NOT NULL DEFAULT '',
  source               TEXT,
  data_json            TEXT NOT NULL DEFAULT '{}',
  dedupe_key           TEXT NOT NULL UNIQUE,
  state                TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'held', 'sent', 'skipped', 'failed')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  notified_admins_at   TEXT,
  notified_accounts_at TEXT,
  admin_result_json    TEXT,
  accounts_result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_alerts_created ON security_alerts (created_at);
CREATE INDEX IF NOT EXISTS idx_security_alerts_state ON security_alerts (state);

-- At most one mail per account per alert: the (alert, account) pair is the key;
-- a failed attempt may be retried, a sent one never repeats.
CREATE TABLE IF NOT EXISTS security_alert_deliveries (
  id          INTEGER PRIMARY KEY,
  alert_id    INTEGER NOT NULL REFERENCES security_alerts (id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL,
  username    TEXT NOT NULL,
  address     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  error       TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (alert_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_security_alert_deliveries_alert ON security_alert_deliveries (alert_id, status);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('security.alerts.enabled', 'true'),
  ('security.alerts.notify_accounts', 'false'),
  ('security.alerts.min_severity', '"critical"'),
  ('security.alerts.digest_minutes', '60');
