-- Service Configuration ------------------------------------------------------

-- Virtual hosts the panel renders into Apache. The stored spec lets other
-- categories (SSL, DNS forwarding, IP migration) change one aspect and re-render.
CREATE TABLE IF NOT EXISTS web_vhosts (
  id                INTEGER PRIMARY KEY,
  domain            TEXT NOT NULL UNIQUE,
  account_id        INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  username          TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'main' CHECK (type IN ('main', 'addon', 'sub', 'server')),
  docroot           TEXT NOT NULL,
  aliases_json      TEXT NOT NULL DEFAULT '[]',
  ip                TEXT,
  ipv6              TEXT,
  php_version       TEXT,
  ssl_json          TEXT,
  redirects_json    TEXT NOT NULL DEFAULT '[]',
  custom_directives TEXT NOT NULL DEFAULT '',
  path              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('applied', 'pending', 'failed')),
  error             TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_web_vhosts_account ON web_vhosts (account_id);

-- PHP-FPM pools written under the detected pool directory: one per account and
-- PHP version, so domains of one account may run different versions.
CREATE TABLE IF NOT EXISTS web_php_pools (
  username      TEXT NOT NULL,
  version       TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  path          TEXT,
  socket        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('applied', 'pending', 'failed')),
  error         TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (username, version)
);

-- Last apply per component (apache, exim, dovecot, ftp, logrotate, nameserver…)
-- so every page can show "saved and live" versus "saved, daemon missing".
CREATE TABLE IF NOT EXISTS service_config_applies (
  component  TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  ok         INTEGER NOT NULL DEFAULT 1,
  summary    TEXT,
  error      TEXT
);

-- Settings defaults ---------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('service_config.apache', '{"timeout":300,"keepAlive":true,"maxKeepAliveRequests":100,"keepAliveTimeout":5,"serverTokens":"Prod","serverSignature":"Off","traceEnable":"off","hostnameLookups":"Off","serverAdmin":"","directoryIndex":["index.php","index.html","index.htm"],"fileETag":"None","limitRequestBody":0,"serverStatus":true,"mpm":{"module":"event","startServers":2,"minSpareServers":5,"maxSpareServers":10,"minSpareThreads":25,"maxSpareThreads":75,"threadsPerChild":25,"maxRequestWorkers":150,"maxConnectionsPerChild":0,"serverLimit":16},"customDirectives":"","defaultPhpVersion":null}'),
  ('service_config.logrotate', '{"frequency":"daily","rotate":14,"compress":true,"delaycompress":true,"missingok":true,"notifempty":true,"dateext":false,"maxSize":"","panelLogs":true,"accountLogs":true,"webServerLogs":false,"postrotateWeb":true}'),
  ('service_config.webdisk', '{"enabled":true,"port":2077,"sslPort":2078,"requireSsl":true,"allowDigestAuth":true,"allowAnonymousDiscovery":false,"maxUploadMb":2048,"idleTimeoutMinutes":30,"allowedAccounts":"all"}'),
  ('service_config.webservices', '{"apiEnabled":true,"tokenLifetimeMinutes":1440,"sessionTimeoutMinutes":60,"maxConcurrentRequests":200,"rateLimitPerMinute":600,"allowedOrigins":[],"enableCompression":true,"requestLogRetentionDays":30,"exposeVersion":false,"ipv6Listen":true}'),
  ('service_config.exim', '{"rblEnabled":true,"rbls":["zen.spamhaus.org","bl.spamcop.net"],"domainRblEnabled":false,"domainRbls":["dbl.spamhaus.org"],"spfVerify":true,"spfReject":false,"dkimVerify":true,"dkimReject":false,"reverseDnsRequired":false,"verifySender":true,"requireHelo":true,"maxMessageSizeMb":50,"smtpAcceptMax":100,"smtpAcceptMaxPerHost":10,"smtpAcceptQueuePerConnection":10,"ratelimitEnabled":true,"ratelimitMailThreshold":10,"ratelimitMailDelay":1,"ratelimitRcptThreshold":50,"ratelimitRcptDelay":1,"dictionaryAttackProtection":true,"maxUnknownCommands":3,"rcptFailLimit":4,"rcptFailDelay":10,"recipientsMax":100,"recipientsMaxReject":true,"requireTlsForAuth":true,"logSelector":["+smtp_connection","+subject","+tls_cipher"]}'),
  ('service_config.mailserver', '{"protocols":["imap","pop3","lmtp"],"maxUserIpConnections":20,"processLimit":1000,"clientLimit":1000,"ssl":"required","sslMinProtocol":"TLSv1.2","disablePlaintextAuth":true,"loginGreeting":"","imapIdleNotifyIntervalMinutes":2,"pop3UidlFormat":"%08Xu%08Xv","mailLocation":"maildir:~/mail","mailboxFormat":"maildir"}'),
  ('service_config.ftp', '{"passivePortMin":49152,"passivePortMax":65534,"passiveAddress":"","tls":"optional","maxClients":50,"maxPerIp":8,"anonymous":false,"idleTimeoutMinutes":15,"chroot":true}'),
  ('service_config.nameserver', '{"server":"bind","role":"master"}'),
  ('service_config.ftp_server', '"pure-ftpd"');
