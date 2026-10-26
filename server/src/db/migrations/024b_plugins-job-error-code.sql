-- Jobs keep the thrown error's code next to its message so callers (the plugin
-- host's ctx.jobs.status, the UI) can tell JOB_TIMEOUT / JOB_CANCELLED / plugin
-- codes apart from a generic failure. Runs once (schema_migrations), so the
-- non-idempotent ADD COLUMN is safe.
ALTER TABLE jobs ADD COLUMN error_code TEXT;
