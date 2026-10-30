import { Router } from 'express';
import { validate, z, fields } from '../lib/validate.js';
import { requireRoot, requireReseller, isRoot } from '../middleware/rbac.js';
import { notFound } from '../lib/errors.js';
import { createSystemStackService, STACK_INSTALL_JOB } from '../services/system-stack.js';
import { STACK_PROFILE_KEYS, STACK_COMPONENT_KEYS } from '../lib/stack-catalog.js';
import { CONFIG_KEYS } from '../services/clusters-config.js';
import { PS_USER_RE } from '../services/system-health.js';

const serviceName = z.string().regex(/^[a-z0-9-]{1,40}$/);
const capabilityName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
// Process owners as ps prints them: system accounts such as "_apt" or
// "Debian-exim" are not panel usernames.
const processUser = z.string().regex(PS_USER_RE, 'Not a valid process owner name');
// A setting the configuration cluster knows has the value shape its consumer
// expects (clusters-config.js); it is refused here rather than stored for the
// consumer to trip over at runtime (a null cPHulk threshold blocks an address
// after a single failed login). Keys outside that registry are stored as sent.
const settingsBody = z.record(z.string().regex(/^[a-z0-9_.]{1,60}$/), z.any()).superRefine((values, rctx) => {
  for (const [key, value] of Object.entries(values)) {
    const def = CONFIG_KEYS[key];
    if (!def) continue;
    const r = def.schema.safeParse(value);
    if (r.success) continue;
    for (const issue of r.error.issues) rctx.addIssue({ code: 'custom', path: [key, ...issue.path], message: issue.message });
  }
});

export function systemRoutes(ctx) {
  const { system, serviceManager, jobs, scheduler, settings, audit } = ctx;
  // The stack installer is core (it has no category module to register it in),
  // so it is created where the core routes are mounted, once per app.
  if (!ctx.stack) {
    ctx.stack = createSystemStackService(ctx);
    jobs.register(STACK_INSTALL_JOB, (job) => ctx.stack.installJob(job));
  }
  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => data !== undefined && res.json(data?.meta ? data : { data })).catch(next);
  const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => res.status(202).json({ data })).catch(next);
  // A reseller follows the jobs it started and nothing else: another
  // principal's job (its params, result and log lines) is reported as absent.
  const ownJob = (req, id) => {
    const job = jobs.get(id);
    if (!isRoot(req.user) && job.created_by !== req.user.id) throw notFound('Job');
    return job;
  };

  // Dashboard + Server Status + System Health -----------------------------------
  r.get('/status', requireReseller, wrap(() => system.status()));
  r.get('/info', requireRoot, wrap(() => system.info()));
  r.get('/disk', requireRoot, wrap(() => system.diskUsage()));
  r.get('/processes', requireRoot, validate({ query: z.object({ sort: z.enum(['cpu', 'mem', 'pid', 'time']).default('cpu'), limit: z.coerce.number().int().min(1).max(5000).default(500), user: processUser.optional() }) }),
    wrap((req) => system.processes(req.query)));
  r.post('/processes/:pid/signal', requireRoot, validate({ params: z.object({ pid: fields.id }), body: z.object({ signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGSTOP', 'SIGCONT']).default('SIGTERM') }).strict() }),
    wrap((req) => system.signal(req.params.pid, req.body.signal, req)));
  r.post('/processes/:pid/renice', requireRoot, validate({ params: z.object({ pid: fields.id }), body: z.object({ niceness: z.number().int().min(-20).max(19) }).strict() }),
    wrap((req) => system.renice(req.params.pid, req.body.niceness, req)));
  r.post('/root-password', requireRoot, validate({ body: z.object({ password: fields.password }).strict() }), wrap((req) => system.setRootPassword(req.body.password, req)));
  r.get('/capabilities', requireRoot, wrap(() => system.capabilities()));
  r.post('/capabilities/refresh', requireRoot, wrap(() => system.refreshCapabilities()));
  r.post('/capabilities/:cap/install', requireRoot, validate({ params: z.object({ cap: capabilityName }) }), accepted((req) => ctx.stack.capabilityInstall(req.params.cap, req.user, req)));

  // Server stack (install software from the panel) + first-run setup -------------
  r.get('/stack', requireRoot, wrap(() => ctx.stack.status()));
  r.post('/stack/install', requireRoot, validate({ body: z.object({ profile: z.enum(STACK_PROFILE_KEYS).optional(), components: z.array(z.enum(STACK_COMPONENT_KEYS)).max(STACK_COMPONENT_KEYS.length).optional() }).strict() }),
    accepted((req) => ctx.stack.install(req.body, req.user, req)));
  r.post('/setup/complete', requireRoot, validate({ body: z.object({ skipped: z.boolean().default(false) }).strict() }), wrap((req) => ctx.stack.setup.complete(req.body, req)));

  // Service Manager + Restart Services -------------------------------------------
  r.get('/services', requireReseller, wrap(() => serviceManager.list()));
  r.get('/services/:name', requireReseller, validate({ params: z.object({ name: serviceName }) }), wrap((req) => serviceManager.status(req.params.name)));
  r.get('/services/:name/journal', requireRoot, validate({ params: z.object({ name: serviceName }), query: z.object({ lines: z.coerce.number().int().min(1).max(5000).default(200) }) }),
    wrap((req) => serviceManager.journal(req.params.name, req.query.lines)));
  // Install and repair sit before the verb route so its enum does not reject them.
  r.post('/services/:name/install', requireRoot, validate({ params: z.object({ name: serviceName }) }), accepted((req) => ctx.stack.serviceInstall(req.params.name, req.user, req)));
  r.post('/services/:name/repair', requireRoot, validate({ params: z.object({ name: serviceName }) }), wrap((req) => serviceManager.repair(req.params.name, req)));
  r.post('/services/:name/:verb', requireRoot, validate({ params: z.object({ name: serviceName, verb: z.enum(['start', 'stop', 'restart', 'reload', 'enable', 'disable']) }) }),
    wrap((req) => serviceManager.action(req.params.name, req.params.verb, req)));
  r.patch('/services/:name', requireRoot, validate({ params: z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/) }), body: z.object({ monitored: z.boolean().optional(), enabled: z.boolean().optional(), restartOnFailure: z.boolean().optional() }).strict() }),
    wrap((req) => serviceManager.configure(req.params.name, req.body)));

  // Jobs (Task Queue Monitor) ----------------------------------------------------
  r.get('/jobs', requireReseller, validate({ query: z.object({ status: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']).optional(), type: z.string().regex(/^[a-z0-9._-]{1,60}$/).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }),
    wrap((req) => jobs.list(isRoot(req.user) ? req.query : { ...req.query, createdBy: req.user.id })));
  r.get('/jobs/:id', requireReseller, validate({ params: z.object({ id: fields.id }) }), wrap((req) => ownJob(req, req.params.id)));
  r.post('/jobs/:id/cancel', requireRoot, validate({ params: z.object({ id: fields.id }) }), wrap((req) => { jobs.cancel(req.params.id); return { cancelled: true }; }));
  r.get('/jobs/:id/stream', requireReseller, validate({ params: z.object({ id: fields.id }) }), (req, res, next) => {
    let job;
    try { job = ownJob(req, req.params.id); } catch (err) { return next(err); }
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
  r.put('/settings', requireRoot, validate({ body: settingsBody }), wrap((req) => { settings.setMany(req.body); req.audit({ action: 'settings.update', args: req.body }); return settings.getPrefix(''); }));

  // Audit log --------------------------------------------------------------------
  r.get('/audit', requireRoot, validate({ query: z.object({ page: fields.page, pageSize: fields.pageSize, q: z.string().max(200).optional(), principal: z.string().max(64).optional(), action: z.string().max(80).optional(), result: z.string().max(20).optional(), sort: z.string().optional(), dir: fields.sortDir.optional() }) }),
    wrap((req) => audit.list(req.query)));
  r.get('/audit/logins', requireRoot, validate({ query: z.object({ page: fields.page, pageSize: fields.pageSize, sort: z.string().optional(), dir: fields.sortDir.optional() }) }), wrap((req) => audit.loginAttempts(req.query)));

  return r;
}
