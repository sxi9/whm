import { Router } from 'express';
import { validate, z, fields } from '../lib/validate.js';
import { requireRoot, requireReseller } from '../middleware/rbac.js';

export function systemRoutes({ system, serviceManager, jobs, scheduler, settings, audit }) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => data !== undefined && res.json(data?.meta ? data : { data })).catch(next);

  // Dashboard + Server Status + System Health -----------------------------------
  r.get('/status', requireReseller, wrap(() => system.status()));
  r.get('/info', requireRoot, wrap(() => system.info()));
  r.get('/disk', requireRoot, wrap(() => system.diskUsage()));
  r.get('/processes', requireRoot, validate({ query: z.object({ sort: z.enum(['cpu', 'mem', 'pid', 'time']).default('cpu'), limit: z.coerce.number().int().min(1).max(5000).default(500), user: fields.username.optional() }) }),
    wrap((req) => system.processes(req.query)));
  r.post('/processes/:pid/signal', requireRoot, validate({ params: z.object({ pid: fields.id }), body: z.object({ signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGSTOP', 'SIGCONT']).default('SIGTERM') }).strict() }),
    wrap((req) => system.signal(req.params.pid, req.body.signal, req)));
  r.post('/processes/:pid/renice', requireRoot, validate({ params: z.object({ pid: fields.id }), body: z.object({ niceness: z.number().int().min(-20).max(19) }).strict() }),
    wrap((req) => system.renice(req.params.pid, req.body.niceness, req)));
  r.post('/root-password', requireRoot, validate({ body: z.object({ password: fields.password }).strict() }), wrap((req) => system.setRootPassword(req.body.password, req)));
  r.get('/capabilities', requireRoot, wrap(() => system.capabilities()));
  r.post('/capabilities/refresh', requireRoot, wrap(() => system.refreshCapabilities()));

  // Service Manager + Restart Services -------------------------------------------
  r.get('/services', requireReseller, wrap(() => serviceManager.list()));
  r.get('/services/:name', requireReseller, validate({ params: z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/) }) }), wrap((req) => serviceManager.status(req.params.name)));
  r.get('/services/:name/journal', requireRoot, validate({ params: z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/) }), query: z.object({ lines: z.coerce.number().int().min(1).max(5000).default(200) }) }),
    wrap((req) => serviceManager.journal(req.params.name, req.query.lines)));
  r.post('/services/:name/:verb', requireRoot, validate({ params: z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/), verb: z.enum(['start', 'stop', 'restart', 'reload', 'enable', 'disable']) }) }),
    wrap((req) => serviceManager.action(req.params.name, req.params.verb, req)));
  r.patch('/services/:name', requireRoot, validate({ params: z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/) }), body: z.object({ monitored: z.boolean().optional(), enabled: z.boolean().optional(), restartOnFailure: z.boolean().optional() }).strict() }),
    wrap((req) => serviceManager.configure(req.params.name, req.body)));

  // Jobs (Task Queue Monitor) ----------------------------------------------------
  r.get('/jobs', requireReseller, validate({ query: z.object({ status: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']).optional(), type: z.string().regex(/^[a-z0-9._-]{1,60}$/).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }),
    wrap((req) => jobs.list(req.query)));
  r.get('/jobs/:id', requireReseller, validate({ params: z.object({ id: fields.id }) }), wrap((req) => jobs.get(req.params.id)));
  r.post('/jobs/:id/cancel', requireRoot, validate({ params: z.object({ id: fields.id }) }), wrap((req) => { jobs.cancel(req.params.id); return { cancelled: true }; }));
  r.get('/jobs/:id/stream', requireReseller, validate({ params: z.object({ id: fields.id }) }), (req, res) => {
    const job = jobs.get(req.params.id);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'snapshot', job });
    if (['done', 'failed', 'cancelled'].includes(job.status)) return res.end();
    const unsubscribe = jobs.subscribe(req.params.id, (event) => { send(event); if (['done', 'failed', 'cancelled'].includes(event.type)) { unsubscribe(); res.end(); } });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // Configure cPanel Cron Jobs ----------------------------------------------------
  r.get('/schedules', requireRoot, wrap(() => scheduler.list()));
  r.patch('/schedules/:name', requireRoot, validate({ params: z.object({ name: z.string().regex(/^[a-z0-9._-]{1,60}$/) }), body: z.object({ cron: fields.cron.optional(), enabled: z.boolean().optional(), params: z.record(z.any()).optional() }).strict() }),
    wrap((req) => scheduler.update(req.params.name, req.body)));

  // Settings (Basic Setup, Tweak Settings, ...) -----------------------------------
  r.get('/settings', requireRoot, validate({ query: z.object({ prefix: z.string().regex(/^[a-z0-9_.]{0,40}$/).default('') }) }), wrap((req) => settings.getPrefix(req.query.prefix)));
  r.put('/settings', requireRoot, validate({ body: z.record(z.string().regex(/^[a-z0-9_.]{1,60}$/), z.any()) }), wrap((req) => { settings.setMany(req.body); req.audit({ action: 'settings.update', args: req.body }); return settings.getPrefix(''); }));

  // Audit log --------------------------------------------------------------------
  r.get('/audit', requireRoot, validate({ query: z.object({ page: fields.page, pageSize: fields.pageSize, q: z.string().max(200).optional(), principal: z.string().max(64).optional(), action: z.string().max(80).optional(), result: z.string().max(20).optional(), sort: z.string().optional(), dir: fields.sortDir.optional() }) }),
    wrap((req) => audit.list(req.query)));
  r.get('/audit/logins', requireRoot, validate({ query: z.object({ page: fields.page, pageSize: fields.pageSize, sort: z.string().optional(), dir: fields.sortDir.optional() }) }), wrap((req) => audit.loginAttempts(req.query)));

  return r;
}
