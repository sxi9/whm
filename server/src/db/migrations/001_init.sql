-- Identity & access ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  email                TEXT,
  password_hash        TEXT,
  role                 TEXT NOT NULL CHECK (role IN ('root', 'reseller', 'user')),
  totp_secret_enc      TEXT,
  totp_enabled         INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  suspended            INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at        TEXT,
  last_login_ip        TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '[]',
  expires_at   TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reseller_acls (
  reseller_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  acl_key     TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (reseller_id, acl_key)
);

CREATE TABLE IF NOT EXISTS reseller_limits (
  reseller_id      INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  max_accounts     INTEGER,
  max_disk_mb      INTEGER,
  max_bandwidth_mb INTEGER,
  owns_nameservers INTEGER NOT NULL DEFAULT 0,
  nameservers      TEXT NOT NULL DEFAULT '[]',
  shared_ip        TEXT,
  allowed_packages TEXT NOT NULL DEFAULT '[]'
);

-- Packages / features (NULL limit = unlimited) --------------------------------
CREATE TABLE IF NOT EXISTS feature_lists (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  features_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  owner_id           INTEGER REFERENCES users (id) ON DELETE SET NULL,
  disk_mb            INTEGER,
  bandwidth_mb       INTEGER,
  max_domains        INTEGER,
  max_subdomains     INTEGER,
  max_addons         INTEGER,
  max_parked         INTEGER,
  max_db             INTEGER,
  max_email          INTEGER,
  max_ftp            INTEGER,
  max_email_per_hour INTEGER,
  quota_inodes       INTEGER,
  php_version        TEXT,
  feature_list_id    INTEGER REFERENCES feature_lists (id) ON DELETE SET NULL,
  has_shell          INTEGER NOT NULL DEFAULT 0,
  has_dedicated_ip   INTEGER NOT NULL DEFAULT 0,
  cgi                INTEGER NOT NULL DEFAULT 1,
  digest_auth        INTEGER NOT NULL DEFAULT 0,
  theme              TEXT NOT NULL DEFAULT 'jupiter',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hosting accounts ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE,
  domain                TEXT NOT NULL UNIQUE,
  owner_id              INTEGER NOT NULL REFERENCES users (id),
  package_id            INTEGER REFERENCES packages (id) ON DELETE SET NULL,
  package_name          TEXT,
  ip                    TEXT,
  contact_email         TEXT,
  plan_snapshot_json    TEXT NOT NULL DEFAULT '{}',
  shell                 TEXT NOT NULL DEFAULT '/usr/sbin/nologin',
  suspended             INTEGER NOT NULL DEFAULT 0,
  suspend_reason        TEXT,
  suspended_at          TEXT,
  demo_mode             INTEGER NOT NULL DEFAULT 0,
  force_password_change INTEGER NOT NULL DEFAULT 0,
  bandwidth_limit_mb    INTEGER,
  disk_quota_mb         INTEGER,
  disk_used_mb          INTEGER NOT NULL DEFAULT 0,
  bandwidth_used_mb     INTEGER NOT NULL DEFAULT 0,
  uid                   INTEGER,
  gid                   INTEGER,
  home_dir              TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts (owner_id);

CREATE TABLE IF NOT EXISTS account_domains (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  domain      TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('main', 'addon', 'sub', 'parked', 'alias')),
  docroot     TEXT,
  php_version TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_domains_account ON account_domains (account_id);

CREATE TABLE IF NOT EXISTS account_bandwidth (
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  period     TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, period)
);

-- DNS -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dns_zones (
  id             INTEGER PRIMARY KEY,
  domain         TEXT NOT NULL UNIQUE,
  account_id     INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  serial         INTEGER NOT NULL DEFAULT 0,
  ttl            INTEGER NOT NULL DEFAULT 14400,
  type           TEXT NOT NULL DEFAULT 'master',
  dnssec_enabled INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dns_records (
  id         INTEGER PRIMARY KEY,
  zone_id    INTEGER NOT NULL REFERENCES dns_zones (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR', 'SOA')),
  ttl        INTEGER,
  priority   INTEGER,
  value      TEXT NOT NULL,
  line_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dns_records_zone ON dns_records (zone_id);

CREATE TABLE IF NOT EXISTS zone_templates (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dns_clusters (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  remote_host   TEXT NOT NULL,
  api_token_enc TEXT,
  role          TEXT NOT NULL CHECK (role IN ('write-only', 'sync', 'standalone')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Databases -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS db_instances (
  id                 INTEGER PRIMARY KEY,
  profile_name       TEXT NOT NULL UNIQUE,
  engine             TEXT NOT NULL CHECK (engine IN ('mysql', 'mariadb', 'postgres')),
  host               TEXT NOT NULL DEFAULT 'localhost',
  port               INTEGER,
  is_local           INTEGER NOT NULL DEFAULT 1,
  admin_user         TEXT,
  admin_password_enc TEXT,
  is_active          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS databases (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER REFERENCES accounts (id) ON DELETE CASCADE,
  name        TEXT NOT NULL UNIQUE,
  instance_id INTEGER REFERENCES db_instances (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS db_users (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER REFERENCES accounts (id) ON DELETE CASCADE,
  name        TEXT NOT NULL UNIQUE,
  instance_id INTEGER REFERENCES db_instances (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS db_grants (
  id          INTEGER PRIMARY KEY,
  db_user_id  INTEGER NOT NULL REFERENCES db_users (id) ON DELETE CASCADE,
  database_id INTEGER NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
  privileges  TEXT NOT NULL DEFAULT 'ALL PRIVILEGES',
  UNIQUE (db_user_id, database_id)
);

CREATE TABLE IF NOT EXISTS db_access_hosts (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts (id) ON DELETE CASCADE,
  host       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, host)
);

-- Mail ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_domains (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts (id) ON DELETE CASCADE,
  domain     TEXT NOT NULL UNIQUE,
  routing    TEXT NOT NULL DEFAULT 'auto' CHECK (routing IN ('local', 'remote', 'backup', 'auto')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mail_accounts (
  id            INTEGER PRIMARY KEY,
  domain_id     INTEGER NOT NULL REFERENCES mail_domains (id) ON DELETE CASCADE,
  local_part    TEXT NOT NULL,
  quota_mb      INTEGER,
  password_hash TEXT,
  suspended     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (domain_id, local_part)
);

CREATE TABLE IF NOT EXISTS mail_filters (
  id         INTEGER PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('country', 'domain', 'greylist')),
  rule_json  TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dkim_keys (
  domain          TEXT PRIMARY KEY,
  selector        TEXT NOT NULL DEFAULT 'default',
  private_key_enc TEXT NOT NULL,
  public_key      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SSL -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ssl_certs (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  domain     TEXT NOT NULL,
  cert_pem   TEXT,
  key_enc    TEXT,
  chain_pem  TEXT,
  csr_pem    TEXT,
  issuer     TEXT,
  subject    TEXT,
  not_before TEXT,
  not_after  TEXT,
  autossl    INTEGER NOT NULL DEFAULT 0,
  installed  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ssl_certs_domain ON ssl_certs (domain);

CREATE TABLE IF NOT EXISTS ssl_service_certs (
  service    TEXT PRIMARY KEY,
  cert_pem   TEXT,
  key_enc    TEXT,
  chain_pem  TEXT,
  not_after  TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Network -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ip_addresses (
  id              INTEGER PRIMARY KEY,
  address         TEXT NOT NULL UNIQUE,
  family          INTEGER NOT NULL CHECK (family IN (4, 6)),
  netmask         TEXT,
  interface       TEXT,
  is_main         INTEGER NOT NULL DEFAULT 0,
  reserved        INTEGER NOT NULL DEFAULT 0,
  reserved_reason TEXT,
  dedicated_to    INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  delegated_to    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Security ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cphulk_blocks (
  id         INTEGER PRIMARY KEY,
  ip         TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cphulk_blocks_ip ON cphulk_blocks (ip);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY,
  ip         TEXT NOT NULL,
  username   TEXT,
  ok         INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, created_at);

CREATE TABLE IF NOT EXISTS host_access_rules (
  id       INTEGER PRIMARY KEY,
  service  TEXT NOT NULL,
  source   TEXT NOT NULL,
  action   TEXT NOT NULL CHECK (action IN ('allow', 'deny')),
  comment  TEXT,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS modsec_vendors (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  url          TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS modsec_rules (
  id        INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES modsec_vendors (id) ON DELETE CASCADE,
  rule_id   TEXT NOT NULL,
  disabled  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (vendor_id, rule_id)
);

-- Ops / platform ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  name               TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  unit_candidates    TEXT NOT NULL DEFAULT '[]',
  monitored          INTEGER NOT NULL DEFAULT 1,
  enabled            INTEGER NOT NULL DEFAULT 1,
  restart_on_failure INTEGER NOT NULL DEFAULT 1,
  position           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress    INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error       TEXT,
  created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS job_logs (
  id     INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  ts     TEXT NOT NULL DEFAULT (datetime('now')),
  level  TEXT NOT NULL DEFAULT 'info',
  line   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs (job_id);

CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  cron        TEXT NOT NULL,
  job_type    TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT
);

CREATE TABLE IF NOT EXISTS backup_destinations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('local', 'ftp', 'sftp', 's3', 'b2', 'gdrive', 'webdav')),
  config_enc TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  account_name   TEXT,
  type           TEXT NOT NULL DEFAULT 'full',
  destination_id INTEGER REFERENCES backup_destinations (id) ON DELETE SET NULL,
  path           TEXT,
  size           INTEGER,
  sha256         TEXT,
  status         TEXT NOT NULL DEFAULT 'done',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'slack', 'pushover', 'webhook')),
  address     TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hooks (
  id         INTEGER PRIMARY KEY,
  event      TEXT NOT NULL,
  stage      TEXT NOT NULL CHECK (stage IN ('pre', 'post')),
  action     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locales (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  strings_json TEXT NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL DEFAULT (datetime('now')),
  principal     TEXT,
  role          TEXT,
  ip            TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  args_redacted TEXT,
  result        TEXT NOT NULL,
  request_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);
