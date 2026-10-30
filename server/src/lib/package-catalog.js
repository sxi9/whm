// What a hosting server actually installs, as a curated list the Install Distro
// Packages page opens on (a repository search for "php" answers with a thousand
// near-identical names; this is the genuine list). One entry per piece of
// software with the real package names of both families. Entries that are also
// stack components (server/src/lib/stack-catalog.js) link to them with `stack`
// and take their packages, capability, units and repository notes from there,
// so a package list is never maintained twice.
//
// PHP extensions carry `php: { debian, rhel }` suffixes instead of fixed names:
// the Software service expands them per installed PHP version (php8.3-redis,
// php83-php-pecl-redis, ea-php83-php-pecl-redis, php-pecl-redis) and falls back
// to the distribution's unversioned meta-package when no PHP is installed yet.
import { componentByKey } from './stack-catalog.js';

const EPEL = 'Needs the EPEL repository on RHEL, AlmaLinux and Rocky (dnf install epel-release) before this package resolves.';
const REMI = 'On the RHEL family the versioned PHP extension packages come from Remi\'s repository; the stock php-* names cover the system PHP.';

export const PACKAGE_GROUPS = [
  { key: 'web', label: 'Web', description: 'The web server, its modules and the TLS tooling in front of every site.' },
  { key: 'php', label: 'PHP extensions', description: 'The PHP runtime and the extensions web applications ask for, per installed PHP version.' },
  { key: 'databases', label: 'Databases', description: 'Database servers, caches and the web front-ends accounts use.' },
  { key: 'mail', label: 'Mail', description: 'SMTP, mailbox access, spam and virus filtering, webmail.' },
  { key: 'security', label: 'Security', description: 'Brute-force protection, the web application firewall, rootkit and audit scanners.' },
  { key: 'tools', label: 'Tools', description: 'Version control, archivers, media libraries and language toolchains that applications depend on.' },
  { key: 'monitoring', label: 'Monitoring', description: 'Process, disk, I/O and network observation for the server itself.' },
];

export const PACKAGE_CATALOG = [
  // --- Web -------------------------------------------------------------------
  { key: 'apache', category: 'web', stack: 'apache', recommended: true, configure: '/service-configuration/apache-configuration' },
  { key: 'apache-utils', category: 'web', label: 'Apache utilities (htpasswd, ab, rotatelogs)', description: 'Command-line helpers that ship beside the web server: password files for protected directories, the ab benchmark and log rotation.', packages: { debian: ['apache2-utils'], rhel: ['httpd-tools'] }, recommended: true },
  { key: 'apache-mod-fcgid', category: 'web', label: 'Apache mod_fcgid', description: 'FastCGI process manager for CGI applications and the older PHP handler path.', packages: { debian: ['libapache2-mod-fcgid'], rhel: ['mod_fcgid'] }, recommended: false },
  { key: 'apache-mod-evasive', category: 'web', label: 'Apache mod_evasive', description: 'Blocks clients that hammer one page or the whole site (HTTP DoS mitigation).', packages: { debian: ['libapache2-mod-evasive'], rhel: ['mod_evasive'] }, requires: { rhel: EPEL }, recommended: false },
  { key: 'apache-mod-wsgi', category: 'web', label: 'Apache mod_wsgi (Python 3)', description: 'Serves Python WSGI applications directly from Apache.', packages: { debian: ['libapache2-mod-wsgi-py3'], rhel: ['python3-mod_wsgi'] }, recommended: false },
  { key: 'nginx', category: 'web', stack: 'nginx', recommended: false, configure: '/software/nginx-manager' },
  { key: 'certbot', category: 'web', stack: 'acme', recommended: true, configure: '/ssl-tls/manage-autossl' },
  { key: 'varnish', category: 'web', label: 'Varnish Cache', description: 'HTTP accelerator for sites that need a full-page cache in front of Apache.', packages: { debian: ['varnish'], rhel: ['varnish'] }, requires: { rhel: EPEL }, recommended: false },

  // --- PHP -------------------------------------------------------------------
  { key: 'php', category: 'php', stack: 'php', recommended: true, configure: '/software/multiphp-manager' },
  { key: 'php-pecl-tools', category: 'php', label: 'PECL / PEAR build tools', description: 'pecl, pear and the PHP headers needed to build extensions that the distribution does not package (Software › Module Installers).', packages: { debian: ['php-pear', 'php-dev'], rhel: ['php-pear', 'php-devel'] }, recommended: false, configure: '/software/module-installers' },
  { key: 'php-mysql', category: 'php', label: 'MySQL / MariaDB driver', description: 'mysqli and PDO_MySQL; WordPress, Joomla and nearly every PHP application need it.', php: { debian: 'mysql', rhel: 'mysqlnd' }, recommended: true },
  { key: 'php-pgsql', category: 'php', label: 'PostgreSQL driver', description: 'pgsql and PDO_PgSQL for applications on PostgreSQL.', php: { debian: 'pgsql', rhel: 'pgsql' }, recommended: false },
  { key: 'php-sqlite3', category: 'php', label: 'SQLite driver', description: 'sqlite3 and PDO_SQLite for file-based databases (Nextcloud installs, small apps).', php: { debian: 'sqlite3', rhel: 'pdo' }, recommended: false },
  { key: 'php-curl', category: 'php', label: 'cURL', description: 'Outgoing HTTP from PHP: update checks, payment gateways, REST clients.', php: { debian: 'curl', rhel: 'common' }, recommended: true },
  { key: 'php-gd', category: 'php', label: 'GD image library', description: 'Thumbnails, image resizing and captchas; WordPress media needs GD or Imagick.', php: { debian: 'gd', rhel: 'gd' }, recommended: true },
  { key: 'php-imagick', category: 'php', label: 'Imagick (ImageMagick binding)', description: 'Higher-quality image processing than GD; recommended by WordPress and Nextcloud.', php: { debian: 'imagick', rhel: 'pecl-imagick' }, requires: { rhel: REMI }, recommended: true },
  { key: 'php-mbstring', category: 'php', label: 'Multibyte strings', description: 'UTF-8 string functions; required by most frameworks.', php: { debian: 'mbstring', rhel: 'mbstring' }, recommended: true },
  { key: 'php-xml', category: 'php', label: 'XML, DOM and SimpleXML', description: 'XML parsing for feeds, sitemaps, SOAP and composer packages.', php: { debian: 'xml', rhel: 'xml' }, recommended: true },
  { key: 'php-zip', category: 'php', label: 'Zip', description: 'Reads and writes zip archives: plugin and theme uploads, exports.', php: { debian: 'zip', rhel: 'pecl-zip' }, recommended: true },
  { key: 'php-intl', category: 'php', label: 'Internationalisation (intl)', description: 'Locale-aware formatting, transliteration and IDN; Magento, Drupal and Symfony need it.', php: { debian: 'intl', rhel: 'intl' }, recommended: true },
  { key: 'php-bcmath', category: 'php', label: 'BCMath', description: 'Arbitrary-precision arithmetic used by shops and payment libraries.', php: { debian: 'bcmath', rhel: 'bcmath' }, recommended: true },
  { key: 'php-gmp', category: 'php', label: 'GMP', description: 'Big-number arithmetic for cryptography libraries and some licence checks.', php: { debian: 'gmp', rhel: 'gmp' }, recommended: false },
  { key: 'php-soap', category: 'php', label: 'SOAP', description: 'SOAP clients and servers for shipping, tax and ERP integrations.', php: { debian: 'soap', rhel: 'soap' }, recommended: false },
  { key: 'php-ldap', category: 'php', label: 'LDAP', description: 'Directory authentication for intranet applications.', php: { debian: 'ldap', rhel: 'ldap' }, recommended: false },
  { key: 'php-imap', category: 'php', label: 'IMAP', description: 'Mailbox access from PHP (webmail, ticket systems that read mail).', php: { debian: 'imap', rhel: 'imap' }, requires: { rhel: REMI }, recommended: false },
  { key: 'php-tidy', category: 'php', label: 'Tidy', description: 'HTML clean-up for editors and exporters.', php: { debian: 'tidy', rhel: 'tidy' }, recommended: false },
  { key: 'php-xsl', category: 'php', label: 'XSL', description: 'XSLT transformations (feeds, document conversion).', php: { debian: 'xsl', rhel: 'xml' }, recommended: false },
  { key: 'php-opcache', category: 'php', label: 'OPcache', description: 'Bytecode cache; the single biggest PHP speed-up. Built into PHP 8.5 and later, where the package no longer exists.', php: { debian: 'opcache', rhel: 'opcache' }, recommended: true },
  { key: 'php-apcu', category: 'php', label: 'APCu', description: 'In-process user cache that WordPress object-cache plugins and Nextcloud use.', php: { debian: 'apcu', rhel: 'pecl-apcu' }, requires: { rhel: REMI }, recommended: true },
  { key: 'php-redis', category: 'php', label: 'Redis client', description: 'phpredis for session storage and object caches backed by Redis.', php: { debian: 'redis', rhel: 'pecl-redis' }, requires: { rhel: REMI }, recommended: true },
  { key: 'php-memcached', category: 'php', label: 'Memcached client', description: 'libmemcached binding for Memcached-backed caches.', php: { debian: 'memcached', rhel: 'pecl-memcached' }, requires: { rhel: REMI }, recommended: false },
  { key: 'php-igbinary', category: 'php', label: 'igbinary serializer', description: 'Compact serialisation used by the Redis and Memcached clients.', php: { debian: 'igbinary', rhel: 'pecl-igbinary' }, requires: { rhel: REMI }, recommended: false },
  { key: 'php-msgpack', category: 'php', label: 'MessagePack serializer', description: 'Alternative serialiser for the Redis and Memcached clients.', php: { debian: 'msgpack', rhel: 'pecl-msgpack' }, requires: { rhel: REMI }, recommended: false },

  // --- Databases ---------------------------------------------------------------
  { key: 'mariadb', category: 'databases', stack: 'mysql', recommended: true, configure: '/database-services/manage-databases' },
  { key: 'postgresql', category: 'databases', stack: 'postgres', recommended: false, configure: '/database-services/manage-database-profiles' },
  { key: 'redis', category: 'databases', label: 'Redis server', description: 'In-memory key-value store for object caches, sessions and queues.', packages: { debian: ['redis-server'], rhel: ['redis'] }, units: ['redis-server', 'redis'], recommended: true },
  { key: 'memcached', category: 'databases', label: 'Memcached', description: 'Simple distributed memory cache; the older alternative to Redis.', packages: { debian: ['memcached'], rhel: ['memcached'] }, units: ['memcached'], recommended: false },
  { key: 'phpmyadmin', category: 'databases', label: 'phpMyAdmin', description: 'Web interface for MariaDB that accounts reach from HST Panel.', packages: { debian: ['phpmyadmin'], rhel: ['phpMyAdmin'] }, requires: { rhel: EPEL }, recommended: true, configure: '/database-services/phpmyadmin' },
  { key: 'mysqltuner', category: 'databases', label: 'MySQLTuner', description: 'Reports configuration and sizing advice for the MariaDB server.', packages: { debian: ['mysqltuner'], rhel: ['mysqltuner'] }, requires: { rhel: EPEL }, recommended: false },

  // --- Mail --------------------------------------------------------------------
  { key: 'exim', category: 'mail', stack: 'exim', recommended: true, configure: '/service-configuration/exim-configuration-manager' },
  { key: 'dovecot', category: 'mail', stack: 'dovecot', recommended: true, configure: '/service-configuration/mailserver-configuration' },
  { key: 'spamassassin', category: 'mail', stack: 'spamassassin', recommended: true, configure: '/email/spamd-startup-configuration' },
  { key: 'clamav', category: 'mail', stack: 'clamav', recommended: false, configure: '/plugins/clamav-scanner' },
  { key: 'roundcube', category: 'mail', label: 'Roundcube webmail', description: 'Browser-based IMAP client for every mailbox on the server.', packages: { debian: ['roundcube', 'roundcube-mysql'], rhel: ['roundcubemail'] }, requires: { rhel: EPEL }, recommended: true },
  { key: 'mailman', category: 'mail', stack: 'mailman', recommended: false, configure: '/cpanel/reset-a-mailman-password' },

  // --- Security ----------------------------------------------------------------
  { key: 'fail2ban', category: 'security', stack: 'fail2ban', recommended: true, configure: '/security-center/cphulk-brute-force-protection' },
  { key: 'modsecurity', category: 'security', stack: 'modsecurity', recommended: true, configure: '/security-center/modsecurity-configuration' },
  { key: 'firewall', category: 'security', stack: 'firewall', recommended: true, configure: '/security-center/host-access-control' },
  { key: 'rkhunter', category: 'security', label: 'Rootkit Hunter', description: 'Scans for rootkits, backdoors and suspicious file changes.', packages: { debian: ['rkhunter'], rhel: ['rkhunter'] }, requires: { rhel: EPEL }, recommended: true },
  { key: 'lynis', category: 'security', label: 'Lynis', description: 'Security audit of the whole system with a hardening score and advice.', packages: { debian: ['lynis'], rhel: ['lynis'] }, requires: { rhel: EPEL }, recommended: false },
  { key: 'aide', category: 'security', label: 'AIDE file integrity', description: 'Baseline of system files and a report of anything that changed.', packages: { debian: ['aide'], rhel: ['aide'] }, recommended: false },

  // --- Tools -------------------------------------------------------------------
  { key: 'git', category: 'tools', stack: 'git', recommended: true },
  { key: 'rsync', category: 'tools', stack: 'rsync', recommended: true, configure: '/backup/backup-configuration' },
  { key: 'archivers', category: 'tools', label: 'Archive tools (zip, unzip, bzip2, xz)', description: 'What backups, application installers and site migrations unpack with.', packages: { debian: ['zip', 'unzip', 'bzip2', 'xz-utils'], rhel: ['zip', 'unzip', 'bzip2', 'xz'] }, recommended: true },
  { key: 'imagemagick', category: 'tools', label: 'ImageMagick', description: 'Image conversion suite behind the Imagick PHP extension and many CMS media pipelines.', packages: { debian: ['imagemagick'], rhel: ['ImageMagick'] }, requires: { rhel: EPEL }, recommended: true },
  { key: 'ghostscript', category: 'tools', label: 'Ghostscript', description: 'PDF and PostScript rendering for thumbnails and document previews.', packages: { debian: ['ghostscript'], rhel: ['ghostscript'] }, recommended: false },
  { key: 'ffmpeg', category: 'tools', label: 'FFmpeg', description: 'Audio and video transcoding for media uploads. EPEL ships the ffmpeg-free build; the full codec set is in RPM Fusion.', packages: { debian: ['ffmpeg'], rhel: ['ffmpeg-free'] }, requires: { rhel: EPEL }, recommended: false },
  { key: 'wkhtmltopdf', category: 'tools', label: 'wkhtmltopdf', description: 'Renders HTML to PDF for invoices and reports.', packages: { debian: ['wkhtmltopdf'], rhel: ['wkhtmltopdf'] }, requires: { rhel: EPEL }, recommended: false },
  { key: 'nodejs', category: 'tools', stack: 'node', recommended: false, configure: '/application-manager/application-manager' },
  { key: 'python', category: 'tools', stack: 'python', recommended: false, configure: '/application-manager/application-manager' },
  { key: 'ruby', category: 'tools', label: 'Ruby + gem', description: 'Ruby interpreter and headers so gems with native parts build (Software › Module Installers).', packages: { debian: ['ruby', 'ruby-dev'], rhel: ['ruby', 'ruby-devel'] }, recommended: false, configure: '/software/module-installers' },
  { key: 'cpanminus', category: 'tools', label: 'cpanminus (Perl modules)', description: 'Non-interactive CPAN client used by Install a Perl Module.', packages: { debian: ['cpanminus'], rhel: ['perl-App-cpanminus'] }, recommended: false, configure: '/software/install-a-perl-module' },
  { key: 'build-tools', category: 'tools', label: 'Compiler toolchain', description: 'gcc, make and pkg-config for PECL extensions, gems and pip packages that compile native code.', packages: { debian: ['build-essential', 'pkg-config'], rhel: ['gcc', 'gcc-c++', 'make', 'pkgconf-pkg-config'] }, recommended: false, configure: '/security-center/compiler-access' },
  { key: 'curl-wget', category: 'tools', label: 'curl and wget', description: 'Command-line downloaders that installers and cron jobs call.', packages: { debian: ['curl', 'wget'], rhel: ['curl', 'wget'] }, recommended: true },
  { key: 'tmux', category: 'tools', label: 'tmux', description: 'Terminal multiplexer for long sessions in Terminal and over SSH.', packages: { debian: ['tmux'], rhel: ['tmux'] }, recommended: false },

  // --- Monitoring --------------------------------------------------------------
  { key: 'htop', category: 'monitoring', label: 'htop', description: 'Interactive process viewer.', packages: { debian: ['htop'], rhel: ['htop'] }, requires: { rhel: EPEL }, recommended: true },
  { key: 'iotop', category: 'monitoring', label: 'iotop', description: 'Which processes are generating disk I/O.', packages: { debian: ['iotop'], rhel: ['iotop'] }, recommended: true },
  { key: 'sysstat', category: 'monitoring', label: 'sysstat (sar, iostat, mpstat)', description: 'Historical CPU, memory, disk and network counters collected every few minutes.', packages: { debian: ['sysstat'], rhel: ['sysstat'] }, units: ['sysstat'], recommended: true },
  { key: 'netdata', category: 'monitoring', label: 'Netdata', description: 'Real-time per-second dashboards for the whole host.', packages: { debian: ['netdata'], rhel: ['netdata'] }, requires: { rhel: EPEL }, units: ['netdata'], recommended: false },
  { key: 'iftop-nethogs', category: 'monitoring', label: 'iftop and nethogs', description: 'Live bandwidth by connection and by process.', packages: { debian: ['iftop', 'nethogs'], rhel: ['iftop', 'nethogs'] }, requires: { rhel: EPEL }, recommended: false },
  { key: 'smartmontools', category: 'monitoring', label: 'smartmontools', description: 'S.M.A.R.T. disk health checks and failure warnings.', packages: { debian: ['smartmontools'], rhel: ['smartmontools'] }, recommended: false },
  { key: 'logwatch', category: 'monitoring', label: 'Logwatch', description: 'Daily digest of the system logs by mail.', packages: { debian: ['logwatch'], rhel: ['logwatch'] }, recommended: false },
  { key: 'ncdu', category: 'monitoring', label: 'ncdu', description: 'Finds what fills the disk, directory by directory.', packages: { debian: ['ncdu'], rhel: ['ncdu'] }, requires: { rhel: EPEL }, recommended: false },
];

export const PACKAGE_FAMILIES = ['debian', 'rhel'];
export const PACKAGE_GROUP_KEYS = PACKAGE_GROUPS.map((g) => g.key);

// An entry with its stack component folded in (packages, capability, units,
// repository notes, label and description unless the entry overrides them).
export function resolveEntry(entry) {
  const component = entry.stack ? componentByKey(entry.stack) : null;
  if (entry.stack && !component) throw new Error(`package catalog entry "${entry.key}" links to unknown stack component "${entry.stack}"`);
  const packages = entry.php
    ? { debian: [`php-${entry.php.debian}`], rhel: [`php-${entry.php.rhel}`] }
    : { debian: [...(entry.packages?.debian ?? component?.packages?.debian ?? [])], rhel: [...(entry.packages?.rhel ?? component?.packages?.rhel ?? [])] };
  return {
    key: entry.key, category: entry.category,
    label: entry.label ?? component?.label ?? entry.key, description: entry.description ?? component?.description ?? '',
    recommended: Boolean(entry.recommended), stack: entry.stack ?? null, capability: component?.capability ?? null, service: component?.service ?? null,
    units: entry.units ?? component?.units ?? [], requires: { ...(component?.requires ?? {}), ...(entry.requires ?? {}) },
    php: entry.php ? { ...entry.php } : null, packages, configure: entry.configure ?? null,
  };
}

let resolved = null;
export function catalogEntries() {
  if (!resolved) resolved = PACKAGE_CATALOG.map(resolveEntry);
  return resolved;
}

export const entryByKey = (key) => catalogEntries().find((e) => e.key === key) || null;
export const groupByKey = (key) => PACKAGE_GROUPS.find((g) => g.key === key) || null;

// The package of one PHP extension for one installed PHP version, from the
// prefix the agent's discoverPhp() reports: php8.3- (Debian), php83-php- (Remi),
// ea-php83-php- (EA4), rh-php83-php- (SCL) or php- (the RHEL system PHP).
export function phpExtensionPackage(entry, version, family) {
  if (!entry?.php) return null;
  const layout = version?.layout || 'unknown';
  const prefix = version?.packagePrefix || (layout === 'debian' ? `php${version.id}-` : 'php-');
  const debianNames = layout === 'debian' || (layout === 'unknown' && family === 'debian');
  return `${prefix}${debianNames ? entry.php.debian : entry.php.rhel}`;
}

// Package names an install of `entry` means on one family; for PHP extensions
// the per-version names when versions are given, else the unversioned ones.
export function packagesFor(entry, family, { phpVersions = [] } = {}) {
  if (!entry || !PACKAGE_FAMILIES.includes(family)) return [];
  if (entry.php && phpVersions.length) return [...new Set(phpVersions.map((v) => phpExtensionPackage(entry, v, family)).filter(Boolean))];
  return [...entry.packages[family]];
}

// Case-insensitive match on key, label, description and package names.
export function matchesEntry(entry, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  const names = [...entry.packages.debian, ...entry.packages.rhel, entry.key, entry.label, entry.description, entry.stack || ''];
  return names.some((n) => String(n).toLowerCase().includes(needle));
}
