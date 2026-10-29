// The software a hosting server runs, as the panel can install it through the
// host's package manager. One entry per capability/service: the distribution
// packages for both families, the systemd unit candidates, the capability the
// detection layer reports it under, the Service Manager row it maps to and the
// steps that follow an install. `requires` carries a note (EPEL on the RHEL
// family) when the packages are not in the base repositories.
//
// postInstall kinds:
//   { kind: 'a2enmod', modules: [...] }  → agent op stack.apache_enmod (Debian family only; RHEL loads modules from conf.modules.d)
//   { kind: 'enable', unit?, units? }    → agent op svc.enable on the first existing unit (the component's own candidates when none is given)
const EPEL = 'Needs the EPEL repository on RHEL, AlmaLinux and Rocky (dnf install epel-release) before this package resolves.';

export const STACK_COMPONENTS = [
  {
    key: 'apache', label: 'Apache HTTP Server', capability: 'apache', service: 'httpd', recommended: true,
    description: 'The web server that serves every account; the panel writes its virtual hosts.',
    packages: { debian: ['apache2'], rhel: ['httpd', 'mod_ssl'] },
    units: ['apache2', 'httpd'],
    postInstall: [{ kind: 'a2enmod', modules: ['rewrite', 'headers', 'ssl', 'expires', 'proxy', 'proxy_fcgi', 'setenvif', 'suexec'] }, { kind: 'enable' }],
  },
  {
    key: 'php', label: 'PHP (PHP-FPM + common extensions)', capability: 'php', service: 'php-fpm', recommended: true,
    description: 'PHP-FPM with the extensions most web applications expect (MySQL, GD, mbstring, XML, zip, intl, bcmath, SOAP, opcache).',
    packages: {
      debian: ['php-fpm', 'php-cli', 'php-common', 'php-mysql', 'php-curl', 'php-gd', 'php-mbstring', 'php-xml', 'php-zip', 'php-intl', 'php-bcmath', 'php-soap', 'php-opcache'],
      rhel: ['php-fpm', 'php-cli', 'php-common', 'php-mysqlnd', 'php-gd', 'php-mbstring', 'php-xml', 'php-pdo', 'php-intl', 'php-bcmath', 'php-soap', 'php-opcache', 'php-pecl-zip'],
    },
    units: ['php-fpm', 'php8.4-fpm', 'php8.3-fpm', 'php8.2-fpm', 'php8.1-fpm'],
    postInstall: [{ kind: 'enable' }, { kind: 'a2enmod', modules: ['proxy', 'proxy_fcgi', 'setenvif'] }],
  },
  {
    key: 'nginx', label: 'NGINX (reverse proxy)', capability: 'nginx', service: 'nginx', recommended: false,
    description: 'Optional caching reverse proxy in front of Apache (Software › NGINX Manager).',
    packages: { debian: ['nginx'], rhel: ['nginx'] },
    units: ['nginx'],
    postInstall: [],
  },
  {
    key: 'mysql', label: 'MariaDB (MySQL) server', capability: 'mysql', service: 'mysql', recommended: true,
    description: 'Database server for account databases, phpMyAdmin and the Database Services category.',
    packages: { debian: ['mariadb-server', 'mariadb-client'], rhel: ['mariadb-server', 'mariadb'] },
    units: ['mariadb', 'mysql', 'mysqld'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'postgres', label: 'PostgreSQL server', capability: 'postgres', service: 'postgresql', recommended: false,
    description: 'PostgreSQL for accounts that need it. On the RHEL family run postgresql-setup --initdb before the service starts.',
    packages: { debian: ['postgresql', 'postgresql-contrib'], rhel: ['postgresql-server', 'postgresql-contrib'] },
    units: ['postgresql'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'bind', label: 'BIND DNS server', capability: 'bind', service: 'named', recommended: true,
    description: 'Authoritative DNS for every hosted domain (DNS Functions).',
    packages: { debian: ['bind9', 'bind9-utils', 'bind9-dnsutils'], rhel: ['bind', 'bind-utils'] },
    units: ['named', 'bind9'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'exim', label: 'Exim mail transfer agent', capability: 'exim', service: 'exim', recommended: true,
    description: 'Outgoing and incoming SMTP; the Email category, Contact Manager notifications and mail queue depend on it.',
    packages: { debian: ['exim4-daemon-heavy', 'exim4-config'], rhel: ['exim'] },
    requires: { rhel: EPEL },
    units: ['exim4', 'exim'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'dovecot', label: 'Dovecot IMAP/POP3 server', capability: 'dovecot', service: 'imap', recommended: true,
    description: 'Mailbox access over IMAP and POP3, LMTP delivery and Sieve filtering.',
    packages: { debian: ['dovecot-core', 'dovecot-imapd', 'dovecot-pop3d', 'dovecot-lmtpd', 'dovecot-sieve', 'dovecot-managesieved'], rhel: ['dovecot', 'dovecot-pigeonhole'] },
    units: ['dovecot'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'ftp', label: 'FTP server (Pure-FTPd)', capability: 'ftp', service: 'ftpd', recommended: true,
    description: 'FTP/FTPS access to account home directories.',
    packages: { debian: ['pure-ftpd'], rhel: ['pure-ftpd'] },
    requires: { rhel: EPEL },
    units: ['pure-ftpd', 'proftpd', 'vsftpd'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'spamassassin', label: 'SpamAssassin (spamd)', capability: 'spamassassin', service: 'spamd', recommended: true,
    description: 'Spam scoring for incoming mail (Email › Spamd Startup Configuration).',
    packages: { debian: ['spamassassin', 'spamc'], rhel: ['spamassassin'] },
    units: ['spamd', 'spamassassin'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'clamav', label: 'ClamAV antivirus', capability: 'clamav', service: null, recommended: false,
    description: 'Malware scanning for uploads and mail (Plugins › ClamAV Scanner).',
    packages: { debian: ['clamav', 'clamav-daemon', 'clamav-freshclam'], rhel: ['clamav', 'clamd', 'clamav-update'] },
    requires: { rhel: EPEL },
    units: ['clamav-daemon', 'clamd@scan', 'clamd'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'modsecurity', label: 'ModSecurity web application firewall (+ OWASP CRS)', capability: 'modsecurity', service: null, recommended: true,
    description: 'Apache request filtering with the OWASP Core Rule Set (Security Center › ModSecurity).',
    packages: { debian: ['libapache2-mod-security2', 'modsecurity-crs'], rhel: ['mod_security', 'mod_security_crs'] },
    requires: { rhel: EPEL },
    units: [],
    postInstall: [{ kind: 'a2enmod', modules: ['security2'] }],
  },
  {
    key: 'acme', label: 'Certbot (Let\'s Encrypt / ACME client)', capability: 'acme', service: null, recommended: true,
    description: 'Free TLS certificates for hosted domains and the panel (SSL/TLS › AutoSSL).',
    packages: { debian: ['certbot', 'python3-certbot-apache'], rhel: ['certbot', 'python3-certbot-apache'] },
    requires: { rhel: EPEL },
    units: [],
    postInstall: [],
  },
  {
    key: 'quota', label: 'Disk quota tools', capability: 'quota', service: null, recommended: true,
    description: 'Per-account disk limits (Server Configuration › Initial Quota Setup).',
    packages: { debian: ['quota'], rhel: ['quota'] },
    units: [],
    postInstall: [],
  },
  {
    key: 'firewall', label: 'Firewall (nftables / iptables)', capability: 'firewall', service: null, recommended: true,
    description: 'Packet filtering used by Host Access Control, cPHulk and the IP blocker.',
    packages: { debian: ['nftables', 'iptables'], rhel: ['nftables', 'iptables'] },
    units: ['nftables'],
    postInstall: [],
  },
  {
    key: 'awstats', label: 'AWStats', capability: 'awstats', service: null, recommended: true,
    description: 'Per-domain visitor, referrer and bandwidth statistics (Statistics Software Configuration).',
    packages: { debian: ['awstats'], rhel: ['awstats'] },
    requires: { rhel: EPEL },
    units: [],
    postInstall: [],
  },
  {
    key: 'webalizer', label: 'Webalizer', capability: 'webalizer', service: null, recommended: false,
    description: 'Fast incremental HTML usage reports.',
    packages: { debian: ['webalizer'], rhel: ['webalizer'] },
    requires: { rhel: EPEL },
    units: [],
    postInstall: [],
  },
  {
    key: 'analog', label: 'Analog', capability: 'analog', service: null, recommended: false,
    description: 'Compact log summary reports.',
    packages: { debian: ['analog'], rhel: ['analog'] },
    requires: { rhel: EPEL },
    units: [],
    postInstall: [],
  },
  {
    key: 'mailman', label: 'Mailman mailing lists', capability: 'mailman', service: 'mailman', recommended: false,
    description: 'GNU Mailman 3 for account mailing lists.',
    packages: { debian: ['mailman3-full'], rhel: ['mailman3'] },
    requires: { rhel: EPEL },
    units: ['mailman3', 'mailman'],
    postInstall: [{ kind: 'enable' }],
  },
  {
    key: 'rsync', label: 'rsync', capability: 'rsync', service: null, recommended: true,
    description: 'Incremental copies for backups and account transfers.',
    packages: { debian: ['rsync'], rhel: ['rsync'] },
    units: [],
    postInstall: [],
  },
  {
    key: 'git', label: 'Git', capability: 'git', service: null, recommended: true,
    description: 'Version control for deployments and the Application Manager.',
    packages: { debian: ['git'], rhel: ['git'] },
    units: [],
    postInstall: [],
  },
  {
    key: 'node', label: 'Node.js + npm', capability: 'node', service: null, recommended: false,
    description: 'Runtime for Node.js applications (Application Manager).',
    packages: { debian: ['nodejs', 'npm'], rhel: ['nodejs', 'npm'] },
    units: [],
    postInstall: [],
  },
  {
    key: 'python', label: 'Python 3 (+ venv, pip)', capability: 'python', service: null, recommended: false,
    description: 'Runtime for Python applications (Application Manager).',
    packages: { debian: ['python3', 'python3-venv', 'python3-pip'], rhel: ['python3', 'python3-pip'] },
    units: [],
    postInstall: [],
  },
  {
    key: 'fail2ban', label: 'Fail2ban', capability: 'fail2ban', service: null, recommended: true,
    description: 'Bans addresses that fail SSH, FTP or mail logins repeatedly.',
    packages: { debian: ['fail2ban'], rhel: ['fail2ban'] },
    requires: { rhel: EPEL },
    units: ['fail2ban'],
    postInstall: [{ kind: 'enable' }],
  },
];

export const STACK_PROFILES = [
  { key: 'full', label: 'Full hosting stack (recommended)', description: 'Web, PHP, MariaDB, DNS, mail (Exim, Dovecot, SpamAssassin), FTP, ModSecurity, Let\'s Encrypt, quotas, firewall, statistics, backups tooling and Fail2ban.', components: STACK_COMPONENTS.filter((c) => c.recommended).map((c) => c.key) },
  { key: 'web', label: 'Web + database only', description: 'Apache, PHP, MariaDB, Let\'s Encrypt, disk quotas and the firewall. Add mail, DNS or FTP later from Service Manager.', components: ['apache', 'php', 'mysql', 'acme', 'quota', 'firewall'] },
  { key: 'manual', label: 'Choose services', description: 'Pick the components yourself.', components: [] },
];

export const STACK_PROFILE_KEYS = STACK_PROFILES.map((p) => p.key);
export const STACK_COMPONENT_KEYS = STACK_COMPONENTS.map((c) => c.key);
export const PACKAGE_FAMILIES = ['debian', 'rhel'];

export const componentByKey = (key) => STACK_COMPONENTS.find((c) => c.key === key) || null;
export const componentForCapability = (cap) => STACK_COMPONENTS.find((c) => c.capability === cap) || null;
export const componentForService = (name) => STACK_COMPONENTS.find((c) => c.service === name) || null;
export const profileComponents = (key) => STACK_PROFILES.find((p) => p.key === key)?.components ?? null;
