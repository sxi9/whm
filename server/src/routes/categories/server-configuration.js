import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { unprocessable } from '../../lib/errors.js';
import { isValidCron } from '../../lib/cron.js';
import { createServerConfigService, PROFILE_NAMES, GENERATORS, UPDATE_TIERS, NODE_ROLES } from '../../services/server-configuration.js';

// Basic Setup, Tweak Settings, Cron Jobs and Change Root Password are served by
// the core /system router; this module adds the rest of Server Configuration.
const id = z.object({ id: fields.id });
const nonEmpty = (schema) => schema.refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const timezone = z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/, 'IANA timezone such as Europe/London');
const nodeName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, 'Letters, digits, spaces, ".", "_" or "-"');
const nodeHost = z.union([fields.hostname, fields.ip]);
const nodeToken = z.string().min(16).max(512).regex(/^[A-Za-z0-9._~+/=-]+$/, 'API token');
const nodeBase = { name: nodeName, hostname: nodeHost, port: z.number().int().min(1).max(65535), scheme: z.enum(['https', 'http']), username: fields.username.or(z.literal('root')), verifyTls: z.boolean(), roles: z.array(z.enum(NODE_ROLES)).max(NODE_ROLES.length), enabled: z.boolean() };
const nodeCreate = z.object({ ...nodeBase, token: nodeToken, port: nodeBase.port.default(2087), scheme: nodeBase.scheme.default('https'), username: nodeBase.username.default('root'), verifyTls: nodeBase.verifyTls.default(true), roles: nodeBase.roles.default([]), enabled: nodeBase.enabled.default(true) }).strict();
const nodeUpdate = nonEmpty(z.object({ ...Object.fromEntries(Object.entries(nodeBase).map(([k, v]) => [k, v.optional()])), token: nodeToken.optional() }).strict());
const terminalId = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) });
const cron = fields.cron.refine(isValidCron, 'Must be a valid 5-field cron expression');
const terminalInput = z.object({ data: z.string().min(1).max(64 * 1024).regex(/^[^\0]*$/s) }).strict();

// Keystrokes may contain passwords typed at shell prompts. The audit middleware
// serialises req.body when the request finishes, whatever its outcome, so the
// raw body is moved aside before any other handler runs and only its size stays.
function stashTerminalInput(req, _res, next) {
  const raw = req.body;
  req.terminalInput = raw;
  req.body = { bytes: typeof raw?.data === 'string' ? Buffer.byteLength(raw.data) : 0 };
  next();
}
function parseTerminalInput(req) {
  const result = terminalInput.safeParse(req.terminalInput ?? {});
  if (!result.success) {
    const fieldErrors = {};
    for (const issue of result.error.issues) (fieldErrors[issue.path.join('.') || '_'] ||= []).push(issue.message);
    throw unprocessable('Request validation failed', fieldErrors);
  }
  return result.data.data;
}

export async function register(ctx) {
  ctx.serverConfig = createServerConfigService(ctx);
  const s = ctx.serverConfig;
  for (const [type, handler] of Object.entries(s.jobs)) ctx.jobs.register(type, handler);
  for (const sch of s.schedules) ctx.scheduler.ensure(sch.name, sch.cron, sch.jobType);
  await s.stats.alignSchedule().catch((err) => ctx.logger.warn({ err }, 'stats schedule alignment failed'));
  // Update checks are Software's job; the contact notification for security
  // updates is the only part owned here, so it follows every run of that job.
  ctx.jobs.onAny((event) => {
    if (event.type !== 'done') return;
    let job = null;
    try { job = ctx.jobs.get(event.jobId); } catch { return; }
    if (job?.type === s.softwareCheckJob) ctx.serverConfig.updates.afterCheck(event.jobId, event.result).catch((err) => ctx.logger.warn({ err }, 'update notification failed'));
  });
  ctx.capabilities.register('terminal', { binaries: ['script', 'bash'], required: ['script'] });
  ctx.capabilities.register('timedatectl', { binaries: ['timedatectl'], required: ['timedatectl'] });
  // Shared with Account Information (same required set, so registration order
  // does not matter); enabling quotas checks the scanning tools itself.
  ctx.capabilities.register('quota', { binaries: ['setquota', 'repquota', 'quotacheck', 'quotaon', 'quotaoff'], required: ['repquota', 'setquota'] });

  const svc = () => ctx.serverConfig;
  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(typeof status === 'function' ? status(d) : status).json(d?.meta ? d : { data: d })).catch(next);
  const jobOr200 = (d) => (d?.job ? 202 : 200);

  // Server Profile
  r.get('/profile', requireRoot, wrap(() => svc().profile.get()));
  r.put('/profile', requireRoot, validate({ body: z.object({ name: z.enum(PROFILE_NAMES) }).strict() }), wrap((req) => svc().profile.set(req.body.name, req)));

  // Configure cPanel Analytics
  r.get('/analytics', requireRoot, wrap(() => svc().analytics.get()));
  r.put('/analytics', requireRoot, validate({ body: nonEmpty(z.object({ enabled: z.boolean().optional(), shareUsage: z.boolean().optional(), shareErrors: z.boolean().optional() }).strict()) }), wrap((req) => svc().analytics.update(req.body, req)));
  r.post('/analytics/rotate-id', requireRoot, wrap((req) => svc().analytics.rotateId(req)));

  // Server Time
  r.get('/time', requireRoot, wrap(() => svc().time.get()));
  r.put('/time', requireRoot, validate({ body: nonEmpty(z.object({ timezone: timezone.optional(), ntp: z.boolean().optional() }).strict()) }), wrap((req) => svc().time.set(req.body, req)));

  // Initial Quota Setup
  r.get('/quota', requireRoot, wrap(() => svc().quota.status()));
  r.post('/quota/enable', requireRoot, validate({ body: z.object({ mountpoint: fields.absPath, groupQuota: z.boolean().default(true), updateFstab: z.boolean().default(false) }).strict() }), wrap((req) => svc().quota.enable(req.body, req.user, req), 202));
  r.post('/quota/disable', requireRoot, validate({ body: z.object({ mountpoint: fields.absPath }).strict() }), wrap((req) => svc().quota.disable(req.body, req)));
  r.post('/quota/install-tools', requireRoot, wrap((req) => svc().quota.installTools(req.user, req), jobOr200));

  // Link Server Nodes
  r.get('/nodes', requireRoot, wrap(() => svc().nodes.list()));
  r.post('/nodes', requireRoot, validate({ body: nodeCreate }), wrap((req) => svc().nodes.create(req.body, req), 201));
  r.put('/nodes/:id', requireRoot, validate({ params: id, body: nodeUpdate }), wrap((req) => svc().nodes.update(req.params.id, req.body, req)));
  r.delete('/nodes/:id', requireRoot, validate({ params: id }), wrap((req) => svc().nodes.remove(req.params.id, req)));
  r.post('/nodes/:id/test', requireRoot, validate({ params: id }), wrap((req) => svc().nodes.test(req.params.id, req)));

  // Statistics Software Configuration
  r.get('/stats', requireRoot, wrap(() => svc().stats.get()));
  r.put('/stats', requireRoot, validate({ body: nonEmpty(z.object({ generators: z.object(Object.fromEntries(GENERATORS.map((g) => [g, z.boolean().optional()]))).strict().optional(), defaultGenerator: z.enum(GENERATORS).optional(), allowUserChoice: z.boolean().optional(), includeSuspended: z.boolean().optional(), cron: cron.optional(), enabled: z.boolean().optional() }).strict()) }), wrap((req) => svc().stats.update(req.body, req)));
  r.post('/stats/run', requireRoot, validate({ body: z.object({ generator: z.enum(GENERATORS).optional(), domain: fields.hostname.optional() }).strict() }), wrap((req) => svc().stats.run(req.body, req.user, req), 202));

  // Terminal (root only; sessions are owned by the administrator who opened them)
  r.get('/terminal', requireRoot, wrap((req) => svc().terminal.list(req.user)));
  r.post('/terminal', requireRoot, validate({ body: z.object({ shell: z.enum(['/bin/bash', '/bin/sh']).default('/bin/bash'), cols: z.number().int().min(20).max(500).default(120), rows: z.number().int().min(5).max(200).default(32) }).strict() }), wrap((req) => svc().terminal.open(req.body, req), 201));
  r.get('/terminal/:id/stream', requireRoot, validate({ params: terminalId }), (req, res, next) => { try { svc().terminal.stream(req.params.id, req, res); } catch (err) { next(err); } });
  r.post('/terminal/:id/input', stashTerminalInput, requireRoot, validate({ params: terminalId }), wrap((req) => svc().terminal.write(req.params.id, parseTerminalInput(req), req)));
  r.delete('/terminal/:id', requireRoot, validate({ params: terminalId }), wrap((req) => svc().terminal.close(req.params.id, req)));

  // Update Preferences
  r.get('/updates', requireRoot, wrap(() => svc().updates.get()));
  r.put('/updates', requireRoot, validate({ body: nonEmpty(z.object({ tier: z.enum(UPDATE_TIERS).optional(), auto: z.boolean().optional(), autoOs: z.boolean().optional(), notifyContact: z.boolean().optional() }).strict()) }), wrap((req) => svc().updates.update(req.body, req)));
  r.post('/updates/check', requireRoot, wrap((req) => svc().updates.check(req.user, req), 202));

  // WHM Marketplace (static catalog until Phase 5)
  r.get('/marketplace', requireRoot, validate({ query: z.object({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(40).regex(/^[A-Za-z ]*$/).optional() }) }), wrap((req) => svc().marketplace.list(req.query)));

  return { path: '/server-config', router: r };
}
