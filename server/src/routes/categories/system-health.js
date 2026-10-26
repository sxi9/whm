import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { createSystemHealthService, PATTERN_RE, SIGNALS, SCOPES } from '../../services/system-health.js';

const patternName = z.string().trim().regex(PATTERN_RE, 'Process names use letters, digits, ".", "_", "+" or "-" and cannot start with "-"; max 64 chars');
const note = z.string().trim().max(200).nullable();
const idParam = z.object({ id: fields.id });
const pidParam = z.object({ pid: fields.id });
const configBody = z.object({
  enabled: z.boolean().optional(),
  signal: z.enum(SIGNALS).optional(),
  notify: z.boolean().optional(),
  scope: z.enum(SCOPES).optional(),
  exemptUsers: z.array(fields.username).max(200).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change', path: ['_'] });
const addPatternBody = z.object({ name: patternName, note: note.optional(), enabled: z.boolean().optional() }).strict();
const updatePatternBody = z.object({ name: patternName.optional(), note: note.optional(), enabled: z.boolean().optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change', path: ['_'] });
const scanBody = z.object({ dryRun: z.boolean().default(false) }).strict();
const killsQuery = z.object({
  page: fields.page, pageSize: fields.pageSize, q: z.string().trim().max(100).optional(),
  user: fields.username.optional(), result: z.enum(['killed', 'failed', 'gone', 'would-kill']).optional(),
  sort: z.enum(['killed_at', 'pid', 'user', 'command', 'pattern', 'result']).optional(), dir: z.enum(['asc', 'desc']).optional(),
});
const processesQuery = z.object({ sort: z.enum(['cpu', 'mem', 'pid', 'time']).default('cpu'), limit: z.coerce.number().int().min(1).max(5000).default(500), user: fields.username.optional() });

export async function register(ctx) {
  ctx.systemHealth = createSystemHealthService(ctx);
  const s = ctx.systemHealth;
  ctx.capabilities.register('procps', { binaries: ['ps', 'renice'], required: ['ps'] });
  ctx.jobs.register('system-health.bpk.scan', async (job) => {
    if (!s.config().enabled) { job.log('background process killer is disabled; nothing scanned'); return { skipped: 'disabled' }; }
    await ctx.capabilities.ensureFresh();
    if (!ctx.capabilities.has('procps')) { job.log('ps (procps) is not installed; nothing scanned', 'warn'); return { skipped: 'procps_missing' }; }
    const { run, kills } = await s.scan({ trigger: 'scheduled', log: job.log });
    return { runId: run.id, scanned: run.scanned, matched: run.matched, killed: run.killed, failed: run.failed, pids: kills.map((k) => k.pid) };
  });
  ctx.scheduler.ensure(s.SCHEDULE, '*/10 * * * *', 'system-health.bpk.scan');
  if (!s.config().enabled) ctx.scheduler.update(s.SCHEDULE, { enabled: false });

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  // Background Process Killer
  r.get('/bpk', requireRoot, wrap(() => s.overview()));
  r.put('/bpk/config', requireRoot, validate({ body: configBody }), wrap((req) => s.setConfig(req.body, req)));
  r.get('/bpk/patterns', requireRoot, wrap(() => s.patterns()));
  r.post('/bpk/patterns', requireRoot, validate({ body: addPatternBody }), created((req) => s.addPattern(req.body, req)));
  r.patch('/bpk/patterns/:id', requireRoot, validate({ params: idParam, body: updatePatternBody }), wrap((req) => s.updatePattern(req.params.id, req.body, req)));
  r.delete('/bpk/patterns/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.removePattern(req.params.id, req)));
  r.get('/bpk/matches', requireRoot, wrap(() => s.matches()));
  r.post('/bpk/scan', requireRoot, validate({ body: scanBody }), wrap((req) => s.scan({ dryRun: req.body.dryRun, trigger: 'manual', req })));
  r.post('/bpk/matches/:pid/kill', requireRoot, validate({ params: pidParam }), wrap((req) => s.killMatch(req.params.pid, req)));
  r.get('/bpk/kills', requireRoot, validate({ query: killsQuery }), wrap((req) => s.kills(req.query)));
  r.delete('/bpk/kills', requireRoot, wrap((req) => s.clearKills(req)));
  r.get('/bpk/runs', requireRoot, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }) }), wrap((req) => s.runs(req.query.limit)));

  // Show Current Disk Usage
  r.get('/disk', requireRoot, wrap(() => s.diskUsage()));

  // Process Manager / Show Current Running Processes
  r.get('/processes', requireRoot, validate({ query: processesQuery }), wrap((req) => s.processes(req.query)));
  r.post('/processes/:pid/signal', requireRoot, validate({ params: pidParam, body: z.object({ signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGSTOP', 'SIGCONT']).default('SIGTERM') }).strict() }),
    wrap((req) => s.signal(req.params.pid, req.body.signal, req)));
  r.post('/processes/:pid/renice', requireRoot, validate({ params: pidParam, body: z.object({ niceness: z.number().int().min(-20).max(19) }).strict() }),
    wrap((req) => s.renice(req.params.pid, req.body.niceness, req)));

  return { path: '/system-health', router: r };
}
