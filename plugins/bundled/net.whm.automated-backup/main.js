'use strict';

// Automated Backup: scheduled account backups on top of the host's backup API.
//
// A run takes the accounts the settings select, locks each one in the plugin
// store (`lock:<account>`, TTL from the settings), creates the archive, verifies
// it, uploads it to every configured destination, records it in the `artefacts`
// collection and then applies retention. Retention keeps the newest archive of
// the last N days, N ISO weeks and N months and deletes every other LOCAL
// archive the plugin created through ctx.api.backups.delete; the host has no API
// to remove a copy from a destination, so remote copies are left to the
// destination's own retention and recorded as remote: 'retained'. Host-initiated
// backups (Backup category, other plugins) are recorded in the history through
// the backup.completed/backup.failed hooks but are never pruned here.
//
// The host only produces gzip-compressed, unencrypted archives: `encrypt: true`
// is refused with UNSUPPORTED, which a run records as a warning before writing
// the archive unencrypted.

const crypto = require('node:crypto');

const ID = 'net.whm.automated-backup';
const DAY_MS = 86400e3;
const MAX_RUNS_KEPT = 500;
const LOCK_PREFIX = 'lock:';
const SEEN_PREFIX = 'seen:artefact:';
const ACCOUNT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CONFIRM_REF_RE = /^[a-f0-9]{32}$/;
const CONFIRM_HOLD_MS = 10 * 60e3;

const lines = (text) => String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const uniq = (arr) => [...new Set(arr)];
const iso = (ts) => (ts == null ? null : new Date(ts).toISOString());
const runsOf = (ctx) => ctx.store.collection('runs');
const artefactsOf = (ctx) => ctx.store.collection('artefacts');

function dayKey(ts) { return iso(ts).slice(0, 10); }
function monthKey(ts) { return iso(ts).slice(0, 7); }
function isoWeekKey(ts) {
  const d = new Date(ts);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Which of `artefacts` (any order) retention keeps: the newest per day for the
 * last `daily` distinct days, per ISO week for `weekly` weeks, per month for
 * `monthly` months. Returns { keep: Set<artefactId>, drop: [artefact] }.
 */
function retentionPlan(artefacts, { daily = 0, weekly = 0, monthly = 0 }) {
  const sorted = artefacts.slice().sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set();
  const seen = { day: new Set(), week: new Set(), month: new Set() };
  for (const a of sorted) {
    const keys = { day: dayKey(a.createdAt), week: isoWeekKey(a.createdAt), month: monthKey(a.createdAt) };
    const limits = { day: daily, week: weekly, month: monthly };
    for (const bucket of ['day', 'week', 'month']) {
      if (seen[bucket].has(keys[bucket])) continue;
      if (seen[bucket].size >= limits[bucket]) continue;
      seen[bucket].add(keys[bucket]);
      keep.add(a.artefactId);
    }
  }
  return { keep, drop: sorted.filter((a) => !keep.has(a.artefactId)) };
}

async function allAccounts(ctx) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const r = await ctx.api.accounts.list({ page, pageSize: 500 });
    out.push(...r.data);
    if (out.length >= r.meta.total || r.data.length === 0) break;
  }
  return out;
}

/** The accounts a run covers, per the scope settings, plus warnings for unknown names. */
async function selectAccounts(ctx, settings, override) {
  const warnings = [];
  const accounts = await allAccounts(ctx);
  const byName = new Map(accounts.map((a) => [a.username, a]));
  if (Array.isArray(override) && override.length) {
    const unknown = override.filter((u) => !byName.has(u));
    for (const u of unknown) warnings.push({ code: 'unknown_account', account: u, message: `account "${u}" does not exist` });
    return { targets: override.filter((u) => byName.has(u)).map((u) => byName.get(u)), warnings };
  }
  if (settings.scope === 'accounts') {
    const wanted = uniq(lines(settings.accounts));
    for (const u of wanted) if (!byName.has(u)) warnings.push({ code: 'unknown_account', account: u, message: `account "${u}" does not exist` });
    return { targets: wanted.filter((u) => byName.has(u)).map((u) => byName.get(u)), warnings };
  }
  if (settings.scope === 'packages') {
    const wanted = uniq(lines(settings.packages));
    const known = new Set((await ctx.api.packages.list()).map((p) => p.name));
    for (const p of wanted) if (!known.has(p)) warnings.push({ code: 'unknown_package', package: p, message: `package "${p}" does not exist` });
    return { targets: accounts.filter((a) => wanted.includes(a.package)), warnings };
  }
  return { targets: accounts, warnings };
}

/** Destination ids from the settings that exist on the host; unknown ones become warnings. */
async function selectDestinations(ctx, settings) {
  const wanted = uniq(lines(settings.destinations));
  if (!wanted.length) return { destinations: [], warnings: [] };
  const known = new Map((await ctx.api.backups.destinations.list()).map((d) => [d.id, d]));
  const warnings = wanted.filter((id) => !known.has(id)).map((id) => ({ code: 'unknown_destination', destinationId: id, message: `destination "${id}" is not configured; skipped` }));
  return { destinations: wanted.filter((id) => known.has(id)).map((id) => known.get(id)), warnings };
}

async function readLock(ctx, account) {
  const lock = await ctx.store.get(`${LOCK_PREFIX}${account}`);
  if (!lock) return null;
  return { account, ...lock, expired: lock.expiresAt <= ctx.now() };
}

// The store has no compare-and-set, so the read-then-write of a lock is made
// atomic per account with an in-process queue: every run of this plugin shares
// this module instance, which is where concurrent runs (cron plus a manual
// POST /run) would otherwise both observe "no lock". The stored lock still
// carries the TTL so an interrupted run never blocks an account forever.
const lockQueues = new Map();
function serialised(key, fn) {
  const prev = lockQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {}).then(() => { if (lockQueues.get(key) === tail) lockQueues.delete(key); });
  lockQueues.set(key, tail);
  return next;
}

function acquireLock(ctx, account, jobId, ttlMinutes) {
  return serialised(account, async () => {
    const existing = await readLock(ctx, account);
    if (existing && !existing.expired) return { ok: false, lock: existing };
    const lock = { jobId, acquiredAt: ctx.now(), expiresAt: ctx.now() + ttlMinutes * 60e3 };
    await ctx.store.set(`${LOCK_PREFIX}${account}`, lock);
    return { ok: true, lock: { account, ...lock, expired: false, takenOver: Boolean(existing) } };
  });
}

const releaseLock = (ctx, account) => ctx.store.delete(`${LOCK_PREFIX}${account}`);

async function listLocks(ctx) {
  const out = [];
  for (const key of await ctx.store.keys(LOCK_PREFIX)) {
    const lock = await readLock(ctx, key.slice(LOCK_PREFIX.length));
    if (lock) out.push({ ...lock, acquiredAt: iso(lock.acquiredAt), expiresAt: iso(lock.expiresAt) });
  }
  return out;
}

async function notify(ctx, settings, { ok, subject, body }) {
  const mode = settings.notify_on;
  if (mode === 'never') return false;
  if (ok && mode === 'failure') return false;
  if (!ok && mode === 'success') return false;
  try {
    await ctx.api.contacts.notify({ event: `${ID}.${ok ? 'run_ok' : 'run_failed'}`, severity: ok ? 'info' : 'critical', subject, body });
    return true;
  } catch (err) {
    ctx.log.warn('notification could not be delivered', { error: err.message });
    return false;
  }
}

async function trimRuns(ctx) {
  const runs = runsOf(ctx);
  const total = await runs.count({});
  if (total <= MAX_RUNS_KEPT) return;
  const oldest = await runs.find({}, { sort: { startedAt: 1 }, limit: total - MAX_RUNS_KEPT });
  for (const r of oldest) await runs.remove({ id: r.id });
}

function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  return Promise.all(workers);
}

/** Back up one account: lock → create (encrypt fallback) → verify → upload → record. */
async function backupAccount(ctx, job, settings, account, destinations, runId, warnings) {
  const result = { account: account.username, status: 'ok', artefactId: null, size: null, sha256: null, remote: [], error: null, startedAt: ctx.now(), finishedAt: null };
  const lock = await acquireLock(ctx, account.username, job.id, settings.lock_ttl_minutes);
  if (!lock.ok) {
    warnings.push({ code: 'locked', account: account.username, message: `account "${account.username}" is locked by job ${lock.lock.jobId} until ${iso(lock.lock.expiresAt)}; skipped` });
    return { ...result, status: 'skipped', finishedAt: ctx.now() };
  }
  if (lock.lock.takenOver) warnings.push({ code: 'lock_expired', account: account.username, message: `an expired lock of job ${lock.lock.jobId} was taken over` });
  try {
    let artefact;
    try {
      artefact = await ctx.api.backups.create({ account: account.username, include: settings.include, compression: 'gzip', encrypt: Boolean(settings.encrypt) });
    } catch (err) {
      if (!(settings.encrypt && err.code === 'UNSUPPORTED')) throw err;
      warnings.push({ code: 'encrypt_unsupported', account: account.username, message: `this host cannot encrypt archives (${err.message}); written unencrypted` });
      artefact = await ctx.api.backups.create({ account: account.username, include: settings.include, compression: 'gzip', encrypt: false });
    }
    await ctx.store.set(`${SEEN_PREFIX}${artefact.id}`, runId);
    result.artefactId = artefact.id;
    result.size = artefact.size;
    result.sha256 = artefact.sha256;
    if (settings.verify) {
      const v = await ctx.api.backups.verify(artefact.id);
      if (!v.ok || (artefact.sha256 && v.sha256 !== artefact.sha256)) throw Object.assign(new Error(`archive ${artefact.id} failed verification`), { code: 'VERIFY_FAILED' });
      result.verifiedAt = v.verifiedAt;
    }
    for (const dest of destinations) {
      if (job.signal.aborted) break;
      try {
        const up = await ctx.api.backups.upload({ artefactId: artefact.id, destinationId: dest.id });
        result.remote.push({ destinationId: dest.id, remotePath: up.remotePath, sha256: up.sha256, state: 'uploaded', ...(up.encrypted != null ? { encrypted: Boolean(up.encrypted) } : {}) });
      } catch (err) {
        result.remote.push({ destinationId: dest.id, state: 'failed', error: err.message });
        warnings.push({ code: 'upload_failed', account: account.username, destinationId: dest.id, message: `upload of ${artefact.id} to "${dest.id}" failed: ${err.message}` });
      }
    }
    await artefactsOf(ctx).insert({
      artefactId: artefact.id, account: account.username, runId, createdBy: 'plugin', createdAt: artefact.createdAt, path: artefact.path, size: artefact.size, sha256: artefact.sha256,
      include: artefact.include, encrypted: Boolean(artefact.encrypted), local: 'present', remote: result.remote,
    });
  } catch (err) {
    result.status = 'failed';
    result.error = { code: err.code || 'BACKUP_FAILED', message: err.message };
    ctx.log.error('account backup failed', { account: account.username, error: err.message, code: result.error.code });
  } finally {
    await releaseLock(ctx, account.username);
    result.finishedAt = ctx.now();
  }
  return result;
}

/** Apply retention to the plugin's own local archives; returns what was deleted. */
async function prune(ctx, settings, { runId = null } = {}) {
  const artefacts = artefactsOf(ctx);
  const present = await artefacts.find({ createdBy: 'plugin', local: 'present' });
  const byAccount = new Map();
  for (const a of present) { if (!byAccount.has(a.account)) byAccount.set(a.account, []); byAccount.get(a.account).push(a); }
  const deleted = [];
  const errors = [];
  for (const [account, list] of byAccount) {
    const { drop } = retentionPlan(list, { daily: settings.retention_daily, weekly: settings.retention_weekly, monthly: settings.retention_monthly });
    for (const a of drop) {
      try {
        await ctx.api.backups.delete(a.artefactId);
      } catch (err) {
        if (err.code !== 'NOT_FOUND') { errors.push({ artefactId: a.artefactId, account, error: err.message }); continue; }
      }
      const remote = (a.remote || []).filter((r) => r.state === 'uploaded').map((r) => ({ ...r, state: 'retained' }));
      await artefacts.update({ id: a.id }, { local: 'deleted', deletedAt: ctx.now(), prunedBy: runId, remote });
      await ctx.store.delete(`${SEEN_PREFIX}${a.artefactId}`);
      deleted.push({ artefactId: a.artefactId, account, createdAt: a.createdAt, remote: remote.length ? 'retained' : 'none', destinations: remote.map((r) => r.destinationId) });
    }
  }
  return { deleted, errors, accounts: byAccount.size };
}

function summarise(results) {
  return {
    accounts: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}

// Confirm tokens never reach the job queue: the host persists job params
// (jobs.params_json, visible on the Manage Plugins job list), so POST /restore
// parks the token in memory under a random reference and the job redeems the
// reference exactly once. A reference that is unknown, already redeemed, older
// than the token's own lifetime or orphaned by a panel restart fails the job
// with PERMISSION_DENIED, the same as a bad token.
const heldTokens = new Map();
function holdToken(token, now) {
  for (const [ref, held] of heldTokens) if (held.expiresAt <= now) heldTokens.delete(ref);
  const ref = crypto.randomBytes(16).toString('hex');
  heldTokens.set(ref, { token, expiresAt: now + CONFIRM_HOLD_MS });
  return ref;
}
function redeemToken(ref, now) {
  const held = typeof ref === 'string' && CONFIRM_REF_RE.test(ref) ? heldTokens.get(ref) : undefined;
  if (held) heldTokens.delete(ref);
  return held && held.expiresAt > now ? held.token : null;
}

function validateRestoreBody(body, errors) {
  const fields = [];
  if (!body || typeof body !== 'object') throw new errors.ValidationError('a JSON object is required');
  if (typeof body.artefactId !== 'string' || !ID_RE.test(body.artefactId)) fields.push({ path: 'artefactId', code: 'PATTERN', message: 'artefactId is required' });
  if (typeof body.account !== 'string' || !ACCOUNT_RE.test(body.account)) fields.push({ path: 'account', code: 'PATTERN', message: 'account must be a username' });
  if (typeof body.confirmToken !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.confirmToken)) fields.push({ path: 'confirmToken', code: 'PATTERN', message: 'confirmToken is required' });
  if (fields.length) throw new errors.ValidationError('invalid restore request', fields);
  return { artefactId: body.artefactId, account: body.account, confirmToken: body.confirmToken };
}

module.exports = {
  async activate(ctx) {
    if ((await ctx.store.get('installedAt')) === undefined) await ctx.store.set('installedAt', ctx.now());
    const settings = await ctx.settings.getAll();
    await ctx.ui.registerPage({ route: '/help', title: 'How retention works', kind: 'markdown', content: [
      '# Automated Backup: retention and remote copies', '',
      `Retention keeps, per account, the newest archive of the last **${settings.retention_daily}** days, **${settings.retention_weekly}** ISO weeks and **${settings.retention_monthly}** months and deletes every other local archive this plugin created.`, '',
      'Remote copies are governed by the destination\'s own retention: the host has no API to remove a copy from a destination, so pruned archives keep their uploads and the history records them as `remote: retained`.', '',
      'This panel only writes gzip-compressed, unencrypted archives; the **encrypt** toggle asks the host and records an `encrypt_unsupported` warning when it refuses.',
    ].join('\n') });
    ctx.log.info('activated', { version: ctx.plugin.version, scheduled: Boolean(settings.schedule), scope: settings.scope });
  },

  async deactivate(ctx) {
    ctx.log.info('deactivated');
  },

  hooks: {
    // Archives the Backup category (or another plugin) produced show up in the
    // history; the plugin's own archives are already recorded by the run.
    async onBackupCompleted(evt, ctx) {
      const { jobId, account, artefact } = evt.payload;
      if (!artefact || !artefact.id) return;
      if (await ctx.store.get(`${SEEN_PREFIX}${artefact.id}`)) return;
      if (await artefactsOf(ctx).findOne({ artefactId: artefact.id })) return;
      await artefactsOf(ctx).insert({ artefactId: artefact.id, account, runId: null, hostJobId: jobId || null, createdBy: 'host', createdAt: artefact.createdAt || evt.ts, path: artefact.path || null, size: artefact.size ?? null, sha256: artefact.sha256 || null, local: 'present', remote: [] });
      await runsOf(ctx).insert({ kind: 'host', source: evt.principal || 'host', status: 'ok', startedAt: evt.ts, finishedAt: evt.ts, account, artefactId: artefact.id, accounts: 1, ok: 1, failed: 0, skipped: 0, warnings: 0, results: [{ account, status: 'ok', artefactId: artefact.id, size: artefact.size ?? null }], hostJobId: jobId || null });
      await trimRuns(ctx);
    },
    async onBackupFailed(evt, ctx) {
      const { jobId, account, error } = evt.payload;
      await runsOf(ctx).insert({ kind: 'host', source: evt.principal || 'host', status: 'failed', startedAt: evt.ts, finishedAt: evt.ts, account, accounts: 1, ok: 0, failed: 1, skipped: 0, warnings: 0, results: [{ account, status: 'failed', error: error || null }], hostJobId: jobId || null });
      await trimRuns(ctx);
    },
    async onAccountTerminated(evt, ctx) {
      const { username } = evt.payload;
      await releaseLock(ctx, username);
      const docs = await artefactsOf(ctx).find({ account: username });
      for (const a of docs) await ctx.store.delete(`${SEEN_PREFIX}${a.artefactId}`);
      const removed = await artefactsOf(ctx).remove({ account: username });
      const runs = await runsOf(ctx).remove({ kind: { $in: ['host', 'restore'] }, account: username });
      ctx.log.info('history of a terminated account dropped', { username, artefacts: removed, runs });
    },
  },

  jobs: {
    async run(job, ctx) {
      const settings = await ctx.settings.getAll();
      const warnings = [];
      job.progress(1, 'selecting accounts');
      const sel = await selectAccounts(ctx, settings, job.params.accounts);
      const dst = await selectDestinations(ctx, settings);
      warnings.push(...sel.warnings, ...dst.warnings);
      const run = await runsOf(ctx).insert({ kind: 'run', source: job.params.source || 'manual', jobId: job.id, status: 'running', startedAt: ctx.now(), finishedAt: null, accounts: sel.targets.length, ok: 0, failed: 0, skipped: 0, warnings: warnings.length, destinations: dst.destinations.map((d) => d.id), include: settings.include, results: [], warningList: warnings, prune: null });
      const results = [];
      let done = 0;
      await runPool(sel.targets, settings.max_parallel, async (account) => {
        if (job.signal.aborted) { results.push({ account: account.username, status: 'skipped', error: { code: 'JOB_CANCELLED', message: 'run cancelled' } }); return; }
        job.log(`backing up ${account.username}`);
        results.push(await backupAccount(ctx, job, settings, account, dst.destinations, run.id, warnings));
        done++;
        job.progress(Math.min(90, Math.round((done / Math.max(1, sel.targets.length)) * 85) + 2), `${done}/${sel.targets.length} accounts`);
      });
      let pruned = null;
      if (!job.signal.aborted) {
        job.progress(92, 'applying retention');
        pruned = await prune(ctx, settings, { runId: run.id });
      }
      const counts = summarise(results);
      const status = job.signal.aborted ? 'cancelled' : counts.failed === 0 ? 'ok' : counts.ok === 0 ? 'failed' : 'partial';
      await runsOf(ctx).update({ id: run.id }, { status, finishedAt: ctx.now(), ...counts, warnings: warnings.length, results, warningList: warnings, prune: pruned && { deleted: pruned.deleted.length, errors: pruned.errors.length, retained_remote: pruned.deleted.filter((d) => d.remote === 'retained').length } });
      await trimRuns(ctx);
      const failedNames = results.filter((r) => r.status === 'failed').map((r) => `${r.account} (${r.error.message})`);
      await notify(ctx, settings, {
        ok: status === 'ok',
        subject: `Automated Backup: ${status} (${counts.ok}/${counts.accounts} accounts)`,
        body: [`Run ${run.id} started ${iso(run.startedAt)} finished ${status}.`, `${counts.ok} ok, ${counts.failed} failed, ${counts.skipped} skipped, ${warnings.length} warning(s).`, failedNames.length ? `Failed: ${failedNames.join('; ')}` : '', warnings.length ? `Warnings: ${warnings.map((w) => w.message).join('; ')}` : ''].filter(Boolean).join('\n'),
      });
      job.progress(100, status);
      return { runId: run.id, status, ...counts, warnings, pruned: pruned ? pruned.deleted.length : 0 };
    },

    async prune(job, ctx) {
      const settings = await ctx.settings.getAll();
      const run = await runsOf(ctx).insert({ kind: 'prune', source: job.params.source || 'manual', jobId: job.id, status: 'running', startedAt: ctx.now(), finishedAt: null, accounts: 0, ok: 0, failed: 0, skipped: 0, warnings: 0, results: [] });
      const r = await prune(ctx, settings, { runId: run.id });
      await runsOf(ctx).update({ id: run.id }, { status: r.errors.length ? 'partial' : 'ok', finishedAt: ctx.now(), accounts: r.accounts, ok: r.deleted.length, failed: r.errors.length, results: r.deleted, errors: r.errors });
      await trimRuns(ctx);
      return { runId: run.id, deleted: r.deleted, errors: r.errors };
    },

    async restore(job, ctx) {
      const { artefactId, account, confirmRef } = job.params;
      const settings = await ctx.settings.getAll();
      const run = await runsOf(ctx).insert({ kind: 'restore', source: job.params.source || 'manual', jobId: job.id, status: 'running', startedAt: ctx.now(), finishedAt: null, account, artefactId, accounts: 1, ok: 0, failed: 0, skipped: 0, warnings: 0, results: [] });
      try {
        const confirmToken = redeemToken(confirmRef, ctx.now());
        if (!confirmToken) throw Object.assign(new ctx.errors.PermissionError('confirm-token', 'jobs.restore', ID), { message: 'confirm token reference is unknown, already redeemed or expired; request a new token' });
        const r = await ctx.api.backups.restore({ artefactId, account, confirmToken });
        await runsOf(ctx).update({ id: run.id }, { status: 'ok', finishedAt: ctx.now(), ok: 1, results: [{ account, status: 'ok', artefactId, hostJobId: r.jobId || null }] });
        await notify(ctx, settings, { ok: true, subject: `Automated Backup: restore of ${artefactId} over ${account} started`, body: `Host job ${r.jobId || '?'} restores archive ${artefactId} over account ${account}.` });
        return { runId: run.id, hostJobId: r.jobId || null };
      } catch (err) {
        await runsOf(ctx).update({ id: run.id }, { status: 'failed', finishedAt: ctx.now(), failed: 1, results: [{ account, status: 'failed', artefactId, error: { code: err.code || 'RESTORE_FAILED', message: err.message } }] });
        await notify(ctx, settings, { ok: false, subject: `Automated Backup: restore of ${artefactId} over ${account} refused`, body: err.message });
        throw err;
      }
    },
  },

  routes(router, ctx) {
    router.get('/status', async (req, res) => {
      const settings = await ctx.settings.getAll();
      const schedules = await ctx.schedule.list();
      const [last] = await runsOf(ctx).find({ kind: 'run' }, { sort: { startedAt: -1 }, limit: 1 });
      res.json({
        scope: settings.scope, scheduled: Boolean(settings.schedule), schedule: settings.schedule || null,
        nextRunAt: schedules.length ? iso(Math.min(...schedules.map((s) => s.nextRunAt))) : null,
        lastRun: last ? { id: last.id, status: last.status, startedAt: iso(last.startedAt), finishedAt: iso(last.finishedAt), ok: last.ok, failed: last.failed, skipped: last.skipped } : null,
        locks: (await listLocks(ctx)).length, archives: await artefactsOf(ctx).count({ local: 'present' }), destinations: lines(settings.destinations),
      });
    });

    router.get('/runs', async (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_RUNS_KEPT);
      const query = {};
      if (req.query.kind) query.kind = String(req.query.kind);
      const rows = await runsOf(ctx).find(query, { sort: { startedAt: -1 }, limit });
      res.json(rows.map((r) => ({ id: r.id, kind: r.kind, source: r.source, status: r.status, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), accounts: r.accounts, ok: r.ok, failed: r.failed, skipped: r.skipped, warnings: r.warnings, destinations: r.destinations || [], results: r.results || [], warningList: r.warningList || [], prune: r.prune || null, account: r.account || null, artefactId: r.artefactId || null })));
    });

    router.get('/artefacts', async (req, res) => {
      const query = {};
      if (req.query.account) query.account = String(req.query.account);
      if (req.query.local) query.local = String(req.query.local);
      const rows = await artefactsOf(ctx).find(query, { sort: { createdAt: -1 }, limit: 500 });
      res.json(rows.map((a) => ({ ...a, createdAt: iso(a.createdAt), deletedAt: iso(a.deletedAt) })));
    });

    router.get('/locks', async (req, res) => {
      res.json(await listLocks(ctx));
    });

    router.post('/locks/:account/release', async (req, res) => {
      if (!ACCOUNT_RE.test(req.params.account)) throw new ctx.errors.ValidationError('account must be a username');
      const lock = await readLock(ctx, req.params.account);
      if (!lock) throw new ctx.errors.NotFoundError('lock', req.params.account);
      await releaseLock(ctx, req.params.account);
      ctx.log.warn('lock released by the operator', { account: req.params.account, jobId: lock.jobId, by: req.user.username });
      res.json({ released: req.params.account, jobId: lock.jobId, wasExpired: lock.expired });
    });

    router.get('/destinations', async (req, res) => {
      const selected = new Set(lines(await ctx.settings.get('destinations')));
      const list = await ctx.api.backups.destinations.list();
      res.json(list.map((d) => ({ id: d.id, name: d.name, kind: d.kind, selected: selected.has(d.id) })));
    });

    router.post('/run', async (req, res) => {
      const accounts = req.body && req.body.accounts;
      if (accounts !== undefined && (!Array.isArray(accounts) || accounts.some((a) => typeof a !== 'string' || !ACCOUNT_RE.test(a)) || accounts.length > 500)) throw new ctx.errors.ValidationError('accounts must be an array of usernames');
      const jobId = await ctx.jobs.run('run', { source: 'api', by: req.user.username, ...(accounts ? { accounts } : {}) });
      res.status(202).json({ job: { id: jobId } });
    });

    router.post('/prune', async (req, res) => {
      const jobId = await ctx.jobs.run('prune', { source: 'api', by: req.user.username });
      res.status(202).json({ job: { id: jobId } });
    });

    router.post('/restore', async (req, res) => {
      const { artefactId, account, confirmToken } = validateRestoreBody(req.body, ctx.errors);
      const confirmRef = holdToken(confirmToken, ctx.now());
      const jobId = await ctx.jobs.run('restore', { artefactId, account, confirmRef, source: 'api', by: req.user.username });
      res.status(202).json({ job: { id: jobId } });
    });
  },

  __test: { retentionPlan, isoWeekKey, dayKey, monthKey, selectAccounts, selectDestinations, lines, holdToken, redeemToken, heldTokens, LOCK_PREFIX, SEEN_PREFIX, MAX_RUNS_KEPT, CONFIRM_HOLD_MS },
};
