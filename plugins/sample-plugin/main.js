'use strict';

// Sample Notes — the reference plugin for the WHM plugin SDK (plugins/SDK.md).
// A small notebook per server that touches every extension point: settings of
// every type, cancellable and plain hooks, two jobs, two cron schedules, every
// page kind, routes with roles, the store (kv + collection), fs, crypto, an
// outbound fetch under a net:outbound scope, plugin events, i18n and migrate().
//
// Nothing here is required by the host beyond module.exports.{activate,
// deactivate, migrate, routes, hooks, jobs}; the structure is what a plugin
// author would copy. ctx is the host context documented in SDK.md.

const ID = 'net.whm.sample-notes';
const WEBHOOK_URL = 'https://hooks.example.net/whm-notes';
const CATEGORIES = ['ops', 'billing', 'security', 'misc'];
const DIGEST_WINDOW_MS = 24 * 3600e3;
const EXPORT_FILE = 'exports/latest-digest.json';
const DAY_MS = 86400e3;

const notesOf = (ctx) => ctx.store.collection('notes');

function blockedList(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Error classes come from ctx.errors (the same objects the host hands every
// plugin), so the module needs no require() at all.
function validateNote(body, { ValidationError }) {
  if (!body || typeof body !== 'object') throw new ValidationError('a JSON object is required');
  const fields = [];
  if (typeof body.title !== 'string' || !body.title.trim()) fields.push({ path: 'title', code: 'REQUIRED', message: 'title is required' });
  else if (body.title.length > 120) fields.push({ path: 'title', code: 'LENGTH', message: 'title must be at most 120 characters' });
  if (body.body !== undefined && (typeof body.body !== 'string' || body.body.length > 4000)) fields.push({ path: 'body', code: 'LENGTH', message: 'body must be a string of at most 4000 characters' });
  const category = body.category === undefined ? 'ops' : body.category;
  if (!CATEGORIES.includes(category)) fields.push({ path: 'category', code: 'UNKNOWN', message: `category must be one of ${CATEGORIES.join(', ')}` });
  if (body.account !== undefined && (typeof body.account !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(body.account))) fields.push({ path: 'account', code: 'PATTERN', message: 'account must be a username' });
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string' || t.length > 32) || body.tags.length > 10)) fields.push({ path: 'tags', code: 'TYPE', message: 'tags must be up to 10 short strings' });
  if (fields.length) throw new ValidationError('invalid note', fields);
  return { title: body.title.trim(), body: body.body || '', category, account: body.account || null, tags: body.tags || [] };
}

async function addNote(ctx, note, { principal = 'root' } = {}) {
  const doc = await notesOf(ctx).insert({ ...note, createdBy: principal, createdAtIso: new Date(ctx.now()).toISOString() });
  await ctx.store.set('stats:lastNoteAt', ctx.now());
  await ctx.events.emit(`${ID}.note_created`, { id: doc.id, title: doc.title, category: doc.category, account: doc.account });
  return doc;
}

// The webhook token is a password-type setting (stored encrypted by the host);
// what the plugin keeps in its own store is encrypted again with ctx.crypto so a
// store dump never shows it in clear.
async function rememberToken(ctx, token) {
  if (!token) { await ctx.store.delete('webhook:token'); return; }
  await ctx.store.set('webhook:token', await ctx.crypto.encrypt(token));
}
async function webhookToken(ctx) {
  const enc = await ctx.store.get('webhook:token');
  return enc ? ctx.crypto.decrypt(enc) : null;
}

// Tenancy: a reseller may only see notes attached to accounts it owns. Every
// route that returns a note applies this, not only the list.
async function ownedAccounts(ctx, user) {
  return new Set((await ctx.api.accounts.list({ owner: user.username, pageSize: 500 })).data.map((a) => a.username));
}
async function ownsNote(ctx, user, note) {
  return Boolean(note.account) && (await ownedAccounts(ctx, user)).has(note.account);
}

async function postDigest(ctx, digest, token) {
  const res = await ctx.net.fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(digest),
  });
  return { ok: !!res.ok, status: res.status };
}

module.exports = {
  // ------------------------------------------------------------ lifecycle
  async activate(ctx) {
    const settings = await ctx.settings.getAll();
    await rememberToken(ctx, settings.webhookToken);
    ctx.settings.onChange(async (key, value) => {
      ctx.log.info('setting changed', { setting: key });
      if (key === 'webhookToken') await rememberToken(ctx, value);
    });
    if ((await ctx.store.get('installedAt')) === undefined) await ctx.store.set('installedAt', ctx.now());
    await ctx.fs.mkdir('exports');
    // A page registered at runtime (the manifest declares the other six).
    const schedules = (await ctx.schedule.list()).map((s) => `- **${s.name}**: \`${s.expr}\` (next ${new Date(s.nextRunAt).toISOString()})`).join('\n');
    await ctx.ui.registerPage({ route: '/schedules', title: 'Schedules', kind: 'markdown', content: `# Schedules at activation\n\n${schedules || '_none_'}\n\nLive values: \`GET ${ctx.http.baseUrl}/schedules\`.` });
    ctx.log.info('activated', { version: ctx.plugin.version, host: ctx.plugin.hostVersion, locale: ctx.i18n.locale() });
  },

  async deactivate(ctx) {
    ctx.log.info('deactivated');
  },

  // 1.0.x stored notes without `tags` and `category`; 1.1.0 reads both.
  async migrate(ctx, fromVersion) {
    const notes = notesOf(ctx);
    let patched = 0;
    for (const n of await notes.find({})) {
      if (Array.isArray(n.tags) && CATEGORIES.includes(n.category)) continue;
      await notes.update({ id: n.id }, { tags: n.tags || [], category: CATEGORIES.includes(n.category) ? n.category : 'misc' });
      patched++;
    }
    await ctx.store.set('migratedFrom', fromVersion);
    ctx.log.info('migrated', { from: fromVersion, to: ctx.plugin.version, patched });
    return { patched };
  },

  // ------------------------------------------------------------ hooks
  hooks: {
    // pre stage, cancellable with accounts:write: refuse blocked usernames.
    async beforeAccountCreated(evt, ctx) {
      const blocked = blockedList(await ctx.settings.get('blockedUsernames'));
      if (blocked.includes(evt.payload.username)) {
        await ctx.api.audit.record({ action: 'account.blocked', target: evt.payload.username, details: { by: evt.principal } });
        evt.cancel(ctx.i18n.t('note.blocked', { username: evt.payload.username }));
      }
    },
    async afterAccountCreated(evt, ctx) {
      const { username, domain } = evt.payload;
      const account = await ctx.api.accounts.get(username);
      await addNote(ctx, {
        title: ctx.i18n.t('note.welcome.title', { username }),
        body: ctx.i18n.t('note.welcome.body', { username, domain: domain || account.domain, date: new Date(evt.ts).toISOString().slice(0, 10) }),
        category: 'ops', account: username, tags: ['welcome'],
      }, { principal: evt.principal });
    },
    async afterAccountTerminated(evt, ctx) {
      const removed = await notesOf(ctx).remove({ account: evt.payload.username });
      ctx.log.info('notes of a terminated account removed', { username: evt.payload.username, removed });
    },
  },

  // ------------------------------------------------------------ jobs
  jobs: {
    async digest(job, ctx) {
      const settings = await ctx.settings.getAll();
      if (!settings.digestEnabled && job.params.source === 'cron') return { skipped: true, reason: 'disabled' };
      job.progress(10, 'collecting notes');
      const since = ctx.now() - DIGEST_WINDOW_MS;
      const sort = settings.sortOrder === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
      const recent = (await notesOf(ctx).find({ createdAt: { $gte: since } }, { sort })).filter((n) => settings.categories.includes(n.category));
      if (job.signal.aborted) return null;
      const vars = { title: settings.title, count: recent.length, since: new Date(since).toISOString() };
      const digest = { title: settings.title, generatedAt: new Date(ctx.now()).toISOString(), since: vars.since, count: recent.length, notes: recent.map((n) => ({ id: n.id, title: n.title, category: n.category, account: n.account })) };
      job.progress(40, 'writing export');
      await ctx.fs.writeFile(EXPORT_FILE, JSON.stringify(digest, null, 2));
      job.progress(60, 'notifying');
      await ctx.api.contacts.notify({
        event: `${ID}.digest`, severity: 'info',
        subject: ctx.i18n.t('digest.subject', vars),
        body: ctx.i18n.t(recent.length ? 'digest.body' : 'digest.empty', vars),
      });
      let webhook = null;
      const token = await webhookToken(ctx);
      if (token) {
        job.progress(80, 'posting webhook');
        try { webhook = await postDigest(ctx, digest, token); } catch (err) { webhook = { ok: false, error: err.message }; ctx.log.warn('webhook failed', { error: err.message }); }
      }
      await ctx.store.set('digest:last', { at: ctx.now(), count: recent.length, webhook });
      await ctx.events.emit(`${ID}.digest_sent`, { count: recent.length, webhook: !!(webhook && webhook.ok) });
      job.progress(100, 'done');
      return { count: recent.length, file: EXPORT_FILE, webhook };
    },

    async housekeeping(job, ctx) {
      const max = await ctx.settings.get('maxNotes');
      const notes = notesOf(ctx);
      const all = await notes.find({}, { sort: { createdAt: -1 } });
      const stale = all.slice(max);
      for (const n of stale) await notes.remove({ id: n.id });
      const summary = ctx.i18n.t('housekeeping.summary', { removed: stale.length, kept: all.length - stale.length });
      job.log(summary);
      ctx.log.info(summary, { removed: stale.length });
      return { removed: stale.length, kept: all.length - stale.length };
    },
  },

  // ------------------------------------------------------------ routes
  routes(router, ctx) {
    router.get('/notes', { roles: ['root', 'reseller'] }, async (req, res) => {
      const sort = (await ctx.settings.get('sortOrder')) === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
      const query = {};
      if (req.query.category) query.category = String(req.query.category);
      if (req.query.account) query.account = String(req.query.account);
      // Resellers only see notes attached to accounts they own.
      let rows = await notesOf(ctx).find(query, { sort, limit: 200 });
      if (req.user.role === 'reseller') {
        const owned = await ownedAccounts(ctx, req.user);
        rows = rows.filter((n) => n.account && owned.has(n.account));
      }
      res.json(rows.map((n) => ({ id: n.id, title: n.title, category: n.category, account: n.account, tags: n.tags, createdAt: n.createdAtIso || new Date(n.createdAt).toISOString() })));
    });

    router.post('/notes', { roles: ['root', 'reseller'] }, async (req, res) => {
      const note = validateNote(req.body, ctx.errors);
      if (note.account) {
        const account = await ctx.api.accounts.get(note.account);
        if (req.user.role === 'reseller' && account.owner !== req.user.username) throw new ctx.errors.ConflictError(`account "${note.account}" is not owned by ${req.user.username}`);
      }
      const doc = await addNote(ctx, note, { principal: req.user.username });
      res.status(201).json(doc);
    });

    router.get('/notes/:id', { roles: ['root', 'reseller'] }, async (req, res) => {
      const doc = await notesOf(ctx).findOne({ id: req.params.id });
      // Same scope as the list: a reseller gets 404, not 403, for a note it may
      // not see, so ids of other tenants' notes are not confirmed to exist.
      if (!doc || (req.user.role === 'reseller' && !(await ownsNote(ctx, req.user, doc)))) throw new ctx.errors.NotFoundError('note', req.params.id);
      res.json(doc);
    });

    router.delete('/notes/:id', async (req, res) => {
      const removed = await notesOf(ctx).remove({ id: req.params.id });
      if (!removed) throw new ctx.errors.NotFoundError('note', req.params.id);
      res.status(204).send('');
    });

    router.get('/status', async (req, res) => {
      const [count, last, installedAt, migratedFrom, exported] = await Promise.all([
        notesOf(ctx).count({}), ctx.store.get('digest:last'), ctx.store.get('installedAt'), ctx.store.get('migratedFrom'), ctx.fs.exists(EXPORT_FILE),
      ]);
      const schedules = await ctx.schedule.list();
      res.json({ plugin: ctx.plugin.id, version: ctx.plugin.version, notes: count, lastDigest: last || null, installedAt: installedAt || null, migratedFrom: migratedFrom || null, exportPresent: exported, schedules: schedules.map((s) => ({ name: s.name, expr: s.expr, nextRunAt: s.nextRunAt })), webhookConfigured: !!(await ctx.store.get('webhook:token')), daysInstalled: installedAt ? Math.floor((ctx.now() - installedAt) / DAY_MS) : 0 });
    });

    router.get('/schedules', { roles: ['root', 'reseller'] }, async (req, res) => {
      res.json((await ctx.schedule.list()).map((s) => ({ name: s.name, job: s.jobName, expr: s.expr, nextRunAt: new Date(s.nextRunAt).toISOString(), lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null })));
    });

    router.get('/export', async (req, res) => {
      if (!(await ctx.fs.exists(EXPORT_FILE))) throw new ctx.errors.NotFoundError('export', EXPORT_FILE);
      res.set('content-type', 'application/json');
      res.send(await ctx.fs.readFile(EXPORT_FILE));
    });

    router.post('/digest', async (req, res) => {
      const jobId = await ctx.jobs.run('digest', { source: 'route', by: req.user.username });
      res.status(202).json({ job: { id: jobId } });
    });
  },

  __test: { validateNote, blockedList, WEBHOOK_URL, EXPORT_FILE, CATEGORIES },
};
