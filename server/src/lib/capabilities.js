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
  tar: ['tar'],
  spamassassin: ['spamd', 'spamassassin'],
  modsecurity: ['modsecurity'],
  pkg: ['apt-get', 'dnf', 'yum'],
  perl: ['perl', 'cpan', 'cpanm'],
  mailman: ['mailman'],
};

// A capability is "installed" when at least one of its *required* programs exists.
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

// Debian/Ubuntu ship one unit per PHP branch (php8.5-fpm) and new branches
// appear faster than a seeded candidate list can follow; when no listed
// candidate exists the newest php<major>.<minor>-fpm unit on the host is used.
const UNIT_PATTERNS = { 'php-fpm': /^php(\d+)\.(\d+)-fpm$/ };

export function newestUnitMatching(pattern, present) {
  const found = [...present].map((u) => u.match(pattern)).filter(Boolean)
    .sort((a, b) => (Number(b[1]) - Number(a[1])) || (Number(b[2]) - Number(a[2])));
  return found[0]?.[0] ?? null;
}

export function resolveUnit(name, candidates, present) {
  const listed = candidates.find((u) => present.has(u));
  if (listed) return listed;
  const pattern = UNIT_PATTERNS[name];
  return pattern ? newestUnitMatching(pattern, present) : null;
}

export function createCapabilities({ agent, db, logger }) {
  let snapshot = { at: 0, binaries: {}, capabilities: {}, units: {} };

  async function refresh() {
    const names = [...new Set(Object.values(CAPABILITY_BINARIES).flat())];
    const binaries = {};
    // sys.binaries accepts at most 100 names per call and categories keep registering more.
    for (let i = 0; i < names.length; i += 100) Object.assign(binaries, await agent.op('sys.binaries', { names: names.slice(i, i + 100) }));
    const capabilities = {};
    for (const [cap, bins] of Object.entries(CAPABILITY_BINARIES)) {
      const required = REQUIRED[cap] || bins;
      capabilities[cap] = { installed: required.some((b) => binaries[b]), binaries: Object.fromEntries(bins.map((b) => [b, Boolean(binaries[b])])) };
    }
    const units = {};
    try {
      const present = new Set(await agent.op('svc.list_units'));
      for (const row of db.prepare('SELECT name, unit_candidates FROM services').all()) {
        units[row.name] = resolveUnit(row.name, JSON.parse(row.unit_candidates), present);
      }
    } catch (err) {
      logger.warn({ err }, 'could not list systemd units');
    }
    snapshot = { at: Date.now(), binaries, capabilities, units };
    logger.info({ installed: Object.entries(capabilities).filter(([, v]) => v.installed).map(([k]) => k) }, 'capability detection complete');
    return snapshot;
  }

  return {
    refresh,
    // Category modules declare the programs their feature needs; detection picks
    // them up on the next refresh (boot refreshes after all modules register).
    register(cap, { binaries, required }) {
      CAPABILITY_BINARIES[cap] = binaries;
      REQUIRED[cap] = required || binaries;
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
