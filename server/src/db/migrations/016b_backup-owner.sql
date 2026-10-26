-- Backup: ownership recorded on the rows themselves -----------------------------
--
-- Reseller access to an archive used to be derived from whichever account
-- currently carries the archive's username; a terminated account's name can be
-- reused by another reseller. The owner is now fixed when the row is written and
-- rows without one are root-only.
ALTER TABLE backups ADD COLUMN owner_id INTEGER REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE backup_restores ADD COLUMN owner_id INTEGER REFERENCES users (id) ON DELETE SET NULL;

UPDATE backups SET owner_id = (SELECT a.owner_id FROM accounts a WHERE a.id = backups.account_id)
  WHERE owner_id IS NULL AND account_id IS NOT NULL;
UPDATE backup_restores SET owner_id = (SELECT b.owner_id FROM backups b WHERE b.id = backup_restores.backup_id)
  WHERE owner_id IS NULL AND backup_id IS NOT NULL;
