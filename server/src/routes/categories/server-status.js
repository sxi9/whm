import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { createServerStatusService } from '../../services/server-status.js';

// Server Information, Service Status and Task Queue Monitor are served by the
// core /system router; this module adds Apache Status and the Daily Process Log.
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Must be a date in YYYY-MM-DD form');
// System accounts (www-data, systemd-resolve, _apt, ...) do not fit the panel's
// username rule, so the filter accepts what `ps` prints and nothing else.
const processUser = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,31}$/, 'Not a valid system user name');
const settingsBody = z.object({
  enabled: z.boolean().optional(),
  topN: z.number().int().min(1).max(200).optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export async function register(ctx) {
  ctx.serverStatus = createServerStatusService(ctx);
  const s = ctx.serverStatus;
  for (const [type, handler] of Object.entries(s.jobs)) ctx.jobs.register(type, handler);
  ctx.scheduler.ensure(s.schedule.name, s.schedule.cron, s.schedule.jobType);
  s.processLog.alignSchedule();

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.serverStatus;

  // Apache Status
  r.get('/apache', requireRoot, wrap(() => svc().apache()));
  r.post('/apache/enable-status', requireRoot, wrap((req) => svc().enableModStatus(req)));

  // Daily Process Log
  r.get('/process-log/days', requireRoot, wrap(() => svc().processLog.days()));
  r.get('/process-log/settings', requireRoot, wrap(() => svc().processLog.settings()));
  r.put('/process-log/settings', requireRoot, validate({ body: settingsBody }), wrap((req) => svc().processLog.updateSettings(req.body, req)));
  r.post('/process-log/sample', requireRoot, wrap((req) => ({ job: svc().processLog.enqueueSample(req.user) }), 202));
  r.get('/process-log/latest', requireRoot, wrap(() => svc().processLog.latest()));
  r.get('/process-log/day/:date', requireRoot, validate({ params: z.object({ date: day }), query: z.object({ user: processUser.optional() }) }), wrap((req) => svc().processLog.day(req.params.date, req.query)));
  r.delete('/process-log/day/:date', requireRoot, validate({ params: z.object({ date: day }) }), wrap((req) => svc().processLog.purgeDay(req.params.date, req)));
  r.get('/process-log/samples/:id', requireRoot, validate({ params: z.object({ id: fields.id }) }), wrap((req) => svc().processLog.sampleDetail(req.params.id)));

  return { path: '/server-status', router: r };
}
