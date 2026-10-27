-- Fix round 1 (U1): one license.checkin_failed per miss episode, job
-- results readable only by their creator, and billing cancellations that
-- suspend after the grace period instead of immediately.
-- Idempotency: the runner (shared/db.js migrate) records applied file names
-- in schema_migrations and additionally drops each `ALTER TABLE … ADD COLUMN`
-- statement whose column already exists, so re-running this file is a no-op.
ALTER TABLE activations ADD COLUMN checkin_failed_at TEXT;
ALTER TABLE jobs ADD COLUMN created_by TEXT;
ALTER TABLE licenses ADD COLUMN suspend_after TEXT;
ALTER TABLE licenses ADD COLUMN suspend_reason TEXT;
CREATE INDEX IF NOT EXISTS licenses_suspend_after ON licenses(suspend_after);
