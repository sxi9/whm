import { cronMatches, nextCronRun, isValidCron } from './cron.js';
import { json } from '../db/index.js';
import { notFound, unprocessable } from './errors.js';

// Minute-resolution scheduler over the `schedules` table. Each row names a job
// type; when its cron matches the current minute the job is enqueued. Rows are
// declared by the modules that own them via ensure(); operators tune them in
// "Configure cPanel Cron Jobs".
export function createScheduler({ db, jobs, logger }) {
  let timer = null;
  const stmts = {
    due: db.prepare('SELECT * FROM schedules WHERE enabled = 1'),
    mark: db.prepare("UPDATE schedules SET last_run_at = datetime('now'), next_run_at = ? WHERE id = ?"),
    ensure: db.prepare(`INSERT INTO schedules (name, cron, job_type, params_json, next_run_at) VALUES (@name, @cron, @job_type, @params, @next)
      ON CONFLICT (name) DO UPDATE SET job_type = excluded.job_type`),
    all: db.prepare('SELECT * FROM schedules ORDER BY name'),
    byPrefix: db.prepare('SELECT * FROM schedules WHERE name LIKE ? ESCAPE \'\\\' ORDER BY name'),
    remove: db.prepare('DELETE FROM schedules WHERE name = ?'),
    update: db.prepare('UPDATE schedules SET cron = @cron, enabled = @enabled, params_json = @params, next_run_at = @next WHERE name = @name'),
  };

  // A schedule's previous run that is still queued or running (the worker's
  // slots are taken by long jobs) must not be joined by a duplicate every
  // minute its cron matches. The match is on type AND params so an operator's
  // job of the same type (a one-account backup) never cancels the scheduled
  // one (the nightly full backup).
  function stillPending(jobType, params) {
    const want = JSON.stringify(params);
    return ['queued', 'running'].some((status) => jobs.list({ type: jobType, status }).some((j) => JSON.stringify(j.params) === want));
  }

  function tick() {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    for (const row of stmts.due.all()) {
      try {
        if (row.last_run_at && new Date(row.last_run_at.replace(' ', 'T') + 'Z').toISOString().slice(0, 16) === minuteKey) continue;
        if (!cronMatches(row.cron, now)) continue;
        if (!jobs.types().includes(row.job_type)) continue;
        const params = json.parse(row.params_json, {});
        if (stillPending(row.job_type, params)) {
          stmts.mark.run(nextCronRun(row.cron, now)?.toISOString() ?? null, row.id);
          logger.debug({ schedule: row.name, job: row.job_type }, 'scheduled job skipped: previous run still pending');
          continue;
        }
        jobs.enqueue(row.job_type, params);
        stmts.mark.run(nextCronRun(row.cron, now)?.toISOString() ?? null, row.id);
        logger.info({ schedule: row.name, job: row.job_type }, 'scheduled job enqueued');
      } catch (err) {
        logger.error({ err, schedule: row.name }, 'scheduler error');
      }
    }
  }

  return {
    ensure(name, cron, jobType, params = {}) {
      if (!isValidCron(cron)) throw new Error(`invalid cron for schedule ${name}: ${cron}`);
      stmts.ensure.run({ name, cron, job_type: jobType, params: JSON.stringify(params), next: nextCronRun(cron)?.toISOString() ?? null });
    },
    list: () => stmts.all.all().map((r) => ({ ...r, params: json.parse(r.params_json, {}), params_json: undefined })),
    listPrefix: (prefix) => stmts.byPrefix.all(`${String(prefix).replace(/[\\%_]/g, '\\$&')}%`).map((r) => ({ ...r, params: json.parse(r.params_json, {}), params_json: undefined })),
    remove: (name) => stmts.remove.run(name).changes > 0,
    update(name, { cron, enabled, params }) {
      const current = stmts.all.all().find((r) => r.name === name);
      if (!current) throw notFound('Schedule');
      const nextCron = cron ?? current.cron;
      if (!isValidCron(nextCron)) throw unprocessable('Invalid cron expression', { cron: ['Not a valid 5-field cron expression'] });
      stmts.update.run({ name, cron: nextCron, enabled: enabled == null ? current.enabled : enabled ? 1 : 0, params: JSON.stringify(params ?? json.parse(current.params_json, {})), next: nextCronRun(nextCron)?.toISOString() ?? null });
      return stmts.all.all().find((r) => r.name === name);
    },
    start() {
      // Every tick arms the next one for the coming minute boundary, so a late
      // tick (busy event loop) never carries its lateness forward into a
      // skipped minute the way a fixed setInterval would.
      const arm = () => {
        timer = setTimeout(() => {
          try { tick(); } finally { if (timer) arm(); }
        }, 60_000 - (Date.now() % 60_000));
        timer.unref();
      };
      arm();
    },
    stop() { clearTimeout(timer); timer = null; },
    tick,
  };
}
