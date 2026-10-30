import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Service registry: the Restart Services + Service Manager entries. Each has the
// systemd unit names it may appear under across Debian/Ubuntu and RHEL families;
// the capability layer resolves which one exists on this host.
export const SERVICE_REGISTRY = [
  { name: 'mysql', display_name: 'Database Server (MySQL/MariaDB)', units: ['mariadb', 'mysql', 'mysqld'], position: 10 },
  { name: 'named', display_name: 'DNS Server (BIND)', units: ['named', 'bind9'], position: 20 },
  { name: 'httpd', display_name: 'HTTP Server (Apache)', units: ['apache2', 'httpd'], position: 30 },
  { name: 'nginx', display_name: 'NGINX', units: ['nginx'], position: 35, monitored: 0 },
  { name: 'imap', display_name: 'IMAP Server (Dovecot)', units: ['dovecot'], position: 40 },
  { name: 'exim', display_name: 'Mail Server (Exim)', units: ['exim4', 'exim'], position: 50 },
  { name: 'mailman', display_name: 'Mailing List Manager (Mailman)', units: ['mailman3', 'mailman'], position: 60, monitored: 0 },
  { name: 'php-fpm', display_name: 'PHP-FPM service for Apache', units: ['php-fpm', 'php*-fpm'], position: 70 },
  { name: 'sshd', display_name: 'SSH Server (OpenSSH)', units: ['ssh', 'sshd'], position: 80 },
  { name: 'ftpd', display_name: 'FTP Server', units: ['pure-ftpd', 'proftpd', 'vsftpd'], position: 90 },
  { name: 'cron', display_name: 'Cron Daemon', units: ['cron', 'crond'], position: 100 },
  { name: 'spamd', display_name: 'SpamAssassin (spamd)', units: ['spamd', 'spamassassin'], position: 110, monitored: 0 },
  { name: 'postgresql', display_name: 'PostgreSQL Server', units: ['postgresql'], position: 120, monitored: 0 },
  { name: 'whm-agentd', display_name: 'WHM Agent Daemon', units: ['whm-agentd'], position: 130, monitored: 0 },
];

export const DEFAULT_SETTINGS = {
  'basic.contact_email': '',
  'basic.hostname': os.hostname(),
  'basic.main_ip': '',
  'basic.shared_ip': '',
  'basic.nameservers': ['ns1.example.com', 'ns2.example.com'],
  'basic.home_root': '/home',
  'basic.default_package': 'default',
  'tweak.max_emails_per_hour': 0,
  'tweak.allow_remote_domains': false,
  'tweak.prevent_unlimited_bandwidth': false,
  'tweak.login_theme': 'jupiter',
  'web.force_https': true,
  'panel.force_https': true,
  'security.min_password_strength': 65,
  'security.cphulk.enabled': true,
  'security.cphulk.max_failures_per_ip': 15,
  'security.cphulk.lockout_minutes': 30,
  'security.2fa.required_for_root': false,
  'backup.enabled': false,
  'backup.schedule': '0 2 * * *',
  'backup.retention_daily': 7,
  'backup.retention_weekly': 4,
  'backup.retention_monthly': 3,
  'dns.default_ttl': 14400,
  'php.default_version': 'ea-php83',
  'updates.tier': 'stable',
  'updates.auto': true,
  'analytics.enabled': false,
  'setup.completed': false,
};

export const DEFAULT_ZONE_TEMPLATE = `; Zone template: %domain%
$TTL %ttl%
@   IN  SOA %ns1%. hostmaster.%domain%. (
        %serial%  ; serial
        3600      ; refresh
        1800      ; retry
        1209600   ; expire
        86400 )   ; minimum
@       IN  NS    %ns1%.
@       IN  NS    %ns2%.
@       IN  A     %ip%
www     IN  CNAME %domain%.
mail    IN  A     %ip%
ftp     IN  CNAME %domain%.
@       IN  MX 0  mail.%domain%.
@       IN  TXT   "v=spf1 +mx +a ip4:%ip% ~all"
`;

export const DEFAULT_FEATURES = {
  addondomains: true, subdomains: true, parkeddomains: true, filemanager: true, ftpaccts: true,
  emailaccts: true, forwarders: true, autoresponders: true, defaultaddress: true, spamassassin: true,
  mysql: true, phpmyadmin: true, postgres: false, cron: true, ssh: false, backup: true, bandwidth: true,
  statselect: true, awstats: true, webalizer: false, errlog: true, rawlog: true, sslmanager: true,
  autossl: true, phpversion: true, multiphp: true, webdisk: true, api: true, passwordchange: true,
  hotlink: true, leechprotect: true, indexmanager: true, errpgs: true, redirects: true, cpanelpro_support: false,
};

export async function seed({ db, config, crypto, logger }) {
  const tx = db.transaction(() => {
    const putSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) putSetting.run(key, JSON.stringify(value));

    // The registry owns display_name, unit_candidates and position: a row kept
    // from an earlier release would otherwise never learn a new unit name.
    // monitored/enabled/restart_on_failure belong to the operator and are kept.
    const putService = db.prepare(`INSERT INTO services (name, display_name, unit_candidates, monitored, position)
      VALUES (@name, @display_name, @units, @monitored, @position)
      ON CONFLICT(name) DO UPDATE SET display_name = excluded.display_name, unit_candidates = excluded.unit_candidates, position = excluded.position`);
    for (const s of SERVICE_REGISTRY) {
      putService.run({ ...s, units: JSON.stringify(s.units), monitored: s.monitored ?? 1 });
    }

    db.prepare('INSERT OR IGNORE INTO zone_templates (name, body) VALUES (?, ?)').run('standard', DEFAULT_ZONE_TEMPLATE);
    db.prepare('INSERT OR IGNORE INTO feature_lists (name, features_json) VALUES (?, ?)').run('default', JSON.stringify(DEFAULT_FEATURES));
    db.prepare('INSERT OR IGNORE INTO feature_lists (name, features_json) VALUES (?, ?)').run('disabled', JSON.stringify(
      Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((k) => [k, false])),
    ));

    const defaultList = db.prepare('SELECT id FROM feature_lists WHERE name = ?').get('default');
    db.prepare(`INSERT OR IGNORE INTO packages (name, disk_mb, bandwidth_mb, max_domains, max_subdomains, max_addons, max_parked,
        max_db, max_email, max_ftp, feature_list_id, php_version)
      VALUES ('default', 10240, 102400, 1, 10, 0, 0, 10, 50, 10, ?, 'ea-php83')`).run(defaultList.id);

    db.prepare(`INSERT OR IGNORE INTO db_instances (profile_name, engine, host, port, is_local, is_active)
      VALUES ('localhost', 'mysql', 'localhost', 3306, 1, 1)`).run();
    db.prepare(`INSERT OR IGNORE INTO locales (code, name) VALUES ('en', 'English')`).run();
  });
  tx();

  const hasRoot = db.prepare("SELECT 1 FROM users WHERE role = 'root' LIMIT 1").get();
  if (!hasRoot) {
    let password = config.adminPassword;
    let generated = false;
    if (!password) {
      password = crypto.randomPassword(20);
      generated = true;
    }
    const hash = await crypto.hashPassword(password);
    db.prepare("INSERT INTO users (username, role, password_hash, must_change_password) VALUES ('root', 'root', ?, ?)")
      .run(hash, generated ? 1 : 0);
    if (generated) {
      const file = path.join(config.dataDir, 'initial-admin-password.txt');
      fs.writeFileSync(file, `username: root\npassword: ${password}\n`, { mode: 0o600 });
      logger.warn({ file }, 'created initial "root" administrator; the generated password was written to this file (delete it after first login)');
    } else {
      logger.info('created initial "root" administrator from WHM_ADMIN_PASSWORD');
    }
  }
}
