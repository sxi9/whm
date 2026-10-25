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

export function createCapabilities({ agent, db, logger }) {
  let snapshot = { at: 0, binaries: {}, capabilities: {}, units: {} };

  async function refresh() {
    const names = [...new Set(Object.values(CAPABILITY_BINARIES).flat())];
    const binaries = await agent.op('sys.binaries', { names });
    const capabilities = {};
    for (const [cap, bins] of Object.entries(CAPABILITY_BINARIES)) {
      const required = REQUIRED[cap] || bins;
      capabilities[cap] = { installed: required.some((b) => binaries[b]), binaries: Object.fromEntries(bins.map((b) => [b, Boolean(binaries[b])])) };
    }
    const units = {};
    try {
      const present = new Set(await agent.op('svc.list_units'));
      for (const row of db.prepare('SELECT name, unit_candidates FROM services').all()) {
        units[row.name] = JSON.parse(row.unit_candidates).find((u) => present.has(u)) || null;
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
