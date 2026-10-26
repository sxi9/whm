-- Password age enforcement (Security Center › Configure Security Policies) needs
-- to know when a panel password was last set. NULL means "never recorded":
-- the account's creation time is used instead.
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
