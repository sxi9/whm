-- Email All Resellers: the message and the per-recipient outcome live here, not
-- in the job's params/result, because job records are readable by every reseller.
CREATE TABLE IF NOT EXISTS reseller_broadcasts (
  id           INTEGER PRIMARY KEY,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  from_address TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  job_id       INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  sent_json    TEXT NOT NULL DEFAULT '[]',
  failed_json  TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
