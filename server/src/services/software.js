import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, forbidden, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot, ownsRow } from '../middleware/rbac.js';
import { RUNTIMES, TOOLS, RUNTIME_KEYS, PHP_SOURCE_PREFIX, PHP_SOURCE_MINORS, PHP_BUILD_DEPS, resolveInstall, packagesFor, runtimeNote, detectedVersion } from './software-runtimes.js';

// Software. Attached as ctx.software; other categories may call:
//   software.pkg.detect()                                   -> { manager: 'apt'|'dnf'|'yum'|null, family, rpm, capability }
//   software.pkg.isInstalled(names[])                       -> { name: boolean }
//   software.pkg.ensureInstalled(names[], { user, req })    -> { missing, job } (enqueues an install job when something is missing)
//   software.pkg.install(names[], user, req)                -> job (202 semantics)
//   software.php.versions()                                 -> { versions: [{ id, version, binary, iniPath, poolDir, fpmUnit, isDefault, advisories }], defaultId }
//   software.php.systemDefault()                            -> { configured, detected, effective }
//   software.php.versionForDomain(domain)                   -> { domain, phpVersion, effective, inherited } or null
//   software.php.setDomainVersion(domains[], version|null, user, req) -> { results, job } (job when more than one domain)
//   software.php.catalog()                                  -> every catalog + installed PHP version with state/offered/domains (contract §52)
//   software.php.offeredVersions()                          -> ids the account panel may pick, or null (= all installed)
//   software.php.usage()                                    -> { [versionId]: pinned-domain count }
//   software.php.remove(version, user, req, { force, packages }) -> { job, version } (refuses the system/CLI default, the last version, versions pinned on domains, plans, vhosts or the Apache web default;
//                                                              packages: true removes only the distribution packages a Keel build of the minor shadows)
//   software.nginx.status()                                 -> install + proxy state (never throws CapabilityError); stale: true when the
//                                                              rendered proxy no longer matches the current domains / certificates
//   software.nginx.sync(req)                                -> re-render the reverse-proxy config from current domains and certificates;
//                                                              { skipped: true } when the proxy is disabled, so SSL/TLS and Accounts
//                                                              should call ctx.software?.nginx.sync(req) after installing a certificate
//                                                              or creating / removing a domain (an hourly schedule, enabled only while
//                                                              the proxy is on, catches the rest)
// software.update.status({ cached })                      -> pending OS updates; cached: true serves the last recorded check
//   software.runtimes.catalog()                             -> one-click runtime/tool catalog with installed state (contract §51)
//   software.runtimes.install({ runtime, version } | { tool }, user, req) -> { job } (job type software.runtime.install)
//   software.updates.critical({ versions?, fresh?, releases? }) -> { checkedAt, packagesCheckedAt, releasesCheckedAt, items: [{ kind, id, label, current,
//                                                              candidate, severity, reasons, source, action }] } (contract §63; cached 10 min, never throws)
//   software.updates.refresh()                               -> the list recomputed after a fresh release lookup and, when the recorded OS check is older than 6 h, a new one
//   software.updates.rowUpdate(list, kind, id)               -> { candidate, severity, reasons, current, source, method, build, checkedAt } | null for a catalog row
//   software.php.update(version, user, req)                  -> { job, version, candidate, method } (job type software.php.update; 422 without a candidate;
//                                                              method 'source' builds php.net's release over a packaged minor with an advisory no package fixes and resyncs every domain on it)
//   software.runtimes.update({ runtime, version } | { tool }, user, req) -> { job } (job type software.runtime.update)
// Lazily used when present: ctx.web.setPhpVersion(domain, version, req, { reload }) (the 4th argument is advisory: the web category
// may skip the Apache reload until the last domain of a batch), ctx.web.setListenPorts({ http, https, bind }, req),
// ctx.web.apache.settings().defaultPhpVersion, ctx.ssl.certForDomain(domain) + ctx.ssl.bundlePaths(domain).
// Package-manager work runs as jobs; each agent call is a short request (the installer runs detached on the host and
// is polled through pkg.run.status), so a dist-upgrade or a PECL build never has to fit in one socket round trip.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BACKEND_BIND = '127.0.0.1';

export const BASIC_DIRECTIVES = [
  { key: 'allow_url_fopen', label: 'allow_url_fopen', type: 'bool', help: 'Let PHP open remote URLs with fopen()/file_get_contents().' },
  { key: 'allow_url_include', label: 'allow_url_include', type: 'bool', help: 'Let include/require load remote files. Keep off.' },
  { key: 'date.timezone', label: 'date.timezone', type: 'text', help: 'Default timezone, e.g. UTC or Europe/Berlin.' },
  { key: 'disable_functions', label: 'disable_functions', type: 'text', help: 'Comma-separated functions PHP refuses to run (exec, shell_exec, …).' },
  { key: 'display_errors', label: 'display_errors', type: 'bool', help: 'Print errors to the page. Off on production hosts.' },
  { key: 'enable_dl', label: 'enable_dl', type: 'bool', help: 'Allow dl() to load extensions at runtime.' },
  { key: 'error_log', label: 'error_log', type: 'text', help: 'File PHP writes errors to (empty = SAPI log).' },
  { key: 'error_reporting', label: 'error_reporting', type: 'text', help: 'e.g. E_ALL & ~E_DEPRECATED & ~E_STRICT' },
  { key: 'file_uploads', label: 'file_uploads', type: 'bool', help: 'Allow HTTP file uploads.' },
  { key: 'include_path', label: 'include_path', type: 'text', help: 'Directories searched by include/require.' },
  { key: 'log_errors', label: 'log_errors', type: 'bool', help: 'Log errors to error_log.' },
  { key: 'mail.add_x_header', label: 'mail.add_x_header', type: 'bool', help: 'Add X-PHP-Originating-Script to mail() messages.' },
  { key: 'max_execution_time', label: 'max_execution_time', type: 'int', help: 'Seconds a script may run.' },
  { key: 'max_input_time', label: 'max_input_time', type: 'int', help: 'Seconds to parse request data (-1 = unlimited).' },
  { key: 'max_input_vars', label: 'max_input_vars', type: 'int', help: 'Maximum GET/POST/COOKIE variables.' },
  { key: 'memory_limit', label: 'memory_limit', type: 'size', help: 'Per-script memory cap, e.g. 256M.' },
  { key: 'output_buffering', label: 'output_buffering', type: 'text', help: 'Off, On or a byte size such as 4096.' },
  { key: 'post_max_size', label: 'post_max_size', type: 'size', help: 'Maximum POST body, e.g. 64M (must exceed upload_max_filesize).' },
  { key: 'session.gc_maxlifetime', label: 'session.gc_maxlifetime', type: 'int', help: 'Seconds before idle session data may be collected.' },
  { key: 'session.save_path', label: 'session.save_path', type: 'text', help: 'Where session files are stored.' },
  { key: 'short_open_tag', label: 'short_open_tag', type: 'bool', help: 'Allow <? as a PHP open tag.' },
  { key: 'upload_max_filesize', label: 'upload_max_filesize', type: 'size', help: 'Largest single uploaded file, e.g. 32M.' },
  { key: 'max_file_uploads', label: 'max_file_uploads', type: 'int', help: 'Files per request.' },
  { key: 'zlib.output_compression', label: 'zlib.output_compression', type: 'bool', help: 'Compress output with zlib.' },
];

// Package groups offered by the EasyApache 4 profile editor, per distro family.
export const EA4_CATALOG = {
  debian: {
    'Apache': ['apache2', 'apache2-utils', 'apache2-suexec-pristine', 'libapache2-mod-fcgid', 'libapache2-mod-security2', 'modsecurity-crs', 'libapache2-mod-evasive', 'libapache2-mpm-itk'],
    'PHP runtime': ['php-fpm', 'php-cli', 'php-common', 'php-opcache', 'php-dev', 'php-pear', 'libapache2-mod-php'],
    'PHP extensions': ['php-mysql', 'php-pgsql', 'php-sqlite3', 'php-curl', 'php-gd', 'php-mbstring', 'php-xml', 'php-zip', 'php-intl', 'php-bcmath', 'php-soap', 'php-imagick', 'php-redis', 'php-memcached', 'php-ldap', 'php-imap', 'php-xmlrpc', 'php-gmp', 'php-tidy', 'php-xsl', 'php-apcu', 'php-igbinary', 'php-msgpack'],
    'Other': ['nginx', 'brotli', 'certbot', 'cpanminus', 'ruby', 'python3-pip', 'imagemagick', 'ghostscript', 'ffmpeg'],
  },
  rhel: {
    'Apache': ['httpd', 'httpd-tools', 'mod_ssl', 'mod_fcgid', 'mod_security', 'mod_security_crs', 'mod_evasive', 'mod_http2'],
    'PHP runtime': ['php', 'php-fpm', 'php-cli', 'php-common', 'php-opcache', 'php-devel', 'php-pear'],
    'PHP extensions': ['php-mysqlnd', 'php-pgsql', 'php-pdo', 'php-gd', 'php-mbstring', 'php-xml', 'php-pecl-zip', 'php-intl', 'php-bcmath', 'php-soap', 'php-pecl-redis', 'php-pecl-memcached', 'php-ldap', 'php-gmp', 'php-tidy', 'php-xsl', 'php-pecl-apcu', 'php-process', 'php-json', 'php-pecl-imagick'],
    'Other': ['nginx', 'certbot', 'perl-App-cpanminus', 'ruby', 'python3-pip', 'ImageMagick', 'ghostscript'],
  },
};
const EA4_PREFIXES = { debian: ['apache2', 'libapache2-', 'php', 'modsecurity'], rhel: ['httpd', 'mod_', 'php'] };
// The hostname site's applications (contract §41): their drop-in names and the distro packages that pull in PHP.
const HOST_APP_LABELS = { webmail: 'webmail', phpmyadmin: 'phpMyAdmin' };
const HOST_APP_PACKAGES = [[/^roundcube/, 'webmail'], [/^phpmyadmin/i, 'phpMyAdmin']];

export function compareVersions(a, b) {
  const pa = String(a ?? '').replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b ?? '').replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

export function pickBasic(directives) {
  return Object.fromEntries(BASIC_DIRECTIVES.map((d) => [d.key, directives?.[d.key] ?? null]));
}

// What the rendered proxy depends on; a change means whm-proxy.conf is stale.
export function proxyFingerprint(settings, domains) {
  const material = { apachePort: settings.apachePort, cache: settings.cache, cacheMaxSizeMb: settings.cacheMaxSizeMb, cacheTtl: settings.cacheTtl, domains: [...domains].sort((a, b) => a.domain.localeCompare(b.domain)) };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RUN_LOG_LINES = 2000;
const RUN_FAIL_TAIL_LINES = 40;

export function createSoftwareService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;
  const op = (name, args = {}, req) => agent.op(name, args, { req });
  const S = (key, fallback) => { const v = settings.get(key, fallback); return v === undefined ? fallback : v; };

  // Every hosted domain: main domains without an account_domains row plus every
  // recorded row (account_domains.domain is unique, so no domain repeats).
  const ALL_DOMAINS_SQL = `SELECT a.domain, a.username, a.id AS account_id, a.owner_id, a.home_dir, a.suspended, 'main' AS type, NULL AS docroot, NULL AS php_version, 0 AS has_row FROM accounts a
      WHERE a.domain NOT IN (SELECT domain FROM account_domains)
      UNION ALL SELECT d.domain, a.username, a.id, a.owner_id, a.home_dir, a.suspended, d.type, d.docroot, d.php_version, 1 FROM account_domains d JOIN accounts a ON a.id = d.account_id`;
  const stmts = {
    allDomains: db.prepare(`${ALL_DOMAINS_SQL} ORDER BY 1`),
    accountMainDomains: db.prepare('SELECT id, domain FROM accounts'),
    accountByDomain: db.prepare('SELECT * FROM accounts WHERE domain = ?'),
    accountDomain: db.prepare('SELECT d.*, a.username, a.owner_id, a.home_dir, a.suspended FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ?'),
    setDomainPhp: db.prepare('UPDATE account_domains SET php_version = ? WHERE domain = ?'),
    insertMainDomain: db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot, php_version) VALUES (?, ?, ?, ?, ?)'),
    phpUsage: db.prepare("SELECT php_version AS id, COUNT(*) AS n FROM account_domains WHERE php_version IS NOT NULL AND php_version <> '' GROUP BY php_version"),
    domainsPinnedTo: db.prepare('SELECT d.domain FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.php_version = ? AND a.suspended = 0 ORDER BY d.domain'),
    packagesUsingPhp: db.prepare('SELECT COUNT(*) AS n FROM packages WHERE php_version = ?'),
    profiles: db.prepare('SELECT * FROM ea4_profiles ORDER BY stock DESC, name'),
    profileById: db.prepare('SELECT * FROM ea4_profiles WHERE id = ?'),
    profileByName: db.prepare('SELECT * FROM ea4_profiles WHERE name = ?'),
    insertProfile: db.prepare('INSERT INTO ea4_profiles (name, description, packages_json, stock) VALUES (?, ?, ?, 0)'),
    updateProfile: db.prepare(`UPDATE ea4_profiles SET name = ?, description = ?, packages_json = ?, updated_at = datetime('now') WHERE id = ?`),
    deleteProfile: db.prepare('DELETE FROM ea4_profiles WHERE id = ?'),
  };

  const requirePkg = () => capabilities.require('pkg', 'No supported package manager (apt-get, dnf or yum) was found on this server');
  const likeEscape = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
  const requirePhp = () => capabilities.require('php', 'PHP is not installed on this server; install a PHP version (Software › Install Software or EasyApache 4)');
  const enqueue = (type, params, user) => ctx.jobs.enqueue(type, params, { userId: user?.id ?? null });
  const docrootOf = (row) => row.docroot || `${row.home_dir || `/home/${row.username}`}/public_html`;

  // Where a hostname lives and who may touch it. Root may address any hostname.
  function resolveDomain(domain, user) {
    const main = stmts.accountByDomain.get(domain);
    const sub = main ? null : stmts.accountDomain.get(domain);
    const row = main ? { ...main, type: 'main', username: main.username, docroot: null } : sub;
    if (!row) throw notFound(`Domain "${domain}"`);
    if (!ownsRow(user, row, { accountId: main ? main.id : sub.account_id })) throw forbidden('That domain belongs to another reseller');
    return { domain, type: row.type, username: row.username, accountId: main ? main.id : sub.account_id, ownerId: row.owner_id, docroot: docrootOf(row), phpVersion: main ? (stmts.accountDomain.get(domain)?.php_version ?? null) : sub.php_version, hasRow: !main || Boolean(stmts.accountDomain.get(domain)) };
  }

  const family = async () => (await op('pkg.detect')).family;

  // Runs a long agent op as a job step. The op is asked not to wait; when it
  // answers with a run id the installer is polled and its output streamed into
  // the job log, otherwise (older agent / synchronous result) the output is
  // logged as a whole. Resolves with the op result plus `output`; rejects when
  // the installer failed, timed out or vanished.
  const runs = { pollMs: 2000, maxPollMs: 10_000 };
  async function runLongOp(job, opName, args = {}, label = opName) {
    const started = await job.agent.op(opName, { ...args, wait: false });
    if (!started.run) { for (const line of started.output || []) job.log(line); return started; }
    job.log(`${label}: running detached on the host (pid ${started.run.pid}, log ${started.run.logPath})`);
    let offset = 0; let delay = runs.pollMs; let status;
    const output = [];
    for (;;) {
      await sleep(delay);
      status = await job.agent.op('pkg.run.status', { id: started.run.id, offset });
      for (const line of status.output) {
        if (output.length === MAX_RUN_LOG_LINES) job.log(`… output truncated after ${MAX_RUN_LOG_LINES} lines; the full log is ${started.run.logPath}`, 'warn');
        if (output.length < MAX_RUN_LOG_LINES) job.log(line);
        output.push(line);
      }
      offset = status.offset;
      if (status.done) break;
      delay = Math.min(Math.round(delay * 1.5), runs.maxPollMs);
    }
    if (status.status === 'finished' && status.code === 0) return { ...started, output, run: status };
    if (output.length > MAX_RUN_LOG_LINES) {
      job.log(`${label}: last ${RUN_FAIL_TAIL_LINES} lines of the output`, 'warn');
      for (const line of output.slice(-RUN_FAIL_TAIL_LINES)) job.log(line);
    }
    const reason = status.status === 'finished' ? `exited with status ${status.code}` : status.status === 'lost' ? status.error : status.status === 'timeout' ? status.error : status.error || status.status;
    const err = new Error(`${label} ${reason}${status.status === 'finished' ? `: ${output.filter((l) => /^E:|error|fail/i.test(l)).pop() || output[output.length - 1] || 'see the log'}` : ''}`);
    err.run = status;
    throw err;
  }

  // --- distro packages -----------------------------------------------------
  const pkg = {
    async detect() {
      let detected = { manager: null, family: null, binary: null, rpm: false, rebootRequired: false };
      try { detected = await op('pkg.detect'); } catch (err) { logger.warn({ err }, 'pkg.detect failed'); }
      return { ...detected, capability: capabilities.has('pkg'), rpmCapability: capabilities.has('rpm') };
    },
    async installed(query = {}) {
      requirePkg();
      const { manager, total, packages } = await op('pkg.list_installed', query.q ? { q: query.q } : {});
      const page = query.page || 1; const pageSize = query.pageSize || 50;
      return { data: packages.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: packages.length, installedTotal: total, manager } };
    },
    async search(q, limit = 100) { requirePkg(); return op('pkg.search', { q, limit }); },
    async info(name) { requirePkg(); return op('pkg.info', { name }); },
    async isInstalled(names) {
      requirePkg();
      const { packages } = await op('pkg.list_installed', { prefix: names });
      const set = new Set(packages.map((p) => p.name));
      return Object.fromEntries(names.map((n) => [n, set.has(n)]));
    },
    install(packages, user, req, { noRecommends = false } = {}) {
      requirePkg();
      const job = enqueue('software.pkg.install', { packages, noRecommends }, user);
      req?.audit?.({ action: 'software.pkg.install', target: packages.join(','), args: { packages, jobId: job.id } });
      return { job };
    },
    remove(packages, user, req, { purge = false } = {}) {
      requirePkg();
      const job = enqueue('software.pkg.remove', { packages, purge }, user);
      req?.audit?.({ action: 'software.pkg.remove', target: packages.join(','), args: { packages, purge, jobId: job.id } });
      return { job };
    },
    updateIndex(user, req) {
      requirePkg();
      const job = enqueue('software.pkg.update_index', {}, user);
      req?.audit?.({ action: 'software.pkg.update_index', args: { jobId: job.id } });
      return { job };
    },
    async ensureInstalled(names, { user, req } = {}) {
      const present = await pkg.isInstalled(names);
      const missing = names.filter((n) => !present[n]);
      if (!missing.length) return { missing: [], job: null };
      return { missing, ...pkg.install(missing, user, req) };
    },
    recent(limit = 20) { return ctx.jobs.list({ limit: 200 }).filter((j) => j.type.startsWith('software.pkg.')).slice(0, limit); },
  };

  async function pkgJob(job, opName, args, label) {
    job.log(`${label}: ${JSON.stringify(args.packages || args)}`);
    job.progress(5, label);
    const result = await runLongOp(job, opName, args, label);
    // A package can bring or take away a program a capability depends on
    // (ruby → gem, php-pear → pecl); re-detect now rather than answering 501
    // until the periodic re-detection.
    if (opName === 'pkg.install' || opName === 'pkg.remove') {
      await capabilities.refresh().catch((err) => { logger.warn({ err }, 'capability refresh after package change failed'); job.log(`capability re-detection failed: ${err.message}`, 'warn'); });
    }
    job.progress(100, 'finished');
    return { manager: result.manager, packages: result.packages, purge: result.purge, lines: result.output?.length ?? 0 };
  }

  // --- one-click runtimes and tools (contract §51) ----------------------------
  const RUNTIME_JOB_TYPES = ['software.runtime.install', 'software.runtime.remove', 'software.runtime.update'];
  // One pkg.repo.status per distinct repo of the runtimes that fall back to a
  // source build; a failed probe (offline) is null, state 'unknown'.
  async function probeRepos(repos) {
    const status = {};
    for (const repo of new Set(repos.filter(Boolean))) {
      try { const r = await op('pkg.repo.status', { repo }); status[repo] = { present: Boolean(r.present), supported: r.supported === true ? true : r.supported === false ? false : null, detail: r.detail ?? null }; } catch (err) { logger.warn({ err, repo }, 'pkg.repo.status failed'); status[repo] = null; }
    }
    return status;
  }
  const osLabel = (os) => (os?.id ? `${os.id}${os.versionId ? ` ${os.versionId}` : ''}${os.codename ? ` (${os.codename})` : ''}` : 'this OS');
  const repoLabel = (repo, fam, os) => (repo === 'php' ? (fam === 'rhel' ? 'Remi' : os?.id === 'ubuntu' ? 'ppa:ondrej/php' : 'packages.sury.org') : repo);
  // State of a catalog version that is not installed: packages when the repo
  // serves them, the php.net source build when it does not (or the probe could
  // not say), unsupported only without any package manager.
  function availability(entry, repo, rs, fam, os, version) {
    if (!fam) return { state: 'unsupported', method: null, note: 'No supported package manager (apt-get, dnf or yum) was found on this server' };
    if (repo === null || rs?.present || rs?.supported === true) return { state: 'available', method: 'package', note: null };
    if (entry.source) {
      const why = `packages from ${repoLabel(repo, fam, os)} are not available for ${osLabel(os)}`;
      if (!PHP_SOURCE_MINORS.includes(version)) return { state: 'unsupported', method: null, note: `php.net's last ${version} release does not compile against this OS's libxml2/ICU, and ${why}${rs?.detail ? ` (${rs.detail})` : ''}` };
      return { state: 'available', method: 'source', note: `Built from the official php.net source into ${PHP_SOURCE_PREFIX}/${version} (about 15 minutes); ${why}${rs?.detail ? ` (${rs.detail})` : ''}` };
    }
    if (rs?.supported === false) return { state: 'unsupported', method: null, note: rs.detail ?? null };
    return { state: 'unknown', method: 'package', note: rs?.detail ?? null };
  }

  const runtimes = {
    async catalog({ repoStatus = null, updates: withUpdates = true } = {}) {
      const d = await pkg.detect();
      const crit = withUpdates ? await updates.critical().catch(() => null) : null;
      const fam = d.family ?? null;
      let detected = {};
      try { detected = await op('pkg.runtime.detect'); } catch (err) { logger.warn({ err }, 'runtime detection failed'); }
      const sourceRepos = RUNTIME_KEYS.filter((key) => RUNTIMES[key].source).map((key) => RUNTIMES[key].repo);
      const repos = repoStatus ?? (fam ? await probeRepos(sourceRepos) : {});
      const toolEntries = TOOLS.map((t) => ({ key: t.key, label: t.label, packages: (fam ? packagesFor(t, fam) : null) ?? [] }));
      let installedSet = null;
      if (fam && capabilities.has('pkg')) {
        try {
          const { packages } = await op('pkg.list_installed', { prefix: [...new Set(toolEntries.flatMap((t) => t.packages))] });
          installedSet = new Set(packages.map((p) => p.name));
        } catch (err) { logger.warn({ err }, 'tool package listing failed'); }
      }
      const runtimeList = RUNTIME_KEYS.map((key) => {
        const entry = RUNTIMES[key];
        const note = runtimeNote(key, fam);
        const versions = (entry.single ? [null] : entry.versions).map((v) => {
          const state = detectedVersion(key, v, detected);
          const packages = entry.installer ? [] : (fam ? packagesFor(entry, fam, v) : null) ?? [];
          const repo = entry.repo === 'epel' ? (fam === 'rhel' ? 'epel' : null) : entry.repo ?? null;
          // critical() keys PHP items by the installed id (ea-php83, php83, system on EL layouts), not the catalog id.
          const update = crit && state.installed ? updates.rowUpdate(crit, key === 'php' ? 'php' : 'runtime', key === 'php' ? state.id ?? v : v ? `${key}:${v}` : key) : null;
          const row = { id: v ?? key, label: v ? `${entry.label} ${v}` : entry.label, installed: state.installed, version: state.version, packages, repo, note, update, ...(key === 'nodejs' && v ? { path: state.path ?? `/opt/keel/node/${v}`, bin: `/usr/local/bin/node${v}` } : {}) };
          if (!entry.source) return row;
          const rs = repo ? repos[repo] ?? null : null;
          const avail = state.installed ? { state: 'installed', method: state.source ? 'source' : 'package', note: state.packagedTwin ? `Distribution packages ${state.packagedTwin.version ?? ''} remain installed and unused.`.replace(/\s+remain/, ' remain') : note } : availability(entry, repo, rs, d.capability ? fam : null, detected.os, v);
          return { ...row, ...avail, note: avail.note ?? note, source: Boolean(state.source), repoStatus: rs, ...(avail.method === 'source' || state.source ? { prefix: `${PHP_SOURCE_PREFIX}/${v}` } : {}), ...(state.packagedTwin ? { packagedTwin: { binary: state.packagedTwin.binary ?? null, version: state.packagedTwin.version ?? null, packagePrefix: state.packagedTwin.packagePrefix ?? null } } : {}) };
        });
        return { key, label: entry.label, single: Boolean(entry.single), installer: entry.installer ?? null, source: Boolean(entry.source), versions };
      });
      const tools = toolEntries.map((t) => { const installed = installedSet && t.packages.length ? t.packages.every((p) => installedSet.has(p)) : null; return { ...t, installed, update: crit && installed ? updates.rowUpdate(crit, 'tool', t.key) : null }; });
      return { family: fam, os: detected.os ?? null, manager: d.manager ?? null, capability: Boolean(d.capability), runtimes: runtimeList, tools, updates: crit ? updates.stamp(crit) : null };
    },
    async install({ runtime, version, tool, method }, user, req) {
      // Node.js builds need no package manager; everything else answers 501 before the catalog check.
      if (RUNTIMES[runtime]?.installer !== 'node') requirePkg();
      const fam = capabilities.has('pkg') ? await family().catch(() => null) : null;
      const entry = runtime ? RUNTIMES[runtime] : null;
      if (method && !entry?.source) throw unprocessable('Only PHP versions have an install method; everything else installs from packages', { method: ['Leave it out'] });
      let installed = null; let latest = null;
      if (entry?.source && fam) {
        // Catalog check first (422 on a bad version), then what is already on
        // the host (a distro tree is never replaced by a source build, a Keel
        // build is never built twice), then the repo decides the default method.
        resolveInstall({ runtime, version }, fam);
        try { installed = detectedVersion(runtime, version, await op('pkg.runtime.detect')); } catch (err) { logger.warn({ err }, 'runtime detection failed'); }
        // A source build over a packaged minor is allowed only as an update: php.net's release must be newer than the packages.
        if (method === 'source' && installed?.installed && !installed.source) latest = (await releaseFor('php', version))?.version ?? null;
        resolveInstall({ runtime, version }, fam, { installed, latest });
        const rs = (await probeRepos([entry.repo]))[entry.repo];
        const packagesAvailable = Boolean(rs?.present || rs?.supported === true);
        if (!method) method = packagesAvailable || installed?.installed ? 'package' : 'source';
        else if (method === 'package' && rs?.supported === false && !installed?.installed) throw unprocessable(`${entry.label} ${version} packages are not available on this OS: ${rs.detail || 'the repository has no series for it'}${PHP_SOURCE_MINORS.includes(version) ? '; install it as a source build instead' : ''}`, { method: PHP_SOURCE_MINORS.includes(version) ? ['source'] : ['No install method is available for this version on this OS'] });
      }
      const plan = resolveInstall({ runtime, version, tool }, fam, { method, installed, latest });
      const job = enqueue('software.runtime.install', { kind: plan.kind, key: plan.key, version: plan.version, family: fam, ...(plan.installer === 'php-source' ? { method: 'source' } : {}) }, user);
      const target = plan.version ? `${plan.key}:${plan.version}` : plan.key;
      req?.audit?.({ action: 'software.runtime.install', target, args: { kind: plan.kind, key: plan.key, version: plan.version, method: plan.installer === 'php-source' ? 'source' : plan.installer === 'node' ? 'node' : 'package', packages: plan.packages, jobId: job.id } });
      return { job, target, packages: plan.packages, method: plan.installer === 'php-source' ? 'source' : 'package', ...(plan.prefix ? { prefix: plan.prefix } : {}) };
    },
    remove({ runtime, version }, user, req) {
      if (runtime !== 'nodejs') throw unprocessable('Only Node.js builds are removed here; PHP versions are removed in the PHP Version Manager and Python packages from the Installed tab', { runtime: ['nodejs'] });
      const plan = resolveInstall({ runtime, version }, null);
      const job = enqueue('software.runtime.remove', { key: 'nodejs', version: plan.version }, user);
      req?.audit?.({ action: 'software.runtime.remove', target: `nodejs:${plan.version}`, args: { major: plan.major, jobId: job.id } });
      return { job, target: `nodejs:${plan.version}` };
    },
    recent(limit = 20) { return ctx.jobs.list({ limit: 200 }).filter((j) => RUNTIME_JOB_TYPES.includes(j.type)).slice(0, limit); },
    async installJob(job) {
      const { kind, key, version, method } = job.params;
      const fam = job.params.family ?? (capabilities.has('pkg') ? await job.agent.op('pkg.detect').then((d) => d.family).catch(() => null) : null);
      const plan = resolveInstall(kind === 'tool' ? { tool: key } : { runtime: key, version }, fam, { method });
      const label = plan.version ? `${plan.label} ${plan.version}` : plan.label;
      job.log(`${label}: ${plan.installer === 'node' ? `official Node.js ${plan.major}.x build` : plan.installer === 'php-source' ? `php.net source build into ${plan.prefix}` : JSON.stringify(plan.packages)}${fam ? ` (${fam})` : ''}`);
      let added = false;
      for (const [i, repo] of plan.repos.entries()) {
        job.progress(5 + i * 5, `checking the ${repo} repository`);
        const result = await job.agent.op('pkg.repo.ensure', { repo });
        job.log(`repository ${repo}: ${result.action}${result.detail ? ` (${result.detail})` : ''}`);
        if (result.action === 'unsupported') throw new Error(`${label} cannot be installed on this distribution: ${result.detail || `the ${repo} repository is not available for it`}`);
        if (result.action === 'added') added = true;
      }
      if (added) {
        job.progress(20, 'refreshing package index');
        await runLongOp(job, 'pkg.update_index', {}, 'package index refresh');
      }
      let cliDefaultBefore = null;
      if (plan.key === 'php' && capabilities.has('php')) {
        try { cliDefaultBefore = (await job.agent.op('pkg.php.versions')).defaultId ?? null; } catch (err) { job.log(`could not read the current PHP CLI default: ${err.message}`, 'warn'); }
      }
      let nodeResult = null; let build = null;
      if (plan.installer === 'php-source') {
        job.progress(5, 'installing build dependencies');
        job.log(`build dependencies (${fam}): ${JSON.stringify(plan.deps)}`);
        await runLongOp(job, 'pkg.install', { packages: plan.deps }, 'build dependencies');
        job.progress(15, `downloading and building PHP ${plan.minor}`);
        await runLongOp(job, 'pkg.php.build', { minor: plan.minor }, `PHP ${plan.minor} build`);
        job.progress(90, 'registering the PHP-FPM unit');
        build = await job.agent.op('pkg.php.build.finish', { minor: plan.minor });
        const unit = build.unit ?? `keel-php${plan.minor}-fpm`;
        if (build.linkConflict) job.log(`${build.link ?? `/usr/local/bin/php${plan.minor}`} was left alone: ${build.linkConflict}`, 'warn');
        if (build.unitError || build.active === false) throw new Error(`PHP ${build.version ?? plan.minor} built but ${unit} did not start: ${build.unitError ?? 'unit inactive'}; see journalctl -u ${unit}`);
        job.log(`PHP ${build.version ?? plan.minor} installed under ${build.prefix ?? plan.prefix}; unit ${unit} ${build.active ? 'active' : 'not checked'}; CLI ${build.link ?? `/usr/local/bin/php${plan.minor}`}`);
      } else {
        job.progress(30, `installing ${label}`);
        if (plan.installer === 'node') nodeResult = await runLongOp(job, 'pkg.node.install', { major: plan.major }, `${label} install`);
        else await runLongOp(job, 'pkg.install', { packages: plan.packages }, `${label} install`);
      }
      if (cliDefaultBefore) {
        job.progress(92, 'checking the PHP CLI default');
        try {
          const after = (await job.agent.op('pkg.php.versions')).defaultId ?? null;
          if (after && after !== cliDefaultBefore) {
            await job.agent.op('pkg.php.default.set', { version: cliDefaultBefore });
            job.log(`the installer switched the php CLI default to ${after}; restored ${cliDefaultBefore}`);
          }
        } catch (err) { job.log(`PHP CLI default check failed: ${err.message}`, 'warn'); }
      }
      job.progress(94, 're-detecting capabilities');
      await capabilities.refresh().catch((err) => { logger.warn({ err }, 'capability refresh after runtime install failed'); job.log(`capability re-detection failed: ${err.message}`, 'warn'); });
      let detected = null;
      if (plan.kind === 'runtime') {
        job.progress(96, 'verifying');
        const state = detectedVersion(plan.key, plan.version ?? plan.key, await job.agent.op('pkg.runtime.detect'));
        if (!state.installed) throw new Error(`${label} is still not detected after the install; see the log above`);
        detected = state.version ?? nodeResult?.version ?? build?.version ?? null;
        job.log(`${label} detected: ${detected ?? 'present'}`);
      }
      job.progress(100, 'done');
      const how = plan.installer === 'php-source' ? 'source' : plan.installer === 'node' ? 'node' : 'package';
      return { kind: plan.kind, [plan.kind === 'tool' ? 'tool' : 'runtime']: plan.key, version: plan.version, packages: plan.packages, installed: true, detected, method: how,...(nodeResult ? { path: nodeResult.path, bin: nodeResult.bin, symlinks: nodeResult.symlinks } : {}), ...(build ? { prefix: build.prefix ?? plan.prefix, unit: build.unit ?? null, link: build.link ?? null, release: build.version ?? null, binary: build.binary ?? null, deps: plan.deps } : {}) };
    },
    async removeJob(job) {
      const major = Number(job.params.version);
      job.progress(10, `removing Node.js ${major}`);
      const result = await job.agent.op('pkg.node.remove', { major });
      await capabilities.refresh().catch((err) => { logger.warn({ err }, 'capability refresh after node removal failed'); });
      job.progress(100, 'done');
      return { runtime: 'nodejs', version: String(major), removed: true, ...result };
    },
    // Direct update of an installed runtime or tool (contract §63): packages
    // through pkg.upgrade, a Node.js major through a fresh nodejs.org build.
    async update({ runtime, version, tool }, user, req) {
      if (runtime === 'php') throw unprocessable('PHP versions are updated through the PHP Version Manager (POST /software/php/update)', { runtime: ['Use /software/php/update'] });
      if (RUNTIMES[runtime]?.installer !== 'node') requirePkg();
      const fam = capabilities.has('pkg') ? await family().catch(() => null) : null;
      const plan = resolveInstall({ runtime, version, tool }, fam);
      const label = plan.version ? `${plan.label} ${plan.version}` : plan.label;
      if (plan.installer === 'node') {
        const { versions } = await op('pkg.node.list');
        if (!(versions || []).some((n) => n.major === plan.major)) throw unprocessable(`Node.js ${plan.major} is not installed under /opt/keel/node; install it first`, { version: ['Install it from Install Software first'] });
      } else {
        const present = await pkg.isInstalled(plan.packages);
        if (!plan.packages.some((p) => present[p])) throw unprocessable(`${label} is not installed; there is nothing to update`, { [tool ? 'tool' : 'runtime']: ['Install it first'] });
      }
      const job = enqueue('software.runtime.update', { kind: plan.kind, key: plan.key, version: plan.version, family: fam, packages: plan.packages, major: plan.major ?? null }, user);
      const target = plan.version ? `${plan.key}:${plan.version}` : plan.key;
      req?.audit?.({ action: 'software.runtime.update', target, args: { kind: plan.kind, key: plan.key, version: plan.version, method: plan.installer === 'node' ? 'node' : 'package', packages: plan.packages, jobId: job.id } });
      return { job, target, packages: plan.packages, method: plan.installer === 'node' ? 'node' : 'package' };
    },
    async updateJob(job) {
      const { kind, key, version, packages, major } = job.params;
      const entry = kind === 'tool' ? TOOLS.find((t) => t.key === key) : RUNTIMES[key];
      const label = version ? `${entry?.label ?? key} ${version}` : entry?.label ?? key;
      let detected = null;
      if (key === 'nodejs') {
        job.progress(10, `installing the latest Node.js ${major}.x build`);
        const r = await runLongOp(job, 'pkg.node.install', { major }, `${label} update`);
        detected = r.version ?? null;
      } else {
        job.log(`${label}: upgrading ${JSON.stringify(packages)}`);
        job.progress(10, `upgrading ${packages.length} package(s)`);
        await runLongOp(job, 'pkg.upgrade', { packages, dist: false }, `${label} upgrade`);
        job.progress(80, 'checking what is still pending');
        try { recordCheck(await job.agent.op('pkg.upgradable')); } catch (err) { job.log(`post-upgrade check failed: ${err.message}`, 'warn'); }
      }
      job.progress(92, 're-detecting capabilities');
      await capabilities.refresh().catch((err) => { logger.warn({ err }, 'capability refresh after runtime update failed'); job.log(`capability re-detection failed: ${err.message}`, 'warn'); });
      if (kind === 'runtime') {
        try { detected = detectedVersion(key, version ?? key, await job.agent.op('pkg.runtime.detect')).version ?? detected; } catch (err) { job.log(`runtime detection failed: ${err.message}`, 'warn'); }
      }
      updates.invalidate();
      job.log(`${label}: ${detected ? `now ${detected}` : 'updated'}`);
      job.progress(100, 'done');
      return { kind, [kind === 'tool' ? 'tool' : 'runtime']: key, version, packages, updated: true, detected, method: key === 'nodejs' ? 'node' : 'package' };
    },
  };

  // --- system update -------------------------------------------------------
  // The simulation (apt-get -s dist-upgrade / dnf check-update) can take minutes,
  // so its result is kept in settings and served to page loads; the job runs
  // and the explicit "check now" refresh it.
  const MAX_CACHED_PACKAGES = 200;
  const recordCheck = (pending) => {
    const packages = Array.isArray(pending.packages) ? pending.packages : [];
    const entry = { at: new Date().toISOString(), manager: pending.manager ?? null, count: Number(pending.count ?? packages.length) || 0, security: Number(pending.security ?? packages.filter((p) => p.security).length) || 0, rebootRequired: Boolean(pending.rebootRequired), packages: packages.slice(0, MAX_CACHED_PACKAGES), truncated: packages.length > MAX_CACHED_PACKAGES };
    settings.set('software.updates.last_check', entry);
    return entry;
  };
  const update = {
    async status({ cached = false } = {}) {
      requirePkg();
      let check = cached ? S('software.updates.last_check', null) : null;
      let source = 'cached';
      if (!check || !Array.isArray(check.packages)) { check = recordCheck(await op('pkg.upgradable')); source = 'live'; }
      let rebootRequired = check.rebootRequired;
      if (source === 'cached') { try { rebootRequired = Boolean((await op('pkg.reboot_required')).rebootRequired); } catch (err) { logger.warn({ err }, 'reboot check failed'); } }
      const last = ctx.jobs.list({ type: 'software.system.update', limit: 1 })[0] ?? null;
      return { manager: check.manager, count: check.count, security: check.security, packages: check.packages, truncated: Boolean(check.truncated), rebootRequired, checkedAt: check.at, source, lastRun: last, lastCheck: check, autoApply: Boolean(S('software.updates.auto_os', false)), tier: S('updates.tier', 'stable') };
    },
    run({ dist = true, autoremove = false, refreshIndex = true, packages } = {}, user, req) {
      requirePkg();
      const job = enqueue('software.system.update', { dist, autoremove, refreshIndex, packages: packages ?? null }, user);
      req?.audit?.({ action: 'software.system.update', args: { dist, autoremove, refreshIndex, packages: packages ?? null, jobId: job.id } });
      return { job };
    },
    async setAuto(autoApply, req) {
      settings.set('software.updates.auto_os', Boolean(autoApply));
      req?.audit?.({ action: 'software.update.auto', args: { autoApply } });
      return { autoApply: Boolean(autoApply) };
    },
    async runJob(job) {
      const { dist, autoremove, refreshIndex, packages } = job.params;
      if (refreshIndex) {
        job.progress(5, 'refreshing package index');
        await runLongOp(job, 'pkg.update_index', {}, 'package index refresh');
      }
      job.progress(20, 'checking for updates');
      const pending = await job.agent.op('pkg.upgradable');
      job.log(`${pending.count} package(s) can be upgraded${pending.security ? ` (${pending.security} security)` : ''}`);
      for (const p of pending.packages.slice(0, 200)) job.log(`  ${p.name} ${p.current ?? ''} -> ${p.candidate}${p.security ? ' [security]' : ''}`);
      let rebootRequired = pending.rebootRequired;
      if (pending.count > 0 || packages?.length) {
        job.progress(30, `upgrading ${packages?.length || pending.count} package(s)`);
        const result = await runLongOp(job, 'pkg.upgrade', { dist, autoremove, ...(packages?.length ? { packages } : {}) }, 'upgrade');
        for (const line of result.autoremoveOutput || []) job.log(line);
        if (result.autoremovePending) {
          job.progress(85, 'removing unused dependencies');
          await runLongOp(job, 'pkg.autoremove', {}, 'autoremove');
        }
        rebootRequired = result.rebootRequired ?? (await job.agent.op('pkg.reboot_required')).rebootRequired;
      } else {
        job.log('System is up to date');
      }
      // A partial upgrade (or packages the manager held back) leaves updates
      // pending; the recorded count comes from a fresh simulation, not from zero.
      job.progress(95, 'checking what is still pending');
      let still = { count: 0, security: 0, packages: [], manager: pending.manager, rebootRequired };
      try { still = { ...(await job.agent.op('pkg.upgradable')), rebootRequired }; } catch (err) { job.log(`post-upgrade check failed: ${err.message}`, 'warn'); }
      const after = recordCheck(still);
      if (after.count) job.log(`${after.count} update(s) still pending after this run${after.security ? ` (${after.security} security)` : ''}`);
      job.progress(100, rebootRequired ? 'done; reboot required' : 'done');
      if (rebootRequired) job.log('A reboot is required to finish applying these updates', 'warn');
      const upgraded = packages?.length ? pending.packages.filter((p) => packages.includes(p.name)) : pending.packages;
      return { upgraded: upgraded.length, packages: upgraded.map((p) => p.name), stillPending: after.count, rebootRequired };
    },
    async checkJob(job) {
      if (!capabilities.has('pkg')) { job.log('no package manager detected; skipping'); return { skipped: true }; }
      // Without a fresh index the simulation only sees what the last refresh knew.
      job.progress(5, 'refreshing package index');
      try { await runLongOp(job, 'pkg.update_index', {}, 'package index refresh'); } catch (err) { job.log(`package index refresh failed: ${err.message}; checking against the current index`, 'warn'); }
      job.progress(40, 'checking for updates');
      const pending = recordCheck(await job.agent.op('pkg.upgradable'));
      job.log(`${pending.count} pending update(s), ${pending.security} security`);
      if (pending.count > 0 && S('software.updates.auto_os', false)) {
        job.log('automatic OS updates are enabled; applying');
        const run = enqueue('software.system.update', { dist: true, autoremove: true, refreshIndex: false }, null);
        return { count: pending.count, security: pending.security, autoJobId: run.id };
      }
      return { count: pending.count, security: pending.security };
    },
  };

  // --- critical updates (contract §63) ---------------------------------------
  // One list for the Home banner, the PHP Version Manager, Install Software and
  // the Security Advisor: PHP advisories, pending package updates of the
  // runtimes/tools/web stack and newer Node.js builds. Cached ten minutes; every
  // probe is isolated so a failing one (offline, no PHP) never blocks a page.
  const CRITICAL_TTL_MS = 10 * 60_000;
  const RELEASE_TTL_MS = 6 * 60 * 60_000;
  const SEVERITY_RANK = { critical: 0, security: 1, update: 2 };
  const WEB_STACK = [['apache', 'Apache', ['apache2', 'httpd']], ['nginx', 'NGINX', ['nginx']], ['exim', 'Exim', ['exim4', 'exim']], ['dovecot', 'Dovecot', ['dovecot']], ['mariadb', 'MariaDB', ['mariadb']], ['mysql', 'MySQL', ['mysql-server', 'mysql-community-server']], ['postgresql', 'PostgreSQL', ['postgresql']], ['pure-ftpd', 'Pure-FTPd', ['pure-ftpd']], ['proftpd', 'ProFTPD', ['proftpd']], ['openssl', 'OpenSSL', ['openssl']]];
  const RELEASE_SHAPES = { php: ['software.php.releases', 'pkg.php.release', (k) => ({ minor: k }), (r) => typeof r?.version === 'string' && /^\d+\.\d+\.\d+$/.test(r.version)], node: ['software.node.releases', 'pkg.node.release', (k) => ({ major: Number(k) }), (r) => typeof r?.version === 'string' && /^v\d+\.\d+\.\d+$/.test(r.version)] };
  let criticalCache = null;
  // A forced lookup ("Check for updates") asks php.net / nodejs.org at most once a minute per entry.
  const RELEASE_FORCE_MIN_MS = 60_000;
  // The newest upstream release of a PHP minor / Node major, kept six hours in
  // settings; a failed lookup serves the stale entry when there is one.
  async function releaseFor(kind, key, { force = false } = {}) {
    const [setting, opName, args, valid] = RELEASE_SHAPES[kind];
    const cache = S(setting, {}) || {};
    const hit = cache[key];
    const age = hit ? Date.now() - (Date.parse(hit.at) || 0) : Infinity;
    if (hit && age < (force ? RELEASE_FORCE_MIN_MS : RELEASE_TTL_MS)) return hit;
    try {
      const r = await op(opName, args(key));
      if (!valid(r)) throw new Error(`${opName} answered without a usable version`);
      const entry = { version: r.version, sha256: r.sha256 ?? null, file: r.filename ?? r.file ?? null, at: new Date().toISOString() };
      settings.set(setting, { ...cache, [key]: entry });
      return entry;
    } catch (err) {
      logger.warn({ err, kind, key }, 'release lookup failed');
      return hit ?? null;
    }
  }
  const pendingItem = ({ kind, id, label, hits, action }) => ({ kind, id, label, current: hits[0].current ?? null, candidate: hits[0].candidate ?? null, severity: hits.some((p) => p.security) ? 'security' : 'update', reasons: hits.map((p) => `${p.name} ${p.current ?? ''} → ${p.candidate}${p.security ? ' (security)' : ''}`.replace(/\s+/g, ' ')), packages: hits.map((p) => p.name), source: 'package', action });
  const OS_CHECK_TTL_MS = 6 * 60 * 60_000;
  let refreshing = null;
  const updates = {
    async critical({ versions = null, fresh = false, releases = false } = {}) {
      if (!fresh && criticalCache && Date.now() - criticalCache.at < CRITICAL_TTL_MS) return criticalCache.value;
      const items = [];
      const cached = S('software.updates.last_check', null);
      const pending = Array.isArray(cached?.packages) ? cached.packages : [];
      // The newest release entry consulted this round; null when no Keel build or Node major asked php.net / nodejs.org.
      let releasesCheckedAt = null;
      const lookup = async (kind, key) => {
        const r = await releaseFor(kind, key, { force: releases });
        if (r?.at && (!releasesCheckedAt || r.at > releasesCheckedAt)) releasesCheckedAt = r.at;
        return r;
      };
      // Advisories the last advisor run found backported by the distribution are not open on that version.
      const backported = new Set();
      try { for (const f of ctx.security?.advisor?.last?.()?.findings || []) if (/\.backported$/.test(String(f.id)) && f.advisory) for (const h of f.versions || []) backported.add(`${f.advisory}|${h.id}`); } catch (err) { logger.warn({ err }, 'advisor findings unreadable'); }
      try {
        const installed = versions ?? (capabilities.has('php') ? (await php.versions()).versions : []);
        for (const v of installed) {
          const advisories = (v.advisories || []).filter((a) => !backported.has(`${a.id}|${v.id}`));
          const prefix = v.packagePrefix || null;
          const hits = prefix ? pending.filter((p) => String(p.name).startsWith(prefix)) : [];
          let candidate = null; let release = null; let method = hits.length ? 'package' : null; let build = hits.length ? false : null;
          const minor = /^\d+\.\d+$/.test(String(v.id)) ? String(v.id) : null;
          if (hits.length) candidate = (hits.find((p) => p.name === `${prefix}fpm`) ?? hits.find((p) => p.name === `${prefix}cli`) ?? hits[0]).candidate ?? null;
          else if (v.layout === 'keel' && minor) {
            release = await lookup('php', minor);
            if (release && v.version && compareVersions(release.version, v.version) > 0) { candidate = release.version; method = 'source'; build = true; }
            // A build shadowing distro packages of its minor: until the update job has re-rendered every
            // domain of that minor onto it (recorded per minor), the "update" is that resync alone.
            else if (v.packagedTwin && v.version && !php.keelResynced(minor, v.version)) { candidate = v.version; method = 'source'; build = false; }
          } else if (advisories.length && minor && PHP_SOURCE_MINORS.includes(minor)) {
            // A packaged minor with an advisory no distribution package fixes: php.net's newer release, built from source, replaces it.
            release = await lookup('php', minor);
            if (release && v.version && compareVersions(release.version, v.version) > 0) { candidate = release.version; method = 'source'; build = true; }
          }
          if (!advisories.length && !candidate) continue;
          const source = hits.length ? 'package' : candidate ? 'release' : null;
          const severity = advisories.some((a) => a.grade === 'critical') ? 'critical' : advisories.length || hits.some((p) => p.security) ? 'security' : 'update';
          const reasons = [
            ...advisories.map((a) => `${a.id}: ${a.title}${a.fixedIn ? ` (fixed in ${a.fixedIn})` : ''}`),
            ...(hits.length ? [`${hits.length} package update${hits.length === 1 ? '' : 's'} pending${hits.some((p) => p.security) ? ' (security)' : ''}`] : []),
            ...(release && candidate && build ? [`php.net released ${release.version}${v.layout === 'keel' ? '' : '; no distribution package carries a fix, so it is built from source'}`] : []),
            ...(candidate && method === 'source' && build === false ? [`the Keel build ${v.version} shadows the distribution packages ${v.packagedTwin?.version ?? ''}; the domains on PHP ${minor} are re-rendered onto it`.replace(/\s+;/, ';')] : []),
          ];
          items.push({ kind: 'php', id: v.id, label: v.label || `PHP ${v.id}`, current: v.version ?? null, candidate, severity, reasons, layout: v.layout ?? null, packages: hits.map((p) => p.name), unit: v.fpmUnit ?? null, source, method: candidate ? method : null, build: candidate ? build : null, action: candidate ? { method: 'POST', path: '/software/php/update', body: { version: v.id } } : null });
        }
      } catch (err) { logger.warn({ err }, 'php update check failed'); }
      let fam = null;
      if (pending.length && capabilities.has('pkg')) {
        try { fam = await family(); } catch (err) { logger.warn({ err }, 'pkg.detect failed'); }
      }
      if (fam) {
        const byName = new Map(pending.map((p) => [p.name, p]));
        const pick = (names) => (names || []).map((n) => byName.get(n)).filter(Boolean);
        for (const key of RUNTIME_KEYS) {
          const entry = RUNTIMES[key];
          if (key === 'php' || entry.installer) continue;
          for (const v of entry.single ? [null] : entry.versions) {
            const hits = pick(packagesFor(entry, fam, v));
            if (hits.length) items.push(pendingItem({ kind: 'runtime', id: v ? `${key}:${v}` : key, label: v ? `${entry.label} ${v}` : entry.label, hits, action: { method: 'POST', path: '/software/runtimes/update', body: v ? { runtime: key, version: v } : { runtime: key } } }));
          }
        }
        for (const t of TOOLS) {
          const hits = pick(packagesFor(t, fam));
          if (hits.length) items.push(pendingItem({ kind: 'tool', id: t.key, label: t.label, hits, action: { method: 'POST', path: '/software/runtimes/update', body: { tool: t.key } } }));
        }
        for (const [id, label, prefixes] of WEB_STACK) {
          const hits = pending.filter((p) => prefixes.some((x) => p.name === x || String(p.name).startsWith(`${x}-`)));
          if (hits.length) items.push(pendingItem({ kind: 'package', id, label, hits, action: { method: 'POST', path: '/software/update/run', body: { packages: hits.map((p) => p.name), dist: false, refreshIndex: false } } }));
        }
      }
      try {
        const { versions: nodes } = await op('pkg.node.list');
        for (const n of nodes || []) {
          if (!n?.version || !Number.isInteger(n.major)) continue;
          const release = await lookup('node', String(n.major));
          if (!release || compareVersions(release.version, n.version) <= 0) continue;
          items.push({ kind: 'runtime', id: `nodejs:${n.major}`, label: `Node.js ${n.major}`, current: n.version, candidate: release.version, severity: 'update', reasons: [`nodejs.org released ${release.version}`], packages: [], source: 'release', action: { method: 'POST', path: '/software/runtimes/update', body: { runtime: 'nodejs', version: String(n.major) } } });
        }
      } catch (err) { logger.warn({ err }, 'node update check failed'); }
      items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.label.localeCompare(b.label));
      const value = { checkedAt: new Date().toISOString(), packagesCheckedAt: cached?.at ?? null, releasesCheckedAt, items };
      criticalCache = { at: Date.now(), value };
      return value;
    },
    // "Check for updates": a fresh php.net / nodejs.org lookup, the OS update
    // simulation again when the recorded one is older than six hours (no index
    // refresh; the nightly job does that), then the list recomputed.
    // Concurrent callers (two pages, a double click) share one run.
    async refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const cached = S('software.updates.last_check', null);
        const stale = !cached?.at || Date.now() - (Date.parse(cached.at) || 0) > OS_CHECK_TTL_MS;
        if (stale && capabilities.has('pkg')) {
          try { recordCheck(await op('pkg.upgradable')); } catch (err) { logger.warn({ err }, 'update check refresh failed'); }
        }
        return updates.critical({ fresh: true, releases: true });
      })().finally(() => { refreshing = null; });
      return refreshing;
    },
    invalidate() { criticalCache = null; },
    // { candidate, severity, reasons, current, source, checkedAt } for a catalog row, or null.
    rowUpdate(list, kind, id) {
      const item = list?.items?.find((i) => i.kind === kind && i.id === id);
      if (!item) return null;
      const checkedAt = (item.source === 'release' ? list.releasesCheckedAt : list.packagesCheckedAt) ?? list.checkedAt ?? null;
      return { candidate: item.candidate, severity: item.severity, reasons: item.reasons, current: item.current ?? null, source: item.source ?? null, method: item.method ?? null, build: item.build ?? null, checkedAt };
    },
    // The check times a catalog carries beside its rows.
    stamp(list) {
      return { checkedAt: list?.checkedAt ?? null, packagesCheckedAt: list?.packagesCheckedAt ?? null, releasesCheckedAt: list?.releasesCheckedAt ?? null };
    },
  };

  // --- RPM database ----------------------------------------------------------
  const rpm = {
    async status() {
      const d = await pkg.detect();
      return { supported: capabilities.has('rpm'), family: d.family, manager: d.manager, lastRun: ctx.jobs.list({ type: 'software.rpmdb.rebuild', limit: 1 })[0] ?? null };
    },
    rebuild(user, req) {
      capabilities.require('rpm', 'rpm is not installed; the RPM database only exists on RHEL-family systems (AlmaLinux, Rocky, CloudLinux, Fedora). Debian/Ubuntu hosts use dpkg and need no rebuild.');
      const job = enqueue('software.rpmdb.rebuild', {}, user);
      req?.audit?.({ action: 'software.rpmdb.rebuild', args: { jobId: job.id } });
      return { job };
    },
    async rebuildJob(job) {
      job.progress(5, 'rpm --rebuilddb');
      const result = await runLongOp(job, 'pkg.rebuild_rpmdb', {}, 'rpm --rebuilddb');
      const packagesAfter = result.packagesAfter ?? (await job.agent.op('pkg.rpm_count')).packages;
      job.log(`RPM database rebuilt: ${result.packagesBefore} package(s) before, ${packagesAfter} after`);
      job.progress(100, 'done');
      return { rebuilt: true, packagesBefore: result.packagesBefore, packagesAfter };
    },
  };

  // --- language modules ---------------------------------------------------
  const MODULE_OPS = { pecl: ['pkg.pecl.list', 'pkg.pecl.install', 'pecl', 'extension', 'extensions'], pear: ['pkg.pear.list', 'pkg.pear.install', 'pear', 'package', 'packages'], gem: ['pkg.gem.list', 'pkg.gem.install', 'gem', 'gem', 'gems'], pip: ['pkg.pip.list', 'pkg.pip.install', 'pip', 'package', 'packages'] };
  // Mirrors the agent's per-installer name schemas (agent/src/ops/pkg.js) so a
  // name the agent would refuse is a 422 with a field message, not a failed job.
  const MODULE_NAMES = {
    pecl: [/^[a-z][a-z0-9_]{0,63}(-(stable|beta|alpha|[0-9][0-9A-Za-z.]{0,31}))?$/, 'PECL extension names are lowercase letters, digits and "_" (redis, imagick), optionally followed by -stable, -beta or -<version>'],
    pear: [/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'PEAR package names use letters, digits and "_" only (Mail, Net_SMTP); give the version separately'],
    gem: [/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'Gem names use letters, digits, ".", "_" and "-"'],
    pip: [/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'Package names use letters, digits, ".", "_" and "-"'],
  };
  const modules = {
    async installers() {
      let detected = { present: {}, versions: {}, perl: null, pip: null };
      try { detected = await op('pkg.module.detect'); } catch (err) { logger.warn({ err }, 'module detection failed'); }
      const fam = await family().catch(() => null);
      // The distro packages that bring each installer, so the page can install
      // a missing one in place instead of sending the operator to the search.
      const toolPackages = (key) => (fam ? packagesFor(TOOLS.find((t) => t.key === key), fam) : null) ?? [];
      const packages = { php: toolPackages('php-pear'), perl: toolPackages('cpanminus'), ruby: (fam ? packagesFor(RUNTIMES.ruby, fam) : null) ?? [], python3: toolPackages('python3-pip') };
      return { ...detected, family: fam, packages, capabilities: { perl: capabilities.has('perl'), cpan: capabilities.has('cpan'), pecl: capabilities.has('pecl'), pear: capabilities.has('pear'), gem: capabilities.has('gem'), pip: capabilities.has('pip') } };
    },
    // An installer added outside the panel (apt on a shell) gets one bounded
    // re-detection before the install prompt, so the page follows the host.
    async requireInstaller(kind, cap) {
      if (!capabilities.has(cap)) await capabilities.ensureFresh(30 * 1000).catch((err) => logger.warn({ err, kind }, 'capability refresh failed'));
      capabilities.require(cap, `${kind} is not installed on this server`);
    },
    async list(kind) {
      const [listOp, , cap, , plural] = MODULE_OPS[kind];
      await modules.requireInstaller(kind, cap);
      const result = await op(listOp);
      return { kind, items: result[plural] || [] };
    },
    async install(kind, { name, version }, user, req) {
      const [, installOp, cap, argName] = MODULE_OPS[kind];
      const [pattern, hint] = MODULE_NAMES[kind];
      if (!pattern.test(name)) throw unprocessable(`"${name}" is not a valid ${kind} name`, { name: [hint] });
      await modules.requireInstaller(kind, cap);
      const job = enqueue('software.module.install', { kind, op: installOp, args: { [argName]: name, ...(version && kind !== 'pecl' && kind !== 'pear' ? { version } : {}) } }, user);
      req?.audit?.({ action: `software.module.install.${kind}`, target: name, args: { version: version ?? null, jobId: job.id } });
      return { job };
    },
    async installJob(job) {
      const { kind, op: installOp, args } = job.params;
      job.log(`${kind}: installing ${JSON.stringify(args)}`);
      job.progress(10, `installing with ${kind}`);
      const result = await runLongOp(job, installOp, args, `${kind} install`);
      const iniHint = result.iniHint ?? (kind === 'pecl' ? (result.output || []).map((l) => l.match(/You should add "([^"]+)" to php\.ini/)?.[1]).find(Boolean) ?? null : null);
      if (iniHint) job.log(`Add "${iniHint}" to the php.ini of the version that should load it (MultiPHP INI Editor)`, 'warn');
      job.progress(100, 'done');
      return { installer: result.installer, kind, args, iniHint };
    },
  };

  const perl = {
    async list() { capabilities.require('perl', 'perl is not installed on this server'); return op('pkg.perl.list'); },
    install(modulesList, { notest = true } = {}, user, req) {
      capabilities.require('perl', 'perl is not installed on this server');
      capabilities.require('cpan', 'Neither cpanm nor cpan is installed; install the cpanminus (Debian) or perl-App-cpanminus (RHEL) package first');
      const job = enqueue('software.perl.install', { modules: modulesList, notest }, user);
      req?.audit?.({ action: 'software.perl.install', target: modulesList.join(','), args: { modules: modulesList, notest, jobId: job.id } });
      return { job };
    },
    async installJob(job) {
      const { modules: list, notest } = job.params;
      job.progress(5, `installing ${list.length} module(s)`);
      const result = await runLongOp(job, 'pkg.perl.install', { modules: list, notest }, 'CPAN install');
      job.log(`installer: ${result.installer}`);
      job.progress(100, 'done');
      return { installer: result.installer, modules: list };
    },
  };

  // --- panel self-update ----------------------------------------------------
  // A feed URL may carry basic-auth credentials; they never reach the audit
  // log or a GET response, and since fetch() refuses URLs with userinfo they
  // are sent as an Authorization header instead.
  const splitCredentials = (url) => {
    try {
      const u = new URL(url);
      if (!u.username && !u.password) return { url, headers: {} };
      const auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
      u.username = ''; u.password = '';
      return { url: u.href, headers: { Authorization: auth } };
    } catch { return { url, headers: {} }; }
  };
  const redactUrl = (url) => (url ? splitCredentials(url).url : url);
  const panel = {
    installMethod() {
      if (fs.existsSync(path.join(REPO_ROOT, '.git'))) return 'git';
      if (fs.existsSync('/opt/whm/scripts/install.sh') || fs.existsSync(path.join(REPO_ROOT, 'scripts/install.sh'))) return 'install-script';
      return 'manual';
    },
    status() {
      const last = S('software.panel.last_check', null);
      const latest = last?.latest ?? null;
      const method = panel.installMethod();
      return {
        currentVersion: ctx.version, updateUrl: redactUrl(S('software.update_url', '')), updateUrlHasCredentials: redactUrl(S('software.update_url', '')) !== S('software.update_url', ''), tier: S('updates.tier', 'stable'), autoUpdate: Boolean(S('updates.auto', false)),
        lastCheck: last, latest, updateAvailable: latest ? compareVersions(latest.version, ctx.version) > 0 : null,
        installMethod: method, repoRoot: REPO_ROOT,
        selfUpdate: { supported: false, reason: 'In-place self-update is not performed by the panel. Apply updates with the install script so the service restarts under systemd with the right ownership.' },
        instructions: [
          method === 'git' ? `cd ${REPO_ROOT} && git fetch --tags && git checkout <release-tag>` : `Download the release archive${latest?.url ? ` from ${latest.url}` : ''} and unpack it over the install directory`,
          `${method === 'git' ? REPO_ROOT : '/opt/whm'}/scripts/install.sh --upgrade`,
          'systemctl restart whm-panel whm-agentd',
          'Verify: Home shows the new version and Server Status > Task Queue Monitor has no failed jobs',
        ],
      };
    },
    async check(req) {
      const url = S('software.update_url', '');
      if (!url) throw unprocessable('No update URL is configured', { url: ['Set the update URL below first'] });
      const target = splitCredentials(url);
      const entry = { at: new Date().toISOString(), url: target.url, ok: false, latest: null, error: null };
      try {
        const res = await fetch(target.url, { headers: { Accept: 'application/json', 'User-Agent': `whm-panel/${ctx.version}`, ...target.headers }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
        if (!res.ok) throw new Error(`update server answered ${res.status}`);
        const body = await res.json();
        const tier = S('updates.tier', 'stable');
        const release = body?.tiers?.[tier] ?? body?.[tier] ?? body;
        if (!release || typeof release.version !== 'string' || !/^v?\d+(\.\d+){0,3}([.-][0-9A-Za-z.]+)?$/.test(release.version)) throw new Error('update feed has no usable "version" field');
        entry.ok = true;
        entry.latest = {
          version: release.version.replace(/^v/, ''), url: typeof release.url === 'string' && /^https?:\/\//.test(release.url) ? release.url : null,
          notes: typeof release.notes === 'string' ? release.notes.slice(0, 4000) : null, publishedAt: typeof release.publishedAt === 'string' ? release.publishedAt : null, tier,
          // Integrity fields are passed through for cPanel › Upgrade to Latest Version, which verifies the archive before installing it.
          sha256: typeof release.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(release.sha256) ? release.sha256.toLowerCase() : null,
          signature: typeof release.signature === 'string' && /^[A-Za-z0-9+/=_-]{1,1024}$/.test(release.signature) ? release.signature : null,
          keyId: typeof release.keyId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(release.keyId) ? release.keyId : null,
        };
      } catch (err) {
        entry.error = (err.name === 'TimeoutError' ? 'timed out after 10s' : err.message).split(url).join(entry.url);
      }
      settings.set('software.panel.last_check', entry);
      req?.audit?.({ action: 'software.panel.check', args: { url: entry.url, ok: entry.ok, latest: entry.latest?.version ?? null, error: entry.error } });
      return panel.status();
    },
    updateSettings({ url, tier, autoUpdate }, req) {
      const values = {};
      if (url !== undefined) values['software.update_url'] = url;
      if (tier !== undefined) values['updates.tier'] = tier;
      if (autoUpdate !== undefined) values['updates.auto'] = autoUpdate;
      settings.setMany(values);
      req?.audit?.({ action: 'software.panel.settings', args: { ...values, ...(url !== undefined ? { 'software.update_url': redactUrl(url) } : {}) } });
      return panel.status();
    },
  };

  // --- PHP versions ----------------------------------------------------------
  const inheritedDomains = () => {
    const seen = new Set();
    const out = [];
    for (const d of stmts.allDomains.all()) {
      if (seen.has(d.domain) || d.php_version || d.suspended) continue;
      seen.add(d.domain);
      out.push(d.domain);
    }
    return out;
  };

  // Applies one PHP version to a list of domains through the web category,
  // asking it to reload Apache only after the last one. Used by the resync and
  // bulk-apply jobs; never throws for a single failing domain.
  async function applyPhpToDomains(job, domains, version, { repool = false } = {}) {
    const failed = [];
    let applied = 0;
    for (const [i, domain] of domains.entries()) {
      job.progress(10 + Math.round((i / Math.max(1, domains.length)) * 85), domain);
      try {
        await ctx.web.setPhpVersion(domain, version, null, { reload: i === domains.length - 1, repool });
        applied++;
        job.log(`${domain}: ${version ?? 'inherit'} applied`);
      } catch (err) {
        failed.push({ domain, error: err.message });
        job.log(`${domain}: ${err.message}`, 'error');
      }
    }
    return { applied, failed };
  }

  // /usr/bin/php left on the packaged twin of a Keel build would make the
  // agent refuse the package removal (and the UI hides "Set as default" for a
  // row that already counts as the default): point it at the build.
  async function relinkCliToBuild(job, entry, defaultBinary) {
    if (!entry?.isDefault || !entry.packagedTwin || entry.layout !== 'keel' || !entry.binary || defaultBinary === entry.binary) return false;
    await job.agent.op('pkg.php.default.set', { version: entry.id });
    return true;
  }

  const php = {
    // Resellers only need the dropdown: binaries, ini paths, pool dirs, units
    // and the per-version module scan stay root-only.
    async versions({ modules = false, user = null } = {}) {
      requirePhp();
      const root = !user || isRoot(user);
      const result = await op('pkg.php.versions', { modules: root && modules });
      const configured = S('php.default_version', null);
      const effectiveDefault = result.versions.some((v) => v.id === configured) ? configured : result.defaultId;
      // Security Center's advisory rules (setting security.advisories) badge each
      // version here so MultiPHP Manager and the Security Advisor agree.
      const advisoriesFor = (v) => { try { return ctx.security?.phpAdvisories?.forVersion(v) ?? []; } catch { return []; } };
      const versions = result.versions.map((v) => ({ ...v, advisories: advisoriesFor(v) }));
      if (root) return { ...result, versions, configuredDefault: configured, effectiveDefault };
      return { versions: versions.map((v) => ({ id: v.id, label: v.label, version: v.version, isDefault: v.id === effectiveDefault, advisories: v.advisories })), defaultId: effectiveDefault, configuredDefault: configured, effectiveDefault };
    },
    async systemDefault() {
      const configured = S('php.default_version', null);
      let detected = null; let versions = [];
      if (capabilities.has('php')) { try { const r = await op('pkg.php.versions'); detected = r.defaultId; versions = r.versions; } catch (err) { logger.warn({ err }, 'php detection failed'); } }
      return { configured, detected, effective: versions.some((v) => v.id === configured) ? configured : detected ?? configured, versions: versions.map((v) => v.id) };
    },
    // The default is persisted at once; the per-domain vhost rewrites that
    // follow run as a job (one Apache pass per domain on the web side), so a
    // host with hundreds of domains does not tie up the request.
    async setSystemDefault(version, user, req) {
      const { versions } = await php.versions();
      if (!versions.some((v) => v.id === version)) throw unprocessable(`PHP "${version}" is not installed on this server`, { version: ['Pick one of the installed versions'] });
      let cli = { applied: false, note: null };
      try { cli = { applied: true, ...(await op('pkg.php.default.set', { version }, req)) }; } catch (err) { cli = { applied: false, note: err.message }; }
      settings.set('php.default_version', version);
      // The hostname site (webmail, phpMyAdmin) follows the default at once
      // through service-configuration's seam (contract §41.2), before the
      // inherited-domain job is queued so the order of the two cannot matter.
      let host = null;
      try { host = await ctx.web?.hostApps?.resyncPhpDefault?.(version, req) ?? null; } catch (err) { logger.warn({ err, version }, 'hostname site PHP resync failed'); host = { applied: false, error: err.message }; }
      const web = php.queueDefaultResync(version, user);
      req?.audit?.({ action: 'software.php.default', target: version, args: { cliApplied: cli.applied, web: web.state, domains: web.domains, jobId: web.job?.id ?? null, hostApplied: host?.applied ?? null, hostSocket: host?.socket ?? null, hostError: host?.error ?? null } });
      return { version, cli, web, host, job: web.job ?? null };
    },
    queueDefaultResync(version, user) {
      if (typeof ctx.web?.setPhpVersion !== 'function') return { state: 'not-loaded', domains: 0, job: null, detail: 'Service Configuration is not loaded; the web handler is unchanged.' };
      const pinned = ctx.web.apache?.settings?.()?.defaultPhpVersion ?? null;
      if (pinned) return { state: 'pinned', domains: 0, job: null, detail: `Apache Configuration pins the web default to ${pinned}; clear or change it there for this default to reach the web server.` };
      if (!capabilities.has('apache')) return { state: 'skipped', domains: 0, job: null, detail: 'Apache is not installed; the handler is applied when it is.' };
      const domains = inheritedDomains();
      if (!domains.length) return { state: 'applied', domains: 0, job: null, detail: 'No domain inherits the default yet.' };
      const job = enqueue('software.php.resync', { version, domains: domains.length }, user);
      return { state: 'queued', domains: domains.length, job, detail: `${domains.length} inherited domain(s) are being re-pinned to ${version} in job #${job.id}.` };
    },
    async resyncJob(job) {
      const { version } = job.params;
      if (typeof ctx.web?.setPhpVersion !== 'function') { job.log('Service Configuration is not loaded; nothing to apply'); return { version, applied: 0, failed: [], state: 'not-loaded' }; }
      const domains = inheritedDomains();
      job.log(`re-pinning ${domains.length} inherited domain(s) to PHP ${version}`);
      const { applied, failed } = await applyPhpToDomains(job, domains, version);
      job.progress(100, failed.length ? `${applied} applied, ${failed.length} failed` : 'done');
      if (failed.length && !applied) throw new Error(`No domain could be updated: ${failed.slice(0, 3).map((f) => `${f.domain} (${f.error})`).join('; ')}`);
      return { version, applied, failed, state: failed.length ? 'partial' : 'applied' };
    },
    // Paged in SQL: a server with tens of thousands of domains never materialises
    // them all per request (pageSize is capped by the route).
    async domains(user, { account, q, page = 1, pageSize = 500, sort, dir = 'asc' } = {}) {
      const def = await php.systemDefault();
      const where = []; const params = { def: def.effective ?? '' };
      if (!isRoot(user)) { where.push('d.owner_id = @owner'); params.owner = user.id; }
      if (account) { where.push('d.username = @account'); params.account = account; }
      if (q) { where.push("(d.domain LIKE @q ESCAPE '\\' OR d.username LIKE @q ESCAPE '\\')"); params.q = `%${likeEscape(q.toLowerCase())}%`; }
      const result = paginate(db, {
        select: 'd.*', from: `(${ALL_DOMAINS_SQL}) d`, where, params,
        sortable: { domain: 'd.domain', account: 'd.username', type: 'd.type', effective: 'COALESCE(d.php_version, @def)' }, defaultSort: 'domain',
        query: { page: Math.max(Number(page) || 1, 1), pageSize: Math.min(Math.max(Number(pageSize) || 500, 1), 500), sort, dir },
      });
      const domains = result.data.map((d) => ({ domain: d.domain, account: d.username, accountId: d.account_id, type: d.type, suspended: Boolean(d.suspended), docroot: docrootOf(d), phpVersion: d.php_version || null, effective: d.php_version || def.effective, inherited: !d.php_version }));
      return { data: { systemDefault: def, domains }, meta: result.meta };
    },
    versionForDomain(domain) {
      const row = stmts.accountDomain.get(domain) || (stmts.accountByDomain.get(domain) ? { php_version: null } : null);
      if (!row) return null;
      const configured = S('php.default_version', null);
      return { domain, phpVersion: row.php_version || null, effective: row.php_version || configured, inherited: !row.php_version };
    },
    // A single domain is applied inline; a batch is recorded at once and applied
    // by a job so the request returns before the web server is touched.
    async setDomainVersion(domains, version, user, req) {
      if (version) {
        const { versions } = await php.versions();
        if (!versions.some((v) => v.id === version)) throw unprocessable(`PHP "${version}" is not installed on this server`, { version: ['Pick one of the installed versions'] });
      }
      const targets = domains.map((domain) => resolveDomain(domain, user));
      const record = db.transaction(() => {
        for (const target of targets) {
          if (target.hasRow) stmts.setDomainPhp.run(version, target.domain);
          else stmts.insertMainDomain.run(target.accountId, target.domain, 'main', target.docroot, version);
        }
      });
      record();
      const linked = typeof ctx.web?.setPhpVersion === 'function';
      let job = null;
      const results = [];
      if (targets.length === 1 || !linked) {
        for (const target of targets) {
          let web = 'recorded';
          if (linked) {
            try { await ctx.web.setPhpVersion(target.domain, version, req); web = 'applied'; } catch (err) { logger.warn({ err, domain: target.domain }, 'web.setPhpVersion failed'); web = `failed: ${err.message}`; }
          }
          results.push({ domain: target.domain, account: target.username, phpVersion: version, web });
        }
      } else {
        job = enqueue('software.php.apply', { domains: targets.map((t) => t.domain), version }, user);
        for (const target of targets) results.push({ domain: target.domain, account: target.username, phpVersion: version, web: 'queued' });
      }
      req?.audit?.({ action: 'software.php.domain_version', target: domains.join(','), args: { version, domains, jobId: job?.id ?? null } });
      return { results, job };
    },
    async applyJob(job) {
      const { domains, version } = job.params;
      if (typeof ctx.web?.setPhpVersion !== 'function') { job.log('Service Configuration is not loaded; versions were recorded only'); return { version, applied: 0, failed: [], state: 'recorded' }; }
      job.log(`applying PHP ${version ?? 'inherit'} to ${domains.length} domain(s)`);
      const { applied, failed } = await applyPhpToDomains(job, domains, version);
      job.progress(100, failed.length ? `${applied} applied, ${failed.length} failed` : 'done');
      if (failed.length && !applied) throw new Error(`No domain could be updated: ${failed.slice(0, 3).map((f) => `${f.domain} (${f.error})`).join('; ')}`);
      return { version, applied, failed, state: failed.length ? 'partial' : 'applied' };
    },
    async pools(version) { requirePhp(); return op('pkg.phpfpm.pools', version ? { version } : {}); },

    // --- PHP Version Manager (contract §52) ---------------------------------
    // Pinned domains only: a main domain without an account_domains row inherits
    // the system default and counts for nothing.
    usage() {
      const out = {};
      for (const row of stmts.phpUsage.all()) out[row.id] = row.n;
      return out;
    },
    offeredVersions() {
      const v = S('php.offered_versions', null);
      return Array.isArray(v) ? v.map(String) : null;
    },
    async setOffered(versionIds, user, req) {
      let offered = null;
      if (versionIds !== null) {
        const { versions } = await php.versions();
        const unknown = versionIds.filter((id) => !versions.some((v) => v.id === id));
        if (unknown.length) throw unprocessable(`PHP ${unknown.join(', ')} is not installed on this server`, { versions: ['Only installed versions can be offered to accounts'] });
        offered = [...new Set(versionIds)];
      }
      settings.set('php.offered_versions', offered);
      req?.audit?.({ action: 'software.php.offered', target: offered ? offered.join(',') : 'all', args: { offered } });
      return { offered };
    },
    // Every version of the one-click catalog plus whatever else is installed,
    // from one pkg.php.versions, one runtimes.catalog() and one pkg.repo.status
    // per distinct repository. The catalog loads without PHP (nothing installed
    // yet) and without the network (repo state 'unknown').
    async catalog() {
      let installed = { versions: [], defaultId: null, configuredDefault: S('php.default_version', null), effectiveDefault: null };
      if (capabilities.has('php')) {
        try { installed = await php.versions({ modules: false }); } catch (err) { logger.warn({ err }, 'php version listing failed'); }
      }
      const rc = await runtimes.catalog({ updates: false });
      const crit = await updates.critical({ versions: installed.versions }).catch(() => null);
      const phpRuntime = rc.runtimes.find((r) => r.key === 'php') ?? { versions: [] };
      const offered = php.offeredVersions();
      const usage = php.usage();
      const dependants = (id) => php.dependants(id);
      const digits = (id) => String(id).replace(/[^0-9]/g, '');
      const findInstalled = (id) => installed.versions.find((x) => x.id === id || /php(\d+)$/.exec(String(x.id))?.[1] === digits(id) || String(x.version || '').startsWith(`${id}.`)) ?? null;
      const isOffered = (id, inst) => Boolean(inst) && (offered === null || offered.includes(id));
      const isSource = (inst) => Boolean(inst.source || inst.layout === 'keel');
      const twinOf = (inst) => (inst.packagedTwin ? { packagedTwin: { binary: inst.packagedTwin.binary ?? null, version: inst.packagedTwin.version ?? null, packagePrefix: inst.packagedTwin.packagePrefix ?? null, fpmUnit: inst.packagedTwin.fpmUnit ?? null }, packagePrefix: inst.packagedTwin.packagePrefix ?? null, twinNote: `Distribution packages ${inst.packagedTwin.version ?? ''} remain installed and unused; Remove packages drops them without touching the Keel build.`.replace(/\s+remain/, ' remain') } : {});
      const shapeInstalled = (inst) => ({ installed: true, version: inst.version ?? null, binary: inst.binary ?? null, iniPath: inst.iniPath ?? null, fpmInstalled: inst.fpmInstalled ?? null, fpmActive: inst.fpmActive ?? null, fpmUnit: inst.fpmUnit ?? null, isDefault: Boolean(inst.isDefault), isSystemDefault: inst.id === installed.effectiveDefault, advisories: inst.advisories ?? [], source: isSource(inst), layout: inst.layout ?? null, method: isSource(inst) ? 'source' : 'package', update: updates.rowUpdate(crit, 'php', inst.id), ...(isSource(inst) ? { prefix: `${PHP_SOURCE_PREFIX}/${inst.id}` } : {}), ...twinOf(inst) });
      const seen = new Set();
      const versions = phpRuntime.versions.map((v) => {
        const inst = findInstalled(v.id);
        if (inst) seen.add(inst.id);
        const id = inst ? inst.id : v.id;
        const rs = v.repoStatus ?? null;
        // pkg.php.versions decides "installed"; a missing version gets package / source / unsupported from the repo probe.
        const avail = inst ? { state: 'installed', note: null } : availability(RUNTIMES.php, v.repo, rs, rc.capability ? rc.family : null, rc.os, v.id);
        return {
          id, catalogVersion: v.id, label: inst ? inst.label ?? v.label : v.label, state: avail.state,
          ...(inst ? shapeInstalled(inst) : { installed: false, version: null, binary: null, iniPath: null, fpmInstalled: null, fpmActive: null, fpmUnit: null, isDefault: false, isSystemDefault: false, advisories: [], source: false, layout: null, method: avail.method, update: null, ...(avail.method === 'source' ? { prefix: `${PHP_SOURCE_PREFIX}/${v.id}` } : {}) }),
          offered: isOffered(id, inst), domains: usage[id] ?? 0, ...(inst ? dependants(id) : { webDefault: false, plans: 0, vhosts: 0 }), packages: avail.method === 'source' || (inst && isSource(inst)) ? [] : v.packages ?? [], repo: v.repo ?? null, repoStatus: rs, note: inst?.packagedTwin ? twinOf(inst).twinNote : avail.note ?? runtimeNote('php', rc.family),
        };
      });
      for (const inst of installed.versions) {
        if (seen.has(inst.id)) continue;
        versions.push({ id: inst.id, catalogVersion: null, label: inst.label ?? inst.id, state: 'installed', ...shapeInstalled(inst), offered: isOffered(inst.id, inst), domains: usage[inst.id] ?? 0, ...dependants(inst.id), packages: [], repo: null, repoStatus: null, note: inst.packagedTwin ? twinOf(inst).twinNote : null });
      }
      return { family: rc.family, os: rc.os, manager: rc.manager, capability: rc.capability, phpCapability: capabilities.has('php'), effectiveDefault: installed.effectiveDefault ?? null, configuredDefault: installed.configuredDefault ?? null, offered, versions, updates: crit ? updates.stamp(crit) : null };
    },
    // Everything that still resolves to the version: the Apache web default,
    // package plans and rendered vhosts (contract §52), besides pinned domains.
    dependants(version) {
      let webDefault = false; let vhosts = 0;
      try { webDefault = ctx.web?.apache?.settings?.()?.defaultPhpVersion === version; } catch { webDefault = false; }
      try { vhosts = Number(ctx.web?.vhostsUsingPhp?.(version) ?? 0) || 0; } catch { vhosts = 0; }
      return { webDefault, plans: stmts.packagesUsingPhp.get(version).n, vhosts };
    },
    // Shared by the request (422) and the job (TOCTOU re-check): the first
    // reason the version must stay, as [message, field hint], or null.
    async removeBlocker(version) {
      const { versions, effectiveDefault, defaultId } = await php.versions();
      const inst = versions.find((v) => v.id === version);
      if (!inst) return [`PHP "${version}" is not installed on this server`, 'Pick one of the installed versions'];
      if (version === effectiveDefault) return [`PHP ${version} is the system default; make another version the default before removing it`, 'Change the system default first'];
      if (inst.isDefault || version === defaultId) return [`PHP ${version} is the CLI default (/usr/bin/php); make another version the default before removing it`, 'Change the default first'];
      if (versions.length < 2) return [`PHP ${version} is the only installed version; install another one before removing it`, 'Install another version first'];
      const count = php.usage()[version] ?? 0;
      if (count > 0) return [`PHP ${version} is pinned on ${count} domain(s); move them to another version first`, `${count} domain(s) use this version`];
      const { webDefault, plans, vhosts } = php.dependants(version);
      if (webDefault) return [`PHP ${version} is the web default pinned in Apache Configuration; clear or change it there first`, 'Change the Apache web default first'];
      if (plans > 0) return [`PHP ${version} is the default of ${plans} package(s); change those packages first`, `${plans} package(s) use this version`];
      if (vhosts > 0) return [`PHP ${version} serves ${vhosts} web vhost(s); move them to another version first`, `${vhosts} vhost(s) use this version`];
      const apps = await php.hostAppsOn(version, versions, defaultId);
      if (apps.length) return [`PHP ${version} runs the hostname site's ${apps.join(' and ')} (webmail and phpMyAdmin are served on the PHP-FPM socket of the version the hostname site renders); publish them on another version first`, `${apps.join(' and ')} run on this version`];
      return null;
    },
    // The PHP version the hostname site's applications run on: the version
    // whose PHP-FPM socket the live site renders (the distro www socket or the
    // keel-host pool's php<ver>-fpm-keel-host.sock), else the
    // service-configuration helper's last recorded pool apply (a failed apply
    // overwrites it, so the live socket is asked first), else the distribution
    // default.
    async hostAppsPhpVersion(versions, defaultId) {
      let socket = null;
      if (typeof ctx.web?.hostname?.status === 'function') {
        try { socket = (await ctx.web.hostname.status())?.phpSocket ?? null; } catch (err) { logger.warn({ err }, 'hostname site status failed'); }
      }
      if (socket) {
        const debian = /\/php(\d+\.\d+)-fpm(?:-[A-Za-z0-9-]+)?\.sock$/.exec(socket)?.[1];
        const hit = versions.find((v) => v.id === debian) ?? versions.find((v) => v.id && socket.includes(`/${v.id}/`));
        if (hit) return hit.id;
      }
      if (typeof ctx.web?.hostApps?.phpVersion === 'function') {
        // { version, socket } | null (service-configuration), or a bare id.
        try { const v = await ctx.web.hostApps.phpVersion(); const id = typeof v === 'string' ? v : v?.version ?? null; if (id) return id; } catch (err) { logger.warn({ err }, 'host apps PHP version lookup failed'); }
      }
      return defaultId ?? null;
    },
    // Labels of the hostname-site applications (contract §41) that would lose
    // their PHP handler with this version; [] without a hostname site.
    async hostAppsOn(version, versions, defaultId) {
      if (typeof ctx.web?.hostApps?.list !== 'function') return [];
      let apps;
      try { apps = (await ctx.web.hostApps.list()).apps || []; } catch (err) { logger.warn({ err }, 'host app listing failed'); return []; }
      const phpApps = apps.filter((a) => a.php !== false && a.managed !== false);
      if (!phpApps.length) return [];
      if ((await php.hostAppsPhpVersion(versions, defaultId)) !== version) return [];
      return phpApps.map((a) => HOST_APP_LABELS[a.name] ?? a.name);
    },
    // The 422 for a removal the package manager would widen beyond php<ver>-*.
    collateralMessage(version, extra) {
      const appOf = (p) => HOST_APP_PACKAGES.find(([re]) => re.test(p))?.[1] ?? null;
      const apps = [...new Set(extra.map(appOf).filter(Boolean))];
      if (extra.some((p) => !appOf(p))) apps.push(apps.length ? 'whatever else depends on it' : 'what depends on it');
      return `Removing PHP ${version} would also remove ${extra.join(', ')} — move ${apps.join(' and ')} to another version first, or force the removal`;
    },
    // Removing only the distribution packages a Keel build shadows: the build
    // keeps serving the minor, so the default / usage guards do not apply — only
    // the hostname site must already render on the build's socket.
    async packagesBlocker(version) {
      const { versions } = await php.versions();
      const inst = versions.find((v) => v.id === version);
      if (!inst) return [`PHP "${version}" is not installed on this server`, 'Pick one of the installed versions'];
      if (inst.layout !== 'keel' || !inst.packagedTwin) return [`PHP ${version} has no distribution packages beside a Keel build; remove the version itself instead`, 'Not a Keel build with packages beside it'];
      // Pools and vhosts rendered before the build still point at the packaged
      // unit's sockets until the resync (Update) moved them onto the build.
      const usage = php.usage();
      const effective = (await php.systemDefault()).effective;
      if ((usage[version] || effective === version) && !php.keelResynced(version, inst.version)) return [`The domains on PHP ${version} still run on the distribution packages; run Update on PHP ${version} first so they move to the Keel build`, 'Update PHP first'];
      let socket = null;
      if (typeof ctx.web?.hostname?.status === 'function') {
        try { socket = (await ctx.web.hostname.status())?.phpSocket ?? null; } catch (err) { logger.warn({ err }, 'hostname site status failed'); }
      }
      if (socket && new RegExp(`/php${version.replace(/\./g, '\\.')}-fpm(?:-[A-Za-z0-9-]+)?\\.sock$`).test(socket) && !socket.includes('/keel-php/')) return [`The hostname site (webmail, phpMyAdmin) still runs on the PHP ${version} packages' socket ${socket}; run Update on PHP ${version} first so it moves to the Keel build`, 'Update PHP first'];
      return null;
    },
    async remove(version, user, req, { force = false, packages = false } = {}) {
      requirePhp();
      const blocker = packages ? await php.packagesBlocker(version) : await php.removeBlocker(version);
      if (blocker) throw unprocessable(blocker[0], { version: [blocker[1]] });
      // The package manager's dry run first: apt removes reverse dependencies
      // (roundcube-core, phpmyadmin) with the version packages.
      const sim = await op('pkg.php.remove', { version, dry: true, ...(packages ? { packages: true } : {}) }, req);
      const extra = Array.isArray(sim?.extra) ? sim.extra : [];
      if (extra.length && !force) throw unprocessable(php.collateralMessage(version, extra), { version: [`Removing it also removes ${extra.join(', ')}`], extra });
      const forced = Boolean(force && extra.length);
      // The confirmed collateral travels with the job: the agent refuses a forced
      // removal whose fresh simulation names anything beyond it.
      const job = enqueue('software.php.remove', { version, ...(force ? { force: true, extra } : {}), ...(packages ? { packages: true } : {}) }, user);
      req?.audit?.({ action: 'software.php.remove', target: version, args: { jobId: job.id, force: Boolean(force), forced, extra, packages: Boolean(packages) } });
      return { job, version, extra, forced, packages: Boolean(packages) };
    },
    async removeJob(job) {
      const { version, force = false, extra: confirmed = [], packages = false } = job.params;
      const blocker = packages ? await php.packagesBlocker(version) : await php.removeBlocker(version);
      if (blocker) throw new Error(`Removal of PHP ${version}${packages ? ' packages' : ''} refused: ${blocker[0]}`);
      if (force) job.log(`forced: packages outside PHP ${version}'s own prefix that depend on it are removed as well${confirmed.length ? ` (confirmed: ${confirmed.join(', ')})` : ''}`, 'warn');
      if (packages) {
        const { versions, defaultBinary } = await php.versions();
        const inst = versions.find((v) => v.id === version);
        if (await relinkCliToBuild(job, inst, defaultBinary)) job.log(`/usr/bin/php now points at the Keel build ${inst.binary}`);
      }
      job.progress(5, packages ? `removing the PHP ${version} distribution packages (the Keel build stays)` : `removing PHP ${version}`);
      const result = await runLongOp(job, 'pkg.php.remove', { version, ...(force ? { force: true, extra: confirmed } : {}), ...(packages ? { packages: true } : {}) }, `PHP ${version} removal`);
      job.progress(90, 're-detecting capabilities');
      await capabilities.refresh().catch((err) => { logger.warn({ err }, 'capability refresh after PHP removal failed'); job.log(`capability re-detection failed: ${err.message}`, 'warn'); });
      if (!packages) {
        const offered = php.offeredVersions();
        if (offered?.includes(version)) settings.set('php.offered_versions', offered.filter((id) => id !== version));
      }
      updates.invalidate();
      job.progress(100, 'done');
      return { version, packages: result.packages ?? [], removed: true, ...(packages ? { packagesOnly: true, keelKept: true, ...(result.keelPrefix ? { prefix: result.keelPrefix } : {}) } : { ...(result.layout ? { layout: result.layout } : {}), ...(result.prefix ? { prefix: result.prefix } : {}) }), ...(Array.isArray(result.extra) && result.extra.length ? { extra: result.extra, forced: true } : {}) };
    },
    // Direct update of an installed version (contract §63): the pending
    // packages of its prefix, or a fresh php.net build over a Keel prefix.
    async update(version, user, req) {
      requirePhp();
      const list = await updates.critical({ fresh: true });
      const item = list.items.find((i) => i.kind === 'php' && i.id === version);
      if (!item) {
        const { versions } = await php.versions();
        if (!versions.some((v) => v.id === version)) throw unprocessable(`PHP "${version}" is not installed on this server`, { version: ['Pick one of the installed versions'] });
        throw unprocessable(`PHP ${version} has no pending update`, { version: ['Nothing newer is available for it'] });
      }
      if (!item.candidate) throw unprocessable(`PHP ${version} is affected by ${item.reasons[0] ?? 'an advisory'}, but no newer build or package is available yet`, { version: ['No fix is available yet; check again later or move its sites to another version'] });
      const method = item.method ?? (item.layout === 'keel' ? 'source' : 'package');
      const build = method === 'source' ? item.build !== false : false;
      const fam = method === 'source' && build ? await family().catch(() => null) : null;
      if (method === 'source' && build && !PHP_BUILD_DEPS[fam]) throw unprocessable(`A PHP ${version} source build needs a package manager for its build dependencies`, { version: ['No supported package manager was found on this server'] });
      const job = enqueue('software.php.update', { version, layout: item.layout, candidate: item.candidate, current: item.current, packages: item.packages, unit: item.unit, method, build, ...(fam ? { family: fam } : {}) }, user);
      req?.audit?.({ action: 'software.php.update', target: version, args: { from: item.current, to: item.candidate, method, build, packages: item.packages, jobId: job.id } });
      return { job, version, candidate: item.candidate, method, build };
    },
    // Per minor, the build version every domain of that minor was last re-rendered onto (the source update's resync).
    keelResynced(minor, version) {
      const rec = S('software.php.keel_resynced', {}) || {};
      return rec[minor]?.version === version;
    },
    // After a source build replaced (or shadows) the packaged tree of a minor:
    // every domain pinned to it, the inherited ones when it is the default, and
    // the hostname site are rendered again, now on the Keel build's tree.
    async resyncMinor(job, version) {
      const effective = (await php.systemDefault()).effective ?? null;
      const pinned = stmts.domainsPinnedTo.all(version).map((d) => d.domain);
      const inherited = effective === version ? inheritedDomains() : [];
      const domains = [...new Set([...pinned, ...inherited])];
      let applied = 0; let failed = [];
      if (typeof ctx.web?.setPhpVersion !== 'function') job.log('Service Configuration is not loaded; no vhost or pool to re-render');
      else if (!domains.length) job.log(`no domain runs PHP ${version}`);
      else {
        job.log(`re-rendering ${pinned.length} pinned and ${inherited.length} inherited domain(s) on the PHP ${version} Keel build`);
        ({ applied, failed } = await applyPhpToDomains(job, domains, version, { repool: true }));
      }
      let host = null;
      try {
        const { versions, defaultId } = await php.versions();
        const hostVersion = await php.hostAppsPhpVersion(versions, defaultId);
        if ((hostVersion === version || effective === version) && typeof ctx.web?.hostApps?.resyncPhpDefault === 'function') {
          host = await ctx.web.hostApps.resyncPhpDefault(effective ?? version, null);
          job.log(`hostname site: ${host?.applied ? `rendered on ${host.socket ?? 'its pool'}` : `unchanged (${host?.reason ?? 'nothing to apply'})`}`);
        }
      } catch (err) { host = { applied: false, error: err.message }; job.log(`hostname site re-render failed: ${err.message}`, 'warn'); }
      return { domains: domains.length, pinned: pinned.length, inherited: inherited.length, applied, failed, host };
    },
    async updateJob(job) {
      const { version, layout, candidate, current, packages, unit, method } = job.params;
      job.log(`PHP ${version}: ${current ?? 'unknown'} → ${candidate} (${method === 'source' ? 'php.net source build' : JSON.stringify(packages)})`);
      let build = null; let restarted = false; let resync = null;
      const buildWanted = method === 'source' && job.params.build !== false;
      if (method === 'source') {
        if (buildWanted) {
          const fam = job.params.family ?? (capabilities.has('pkg') ? await job.agent.op('pkg.detect').then((d) => d.family).catch(() => null) : null);
          const deps = PHP_BUILD_DEPS[fam];
          if (!deps) throw new Error(`A PHP ${version} source build needs a package manager for its build dependencies`);
          job.progress(3, 'installing build dependencies');
          job.log(`build dependencies (${fam}): ${JSON.stringify(deps)}`);
          await runLongOp(job, 'pkg.install', { packages: deps }, 'build dependencies');
          job.progress(8, `downloading and building PHP ${candidate}`);
          await runLongOp(job, 'pkg.php.build', { minor: version }, `PHP ${version} build`);
          job.progress(75, `${layout === 'keel' ? 'restarting' : 'starting'} keel-php${version}-fpm`);
          build = await job.agent.op('pkg.php.build.finish', { minor: version });
          const unitName = build.unit ?? `keel-php${version}-fpm`;
          if (build.unitError || build.active === false) throw new Error(`PHP ${build.version ?? candidate} built but ${unitName} did not come back: ${build.unitError ?? 'unit inactive'}; see journalctl -u ${unitName}`);
          restarted = Boolean(build.restarted);
          job.log(`${unitName} ${restarted ? 'restarted' : 'started'} with PHP ${build.version ?? candidate}`);
        } else job.log(`PHP ${version} Keel build ${candidate} is already php.net's latest; re-rendering the domains on it`);
        job.progress(80, 're-detecting PHP versions');
        await capabilities.refresh().catch((err) => { logger.warn({ err }, 'capability refresh after PHP build failed'); job.log(`capability re-detection failed: ${err.message}`, 'warn'); });
        const detectedNow = await job.agent.op('pkg.php.versions');
        const now = detectedNow.versions.find((v) => v.id === version) ?? null;
        if (!now || now.layout !== 'keel') throw new Error(`PHP ${version} does not resolve to the Keel build after the build (found ${now ? `${now.layout} at ${now.binary}` : 'nothing'}); no domain was moved`);
        job.log(`PHP ${version} now resolves to the Keel build at ${now.binary}${now.packagedTwin ? ` (distribution packages ${now.packagedTwin.version ?? ''} remain installed and unused)`.replace(/\s+\)/, ')') : ''}`);
        if (await relinkCliToBuild(job, now, detectedNow.defaultBinary ?? null)) job.log(`/usr/bin/php now points at the Keel build ${now.binary}`);
        job.progress(82, `re-rendering the domains on PHP ${version}`);
        resync = await php.resyncMinor(job, version);
        if (resync.failed.length && !resync.applied) throw new Error(`No domain could be moved to the PHP ${version} Keel build: ${resync.failed.slice(0, 3).map((f) => `${f.domain} (${f.error})`).join('; ')}`);
        const rec = S('software.php.keel_resynced', {}) || {};
        settings.set('software.php.keel_resynced', { ...rec, [version]: { version: build?.version ?? now.version ?? candidate, at: new Date().toISOString() } });
      } else {
        job.progress(10, `upgrading ${packages.length} package(s)`);
        await runLongOp(job, 'pkg.upgrade', { packages, dist: false }, `PHP ${version} upgrade`);
        if (unit) {
          job.progress(80, `reloading ${unit}`);
          try { await job.agent.op('svc.reload', { unit }); restarted = true; job.log(`${unit} reloaded`); } catch (err) { job.log(`${unit} could not be reloaded: ${err.message}`, 'warn'); }
        }
        job.progress(85, 'checking what is still pending');
        try { recordCheck(await job.agent.op('pkg.upgradable')); } catch (err) { job.log(`post-upgrade check failed: ${err.message}`, 'warn'); }
      }
      job.progress(92, 're-detecting capabilities');
      await capabilities.refresh().catch((err) => { logger.warn({ err }, 'capability refresh after PHP update failed'); job.log(`capability re-detection failed: ${err.message}`, 'warn'); });
      let detected = null;
      try { detected = (await job.agent.op('pkg.php.versions')).versions.find((v) => v.id === version)?.version ?? null; job.log(`PHP ${version} now reports PHP_VERSION ${detected ?? 'unknown'}`); } catch (err) { job.log(`PHP re-detection failed: ${err.message}`, 'warn'); }
      updates.invalidate();
      job.progress(100, 'done');
      return { version, layout: layout ?? null, method, build: buildWanted, from: current ?? null, to: detected ?? build?.version ?? candidate, candidate, packages, restarted, updated: true, ...(resync ? { resync } : {}) };
    },
  };

  // --- php.ini / .user.ini ------------------------------------------------
  const ini = {
    directives: () => BASIC_DIRECTIVES,
    async readVersion(version, sapi) {
      requirePhp();
      const result = await op('pkg.php.ini.read', { version, ...(sapi ? { sapi } : {}) });
      return { ...result, basic: pickBasic(result.directives) };
    },
    async writeVersion(version, { content, directives, sapi, reloadFpm = true }, req) {
      requirePhp();
      const result = await op('pkg.php.ini.write', { version, ...(sapi ? { sapi } : {}), ...(content != null ? { content } : {}), ...(directives ? { directives } : {}) }, req);
      let reload = { attempted: false };
      if (reloadFpm && result.fpmUnit) {
        try { await op('svc.reload', { unit: result.fpmUnit }, req); reload = { attempted: true, ok: true, unit: result.fpmUnit }; } catch (err) { reload = { attempted: true, ok: false, unit: result.fpmUnit, error: err.message }; }
      }
      req?.audit?.({ action: 'software.php.ini.write', target: version, args: { path: result.path, directives: directives ? Object.keys(directives) : 'full-file', reload } });
      return { ...result, basic: pickBasic(result.directives), reload };
    },
    async readDomain(domain, user) {
      const target = resolveDomain(domain, user);
      const result = await op('pkg.php.userini.read', { docroot: target.docroot, owner: target.username });
      return { ...result, domain, account: target.username, basic: pickBasic(result.directives) };
    },
    async writeDomain(domain, { content, directives }, user, req) {
      const target = resolveDomain(domain, user);
      const result = await op('pkg.php.userini.write', { docroot: target.docroot, owner: target.username, ...(content != null ? { content } : {}), ...(directives ? { directives } : {}) }, req);
      req?.audit?.({ action: 'software.php.userini.write', target: domain, args: { path: result.path, directives: directives ? Object.keys(directives) : 'full-file' } });
      return { ...result, domain, account: target.username, basic: pickBasic(result.directives) };
    },
  };

  // --- NGINX reverse proxy -----------------------------------------------
  const nginxSettings = () => ({ enabled: Boolean(S('software.nginx.enabled', false)), cache: Boolean(S('software.nginx.cache', false)), apachePort: Number(S('software.nginx.apache_port', 8080)) || 8080, apacheSslPort: Number(S('software.nginx.apache_ssl_port', 8443)) || 8443, cacheMaxSizeMb: Number(S('software.nginx.cache_max_mb', 1024)) || 1024, cacheTtl: S('software.nginx.cache_ttl', '10m') || '10m', lastSync: S('software.nginx.last_sync', null), lastFingerprint: S('software.nginx.last_fingerprint', null) });
  const persistNginx = (s) => settings.setMany({ 'software.nginx.enabled': s.enabled, 'software.nginx.cache': s.cache, 'software.nginx.apache_port': s.apachePort, 'software.nginx.apache_ssl_port': s.apacheSslPort, 'software.nginx.cache_max_mb': s.cacheMaxSizeMb, 'software.nginx.cache_ttl': s.cacheTtl });
  const webLinked = () => typeof ctx.web?.setListenPorts === 'function';
  // nginx only ever proxies to 127.0.0.1:<apachePort>, so behind the proxy
  // Apache is pinned to loopback: the backend ports are not reachable from
  // outside and X-Forwarded-* cannot be forged around the proxy.
  const backendPorts = (s) => (s.enabled ? { http: s.apachePort, https: s.apacheSslPort, bind: BACKEND_BIND } : { http: 80, https: 443, bind: null });
  const backendBind = () => S('service_config.apache_ports', null)?.bind ?? null;
  const BACKEND_NOTE = `Apache now listens on the backend ports on ${BACKEND_BIND} only; nothing outside this host can bypass the proxy.`;
  const manualNote = (s) => (s.enabled ? `Make Apache listen on ${BACKEND_BIND}:${s.apachePort} (HTTP) and ${BACKEND_BIND}:${s.apacheSslPort} (HTTPS) in Service Configuration > Apache Configuration while the proxy is on.` : 'Make Apache listen on 80/443 again in Service Configuration > Apache Configuration.');

  const installedCert = (domain) => {
    if (typeof ctx.ssl?.certForDomain !== 'function' || typeof ctx.ssl?.bundlePaths !== 'function') return null;
    try {
      const cert = ctx.ssl.certForDomain(domain);
      if (cert && (cert.state === 'installed' || cert.installed > 0)) { const p = ctx.ssl.bundlePaths(domain); return { cert: p.fullchain, key: p.key }; }
    } catch (err) { logger.warn({ err, domain }, 'ssl lookup for nginx failed'); }
    return null;
  };

  // One entry per Apache vhost: main / addon / sub domains, each with the names
  // its vhost answers to (www. plus the account's parked and alias domains on
  // the main vhost), so HTTPS requests for those names reach the same block
  // instead of whichever ssl block nginx finds first. A parked domain with its
  // own installed certificate gets its own block.
  function proxyDomains() {
    const seen = new Set();
    const rows = [];
    for (const d of stmts.allDomains.all()) {
      if (seen.has(d.domain) || d.suspended) continue;
      seen.add(d.domain);
      rows.push(d);
    }
    const mainOf = new Map(stmts.accountMainDomains.all().map((a) => [a.id, a.domain]));
    const parkedByAccount = new Map();
    const out = [];
    for (const d of rows) {
      const ssl = installedCert(d.domain);
      if (['parked', 'alias'].includes(d.type) && !ssl) {
        const main = mainOf.get(d.account_id);
        if (main && main !== d.domain) { (parkedByAccount.get(d.account_id) || parkedByAccount.set(d.account_id, []).get(d.account_id)).push(d.domain); continue; }
      }
      const entry = { domain: d.domain, aliases: [`www.${d.domain}`], accountId: d.account_id, type: d.type };
      if (ssl) entry.ssl = ssl;
      out.push(entry);
    }
    for (const entry of out) {
      if (entry.type === 'main') entry.aliases.push(...(parkedByAccount.get(entry.accountId) || []));
      delete entry.accountId; delete entry.type;
    }
    return out;
  }

  async function nginxUnit(verb, req) {
    try { return { ok: true, ...(await op(`svc.${verb}`, { unit: 'nginx' }, req)) }; } catch (err) { return { ok: false, verb, error: err.message }; }
  }

  // Renders + `nginx -t` through the agent; the op leaves the host untouched when
  // the test fails, so callers may run this before changing anything else. The
  // sync time / fingerprint are only recorded by markSynced(), once the caller
  // knows the write is not going to be rolled back.
  async function writeProxy(s, req) {
    const domains = proxyDomains();
    const result = await op('pkg.nginx.proxy.write', { apachePort: s.apachePort, cache: s.cache, cacheMaxSizeMb: s.cacheMaxSizeMb, cacheTtl: s.cacheTtl, domains }, req);
    return { ...result, fingerprint: proxyFingerprint(s, domains), syncedAt: new Date().toISOString() };
  }
  const markSynced = (written) => settings.setMany({ 'software.nginx.last_sync': written.syncedAt, 'software.nginx.last_fingerprint': written.fingerprint });

  // A unit that was stopped + disabled by "disable proxy" is enabled again so
  // the proxy comes back after a reboot.
  async function startOrReload(req) {
    const status = await op('pkg.nginx.status');
    if (status.active) return nginxUnit('reload', req);
    const started = await nginxUnit('start', req);
    if (started.ok) started.enabledAtBoot = (await nginxUnit('enable', req)).ok;
    return started;
  }

  // nginx must let go of :80/:443 before Apache can take them back: the stock
  // default site proxy.remove restores listens on :80 again, so a reload would
  // keep the ports and Apache's restart would fail to bind. The unit is also
  // disabled so a reboot does not bring nginx up in front of Apache again.
  async function releasePorts(req) {
    const unit = await nginxUnit('stop', req);
    if (unit.ok) unit.disabledAtBoot = (await nginxUnit('disable', req)).ok;
    let active = null;
    try { active = (await op('pkg.nginx.status')).active; } catch (err) { logger.warn({ err }, 'nginx status after stop failed'); }
    unit.stillActive = active === true;
    unit.holdsPorts = !unit.ok ? active !== false : active === true;
    if (unit.holdsPorts) unit.hint = `nginx is still running and holds ports 80/443${unit.ok ? '' : ` (stop failed: ${unit.error})`}; stop it before Apache can listen there.`;
    return unit;
  }

  const SYNC_SCHEDULE = 'nginx-proxy-sync';
  // The schedule only fires while the proxy is on (contract: no job rows for work that is skipped).
  const syncSchedule = (enabled) => { try { ctx.scheduler?.update?.(SYNC_SCHEDULE, { enabled: Boolean(enabled) }); } catch (err) { logger.warn({ err }, 'nginx: schedule toggle failed'); } };

  const nginx = {
    async status() {
      let state = { installed: false, version: null, active: null, configPath: '/etc/nginx/conf.d/whm-proxy.conf', proxyConfigured: false, proxy: null };
      try { state = await op('pkg.nginx.status'); } catch (err) { logger.warn({ err }, 'nginx status failed'); }
      const s = nginxSettings();
      const domains = proxyDomains();
      const fingerprint = proxyFingerprint(s, domains);
      const stale = s.enabled && (!state.proxyConfigured || fingerprint !== s.lastFingerprint);
      const bind = backendBind();
      return { ...state, capability: capabilities.has('nginx'), settings: s, domains: domains.length, sslDomains: domains.filter((d) => d.ssl).length, stale, fingerprint, webLinked: webLinked(), backendBind: bind || 'all-interfaces', backendExposed: s.enabled && webLinked() && bind !== BACKEND_BIND, apacheCapability: capabilities.has('apache') };
    },
    install(user, req) {
      requirePkg();
      const job = enqueue('software.nginx.install', {}, user);
      req?.audit?.({ action: 'software.nginx.install', args: { jobId: job.id } });
      return { job };
    },
    async installJob(job) {
      job.progress(5, 'installing nginx');
      await runLongOp(job, 'pkg.install', { packages: ['nginx'] }, 'nginx install');
      try { await job.agent.op('svc.enable', { unit: 'nginx' }); job.log('nginx unit enabled'); } catch (err) { job.log(`nginx could not be started yet: ${err.message} (Apache probably still owns port 80; enable the proxy to move it)`, 'warn'); }
      await capabilities.refresh();
      job.progress(100, 'done');
      return { installed: true };
    },
    async configtest() { capabilities.require('nginx', 'nginx is not installed on this server'); return op('pkg.nginx.configtest'); },
    // Other categories call this after every certificate / domain change; it is
    // a no-op while the proxy is off. The NGINX Manager page asks for
    // requireInstalled so a missing nginx surfaces as the install prompt.
    async sync(req, { requireInstalled = false } = {}) {
      const s = nginxSettings();
      if (requireInstalled) capabilities.require('nginx', 'nginx is not installed on this server');
      if (!s.enabled) return { skipped: true, reason: 'proxy disabled' };
      capabilities.require('nginx', 'nginx is not installed on this server');
      const result = await writeProxy(s, req);
      markSynced(result);
      req?.audit?.({ action: 'software.nginx.sync', args: { domains: result.domains, sslDomains: result.sslDomains } });
      return { ...result, unit: await startOrReload(req) };
    },
    // Scheduled hourly while the proxy is on: re-renders only when the domains,
    // certificates or settings the config was rendered from have changed since
    // the last write.
    async syncJob(job) {
      const s = nginxSettings();
      if (!s.enabled) { job.log('proxy disabled; nothing to do'); return { skipped: true, reason: 'proxy disabled' }; }
      if (!capabilities.has('nginx')) { job.log('nginx is not installed; nothing to do'); return { skipped: true, reason: 'nginx missing' }; }
      let configured = true;
      try { configured = (await job.agent.op('pkg.nginx.status')).proxyConfigured; } catch (err) { job.log(`nginx status unavailable: ${err.message}`, 'warn'); }
      const domains = proxyDomains();
      const fingerprint = proxyFingerprint(s, domains);
      if (configured && fingerprint === s.lastFingerprint) { job.log('proxy config is current'); return { skipped: true, reason: 'current', domains: domains.length }; }
      job.log(`proxy config is out of date (${domains.length} domains, ${domains.filter((d) => d.ssl).length} with HTTPS); re-rendering`);
      const result = await writeProxy(s, null);
      markSynced(result);
      const unit = await startOrReload(null);
      job.log(`rendered ${result.domains} domains; nginx ${unit.ok ? `${unit.verb} ok` : `${unit.verb} failed: ${unit.error}`}`, unit.ok ? 'info' : 'error');
      if (!unit.ok) throw new Error(`nginx ${unit.verb} failed: ${unit.error}`);
      return { skipped: false, domains: result.domains, sslDomains: result.sslDomains, unit };
    },
    // Enable order: render + validate the proxy (nothing changes on failure), move
    // Apache, persist, start nginx; any later failure undoes the earlier steps so
    // the host never ends with Apache off :80 and no proxy in front of it.
    async configure({ enabled, cache, apachePort, apacheSslPort, cacheMaxSizeMb, cacheTtl }, req) {
      const before = nginxSettings();
      const next = { ...before, ...(enabled !== undefined ? { enabled } : {}), ...(cache !== undefined ? { cache } : {}), ...(apachePort !== undefined ? { apachePort } : {}), ...(apacheSslPort !== undefined ? { apacheSslPort } : {}), ...(cacheMaxSizeMb !== undefined ? { cacheMaxSizeMb } : {}), ...(cacheTtl !== undefined ? { cacheTtl } : {}) };
      if (next.enabled) capabilities.require('nginx', 'nginx is not installed on this server; install it first');
      if (next.enabled && next.apachePort === 80) throw unprocessable('Apache cannot stay on port 80 while NGINX listens there', { apachePort: ['Use another port, e.g. 8080'] });
      if (next.enabled && next.apacheSslPort === 443) throw unprocessable('Apache cannot stay on port 443 while NGINX terminates HTTPS there', { apacheSslPort: ['Use another port, e.g. 8443'] });
      if (next.enabled && next.apachePort === next.apacheSslPort) throw unprocessable('The HTTP and HTTPS backend ports must differ', { apacheSslPort: ['Pick a different port'] });
      let apache = { state: 'manual', detail: manualNote(next) };
      let proxy;
      if (next.enabled) {
        proxy = await writeProxy(next, req);
        const bindChanged = webLinked() && backendBind() !== BACKEND_BIND;
        const portsChanged = !before.enabled || before.apachePort !== next.apachePort || before.apacheSslPort !== next.apacheSslPort || bindChanged;
        if (webLinked() && portsChanged) {
          try { await ctx.web.setListenPorts(backendPorts(next), req); apache = { state: 'applied', detail: BACKEND_NOTE }; } catch (err) {
            try { if (before.enabled) await writeProxy(before, req); else await op('pkg.nginx.proxy.remove', {}, req); } catch (undo) { logger.warn({ err: undo }, 'nginx: proxy rollback after Apache failure failed'); }
            throw badRequest(`Apache could not be moved to the backend ports, so the proxy was not enabled: ${err.message}`);
          }
        } else if (webLinked()) {
          apache = { state: 'unchanged', detail: BACKEND_NOTE };
        }
        persistNginx(next);
        proxy.unit = await startOrReload(req);
        if (!proxy.unit.ok && apache.state === 'applied') {
          persistNginx(before);
          try { if (before.enabled) await writeProxy(before, req); else await op('pkg.nginx.proxy.remove', {}, req); } catch (undo) { logger.warn({ err: undo }, 'nginx: proxy rollback after unit failure failed'); }
          let restored = 'Apache was moved back';
          try { await ctx.web.setListenPorts(backendPorts(before), req); } catch (undo) { restored = `Apache could NOT be moved back (${undo.message}); fix it in Apache Configuration`; }
          req?.audit?.({ action: 'software.nginx.configure', args: { before, after: next, rolledBack: true, error: proxy.unit.error } });
          throw badRequest(`nginx ${proxy.unit.verb} failed (${proxy.unit.error}); the proxy settings were rolled back and ${restored}`);
        }
        markSynced(proxy);
        syncSchedule(true);
        if (!proxy.unit.ok) proxy.unit.hint = manualNote(next);
      } else {
        // Order: remove the managed config, stop nginx (it must release :80/:443),
        // persist, then hand the ports back to Apache. Apache is left on the
        // backend ports rather than restarted into a bind failure when nginx
        // could not be stopped.
        const hadProxy = before.enabled || (await op('pkg.nginx.status')).proxyConfigured;
        if (hadProxy) {
          proxy = await op('pkg.nginx.proxy.remove', {}, req);
          if (capabilities.has('nginx')) proxy.unit = await releasePorts(req);
        } else {
          proxy = { skipped: true };
        }
        persistNginx(next);
        syncSchedule(false);
        // Apache pinned to loopback is proxy state; a re-save after a stuck
        // disable moves it back once nginx has let go of the ports.
        const stillPinned = webLinked() && backendBind() === BACKEND_BIND;
        if (webLinked() && (before.enabled || hadProxy || stillPinned)) {
          let holdsPorts = proxy.unit?.holdsPorts ?? false;
          if (!proxy.unit && stillPinned && capabilities.has('nginx')) { try { holdsPorts = (await op('pkg.nginx.status')).active === true; } catch (err) { logger.warn({ err }, 'nginx status before moving Apache back failed'); holdsPorts = true; } }
          if (holdsPorts) {
            apache = { state: 'skipped', detail: `Apache was left on the backend ports because nginx still holds 80/443 (${proxy.unit ? (proxy.unit.ok ? 'still active after stop' : proxy.unit.error) : 'nginx is running'}). Stop nginx, then save again or ${manualNote(next).charAt(0).toLowerCase()}${manualNote(next).slice(1)}` };
          } else {
            try { await ctx.web.setListenPorts(backendPorts(next), req); apache = { state: 'applied', detail: `Apache listens on 80/443 on all interfaces again${proxy.unit?.ok ? '; nginx was stopped and disabled' : ''}.` }; } catch (err) { apache = { state: 'failed', detail: `${err.message}. ${manualNote(next)}` }; }
          }
        } else if (webLinked()) {
          apache = { state: 'unchanged', detail: null };
        } else if (proxy.unit?.ok) {
          apache.detail = `nginx was stopped and disabled. ${apache.detail}`;
        }
      }
      req?.audit?.({ action: 'software.nginx.configure', args: { before, after: next, apache: apache.state, bind: next.enabled ? BACKEND_BIND : null, nginxStopped: !next.enabled ? Boolean(proxy.unit?.ok) : undefined } });
      return { settings: next, apache, proxy, status: await nginx.status() };
    },
    async control(verb, req) {
      capabilities.require('nginx', 'nginx is not installed on this server');
      const result = await nginxUnit(verb, req);
      if (!result.ok) throw badRequest(`nginx ${verb} failed: ${result.error}`);
      req?.audit?.({ action: `software.nginx.${verb}` });
      return result;
    },
    async readConfig() { return (await op('pkg.nginx.status', { includeContent: true })).content ?? null; },
    proxyDomains,
    // Called from register(): a fresh schedules row is enabled by default, which
    // would enqueue skipped jobs on every host without a proxy. Operator tuning
    // of an enabled schedule is left alone.
    alignSchedule() { if (!nginxSettings().enabled) syncSchedule(false); },
  };

  // --- EasyApache 4 -----------------------------------------------------------
  const shapeProfile = (row, active) => ({ id: row.id, name: row.name, description: row.description, packages: json.parse(row.packages_json, { debian: [], rhel: [] }), stock: Boolean(row.stock), active: active === row.id, createdAt: row.created_at, updatedAt: row.updated_at });
  const loadProfile = (id) => { const row = stmts.profileById.get(id); if (!row) throw notFound('Profile'); return row; };
  const normalizePackages = (p = {}) => ({ debian: [...new Set(p.debian || [])], rhel: [...new Set(p.rhel || [])] });

  // apt/dnf take reverse dependencies down with a removal; the simulation says
  // which, so nothing outside the profile-managed set goes silently.
  async function simulateRemoval(packages, agentOp = op) {
    if (!packages.length) return { remove: [], collateral: [], error: null };
    try {
      const sim = await agentOp('pkg.remove_simulate', { packages });
      return { remove: sim.remove, collateral: sim.collateral, error: null };
    } catch (err) {
      return { remove: packages, collateral: null, error: err.message };
    }
  }

  const ea4 = {
    async profiles() {
      const active = S('software.ea4.active_profile', null);
      const fam = capabilities.has('pkg') ? await family().catch(() => null) : null;
      return { family: fam, activeProfileId: active, profiles: stmts.profiles.all().map((r) => shapeProfile(r, active)) };
    },
    get(id) { return shapeProfile(loadProfile(id), S('software.ea4.active_profile', null)); },
    catalog() { return EA4_CATALOG; },
    create({ name, description, packages }, req) {
      if (stmts.profileByName.get(name)) throw conflict(`A profile named "${name}" already exists`);
      const { lastInsertRowid } = stmts.insertProfile.run(name, description ?? null, JSON.stringify(normalizePackages(packages)));
      req?.audit?.({ action: 'software.ea4.profile.create', target: name, args: { packages } });
      return ea4.get(lastInsertRowid);
    },
    copy(id, name, req) {
      const src = loadProfile(id);
      if (stmts.profileByName.get(name)) throw conflict(`A profile named "${name}" already exists`);
      const { lastInsertRowid } = stmts.insertProfile.run(name, src.description ? `Copy of ${src.name}: ${src.description}` : `Copy of ${src.name}`, src.packages_json);
      req?.audit?.({ action: 'software.ea4.profile.copy', target: name, args: { from: src.name } });
      return ea4.get(lastInsertRowid);
    },
    update(id, { name, description, packages }, req) {
      const row = loadProfile(id);
      if (row.stock) throw conflict('Stock profiles are read-only; copy it to customise');
      const nextName = name ?? row.name;
      const clash = stmts.profileByName.get(nextName);
      if (clash && clash.id !== row.id) throw conflict(`A profile named "${nextName}" already exists`);
      stmts.updateProfile.run(nextName, description === undefined ? row.description : description, packages ? JSON.stringify(normalizePackages(packages)) : row.packages_json, id);
      req?.audit?.({ action: 'software.ea4.profile.update', target: nextName, args: { packages } });
      return ea4.get(id);
    },
    remove(id, req) {
      const row = loadProfile(id);
      if (row.stock) throw conflict('Stock profiles cannot be deleted');
      stmts.deleteProfile.run(id);
      if (S('software.ea4.active_profile', null) === id) settings.set('software.ea4.active_profile', null);
      req?.audit?.({ action: 'software.ea4.profile.delete', target: row.name });
      return { id, deleted: true };
    },
    async installed() {
      requirePkg();
      const fam = await family();
      const { manager, packages } = await op('pkg.list_installed', { prefix: EA4_PREFIXES[fam] || EA4_PREFIXES.debian });
      return { family: fam, manager, packages };
    },
    async diff(id, { simulate = true, agentOp = op } = {}) {
      requirePkg();
      const profile = ea4.get(id);
      const fam = await family();
      const target = new Set(profile.packages[fam] || []);
      const { packages } = await agentOp('pkg.list_installed', {});
      const installed = new Set(packages.map((p) => p.name));
      const managed = new Set(stmts.profiles.all().flatMap((r) => json.parse(r.packages_json, {})[fam] || []));
      const install = [...target].filter((p) => !installed.has(p));
      const remove = [...managed].filter((p) => installed.has(p) && !target.has(p));
      const unchanged = [...target].filter((p) => installed.has(p));
      const removal = simulate ? await simulateRemoval(remove, agentOp) : { remove, collateral: null, error: null };
      return { profile: { id: profile.id, name: profile.name }, family: fam, install, remove, unchanged, total: target.size, collateral: removal.collateral ?? null, simulationError: removal.error };
    },
    async build(id, { removeExtras = false, removeDependents = false } = {}, user, req) {
      requirePkg();
      const profile = ea4.get(id);
      const job = enqueue('software.ea4.build', { profileId: id, removeExtras, removeDependents }, user);
      req?.audit?.({ action: 'software.ea4.build', target: profile.name, args: { removeExtras, removeDependents, jobId: job.id } });
      return { job, profile: { id: profile.id, name: profile.name } };
    },
    async buildJob(job) {
      const { profileId, removeExtras, removeDependents } = job.params;
      const agentOp = (name, args) => job.agent.op(name, args);
      const diff = await ea4.diff(profileId, { simulate: Boolean(removeExtras), agentOp });
      job.log(`profile "${diff.profile.name}" on ${diff.family}: ${diff.install.length} to install, ${removeExtras ? diff.remove.length : 0} to remove, ${diff.unchanged.length} already present`);
      job.progress(10, 'resolving packages');
      const guardRemoval = (collateral, error) => {
        if (error) throw new Error(`The package manager could not simulate the removal (${error}); nothing was removed`);
        if (collateral.length && !removeDependents) throw new Error(`Removing ${diff.remove.join(', ')} would also remove ${collateral.map((p) => p.name).join(', ')}; run the build again with "also remove dependent packages" or keep those packages in the profile`);
        if (collateral.length) job.log(`dependent packages removed as well: ${collateral.map((p) => p.name).join(', ')}`, 'warn');
      };
      if (removeExtras && diff.remove.length) guardRemoval(diff.collateral ?? [], diff.simulationError);
      if (diff.install.length) {
        job.progress(20, `installing ${diff.install.length} package(s)`);
        await runLongOp(job, 'pkg.install', { packages: diff.install }, 'install');
      }
      let removed = [];
      if (removeExtras && diff.remove.length) {
        // Simulated again after the install step: the dependency graph has changed.
        job.progress(65, 'checking what the removal takes with it');
        const again = await simulateRemoval(diff.remove, agentOp);
        guardRemoval(again.collateral ?? [], again.error);
        job.progress(70, `removing ${diff.remove.length} package(s)`);
        await runLongOp(job, 'pkg.remove', { packages: diff.remove }, 'remove');
        removed = again.remove;
      }
      settings.set('software.ea4.active_profile', profileId);
      await capabilities.refresh();
      job.progress(100, 'build complete');
      return { profileId, installed: diff.install, removed, unchanged: diff.unchanged.length };
    },
    builds(limit = 20) { return ctx.jobs.list({ type: 'software.ea4.build', limit }); },
  };

  const jobs = {
    'software.pkg.install': (job) => pkgJob(job, 'pkg.install', { packages: job.params.packages, noRecommends: Boolean(job.params.noRecommends) }, 'installing packages'),
    'software.pkg.remove': (job) => pkgJob(job, 'pkg.remove', { packages: job.params.packages, purge: Boolean(job.params.purge) }, 'removing packages'),
    'software.pkg.update_index': (job) => pkgJob(job, 'pkg.update_index', {}, 'refreshing package index'),
    'software.system.update': (job) => update.runJob(job),
    'software.update.check': (job) => update.checkJob(job),
    'software.rpmdb.rebuild': (job) => rpm.rebuildJob(job),
    'software.perl.install': (job) => perl.installJob(job),
    'software.module.install': (job) => modules.installJob(job),
    'software.nginx.install': (job) => nginx.installJob(job),
    'software.nginx.sync': (job) => nginx.syncJob(job),
    'software.php.resync': (job) => php.resyncJob(job),
    'software.php.apply': (job) => php.applyJob(job),
    'software.php.remove': (job) => php.removeJob(job),
    'software.php.update': (job) => php.updateJob(job),
    'software.ea4.build': (job) => ea4.buildJob(job),
    'software.runtime.install': (job) => runtimes.installJob(job),
    'software.runtime.remove': (job) => runtimes.removeJob(job),
    'software.runtime.update': (job) => runtimes.updateJob(job),
  };

  return { pkg, update, updates, rpm, modules, perl, panel, php, ini, nginx, ea4, runtimes, jobs, resolveDomain, runs };
}
