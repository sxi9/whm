import { EventEmitter } from 'node:events';
import { json } from '../db/index.js';
import { notFound, badRequest } from './errors.js';

// Long-running work (backups, transfers, bulk account changes, builds) runs as a
// job: persisted in SQLite, executed by an in-process worker, streamed to the UI
// over SSE via subscribe(). Handlers are registered by the module that owns them.
export function createJobs({ db, logger, agent, concurrency = 2 }) {
  const handlers = new Map();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const running = new Map();
  let timer = null;

  const stmts = {
    insert: db.prepare(`INSERT INTO jobs (type, params_json, created_by) VALUES (?, ?, ?)`),
    get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    claim: db.prepare(`UPDATE jobs SET status = 'running', started_at = datetime('now') WHERE id = ? AND status = 'queued'`),
    nextQueued: db.prepare(`SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT ?`),
    progress: db.prepare('UPDATE jobs SET progress = ?, message = ? WHERE id = ?'),
    finish: db.prepare(`UPDATE jobs SET status = ?, progress = ?, result_json = ?, error = ?, finished_at = datetime('now') WHERE id = ?`),
    cancel: db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'queued'`),
    log: db.prepare('INSERT INTO job_logs (job_id, level, line) VALUES (?, ?, ?)'),
    logs: db.prepare('SELECT ts, level, line FROM job_logs WHERE job_id = ? ORDER BY id'),
    recoverStale: db.prepare(`UPDATE jobs SET status = 'failed', error = 'panel restarted while job was running', finished_at = datetime('now') WHERE status = 'running'`),
  };

  function shape(row) {
    if (!row) return null;
    return { ...row, params: json.parse(row.params_json, {}), result: json.parse(row.result_json, null), params_json: undefined, result_json: undefined };
  }

  function emit(jobId, event) {
    events.emit(`job:${jobId}`, event);
    events.emit('job', { jobId, ...event });
  }

  async function run(jobId) {
    const row = stmts.get.get(jobId);
    if (!row) return;
    const handler = handlers.get(row.type);
    const job = shape(row);
    const ctx = {
      job,
      params: job.params,
      agent,
      log(line, level = 'info') {
        stmts.log.run(jobId, level, String(line));
        emit(jobId, { type: 'log', level, line: String(line) });
      },
      progress(pct, message) {
        const p = Math.max(0, Math.min(100, Math.round(pct)));
        stmts.progress.run(p, message ?? null, jobId);
        emit(jobId, { type: 'progress', progress: p, message: message ?? null });
      },
    };
    try {
      if (!handler) throw new Error(`no handler registered for job type "${row.type}"`);
      const result = await handler(ctx);
      stmts.finish.run('done', 100, JSON.stringify(result ?? null), null, jobId);
      emit(jobId, { type: 'done', result: result ?? null });
    } catch (err) {
      logger.error({ err, jobId, type: row.type }, 'job failed');
      stmts.finish.run('failed', job.progress, null, err.message, jobId);
      ctx.log(err.message, 'error');
      emit(jobId, { type: 'failed', error: err.message });
    } finally {
      running.delete(jobId);
    }
  }

  function tick() {
    const free = concurrency - running.size;
    if (free <= 0) return;
    for (const { id } of stmts.nextQueued.all(free)) {
      if (stmts.claim.run(id).changes === 1) {
        running.set(id, run(id));
        emit(id, { type: 'started' });
      }
    }
  }

  return {
    register(type, handler) { handlers.set(type, handler); },
    types: () => [...handlers.keys()],
    enqueue(type, params = {}, { userId = null } = {}) {
      if (!handlers.has(type)) throw badRequest(`Unknown job type "${type}"`);
      const { lastInsertRowid } = stmts.insert.run(type, JSON.stringify(params), userId);
      const job = shape(stmts.get.get(lastInsertRowid));
      setImmediate(tick);
      return job;
    },
    get(id) {
      const job = shape(stmts.get.get(id));
      if (!job) throw notFound('Job');
      return { ...job, logs: stmts.logs.all(id) };
    },
    list({ status, type, limit = 100 } = {}) {
      const where = [];
      const params = { limit };
      if (status) { where.push('status = @status'); params.status = status; }
      if (type) { where.push('type = @type'); params.type = type; }
      const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT @limit`;
      return db.prepare(sql).all(params).map(shape);
    },
    cancel(id) {
      if (stmts.cancel.run(id).changes === 0) throw badRequest('Only queued jobs can be cancelled');
      emit(id, { type: 'cancelled' });
    },
    subscribe(id, fn) {
      events.on(`job:${id}`, fn);
      return () => events.off(`job:${id}`, fn);
    },
    onAny(fn) { events.on('job', fn); return () => events.off('job', fn); },
    start() {
      const recovered = stmts.recoverStale.run().changes;
      if (recovered) logger.warn({ recovered }, 'marked jobs interrupted by a restart as failed');
      timer = setInterval(tick, 1000);
      timer.unref();
      tick();
    },
    stop() { clearInterval(timer); },
    runningCount: () => running.size,
  };
}
