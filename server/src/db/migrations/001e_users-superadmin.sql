-- The super admin is the one root user who owns this panel: only that user
-- sees the license hub, the license key and the activation controls. The flag
-- is set exclusively by `whm-cli superadmin <user>` after the setup password
-- in <dataDir>/superadmin.key has been verified; no API route can set it.
ALTER TABLE users ADD COLUMN superadmin INTEGER NOT NULL DEFAULT 0;
