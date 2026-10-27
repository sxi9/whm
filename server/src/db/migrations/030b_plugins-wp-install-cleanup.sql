-- A failed one-click WordPress install drops the database and user it created
-- so the names can be reused; what was dropped (or could not be) is kept with
-- the row. Runs once (schema_migrations), so the non-idempotent ADD COLUMN is
-- safe.
ALTER TABLE wp_installs ADD COLUMN cleanup TEXT;
