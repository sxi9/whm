'use strict';

// WP Toolkit: the "sites" collection holds every WordPress installation the
// discover job found under account web roots; the routes drive WP-CLI (as the
// account user, through the web.wp.* agent ops) for one site at a time.
// Resellers only see and touch sites of accounts they own. One-click install
// lives in the panel's Plugins category route (it needs the database and
// vhost services), not here.

const USERNAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const INSPECT_TTL_MS = 10 * 60e3;

const isCapabilityError = (err) => err && (err.status === 501 || err.code === 'CAPABILITY_MISSING' || err.code === 'BINARY_NOT_FOUND');

function siteKey(username, p) {
  return `${username}:${p}`;
}

async function visibleAccounts(ctx, user) {
  const filter = { pageSize: 500 };
  if (user.role !== 'root') filter.owner = user.username;
  const page = await ctx.api.accounts.list(filter);
  return page.data;
}

async function assertOwner(ctx, user, username) {
  if (user.role === 'root') return;
  const account = await ctx.api.accounts.get(username);
  if (account.owner !== user.username) throw new ctx.errors.PermissionError('accounts:owner', 'wp-toolkit', ctx.plugin.id);
}

async function loadSite(ctx, user, id) {
  const site = await ctx.store.collection('sites').findOne({ id: String(id) });
  if (!site) throw new ctx.errors.NotFoundError('site', id);
  await assertOwner(ctx, user, site.username);
  return site;
}

async function discover(ctx, { usernames, log = () => {}, signal } = {}) {
  const settings = await ctx.settings.getAll();
  const accounts = await visibleAccounts(ctx, { role: 'root' });
  const wanted = accounts.map((a) => a.username).filter((u) => !usernames || usernames.includes(u));
  const sites = ctx.store.collection('sites');
  const known = await sites.find({});
  const seen = new Set();
  let added = 0;
  let updated = 0;
  const batch = 25;
  for (let i = 0; i < wanted.length; i += batch) {
    if (signal?.aborted) throw new ctx.errors.PluginError('discovery cancelled', { code: 'JOB_CANCELLED', status: 409 });
    const slice = wanted.slice(i, i + batch);
    const r = await ctx.agent.op('web.wp.discover', { usernames: slice, maxDepth: Math.min(4, Math.max(0, Number(settings.maxDepth ?? 3))) });
    for (const inst of r.installs || []) {
      const key = siteKey(inst.username, inst.path);
      seen.add(key);
      const existing = known.find((s) => s.key === key);
      const fields = { username: inst.username, path: inst.path, relative: inst.relative, version: inst.version, dbName: inst.dbName, tablePrefix: inst.tablePrefix, lastSeenAt: ctx.now() };
      if (existing) { await sites.update({ id: existing.id }, fields); updated++; } else { await sites.insert({ key, ...fields, discoveredAt: ctx.now(), inspection: null }); added++; }
    }
    log(`${slice.length} account(s) searched, ${(r.installs || []).length} site(s) found`);
  }
  let removed = 0;
  for (const s of known) if (!seen.has(s.key) && (!usernames || usernames.includes(s.username))) { await sites.remove({ id: s.id }); removed++; }
  await ctx.store.set('lastDiscovery', { at: ctx.now(), accounts: wanted.length, sites: seen.size });
  return { accounts: wanted.length, sites: seen.size, added, updated, removed };
}

async function inspect(ctx, site, { fresh = false } = {}) {
  if (!fresh && site.inspection && ctx.now() - site.inspection.inspectedAt < INSPECT_TTL_MS) return site.inspection;
  const r = await ctx.agent.op('web.wp.inspect', { username: site.username, path: site.path });
  const inspection = { ...r, inspectedAt: ctx.now() };
  await ctx.store.collection('sites').update({ id: site.id }, { inspection, version: r.version || site.version });
  return inspection;
}

function shapeSite(s) {
  const insp = s.inspection || null;
  return {
    id: s.id, username: s.username, path: s.path, relative: s.relative, version: s.version, dbName: s.dbName, discoveredAt: s.discoveredAt, lastSeenAt: s.lastSeenAt,
    siteUrl: insp?.siteUrl ?? null, maintenance: insp?.maintenance ?? null, coreUpdate: insp?.coreUpdates?.[0]?.version ?? null,
    pluginUpdates: insp ? insp.plugins.filter((p) => p.update === 'available').length : null, themeUpdates: insp ? insp.themes.filter((t) => t.update === 'available').length : null,
    inspectedAt: insp?.inspectedAt ?? null,
  };
}

module.exports = {
  async activate(ctx) {
    ctx.log.info('WP Toolkit active', { version: ctx.plugin.version });
  },

  jobs: {
    async discover(job, ctx) {
      const r = await discover(ctx, { usernames: Array.isArray(job.params.usernames) && job.params.usernames.length ? job.params.usernames : null, log: job.log, signal: job.signal });
      job.progress(100, `${r.sites} site(s)`);
      return r;
    },
    async update(job, ctx) {
      const { siteId, kind, name, all } = job.params;
      const site = await ctx.store.collection('sites').findOne({ id: String(siteId) });
      if (!site) throw new ctx.errors.NotFoundError('site', siteId);
      job.log(`updating ${kind}${name ? ` ${name}` : all ? ' (all)' : ''} on ${site.path} as ${site.username}`);
      job.progress(10, 'running WP-CLI');
      const r = await ctx.agent.op('web.wp.update', { username: site.username, path: site.path, kind, ...(name ? { name } : {}), all: Boolean(all) });
      for (const line of String(r.output || '').split('\n').filter(Boolean).slice(-40)) job.log(line);
      job.progress(80, 'refreshing site details');
      let inspection = null;
      try { inspection = await inspect(ctx, site, { fresh: true }); } catch (err) { job.log(`inspection after update failed: ${err.message}`); }
      await ctx.api.audit.record({ action: 'update', target: `${site.username}:${site.path}`, details: { kind, name: name ?? null, all: Boolean(all), version: inspection?.version ?? null } });
      job.progress(100, 'done');
      return { kind, name: name ?? null, all: Boolean(all), version: inspection?.version ?? null, databaseUpdated: r.databaseUpdated ?? null };
    },
  },

  routes(http, ctx) {
    const roles = ['root', 'reseller'];
    http.get('/status', { roles }, async (req, res) => {
      let wpcli = { installed: false, version: null };
      const errors = {};
      try { wpcli = await ctx.agent.op('web.wp.detect', {}); } catch (err) { errors.wpcli = err.message; }
      const accounts = await visibleAccounts(ctx, req.user);
      const mine = new Set(accounts.map((a) => a.username));
      const all = await ctx.store.collection('sites').find({});
      const sites = all.filter((s) => req.user.role === 'root' || mine.has(s.username));
      res.json({ wpcli, errors, lastDiscovery: (await ctx.store.get('lastDiscovery')) || null, sites: sites.length, outdated: sites.filter((s) => s.inspection?.coreUpdates?.length).length, accounts: accounts.map((a) => ({ username: a.username, domain: a.domain })), install: { steps: ['curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar', 'chmod +x wp-cli.phar', 'mv wp-cli.phar /usr/local/bin/wp', 'wp --info'], url: 'https://wp-cli.org/#installing' } });
    });

    http.get('/sites', { roles }, async (req, res) => {
      const accounts = await visibleAccounts(ctx, req.user);
      const mine = new Set(accounts.map((a) => a.username));
      const rows = (await ctx.store.collection('sites').find({}, { sort: { username: 1 } })).filter((s) => req.user.role === 'root' || mine.has(s.username));
      res.json(rows.map(shapeSite));
    });

    http.post('/discover', { roles }, async (req, res) => {
      const body = req.body || {};
      let usernames = Array.isArray(body.usernames) ? body.usernames.filter((u) => typeof u === 'string' && USERNAME_RE.test(u)) : [];
      if (req.user.role !== 'root') {
        const mine = (await visibleAccounts(ctx, req.user)).map((a) => a.username);
        usernames = usernames.length ? usernames.filter((u) => mine.includes(u)) : mine;
        if (!usernames.length) { res.json({ accounts: 0, sites: 0, added: 0, updated: 0, removed: 0 }); return; }
      }
      if (body.background) { const jobId = await ctx.jobs.run('discover', { usernames }); res.status(202).json({ jobId }); return; }
      res.json(await discover(ctx, { usernames: usernames.length ? usernames : null }));
    });

    http.get('/sites/:id', { roles }, async (req, res) => {
      const site = await loadSite(ctx, req.user, req.params.id);
      const inspection = await inspect(ctx, site, { fresh: req.query.fresh === '1' || req.query.fresh === 'true' });
      res.json({ ...shapeSite({ ...site, inspection }), inspection });
    });

    http.post('/sites/:id/update', { roles }, async (req, res) => {
      const site = await loadSite(ctx, req.user, req.params.id);
      const body = req.body || {};
      const E = ctx.errors;
      if (!['core', 'plugin', 'theme'].includes(body.kind)) throw new E.ValidationError('kind must be core, plugin or theme');
      const name = body.name === undefined || body.name === null || body.name === '' ? null : String(body.name);
      if (name && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name)) throw new E.ValidationError('name must be a plugin or theme slug');
      if (body.kind !== 'core' && !name && !body.all) throw new E.ValidationError('name or all is required');
      const jobId = await ctx.jobs.run('update', { siteId: site.id, kind: body.kind, name, all: Boolean(body.all) });
      res.status(202).json({ jobId });
    });

    http.post('/sites/:id/maintenance', { roles }, async (req, res) => {
      const site = await loadSite(ctx, req.user, req.params.id);
      const enabled = Boolean(req.body?.enabled);
      await ctx.agent.op('web.wp.maintenance', { username: site.username, path: site.path, enabled });
      if (site.inspection) await ctx.store.collection('sites').update({ id: site.id }, { inspection: { ...site.inspection, maintenance: enabled } });
      await ctx.api.audit.record({ action: 'maintenance', target: `${site.username}:${site.path}`, details: { enabled, by: req.user.username } });
      res.json({ enabled });
    });

    http.get('/sites/:id/harden', { roles }, async (req, res) => {
      const site = await loadSite(ctx, req.user, req.params.id);
      res.json(await ctx.agent.op('web.wp.harden', { username: site.username, path: site.path }));
    });

    http.post('/sites/:id/harden', { roles }, async (req, res) => {
      const site = await loadSite(ctx, req.user, req.params.id);
      const fixes = Array.isArray(req.body?.fixes) ? req.body.fixes.filter((f) => ['config-perms', 'disallow-file-edit', 'debug-off', 'auto-update-core'].includes(f)) : [];
      if (!fixes.length) throw new ctx.errors.ValidationError('fixes must name at least one known hardening fix');
      const r = await ctx.agent.op('web.wp.hardenfix', { username: site.username, path: site.path, fixes });
      await ctx.api.audit.record({ action: 'harden', target: `${site.username}:${site.path}`, details: { fixes, applied: r.applied, by: req.user.username } });
      res.json(r);
    });

    http.delete('/sites/:id', { roles }, async (req, res) => {
      const site = await loadSite(ctx, req.user, req.params.id);
      await ctx.store.collection('sites').remove({ id: site.id });
      res.json({ removed: true });
    });
  },
};

module.exports.__test = { discover, inspect, shapeSite, siteKey, assertOwner };
