-- A second factor being set up must never touch the one in use: beginning an
-- enrolment used to overwrite totp_secret_enc and clear totp_enabled, which
-- silently disabled an active authenticator without the re-verification that
-- disabling requires. The secret of an enrolment in progress now has its own
-- column and is promoted only when the user confirms a code from it. A secret
-- left behind by an unfinished enrolment moves over; an enabled one is kept.
ALTER TABLE users ADD COLUMN totp_pending_secret_enc TEXT;
UPDATE users
   SET totp_pending_secret_enc = totp_secret_enc, totp_secret_enc = NULL
 WHERE totp_enabled = 0 AND totp_secret_enc IS NOT NULL AND totp_pending_secret_enc IS NULL;
