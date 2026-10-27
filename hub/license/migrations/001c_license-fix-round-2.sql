-- Fix round 2 (U1): TOTP re-enrolment keeps the enabled secret until the new
-- one is confirmed (totp_pending_enc), and customers record where they came
-- from (trial sign-ups are unverified). Idempotent: the runner skips an
-- ADD COLUMN whose column already exists and records the file name.
ALTER TABLE portal_users ADD COLUMN totp_pending_enc TEXT;
ALTER TABLE customers ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
