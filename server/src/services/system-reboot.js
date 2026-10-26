import fs from 'node:fs';
import os from 'node:os';
import { json, paginate } from '../db/index.js';
import { HttpError } from '../lib/errors.js';

export const REBOOT_MODES = ['graceful', 'forceful'];
const ACTIVE = ['queued', 'running'];
const ACTIVE_SQL = ACTIVE.map((s) => `'${s}'`).join(', ');
// `needs-restarting -r` on RHEL-family hosts loads the whole dnf stack, so the
// probe is not repeated for every 15 s pre-flight refresh.
const REBOOT_REQUIRED_TTL_MS = 5 * 60 * 1000;

// The kernel's boot id changes on every boot, so comparing it with the one
// recorded on the last request tells whether that reboot actually happened.
export function readBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
}

// When the running kernel was started, from the host's own uptime (the panel
// always runs on the host it reboots, in both monolithic and split mode).
export function currentBootTime() {
  return Date.now() - Math.floor(os.uptime()) * 1000;
}

function sqliteTime(text) {
  if (!text) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}

// One view of "did that request's reboot happen", shared by the pre-flight
// pill, the history and rebootedSinceLastRequest(): the boot id must differ
// from the one recorded with the request AND the current boot must have
// started after the request was made, or an unrelated later reboot (or a
// failed attempt) would be reported as the request completing.
export function completionOf(row, { bootId = readBootId(), bootTime = currentBootTime() } = {}) {
  if (!row) return { bootIdChanged: false, completed: false };
  const bootIdChanged = Boolean(row.boot_id && bootId && row.boot_id !== bootId);
  const requestedAt = sqliteTime(row.requested_at);
  const bootedAfterRequest = Number.isFinite(requestedAt) && bootTime >= requestedAt;
  return { bootIdChanged, completed: bootIdChanged && row.status !== 'failed' && bootedAfterRequest };
}

export function createSystemRebootService(ctx) {
  const { db, agent, capabilities, jobs, settings, logger } = ctx;
  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const stmts = {
    insert: db.prepare(`INSERT INTO reboot_requests (mode, principal, ip, reason, preflight_json, status, boot_id)
      VALUES (@mode, @principal, @ip, @reason, @preflight, 'requested', @bootId)`),
    triggered: db.prepare("UPDATE reboot_requests SET status = 'triggered', triggered_at = datetime('now') WHERE id = ?"),
    failed: db.prepare("UPDATE reboot_requests SET status = 'failed', error = ? WHERE id = ?"),
    get: db.prepare('SELECT * FROM reboot_requests WHERE id = ?'),
    last: db.prepare('SELECT * FROM reboot_requests ORDER BY id DESC LIMIT 1'),
    jobCounts: db.prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE status IN (${ACTIVE_SQL}) GROUP BY status`),
    activeJobs: db.prepare(`SELECT id, type, status, progress, message, created_at, started_at FROM jobs WHERE status IN (${ACTIVE_SQL}) ORDER BY id DESC LIMIT 20`),
  };
  let rebootRequiredCache = null;

  function shape(row, state = {}) {
    if (!row) return null;
    const { preflight_json: stored, ...rest } = row;
    return { ...rest, preflight: json.parse(stored, {}), ...completionOf(row, state) };
  }

  // Other categories' run tables are optional (their migrations may not exist on
  // a trimmed build), so each is read only when present.
  function activeRuns(table, columns) {
    if (!tableExists(table)) return { available: false, count: 0, items: [] };
    const items = db.prepare(`SELECT ${columns} FROM ${table} WHERE status IN (${ACTIVE_SQL}) ORDER BY id DESC LIMIT 20`).all();
    return { available: true, count: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status IN (${ACTIVE_SQL})`).get().n, items };
  }

  async function rebootRequired({ fresh = false } = {}) {
    if (!fresh && rebootRequiredCache && Date.now() - rebootRequiredCache.at < REBOOT_REQUIRED_TTL_MS) return rebootRequiredCache.value;
    try {
      const value = Boolean((await agent.op('pkg.reboot_required')).rebootRequired);
      rebootRequiredCache = { value, at: Date.now() };
      return value;
    } catch (err) {
      logger.debug({ err }, 'reboot-required check unavailable');
      rebootRequiredCache = null;
      return null;
    }
  }

  async function preflight({ fresh = false } = {}) {
    const snapshot = await capabilities.ensureFresh();
    let info = null;
    try { info = await agent.op('sys.info'); } catch (err) { logger.warn({ err }, 'sys.info unavailable for reboot pre-flight'); }
    const counts = Object.fromEntries(stmts.jobCounts.all().map((r) => [r.status, r.n]));
    const transfers = activeRuns('transfer_runs', 'id, kind, status, source, requested_by, created_at');
    const backups = activeRuns('backup_runs', 'id, status, created_at');
    const restores = activeRuns('backup_restores', 'id, status, created_at');
    const bootId = readBootId();
    const bootTime = currentBootTime();
    // The previous request is reported without its own stored snapshot, or
    // every stored snapshot would nest the whole chain of earlier ones.
    const { preflight: _omit, ...last } = shape(stmts.last.get(), { bootId, bootTime }) || {};
    const warnings = [];
    if (counts.running) warnings.push(`${counts.running} job(s) are running and will be interrupted`);
    if (counts.queued) warnings.push(`${counts.queued} job(s) are queued and will restart after boot`);
    if (transfers.count) warnings.push(`${transfers.count} account transfer(s) or restore(s) are in progress`);
    if (backups.count) warnings.push(`${backups.count} backup run(s) are in progress`);
    if (restores.count) warnings.push(`${restores.count} backup restore(s) are in progress`);
    return {
      hostname: settings.get('basic.hostname') || info?.hostname || null,
      uptimeSeconds: info?.uptimeSeconds ?? null,
      loadAverage: info?.loadAverage ?? null,
      bootId,
      bootedAt: new Date(bootTime).toISOString(),
      capability: { systemd: Boolean(snapshot.capabilities.systemd?.installed), systemctl: Boolean(snapshot.binaries.systemctl) },
      rebootRequired: await rebootRequired({ fresh }),
      rebootRequiredCheckedAt: rebootRequiredCache ? new Date(rebootRequiredCache.at).toISOString() : null,
      jobs: { running: counts.running || 0, queued: counts.queued || 0, workerActive: jobs.runningCount(), items: stmts.activeJobs.all() },
      transfers, backups, restores,
      warnings,
      activeWork: warnings.length > 0,
      lastRequest: last.id ? last : null,
    };
  }

  async function reboot(mode, { reason = null, ignoreActiveWork = false } = {}, req) {
    if (!REBOOT_MODES.includes(mode)) throw new HttpError(422, 'validation_failed', `Unknown reboot mode "${mode}"`, { mode: ['Must be graceful or forceful'] });
    capabilities.require('systemd', 'systemd (systemctl) is required to reboot the server from the panel');
    const check = await preflight({ fresh: true });
    if (check.activeWork && !ignoreActiveWork) {
      throw new HttpError(409, 'active_work', `Reboot not started: ${check.warnings.join('; ')}. Confirm again to reboot anyway.`);
    }
    // Record first: the reboot command kills this process (immediately when
    // forceful), so a row or audit entry written after it would be lost. The
    // row starts as 'requested' and is flipped to 'triggered' or 'failed' only
    // when the panel is still alive to see the outcome; the audit entry written
    // here says 'requested' for the same reason, never 'ok'.
    const principal = req?.user?.username ?? null;
    const { lastInsertRowid: id } = stmts.insert.run({ mode, principal, ip: req?.ip ?? null, reason, preflight: JSON.stringify(check), bootId: check.bootId });
    const auditArgs = { mode, reason, ignoreActiveWork, requestId: id, warnings: check.warnings, hostname: check.hostname };
    req?.audit?.({ action: 'system.reboot', target: mode, args: auditArgs, result: 'requested' });
    logger.warn({ mode, principal, reason, requestId: id }, 'server reboot requested from the panel');
    let result;
    try {
      result = await agent.op('sys.reboot', { mode }, { req });
    } catch (err) {
      stmts.failed.run(err.message, id);
      req?.audit?.({ action: 'system.reboot', target: mode, args: auditArgs, result: `error:${err.code || 'failed'}` });
      throw err;
    }
    stmts.triggered.run(id);
    req?.audit?.({ action: 'system.reboot', target: mode, args: auditArgs, result: 'ok' });
    return { ...shape(stmts.get.get(id)), scheduled: Boolean(result?.scheduled ?? true), preflight: check };
  }

  return {
    preflight,
    reboot,
    graceful: (opts, req) => reboot('graceful', opts, req),
    forceful: (opts, req) => reboot('forceful', opts, req),
    history(query = {}) {
      const state = { bootId: readBootId(), bootTime: currentBootTime() };
      const page = paginate(db, { select: '*', from: 'reboot_requests', sortable: { id: 'id' }, defaultSort: 'id', query: { ...query, dir: 'desc' } });
      return { ...page, data: page.data.map((row) => shape(row, state)) };
    },
    // Whether this host booted since (and because of) the last reboot request
    // the panel made; the same rule as the pre-flight's lastRequest.completed.
    rebootedSinceLastRequest() {
      return completionOf(stmts.last.get()).completed;
    },
  };
}
