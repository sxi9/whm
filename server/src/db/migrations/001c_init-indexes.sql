-- Core tables: indexes for the list endpoints' filters and default sort orders
-- (server/test/perf/list-endpoints.test.js checks every plan against 20k rows).
-- Composite (filter, sort) indexes let SQLite answer "WHERE x = ? ORDER BY y
-- LIMIT n" from the index alone instead of a table walk plus a temp B-tree.

-- Accounts: reseller-scoped, suspended-only and per-package lists ordered by
-- username; created_at sort.
CREATE INDEX IF NOT EXISTS idx_accounts_owner_username ON accounts (owner_id, username);
CREATE INDEX IF NOT EXISTS idx_accounts_suspended_username ON accounts (suspended, username);
CREATE INDEX IF NOT EXISTS idx_accounts_package_username ON accounts (package_name, username);
CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON accounts (created_at);

-- Audit log: principal / result filters newest first; the action filter is a
-- case-insensitive prefix LIKE, which only a NOCASE index can serve.
CREATE INDEX IF NOT EXISTS idx_audit_principal_ts ON audit_log (principal, ts);
CREATE INDEX IF NOT EXISTS idx_audit_result_ts ON audit_log (result, ts);
CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log (action COLLATE NOCASE, ts);

-- Jobs: status / type filters newest first (the scheduler's queue pick also
-- reads (status, id)).
CREATE INDEX IF NOT EXISTS idx_jobs_status_id ON jobs (status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_type_id ON jobs (type, id);

-- DNS: one account's zones in domain order; records per zone in file order.
CREATE INDEX IF NOT EXISTS idx_dns_zones_account_domain ON dns_zones (account_id, domain);
CREATE INDEX IF NOT EXISTS idx_dns_records_zone_line ON dns_records (zone_id, line_index, id);

-- Login history newest first.
CREATE INDEX IF NOT EXISTS idx_login_attempts_created_at ON login_attempts (created_at);
