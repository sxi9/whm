import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { createServerContactsService, CHANNELS, SEVERITIES, SMTP_SECURITY, EVENT_KEY_RE } from '../../services/server-contacts.js';

const idParam = z.object({ id: fields.id });
const eventKey = z.string().regex(EVENT_KEY_RE, 'Event keys look like "service.down"');
const eventList = z.array(z.union([z.literal('*'), eventKey])).max(100);
const contactConfig = z.object({
  token: z.string().max(200).regex(/^[A-Za-z0-9]*$/, 'Pushover tokens are alphanumeric').nullable().optional(),
  secret: z.string().max(200).regex(/^[^\r\n\0]*$/).nullable().optional(),
  channelName: z.string().max(80).regex(/^[#@]?[A-Za-z0-9._-]*$/, 'Slack channel names use letters, digits, ".", "_" or "-"').nullable().optional(),
}).strict();
const nonEmpty = (schema) => schema.refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change', path: ['_'] });
const name = z.string().trim().max(80).regex(/^[^\r\n\0]*$/);
const address = z.string().trim().min(1).max(500).regex(/^[^\s\0]+$/, 'No whitespace');
const createBody = z.object({ name: name.optional(), channel: z.enum(CHANNELS), address, events: eventList.optional(), minSeverity: z.enum(SEVERITIES).optional(), enabled: z.boolean().optional(), config: contactConfig.optional() }).strict();
const updateBody = nonEmpty(z.object({ name: name.optional(), channel: z.enum(CHANNELS).optional(), address: address.optional(), events: eventList.optional(), minSeverity: z.enum(SEVERITIES).optional(), enabled: z.boolean().optional(), config: contactConfig.optional() }).strict());
const settingsBody = nonEmpty(z.object({
  enabled: z.boolean().optional(),
  fromAddress: z.union([z.literal(''), fields.email.regex(/^[A-Za-z0-9_]/, 'May not start with "-"')]).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  smtp: z.object({
    host: z.union([z.literal(''), fields.hostname, fields.ip]).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    security: z.enum(SMTP_SECURITY).optional(),
    username: z.string().max(254).regex(/^[^\s\0]*$/, 'No whitespace').optional(),
    password: z.string().max(256).regex(/^[^\r\n\0]*$/).nullable().optional(),
    allowSelfSigned: z.boolean().optional(),
    prefer: z.boolean().optional(),
  }).strict().optional(),
  check: z.object({
    enabled: z.boolean().optional(),
    diskThresholdPercent: z.number().int().min(50).max(99).optional(),
    cooldownMinutes: z.number().int().min(10).max(10_080).optional(),
    sslDays: z.number().int().min(1).max(90).optional(),
  }).strict().optional(),
}).strict());
const deliveriesQuery = z.object({
  page: fields.page, pageSize: fields.pageSize, q: z.string().trim().max(100).optional(),
  event: eventKey.optional(), status: z.enum(['sent', 'failed']).optional(), contactId: fields.id.optional(),
  sort: z.enum(['ts', 'event', 'channel', 'status', 'severity', 'address']).optional(), dir: z.enum(['asc', 'desc']).optional(),
});
const notifyBody = z.object({ event: eventKey, subject: z.string().trim().min(1).max(200), body: z.string().max(20_000).optional(), severity: z.enum(SEVERITIES).optional() }).strict();
const sendTestBody = z.object({ to: fields.email.regex(/^[A-Za-z0-9_]/, 'May not start with "-"') }).strict();
const aliasTarget = z.union([fields.username, fields.email.regex(/^[A-Za-z0-9_]/, 'May not start with "-"')]);
const mailPrefsBody = nonEmpty(z.object({ forwardTo: z.array(aliasTarget).max(20).optional(), rootMailEvents: z.array(eventKey).max(100).optional() }).strict());

export async function register(ctx) {
  ctx.contacts = createServerContactsService(ctx);
  const s = ctx.contacts;
  ctx.jobs.register(s.JOB, async (job) => {
    if (!s.checkConfig().enabled) { job.log('scheduled contact checks are disabled; nothing checked'); return { skipped: 'disabled' }; }
    await ctx.capabilities.ensureFresh();
    const r = await s.runChecks({ log: job.log });
    return { services: r.services, disks: r.disks, ssl: { expiring: r.ssl.expiring.length }, notifications: r.notifications.length };
  });
  ctx.scheduler.ensure(s.SCHEDULE, '*/10 * * * *', s.JOB);
  if (!s.checkConfig().enabled) ctx.scheduler.update(s.SCHEDULE, { enabled: false });

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  // Contact Manager
  r.get('/', requireRoot, wrap(() => s.overview()));
  r.get('/events', requireRoot, wrap(() => s.events()));
  r.get('/contacts', requireRoot, wrap(() => s.list()));
  r.post('/contacts', requireRoot, validate({ body: createBody }), created((req) => s.create(req.body, req)));
  r.get('/contacts/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.get(req.params.id)));
  r.patch('/contacts/:id', requireRoot, validate({ params: idParam, body: updateBody }), wrap((req) => s.update(req.params.id, req.body, req)));
  r.delete('/contacts/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.remove(req.params.id, req)));
  r.post('/contacts/:id/test', requireRoot, validate({ params: idParam }), wrap((req) => s.test(req.params.id, req)));
  r.get('/settings', requireRoot, wrap(() => s.settings()));
  r.put('/settings', requireRoot, validate({ body: settingsBody }), wrap((req) => s.updateSettings(req.body, req)));
  r.post('/settings/test-mail', requireRoot, validate({ body: sendTestBody }), wrap((req) => s.sendTest(req.body.to, req)));
  r.get('/deliveries', requireRoot, validate({ query: deliveriesQuery }), wrap((req) => s.deliveries(req.query)));
  r.post('/notify', requireRoot, validate({ body: notifyBody }), wrap((req) => s.notify(req.body, undefined, req)));
  r.post('/check', requireRoot, wrap((req) => s.runChecks({ req })));

  // Edit System Mail Preferences
  r.get('/mail-preferences', requireRoot, wrap(() => s.mailPreferences()));
  r.put('/mail-preferences', requireRoot, validate({ body: mailPrefsBody }), wrap((req) => s.setMailPreferences(req.body, req)));

  return { path: '/server-contacts', router: r };
}
