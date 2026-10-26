import fs from 'node:fs';
import path from 'node:path';
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
export const BUNDLED_PLUGINS = Object.freeze([
  { id: 'net.whm.server-monitoring', fnKey: 'plugins/server-monitoring', label: 'Server Monitoring' },
  { id: 'net.whm.imunifyav', fnKey: 'plugins/imunifyav', label: 'ImunifyAV' },
  { id: 'net.whm.wp-toolkit', fnKey: 'plugins/wp-toolkit', label: 'WP Toolkit' },
]);
export const WP_INSTALL_JOB = 'plugins.wp.install';
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
    wpFinish: db.prepare(`UPDATE wp_installs SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?`),
    wpList: db.prepare('SELECT * FROM wp_installs WHERE (@username IS NULL OR username = @username) ORDER BY id DESC LIMIT 50'),
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
          if (previous && previous.action === 'uninstalled') { results.push({ id: def.id, action: 'uninstalled' }); continue; }
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
      bootAction: bundled?.action ?? null, bootError: bundled?.last_error ?? null, canManage: isRoot(user),
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
    const dbPassword = input.dbPassword || ctx.crypto.randomPassword?.(20) || `Wp${Math.random().toString(36).slice(2, 12)}!${Date.now().toString(36)}`;
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
      stmts.wpFinish.run('done', null, p.installId);
      if (ctx.jobs.types().includes(WP_DISCOVER_JOB)) {
        try { ctx.jobs.enqueue(WP_DISCOVER_JOB, { trigger: 'manual', params: { usernames: [p.username] } }); } catch (err) { jobCtx.log(`discovery could not be queued: ${err.message}`, 'warn'); }
      }
      jobCtx.progress(100, 'done');
      return { path: r.path, url: p.url, version: r.version ?? null, steps: r.steps ?? [] };
    } catch (err) {
      stmts.wpFinish.run('failed', err.message, p.installId);
      throw err;
    }
  }

  function wordPressInstalls(user) {
    const rows = stmts.wpList.all({ username: null });
    const visible = isRoot(user) ? rows : rows.filter((r) => { try { ctx.accounts.get(r.username, user); return true; } catch { return false; } });
    return visible.map((r) => ({ ...r, job: r.job_id ? (() => { try { const j = ctx.jobs.get(r.job_id); return { id: j.id, status: j.status, progress: j.progress, message: j.message }; } catch { return null; } })() : null }));
  }

  return {
    BUNDLED_PLUGINS, bundledDir: bundledDirOf, readBundledManifest,
    ensureInstalled, list, status, enable, disable, reinstall,
    accountsForInstall, siteDirOf, installWordPress, runWordPressInstall, wordPressInstalls,
    dataDir: () => config.pluginDataDir,
    record: (id) => json.parse(JSON.stringify(stmts.row.get(id) ?? null), null),
  };
}
