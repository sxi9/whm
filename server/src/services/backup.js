import path from 'node:path';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, unprocessable, CapabilityError, HttpError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { isValidCron } from '../lib/cron.js';
import { reconcileHtaccess, htaccessSummary, htaccessFields } from '../lib/htaccess.js';

// Backup. Attached as ctx.backup; other categories (Transfers, Account Functions)
// may call:
//   backup.archiveAccount(username, { destDir, include }, user, req) -> builds an archive now (not a job) and records it
//   backup.registerArchive(path, user, req)                         -> records an existing local archive (cpmove / imported) as a backup row
//   backup.enqueueRestore({ backupId, kind, options }, user, req)   -> 202 job restoring an account or selected files
//   backup.enqueueRun({ accounts }, user, req)                      -> 202 job backing up the given (or every included) account
//   backup.listBackups({ account }, user) / getBackup(id, user)
//   backup.destinationConfig(id)                                    -> decrypted destination config (root-only callers)
//   backup.localDir()                                               -> the configured local archive directory

export const DESTINATION_KINDS = ['local', 'ftp', 'sftp', 'webdav', 's3'];
export const SETTING_KEYS = ['backup.enabled', 'backup.schedule', 'backup.retention_daily', 'backup.retention_weekly', 'backup.retention_monthly', 'backup.local_dir', 'backup.include_home', 'backup.include_mail', 'backup.include_dbs', 'backup.include_dns', 'backup.include_metadata', 'backup.compression_level', 'backup.strict', 'backup.keep_local', 'backup.prune_remote', 'backup.default_include', 'backup.skip_suspended', 'backup.excludes', 'backup.notify_on_failure'];
const DEFAULTS = {
  'backup.enabled': false, 'backup.schedule': '0 2 * * *', 'backup.retention_daily': 7, 'backup.retention_weekly': 4, 'backup.retention_monthly': 3,
  'backup.local_dir': '/backup', 'backup.include_home': true, 'backup.include_mail': true, 'backup.include_dbs': true, 'backup.include_dns': true, 'backup.include_metadata': true,
  'backup.compression_level': 6, 'backup.strict': false, 'backup.keep_local': true, 'backup.prune_remote': true, 'backup.default_include': true, 'backup.skip_suspended': false,
  'backup.excludes': ['tmp', 'logs', '.cache'], 'backup.notify_on_failure': true,
};
const SECRET_FIELDS = ['password', 'secretKey', 'privateKey'];
const SCHEDULE_NAME = 'backup-run';
// Hand-copied archives are registered from the panel's own directories only;
// a file in an account home is moved there by root first.
const IMPORT_ROOTS = ['/backup', '/var/backups/whm'];
// Ops declared with a longer agent-side timeout than the socket client's 1 h
// default get a matching per-call timeout (contract §5).
const LONG_OPS = { 'backup.account.archive': 7_200_000, 'backup.archive.extract': 7_200_000, 'backup.files.restore': 7_200_000, 'backup.db.import': 7_200_000, 'backup.destination.upload': 7_200_000, 'backup.destination.download': 7_200_000, 'backup.archive.verify': 3_600_000 };
const RESTORABLE_DOMAIN_TYPES = ['addon', 'sub', 'parked', 'alias'];

const isCapabilityMissing = (err) => err instanceof CapabilityError || err?.code === 'capability_missing' || err?.code === 'binary_not_found';

// Day-1 of the month → monthly, Sunday → weekly, else daily, as long as that
// class is retained; the newest N of each class survive pruning.
export function retentionClassFor(date, retention) {
  const d = new Date(date);
  if (retention.monthly > 0 && d.getUTCDate() === 1) return 'monthly';
  if (retention.weekly > 0 && d.getUTCDay() === 0) return 'weekly';
  return 'daily';
}

export function planPrune(backups, retention) {
  const remove = [];
  for (const cls of ['daily', 'weekly', 'monthly']) {
    const keep = Number(retention[cls]) || 0;
    const rows = backups.filter((b) => b.retention_class === cls && !b.pinned).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    remove.push(...rows.slice(keep));
  }
  return remove;
}

// The database a GRANT line names (SHOW GRANTS form), with MySQL's "\_" /
// "\%" escapes removed; null when the line is not a database grant.
export function grantDatabase(line) {
  const m = String(line).match(/^GRANT (.+?) ON (\*|`[^`]*(?:``[^`]*)*`|[^ ]+)\.(\*|`[^`]+`|[^ ]+) TO /i);
  if (!m) return null;
  const unq = (v) => (v.startsWith('`') ? v.slice(1, -1).replace(/``/g, '`') : v);
  return unq(m[2]).replace(/\\([_%])/g, '$1');
}

// Archive docroots point into the home the archive was taken from; they are
// moved under the current home (another home root, a renamed mount).
export function rewriteDocroot(docroot, sourceHome, home) {
  if (typeof docroot !== 'string' || !docroot.startsWith('/')) return null;
  if (sourceHome && (docroot === sourceHome || docroot.startsWith(`${sourceHome}/`))) return `${home}${docroot.slice(sourceHome.length)}`;
  const m = docroot.match(/^\/[^/]+\/[^/]+(\/.*)?$/);
  return m ? `${home}${m[1] || ''}` : null;
}

export function publicDestinationConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config || {})) {
    if (SECRET_FIELDS.includes(k)) out[`has_${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`] = Boolean(v);
    else out[k] = v;
  }
  return out;
}

export function createBackupService(ctx) {
  const { db, agent, capabilities, settings, crypto, logger, jobs, scheduler } = ctx;

  const stmts = {
    accounts: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id ORDER BY a.username'),
    accountByUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    accountDomains: db.prepare('SELECT domain, type, docroot, php_version FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    mailDomains: db.prepare('SELECT m.domain, m.routing FROM mail_domains m WHERE m.account_id = ? OR m.domain IN (SELECT domain FROM account_domains WHERE account_id = ?)'),
    selection: db.prepare('SELECT * FROM backup_user_selection WHERE account_id = ?'),
    selectionAll: db.prepare('SELECT * FROM backup_user_selection'),
    upsertSelection: db.prepare(`INSERT INTO backup_user_selection (account_id, enabled) VALUES (?, ?) ON CONFLICT (account_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`),
    destinations: db.prepare('SELECT * FROM backup_destinations ORDER BY name'),
    destinationById: db.prepare('SELECT * FROM backup_destinations WHERE id = ?'),
    destinationByName: db.prepare('SELECT id FROM backup_destinations WHERE name = ?'),
    insertDestination: db.prepare(`INSERT INTO backup_destinations (name, kind, config_enc, enabled, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`),
    updateDestination: db.prepare(`UPDATE backup_destinations SET name = @name, kind = @kind, config_enc = @config_enc, enabled = @enabled, updated_at = datetime('now') WHERE id = @id`),
    testDestination: db.prepare(`UPDATE backup_destinations SET last_test_at = datetime('now'), last_test_ok = ?, last_test_message = ? WHERE id = ?`),
    deleteDestination: db.prepare('DELETE FROM backup_destinations WHERE id = ?'),
    // Ownership comes from the row (owner_id, fixed when it was written), never
    // from whichever account currently carries the username; the join only
    // tells whether such an account exists today.
    backupById: db.prepare('SELECT b.*, a.id AS live_account_id, a.home_dir AS live_home_dir FROM backups b LEFT JOIN accounts a ON a.username = b.account_name WHERE b.id = ?'),
    backupsForAccount: db.prepare("SELECT * FROM backups WHERE account_id = ? AND account_name = ? AND status = 'done'"),
    backupByPath: db.prepare('SELECT id FROM backups WHERE path = ?'),
    lastBackupFor: db.prepare("SELECT id, created_at, size, status FROM backups WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"),
    insertBackup: db.prepare(`INSERT INTO backups (account_id, account_name, owner_id, type, path, size, sha256, status, run_id, retention_class, components_json, error, local_present, created_at)
      VALUES (@account_id, @account_name, @owner_id, @type, @path, @size, @sha256, @status, @run_id, @retention_class, @components_json, @error, @local_present, COALESCE(@created_at, datetime('now')))`),
    updateBackupLocal: db.prepare('UPDATE backups SET local_present = ?, path = COALESCE(?, path) WHERE id = ?'),
    pinBackup: db.prepare('UPDATE backups SET pinned = ? WHERE id = ?'),
    deleteBackup: db.prepare('DELETE FROM backups WHERE id = ?'),
    uploadsFor: db.prepare('SELECT * FROM backup_uploads WHERE backup_id = ? ORDER BY id'),
    insertUpload: db.prepare('INSERT INTO backup_uploads (backup_id, destination_id, destination_name, remote_path, status, error) VALUES (?, ?, ?, ?, ?, ?)'),
    uploadStatus: db.prepare('UPDATE backup_uploads SET status = ?, error = ? WHERE id = ?'),
    insertRun: db.prepare('INSERT INTO backup_runs (job_id, kind, status, started_by, accounts_total) VALUES (?, ?, ?, ?, ?)'),
    runJob: db.prepare('UPDATE backup_runs SET job_id = ? WHERE id = ?'),
    runById: db.prepare('SELECT * FROM backup_runs WHERE id = ?'),
    runStart: db.prepare("UPDATE backup_runs SET status = 'running', accounts_total = ? WHERE id = ?"),
    runFinish: db.prepare("UPDATE backup_runs SET status = ?, accounts_ok = ?, accounts_failed = ?, bytes = ?, summary_json = ?, error = ?, finished_at = datetime('now') WHERE id = ?"),
    runs: db.prepare('SELECT r.*, j.status AS job_status FROM backup_runs r LEFT JOIN jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT ?'),
    lastRun: db.prepare("SELECT * FROM backup_runs WHERE status IN ('done', 'failed') ORDER BY id DESC LIMIT 1"),
    insertRestore: db.prepare('INSERT INTO backup_restores (backup_id, account_name, owner_id, kind, options_json, started_by) VALUES (?, ?, ?, ?, ?, ?)'),
    restoreJob: db.prepare('UPDATE backup_restores SET job_id = ? WHERE id = ?'),
    restoreById: db.prepare('SELECT * FROM backup_restores WHERE id = ?'),
    restoreStart: db.prepare("UPDATE backup_restores SET status = 'running' WHERE id = ?"),
    restoreFinish: db.prepare("UPDATE backup_restores SET status = ?, summary_json = ?, error = ?, finished_at = datetime('now') WHERE id = ?"),
    restores: db.prepare('SELECT * FROM backup_restores WHERE (@owner IS NULL OR owner_id = @owner) AND (@account IS NULL OR account_name = @account) ORDER BY id DESC LIMIT @limit'),
    abandonRun: db.prepare("UPDATE backup_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'running')"),
    abandonRestore: db.prepare("UPDATE backup_restores SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'running')"),
    runsOfJob: db.prepare("SELECT id FROM backup_runs WHERE job_id = ? AND status IN ('queued', 'running')"),
    restoresOfJob: db.prepare("SELECT id FROM backup_restores WHERE job_id = ? AND status IN ('queued', 'running')"),
    orphanedRuns: db.prepare("SELECT r.id, r.job_id, j.status AS job_status, j.error AS job_error FROM backup_runs r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.status IN ('queued', 'running') AND (j.id IS NULL OR j.status NOT IN ('queued', 'running')) ORDER BY r.id"),
    orphanedRestores: db.prepare("SELECT r.id, r.job_id, j.status AS job_status, j.error AS job_error FROM backup_restores r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.status IN ('queued', 'running') AND (j.id IS NULL OR j.status NOT IN ('queued', 'running')) ORDER BY r.id"),
    userById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
    dbProfileSecret: db.prepare('SELECT * FROM db_instances WHERE id = ?'),
    dnsZonesFor: db.prepare('SELECT domain FROM dns_zones WHERE account_id = ? ORDER BY domain'),
    databasesOf: db.prepare('SELECT name FROM databases WHERE account_id = ?'),
    insertDomain: db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot, php_version) VALUES (?, ?, ?, ?, ?)'),
    // Current owners of the objects an archive may carry, re-checked at restore time.
    dbOwner: db.prepare('SELECT d.account_id, a.username AS account FROM databases d LEFT JOIN accounts a ON a.id = d.account_id WHERE d.name = ?'),
    dbUserOwner: db.prepare('SELECT u.account_id, a.username AS account FROM db_users u LEFT JOIN accounts a ON a.id = u.account_id WHERE u.name = ?'),
    zoneOwner: db.prepare('SELECT z.account_id, a.username AS account FROM dns_zones z LEFT JOIN accounts a ON a.id = z.account_id WHERE z.domain = ?'),
    domainOwner: db.prepare('SELECT d.account_id, a.username AS account FROM account_domains d LEFT JOIN accounts a ON a.id = d.account_id WHERE d.domain = ?'),
    mailDomainOwner: db.prepare('SELECT m.account_id, a.username AS account FROM mail_domains m LEFT JOIN accounts a ON a.id = m.account_id WHERE m.domain = ?'),
  };
  const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

  const setting = (key) => settings.get(key, DEFAULTS[key]);
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const homeOf = (account) => account.home_dir || `${setting('basic.home_root') || '/home'}/${account.username}`;
  const localDir = () => String(setting('backup.local_dir') || '/backup').replace(/\/+$/, '') || '/backup';
  const retention = () => ({ daily: Number(setting('backup.retention_daily')) || 0, weekly: Number(setting('backup.retention_weekly')) || 0, monthly: Number(setting('backup.retention_monthly')) || 0 });

  // A request-like principal for the job worker, so the categories involved in a
  // restore audit and authorise as the user who asked for it.
  function actorRequest(userId, requestId) {
    const user = (userId && stmts.userById.get(userId)) || { id: null, username: 'scheduler', role: 'root' };
    const req = { user, ip: null, id: requestId ?? null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }
  // Bookkeeping in other categories (database map, raw zone import) is root-only;
  // the job performs it on behalf of the actor after ownership was checked at enqueue.
  const SYSTEM_ROOT = { id: null, username: 'backup', role: 'root' };

  function loadAccount(username, user) {
    const row = stmts.accountByUsername.get(username);
    if (!row) throw notFound(`Account "${username}"`);
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return row;
  }

  async function requireTar() {
    await capabilities.ensureFresh();
    capabilities.require('backup', 'tar/gzip are not installed on this server; install the tar and gzip packages to use backups');
  }

  function translate(err) {
    if (isCapabilityMissing(err)) return new CapabilityError('backup', err.message);
    if (err?.code === 'path_not_allowed') return unprocessable(`${err.message}. Backup directories must be under /backup, /var/backups/whm, /var/lib/whm or a home root.`, { dir: [err.message] });
    if (err?.code === 'not_found') return notFound(err.message);
    if (err?.code === 'exists') return conflict(err.message);
    if (err?.code === 'invalid_args') return unprocessable(`The agent rejected the request: ${err.message}`, err.details?.fields);
    if (err?.code === 'destination_failed') return new HttpError(502, 'destination_failed', err.message);
    return err;
  }

  async function op(name, args, req) {
    const opts = { req };
    if (LONG_OPS[name]) opts.timeoutMs = LONG_OPS[name] + 60_000;
    try { return await agent.op(name, args, opts); } catch (err) { throw translate(err); }
  }

  // ----------------------------------------------------------- settings ---

  function config() {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = setting(k);
    return out;
  }

  function syncSchedule() {
    const cron = String(setting('backup.schedule') || DEFAULTS['backup.schedule']);
    try { scheduler.update(SCHEDULE_NAME, { cron, enabled: Boolean(setting('backup.enabled')) }); } catch (err) { logger.warn({ err }, 'could not update the backup schedule'); }
  }

  // Resellers get the capability banner and their own account count only; the
  // destinations, directory, schedule and run history are server configuration.
  async function status(user = SYSTEM_ROOT) {
    await capabilities.ensureFresh();
    const snap = capabilities.snapshot();
    const bins = snap.binaries || {};
    const capability = { installed: capabilities.has('backup'), binaries: { tar: Boolean(bins.tar), gzip: Boolean(bins.gzip), curl: Boolean(bins.curl), mysqldump: Boolean(bins.mysqldump || bins['mariadb-dump']) } };
    if (!isRoot(user)) {
      const own = (a) => a.owner_id === user.id;
      return { capability, includedAccounts: includedAccounts().filter(own).length, totalAccounts: stmts.accounts.all().filter(own).length };
    }
    let dir = { path: localDir(), exists: null };
    try { const st = await agent.op('fs.stat', { path: localDir() }); dir = { path: localDir(), exists: Boolean(st?.exists), isDirectory: st?.isDirectory ?? null, mode: st?.mode ?? null }; } catch (err) { dir = { path: localDir(), exists: null, error: err.message }; }
    return {
      capability,
      localDir: dir,
      schedule: scheduler.list().find((s) => s.name === SCHEDULE_NAME) ?? null,
      destinations: stmts.destinations.all().map(shapeDestination),
      lastRun: shapeRun(stmts.lastRun.get()),
      includedAccounts: includedAccounts().length,
      totalAccounts: stmts.accounts.all().length,
    };
  }

  async function updateConfig(input, req) {
    const next = {};
    for (const [k, v] of Object.entries(input)) if (SETTING_KEYS.includes(k)) next[k] = v;
    if (!Object.keys(next).length) throw badRequest('No backup settings supplied');
    if (next['backup.schedule'] !== undefined) {
      const cron = String(next['backup.schedule']).trim();
      if (!isValidCron(cron)) throw unprocessable('Invalid cron expression', { 'backup.schedule': ['Must be a valid 5-field cron expression (minute hour day-of-month month day-of-week)'] });
      next['backup.schedule'] = cron;
    }
    if (next['backup.local_dir'] !== undefined) {
      const dir = String(next['backup.local_dir']).replace(/\/+$/, '');
      await op('fs.mkdir', { path: dir, mode: '0700', owner: 'root' }, req);
      next['backup.local_dir'] = dir;
    }
    settings.setMany(next);
    syncSchedule();
    audit(req, { action: 'backup.config.update', args: next });
    return { settings: config(), status: await status() };
  }

  // ------------------------------------------------------- destinations ---

  function shapeDestination(row) {
    if (!row) return null;
    let cfg = {};
    try { cfg = row.config_enc ? JSON.parse(crypto.decrypt(row.config_enc)) : {}; } catch { cfg = { error: 'configuration could not be decrypted' }; }
    return { id: row.id, name: row.name, kind: row.kind, enabled: Boolean(row.enabled), config: publicDestinationConfig(cfg), lastTest: row.last_test_at ? { at: row.last_test_at, ok: Boolean(row.last_test_ok), message: row.last_test_message } : null, created_at: row.created_at, updated_at: row.updated_at };
  }

  function destinationConfig(row) {
    const r = typeof row === 'object' ? row : stmts.destinationById.get(row);
    if (!r) throw notFound('Destination');
    const cfg = r.config_enc ? JSON.parse(crypto.decrypt(r.config_enc)) : {};
    return { kind: r.kind, ...cfg };
  }

  function loadDestination(id) {
    const row = stmts.destinationById.get(id);
    if (!row) throw notFound('Destination');
    return row;
  }

  function createDestination({ name, kind, enabled = true, config: cfg }, req) {
    if (stmts.destinationByName.get(name)) throw conflict(`A destination named "${name}" already exists`);
    const { kind: _k, ...rest } = cfg;
    const { lastInsertRowid } = stmts.insertDestination.run(name, kind, crypto.encrypt(JSON.stringify(rest)), enabled ? 1 : 0);
    audit(req, { action: 'backup.destination.create', target: name, args: { kind, config: publicDestinationConfig(rest) } });
    return shapeDestination(stmts.destinationById.get(lastInsertRowid));
  }

  // Secrets left empty in an update keep their stored value; an explicit null
  // removes one (switching an SFTP destination from a key to a password).
  function updateDestination(id, patch, req) {
    const row = loadDestination(id);
    const current = destinationConfig(row);
    const kind = patch.config?.kind || row.kind;
    let merged;
    if (patch.config) {
      const { kind: _k, ...incoming } = patch.config;
      merged = kind === row.kind ? { ...current, ...incoming } : { ...incoming };
      delete merged.kind;
      for (const f of SECRET_FIELDS) {
        if (incoming[f] === null) { delete merged[f]; continue; }
        if (kind === row.kind && (incoming[f] === '' || incoming[f] === undefined) && current[f] !== undefined) merged[f] = current[f];
      }
    } else { merged = { ...current }; delete merged.kind; }
    if (patch.name && patch.name !== row.name && stmts.destinationByName.get(patch.name)) throw conflict(`A destination named "${patch.name}" already exists`);
    stmts.updateDestination.run({ id, name: patch.name ?? row.name, kind, config_enc: crypto.encrypt(JSON.stringify(merged)), enabled: patch.enabled == null ? row.enabled : patch.enabled ? 1 : 0 });
    audit(req, { action: 'backup.destination.update', target: patch.name ?? row.name, args: { kind, enabled: patch.enabled, config: patch.config ? publicDestinationConfig(merged) : undefined } });
    return shapeDestination(stmts.destinationById.get(id));
  }

  function removeDestination(id, req) {
    const row = loadDestination(id);
    stmts.deleteDestination.run(id);
    audit(req, { action: 'backup.destination.remove', target: row.name });
    return { id, removed: true };
  }

  async function testDestination(id, req) {
    const row = loadDestination(id);
    const result = await op('backup.destination.test', { config: destinationConfig(row) }, req);
    stmts.testDestination.run(result.ok ? 1 : 0, result.message, id);
    audit(req, { action: 'backup.destination.test', target: row.name, args: { ok: result.ok, message: result.message }, result: result.ok ? 'ok' : 'failed' });
    return { ...result, destination: shapeDestination(stmts.destinationById.get(id)) };
  }

  async function testDestinationConfig(cfg, req) {
    return op('backup.destination.test', { config: cfg }, req);
  }

  async function listRemote(id, req) {
    const row = loadDestination(id);
    const result = await op('backup.destination.list', { config: destinationConfig(row) }, req);
    return { destination: shapeDestination(row), archives: result.archives };
  }

  // ---------------------------------------------------------- selection ---

  function effectiveEnabled(account, selectionRow) {
    return selectionRow ? Boolean(selectionRow.enabled) : Boolean(setting('backup.default_include'));
  }

  function listSelection(query = {}) {
    const selection = new Map(stmts.selectionAll.all().map((s) => [s.account_id, s]));
    let rows = stmts.accounts.all();
    if (query.q) { const q = query.q.toLowerCase(); rows = rows.filter((a) => `${a.username} ${a.domain} ${a.owner}`.toLowerCase().includes(q)); }
    if (query.owner) rows = rows.filter((a) => a.owner === query.owner);
    const data = rows.map((a) => {
      const sel = selection.get(a.id);
      const last = stmts.lastBackupFor.get(a.id);
      return { username: a.username, domain: a.domain, owner: a.owner, suspended: Boolean(a.suspended), enabled: effectiveEnabled(a, sel), explicit: Boolean(sel), lastBackup: last ? { id: last.id, created_at: last.created_at, size: last.size, status: last.status } : null };
    });
    if (query.enabled != null) return { data: data.filter((r) => r.enabled === query.enabled), meta: { total: data.filter((r) => r.enabled === query.enabled).length, defaultInclude: Boolean(setting('backup.default_include')) } };
    return { data, meta: { total: data.length, defaultInclude: Boolean(setting('backup.default_include')) } };
  }

  function setSelection(usernames, enabled, req) {
    const missing = [];
    const changed = [];
    db.transaction(() => {
      for (const u of new Set(usernames)) {
        const a = stmts.accountByUsername.get(u);
        if (!a) { missing.push(u); continue; }
        stmts.upsertSelection.run(a.id, enabled ? 1 : 0);
        changed.push(u);
      }
    })();
    audit(req, { action: enabled ? 'backup.selection.enable' : 'backup.selection.disable', target: changed.join(','), args: { count: changed.length, missing } });
    return { changed, missing, enabled };
  }

  function includedAccounts() {
    const selection = new Map(stmts.selectionAll.all().map((s) => [s.account_id, s]));
    const skipSuspended = Boolean(setting('backup.skip_suspended'));
    return stmts.accounts.all().filter((a) => effectiveEnabled(a, selection.get(a.id)) && !(skipSuspended && a.suspended));
  }

  // ------------------------------------------------------------ backups ---

  function shapeBackup(row, { withUploads = true } = {}) {
    if (!row) return null;
    return {
      id: row.id, account: row.account_name, accountExists: row.live_account_id != null || row.account_id != null, home_dir: row.live_home_dir ?? null, type: row.type, path: row.path, name: row.path ? path.basename(row.path) : null,
      size: row.size, sha256: row.sha256, status: row.status, error: row.error, created_at: row.created_at, run_id: row.run_id,
      retention_class: row.retention_class, pinned: Boolean(row.pinned), local_present: Boolean(row.local_present), components: json.parse(row.components_json, {}),
      uploads: withUploads ? stmts.uploadsFor.all(row.id).map((u) => ({ id: u.id, destination_id: u.destination_id, destination: u.destination_name, remote_path: u.remote_path, status: u.status, error: u.error, uploaded_at: u.uploaded_at })) : undefined,
    };
  }

  // Rows without an owner (archives of terminated accounts, adopted or imported
  // archives of accounts that no longer exist) are root-only.
  function loadBackup(id, user) {
    const row = stmts.backupById.get(id);
    if (!row) throw notFound('Backup');
    if (!isRoot(user)) {
      if (row.owner_id == null || row.owner_id !== user.id) throw forbidden('That backup belongs to another reseller\'s account');
    }
    return row;
  }

  function listBackups(query, user) {
    const where = [];
    const params = {};
    if (!isRoot(user)) { where.push('b.owner_id = @owner'); params.owner = user.id; }
    if (query.account) { where.push('b.account_name = @account'); params.account = query.account; }
    if (query.status) { where.push('b.status = @status'); params.status = query.status; }
    if (query.q) { where.push('(b.account_name LIKE @q OR b.path LIKE @q)'); params.q = `%${query.q}%`; }
    const result = paginate(db, {
      select: 'b.*, a.id AS live_account_id, a.home_dir AS live_home_dir', from: 'backups b LEFT JOIN accounts a ON a.username = b.account_name', where, params,
      sortable: { created_at: 'b.created_at', account: 'b.account_name', size: 'b.size', status: 'b.status', retention_class: 'b.retention_class' },
      defaultSort: 'created_at', query: { ...query, dir: query.sort ? query.dir : 'desc' },
    });
    return { ...result, data: result.data.map((r) => shapeBackup(r)) };
  }

  function getBackup(id, user) { return shapeBackup(loadBackup(id, user)); }

  async function inspect(id, prefix, user) {
    const row = loadBackup(id, user);
    if (!row.local_present || !row.path) throw conflict('The archive is not on local disk; fetch it from a destination first');
    await requireTar();
    return op('backup.archive.inspect', { archive: row.path, prefix: prefix || 'homedir', limit: 5000 });
  }

  async function archiveInfo(id, user) {
    const row = loadBackup(id, user);
    if (!row.local_present || !row.path) throw conflict('The archive is not on local disk; fetch it from a destination first');
    await requireTar();
    return op('backup.archive.info', { archive: row.path });
  }

  function pinBackup(id, pinned, user, req) {
    loadBackup(id, user);
    stmts.pinBackup.run(pinned ? 1 : 0, id);
    audit(req, { action: pinned ? 'backup.pin' : 'backup.unpin', target: String(id) });
    return shapeBackup(stmts.backupById.get(id));
  }

  async function removeBackupFiles(row, { remote = true } = {}, req, log = () => {}) {
    const outcome = { local: null, remote: [] };
    if (row.local_present && row.path) {
      try { const r = await op('backup.archive.remove', { archive: row.path }, req); outcome.local = r.removed; } catch (err) { outcome.local = `failed: ${err.message}`; log(`could not remove ${row.path}: ${err.message}`, 'warn'); }
    }
    if (remote) {
      for (const u of stmts.uploadsFor.all(row.id)) {
        if (u.status !== 'done' || !u.destination_id) continue;
        const dest = stmts.destinationById.get(u.destination_id);
        if (!dest) { outcome.remote.push({ destination: u.destination_name, removed: false, error: 'destination no longer exists' }); continue; }
        try {
          await op('backup.destination.remove', { config: destinationConfig(dest), remoteName: path.basename(row.path || u.remote_path) }, req);
          stmts.uploadStatus.run('removed', null, u.id);
          outcome.remote.push({ destination: dest.name, removed: true });
        } catch (err) { outcome.remote.push({ destination: dest.name, removed: false, error: err.message }); log(`could not remove ${u.remote_path} from ${dest.name}: ${err.message}`, 'warn'); }
      }
    }
    return outcome;
  }

  async function deleteBackup(id, { remote = true } = {}, user, req) {
    const row = loadBackup(id, user);
    if (row.pinned) throw conflict('This backup is pinned; unpin it before deleting');
    const outcome = await removeBackupFiles(row, { remote }, req);
    stmts.deleteBackup.run(id);
    audit(req, { action: 'backup.delete', target: row.path || String(id), args: { account: row.account_name, ...outcome } });
    return { id, deleted: true, ...outcome };
  }

  // Reconciles the local directory with the backups table: archives nobody
  // recorded (copied in by hand, or produced before the panel) become rows,
  // rows whose file vanished are flagged.
  async function rescan(user, req) {
    const listing = await op('backup.archive.list', { dir: localDir() }, req);
    const known = new Map(db.prepare('SELECT id, path, local_present FROM backups WHERE path IS NOT NULL').all().map((r) => [r.path, r]));
    const added = [];
    const found = new Set();
    for (const a of listing.archives) {
      found.add(a.path);
      const row = known.get(a.path);
      if (row) { if (!row.local_present) stmts.updateBackupLocal.run(1, null, row.id); continue; }
      const account = a.username ? stmts.accountByUsername.get(a.username) : null;
      stmts.insertBackup.run({ account_id: account?.id ?? null, account_name: a.username, owner_id: account?.owner_id ?? null, type: 'full', path: a.path, size: a.sizeBytes, sha256: a.sha256, status: 'done', run_id: null, retention_class: retentionClassFor(a.mtime, retention()), components_json: '{}', error: null, local_present: 1, created_at: a.mtime.replace('T', ' ').slice(0, 19) });
      added.push(a.name);
    }
    let missing = 0;
    for (const [p, row] of known) {
      if (p.startsWith(`${localDir()}/`) && !found.has(p) && row.local_present) { stmts.updateBackupLocal.run(0, null, row.id); missing += 1; }
    }
    audit(req, { action: 'backup.rescan', target: localDir(), args: { added: added.length, missing } });
    return { dir: listing.dir, exists: listing.exists, added, missing };
  }

  async function registerArchive(archivePath, user, req) {
    if (!isRoot(user)) throw forbidden('Only root can import archives');
    const roots = [...new Set([localDir(), ...IMPORT_ROOTS])];
    if (!roots.some((r) => archivePath.startsWith(`${r}/`))) throw unprocessable(`Archives are imported from ${roots.join(', ')} only; move the file there as root first`, { path: [`Must be under ${roots.join(' or ')}`] });
    await requireTar();
    if (stmts.backupByPath.get(archivePath)) throw conflict('That archive is already registered');
    const info = await op('backup.archive.info', { archive: archivePath }, req);
    const username = info.username || info.metadata?.account?.username;
    if (!username) throw unprocessable('The archive name does not identify an account');
    const account = stmts.accountByUsername.get(username);
    const verify = await op('backup.archive.verify', { archive: archivePath }, req);
    const { lastInsertRowid } = stmts.insertBackup.run({ account_id: account?.id ?? null, account_name: username, owner_id: account?.owner_id ?? null, type: 'import', path: archivePath, size: info.sizeBytes, sha256: verify.sha256, status: 'done', run_id: null, retention_class: 'daily', components_json: JSON.stringify(info.components), error: null, local_present: 1, created_at: info.info?.createdAt ? info.info.createdAt.replace('T', ' ').slice(0, 19) : null });
    stmts.pinBackup.run(1, lastInsertRowid);
    audit(req, { action: 'backup.import', target: archivePath, args: { account: username } });
    return shapeBackup(stmts.backupById.get(lastInsertRowid));
  }

  // --------------------------------------------------------- archiving ---

  // Admin credentials of the active database profile, in the shape the agent's
  // db ops take (socket auth when the local profile has none).
  function dbCredentials() {
    const profile = ctx.databases?.activeProfile?.();
    if (!profile || profile.engine === 'postgres') return null;
    const row = stmts.dbProfileSecret.get(profile.id);
    if (!row) return null;
    if (!row.admin_user && !row.admin_password_enc && (row.is_local || row.host === 'localhost')) return undefined;
    const creds = {};
    if (row.host) creds.host = row.host;
    if (row.port) creds.port = row.port;
    if (row.admin_user) creds.user = row.admin_user;
    if (row.admin_password_enc) creds.password = crypto.decrypt(row.admin_password_enc);
    const addresses = ctx.databases?.clientAddresses?.();
    if (addresses && !row.is_local && row.host && !['localhost', '127.0.0.1', '::1'].includes(row.host)) {
      const bind = row.host.includes(':') ? addresses.ipv6 : addresses.ipv4 || addresses.ipv6;
      if (bind) creds.bindAddress = bind;
    }
    return creds;
  }

  function accountMetadata(account) {
    let databases = { databases: [], users: [] };
    try { if (ctx.databases?.forAccount) databases = ctx.databases.forAccount(account.username, SYSTEM_ROOT); } catch (err) { logger.warn({ err, account: account.username }, 'database metadata unavailable for backup'); }
    return {
      version: 1,
      panelVersion: ctx.version ?? null,
      backedUpAt: new Date().toISOString(),
      account: {
        username: account.username, domain: account.domain, owner: account.owner, package_name: account.package_name, plan: json.parse(account.plan_snapshot_json, {}),
        ip: account.ip, contact_email: account.contact_email, shell: account.shell, home_dir: homeOf(account), uid: account.uid, gid: account.gid,
        disk_quota_mb: account.disk_quota_mb, bandwidth_limit_mb: account.bandwidth_limit_mb, suspended: Boolean(account.suspended), suspend_reason: account.suspend_reason, created_at: account.created_at,
      },
      domains: stmts.accountDomains.all(account.id),
      databases: (databases.databases || []).map((d) => ({ name: d.name, users: d.users })),
      dbUsers: (databases.users || []).map((u) => ({ name: u.name, hosts: u.hosts, grants: u.grants })),
      mail: stmts.mailDomains.all(account.id, account.id),
      dnsZones: stmts.dnsZonesFor.all(account.id).map((z) => z.domain),
    };
  }

  // Builds one account archive in `destDir` and records it. Used by the run job
  // and offered to other categories (Transfers) for a synchronous archive.
  async function archiveAccount(username, { destDir, include, runId = null, log = () => {} } = {}, user, req) {
    const account = loadAccount(username, user);
    await requireTar();
    const dest = destDir || localDir();
    const inc = { home: Boolean(setting('backup.include_home')), mail: Boolean(setting('backup.include_mail')), dbs: Boolean(setting('backup.include_dbs')), dns: Boolean(setting('backup.include_dns')), metadata: Boolean(setting('backup.include_metadata')), ...(include || {}) };
    await op('fs.mkdir', { path: dest, mode: '0700', owner: 'root' }, req);
    const metadata = accountMetadata(account);
    const args = {
      username, homeDir: homeOf(account), dest, include: inc,
      excludes: (setting('backup.excludes') || []).filter((e) => typeof e === 'string' && /^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]+$/.test(e)),
      compressionLevel: Number(setting('backup.compression_level')) || 6, strict: Boolean(setting('backup.strict')),
      metadata,
    };
    if (inc.dbs && metadata.databases.length) {
      const creds = dbCredentials();
      if (creds === null && metadata.databases.length) log(`${username}: no MySQL profile is active; databases are not included`, 'warn');
      else {
        args.databases = metadata.databases.map((d) => d.name);
        args.dbUsers = metadata.dbUsers.map((u) => u.name);
        if (creds) args.credentials = creds;
      }
    }
    if (inc.dns && ctx.dns?.renderZoneText) {
      args.dnsZones = [];
      for (const domain of metadata.dnsZones) {
        try { args.dnsZones.push({ domain, body: ctx.dns.renderZoneText(domain) }); } catch (err) { log(`${username}: zone ${domain} could not be rendered: ${err.message}`, 'warn'); }
      }
    }
    let result;
    let error = null;
    try {
      result = await op('backup.account.archive', args, req);
    } catch (err) {
      error = err;
    }
    const { lastInsertRowid } = stmts.insertBackup.run({
      account_id: account.id, account_name: username, owner_id: account.owner_id, type: 'full', path: result?.path ?? null, size: result?.sizeBytes ?? null, sha256: result?.sha256 ?? null,
      status: error ? 'failed' : 'done', run_id: runId, retention_class: retentionClassFor(new Date(), retention()),
      components_json: JSON.stringify(result ? { ...result.components, warnings: result.warnings, durationMs: result.durationMs, include: inc } : { include: inc }), error: error ? error.message : null, local_present: result ? 1 : 0, created_at: null,
    });
    audit(req, { action: 'backup.account', target: username, args: { path: result?.path ?? null, sizeBytes: result?.sizeBytes ?? null, warnings: result?.warnings ?? [], include: inc }, result: error ? 'failed' : 'ok' });
    if (error) throw Object.assign(error, { backupId: Number(lastInsertRowid) });
    for (const w of result.warnings || []) log(`${username}: ${w}`, 'warn');
    return { ...shapeBackup(stmts.backupById.get(lastInsertRowid)), archive: result };
  }

  async function uploadBackup(row, req, log = () => {}) {
    const outcomes = [];
    for (const dest of stmts.destinations.all().filter((d) => d.enabled)) {
      try {
        const r = await op('backup.destination.upload', { config: destinationConfig(dest), file: row.path }, req);
        stmts.insertUpload.run(row.id, dest.id, dest.name, r.remotePath, 'done', null);
        outcomes.push({ destination: dest.name, ok: true, remotePath: r.remotePath, ms: r.ms });
        log(`${row.account_name}: uploaded to ${dest.name} (${r.remotePath})`);
      } catch (err) {
        stmts.insertUpload.run(row.id, dest.id, dest.name, null, 'failed', err.message);
        outcomes.push({ destination: dest.name, ok: false, error: err.message });
        log(`${row.account_name}: upload to ${dest.name} failed: ${err.message}`, 'error');
      }
    }
    if (outcomes.length && outcomes.some((o) => o.ok) && !setting('backup.keep_local')) {
      try { await op('backup.archive.remove', { archive: row.path }, req); stmts.updateBackupLocal.run(0, null, row.id); log(`${row.account_name}: local copy removed (keep local copies is off)`); } catch (err) { log(`${row.account_name}: could not remove the local copy: ${err.message}`, 'warn'); }
    }
    return outcomes;
  }

  // Only this account's own archives are pruned: an orphaned archive with the
  // same username (from a terminated predecessor) is root's to delete by hand.
  async function pruneAccount(account, req, log = () => {}) {
    const username = account.username;
    const rows = stmts.backupsForAccount.all(account.id, username);
    const remove = planPrune(rows, retention());
    const pruned = [];
    for (const row of remove) {
      const outcome = await removeBackupFiles(row, { remote: Boolean(setting('backup.prune_remote')) }, req, log);
      stmts.deleteBackup.run(row.id);
      pruned.push({ id: row.id, path: row.path, retention_class: row.retention_class, ...outcome });
      log(`${username}: pruned ${path.basename(row.path || String(row.id))} (${row.retention_class})`);
    }
    return pruned;
  }

  // ---------------------------------------------------------------- runs ---

  // A run or restore whose job ended without reaching runFinish/restoreFinish
  // (the handler threw before the row was started, the job was cancelled,
  // the panel restarted mid-run) would otherwise stay "running" forever.
  const abandonRun = (runId, reason) => stmts.abandonRun.run(reason, runId).changes > 0;
  const abandonRestore = (restoreId, reason) => stmts.abandonRestore.run(reason, restoreId).changes > 0;
  function abandonForJob(jobId, reason) {
    const out = { runs: [], restores: [] };
    for (const r of stmts.runsOfJob.all(jobId)) if (abandonRun(r.id, reason)) out.runs.push(r.id);
    for (const r of stmts.restoresOfJob.all(jobId)) if (abandonRestore(r.id, reason)) out.restores.push(r.id);
    return out;
  }
  const orphanReason = (r) => (r.job_id == null || r.job_status == null ? 'the job driving this run no longer exists'
    : r.job_status === 'cancelled' ? 'the job was cancelled'
      : r.job_status === 'done' ? 'the job finished without recording the run'
        : r.job_error || 'the job failed');
  // jobs.start() marks the jobs interrupted by a restart as failed without
  // emitting events; the rows they drove are reconciled once the panel is up.
  function reconcileRuns() {
    const abandoned = { runs: [], restores: [] };
    for (const r of stmts.orphanedRuns.all()) if (abandonRun(r.id, orphanReason(r))) abandoned.runs.push(r.id);
    for (const r of stmts.orphanedRestores.all()) if (abandonRestore(r.id, orphanReason(r))) abandoned.restores.push(r.id);
    if (abandoned.runs.length || abandoned.restores.length) logger.warn(abandoned, 'backup: finalised runs/restores whose job ended without them');
    return abandoned;
  }
  jobs.onAny((event) => {
    if (event.type !== 'failed' && event.type !== 'cancelled') return;
    try {
      abandonForJob(event.jobId, event.type === 'cancelled' ? 'the job was cancelled before it started' : event.error || 'the job failed');
    } catch (err) {
      logger.warn({ err, jobId: event.jobId }, 'backup: run could not be finalised after its job failed');
    }
  });
  ctx.events?.on?.('panel.started', () => { try { reconcileRuns(); } catch (err) { logger.warn({ err }, 'backup: run reconciliation at boot failed'); } });

  function shapeRun(row) {
    if (!row) return null;
    return { ...row, summary: json.parse(row.summary_json, {}), summary_json: undefined };
  }

  function enqueueRun({ accounts, kind = 'manual' } = {}, user, req) {
    let targets = null;
    if (accounts?.length) targets = [...new Set(accounts)].map((u) => loadAccount(u, user).username);
    else if (!isRoot(user)) throw forbidden('Resellers can only back up their own accounts; name them explicitly');
    const { lastInsertRowid } = stmts.insertRun.run(null, kind, 'queued', user?.username ?? null, targets ? targets.length : includedAccounts().length);
    const job = jobs.enqueue('backup.run', { runId: Number(lastInsertRowid), accounts: targets, kind, userId: user?.id ?? null }, { userId: user?.id ?? null });
    stmts.runJob.run(job.id, lastInsertRowid);
    audit(req, { action: 'backup.run.start', target: targets ? targets.join(',') : 'all', args: { kind, jobId: job.id } });
    return { job, run: shapeRun(stmts.runById.get(lastInsertRowid)) };
  }

  async function runBackupJob(jobCtx) {
    const { params } = jobCtx;
    const kind = params.kind || 'scheduled';
    const req = actorRequest(params.userId, `job:${jobCtx.job?.id ?? ''}`);
    let runId = params.runId;
    if (!runId) {
      const { lastInsertRowid } = stmts.insertRun.run(jobCtx.job?.id || null, kind, 'queued', req.user.username, 0);
      runId = Number(lastInsertRowid);
    }
    if (kind === 'scheduled' && !setting('backup.enabled')) {
      stmts.runFinish.run('skipped', 0, 0, 0, '{}', 'backups are disabled', runId);
      jobCtx.log('Backups are disabled in Backup Configuration; nothing to do.', 'warn');
      return { runId, skipped: true };
    }
    const accounts = params.accounts ? params.accounts.map((u) => stmts.accountByUsername.get(u)).filter(Boolean) : includedAccounts();
    stmts.runStart.run(accounts.length, runId);
    const summary = { accounts: [], pruned: 0, uploads: 0, uploadFailures: 0 };
    let ok = 0;
    let failed = 0;
    let bytes = 0;
    let fatal = null;
    try {
      await requireTar();
      jobCtx.log(`Backing up ${accounts.length} account(s) to ${localDir()}${stmts.destinations.all().some((d) => d.enabled) ? ' and the enabled destinations' : ''}`);
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        jobCtx.progress((i / Math.max(1, accounts.length)) * 100, `${account.username} (${i + 1}/${accounts.length})`);
        const entry = { username: account.username, status: 'done', sizeBytes: null, path: null, uploads: [], pruned: 0 };
        try {
          const backup = await archiveAccount(account.username, { runId, log: jobCtx.log }, SYSTEM_ROOT, req);
          entry.sizeBytes = backup.size; entry.path = backup.path; entry.backupId = backup.id;
          bytes += backup.size || 0;
          jobCtx.log(`${account.username}: archived ${backup.name} (${Math.round((backup.size || 0) / 1024)} KB)`);
          const row = stmts.backupById.get(backup.id);
          entry.uploads = await uploadBackup(row, req, jobCtx.log);
          summary.uploads += entry.uploads.filter((u) => u.ok).length;
          summary.uploadFailures += entry.uploads.filter((u) => !u.ok).length;
          entry.pruned = (await pruneAccount(account, req, jobCtx.log)).length;
          summary.pruned += entry.pruned;
          ok += 1;
        } catch (err) {
          failed += 1;
          entry.status = 'failed';
          entry.error = err.message;
          jobCtx.log(`${account.username}: ${err.message}`, 'error');
          if (isCapabilityMissing(err) || setting('backup.strict')) { fatal = err; summary.accounts.push(entry); break; }
        }
        summary.accounts.push(entry);
      }
    } catch (err) {
      fatal = err;
      jobCtx.log(err.message, 'error');
    }
    const status = fatal ? 'failed' : failed ? (ok ? 'done' : 'failed') : 'done';
    stmts.runFinish.run(status, ok, failed, bytes, JSON.stringify(summary), fatal ? fatal.message : failed ? `${failed} account(s) failed` : null, runId);
    jobCtx.progress(100, `${ok} ok, ${failed} failed`);
    if ((fatal || failed) && setting('backup.notify_on_failure')) {
      Promise.resolve(ctx.contacts?.notify?.({ event: 'backup.failed', subject: `Backup run ${runId}: ${failed} account(s) failed`, body: `${fatal ? `${fatal.message}\n` : ''}${summary.accounts.filter((a) => a.status === 'failed').map((a) => `${a.username}: ${a.error}`).join('\n')}`, severity: 'error' })).catch(() => {});
    }
    audit(req, { action: 'backup.run.finish', target: String(runId), args: { kind, ok, failed, bytes, pruned: summary.pruned }, result: status === 'done' ? 'ok' : 'failed' });
    if (fatal) throw fatal;
    return { runId, status, ok, failed, bytes, summary };
  }

  function listRuns({ limit = 50 } = {}) {
    return stmts.runs.all(limit).map(shapeRun);
  }

  // ------------------------------------------------------------- restore ---

  // Makes sure the archive is on local disk, downloading it from the first
  // destination that still holds it.
  async function ensureLocal(row, req, log = () => {}) {
    if (row.local_present && row.path) {
      const st = await agent.op('fs.stat', { path: row.path }, { req }).catch(() => null);
      if (st?.exists) return row.path;
      stmts.updateBackupLocal.run(0, null, row.id);
    }
    const name = row.path ? path.basename(row.path) : null;
    if (!name) throw conflict('This backup has no archive file recorded');
    for (const u of stmts.uploadsFor.all(row.id)) {
      if (u.status !== 'done' || !u.destination_id) continue;
      const dest = stmts.destinationById.get(u.destination_id);
      if (!dest) continue;
      log(`fetching ${name} from ${dest.name}…`);
      try {
        const r = await op('backup.destination.download', { config: destinationConfig(dest), remoteName: name, dest: localDir() }, req);
        if (row.sha256 && r.sha256 !== row.sha256) { await op('backup.archive.remove', { archive: r.path }, req).catch(() => {}); throw new HttpError(502, 'checksum_mismatch', `The copy on ${dest.name} does not match the recorded sha256`); }
        stmts.updateBackupLocal.run(1, r.path, row.id);
        log(`fetched ${name} (${Math.round(r.sizeBytes / 1024)} KB)`);
        return r.path;
      } catch (err) { log(`${dest.name}: ${err.message}`, 'warn'); }
    }
    throw conflict(`The archive ${name} is not on local disk and no destination could provide it`);
  }

  function enqueueFetch(id, user, req) {
    const row = loadBackup(id, user);
    const job = jobs.enqueue('backup.fetch', { backupId: row.id, userId: user?.id ?? null }, { userId: user?.id ?? null });
    audit(req, { action: 'backup.fetch', target: String(id), args: { jobId: job.id } });
    return { job };
  }

  async function runFetchJob(jobCtx) {
    const row = stmts.backupById.get(jobCtx.params.backupId);
    if (!row) throw new Error('backup no longer exists');
    const p = await ensureLocal(row, actorRequest(jobCtx.params.userId, `job:${jobCtx.job?.id ?? ''}`), jobCtx.log);
    return { path: p };
  }

  function enqueueRestore({ backupId, kind, options = {} }, user, req) {
    const row = loadBackup(backupId, user);
    if (row.status !== 'done') throw conflict('Only completed backups can be restored');
    const account = stmts.accountByUsername.get(row.account_name);
    if (kind === 'files') {
      if (!account) throw conflict(`Account "${row.account_name}" does not exist; restore the whole account instead`);
      if (!options.paths?.length) throw badRequest('Choose at least one file or directory to restore');
    }
    if (kind === 'account' && !account && !options.createAccount) throw conflict(`Account "${row.account_name}" no longer exists; enable "create the account" to recreate it from the archive`);
    const { lastInsertRowid } = stmts.insertRestore.run(row.id, row.account_name, row.owner_id ?? null, kind, JSON.stringify(options), user?.username ?? null);
    const job = jobs.enqueue('backup.restore', { restoreId: Number(lastInsertRowid), userId: user?.id ?? null }, { userId: user?.id ?? null });
    stmts.restoreJob.run(job.id, lastInsertRowid);
    audit(req, { action: kind === 'files' ? 'backup.restore.files' : 'backup.restore.account', target: row.account_name, args: { backupId: row.id, options, jobId: job.id } });
    return { job, restore: shapeRestore(stmts.restoreById.get(lastInsertRowid)) };
  }

  function shapeRestore(row) {
    if (!row) return null;
    const { owner_id, ...rest } = row;
    return { ...rest, options: json.parse(row.options_json, {}), summary: json.parse(row.summary_json, {}), options_json: undefined, summary_json: undefined };
  }

  function listRestores({ limit = 50, account } = {}, user) {
    return stmts.restores.all({ owner: isRoot(user) ? null : user.id, account: account ?? null, limit }).map(shapeRestore);
  }

  // The objects inside an archive may have changed hands since it was written;
  // each is restored only when it is still unowned or owned by this account.
  function ownedByAccount(row, account) {
    if (!row || row.account_id == null) return { ok: true };
    if (row.account_id === account.id) return { ok: true };
    return { ok: false, reason: `now belongs to ${row.account ?? 'another account'}` };
  }
  function databaseClaim(name, account) {
    if (SYSTEM_SCHEMAS.has(name.toLowerCase())) return { ok: false, reason: 'system schema' };
    return ownedByAccount(stmts.dbOwner.get(name), account);
  }
  function zoneClaim(domain, account) {
    const zone = ownedByAccount(stmts.zoneOwner.get(domain), account);
    if (!zone.ok) return zone;
    return ownedByAccount(stmts.domainOwner.get(domain), account);
  }
  function mailDomainClaim(domain, account) {
    const owned = ownedByAccount(stmts.domainOwner.get(domain), account);
    if (!owned.ok) return owned;
    return ownedByAccount(stmts.mailDomainOwner.get(domain), account);
  }

  // Grants come back only for databases the archive restored into this account
  // or the account owns today; global, system-schema and wildcard grants never do.
  function filterGrants(grants, allowed) {
    const kept = [];
    const dropped = [];
    for (const line of grants || []) {
      if (typeof line !== 'string') continue;
      const database = grantDatabase(line);
      const reason = database == null ? 'not a database grant' : database === '*' ? 'global grant' : SYSTEM_SCHEMAS.has(database.toLowerCase()) ? 'system schema' : !/^[a-z0-9_]{1,64}$/.test(database) ? 'wildcard database' : !allowed.has(database) ? 'database not restored for this account' : null;
      if (reason) dropped.push(`${line.slice(0, 160)} (${reason})`);
      else kept.push(line);
    }
    return { kept, dropped };
  }

  // Parked/addon/sub domains recorded in the archive metadata come back as
  // account_domains rows (docroots moved under the current home) and one vhost
  // sync; a domain that another account hosts today is left with it.
  async function restoreDomains(account, meta, req, log) {
    const home = homeOf(account);
    const sourceHome = typeof meta.account?.home_dir === 'string' ? meta.account.home_dir : null;
    const domains = [];
    let added = 0;
    for (const d of meta.domains) {
      if (typeof d?.domain !== 'string' || !RESTORABLE_DOMAIN_TYPES.includes(d.type) || d.domain === account.domain) continue;
      if (isServerHostname(ctx, d.domain)) { domains.push({ domain: d.domain, type: d.type, status: 'skipped', detail: 'is the server hostname' }); log(`domain ${d.domain} skipped: it is the server hostname`, 'warn'); continue; }
      const owner = stmts.domainOwner.get(d.domain);
      const claim = ownedByAccount(owner, account);
      if (!claim.ok) { domains.push({ domain: d.domain, type: d.type, status: 'skipped', detail: claim.reason }); log(`domain ${d.domain} skipped: ${claim.reason}`, 'warn'); continue; }
      if (owner) { domains.push({ domain: d.domain, type: d.type, status: 'kept', detail: 'already on the account' }); continue; }
      const sub = d.type === 'sub' && d.domain.endsWith(`.${account.domain}`) ? d.domain.slice(0, -(account.domain.length + 1)) : d.domain;
      const docroot = rewriteDocroot(d.docroot, sourceHome, home) ?? (d.type === 'parked' || d.type === 'alias' ? `${home}/public_html` : `${home}/public_html/${sub}`);
      try {
        stmts.insertDomain.run(account.id, d.domain, d.type, docroot, typeof d.php_version === 'string' ? d.php_version : null);
        added += 1;
        domains.push({ domain: d.domain, type: d.type, docroot, status: 'added' });
      } catch (err) { domains.push({ domain: d.domain, type: d.type, status: 'failed', detail: err.message }); }
    }
    let web = null;
    if (added) {
      if (!ctx.web?.ensureVhost) web = { status: 'skipped', detail: 'Service Configuration is not loaded' };
      else {
        try {
          const r = await ctx.web.ensureVhost(account.username, req);
          const warning = ['php_missing', 'php_pool_failed'].includes(r?.reason);
          if (r?.applied || warning) web = { status: 'done', detail: warning ? `vhosts written (${r.reason})` : 'vhosts written' };
          else if (r?.reason === 'capability_missing') web = { status: 'pending', detail: 'Apache is not installed; the vhosts are written when it is' };
          else web = { status: 'failed', detail: r?.vhosts?.find((v) => !v.applied)?.error || r?.reason || 'vhost not applied' };
          for (const d of domains) { const v = r?.vhosts?.find((x) => x.domain === d.domain); if (v) d.vhost = v.applied ? 'applied' : v.reason || 'failed'; }
        } catch (err) { web = { status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message }; }
      }
    }
    const counts = { added, kept: domains.filter((d) => d.status === 'kept').length, skipped: domains.filter((d) => d.status === 'skipped').length, failed: domains.filter((d) => d.status === 'failed').length };
    const status = counts.failed && !added ? 'failed' : web?.status === 'failed' ? 'failed' : web?.status === 'pending' ? 'pending' : !added && counts.skipped && !counts.kept ? 'skipped' : 'done';
    return { status, detail: `${added} domain(s) re-added, ${counts.kept} kept, ${counts.skipped} skipped${counts.failed ? `, ${counts.failed} failed` : ''}${web ? `; vhosts: ${web.detail}` : ''}`, domains, web };
  }

  async function runRestoreJob(jobCtx) {
    const restore = stmts.restoreById.get(jobCtx.params.restoreId);
    if (!restore) throw new Error('restore request no longer exists');
    const req = actorRequest(jobCtx.params.userId, `job:${jobCtx.job?.id ?? ''}`);
    const options = json.parse(restore.options_json, {});
    stmts.restoreStart.run(restore.id);
    const summary = { steps: {} };
    const step = (name, value) => { summary.steps[name] = value; jobCtx.log(`${name}: ${value.detail || value.status}`, value.status === 'failed' ? 'error' : value.status === 'pending' ? 'warn' : 'info'); };
    let staging = null;
    try {
      await requireTar();
      const row = stmts.backupById.get(restore.backup_id);
      if (!row) throw new Error('the backup row was deleted');
      jobCtx.progress(5, 'locating archive');
      const archive = await ensureLocal(row, req, jobCtx.log);
      if (row.sha256) {
        jobCtx.progress(10, 'verifying checksum');
        const v = await op('backup.archive.verify', { archive, sha256: row.sha256 }, req);
        if (!v.ok) throw new Error(`checksum mismatch: the archive on disk does not match the recorded sha256 (${v.sha256} != ${row.sha256})`);
        step('verify', { status: 'done', detail: 'sha256 matches' });
      }
      let account = stmts.accountByUsername.get(restore.account_name);
      // Ownership was checked when the restore was queued; the account may have
      // changed hands since, so it is checked again for the actor here.
      if (account && !isRoot(req.user) && account.owner_id !== req.user.id) throw new Error(`account ${restore.account_name} no longer belongs to ${req.user.username}`);
      if (restore.kind === 'files') {
        if (!account) throw new Error(`account ${restore.account_name} does not exist`);
        jobCtx.progress(30, 'restoring files');
        const r = await op('backup.files.restore', { archive, username: account.username, homeDir: homeOf(account), paths: options.paths, overwrite: options.overwrite !== false }, req);
        const htaccess = r.restored.length ? await reconcileHtaccess(agent, { roots: r.restored.map((p) => path.resolve(homeOf(account), p)), username: account.username, req, log: jobCtx.log }) : null;
        step('files', { status: r.missing.length && !r.restored.length ? 'failed' : 'done', detail: `${r.restored.length} path(s) restored${r.missing.length ? `, not in archive: ${r.missing.join(', ')}` : ''}${htaccessSummary(htaccess)}`, restored: r.restored, missing: r.missing, ...htaccessFields(htaccess) });
      } else {
        staging = `${localDir()}/.restore-${restore.id}`;
        jobCtx.progress(15, 'extracting metadata');
        const ex = await op('backup.archive.extract', { archive, dest: staging }, req);
        const meta = ex.metadata || {};
        if (!account) {
          jobCtx.progress(20, 'creating account');
          if (!ctx.accounts?.create) throw new Error('account service unavailable');
          const acc = meta.account || {};
          const domain = acc.domain;
          if (!domain) throw new Error('the archive carries no account metadata (cp/<user>.json); create the account first and restore again');
          const input = { username: restore.account_name, domain, contactEmail: acc.contact_email || undefined, provision: { web: true, dns: false, mail: false } };
          if (acc.package_name && db.prepare('SELECT 1 FROM packages WHERE name = ?').get(acc.package_name)) input.package = acc.package_name;
          if (options.package) input.package = options.package;
          if (isRoot(req.user) && acc.owner && db.prepare("SELECT 1 FROM users WHERE username = ? AND role IN ('root', 'reseller')").get(acc.owner)) input.owner = acc.owner;
          const created = await ctx.accounts.create(input, req.user, req);
          account = stmts.accountByUsername.get(restore.account_name);
          step('account', { status: 'done', detail: `created ${created.username} (${domain}, package ${created.package_name})`, provisioning: created.provisioning });
        } else step('account', { status: 'done', detail: 'account exists; data is restored into it' });
        if (Array.isArray(meta.domains) && meta.domains.length) {
          jobCtx.progress(28, 'restoring domains');
          step('domains', await restoreDomains(account, meta, req, jobCtx.log));
        }
        if (options.files !== false) {
          jobCtx.progress(35, 'restoring home directory');
          const r = await op('backup.files.restore', { archive, username: account.username, homeDir: homeOf(account), paths: [], overwrite: options.overwrite !== false }, req);
          const htaccess = await reconcileHtaccess(agent, { roots: [homeOf(account)], username: account.username, req, log: jobCtx.log });
          step('files', { status: 'done', detail: `home directory restored into ${homeOf(account)}${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}${htaccessSummary(htaccess)}`, warnings: r.warnings, ...htaccessFields(htaccess) });
        }
        if (options.databases !== false && ex.mysql.length) {
          jobCtx.progress(55, 'importing databases');
          const creds = dbCredentials();
          if (creds === null) step('databases', { status: 'pending', detail: 'no MySQL profile is active; dumps left in the archive' });
          else {
            const imported = [];
            const errors = [];
            const skipped = [];
            const allowedDatabases = new Set(stmts.databasesOf.all(account.id).map((r) => r.name));
            for (const d of ex.mysql) {
              const claim = databaseClaim(d.database, account);
              if (!claim.ok) { skipped.push(`${d.database} (${claim.reason})`); jobCtx.log(`database ${d.database} skipped: ${claim.reason}`, 'warn'); continue; }
              allowedDatabases.add(d.database);
              try {
                await op('backup.db.import', { file: d.file, database: d.database, ...(creds ? { credentials: creds } : {}) }, req);
                imported.push(d.database);
                try { await ctx.databases?.assign?.({ kind: 'database', name: d.database, account: account.username }, SYSTEM_ROOT, req); } catch (err) { jobCtx.log(`database map: ${d.database}: ${err.message}`, 'warn'); }
              } catch (err) {
                if (isCapabilityMissing(err)) { errors.push(`${d.database}: ${err.message}`); break; }
                errors.push(`${d.database}: ${err.message}`);
              }
            }
            let users = null;
            const userRows = (ex.users?.users || []).filter((u) => {
              const claim = ownedByAccount(stmts.dbUserOwner.get(u.user), account);
              if (!claim.ok) { skipped.push(`user ${u.user} (${claim.reason})`); jobCtx.log(`database user ${u.user} skipped: ${claim.reason}`, 'warn'); }
              return claim.ok;
            });
            const droppedGrants = [];
            if (userRows.length) {
              try {
                const payload = userRows.map((u) => {
                  const g = filterGrants(u.grants, allowedDatabases);
                  for (const line of g.dropped) { droppedGrants.push(`${u.user}@${u.host}: ${line}`); jobCtx.log(`grant for ${u.user}@${u.host} dropped: ${line}`, 'warn'); }
                  return { user: u.user, host: u.host, plugin: u.plugin || '', hashHex: u.hashHex || '', grants: g.kept };
                });
                users = await op('backup.db.restore_users', { users: payload, allowedDatabases: [...allowedDatabases], ...(creds ? { credentials: creds } : {}) }, req);
                users.droppedGrants = droppedGrants;
                for (const name of new Set(userRows.map((u) => u.user))) { try { await ctx.databases?.assign?.({ kind: 'user', name, account: account.username }, SYSTEM_ROOT, req); } catch (err) { jobCtx.log(`database map: user ${name}: ${err.message}`, 'warn'); } }
              } catch (err) { errors.push(`users: ${err.message}`); }
            }
            step('databases', { status: errors.length ? (imported.length ? 'done' : 'failed') : imported.length || !skipped.length ? 'done' : 'skipped', detail: `${imported.length}/${ex.mysql.length} database(s) imported${users ? `, ${users.created.length} user(s) recreated, ${users.skipped.length} kept${droppedGrants.length ? `, ${droppedGrants.length} grant(s) dropped` : ''}` : ''}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}${errors.length ? `; errors: ${errors.join(' | ')}` : ''}`, imported, skipped, errors, users, droppedGrants });
          }
        }
        if (options.dns !== false && ex.dnszones.length) {
          jobCtx.progress(75, 'restoring DNS zones');
          if (!ctx.dns?.importZone) step('dns', { status: 'skipped', detail: 'DNS Functions is not loaded' });
          else {
            const done = [];
            const errors = [];
            const skipped = [];
            let pending = false;
            for (const zone of ex.dnszones) {
              const claim = zoneClaim(zone.domain, account);
              if (!claim.ok) { skipped.push(`${zone.domain} (${claim.reason})`); jobCtx.log(`zone ${zone.domain} skipped: ${claim.reason}`, 'warn'); continue; }
              try { await ctx.dns.importZone({ domain: zone.domain, body: zone.body }, SYSTEM_ROOT, req); done.push(zone.domain); } catch (err) { if (isCapabilityMissing(err)) pending = true; errors.push(`${zone.domain}: ${err.message}`); }
            }
            step('dns', { status: pending && !done.length ? 'pending' : errors.length && !done.length ? 'failed' : !done.length && skipped.length ? 'skipped' : 'done', detail: `${done.length}/${ex.dnszones.length} zone(s) loaded${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}${errors.length ? `; ${errors.join(' | ')}` : ''}`, zones: done, skipped, errors });
          }
        }
        if (options.mail !== false && meta.mail?.length) {
          jobCtx.progress(85, 'restoring mail routing');
          if (!ctx.mail?.setRouting) step('mail', { status: 'skipped', detail: 'Email is not loaded' });
          else {
            const results = [];
            const skipped = [];
            for (const m of meta.mail) {
              if (typeof m?.domain !== 'string') continue;
              const claim = mailDomainClaim(m.domain, account);
              if (!claim.ok) { skipped.push(`${m.domain} (${claim.reason})`); jobCtx.log(`mail routing for ${m.domain} skipped: ${claim.reason}`, 'warn'); continue; }
              try { const r = await ctx.mail.setRouting(m.domain, m.routing || 'local', req); results.push(`${m.domain}: ${m.routing}${r?.applied === false ? ' (pending)' : ''}`); } catch (err) { results.push(`${m.domain}: ${err.message}`); }
            }
            step('mail', { status: results.length || !skipped.length ? 'done' : 'skipped', detail: [...results, ...skipped.map((s) => `skipped ${s}`)].join(', '), skipped });
          }
        }
      }
      stmts.restoreFinish.run('done', JSON.stringify(summary), null, restore.id);
      jobCtx.progress(100, 'finished');
      audit(req, { action: 'backup.restore.finish', target: restore.account_name, args: { restoreId: restore.id, kind: restore.kind, steps: Object.fromEntries(Object.entries(summary.steps).map(([k, v]) => [k, v.status])) } });
      return summary;
    } catch (err) {
      stmts.restoreFinish.run('failed', JSON.stringify(summary), err.message, restore.id);
      audit(req, { action: 'backup.restore.finish', target: restore.account_name, args: { restoreId: restore.id, kind: restore.kind, error: err.message }, result: 'failed' });
      throw err;
    } finally {
      if (staging) await op('backup.staging.remove', { dir: staging }, req).catch((err) => jobCtx.log(`staging cleanup: ${err.message}`, 'warn'));
    }
  }

  // Accounts a user may restore into, with their backup counts (restore pages).
  function accountsOverview(user) {
    const counts = new Map((isRoot(user)
      ? db.prepare("SELECT account_name, COUNT(*) AS n, MAX(created_at) AS last FROM backups WHERE status = 'done' GROUP BY account_name").all()
      : db.prepare("SELECT account_name, COUNT(*) AS n, MAX(created_at) AS last FROM backups WHERE status = 'done' AND owner_id = ? GROUP BY account_name").all(user.id)
    ).map((r) => [r.account_name, r]));
    const accounts = stmts.accounts.all().filter((a) => isRoot(user) || a.owner_id === user.id).map((a) => ({ username: a.username, domain: a.domain, owner: a.owner, home_dir: homeOf(a), exists: true, backups: counts.get(a.username)?.n ?? 0, lastBackup: counts.get(a.username)?.last ?? null }));
    // Archives of terminated accounts stay restorable by whoever owned them; a
    // name that another reseller's live account carries today is not offered.
    const known = new Set(accounts.map((a) => a.username));
    for (const [name, c] of counts) {
      if (known.has(name) || stmts.accountByUsername.get(name)) continue;
      accounts.push({ username: name, domain: null, owner: null, home_dir: null, exists: false, backups: c.n, lastBackup: c.last });
    }
    return accounts.sort((a, b) => a.username.localeCompare(b.username));
  }

  return {
    config, status, updateConfig, syncSchedule, localDir,
    listDestinations: () => stmts.destinations.all().map(shapeDestination),
    createDestination, updateDestination, removeDestination, testDestination, testDestinationConfig, listRemote, destinationConfig: (id) => destinationConfig(id),
    listSelection, setSelection, includedAccounts: () => includedAccounts().map((a) => a.username),
    listBackups, getBackup, inspect, archiveInfo, pinBackup, deleteBackup, rescan, registerArchive, accountsOverview,
    archiveAccount, enqueueRun, runBackupJob, listRuns, getRun: (id) => { const r = stmts.runById.get(id); if (!r) throw notFound('Backup run'); return shapeRun(r); },
    enqueueRestore, runRestoreJob, listRestores, getRestore: (id, user) => { const r = stmts.restoreById.get(id); if (!r) throw notFound('Restore'); if (!isRoot(user) && (r.owner_id == null || r.owner_id !== user.id)) throw forbidden('That restore belongs to another reseller\'s account'); return shapeRestore(r); },
    enqueueFetch, runFetchJob, reconcileRuns,
    retentionClassFor, planPrune, grantDatabase, rewriteDocroot,
  };
}

// The server hostname owns the panel's landing vhost and certificate; an
// imported account must never claim it (accounts.create refuses it the same way).
function isServerHostname(ctx, domain) {
  const name = String(domain || '').toLowerCase();
  if (!name) return false;
  if (ctx.web?.isServerName?.(name)) return true;
  const host = String(ctx.settings?.get?.('basic.hostname') || '').toLowerCase();
  return Boolean(host) && (name === host || name === `www.${host}`);
}
