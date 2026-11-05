import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, runOp, listOps, OpError } from './ops/index.js';
import { exec, hasBinary, resolveBinary, ExecError } from './exec.js';

// <tree>/deploy/<app> of the tree this agent runs from (agent/src/lib.js → ../../deploy).
const deployDirOf = (app) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', app);

// Paths the agent may read or write. Everything the panel manages lives under one
// of these; anything else is refused even for root. Operators can extend the list
// in the agent config, never the API.
export const NODE_LINK_MAJORS = { min: 16, max: 30 };
export const NODE_LINK_PATHS = Array.from({ length: NODE_LINK_MAJORS.max - NODE_LINK_MAJORS.min + 1 }, (_, i) => NODE_LINK_MAJORS.min + i).flatMap((m) => ['node', 'npm', 'npx'].map((n) => `/usr/local/bin/${n}${m}`));
// PHP minors the source builder (pkg.php.build) may produce; the unit file and the CLI link of each are exact allowed paths.
export const PHP_MINORS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '9.0', '9.1'];
export const PHP_UNIT_PATHS = PHP_MINORS.map((m) => `/etc/systemd/system/keel-php${m}-fpm.service`);
export const PHP_LINK_PATHS = PHP_MINORS.map((m) => `/usr/local/bin/php${m}`);

export const DEFAULT_ALLOWED_ROOTS = [
  '/home', '/var/lib/whm', '/etc/whm', '/var/log/whm',
  '/etc/apache2', '/etc/httpd', '/etc/nginx', '/var/www',
  '/etc/bind', '/var/named', '/var/lib/bind', '/var/cache/bind',
  '/etc/exim', '/etc/exim4', '/etc/dovecot', '/var/spool/exim', '/var/spool/exim4', '/var/log/exim', '/var/log/exim4', '/var/log/mail.log',
  '/etc/mysql', '/etc/my.cnf', '/etc/my.cnf.d', '/var/lib/mysql-files',
  '/etc/pure-ftpd', '/etc/proftpd', '/etc/vsftpd.conf',
  '/etc/ssl/whm', '/etc/letsencrypt', '/etc/pki/tls/whm', '/etc/ssl/private/pure-ftpd.pem',
  '/etc/php', '/etc/opt/remi', '/etc/php-fpm.d',
  '/etc/hosts.allow', '/etc/hosts.deny', '/etc/hosts', '/etc/ssh/sshd_config', '/etc/ssh/sshd_config.d', '/root/.ssh',
  '/etc/security/limits.conf', '/etc/security/limits.d', '/etc/logrotate.d', '/etc/cron.d', '/var/spool/cron',
  '/var/log/apache2', '/var/log/httpd', '/var/log/nginx', '/var/log/syslog', '/var/log/messages', '/var/log/auth.log', '/var/log/secure',
  '/backup', '/var/backups/whm', '/tmp/whm',
  '/etc/named.conf', '/etc/named.whm.conf', '/etc/named',
  '/etc/modsecurity', '/var/log/modsec_audit.log', '/usr/share/modsecurity-crs',
  '/etc/systemd/system/whm-ips.service',
  '/root/.my.cnf',
  '/root/.acme.sh', '/var/log/letsencrypt',
  '/etc/default/spamassassin', '/etc/default/spamd', '/etc/sysconfig/spamassassin', '/etc/exim.conf', '/var/log/exim_mainlog', '/var/log/exim_rejectlog',
  '/opt/cpanel', '/etc/php.ini', '/etc/php.d', '/etc/opt/rh', '/var/run/reboot-required', '/var/run/reboot-required.pkgs',
  '/etc/vsftpd',
  '/usr/local/whm/hooks',
  '/etc/default/locale', '/etc/locale.conf',
  '/var/cache/nginx',
  '/home2', '/home3', '/home4', '/mnt/home', '/srv/home',
  '/etc/systemd/resolved.conf.d',
  '/etc/awstats',
  '/etc/aliases',
  '/etc/resolv.conf',
  '/var/cache/whm',
  // Curated repositories and side-by-side Node.js builds (pkg.repo.ensure, pkg.node.*).
  '/etc/apt/sources.list.d', '/etc/apt/keyrings', '/etc/yum.repos.d', '/opt/keel/node',
  // Only the versioned links the Node.js installer manages, never /usr/local/bin itself.
  ...NODE_LINK_PATHS,
  // PHP builds from source (pkg.php.build): the prefix tree, the FPM socket directory, and only the
  // per-minor unit files and php<minor> links, never /etc/systemd/system or /usr/local/bin themselves.
  '/opt/keel/php', '/run/keel-php',
  ...PHP_UNIT_PATHS,
  ...PHP_LINK_PATHS,
  // Web applications published under the server-hostname site (web.host.app.*) and their distro
  // configuration: Debian names, then the RHEL/Remi packages and the bare-tarball locations that
  // webmail.js WEBMAIL_CANDIDATES and db.js PMA_DIRS / PMA_CONFIGS probe (keep the lists in step).
  '/usr/share/roundcube', '/var/lib/roundcube', '/etc/roundcube', '/usr/share/phpmyadmin', '/var/lib/phpmyadmin', '/etc/phpmyadmin',
  '/usr/share/roundcubemail', '/etc/roundcubemail', '/usr/share/phpMyAdmin', '/etc/phpMyAdmin', '/opt/phpmyadmin', '/srv/phpmyadmin',
  '/usr/share/nginx/html/roundcube', '/usr/share/rainloop', '/usr/share/snappymail',
  // Keel-shipped application plugins copied into the published apps (web.webmail.plugin.install).
  '/opt/whm/deploy/roundcube',
  // The phpMyAdmin signon script, served as /keel under the hostname site (web.host.app.write reads the root).
  '/opt/whm/deploy/phpmyadmin',
  // The same two directories of the tree this agent runs from: the server resolves them from its own
  // location, so an APP_DIR other than /opt/whm (or a dev checkout) must agree with the agent.
  ...['roundcube', 'phpmyadmin'].map(deployDirOf).filter((p) => !p.startsWith('/opt/whm/')),
];

export function createContext({ allowedRoots = DEFAULT_ALLOWED_ROOTS, principal = null, log = () => {} } = {}) {
  const roots = allowedRoots.map((r) => path.resolve(r));
  return {
    principal,
    log,
    allowedRoots: roots,
    assertAllowedPath(p, mode = 'read') {
      const resolved = path.resolve(p);
      const ok = roots.some((root) => resolved === root || resolved.startsWith(root.endsWith('/') ? root : `${root}/`));
      if (!ok) throw new OpError('path_not_allowed', `Path "${p}" is outside the locations the agent may ${mode}`);
      return resolved;
    },
  };
}

// In-process execution for WHM_MODE=monolithic, and the implementation behind the
// socket daemon. Both paths validate against the same catalog.
export async function executeOp(name, args, ctxOptions = {}) {
  const ctx = ctxOptions.assertAllowedPath ? ctxOptions : createContext(ctxOptions);
  return runOp(name, args, ctx);
}

export { catalog, runOp, listOps, OpError, exec, hasBinary, resolveBinary, ExecError };
