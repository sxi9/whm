-- Themes: interface themes built on the CSS token layer (client/src/theme/tokens.css).
-- A theme is a base scheme (light/dark) plus overrides for the design tokens and an
-- optional uploaded CSS override stored under $WHM_DATA_DIR/themes/<slug>.css.
-- Built-in themes can be copied but neither edited nor deleted.
CREATE TABLE IF NOT EXISTS themes (
  slug           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  base           TEXT NOT NULL DEFAULT 'light' CHECK (base IN ('light', 'dark')),
  builtin        INTEGER NOT NULL DEFAULT 0,
  copied_from    TEXT,
  variables_json TEXT NOT NULL DEFAULT '{}',
  css_file       TEXT,
  css_bytes      INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user override of the server default (panel users: root/resellers/users).
CREATE TABLE IF NOT EXISTS theme_user_prefs (
  user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  theme      TEXT NOT NULL REFERENCES themes (slug) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO themes (slug, name, base, builtin, variables_json) VALUES
  ('jupiter', 'Jupiter', 'light', 1, '{}'),
  ('jupiter-dark', 'Jupiter Dark', 'dark', 1, '{}'),
  ('high-contrast', 'High Contrast', 'light', 1,
   '{"bg":"#ffffff","surface":"#ffffff","surface-2":"#f2f2f2","border":"#000000","border-strong":"#000000","text":"#000000","text-muted":"#1a1a1a","text-faint":"#333333","chrome":"#000000","chrome-2":"#111111","chrome-text":"#ffffff","chrome-muted":"#e0e0e0","chrome-hover":"#333333","chrome-active":"#ffd200","primary":"#0000cc","primary-hover":"#000099","primary-text":"#ffffff","primary-soft":"#dde3ff","ok":"#006400","ok-soft":"#d9f2d9","warn":"#7a4b00","warn-soft":"#ffe9c2","bad":"#b00000","bad-soft":"#ffd9d9","info":"#0000cc","info-soft":"#dde3ff","radius":"2px","radius-lg":"4px"}');

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('themes.default', '"jupiter"'),
  ('themes.account_default', '"jupiter"'),
  ('themes.allow_user_override', 'true');
