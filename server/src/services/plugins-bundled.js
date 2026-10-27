import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { json } from '../db/index.js';
import { HttpError, CapabilityError, notFound, conflict, badRequest } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { REPO_ROOT, loadPluginSdk } from '../lib/plugin-sdk.js';

// The Plugins category: the three WHM plugin functions are real plugins on the
// SDK, shipped under plugins/bundled/<id> and installed into the plugin host
// (ctx.plugins) at boot. This service owns that boot install, the enable /
// disable / repair actions behind the function pages, and the one-click
// WordPress install, which needs the panel's database and vhost services.
// The service file is not services/plugins.js only because that path is the
// plugin host itself.

export const BUNDLED_DIR = path.join(REPO_ROOT, 'plugins', 'bundled');
// `roles` mirrors the roles each plugin's main.js registers its routes with
// (the host default is root only), so the function page can tell a reseller
// up front instead of filling with 403 banners. `fnKey: null` means the plugin
// has no function page of its own: its ui:sidebar pages carry its UI.
export const BUNDLED_PLUGINS = Object.freeze([
  { id: 'net.whm.server-monitoring', fnKey: 'plugins/server-monitoring', label: 'Server Monitoring', roles: ['root'] },
  { id: 'net.whm.imunifyav', fnKey: 'plugins/imunifyav', label: 'ImunifyAV', roles: ['root'] },
  { id: 'net.whm.wp-toolkit', fnKey: 'plugins/wp-toolkit', label: 'WP Toolkit', roles: ['root', 'reseller'] },
  { id: 'net.whm.automated-backup', fnKey: null, label: 'Automated Backup', roles: ['root'] },
]);
export const WP_INSTALL_JOB = 'plugins.wp.install';
export const ENSURE_JOB = 'plugins.bundled.ensure';
const WP_DISCOVER_JOB = 'plugin:net.whm.wp-toolkit:discover';

export function bundledDirOf(id) {
  return path.join(BUNDLED_DIR, id);
}

export function readBundledManifest(id) {
  try { return JSON.parse(fs.readFileSync(path.join(bundledDirOf(id), 'plugin.json'), 'utf8')); } catch { return null; }
}

export function createBundledPluginsService(ctx) {
  const { db, logger, config } = ctx;
  const log = logger.child ? logger.child({ module: 'plugins-bundled' }) : logger;
  const semver = loadPluginSdk()?.semver ?? null;
  const stmts = {
    upsert: db.prepare(`INSERT INTO bundled_plugins (id, bundled_version, installed_version, action, last_error, installed_at, updated_at)
      VALUES (@id, @bundled_version, @installed_version, @action, @last_error, CASE WHEN @action IN ('installed', 'upgraded', 'reinstalled') THEN datetime('now') ELSE NULL END, datetime('now'))
      ON CONFLICT (id) DO UPDATE SET bundled_version = excluded.bundled_version, installed_version = excluded.installed_version, action = excluded.action, last_error = excluded.last_error,
        installed_at = COALESCE(excluded.installed_at, bundled_plugins.installed_at), updated_at = excluded.updated_at`),
    row: db.prepare('SELECT * FROM bundled_plugins WHERE id = ?'),
    wpInsert: db.prepare('INSERT INTO wp_installs (username, path, url, db_name, db_user, job_id, status, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    wpJob: db.prepare('UPDATE wp_installs SET job_id = ? WHERE id = ?'),
    wpFinish: db.prepare(`UPDATE wp_installs SET status = ?, error = ?, cleanup = ?, finished_at = datetime('now') WHERE id = ?`),
    wpList: db.prepare('SELECT * FROM wp_installs ORDER BY id DESC LIMIT 50'),
    wpListOwned: db.prepare('SELECT * FROM wp_installs WHERE username IN (SELECT username FROM accounts WHERE owner_id = @ownerId) ORDER BY id DESC LIMIT 50'),
  };

  const host = () => {
    if (!ctx.plugins) throw new CapabilityError('plugin-host', 'The plugin host is not available in this panel');
    return ctx.plugins;
  };
  const defOf = (id) => {
    const def = BUNDLED_PLUGINS.find((p) => p.id === id);
    if (!def) throw notFound(`Bundled plugin "${id}"`);
    return def;
  };
  const installedRow = (id) => { try { return host().get(id); } catch { return null; } };

  function record(id, bundledVersion, installedVersion, action, error = null) {
    stmts.upsert.run({ id, bundled_version: bundledVersion, installed_version: installedVersion, action, last_error: error ? String(error).slice(0, 1000) : null });
  }

  // Boot has no HTTP request; the audit rows the host writes for install and
  // enable still need a principal, so a synthetic "system" request stands in.
  function bootRequest() {
    const req = { user: { id: null, username: 'system', role: 'root' }, ip: null, id: null, get: () => undefined };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }

  // The host emits plugin.uninstalled for every uninstall (Manage Plugins, the
  // API, another plugin); recording it here is what keeps the boot installer
  // from putting the plugin back. The scan in ensureInstalled() covers an
  // uninstall that happened while this process was not listening.
  function noteUninstalled(id, version = null) {
    if (!BUNDLED_PLUGINS.some((p) => p.id === id)) return false;
    const manifest = readBundledManifest(id);
    record(id, manifest?.version ?? stmts.row.get(id)?.bundled_version ?? '0.0.0', null, 'uninstalled', version ? `version ${version} was uninstalled by the operator` : null);
    return true;
  }

  function watchHost() {
    if (typeof ctx.events?.on !== 'function') return false;
    ctx.events.on('plugin.uninstalled', (envelope) => {
      try { noteUninstalled(envelope?.payload?.pluginId, envelope?.payload?.version); } catch (err) { log.warn({ err }, 'could not record a bundled plugin uninstall'); }
    });
    return true;
  }

  // A plugin this service once installed (or saw installed) that the host no
  // longer has was removed by the operator: it is reported, never re-installed.
  const wasRemovedByOperator = (previous) => Boolean(previous && previous.installed_version != null && !['missing', 'failed', 'uninstalled'].includes(previous.action));

  // In production the boot install runs as a one-shot job: the job workers
  // start only after the panel listens and the host has loaded the plugins it
  // already had, so a slow activation never delays the first request. One
  // queued job is enough, however many boots were interrupted before it ran.
  function scheduleEnsureInstalled() {
    if (!ctx.jobs.types().includes(ENSURE_JOB)) return null;
    const queued = ctx.jobs.list({ type: ENSURE_JOB, status: 'queued', limit: 1 });
    if (queued.length) return queued[0];
    return ctx.jobs.enqueue(ENSURE_JOB, { trigger: 'boot' });
  }

  async function runEnsureInstalled(jobCtx) {
    const results = await ensureInstalled();
    for (const r of results) jobCtx.log(`${r.id}: ${r.action}${r.version ? ` ${r.version}` : ''}${r.error ? ` (${r.error})` : ''}`, r.action === 'failed' ? 'error' : 'info');
    return { results };
  }

  // Idempotent: a plugin that is missing from the host is installed and
  // enabled; one whose bundled version is newer is upgraded in place (the host
  // keeps its state and runs migrate()); anything else is left alone, so an
  // operator's disable or uninstall sticks.
  async function ensureInstalled({ req = bootRequest() } = {}) {
    const results = [];
    for (const def of BUNDLED_PLUGINS) {
      const manifest = readBundledManifest(def.id);
      if (!manifest) { results.push({ id: def.id, action: 'missing' }); record(def.id, '0.0.0', null, 'missing', `plugins/bundled/${def.id}/plugin.json is missing`); continue; }
      const existing = installedRow(def.id);
      const previous = stmts.row.get(def.id);
      try {
        if (!existing) {
          if (previous?.action === 'uninstalled') { results.push({ id: def.id, action: 'uninstalled' }); continue; }
          if (wasRemovedByOperator(previous)) {
            noteUninstalled(def.id, previous.installed_version);
            log.info({ plugin: def.id, version: previous.installed_version }, 'bundled plugin was uninstalled by the operator; not re-installing it');
            results.push({ id: def.id, action: 'uninstalled', version: previous.installed_version });
            continue;
          }
          await host().install({ dir: bundledDirOf(def.id), source: 'bundled' }, { user: req?.user, req });
          const enabled = await host().enable(def.id, { req });
          record(def.id, manifest.version, manifest.version, 'installed', enabled?.state === 'errored' ? enabled.lastError?.message : null);
          results.push({ id: def.id, action: 'installed', version: manifest.version, state: enabled?.state });
        } else if (semver && semver.compare(manifest.version, existing.version) > 0) {
          const r = await host().install({ dir: bundledDirOf(def.id), source: 'bundled' }, { user: req?.user, req });
          record(def.id, manifest.version, manifest.version, 'upgraded');
          results.push({ id: def.id, action: 'upgraded', from: existing.version, version: manifest.version, state: r.plugin?.state });
        } else {
          record(def.id, manifest.version, existing.version, 'kept');
          results.push({ id: def.id, action: 'kept', version: existing.version, state: existing.state });
        }
      } catch (err) {
        log.error({ err, plugin: def.id }, 'bundled plugin could not be installed');
        record(def.id, manifest.version, existing?.version ?? null, 'failed', err.message);
        results.push({ id: def.id, action: 'failed', error: err.message });
      }
    }
    return results;
  }

  function shape(def, user) {
    const manifest = readBundledManifest(def.id);
    const row = installedRow(def.id);
    const live = ctx.plugins?.isLive?.(def.id) === true;
    const ui = live ? host().uiCatalog().find((p) => p.id === def.id) : null;
    const bundled = stmts.row.get(def.id);
    return {
      id: def.id, label: def.label, fnKey: def.fnKey, bundledVersion: manifest?.version ?? null, description: manifest?.description ?? null,
      installed: Boolean(row), installedVersion: row?.version ?? null, state: row ? (live ? 'enabled' : row.state) : 'not-installed', lastError: row?.lastError ?? null,
      enabled: live, pages: ui?.pages ?? [], updateAvailable: Boolean(row && manifest && semver && semver.compare(manifest.version, row.version) > 0),
      bootAction: bundled?.action ?? null, bootError: bundled?.last_error ?? null, canManage: isRoot(user), roles: def.roles.slice(), canUse: def.roles.includes(user?.role),
    };
  }

  function list(user) {
    return BUNDLED_PLUGINS.map((def) => shape(def, user));
  }

  function status(id, user) {
    return shape(defOf(id), user);
  }

  async function enable(id, req) {
    const def = defOf(id);
    if (!installedRow(id)) {
      await host().install({ dir: bundledDirOf(id), source: 'bundled' }, { user: req?.user, req });
      record(id, readBundledManifest(id)?.version ?? '0.0.0', readBundledManifest(id)?.version ?? null, 'reinstalled');
    }
    const r = await host().enable(id, { req });
    if (r?.state === 'errored') throw new HttpError(422, 'plugin_errored', `${def.label} could not be enabled: ${r.lastError?.message || 'activation failed'}`, { plugin: r.lastError });
    req?.audit?.({ action: 'plugins.bundled.enable', target: id, args: { version: r?.version } });
    return status(id, req?.user);
  }

  async function disable(id, req) {
    defOf(id);
    if (!installedRow(id)) throw conflict(`${id} is not installed`);
    await host().disable(id, { req });
    req?.audit?.({ action: 'plugins.bundled.disable', target: id });
    return status(id, req?.user);
  }

  // Repair: copy the bundled files over the installed ones (same version
  // included) and enable; the host keeps settings, store and logs.
  async function reinstall(id, req) {
    const def = defOf(id);
    const manifest = readBundledManifest(id);
    if (!manifest) throw notFound(`plugins/bundled/${id}`);
    const r = await host().install({ dir: bundledDirOf(id), source: 'bundled' }, { user: req?.user, req });
    const enabled = await host().enable(id, { req });
    record(id, manifest.version, manifest.version, 'reinstalled', enabled?.state === 'errored' ? enabled.lastError?.message : null);
    req?.audit?.({ action: 'plugins.bundled.reinstall', target: id, args: { version: manifest.version, previousVersion: r.previousVersion } });
    if (enabled?.state === 'errored') throw new HttpError(422, 'plugin_errored', `${def.label} was reinstalled but could not be enabled: ${enabled.lastError?.message || 'activation failed'}`, { plugin: enabled.lastError });
    return status(id, req?.user);
  }

  // ------------------------------------------------------------ WP Toolkit ---

  function requireDatabases() {
    if (!ctx.databases) throw new CapabilityError('mysql', 'The Database Services module is not loaded, so WordPress cannot get a database');
    return ctx.databases;
  }

  // Asked of the agent, not the capability snapshot: the operator installs
  // WP-CLI and retries straight away, and nothing may be provisioned for an
  // install that cannot run.
  async function requireWpCli() {
    let d;
    try { d = await ctx.agent.op('web.wp.detect', {}); } catch (err) {
      if (err?.agentError && ['capability_missing', 'binary_not_found'].includes(err.code)) throw new CapabilityError('wpcli', err.message);
      throw err;
    }
    if (!d?.installed) throw new CapabilityError('wpcli', 'WP-CLI (wp) is not installed on this server, so WordPress cannot be installed');
    if (d.runuser === false) throw new CapabilityError('wpcli', 'runuser is required to run WP-CLI as the account user');
    return d;
  }

  // A credential is only ever drawn from the CSPRNG; lib/crypto.js provides
  // the usual generator and node:crypto stands in when a test context lacks it.
  function generatedPassword(length) {
    if (typeof ctx.crypto?.randomPassword === 'function') return ctx.crypto.randomPassword(length);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function accountsForInstall(user) {
    const r = ctx.accounts.list({ page: 1, pageSize: 500 }, user);
    return r.data.filter((a) => !a.suspended).map((a) => ({ username: a.username, domain: a.domain, home: a.home_dir || `${ctx.settings.get('basic.home_root') || '/home'}/${a.username}`, owner: a.owner }));
  }

  function siteDirOf(account, directory) {
    const home = account.home_dir || `${ctx.settings.get('basic.home_root') || '/home'}/${account.username}`;
    const rel = String(directory || '').replace(/^\/+|\/+$/g, '');
    if (rel && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rel)) throw badRequest('directory may only contain letters, digits, ".", "_" and "-" separated by "/"', { directory: ['Relative path below public_html'] });
    if (rel.split('/').includes('..')) throw badRequest('directory may not contain ".."', { directory: ['No ".." segments'] });
    return { home, site: rel ? `${home}/public_html/${rel}` : `${home}/public_html`, rel };
  }

  async function installWordPress(input, user, req) {
    const account = ctx.accounts.get(input.username, user);
    if (account.suspended) throw conflict(`Account "${account.username}" is suspended`);
    if (!ctx.plugins?.isLive?.('net.whm.wp-toolkit')) throw conflict('Enable the WP Toolkit plugin before installing WordPress');
    const { site, rel } = siteDirOf(account, input.directory);
    const url = input.url || `https://${account.domain}${rel ? `/${rel}` : ''}`;
    const databases = requireDatabases();
    await requireWpCli();
    const dbPassword = input.dbPassword || generatedPassword(20);
    const created = await databases.createDatabase({ account: account.username, name: input.dbName }, user, req);
    let dbUserName;
    try {
      const u = await databases.createUser({ account: account.username, name: input.dbUser || input.dbName, password: dbPassword, databases: [created.name] }, user, req);
      dbUserName = u.name;
    } catch (err) {
      try { await databases.dropDatabase(created.name, user, req); } catch (dropErr) { log.warn({ err: dropErr, database: created.name }, 'could not drop the database after the user creation failed'); }
      throw err;
    }
    const warnings = [];
    if (ctx.web?.ensureVhost) {
      try { await ctx.web.ensureVhost(account.username, req); } catch (err) { warnings.push(`virtual host: ${err.message}`); }
    } else warnings.push('Service Configuration is not loaded: the virtual host was not checked');
    const dbHost = databases.hostsFor ? (databases.hostsFor(account.id).includes('localhost') ? 'localhost' : databases.hostsFor(account.id)[0] || 'localhost') : 'localhost';
    const { lastInsertRowid } = stmts.wpInsert.run(account.username, site, url, created.name, dbUserName, null, 'queued', user?.username ?? null);
    const params = {
      installId: Number(lastInsertRowid), username: account.username, path: site, url, title: input.title, adminUser: input.adminUser, adminEmail: input.adminEmail || account.contact_email || `admin@${account.domain}`,
      adminPassword: ctx.crypto.encrypt(input.adminPassword), dbName: created.name, dbUser: dbUserName, dbPassword: ctx.crypto.encrypt(dbPassword), dbHost, tablePrefix: input.tablePrefix || 'wp_', locale: input.locale || 'en_US',
    };
    const job = ctx.jobs.enqueue(WP_INSTALL_JOB, params, { userId: user?.id ?? null });
    stmts.wpJob.run(job.id, Number(lastInsertRowid));
    req?.audit?.({ action: 'plugins.wp.install', target: `${account.username}:${site}`, args: { url, database: created.name, dbUser: dbUserName, adminUser: input.adminUser, jobId: job.id, warnings } });
    return { job: { id: job.id }, installId: Number(lastInsertRowid), path: site, url, database: created.name, dbUser: dbUserName, warnings };
  }

  async function runWordPressInstall(jobCtx) {
    const p = jobCtx.params;
    jobCtx.log(`installing WordPress for ${p.username} at ${p.path} (${p.url})`);
    jobCtx.progress(5, 'downloading WordPress');
    try {
      const r = await ctx.agent.op('web.wp.install', {
        username: p.username, path: p.path, url: p.url, title: p.title, adminUser: p.adminUser, adminEmail: p.adminEmail, adminPassword: ctx.crypto.decrypt(p.adminPassword),
        dbName: p.dbName, dbUser: p.dbUser, dbPassword: ctx.crypto.decrypt(p.dbPassword), dbHost: p.dbHost, tablePrefix: p.tablePrefix, locale: p.locale,
      });
      jobCtx.progress(90, 'registering the site with WP Toolkit');
      stmts.wpFinish.run('done', null, null, p.installId);
      if (ctx.jobs.types().includes(WP_DISCOVER_JOB)) {
        try { ctx.jobs.enqueue(WP_DISCOVER_JOB, { trigger: 'manual', params: { usernames: [p.username] } }); } catch (err) { jobCtx.log(`discovery could not be queued: ${err.message}`, 'warn'); }
      }
      jobCtx.progress(100, 'done');
      return { path: r.path, url: p.url, version: r.version ?? null, steps: r.steps ?? [] };
    } catch (err) {
      const cleanup = await compensateWordPressInstall(p, jobCtx, err);
      stmts.wpFinish.run('failed', err.message, cleanup, p.installId);
      throw err;
    }
  }

  // A failed install leaves nothing behind: the agent removes the files it
  // wrote (reported in the error details, as the account user) and the
  // database user and database created for it are dropped here (user first,
  // it holds the grants) so the same names work on the retry. What happened,
  // including a tree that could not be removed, is kept on the wp_installs row.
  async function compensateWordPressInstall(p, jobCtx, err = null) {
    const notes = [];
    const files = err?.details?.cleanup;
    if (typeof files === 'string' && files) {
      notes.push(`site ${p.path}: ${files}`);
      jobCtx.log(`site files: ${files}`, /left in place/i.test(files) ? 'warn' : 'info');
    } else if (err?.details?.step && err.details.step !== 'download') {
      notes.push(`site ${p.path} may still hold a partial WordPress tree; remove it before retrying`);
      jobCtx.log(`the agent did not report what it left in ${p.path}; check the directory before retrying`, 'warn');
    }
    if (!ctx.databases) return [...notes, 'database cleanup skipped: Database Services is not loaded'].join('; ');
    const req = bootRequest();
    const steps = [['user', p.dbUser, (name) => ctx.databases.dropUser(name, req.user, req)], ['database', p.dbName, (name) => ctx.databases.dropDatabase(name, req.user, req)]];
    for (const [kind, name, drop] of steps) {
      if (!name) continue;
      try {
        await drop(name);
        notes.push(`dropped ${kind} ${name}`);
        jobCtx.log(`dropped the ${kind} ${name} created for this install`);
      } catch (err) {
        notes.push(`could not drop ${kind} ${name}: ${err.message}`);
        jobCtx.log(`could not drop the ${kind} ${name}: ${err.message}`, 'warn');
        log.warn({ err, installId: p.installId, [kind]: name }, 'WordPress install cleanup failed');
      }
    }
    return notes.join('; ') || null;
  }

  function wordPressInstalls(user) {
    // Ownership is applied in SQL, before the LIMIT, so a reseller's installs
    // are never pushed out of the window by newer rows of other owners.
    const rows = isRoot(user) ? stmts.wpList.all() : user?.id != null ? stmts.wpListOwned.all({ ownerId: user.id }) : [];
    return rows.map((r) => ({ ...r, job: r.job_id ? (() => { try { const j = ctx.jobs.get(r.job_id); return { id: j.id, status: j.status, progress: j.progress, message: j.message }; } catch { return null; } })() : null }));
  }

  return {
    BUNDLED_PLUGINS, bundledDir: bundledDirOf, readBundledManifest,
    ensureInstalled, scheduleEnsureInstalled, runEnsureInstalled, watchHost, noteUninstalled, list, status, enable, disable, reinstall,
    accountsForInstall, siteDirOf, installWordPress, runWordPressInstall, wordPressInstalls,
    dataDir: () => config.pluginDataDir,
    record: (id) => json.parse(JSON.stringify(stmts.row.get(id) ?? null), null),
  };
}
