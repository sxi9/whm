import path from 'node:path';
import { catalog, runOp, listOps, OpError } from './ops/index.js';
import { exec, hasBinary, resolveBinary, ExecError } from './exec.js';

// Paths the agent may read or write. Everything the panel manages lives under one
// of these; anything else is refused even for root. Operators can extend the list
// in the agent config, never the API.
export const DEFAULT_ALLOWED_ROOTS = [
  '/home', '/var/lib/whm', '/etc/whm', '/var/log/whm',
  '/etc/apache2', '/etc/httpd', '/etc/nginx', '/var/www',
  '/etc/bind', '/var/named', '/var/lib/bind', '/var/cache/bind',
  '/etc/exim', '/etc/exim4', '/etc/dovecot', '/var/spool/exim', '/var/spool/exim4', '/var/log/exim', '/var/log/exim4', '/var/log/mail.log',
  '/etc/mysql', '/etc/my.cnf', '/etc/my.cnf.d', '/var/lib/mysql-files',
  '/etc/pure-ftpd', '/etc/proftpd', '/etc/vsftpd.conf',
  '/etc/ssl/whm', '/etc/letsencrypt', '/etc/pki/tls/whm',
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
