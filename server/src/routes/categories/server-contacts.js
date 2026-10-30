import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { unprocessable } from '../../lib/errors.js';
import { createServerContactsService, maskAddress, CHANNELS, SEVERITIES, SMTP_SECURITY, EVENT_KEY_RE, MANAGED_MAIL_USERS } from '../../services/server-contacts.js';
import { createSecurityAlertsService } from '../../services/security-alerts.js';

const idParam = z.object({ id: fields.id });
const eventKey = z.string().regex(EVENT_KEY_RE, 'Event keys look like "service.down"');
const eventList = z.array(z.union([z.literal('*'), eventKey])).max(100);
const contactConfig = z.object({
  token: z.string().max(200).regex(/^[A-Za-z0-9]*$/, 'Pushover tokens are alphanumeric').nullable().optional(),
  secret: z.string().trim().max(200).regex(/^[^\r\n\0]*$/).nullable().optional(),
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
    host: z.union([z.literal(''), z.literal('localhost'), fields.hostname, fields.ip]).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    security: z.enum(SMTP_SECURITY).optional(),
    username: z.string().max(254).regex(/^[^\s\0]*$/, 'No whitespace').optional(),
    password: z.string().max(256).regex(/^[^\r\n\0]*$/).nullable().optional(),
    allowSelfSigned: z.boolean().optional(),
    prefer: z.boolean().optional(),
    allowPlaintextAuth: z.boolean().optional(),
  }).strict().optional(),
  webhook: z.object({ allowPrivate: z.boolean().optional() }).strict().optional(),
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
// The route-level audit row (middleware/audit.js) mirrors req.body when the
// response finishes, so a credential-bearing "address" is swapped for its
// display form before anything can reject the request (RBAC, validation):
// a 403/422 must not record a Slack or tokenised webhook URL either. The real
// body travels on req.contactInput and is validated from there.
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
function auditSafeAddress(channel, address) {
  if (!URL_LIKE.test(address)) return address;
  try {
    const { display, secret } = maskAddress(channel, address);
    if (secret) return display;
    const url = new URL(address);
    if (channel === 'webhook' && !url.username && !url.password) return display;
  } catch { /* unparseable: redacted below */ }
  return '[redacted]';
}
function stashContactBody(req, _res, next) {
  const raw = req.body;
  req.contactInput = raw;
  if (raw && typeof raw === 'object' && typeof raw.address === 'string') req.body = { ...raw, address: auditSafeAddress(raw.channel, raw.address) };
  next();
}
const parseContactBody = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.contactInput ?? {});
  if (!result.success) {
    const fieldErrors = {};
    for (const issue of result.error.issues) (fieldErrors[issue.path.join('.') || '_'] ||= []).push(issue.message);
    return next(unprocessable('Request validation failed', fieldErrors));
  }
  req.contactInput = result.data;
  next();
};
const sendTestBody = z.object({ to: fields.email.regex(/^[A-Za-z0-9_]/, 'May not start with "-"') }).strict();
const aliasTarget = z.union([fields.username, fields.email.regex(/^[A-Za-z0-9_]/, 'May not start with "-"')]);
const aliasList = z.array(aliasTarget).max(20);
const mailPrefsBody = nonEmpty(z.object({
  forwardTo: aliasList.optional(),
  users: z.object(Object.fromEntries(MANAGED_MAIL_USERS.map((u) => [u, aliasList.optional()]))).strict().optional(),
  rootMailEvents: z.array(eventKey).max(100).optional(),
}).strict());
const freeText = (max) => z.string().trim().min(1).max(max).regex(/^[^\0]*$/);
const alertSettingsBody = nonEmpty(z.object({
  enabled: z.boolean().optional(),
  notifyAccounts: z.boolean().optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
  digestMinutes: z.number().int().min(0).max(1440).optional(),
}).strict());
const alertTestBody = z.object({ includeAccounts: z.boolean().optional() }).strict();
const alertBroadcastBody = z.object({ title: freeText(200).regex(/^[^\r\n]*$/, 'One line'), body: freeText(10_000), severity: z.enum(SEVERITIES).optional(), notifyAccounts: z.boolean().optional() }).strict();
const alertListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

export async function register(ctx) {
  ctx.contacts = createServerContactsService(ctx);
  const s = ctx.contacts;
  // A scheduled run honours the enable toggle; "Run checks now" ({ manual })
  // always runs so the admin can see what a check would report.
  ctx.jobs.register(s.JOB, async (job) => {
    if (!job.params?.manual && !s.checkConfig().enabled) { job.log('scheduled contact checks are disabled; nothing checked'); return { skipped: 'disabled' }; }
    await ctx.capabilities.ensureFresh();
    return s.runChecks({ log: job.log });
  });
  ctx.scheduler.ensure(s.SCHEDULE, '*/10 * * * *', s.JOB);
  if (!s.checkConfig().enabled) ctx.scheduler.update(s.SCHEDULE, { enabled: false });

  // Security alerts ride on the contacts transports; alerts left pending by a
  // restart (a digest window that never closed) are delivered once the job
  // worker starts.
  ctx.securityAlerts = createSecurityAlertsService(ctx);
  const a = ctx.securityAlerts;
  ctx.jobs.register(a.JOB, (job) => a.deliverJob(job));
  if (a.pendingCount() > 0) { try { a.scheduleDelivery(); } catch (err) { ctx.logger.warn({ err }, 'could not schedule pending security alerts'); } }

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);
  const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(202).json({ data: d })).catch(next);

  // Contact Manager
  r.get('/', requireRoot, wrap(() => s.overview()));
  r.get('/events', requireRoot, wrap(() => s.events()));
  r.get('/contacts', requireRoot, wrap(() => s.list()));
  r.post('/contacts', stashContactBody, requireRoot, parseContactBody(createBody), created((req) => s.create(req.contactInput, req)));
  r.get('/contacts/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.get(req.params.id)));
  r.patch('/contacts/:id', stashContactBody, requireRoot, validate({ params: idParam }), parseContactBody(updateBody), wrap((req) => s.update(req.params.id, req.contactInput, req)));
  r.delete('/contacts/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.remove(req.params.id, req)));
  r.post('/contacts/:id/test', requireRoot, validate({ params: idParam }), wrap((req) => s.test(req.params.id, req)));
  r.get('/settings', requireRoot, wrap(() => s.settings()));
  r.put('/settings', requireRoot, validate({ body: settingsBody }), wrap((req) => s.updateSettings(req.body, req)));
  r.post('/settings/test-mail', requireRoot, validate({ body: sendTestBody }), wrap((req) => s.sendTest(req.body.to, req)));
  r.get('/deliveries', requireRoot, validate({ query: deliveriesQuery }), wrap((req) => s.deliveries(req.query)));
  r.post('/notify', requireRoot, validate({ body: notifyBody }), wrap((req) => s.notify(req.body, undefined, req)));
  r.post('/check', requireRoot, (req, res, next) => {
    try {
      const job = ctx.jobs.enqueue(s.JOB, { manual: true, requestedBy: req.user?.username }, { userId: req.user?.id ?? null });
      res.status(202).json({ data: { job } });
    } catch (err) { next(err); }
  });

  // Edit System Mail Preferences
  r.get('/mail-preferences', requireRoot, wrap(() => s.mailPreferences()));
  r.put('/mail-preferences', requireRoot, validate({ body: mailPrefsBody }), wrap((req) => s.setMailPreferences(req.body, req)));
  r.post('/mail-preferences/test', requireRoot, wrap((req) => s.testRootMail(req)));

  // Security notifications (emergency update notices)
  r.get('/security-alerts', requireRoot, wrap(() => a.overview()));
  r.get('/security-alerts/alerts', requireRoot, validate({ query: alertListQuery }), wrap((req) => a.list(req.query)));
  r.put('/security-alerts/settings', requireRoot, validate({ body: alertSettingsBody }), wrap((req) => a.updateSettings(req.body, req)));
  r.post('/security-alerts/test', requireRoot, validate({ body: alertTestBody }), accepted((req) => a.test(req.body, req)));
  r.post('/security-alerts/raise', requireRoot, validate({ body: alertBroadcastBody }), accepted((req) => a.broadcast(req.body, req)));
  r.post('/security-alerts/deliver', requireRoot, accepted((req) => a.deliverNow(req)));

  return { path: '/server-contacts', router: r };
}
