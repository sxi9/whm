import { CapabilityError } from './errors.js';

// Programs each feature area needs. The dashboard shows what is installed and
// services raise CapabilityError (→ an install prompt in the UI) when a feature
// is used on a host that lacks its daemon.
export const CAPABILITY_BINARIES = {
  systemd: ['systemctl'],
  users: ['useradd', 'usermod', 'userdel', 'chpasswd'],
  quota: ['setquota', 'repquota', 'quotacheck'],
  apache: ['apache2ctl', 'apachectl', 'httpd'],
  nginx: ['nginx'],
  php: ['php', 'php-fpm'],
  bind: ['named', 'rndc', 'named-checkzone'],
  exim: ['exim', 'exim4', 'exiqgrep'],
  dovecot: ['dovecot', 'doveadm'],
  mysql: ['mysql', 'mysqld', 'mariadbd', 'mysqlcheck', 'mysqldump'],
  postgres: ['psql', 'pg_dump'],
  ftp: ['pure-ftpd', 'proftpd', 'vsftpd', 'pure-pw'],
  ssl: ['openssl'],
  acme: ['certbot', 'acme.sh'],
  firewall: ['iptables', 'nft', 'ufw', 'firewall-cmd'],
  rsync: ['rsync'],
  rclone: ['rclone'],
  tar: ['tar'],
  spamassassin: ['spamd', 'spamassassin'],
  modsecurity: [],
  pkg: ['apt-get', 'dnf', 'yum'],
  perl: ['perl', 'cpan', 'cpanm'],
  mailman: ['mailman'],
};

// Features that ship no program of their own are detected by the files their
// package installs, through the agent's fs.stat (sys.binaries only knows
// names on PATH). ModSecurity is an Apache module: these are the files
// sec.modsec.detect reads on Debian (security2.load, /etc/modsecurity) and
// on the RHEL family (mod_security.conf, modsecurity.d); all lie under the
// agent's allowed roots.
export const CAPABILITY_PATHS = {
  modsecurity: ['/etc/apache2/mods-available/security2.load', '/etc/modsecurity/modsecurity.conf', '/etc/httpd/conf.d/mod_security.conf', '/etc/httpd/modsecurity.d'],
};

// A capability is "installed" when at least one of its *required* programs
// exists, or one of its paths does.
const REQUIRED = {
  apache: ['apache2ctl', 'apachectl', 'httpd'],
  bind: ['named'],
  exim: ['exim', 'exim4'],
  dovecot: ['dovecot'],
  mysql: ['mysqld', 'mariadbd', 'mysql'],
  postgres: ['psql'],
  ftp: ['pure-ftpd', 'proftpd', 'vsftpd'],
  acme: ['certbot', 'acme.sh'],
  firewall: ['iptables', 'nft', 'ufw', 'firewall-cmd'],
  pkg: ['apt-get', 'dnf', 'yum'],
  spamassassin: ['spamd', 'spamassassin'],
  php: ['php'],
  perl: ['perl'],
};

// A service row's unit candidate may be a glob (php*-fpm): Debian/Ubuntu
// version the PHP-FPM unit name (php8.4-fpm on Debian 13) and the stored row
// cannot list every release. Exact names resolve in the order given; a glob
// resolves to the newest of the units it matches (8.10 sorts after 8.4).
const globToRegExp = (glob) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
export function resolveUnit(candidates, present) {
  for (const candidate of candidates) {
    if (!candidate.includes('*')) {
      if (present.has(candidate)) return candidate;
      continue;
    }
    const re = globToRegExp(candidate);
    const matches = [...present].filter((u) => re.test(u)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (matches.length) return matches[0];
  }
  return null;
}

export function createCapabilities({ agent, db, logger }) {
  let snapshot = { at: 0, binaries: {}, paths: {}, capabilities: {}, units: {} };

  async function refresh() {
    const names = [...new Set(Object.values(CAPABILITY_BINARIES).flat())];
    const binaries = {};
    // sys.binaries accepts at most 100 names per call and categories keep registering more.
    for (let i = 0; i < names.length; i += 100) Object.assign(binaries, await agent.op('sys.binaries', { names: names.slice(i, i + 100) }));
    const paths = {};
    for (const p of [...new Set(Object.values(CAPABILITY_PATHS).flat())]) {
      try { paths[p] = Boolean((await agent.op('fs.stat', { path: p }))?.exists); } catch (err) {
        paths[p] = false;
        logger.debug({ err, path: p }, 'capability path probe failed');
      }
    }
    const capabilities = {};
    for (const [cap, bins] of Object.entries(CAPABILITY_BINARIES)) {
      const required = REQUIRED[cap] || bins;
      const capPaths = CAPABILITY_PATHS[cap] || [];
      capabilities[cap] = {
        installed: required.some((b) => binaries[b]) || capPaths.some((p) => paths[p]),
        binaries: Object.fromEntries(bins.map((b) => [b, Boolean(binaries[b])])),
        ...(capPaths.length ? { paths: Object.fromEntries(capPaths.map((p) => [p, Boolean(paths[p])])) } : {}),
      };
    }
    const units = {};
    try {
      const present = new Set(await agent.op('svc.list_units'));
      for (const row of db.prepare('SELECT name, unit_candidates FROM services').all()) {
        units[row.name] = resolveUnit(JSON.parse(row.unit_candidates), present);
      }
    } catch (err) {
      logger.warn({ err }, 'could not list systemd units');
    }
    snapshot = { at: Date.now(), binaries, paths, capabilities, units };
    logger.info({ installed: Object.entries(capabilities).filter(([, v]) => v.installed).map(([k]) => k) }, 'capability detection complete');
    return snapshot;
  }

  return {
    refresh,
    // Category modules declare the programs their feature needs; detection picks
    // them up on the next refresh (boot refreshes after all modules register).
    register(cap, { binaries, required, paths }) {
      CAPABILITY_BINARIES[cap] = binaries;
      REQUIRED[cap] = required || binaries;
      if (paths) CAPABILITY_PATHS[cap] = paths;
      snapshot.at = 0;
    },
    snapshot: () => snapshot,
    has: (cap) => Boolean(snapshot.capabilities[cap]?.installed),
    unitFor: (serviceName) => snapshot.units[serviceName] ?? null,
    require(cap, detail) {
      if (!snapshot.capabilities[cap]?.installed) throw new CapabilityError(cap, detail);
    },
    async ensureFresh(maxAgeMs = 5 * 60 * 1000) {
      if (Date.now() - snapshot.at > maxAgeMs) await refresh();
      return snapshot;
    },
  };
}
