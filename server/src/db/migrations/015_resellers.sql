-- Resellers ------------------------------------------------------------------
-- reseller_acls / reseller_limits exist since 001. The limits row gains the
-- fields Reseller Center edits: overselling, privilege suspension, the hosting
-- account the reseller was created from, and timestamps.
ALTER TABLE reseller_limits ADD COLUMN oversell_disk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reseller_limits ADD COLUMN oversell_bandwidth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reseller_limits ADD COLUMN privileges_suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reseller_limits ADD COLUMN suspended_reason TEXT;
ALTER TABLE reseller_limits ADD COLUMN account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL;
ALTER TABLE reseller_limits ADD COLUMN notes TEXT;
ALTER TABLE reseller_limits ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE reseller_limits ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- Saved ACL presets ("ACL lists" in WHM) applied to resellers in one click.
CREATE TABLE IF NOT EXISTS reseller_acl_lists (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  acls_json  TEXT NOT NULL DEFAULT '[]',
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO reseller_acl_lists (name, acls_json, builtin) VALUES
  ('standard', '["list-accts","acct-summary","show-bandwidth","create-acct","suspend-acct","upgrade-account","edit-account","passwd","quota","limit-bandwidth","demo-setup","add-pkg","edit-pkg","viewglobalpackages","edit-dns","edit-mx","mailcheck","status","stats","ssl","ssl-info","ssl-buy","locale-edit","cpanel-api"]', 1),
  ('minimal', '["list-accts","acct-summary","show-bandwidth","passwd","status"]', 1);

CREATE INDEX IF NOT EXISTS idx_ip_addresses_delegated ON ip_addresses (delegated_to);
CREATE INDEX IF NOT EXISTS idx_reseller_limits_account ON reseller_limits (account_id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('resellers.email_from', '""'),
  ('resellers.default_acl_list', '"standard"');
