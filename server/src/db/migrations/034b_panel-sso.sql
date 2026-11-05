-- Customer panel single sign-on: one-time tokens the panel mints for a browser
-- hand-off into a published application (webmail, phpMyAdmin) and that the
-- application's signon script exchanges over loopback. Only the SHA-256 of a
-- token is stored; the payload (which mailbox / database user) is encrypted
-- with lib/crypto.js. Generic across kinds so every published app reuses it.
CREATE TABLE IF NOT EXISTS panel_sso_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  account     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('webmail', 'phpmyadmin')),
  token_hash  TEXT NOT NULL UNIQUE,
  payload_enc TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_panel_sso_tokens_expiry ON panel_sso_tokens(expires_at, used_at);
