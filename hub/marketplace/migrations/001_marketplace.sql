-- marketplace.db (§18.2–18.5). signing_keys lives in license.db and is read
-- through ctx.keys only; this file never creates it.

CREATE TABLE IF NOT EXISTS developers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  email_verify_token_hash TEXT,
  email_verify_expires_at TEXT,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  company TEXT,
  website TEXT,
  country TEXT,
  support_email TEXT,
  support_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'suspended')),
  status_reason TEXT,
  verified_at TEXT,
  verified_by TEXT,
  reverify_due_at TEXT,
  namespaces_json TEXT NOT NULL DEFAULT '[]',
  payout_json_enc TEXT,
  revenue_share_pct INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  lockouts INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT,
  credentials_changed_at TEXT,
  rejections_json TEXT NOT NULL DEFAULT '[]',
  last_login_ip_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS developer_namespaces (
  ns TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'verified', 'revoked')),
  verified_at TEXT,
  last_check_at TEXT,
  last_check_result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS developer_namespaces_dev ON developer_namespaces(developer_id);

CREATE TABLE IF NOT EXISTS developer_verifications (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  ns TEXT,
  method TEXT NOT NULL CHECK (method IN ('dns_txt', 'well_known', 'github_org', 'id_document')),
  evidence_json TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'passed', 'failed', 'expired')),
  result_detail TEXT,
  checked_at TEXT,
  reviewer_id TEXT,
  reviewer_note TEXT,
  document_enc TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS developer_verifications_dev ON developer_verifications(developer_id);

CREATE TABLE IF NOT EXISTS developer_keys (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  kid TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE TABLE IF NOT EXISTS developer_key_challenges (
  challenge TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS developer_sessions (
  sid TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  data TEXT NOT NULL DEFAULT '{}',
  totp_verified_at INTEGER,
  created_at TEXT NOT NULL,
  ip_hash TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS developer_sessions_dev ON developer_sessions(developer_id);

CREATE TABLE IF NOT EXISTS developer_api_keys (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS developer_password_resets (
  token_hash TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS developer_webhooks (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  events_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS developer_webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL REFERENCES developer_webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'delivered', 'failed')),
  next_at TEXT,
  last_code INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS developer_webhook_deliveries_due ON developer_webhook_deliveries(status, next_at);

CREATE TABLE IF NOT EXISTS developer_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  developer_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ip_hash TEXT,
  detail TEXT,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO categories (id, slug, name, position) VALUES
  ('cat_security', 'security', 'Security', 1),
  ('cat_backups', 'backups', 'Backups', 2),
  ('cat_wordpress', 'wordpress', 'WordPress', 3),
  ('cat_monitoring', 'monitoring', 'Monitoring', 4),
  ('cat_mail', 'mail', 'Mail', 5),
  ('cat_dns', 'dns', 'DNS', 6),
  ('cat_devtools', 'developer-tools', 'Developer tools', 7),
  ('cat_billing', 'billing', 'Billing', 8),
  ('cat_other', 'other', 'Other', 9);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  name TEXT NOT NULL,
  name_skeleton TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  description_md TEXT,
  category_id TEXT REFERENCES categories(id),
  keywords_json TEXT NOT NULL DEFAULT '[]',
  homepage TEXT,
  support_url TEXT,
  license_spdx TEXT,
  icon_file_id TEXT,
  pricing_json TEXT NOT NULL DEFAULT '{"model":"free"}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'listed', 'unlisted', 'removed')),
  featured INTEGER NOT NULL DEFAULT 0,
  bundled_editions_json TEXT NOT NULL DEFAULT '[]',
  latest_stable_version TEXT,
  latest_beta_version TEXT,
  install_count INTEGER NOT NULL DEFAULT 0,
  rating_avg REAL,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plugins_dev ON plugins(developer_id);

CREATE TABLE IF NOT EXISTS plugin_versions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'scanning', 'scan_failed', 'in_review', 'changes_requested', 'approved', 'published', 'rejected', 'yanked', 'revoked')),
  manifest_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  engines_whm TEXT NOT NULL,
  permission_justifications_json TEXT NOT NULL DEFAULT '{}',
  changelog_md TEXT,
  upload_sha256 TEXT NOT NULL,
  upload_file TEXT NOT NULL,
  package_sha256 TEXT,
  package_file TEXT,
  package_bytes INTEGER,
  extracted_bytes INTEGER,
  package_digest TEXT NOT NULL,
  dev_kid TEXT NOT NULL,
  dev_signature TEXT NOT NULL,
  mkt_kid TEXT,
  mkt_signature TEXT,
  signed_at TEXT,
  risk TEXT NOT NULL DEFAULT 'normal' CHECK (risk IN ('normal', 'high')),
  scan_report_json TEXT,
  review_id TEXT,
  published_at TEXT,
  yanked_at TEXT,
  yanked_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plugin_id, version)
);
CREATE INDEX IF NOT EXISTS plugin_versions_status ON plugin_versions(status);

CREATE TABLE IF NOT EXISTS plugin_version_signatures (
  version_id TEXT NOT NULL REFERENCES plugin_versions(id),
  mkt_kid TEXT NOT NULL,
  mkt_signature TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  file TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  PRIMARY KEY (version_id, mkt_kid)
);

CREATE TABLE IF NOT EXISTS plugin_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL REFERENCES plugin_versions(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  text TEXT
);
CREATE INDEX IF NOT EXISTS plugin_files_version ON plugin_files(version_id);

CREATE TABLE IF NOT EXISTS plugin_assets (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'icon', 'banner')),
  file_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES plugin_versions(id),
  reviewer_id TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'changes_requested', 'rejected')),
  checklist_json TEXT NOT NULL DEFAULT '{}',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  notes_md TEXT,
  diff_base_version_id TEXT,
  approvals_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS plugin_reviews (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  customer_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'hidden')),
  flagged INTEGER NOT NULL DEFAULT 0,
  moderated_by TEXT,
  developer_reply TEXT,
  developer_replied_at TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plugin_id, customer_id)
);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES plugin_versions(id),
  license_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  ip_hash TEXT,
  panel_version TEXT,
  ts TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  fetched_at TEXT,
  result TEXT NOT NULL DEFAULT 'issued'
);
CREATE INDEX IF NOT EXISTS downloads_expiry ON downloads(expires_at);

CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installed', 'enabled', 'disabled', 'uninstalled', 'revoked', 'errored', 'activating')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (plugin_id, activation_id)
);
CREATE INDEX IF NOT EXISTS installs_license ON installs(license_id, plugin_id);

CREATE TABLE IF NOT EXISTS revocations (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  action TEXT NOT NULL CHECK (action IN ('disable', 'uninstall')),
  reason TEXT,
  revoked_by TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revocations_ts ON revocations(ts);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  customer_id TEXT,
  plugin_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('free', 'one_time', 'subscription', 'trial')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'refunded')),
  starts_at TEXT NOT NULL,
  expires_at TEXT,
  purchase_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('checkout', 'admin', 'reseller', 'trial')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entitlements_license ON entitlements(license_id, plugin_id);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  license_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  tax_cents INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'refunded', 'chargeback', 'cancelled')),
  revenue_share_pct INTEGER NOT NULL,
  developer_cents INTEGER NOT NULL,
  vendor_cents INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  refunded_at TEXT,
  payout_id TEXT
);
CREATE INDEX IF NOT EXISTS purchases_dev ON purchases(developer_id, paid_at);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  gross_cents INTEGER NOT NULL,
  refunds_cents INTEGER NOT NULL,
  share_pct INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'failed', 'held')),
  hold_reason TEXT,
  provider_ref TEXT,
  statement_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS customer_magic_links (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  email TEXT NOT NULL,
  plugin_id TEXT,
  license_id TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_events (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_key ON rate_events(key, ts);

CREATE TABLE IF NOT EXISTS market_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  principal TEXT,
  role TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  args_redacted TEXT,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_audit_log_ts ON audit_log(ts);
