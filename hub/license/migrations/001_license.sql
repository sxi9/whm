-- §16.3 as amended by the Phase-5 build plan (signing_keys.purpose, portal_sessions)
-- plus the hub-internal tables the services need (messages, jobs, lookup blocks).

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_url TEXT,
  support_email TEXT,
  default_grace_days INTEGER NOT NULL DEFAULT 7,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO vendors (id, name) VALUES ('vnd_default', 'WHM Vendor');

CREATE TABLE IF NOT EXISTS resellers (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL DEFAULT 'vnd_default' REFERENCES vendors(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  portal_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  quota_json TEXT NOT NULL DEFAULT '{}',
  pricing_json TEXT NOT NULL DEFAULT '{}',
  issued_json TEXT NOT NULL DEFAULT '{}',
  brand_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL DEFAULT 'vnd_default' REFERENCES vendors(id),
  reseller_id TEXT REFERENCES resellers(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  company TEXT,
  country TEXT,
  external_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS customers_reseller ON customers(reseller_id);

CREATE TABLE IF NOT EXISTS portal_users (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL DEFAULT 'vnd_default' REFERENCES vendors(id),
  reseller_id TEXT REFERENCES resellers(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('vendor_admin', 'vendor_support', 'reseller_admin', 'reseller_staff')),
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  edition TEXT NOT NULL CHECK (edition IN ('trial', 'solo', 'pro', 'reseller', 'enterprise')),
  rank INTEGER NOT NULL,
  term TEXT NOT NULL CHECK (term IN ('days', 'monthly', 'annual', 'contract')),
  term_days INTEGER,
  limits_json TEXT NOT NULL,
  features_json TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  active INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO products (id, sku, name, edition, rank, term, term_days, limits_json, features_json, price_cents, currency, active) VALUES
  ('prd_trial', 'whm-trial', 'Trial', 'trial', 10, 'days', 14,
   '{"max_accounts":5,"max_resellers":0,"max_domains_per_account":-1,"max_activations":1,"grace_days":0}',
   '{"api":false,"transfers":false,"clusters":false,"multi_server":false,"marketplace_free":true,"marketplace_paid":false,"white_label":false,"autossl_wildcard":false,"sso":false,"terminal":false,"priority_support":false,"custom_branding_builder":false}',
   0, 'USD', 1),
  ('prd_solo_monthly', 'whm-solo-monthly', 'Solo (monthly)', 'solo', 20, 'monthly', NULL,
   '{"max_accounts":25,"max_resellers":0,"max_domains_per_account":-1,"max_activations":1,"grace_days":7}',
   '{"api":true,"transfers":false,"clusters":false,"multi_server":false,"marketplace_free":true,"marketplace_paid":false,"white_label":false,"autossl_wildcard":false,"sso":false,"terminal":false,"priority_support":false,"custom_branding_builder":false}',
   1500, 'USD', 1),
  ('prd_solo_annual', 'whm-solo-annual', 'Solo (annual)', 'solo', 20, 'annual', NULL,
   '{"max_accounts":25,"max_resellers":0,"max_domains_per_account":-1,"max_activations":1,"grace_days":7}',
   '{"api":true,"transfers":false,"clusters":false,"multi_server":false,"marketplace_free":true,"marketplace_paid":false,"white_label":false,"autossl_wildcard":false,"sso":false,"terminal":false,"priority_support":false,"custom_branding_builder":false}',
   15000, 'USD', 1),
  ('prd_pro_monthly', 'whm-pro-monthly', 'Pro (monthly)', 'pro', 30, 'monthly', NULL,
   '{"max_accounts":-1,"max_resellers":5,"max_domains_per_account":-1,"max_activations":1,"grace_days":7}',
   '{"api":true,"transfers":true,"clusters":false,"multi_server":false,"marketplace_free":true,"marketplace_paid":true,"white_label":false,"autossl_wildcard":true,"sso":false,"terminal":false,"priority_support":false,"custom_branding_builder":false}',
   4500, 'USD', 1),
  ('prd_pro_annual', 'whm-pro-annual', 'Pro (annual)', 'pro', 30, 'annual', NULL,
   '{"max_accounts":-1,"max_resellers":5,"max_domains_per_account":-1,"max_activations":1,"grace_days":7}',
   '{"api":true,"transfers":true,"clusters":false,"multi_server":false,"marketplace_free":true,"marketplace_paid":true,"white_label":false,"autossl_wildcard":true,"sso":false,"terminal":false,"priority_support":false,"custom_branding_builder":false}',
   45000, 'USD', 1),
  ('prd_reseller_annual_5', 'whm-reseller-annual-5', 'Reseller (annual, 5 servers)', 'reseller', 40, 'annual', NULL,
   '{"max_accounts":-1,"max_resellers":-1,"max_domains_per_account":-1,"max_activations":5,"grace_days":7}',
   '{"api":true,"transfers":true,"clusters":true,"multi_server":true,"marketplace_free":true,"marketplace_paid":true,"white_label":true,"autossl_wildcard":true,"sso":false,"terminal":false,"priority_support":false,"custom_branding_builder":false}',
   180000, 'USD', 1),
  ('prd_enterprise', 'whm-enterprise', 'Enterprise (contract)', 'enterprise', 50, 'contract', NULL,
   '{"max_accounts":-1,"max_resellers":-1,"max_domains_per_account":-1,"max_activations":10,"grace_days":30}',
   '{"api":true,"transfers":true,"clusters":true,"multi_server":true,"marketplace_free":true,"marketplace_paid":true,"white_label":true,"autossl_wildcard":true,"sso":true,"terminal":true,"priority_support":true,"custom_branding_builder":true}',
   0, 'USD', 1);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  edition TEXT NOT NULL,
  rank INTEGER NOT NULL,
  term TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  features_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'expired', 'revoked')),
  issued_at TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT,
  grace_days INTEGER NOT NULL DEFAULT 7,
  max_activations INTEGER NOT NULL DEFAULT 1,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  reseller_id TEXT REFERENCES resellers(id),
  issued_by TEXT,
  notes TEXT,
  external_ref TEXT,
  reactivation_override_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS licenses_prefix ON licenses(key_prefix);
CREATE INDEX IF NOT EXISTS licenses_customer ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS licenses_reseller ON licenses(reseller_id);
CREATE INDEX IF NOT EXISTS licenses_external ON licenses(external_ref);
CREATE INDEX IF NOT EXISTS licenses_status_expiry ON licenses(status, expires_at);

CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  fingerprint TEXT NOT NULL,
  fp_components_json TEXT NOT NULL,
  hostname TEXT,
  public_ip TEXT,
  panel_version TEXT,
  os TEXT,
  first_seen TEXT NOT NULL,
  last_checkin TEXT,
  token_kid TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'reclaimed', 'blocked', 'transferred')),
  deactivated_at TEXT,
  deactivated_by TEXT,
  drift_events INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activations_license ON activations(license_id, status);
CREATE INDEX IF NOT EXISTS activations_fingerprint ON activations(fingerprint);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activation_id TEXT NOT NULL REFERENCES activations(id),
  license_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  panel_version TEXT,
  accounts_used INTEGER,
  resellers_used INTEGER,
  domains_used INTEGER,
  usage_json TEXT,
  ip TEXT,
  result TEXT NOT NULL,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS checkins_activation ON checkins(activation_id, ts);
CREATE INDEX IF NOT EXISTS checkins_license ON checkins(license_id, ts);

CREATE TABLE IF NOT EXISTS revocations (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  activation_id TEXT,
  reason TEXT,
  revoked_by TEXT,
  ts TEXT NOT NULL,
  propagated_at TEXT
);

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  license_id TEXT NOT NULL REFERENCES licenses(id),
  fingerprint TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  ip TEXT,
  started_at TEXT NOT NULL,
  converted_license_id TEXT,
  converted_at TEXT
);
CREATE INDEX IF NOT EXISTS trials_fingerprint ON trials(fingerprint);
CREATE INDEX IF NOT EXISTS trials_email ON trials(email_hash);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  from_activation_id TEXT NOT NULL,
  to_activation_id TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  requested_by TEXT
);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  external_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  processed_at TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('vendor', 'reseller')),
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["*"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_owner ON webhook_endpoints(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('vendor', 'reseller')),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('license', 'plugin')),
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'retiring', 'retired'))
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
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);

-- Messages queued for the panel's next check-in (license_id NULL = every panel).
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  code TEXT NOT NULL,
  text TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  activation_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (message_id, activation_id)
);

-- Bulk issuance and other long operations (202 { job }).
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  owner_type TEXT,
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  params_json TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- Failed key lookups per IP and the 24 h blocks they lead to (§16.10).
CREATE TABLE IF NOT EXISTS lookup_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lookup_failures_ip ON lookup_failures(ip, ts);
CREATE TABLE IF NOT EXISTS ip_blocks (
  ip TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
