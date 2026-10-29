-- Portal TOTP everywhere (U4): vendor settings carry hub.require_totp_for_admins
-- (true: vendor and reseller admins must enrol an authenticator app at their
-- first login before anything but /v1/portal/* answers), portal users record
-- when they enrolled and carry the per-account wrong-code budget (five
-- consecutive wrong codes pause TOTP for 15 minutes, whatever the address).
-- Idempotent: the runner skips an ADD COLUMN whose column exists and records
-- the file name.
CREATE TABLE IF NOT EXISTS vendor_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT
);
INSERT OR IGNORE INTO vendor_settings (key, value_json) VALUES ('hub.require_totp_for_admins', 'true');
ALTER TABLE portal_users ADD COLUMN totp_enrolled_at TEXT;
ALTER TABLE portal_users ADD COLUMN totp_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE portal_users ADD COLUMN totp_locked_until TEXT;
