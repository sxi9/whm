import { json } from '../db/index.js';
import { HttpError, CapabilityError, unprocessable, notFound, conflict } from '../lib/errors.js';

// Calendars and Contacts (CalDAV/CardDAV) through the distribution's Radicale
// (contract §70). Attached as ctx.dav by routes/categories/service-configuration.js:
//   dav.status()                         -> admin card data (package, config, unit, publication, probe)
//   dav.install(user, req)               -> job `dav.install` (packages → configure → publish) → { job, pending }
//   dav.publish(req, { reload }) / unpublish(req)
//   dav.serverUrl()                      -> https://<hostname>/dav/ or null
//   dav.setUser(login, hash, req) / removeUser(login, req) / collections(login)
// The agent only ever sees bcrypt hashes; passwords are hashed by the panel.

export const DAV_APP = Object.freeze({ name: 'dav', alias: '/dav', scriptName: '/dav', port: 5232 });
export const DAV_PACKAGES = ['radicale', 'python3-bcrypt'];
export const DAV_PROXY_MODULES = ['proxy', 'proxy_http', 'headers'];
export const DAV_LOGIN_RE = /^(?=.{3,254}$)[a-z0-9][a-z0-9._-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FQDN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function createDavService(ctx) {
  const { db, settings, capabilities, logger } = ctx;
  const agent = () => ctx.agent;
  const web = () => { if (!ctx.web) throw new HttpError(503, 'service_unavailable', 'Service Configuration is not loaded'); return ctx.web; };
  const stmts = {
    applyFor: db.prepare('SELECT * FROM service_config_applies WHERE component = ?'),
    recordApply: db.prepare(`INSERT INTO service_config_applies (component, ok, summary, error, applied_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (component) DO UPDATE SET ok = excluded.ok, summary = excluded.summary, error = excluded.error, applied_at = excluded.applied_at`),
  };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const recordApply = (ok, summary, error = null) => { stmts.recordApply.run('dav', ok ? 1 : 0, JSON.stringify(summary ?? null), error); return lastApply(); };
  const lastApply = () => { const r = stmts.applyFor.get('dav'); return r ? { at: r.applied_at, ok: Boolean(r.ok), summary: json.parse(r.summary, null), error: r.error } : null; };
  const rawHostname = () => String(settings.get('basic.hostname', '') || '').trim();
  const serverHostname = () => { const h = rawHostname().toLowerCase(); return FQDN.test(h) ? h : null; };
  const serverUrl = () => { const h = serverHostname(); return h ? `https://${h}${DAV_APP.alias}/` : null; };

  function translate(err) {
    if (!err || !err.code || err instanceof HttpError) return err;
    if (err.code === 'capability_missing' || err.code === 'binary_not_found') return new CapabilityError('radicale', err.message);
    if (err.code === 'invalid_args') return unprocessable(`The agent rejected the request: ${err.message}`, err.details?.fields);
    if (err.code === 'not_found') return notFound(err.message);
    if (err.code === 'exists') return conflict(err.message);
    if (['refused', 'config_invalid', 'path_not_allowed', 'command_failed'].includes(err.code)) return new HttpError(422, err.code, err.message);
    return err;
  }
  async function op(name, args = {}, req) {
    try { return await agent().op(name, args, { req }); } catch (err) { throw translate(err); }
  }

  const pkgService = () => { const p = ctx.pkg || ctx.software?.pkg; return p && typeof p.install === 'function' ? p : null; };
  const recentJobs = () => ctx.jobs.list({ limit: 100 }).filter((j) => j.type === 'dav.install').slice(0, 5).map((j) => ({ id: j.id, status: j.status, created_at: j.created_at, error: j.error ?? null }));

  async function hostStatus() {
    try { return await op('dav.status'); } catch (err) { return { installed: false, version: null, bcrypt: null, listen: { host: '127.0.0.1', port: DAV_APP.port }, packages: DAV_PACKAGES, config: null, users: null, storage: null, unit: null, error: err.message }; }
  }

  async function publication() {
    const apps = await web().hostApps.list().catch(() => ({ installed: false, apps: [] }));
    const app = (apps.apps || []).find((a) => a.name === DAV_APP.name) || null;
    if (!app) return null;
    const host = serverHostname();
    return { alias: app.alias ?? DAV_APP.alias, file: app.path, managed: Boolean(app.managed), proxy: app.managed ? { port: DAV_APP.port, scriptName: DAV_APP.scriptName } : null, url: host ? `https://${host}${(app.alias ?? DAV_APP.alias).replace(/\/$/, '')}/` : null };
  }

  async function status() {
    await capabilities.ensureFresh();
    const apache = capabilities.has('apache');
    const host = serverHostname();
    const d = await hostStatus();
    const site = apache ? await web().hostname.status().catch(() => null) : null;
    const published = apache ? await publication() : null;
    const modules = apache && published ? await op('web.modules.status', { modules: DAV_PROXY_MODULES }).catch(() => null) : null;
    const http = published?.managed && site?.exists && site.enabled && d.installed ? await web().hostApps.probe(published.alias) : null;
    return {
      installed: Boolean(d.installed), version: d.version ?? null, bcrypt: d.bcrypt ?? null, packages: DAV_PACKAGES, pkgAvailable: Boolean(pkgService()),
      listen: d.listen, config: d.config, users: d.users, storage: d.storage, unit: d.unit,
      hostname: rawHostname() || null, fqdn: Boolean(host), apache,
      site: site ? { exists: site.exists, enabled: site.enabled, ssl: site.ssl, inSync: site.inSync, url: site.url } : null,
      published, url: published?.url ?? null, serverUrl: serverUrl(),
      modules: modules ? { missing: modules.missing, loaded: modules.modules } : null,
      http, warning: web().hostApps.warning(http, 'The calendar server'),
      lastApply: lastApply(), recentJobs: recentJobs(), error: d.error ?? null,
    };
  }

  // The job behind "Install": distro packages (through the agent, synchronously —
  // radicale is a few hundred KiB), then the managed configuration + unit, then
  // the /dav publication when Apache and a hostname are there.
  async function installJob(job) {
    job.progress(5, 'installing packages');
    const present = await job.agent.op('dav.status');
    if (!present.installed) {
      job.log(`installing ${DAV_PACKAGES.join(' ')}`);
      const r = await job.agent.op('pkg.install', { packages: DAV_PACKAGES, noRecommends: true }, { timeoutMs: 45 * 60_000 });
      for (const line of (r.output || []).slice(-60)) job.log(line);
      await capabilities.refresh().catch((err) => job.log(`capability re-detection failed: ${err.message}`, 'warn'));
    } else job.log(`radicale ${present.version || ''} is already installed`.trim());
    job.progress(55, 'writing the configuration');
    const conf = await job.agent.op('dav.install', {});
    job.log(`${conf.config.path} ${conf.config.changed ? 'written' : 'unchanged'}; ${conf.unit.name} ${conf.unit.active ? 'active' : 'not active'}${conf.unit.restarted ? ' (restarted)' : ''}`);
    let published = null;
    if (capabilities.has('apache') && serverHostname()) {
      job.progress(80, 'publishing /dav under the hostname site');
      try {
        published = await publish(null, { reload: true });
        job.log(`published at ${published.url}${published.warning ? ` — ${published.warning}` : ''}`);
      } catch (err) {
        job.log(`publish failed: ${err.message} (install finished; publish again from the card)`, 'warn');
      }
    } else job.log('Apache or a fully qualified hostname is missing, so /dav was not published', 'warn');
    job.progress(100, 'finished');
    recordApply(true, { installed: true, config: conf.config, unit: { active: conf.unit.active }, published: published ? { url: published.url, http: published.http ? { status: published.http.status, ok: published.http.ok } : null } : null }, published?.warning ?? null);
    return { installed: true, config: conf.config, unit: conf.unit, published: published ? { url: published.url, changed: published.changed } : null };
  }

  function install(user, req) {
    const job = ctx.jobs.enqueue('dav.install', { packages: DAV_PACKAGES }, { userId: user?.id ?? null });
    audit(req, { action: 'dav.install', target: DAV_APP.name, args: { packages: DAV_PACKAGES, job: job.id } });
    return { job, packages: DAV_PACKAGES, pending: true };
  }

  async function publish(req, { reload = true } = {}) {
    capabilities.require('apache', 'Apache is not installed on this server, so the calendar server cannot be published under the hostname site.');
    const d = await hostStatus();
    if (!d.installed) throw new CapabilityError('radicale', `Radicale is not installed on this server. Install it from this card (packages ${DAV_PACKAGES.join(', ')}) and publish again.`);
    try {
      const mods = await op('web.modules.status', { modules: DAV_PROXY_MODULES }, req);
      let enabled = null;
      if (mods.missing?.length) enabled = await op('web.modules.enable', { modules: mods.missing, reload: false }, req);
      const app = await web().hostApps.publish({ name: DAV_APP.name, alias: DAV_APP.alias, php: false, proxy: { port: DAV_APP.port, scriptName: DAV_APP.scriptName }, options: ['None'], reload }, req);
      const http = reload ? await web().hostApps.probe(app.alias) : null;
      const warning = web().hostApps.warning(http, 'The calendar server');
      recordApply(http?.ok !== false, { alias: app.alias, url: app.url, changed: app.changed, modules: enabled ? enabled.enabled : [], warnings: (app.warnings || []).map((w) => w.code), http: http ? { status: http.status, ok: http.ok } : null }, warning);
      audit(req, { action: 'dav.publish', target: app.url, args: { alias: app.alias, path: app.path, changed: app.changed, reloaded: app.reloaded, modules: enabled ? enabled.enabled : [], http: http ? { status: http.status, ok: http.ok } : null } });
      return { installed: true, alias: app.alias, url: app.url, path: app.path, changed: app.changed, reloaded: app.reloaded, validated: app.validated, modules: enabled, http, warning, warnings: app.warnings };
    } catch (err) {
      recordApply(false, { alias: DAV_APP.alias }, err.message);
      throw err;
    }
  }

  async function unpublish(req) {
    capabilities.require('apache');
    const r = await web().hostApps.unpublish(DAV_APP.name, req);
    recordApply(true, { unpublished: true, removed: r.removed });
    audit(req, { action: 'dav.unpublish', target: DAV_APP.name, args: { removed: r.removed, reloaded: r.reloaded, path: r.path } });
    return r;
  }

  // ---- what the account panel needs (hashes only) ---------------------------
  async function available() {
    const d = await hostStatus();
    const published = capabilities.has('apache') ? await publication().catch(() => null) : null;
    return { installed: Boolean(d.installed), active: Boolean(d.unit?.active), published: Boolean(published?.managed), url: published?.url ?? null, error: d.error ?? null };
  }
  async function setUser(login, hash, req) {
    if (!DAV_LOGIN_RE.test(login)) throw unprocessable('Invalid DAV login', { login: ['Must be local@domain'] });
    if (typeof hash !== 'string' || !/^\$2[aby]\$/.test(hash)) throw new HttpError(500, 'internal', 'A DAV password must be hashed before it reaches the agent');
    return op('dav.user.set', { login, hash }, req);
  }
  async function removeUser(login, req) {
    if (!DAV_LOGIN_RE.test(login)) throw unprocessable('Invalid DAV login', { login: ['Must be local@domain'] });
    return op('dav.user.remove', { login }, req);
  }
  async function collections(login) {
    if (!DAV_LOGIN_RE.test(login)) throw unprocessable('Invalid DAV login', { login: ['Must be local@domain'] });
    try { return await op('dav.collections', { login }); } catch (err) {
      logger.debug({ err, login }, 'dav: collections unavailable');
      return { login, exists: false, collections: [], error: err.message };
    }
  }

  return { status, install, installJob, publish, unpublish, serverUrl, serverHostname, available, setUser, removeUser, collections };
}
