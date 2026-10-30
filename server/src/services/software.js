import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, forbidden, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { componentByKey } from '../lib/stack-catalog.js';
import { PACKAGE_GROUPS, catalogEntries, entryByKey, packagesFor, phpExtensionPackage, matchesEntry } from '../lib/package-catalog.js';

// Software. Attached as ctx.software; other categories may call:
//   software.pkg.detect()                                   -> { manager: 'apt'|'dnf'|'yum'|null, family, rpm, capability }
//   software.pkg.isInstalled(names[])                       -> { name: boolean }
//   software.pkg.catalog({ q, group, refresh })             -> the curated package catalog (lib/package-catalog.js) with installed / offered state per entry
//   software.pkg.installEntry(key, { phpVersion }, user, req) -> job (202 semantics) installing one catalog entry's packages for this family
//   software.pkg.search(q, { limit, all })                  -> { results: [{ name, summary, installed, variants: [...] }], total, hidden, more } (deduped unless all)
//   software.pkg.ensureInstalled(names[], { user, req })    -> { missing, job } (enqueues an install job when something is missing)
//   software.pkg.install(names[], user, req)                -> job (202 semantics)
//   software.php.versions()                                 -> { versions: [{ id, version, binary, iniPath, poolDir, fpmUnit, isDefault, advisories }], defaultId }
//   software.php.systemDefault()                            -> { configured, detected, effective }
//   software.php.versionForDomain(domain)                   -> { domain, phpVersion, effective, inherited } or null
//   software.php.setDomainVersion(domains[], version|null, user, req) -> { results, job } (job when more than one domain)
//   software.php.installable()                              -> { source, stock, versions: [{ version, id, offered, installed, isDefault, inUse, removable }] }
//   software.php.installVersion(branch, user, req)          -> { job } (enables the family's PHP source when needed, installs, enables FPM)
//   software.php.removeVersion(id, user, req)               -> { job } (409 for the default or a version domains still use)
//   software.nginx.status()                               -> install + proxy state (never throws CapabilityError); stale: true when the
//                                                              rendered proxy no longer matches the current domains / certificates
//   software.nginx.sync(req)                                -> re-render the reverse-proxy config from current domains and certificates;
//                                                              { skipped: true } when the proxy is disabled, so SSL/TLS and Accounts
//                                                              should call ctx.software?.nginx.sync(req) after installing a certificate
//                                                              or creating / removing a domain (an hourly schedule, enabled only while
//                                                              the proxy is on, catches the rest)
// software.update.status({ cached })                      -> pending OS updates; cached: true serves the last recorded check
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

export function createSoftwareService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;
  const op = (name, args = {}, req) => agent.op(name, args, { req });
  const S = (key, fallback) => { const v = settings.get(key, fallback); return v === undefined ? fallback : v; };
  const hostname = () => S('basic.hostname', '') || os.hostname() || 'localhost';
  // Security alerts (Server Contacts) are a courtesy: an update run never fails
  // because the notice could not be recorded.
  const raiseSecurityAlert = (input) => { try { return ctx.securityAlerts?.raise?.(input) ?? null; } catch (err) { logger.warn({ err, kind: input.kind }, 'security alert not raised'); return null; } };

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
    phpUsage: db.prepare('SELECT php_version, COUNT(*) AS n FROM account_domains WHERE php_version IS NOT NULL GROUP BY php_version'),
    phpUsageFor: db.prepare('SELECT COUNT(*) AS n FROM account_domains WHERE php_version = ?'),
    profiles: db.prepare('SELECT * FROM ea4_profiles ORDER BY stock DESC, name'),
    profileById: db.prepare('SELECT * FROM ea4_profiles WHERE id = ?'),
    profileByName: db.prepare('SELECT * FROM ea4_profiles WHERE name = ?'),
    insertProfile: db.prepare('INSERT INTO ea4_profiles (name, description, packages_json, stock) VALUES (?, ?, ?, 0)'),
    updateProfile: db.prepare(`UPDATE ea4_profiles SET name = ?, description = ?, packages_json = ?, updated_at = datetime('now') WHERE id = ?`),
    deleteProfile: db.prepare('DELETE FROM ea4_profiles WHERE id = ?'),
  };

  const requirePkg = () => capabilities.require('pkg', 'No supported package manager (apt-get, dnf or yum) was found on this server');
  const likeEscape = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
  const requirePhp = () => capabilities.require('php', 'PHP is not installed on this server; install a php package (Install Distro Packages or EasyApache 4)');
  const enqueue = (type, params, user) => ctx.jobs.enqueue(type, params, { userId: user?.id ?? null });
  const docrootOf = (row) => row.docroot || `${row.home_dir || `/home/${row.username}`}/public_html`;

  // Where a hostname lives and who may touch it. Root may address any hostname.
  function resolveDomain(domain, user) {
    const main = stmts.accountByDomain.get(domain);
    const sub = main ? null : stmts.accountDomain.get(domain);
    const row = main ? { ...main, type: 'main', username: main.username, docroot: null } : sub;
    if (!row) throw notFound(`Domain "${domain}"`);
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That domain belongs to another reseller');
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
    async search(q, { limit = 60, all = false } = {}) { requirePkg(); return op('pkg.search', { q, limit, all: Boolean(all) }); },
    async info(name) { requirePkg(); return op('pkg.info', { name }); },
    // The curated catalog with what this host has and what its repositories
    // offer. Installed state comes from one dpkg/rpm listing; the offered state
    // of everything not installed from one pkg.offers call, kept for a while
    // because it is the slow part and only an index refresh or an install
    // changes it (pkgJob drops the cache after each of those).
    async catalog({ q, group, refresh = false } = {}) {
      requirePkg();
      const detected = await pkg.detect();
      const fam = detected.family === 'rhel' ? 'rhel' : detected.family === 'debian' ? 'debian' : null;
      if (!fam) throw new CapabilityError('pkg', 'No supported package manager (apt-get, dnf or yum) was found on this server');
      let phpVersions = [];
      if (capabilities.has('php')) { try { phpVersions = (await php.versions()).versions; } catch (err) { logger.warn({ err }, 'php detection failed'); } }
      const entries = catalogEntries();
      const wanted = new Set();
      for (const e of entries) for (const n of packagesFor(e, fam, { phpVersions })) wanted.add(n);
      const listing = await op('pkg.list_installed', {});
      const installed = new Map(listing.packages.map((p) => [p.name, p.version]));
      const offers = await offersFor([...wanted].filter((n) => !installed.has(n)), { refresh, family: fam });
      const packageState = (name) => ({ name, installed: installed.has(name), version: installed.get(name) ?? null, offered: installed.has(name) ? true : offers.known ? Boolean(offers.map[name]?.offered) : null, candidate: offers.map[name]?.candidate ?? null });
      const shape = (e) => {
        const names = packagesFor(e, fam, { phpVersions });
        const packages = names.map(packageState);
        const notInstalled = packages.filter((p) => !p.installed);
        const offered = !notInstalled.length ? true : notInstalled.some((p) => p.offered === null) ? null : notInstalled.every((p) => p.offered);
        const perVersion = e.php && phpVersions.length ? phpVersions.map((v) => ({ id: v.id, label: v.label || `PHP ${v.id}`, ...packageState(phpExtensionPackage(e, v, fam)) })) : null;
        return {
          key: e.key, label: e.label, description: e.description, category: e.category, recommended: e.recommended, stack: e.stack, capability: e.capability,
          requires: e.requires?.[fam] ?? null, configure: e.configure, packages,
          installed: packages.length > 0 && notInstalled.length === 0, partial: notInstalled.length > 0 && notInstalled.length < packages.length,
          offered, missing: notInstalled.filter((p) => p.offered === false).map((p) => p.name), php: e.php ? { versions: perVersion ?? [], unversioned: !perVersion } : null,
        };
      };
      const shaped = entries.filter((e) => (!group || e.category === group) && matchesEntry(e, q)).map(shape);
      const groups = PACKAGE_GROUPS.map((g) => ({ ...g, entries: shaped.filter((e) => e.category === g.key) })).filter((g) => g.entries.length);
      return { manager: detected.manager, family: fam, phpVersions: phpVersions.map((v) => ({ id: v.id, label: v.label || `PHP ${v.id}`, layout: v.layout ?? null })), installedTotal: listing.total, offersKnown: offers.known, offersAt: offers.at, entries: shaped.length, total: entries.length, groups };
    },
    async installEntry(key, { phpVersion } = {}, user, req) {
      requirePkg();
      const entry = entryByKey(key);
      if (!entry) throw notFound(`Catalog entry "${key}"`);
      const fam = (await family()) === 'rhel' ? 'rhel' : 'debian';
      let phpVersions = [];
      if (entry.php && capabilities.has('php')) { try { phpVersions = (await php.versions()).versions; } catch (err) { logger.warn({ err }, 'php detection failed'); } }
      if (phpVersion && !entry.php) throw unprocessable(`"${entry.label}" is not a PHP extension; it has no per-version package`, { phpVersion: ['Leave phpVersion out for this entry'] });
      if (phpVersion && !phpVersions.some((v) => v.id === phpVersion)) throw unprocessable(`PHP "${phpVersion}" is not installed on this server`, { phpVersion: ['Pick one of the installed versions'] });
      const packages = phpVersion ? [phpExtensionPackage(entry, phpVersions.find((v) => v.id === phpVersion), fam)] : packagesFor(entry, fam, { phpVersions });
      if (!packages.length) throw unprocessable(`"${entry.label}" has no packages for the ${fam} family`, { key: ['Nothing to install on this host'] });
      const job = enqueue('software.pkg.install', { packages, noRecommends: false, catalogEntry: key }, user);
      req?.audit?.({ action: 'software.pkg.catalog.install', target: key, args: { packages, phpVersion: phpVersion ?? null, family: fam, jobId: job.id } });
      return { job, key, packages };
    },
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

  // Offered state of names not installed, from pkg.offers in batches; an agent
  // without the op (or a failing one) leaves the state unknown rather than
  // failing the catalog page.
  const OFFERS_TTL_MS = 15 * 60_000;
  let offersCache = null;
  async function offersFor(names, { refresh = false, family: fam } = {}) {
    const now = Date.now();
    if (!refresh && offersCache && offersCache.family === fam && now - offersCache.at < OFFERS_TTL_MS && names.every((n) => n in offersCache.map)) return offersCache;
    const map = {};
    let known = true;
    for (let i = 0; i < names.length; i += 300) {
      const chunk = names.slice(i, i + 300);
      try { Object.assign(map, (await op('pkg.offers', { packages: chunk })).packages); } catch (err) { logger.warn({ err }, 'pkg.offers failed; offered state unknown'); known = false; }
    }
    offersCache = known ? { at: now, family: fam, map, known } : null;
    return { at: known ? now : null, family: fam, map, known };
  }

  async function pkgJob(job, opName, args, label) {
    job.log(`${label}: ${JSON.stringify(args.packages || args)}`);
    job.progress(5, label);
    const result = await runLongOp(job, opName, args, label);
    offersCache = null;
    job.progress(100, 'finished');
    return { manager: result.manager, packages: result.packages, purge: result.purge, lines: result.output?.length ?? 0 };
  }

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
      const securityApplied = upgraded.filter((p) => p.security);
      if (securityApplied.length) {
        raiseSecurityAlert({
          kind: 'updates.security_applied', title: `Emergency security update applied: ${securityApplied.length} package${securityApplied.length === 1 ? '' : 's'} on ${hostname()}`,
          body: securityApplied.slice(0, 50).map((p) => `${p.name} ${p.current ?? ''} -> ${p.candidate ?? ''}`.trim()).join('\n'),
          dedupeKey: `updates.security_applied:${job.job.id}`, source: `software.system.update#${job.job.id}`,
          data: { count: securityApplied.length, packages: securityApplied.slice(0, 50).map((p) => p.name), rebootRequired: Boolean(rebootRequired), stillPending: after.count, jobId: job.job.id },
        });
      }
      return { upgraded: upgraded.length, packages: upgraded.map((p) => p.name), stillPending: after.count, rebootRequired, securityApplied: securityApplied.length };
    },
    async checkJob(job) {
      if (!capabilities.has('pkg')) { job.log('no package manager detected; skipping'); return { skipped: true }; }
      // Without a fresh index the simulation only sees what the last refresh knew.
      job.progress(5, 'refreshing package index');
      try { await runLongOp(job, 'pkg.update_index', {}, 'package index refresh'); } catch (err) { job.log(`package index refresh failed: ${err.message}; checking against the current index`, 'warn'); }
      job.progress(40, 'checking for updates');
      const pending = recordCheck(await job.agent.op('pkg.upgradable'));
      job.log(`${pending.count} pending update(s), ${pending.security} security`);
      if (pending.security > 0) {
        const names = pending.packages.filter((p) => p.security).map((p) => p.name).sort();
        raiseSecurityAlert({
          kind: 'updates.security_available', title: `${pending.security} security update${pending.security === 1 ? '' : 's'} available on ${hostname()}`,
          body: names.slice(0, 50).join(', ') + (names.length > 50 ? ', …' : ''),
          dedupeKey: `updates.security_available:${crypto.createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16)}`, source: `software.update.check#${job.job.id}`,
          data: { count: pending.count, security: pending.security, packages: names.slice(0, 50), rebootRequired: Boolean(pending.rebootRequired), autoApply: Boolean(S('software.updates.auto_os', false)) },
        });
      }
      if (pending.count > 0 && S('software.updates.auto_os', false)) {
        job.log('automatic OS updates are enabled; applying');
        const run = enqueue('software.system.update', { dist: true, autoremove: true, refreshIndex: false }, null);
        return { count: pending.count, security: pending.security, autoJobId: run.id };
      }
      return { count: pending.count, security: pending.security };
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
      return { ...detected, capabilities: { perl: capabilities.has('perl'), cpan: capabilities.has('cpan'), pecl: capabilities.has('pecl'), pear: capabilities.has('pear'), gem: capabilities.has('gem'), pip: capabilities.has('pip') } };
    },
    async list(kind) {
      const [listOp, , cap, , plural] = MODULE_OPS[kind];
      capabilities.require(cap, `${kind} is not installed on this server`);
      const result = await op(listOp);
      return { kind, items: result[plural] || [] };
    },
    install(kind, { name, version }, user, req) {
      const [, installOp, cap, argName] = MODULE_OPS[kind];
      const [pattern, hint] = MODULE_NAMES[kind];
      if (!pattern.test(name)) throw unprocessable(`"${name}" is not a valid ${kind} name`, { name: [hint] });
      capabilities.require(cap, `${kind} is not installed on this server`);
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
          // A release flagged "security" by the feed raises a security alert once per version.
          security: release.security === true || release.security === 'true' || (Array.isArray(release.tags) && release.tags.includes('security')),
        };
      } catch (err) {
        entry.error = (err.name === 'TimeoutError' ? 'timed out after 10s' : err.message).split(url).join(entry.url);
      }
      settings.set('software.panel.last_check', entry);
      req?.audit?.({ action: 'software.panel.check', args: { url: entry.url, ok: entry.ok, latest: entry.latest?.version ?? null, error: entry.error } });
      if (entry.ok && entry.latest.security && compareVersions(entry.latest.version, ctx.version) > 0) {
        raiseSecurityAlert({
          kind: 'panel.security_release', title: `Panel security release ${entry.latest.version} is available (running ${ctx.version})`,
          body: entry.latest.notes ? entry.latest.notes.slice(0, 2000) : `Release ${entry.latest.version} on the ${entry.latest.tier} tier is flagged as a security release.`,
          dedupeKey: `panel.security_release:${entry.latest.version}`, source: 'software.panel.check',
          data: { version: entry.latest.version, currentVersion: ctx.version, url: entry.latest.url, tier: entry.latest.tier, publishedAt: entry.latest.publishedAt },
        });
      }
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
  async function applyPhpToDomains(job, domains, version) {
    const failed = [];
    let applied = 0;
    for (const [i, domain] of domains.entries()) {
      job.progress(10 + Math.round((i / Math.max(1, domains.length)) * 85), domain);
      try {
        await ctx.web.setPhpVersion(domain, version, null, { reload: i === domains.length - 1 });
        applied++;
        job.log(`${domain}: ${version ?? 'inherit'} applied`);
      } catch (err) {
        failed.push({ domain, error: err.message });
        job.log(`${domain}: ${err.message}`, 'error');
      }
    }
    return { applied, failed };
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
      const web = php.queueDefaultResync(version, user);
      req?.audit?.({ action: 'software.php.default', target: version, args: { cliApplied: cli.applied, web: web.state, domains: web.domains, jobId: web.job?.id ?? null } });
      return { version, cli, web, job: web.job ?? null };
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

    // --- install / remove branches ----------------------------------------
    // Works without any PHP on the host: that is when it matters most. The
    // agent's source catalog (ppa:ondrej/php, packages.sury.org, Remi) decides
    // what each family can offer; the install job enables the source on first use.
    async installable() {
      requirePkg();
      const detect = await op('pkg.php.sources.detect');
      let installed = { versions: [], defaultId: null, effectiveDefault: null };
      if (capabilities.has('php')) { try { installed = await php.versions(); } catch (err) { logger.warn({ err }, 'php detection failed'); } }
      const byId = new Map(installed.versions.map((v) => [v.id, v]));
      const inUse = Object.fromEntries(stmts.phpUsage.all().map((r) => [r.php_version, r.n]));
      const effectiveDefault = installed.effectiveDefault ?? installed.defaultId ?? null;
      const shape = (v, found) => ({
        version: v.version, id: v.id, label: found?.label ?? `PHP ${v.version}`, offered: Boolean(v.offered), installed: Boolean(found) || Boolean(v.installed), installedVersion: found?.version ?? v.installedVersion ?? null,
        candidate: v.candidate ?? null, source: v.source ?? null, fpmUnit: found?.fpmUnit ?? v.fpmUnit ?? null, layout: found?.layout ?? null, stock: Boolean(detect.stock) && detect.stock === v.version,
        isDefault: Boolean(found) && found.id === effectiveDefault, isCliDefault: Boolean(found?.isDefault), inUse: inUse[v.id] ?? 0, advisories: found?.advisories ?? [],
        removable: Boolean(found) && found.id !== effectiveDefault && !found.isDefault && !(inUse[v.id] ?? 0) && ['debian', 'remi'].includes(found.layout) && Boolean(branchOf(found)),
      });
      const versions = detect.versions.map((v) => shape(v, byId.get(v.id)));
      // Installed trees outside the branch catalog (ea-php*, rh-php*, the stock RHEL php) are listed read-only.
      for (const found of installed.versions) if (!versions.some((x) => x.id === found.id)) versions.push(shape({ version: branchOf(found) ?? found.version?.match(/^\d\.\d/)?.[0] ?? found.id, id: found.id, offered: false, installed: true }, found));
      const recent = ctx.jobs.list({ limit: 100 }).filter((j) => j.type === 'software.php.install' || j.type === 'software.php.remove').slice(0, 10);
      return { manager: detect.manager, family: detect.family, os: detect.os, source: detect.source, stock: detect.stock, effectiveDefault, versions, recent };
    },
    async installVersion(version, user, req) {
      requirePkg();
      if (capabilities.has('php')) {
        const [{ versions }, fam] = await Promise.all([php.versions(), family()]);
        const id = fam === 'debian' ? version : `php${version.replace('.', '')}`;
        if (versions.some((v) => v.id === id)) throw conflict(`PHP ${version} is already installed on this server (${id})`);
      }
      const job = enqueue('software.php.install', { version }, user);
      req?.audit?.({ action: 'software.php.install', target: version, args: { version, jobId: job.id } });
      return { job, version };
    },
    async installJob(job) {
      const { version } = job.params;
      job.progress(3, 'checking package sources');
      let detect = await job.agent.op('pkg.php.sources.detect', { branches: [version] });
      const host = `${detect.os?.name || detect.family}${detect.os?.codename ? ` (${detect.os.codename})` : ''}`;
      job.log(`${host}: PHP source ${detect.source.label || 'none'} is ${detect.source.configured ? 'configured' : 'not configured'}; stock branch ${detect.stock || 'unknown'}`);
      let entry = detect.versions[0];
      let sourceEnabled = false;
      if (!entry?.offered) {
        if (!detect.source.key || !detect.source.supported) throw new Error(`PHP ${version} is not offered by the configured repositories and no PHP package source is available for this host${detect.source.reason ? ` (${detect.source.reason})` : ''}`);
        if (detect.source.configured) throw new Error(`PHP ${version} is not offered by ${detect.source.label} for ${host}`);
        job.progress(10, `enabling ${detect.source.label}`);
        const enabled = await runLongOp(job, 'pkg.php.source.enable', { source: detect.source.key }, `enable ${detect.source.label}`);
        for (const step of enabled.steps || []) job.log(`${step.step}: ${step.ok ? 'ok' : `failed${step.output ? ` (${step.output})` : ''}`}`, step.ok ? 'info' : 'warn');
        sourceEnabled = Boolean(enabled.changed);
        detect = await job.agent.op('pkg.php.sources.detect', { branches: [version] });
        entry = detect.versions[0];
        if (!entry?.offered) throw new Error(`PHP ${version} is still not offered after enabling ${detect.source.label}; it may not be published for ${host} yet`);
      }
      job.log(`PHP ${version}: ${entry.package} ${entry.candidate || entry.installedVersion || ''} from ${entry.source || 'the distribution'}`);
      job.progress(30, `installing PHP ${version}`);
      const result = await runLongOp(job, 'pkg.php.install', { version, extensions: phpExtensionsFor(detect.family) }, `PHP ${version} install`);
      job.log(`installed ${result.packages.length} package(s): ${result.packages.join(', ')}`);
      if (result.skipped?.length) job.log(`not offered by any repository, skipped: ${result.skipped.join(', ')}`, 'warn');
      job.progress(80, `enabling ${result.fpmUnit}`);
      let unit = result.unit?.enabled == null ? null : result.unit;
      if (!unit) {
        try { await job.agent.op('svc.enable', { unit: result.fpmUnit }); unit = { unit: result.fpmUnit, enabled: true, note: null }; } catch (err) { unit = { unit: result.fpmUnit, enabled: false, note: err.message }; }
      }
      job.log(`${result.fpmUnit}: ${unit.enabled ? 'enabled and started' : `could not be enabled: ${unit.note}`}`, unit.enabled ? 'info' : 'warn');
      job.progress(90, 'refreshing detection');
      await refreshPhpDetection(job);
      job.progress(100, 'done');
      return { version, id: result.id, packages: result.packages, skipped: result.skipped ?? [], fpmUnit: result.fpmUnit, unitEnabled: unit.enabled, source: detect.source.key, sourceEnabled };
    },
    async removeVersion(id, user, req) {
      requirePkg();
      const { versions, effectiveDefault } = await php.versions();
      const entry = versions.find((v) => v.id === id);
      if (!entry) throw notFound(`PHP version "${id}"`);
      if (entry.id === effectiveDefault) throw conflict(`PHP ${id} is the system default; make another version the default before removing it`);
      if (entry.isDefault) throw conflict(`PHP ${id} is what /usr/bin/php resolves to (CLI default); make another version the default before removing it`);
      const used = stmts.phpUsageFor.get(id).n;
      if (used) throw conflict(`PHP ${id} is still used by ${used} domain(s); move them to another version first`);
      const version = branchOf(entry);
      if (!version || !['debian', 'remi'].includes(entry.layout)) throw unprocessable(`PHP ${id} was not installed as a versioned package set and cannot be removed from here`, { id: ['Only php8.x-* (Debian/Ubuntu) and Remi php8x-php-* sets can be removed'] });
      const job = enqueue('software.php.remove', { id, version }, user);
      req?.audit?.({ action: 'software.php.remove', target: id, args: { version, jobId: job.id } });
      return { job, id, version };
    },
    async removeJob(job) {
      const { id, version } = job.params;
      // Re-checked here: a domain may have been moved onto it since the request.
      const used = stmts.phpUsageFor.get(id).n;
      if (used) throw new Error(`PHP ${id} is now used by ${used} domain(s); nothing was removed`);
      job.progress(10, `removing PHP ${version}`);
      const result = await runLongOp(job, 'pkg.php.remove', { version }, `PHP ${version} removal`);
      job.log(`removed ${result.packages.length} package(s): ${result.packages.join(', ')}`);
      job.progress(90, 'refreshing detection');
      await refreshPhpDetection(job);
      job.progress(100, 'done');
      return { id, version, packages: result.packages, fpmUnit: result.fpmUnit };
    },
  };

  // '8.3' for Debian ids (8.3) and Remi ids (php83); null for ea-php*/rh-php*/system.
  function branchOf(entry) {
    const m = String(entry?.id ?? '').match(/^(\d)\.(\d)$/) || String(entry?.id ?? '').match(/^php(\d)(\d)$/);
    return m ? `${m[1]}.${m[2]}` : null;
  }
  // The stack catalog's php component, as the suffixes the agent turns into php8.3-<x> / php83-php-<x>.
  function phpExtensionsFor(fam) {
    const names = componentByKey('php')?.packages?.[fam] || [];
    return names.map((n) => n.replace(/^php-/, '')).filter((n) => n && !['fpm', 'cli', 'common'].includes(n) && /^[a-z][a-z0-9-]{0,31}$/.test(n));
  }
  // Capabilities, the web category's PHP-FPM tree cache and php-fpm detection
  // all see the new (or removed) branch at once.
  async function refreshPhpDetection(job) {
    await capabilities.refresh();
    try { const fpm = await job.agent.op('web.phpfpm.detect'); job.log(`PHP-FPM trees on this host: ${(fpm.versions || []).map((v) => v.version).join(', ') || 'none'}`); } catch (err) { job.log(`php-fpm detection: ${err.message}`, 'warn'); }
    try { await ctx.web?.detect?.(true); } catch (err) { logger.warn({ err }, 'web detect refresh failed'); }
  }

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
    'software.php.install': (job) => php.installJob(job),
    'software.php.remove': (job) => php.removeJob(job),
    'software.ea4.build': (job) => ea4.buildJob(job),
  };

  return { pkg, update, rpm, modules, perl, panel, php, ini, nginx, ea4, jobs, resolveDomain, runs };
}
