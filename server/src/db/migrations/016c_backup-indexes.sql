-- Backups list: newest first for everyone, per reseller (owner_id comes from
-- 016b, so these cannot sit in 001c), per status. Account filter already uses
-- idx_backups_account (account_name, created_at).
CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups (created_at);
CREATE INDEX IF NOT EXISTS idx_backups_owner_created ON backups (owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_backups_status_created ON backups (status, created_at);
