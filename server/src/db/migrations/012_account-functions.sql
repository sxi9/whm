-- Account Functions: per-account web log retention and the editable site/error
-- page templates (the files under /etc/whm/templates are rendered from these).
CREATE TABLE IF NOT EXISTS account_log_retention (
  account_id          INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  archive_logs        INTEGER NOT NULL DEFAULT 0,
  remove_old_archives INTEGER NOT NULL DEFAULT 1,
  retain_months       INTEGER NOT NULL DEFAULT 3,
  last_archived_at    TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS web_templates (
  name       TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO web_templates (name, body) VALUES ('index', '<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{domain}}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6f8;color:#1f2a37}main{text-align:center}h1{font-weight:600}</style></head>
<body><main><h1>{{domain}}</h1><p>This site is hosted but has no content yet. Upload your files to <code>public_html</code>.</p></main></body></html>
');
INSERT OR IGNORE INTO web_templates (name, body) VALUES ('suspended', '<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Account suspended</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#fff7ed;color:#1f2a37}main{text-align:center;max-width:520px}h1{font-weight:600}</style></head>
<body><main><h1>This account has been suspended</h1><p>The website for <strong>{{domain}}</strong> is temporarily unavailable.</p><p>Contact the hosting provider at <a href="mailto:{{contact_email}}">{{contact_email}}</a> for assistance.</p></main></body></html>
');
INSERT OR IGNORE INTO web_templates (name, body) VALUES ('moved', '<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Site moved</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6f8;color:#1f2a37}main{text-align:center;max-width:520px}h1{font-weight:600}</style></head>
<body><main><h1>{{domain}} has moved</h1><p>This website is now served from a different address. If you keep seeing this page, the DNS change has not reached you yet.</p><p>Hosted on {{hostname}}.</p></main></body></html>
');
INSERT OR IGNORE INTO web_templates (name, body) VALUES ('error-4xx', '<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{status}} {{status_text}}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6f8;color:#1f2a37}main{text-align:center;max-width:520px}h1{font-weight:600}</style></head>
<body><main><h1>{{status}} {{status_text}}</h1><p>The page you requested on <strong>{{domain}}</strong> could not be served.</p><p>Hosted on {{hostname}}.</p></main></body></html>
');

INSERT OR IGNORE INTO settings (key, value) VALUES ('account_functions.bandwidth_enforce', 'false');
INSERT OR IGNORE INTO settings (key, value) VALUES ('account_functions.bandwidth_suspend_reason', '"bandwidth: monthly transfer limit exceeded"');
INSERT OR IGNORE INTO settings (key, value) VALUES ('account_functions.email_from', '""');
INSERT OR IGNORE INTO settings (key, value) VALUES ('account_functions.log_archive_default', 'false');
