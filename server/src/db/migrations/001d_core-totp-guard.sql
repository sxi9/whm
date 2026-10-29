-- Second-factor brute-force and replay state. Kept in the database so a panel
-- restart neither frees a paused user nor lets a just-used code pass again.
CREATE TABLE IF NOT EXISTS totp_guard (
  user_id          INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  failures         INTEGER NOT NULL DEFAULT 0,
  first_failure_ms INTEGER,
  locked_until_ms  INTEGER,
  last_code_hash   TEXT,
  last_code_ms     INTEGER
);
