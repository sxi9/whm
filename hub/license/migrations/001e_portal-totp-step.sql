-- RFC 6238 §5.2: a TOTP code is accepted once. portal_users remembers the
-- time step of the last accepted code (login, step-up, enrolment, disable);
-- the same or an earlier step is refused afterwards. Idempotent: the runner
-- skips an ADD COLUMN whose column exists.
ALTER TABLE portal_users ADD COLUMN totp_last_step INTEGER;
