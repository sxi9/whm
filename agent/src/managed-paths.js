// Exact paths the runtime installers may write, shared by lib.js (allowed roots) and ops/pkg.js.
// This module imports nothing: ops/index.js awaits every op module at top level, so an op module
// must never import lib.js (which imports ops/index.js) or the agent deadlocks at start.
export const NODE_LINK_MAJORS = { min: 16, max: 30 };
export const NODE_LINK_PATHS = Array.from({ length: NODE_LINK_MAJORS.max - NODE_LINK_MAJORS.min + 1 }, (_, i) => NODE_LINK_MAJORS.min + i).flatMap((m) => ['node', 'npm', 'npx'].map((n) => `/usr/local/bin/${n}${m}`));
// PHP minors the source builder (pkg.php.build) may produce; the unit file and the CLI link of each are exact allowed paths.
export const PHP_MINORS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '9.0', '9.1'];
export const PHP_UNIT_PATHS = PHP_MINORS.map((m) => `/etc/systemd/system/keel-php${m}-fpm.service`);
export const PHP_LINK_PATHS = PHP_MINORS.map((m) => `/usr/local/bin/php${m}`);
// Where a local PostgreSQL keeps pg_hba.conf (Debian clusters, RHEL data directories); db.pg.hba.write edits it in place.
export const PG_HBA_ROOTS = ['/etc/postgresql', '/var/lib/pgsql'];
// Where the account panel's terminal bridges (term.*) keep their unix sockets: one directory per session below it.
export const TERM_RUN_DIR = '/run/whm/term';
// Radicale (CalDAV/CardDAV, dav.*): the distro config file, the panel's htpasswd directory under /etc/whm and the
// collections store; lib.js adds the two roots outside /etc/whm to the allowed list.
export const RADICALE = Object.freeze({ configDir: '/etc/radicale', config: '/etc/radicale/config', usersDir: '/etc/radicale', users: '/etc/radicale/users', storage: '/var/lib/radicale/collections', unit: 'radicale', user: 'radicale', group: 'radicale', host: '127.0.0.1', port: 5232, packages: ['radicale', 'python3-bcrypt'] });
export const RADICALE_ROOTS = ['/etc/radicale', '/var/lib/radicale'];
