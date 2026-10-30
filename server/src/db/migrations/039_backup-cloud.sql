-- Backup: cloud storage destinations (Google Drive, OneDrive, Dropbox, Azure
-- Blob, Backblaze B2) and at-rest encryption -----------------------------------

-- SQLite cannot widen the kind CHECK in place, so the destinations table is
-- rebuilt with its rows carried over. Dropping the old table fires the
-- ON DELETE SET NULL of backup_uploads.destination_id, so those links are kept
-- aside and restored once the rebuilt table carries the name again.
CREATE TABLE IF NOT EXISTS backup_destinations_v2 (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  kind                TEXT NOT NULL CHECK (kind IN ('local', 'ftp', 'sftp', 'webdav', 's3', 'gdrive', 'onedrive', 'dropbox', 'azureblob', 'b2')),
  config_enc          TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_test_at        TEXT,
  last_test_ok        INTEGER,
  last_test_message   TEXT,
  updated_at          TEXT,
  last_upload_at      TEXT,
  last_upload_ok      INTEGER,
  last_upload_message TEXT
);
INSERT OR IGNORE INTO backup_destinations_v2 (id, name, kind, config_enc, enabled, created_at, last_test_at, last_test_ok, last_test_message, updated_at)
  SELECT id, name, kind, config_enc, enabled, created_at, last_test_at, last_test_ok, last_test_message, updated_at FROM backup_destinations;
CREATE TEMP TABLE backup_upload_links AS SELECT id, destination_id FROM backup_uploads WHERE destination_id IS NOT NULL;
DROP TABLE backup_destinations;
ALTER TABLE backup_destinations_v2 RENAME TO backup_destinations;
UPDATE backup_uploads SET destination_id = (SELECT l.destination_id FROM backup_upload_links l WHERE l.id = backup_uploads.id)
  WHERE destination_id IS NULL AND id IN (SELECT id FROM backup_upload_links);
DROP TABLE backup_upload_links;

-- Which copies are ciphertext (uploaded through the crypt remote): a copy made
-- before encryption was enabled on its destination is fetched and pruned
-- through the plain path.
ALTER TABLE backup_uploads ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;

-- One OAuth client per provider, registered by root; the secret is encrypted
-- with the panel master key and is never returned by the API.
CREATE TABLE IF NOT EXISTS backup_oauth_apps (
  provider          TEXT PRIMARY KEY CHECK (provider IN ('gdrive', 'onedrive', 'dropbox')),
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  created_by        TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
