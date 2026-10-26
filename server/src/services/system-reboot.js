import fs from 'node:fs';
import { json } from '../db/index.js';
import { HttpError } from '../lib/errors.js';

export const REBOOT_MODES = ['graceful', 'forceful'];
const ACTIVE = ['queued', 'running'];

// The kernel's boot id changes on every boot, so comparing it with the one
// recorded on the last request tells whether that reboot actually happened.
export function readBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
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
    history: db.prepare('SELECT * FROM reboot_requests ORDER BY id DESC LIMIT ?'),
    jobCounts: db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY status"),
    activeJobs: db.prepare("SELECT id, type, status, progress, message, created_at, started_at FROM jobs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 20"),
  };

  function shape(row) {
    if (!row) return null;
    return { ...row, preflight: json.parse(row.preflight_json, {}), preflight_json: undefined };
  }

  // Other categories' run tables are optional (their migrations may not exist on
  // a trimmed build), so each is read only when present.
  function activeRuns(table, columns) {
    if (!tableExists(table)) return { available: false, count: 0, items: [] };
    const items = db.prepare(`SELECT ${columns} FROM ${table} WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 20`).all();
    return { available: true, count: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status IN ('queued', 'running')`).get().n, items };
  }

  async function rebootRequired() {
    try { return Boolean((await agent.op('pkg.reboot_required')).rebootRequired); } catch (err) {
      logger.debug({ err }, 'reboot-required check unavailable');
      return null;
    }
  }

  async function preflight() {
    const snapshot = await capabilities.ensureFresh();
    let info = null;
    try { info = await agent.op('sys.info'); } catch (err) { logger.warn({ err }, 'sys.info unavailable for reboot pre-flight'); }
    const counts = Object.fromEntries(stmts.jobCounts.all().map((r) => [r.status, r.n]));
    const transfers = activeRuns('transfer_runs', 'id, kind, status, source, requested_by, created_at');
    const backups = activeRuns('backup_runs', 'id, status, created_at');
    const restores = activeRuns('backup_restores', 'id, status, created_at');
    const bootId = readBootId();
    // The previous request is reported without its own stored snapshot, or
    // every stored snapshot would nest the whole chain of earlier ones.
    const { preflight: _omit, ...last } = shape(stmts.last.get()) || {};
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
      capability: { systemd: Boolean(snapshot.capabilities.systemd?.installed), systemctl: Boolean(snapshot.binaries.systemctl) },
      rebootRequired: await rebootRequired(),
      jobs: { running: counts.running || 0, queued: counts.queued || 0, workerActive: jobs.runningCount(), items: stmts.activeJobs.all().map((j) => ({ ...j, params: undefined })) },
      transfers, backups, restores,
      warnings,
      activeWork: warnings.length > 0,
      lastRequest: last.id ? { ...last, completed: Boolean(last.boot_id && bootId && last.boot_id !== bootId && last.status !== 'failed') } : null,
    };
  }

  async function reboot(mode, { reason = null, ignoreActiveWork = false } = {}, req) {
    if (!REBOOT_MODES.includes(mode)) throw new HttpError(422, 'validation_failed', `Unknown reboot mode "${mode}"`, { mode: ['Must be graceful or forceful'] });
    capabilities.require('systemd', 'systemd (systemctl) is required to reboot the server from the panel');
    const check = await preflight();
    if (check.activeWork && !ignoreActiveWork) {
      throw new HttpError(409, 'active_work', `Reboot not started: ${check.warnings.join('; ')}. Confirm again to reboot anyway.`);
    }
    // Record first: the reboot command kills this process (immediately when
    // forceful), so a row or audit entry written after it would be lost. The
    // row starts as 'requested' and is flipped to 'triggered' or 'failed' only
    // when the panel is still alive to see the outcome.
    const principal = req?.user?.username ?? null;
    const { lastInsertRowid: id } = stmts.insert.run({ mode, principal, ip: req?.ip ?? null, reason, preflight: JSON.stringify(check), bootId: check.bootId });
    req?.audit?.({ action: 'system.reboot', target: mode, args: { mode, reason, ignoreActiveWork, requestId: id, warnings: check.warnings, hostname: check.hostname } });
    logger.warn({ mode, principal, reason, requestId: id }, 'server reboot requested from the panel');
    let result;
    try {
      result = await agent.op('sys.reboot', { mode }, { req });
    } catch (err) {
      stmts.failed.run(err.message, id);
      req?.audit?.({ action: 'system.reboot', target: mode, args: { mode, reason, ignoreActiveWork, requestId: id }, result: `error:${err.code || 'failed'}` });
      throw err;
    }
    stmts.triggered.run(id);
    return { ...shape(stmts.get.get(id)), scheduled: Boolean(result?.scheduled ?? true), preflight: check };
  }

  return {
    preflight,
    reboot,
    graceful: (opts, req) => reboot('graceful', opts, req),
    forceful: (opts, req) => reboot('forceful', opts, req),
    history: (limit = 20) => stmts.history.all(limit).map(shape),
    // Whether this host booted since the last reboot request the panel made.
    rebootedSinceLastRequest() {
      const last = stmts.last.get();
      const bootId = readBootId();
      return Boolean(last?.boot_id && bootId && last.boot_id !== bootId);
    },
  };
}
