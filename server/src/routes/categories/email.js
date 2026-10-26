import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createEmailService } from '../../services/email.js';

const messageId = z.string().regex(/^[A-Za-z0-9]{6}-[A-Za-z0-9]{6,11}-[A-Za-z0-9]{2,4}$/, 'Exim message id');
const idList = z.object({ ids: z.array(messageId).min(1).max(5000) }).strict();
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const hours = z.coerce.number().min(0).max(24 * 366).optional();
const countryCode = z.string().regex(/^[a-z]{2}$/i, 'Two-letter ISO country code').transform((v) => v.toLowerCase());
const singleLine = (max) => z.string().max(max).regex(/^[^\n\r\0]*$/, 'Single line');
const hostOrCidr = z.string().max(255).regex(/^[A-Za-z0-9.:*/_-]+$/, 'Host name, IP address or CIDR network');
const relPath = z.string().min(1).max(512).regex(/^(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]+$/, 'Path without ".." segments');
const mailboxFormat = z.enum(['maildir', 'mbox', 'mdbox', 'sdbox']);
const windowQuery = pagination.extend({ hours });
// Addresses reach exim/doveadm argv: an option-shaped local part is refused here too.
const safeEmail = fields.email.refine((v) => !v.startsWith('-'), 'Must not start with "-"');
// Rendered verbatim into spamd's EnvironmentFile; same shape the agent enforces.
const plainAbsPath = z.string().max(255).regex(/^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)+\/?$/, 'Absolute path made of letters, digits, ".", "_" and "-"');

const spamdBody = z.object({
  enabled: z.boolean().optional(), cron: z.boolean().optional(),
  maxChildren: z.number().int().min(1).max(200).nullable().optional(), minChildren: z.number().int().min(1).max(200).nullable().optional(),
  maxSpare: z.number().int().min(0).max(200).nullable().optional(), minSpare: z.number().int().min(0).max(200).nullable().optional(),
  maxConnPerChild: z.number().int().min(1).max(100_000).nullable().optional(), timeoutChild: z.number().int().min(1).max(3600).nullable().optional(),
  listenIp: z.string().regex(/^[0-9A-Fa-f.:*]{1,45}$/).nullable().optional(), port: z.number().int().min(1).max(65535).nullable().optional(),
  allowedIps: z.array(z.string().regex(/^[0-9A-Fa-f.:]+(\/\d{1,3})?$/)).max(50).nullable().optional(),
  username: fields.username.or(z.literal('root')).nullable().optional(), nice: z.number().int().min(-20).max(19).nullable().optional(),
  createPrefs: z.boolean().nullable().optional(), allowTell: z.boolean().nullable().optional(), helperHomeDir: plainAbsPath.nullable().optional(),
  localOnly: z.boolean().nullable().optional(), syslog: z.enum(['mail', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7', 'stderr', 'null']).nullable().optional(),
}).strict();

export async function register(ctx) {
  ctx.mail = createEmailService(ctx);
  ctx.capabilities.register('exim', { binaries: ['exim', 'exim4', 'exiqgrep', 'update-exim4.conf', 'greylistd', 'sqlite3'], required: ['exim', 'exim4'] });
  ctx.jobs.register('mail.mailbox.repair', (job) => ctx.mail.mailbox.repairJob(job));
  ctx.jobs.register('mail.mailbox.convert', (job) => ctx.mail.mailbox.convertJob(job));
  ctx.jobs.register('mail.greylist.purge', (job) => ctx.mail.greylist.purgeJob(job));
  ctx.jobs.register('mail.queue.flush', (job) => ctx.mail.queue.flushJob(job));
  ctx.scheduler.ensure('mail-greylist-purge', '40 3 * * *', 'mail.greylist.purge');

  const m = () => ctx.mail;
  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);

  r.get('/status', requireReseller, wrap(() => m().status()));

  // Mail Queue Manager
  r.get('/queue', requireRoot, validate({ query: pagination.extend({ frozen: boolQuery, olderThanMinutes: z.coerce.number().int().min(0).optional() }) }), wrap((req) => m().queue.list(req.query)));
  r.get('/queue/:id', requireRoot, validate({ params: z.object({ id: messageId }) }), wrap((req) => m().queue.message(req.params.id)));
  for (const kind of ['deliver', 'freeze', 'thaw', 'remove']) {
    r.post(`/queue/${kind}`, requireRoot, validate({ body: idList }), wrap((req) => m().queue.action(kind, req.body.ids, req)));
  }
  r.post('/queue/bulk', requireRoot, validate({ body: z.object({ action: z.enum(['deliver', 'freeze', 'thaw', 'remove']), frozen: z.boolean().optional(), q: z.string().trim().max(200).optional(), olderThanMinutes: z.number().int().min(0).optional() }).strict() }),
    wrap((req) => m().queue.actionMatching(req.body.action, req.body, req)));
  r.post('/queue/flush', requireRoot, validate({ body: z.object({ force: z.boolean().default(false) }).strict() }), wrap((req) => m().queue.flush(req.body.force, req.user, req), 202));

  // Mail Delivery Reports, statistics, sent summary, relayers
  r.get('/reports', requireRoot, validate({ query: windowQuery.extend({ sender: z.string().trim().max(254).optional(), recipient: z.string().trim().max(254).optional(), status: z.enum(['delivered', 'failed', 'deferred', 'queued', 'completed']).optional() }) }), wrap((req) => m().reports.delivery(req.query)));
  r.get('/stats/summary', requireRoot, validate({ query: z.object({ hours }) }), wrap((req) => m().stats.summary(req.query)));
  r.get('/stats/sent', requireRoot, validate({ query: windowQuery.extend({ authenticated: boolQuery }) }), wrap((req) => m().stats.sent(req.query)));
  r.get('/stats/relayers', requireRoot, validate({ query: windowQuery }), wrap((req) => m().stats.relayers(req.query)));

  // Mail Troubleshooter
  r.post('/troubleshoot', requireRoot, validate({ body: z.object({ address: safeEmail }).strict() }), wrap((req) => m().troubleshoot(req.body.address.toLowerCase(), req)));

  // Email Deliverability (account-scoped: resellers see their own domains)
  r.get('/deliverability', requireReseller, wrap((req) => m().deliverability.domains(req.user)));
  r.get('/deliverability/:domain', requireReseller, validate({ params: z.object({ domain: fields.domain }) }), wrap((req) => m().deliverability.check(req.params.domain, req.user)));
  r.post('/deliverability/:domain/fix', requireReseller, validate({ params: z.object({ domain: fields.domain }), body: z.object({ items: z.array(z.enum(['spf', 'dkim', 'dmarc'])).min(1).max(3) }).strict() }),
    wrap((req) => m().deliverability.fix(req.params.domain, req.body.items, req.user, req)));

  // Filter Incoming Emails by Country
  r.get('/filters/country', requireRoot, wrap(() => m().filters.country.list()));
  r.put('/filters/country/:code', requireRoot, validate({ params: z.object({ code: countryCode }), body: z.object({ name: singleLine(64).optional(), action: z.enum(['block', 'allow']).default('block'), enabled: z.boolean().default(true) }).strict() }),
    wrap((req) => m().filters.country.upsert(req.params.code, req.body, req)));
  r.get('/filters/country/:code/cidrs', requireRoot, validate({ params: z.object({ code: countryCode }), query: pagination }), wrap((req) => m().filters.country.cidrs(req.params.code, req.query)));
  r.post('/filters/country/:code/cidrs', requireRoot, validate({ params: z.object({ code: countryCode }), body: z.object({ text: z.string().min(1).max(16 * 1024 * 1024), replace: z.boolean().default(true) }).strict() }),
    wrap((req) => m().filters.country.setCidrs(req.params.code, req.body.text, { source: 'upload', replace: req.body.replace }, req)));
  r.post('/filters/country/:code/fetch', requireRoot, validate({ params: z.object({ code: countryCode }) }), wrap((req) => m().filters.country.fetch(req.params.code, req)));
  r.delete('/filters/country/:code', requireRoot, validate({ params: z.object({ code: countryCode }) }), wrap((req) => m().filters.country.remove(req.params.code, req)));

  // Filter Incoming Emails by Domain
  r.get('/filters/domain', requireRoot, wrap(() => m().filters.domain.list()));
  r.post('/filters/domain', requireRoot, validate({ body: z.object({ domain: fields.domain, kind: z.enum(['block', 'allow']), comment: singleLine(200).optional() }).strict() }), wrap((req) => m().filters.domain.add(req.body, req), 201));
  r.patch('/filters/domain/:id', requireRoot, validate({ params: z.object({ id: fields.id }), body: z.object({ enabled: z.boolean() }).strict() }), wrap((req) => m().filters.domain.setEnabled(req.params.id, req.body.enabled, req)));
  r.delete('/filters/domain/:id', requireRoot, validate({ params: z.object({ id: fields.id }) }), wrap((req) => m().filters.domain.remove(req.params.id, req)));
  r.put('/filters/messages', requireRoot, validate({ body: z.object({ country: singleLine(200).optional(), domain: singleLine(200).optional(), greylist: singleLine(200).optional() }).strict() }), wrap((req) => m().filters.setMessages(req.body, req)));
  r.post('/filters/apply', requireRoot, wrap((req) => m().filters.apply(req, { strict: true })));

  // Greylisting
  r.get('/greylist', requireRoot, wrap(() => m().greylist.status()));
  r.put('/greylist/settings', requireRoot, validate({ body: z.object({
    enabled: z.boolean().optional(), initialDelayMinutes: z.number().int().min(1).max(1440).optional(), mustRetryHours: z.number().int().min(1).max(168).optional(),
    recordExpiresDays: z.number().int().min(1).max(365).optional(), message: singleLine(200).optional(),
  }).strict() }), wrap((req) => m().greylist.update(req.body, req)));
  r.post('/greylist/trusted', requireRoot, validate({ body: z.object({ kind: z.enum(['host', 'sender_domain', 'recipient_domain']), value: hostOrCidr, comment: singleLine(200).optional() }).strict() }), wrap((req) => m().greylist.addTrusted(req.body, req), 201));
  r.delete('/greylist/trusted/:id', requireRoot, validate({ params: z.object({ id: fields.id }) }), wrap((req) => m().greylist.removeTrusted(req.params.id, req)));
  r.get('/greylist/triplets', requireRoot, validate({ query: z.object({ q: z.string().trim().max(200).regex(/^[^'\0;]*$/).optional(), limit: z.coerce.number().int().min(1).max(10_000).default(500) }) }), wrap((req) => m().greylist.triplets(req.query)));
  r.delete('/greylist/triplets', requireRoot, validate({ query: z.object({ all: boolQuery }) }), wrap((req) => m().greylist.purge({ all: req.query.all === true }, req)));

  // Mailbox Conversion + Repair Mailbox Permissions
  r.get('/mailbox/accounts', requireRoot, wrap(() => m().mailbox.accounts()));
  r.get('/mailbox/accounts/:username', requireRoot, validate({ params: z.object({ username: fields.username }) }), wrap((req) => m().mailbox.inspect(req.params.username)));
  r.post('/mailbox/repair', requireRoot, validate({ body: z.object({ usernames: z.array(fields.username).max(5000).optional(), all: z.boolean().default(false) }).strict() }), wrap((req) => m().mailbox.repair(req.body, req.user, req), 202));
  r.post('/mailbox/convert', requireRoot, validate({ body: z.object({
    username: fields.username, mailUser: safeEmail.or(fields.username).optional(),
    source: z.object({ format: mailboxFormat, path: relPath }).strict(), target: z.object({ format: mailboxFormat, path: relPath }).strict(), dryRun: z.boolean().default(false),
  }).strict() }), wrap((req) => m().mailbox.convert(req.body, req.user, req), 202));

  // Spamd Startup Configuration
  r.get('/spamd', requireRoot, wrap(() => m().spamd.status()));
  r.put('/spamd', requireRoot, validate({ body: spamdBody }), wrap((req) => m().spamd.update(req.body, req)));

  return { path: '/email', router: r };
}
