-- Hardening (Security Advisor › Hardening) ----------------------------------
-- One row per one-click item: whether the operator wants it on (the firewall
-- baseline is re-applied from this at boot), the parameters it was applied
-- with and what Revert has to put back (previous sshd values, sysctl values,
-- the input policy before the baseline).
CREATE TABLE IF NOT EXISTS hardening_state (
  item          TEXT PRIMARY KEY,
  desired       INTEGER NOT NULL DEFAULT 0,
  params_json   TEXT NOT NULL DEFAULT '{}',
  previous_json TEXT,
  applied_at    TEXT,
  reverted_at   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('security.hardening.fail2ban.bantime_seconds', '3600'),
  ('security.hardening.fail2ban.findtime_seconds', '600'),
  ('security.hardening.fail2ban.maxretry', '5');
