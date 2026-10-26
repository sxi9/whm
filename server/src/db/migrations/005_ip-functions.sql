-- IP Functions ----------------------------------------------------------------
-- Delegated IPv6 networks accounts may draw addresses from.
CREATE TABLE IF NOT EXISTS ipv6_ranges (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  range_cidr    TEXT NOT NULL UNIQUE,
  first_address TEXT NOT NULL,
  last_address  TEXT NOT NULL,
  interface     TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which accounts are allowed to receive an address from a range.
CREATE TABLE IF NOT EXISTS ipv6_range_accounts (
  range_id   INTEGER NOT NULL REFERENCES ipv6_ranges (id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (range_id, account_id)
);

-- The IPv6 address handed to an account (one per account).
CREATE TABLE IF NOT EXISTS ipv6_assignments (
  account_id INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  range_id   INTEGER REFERENCES ipv6_ranges (id) ON DELETE SET NULL,
  address    TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reconciled view of every address the panel knows about or found on the host,
-- rebuilt by "Rebuild the IP Address Pool".
CREATE TABLE IF NOT EXISTS ip_pool (
  address    TEXT PRIMARY KEY,
  family     INTEGER NOT NULL CHECK (family IN (4, 6)),
  interface  TEXT,
  state      TEXT NOT NULL CHECK (state IN ('main', 'reserved', 'dedicated', 'shared', 'free', 'missing', 'unmanaged')),
  account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  in_db      INTEGER NOT NULL DEFAULT 0,
  on_system  INTEGER NOT NULL DEFAULT 0,
  synced_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- managed = 0: found on the host as a DHCP/SLAAC or privacy address. Shown in the
-- inventory but never re-added at boot nor handed to accounts.
ALTER TABLE ip_addresses ADD COLUMN managed INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_ip_addresses_dedicated ON ip_addresses (dedicated_to);
CREATE INDEX IF NOT EXISTS idx_accounts_ip ON accounts (ip);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('ip.remote.mail_ipv4', '""'),
  ('ip.remote.mail_ipv6', '""'),
  ('ip.remote.dns_ipv4', '""'),
  ('ip.remote.dns_ipv6', '""'),
  ('ip.remote.mysql_ipv4', '""'),
  ('ip.remote.mysql_ipv6', '""'),
  ('ip.remote.ftp_ipv4', '""'),
  ('ip.remote.ftp_ipv6', '""'),
  ('ip.remote.panel_ipv4', '""'),
  ('ip.remote.panel_ipv6', '""'),
  ('ip.persist_on_boot', 'true'),
  ('ip.pool_last_rebuild', 'null');
