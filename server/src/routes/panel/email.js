import { validate, z, fields, pagination, patchOf } from '../../lib/validate.js';
import { panelRouter, wrap, created } from './index.js';
import { createPanelEmailService, LOCAL_PART, SPECIAL_DESTINATIONS, DEFAULT_ACTIONS } from '../../services/panel-email.js';

// A forwarding target that can never be read by Exim as a pipe, a file, an
// :include: or an expansion: plain address characters only, lower-cased.
const FORWARD_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._+=-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const forwardAddress = z.string().max(254).regex(FORWARD_ADDRESS, 'Must be an email address').transform((s) => s.toLowerCase());
const destination = z.union([z.enum(SPECIAL_DESTINATIONS), forwardAddress], { error: 'A destination must be an email address, ":fail:" or ":blackhole:"' });
const localPart = z.string().regex(LOCAL_PART, 'Local part: lowercase letters, digits, ".", "_" or "-"; must start with a letter or digit; max 64 chars');
const singleLine = (max) => z.string().max(max).regex(/^[^\n\r\0]*$/, 'Must be a single line');
const isoDate = z.string().datetime({ offset: true });
const boolQuery = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : Boolean(v)), z.boolean());
const quotaMb = z.number().int().min(0).max(1_000_000_000).nullable();
const spamScore = z.number().min(1).max(20).refine((n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9, 'Use at most one decimal');

const idParam = z.object({ id: fields.id });
const domainParam = z.object({ domain: fields.domain });

const listQuery = pagination.extend({ domain: fields.domain.optional(), usage: boolQuery.optional() });
const createAccountBody = z.object({ localPart, domain: fields.domain, password: fields.password, quotaMb: quotaMb.optional() }).strict();
const passwordBody = z.object({ password: fields.password }).strict();
const quotaBody = z.object({ quotaMb }).strict();
const stateBody = z.object({ suspended: z.boolean() }).strict();
const removeQuery = z.object({ removeMail: boolQuery.default(false) });

const forwarderQuery = z.object({ domain: fields.domain.optional(), q: z.string().trim().max(200).optional() });
const forwarderBody = z.object({ domain: fields.domain, localPart: localPart.nullable().default(null), destination }).strict();
const defaultBody = z.object({ action: z.enum(DEFAULT_ACTIONS), destination: forwardAddress.optional() }).strict();
const domainForwardBody = z.object({ targetDomain: fields.domain }).strict();

const autoresponderBody = z.object({
  address: z.string().max(254).regex(/^[a-z0-9][a-z0-9._-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, 'Must be an address at one of your domains').transform((s) => s.toLowerCase()),
  fromName: singleLine(128).default(''),
  subject: singleLine(255).min(1),
  body: z.string().max(64 * 1024),
  charset: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/, 'Charset: letters, digits, ".", "_" or "-"').default('utf-8'),
  intervalHours: z.number().int().min(0).max(720).default(24),
  startAt: isoDate.nullable().optional(),
  stopAt: isoDate.nullable().optional(),
  enabled: z.boolean().default(true),
}).strict();
const autoresponderPatch = patchOf(autoresponderBody).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const spamBody = z.object({
  enabled: z.boolean(),
  requiredScore: spamScore,
  autoDelete: z.boolean(),
  autoDeleteScore: spamScore.nullable(),
  whitelist: z.array(forwardAddress).max(200),
  blacklist: z.array(forwardAddress).max(200),
}).strict();
const spamPatch = patchOf(spamBody).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const fixBody = z.object({ items: z.array(z.enum(['spf', 'dkim', 'dmarc'])).min(1).max(3) }).strict();
const dkimBody = z.object({ rotate: z.boolean().default(false) }).strict();
const webmailQuery = z.object({ user: z.string().max(254).regex(/^[^\s@]+@[^\s@]+$/, 'Email address').optional() });
const usageQuery = z.object({ sinceHours: z.coerce.number().int().min(1).max(168).default(24) });

const createdWithMeta = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json(d?.meta ? d : { data: d })).catch(next);

export async function register(ctx) {
  ctx.panelEmail = createPanelEmailService(ctx);
  const s = ctx.panelEmail;

  // Seam S4 (ctx.web.applyVirtualMail) is a root-level Exim/Dovecot rewrite:
  // the integrator calls ctx.panelEmail.ensureVirtualMail() from boot code
  // after capabilities.refresh, never from a customer request. Domains that
  // leave an account (addon/sub/parked removal in U3) are released with
  // ctx.panelEmail.releaseDomain(domain, accountId, req); termination is
  // handled by the account.terminated listener subscribed here.
  s.subscribe();

  const r = panelRouter(ctx, 'email');

  r.get('/accounts', validate({ query: listQuery }), wrap((req) => s.accounts.list(req.panel, req.query)));
  r.post('/accounts', validate({ body: createAccountBody }), createdWithMeta((req) => s.accounts.create(req.panel, req.body, req)));
  r.get('/accounts/:id', validate({ params: idParam }), wrap((req) => s.accounts.get(req.panel, req.params.id)));
  r.get('/accounts/:id/client-settings', validate({ params: idParam }), wrap((req) => s.accounts.clientSettings(req.panel, req.params.id)));
  r.put('/accounts/:id/password', validate({ params: idParam, body: passwordBody }), wrap((req) => s.accounts.setPassword(req.panel, req.params.id, req.body, req)));
  r.put('/accounts/:id/quota', validate({ params: idParam, body: quotaBody }), wrap((req) => s.accounts.setQuota(req.panel, req.params.id, req.body, req)));
  r.patch('/accounts/:id', validate({ params: idParam, body: stateBody }), wrap((req) => s.accounts.patch(req.panel, req.params.id, req.body, req)));
  r.delete('/accounts/:id', validate({ params: idParam, query: removeQuery }), wrap((req) => s.accounts.remove(req.panel, req.params.id, req.query, req)));

  r.get('/forwarders', validate({ query: forwarderQuery }), wrap((req) => s.forwarders.list(req.panel, req.query)));
  r.post('/forwarders', validate({ body: forwarderBody }), created((req) => s.forwarders.create(req.panel, req.body, req)));
  r.delete('/forwarders/:id', validate({ params: idParam }), wrap((req) => s.forwarders.remove(req.panel, req.params.id, req)));

  r.get('/domains/:domain/default', validate({ params: domainParam }), wrap((req) => s.defaultAddress.get(req.panel, req.params.domain)));
  r.put('/domains/:domain/default', validate({ params: domainParam, body: defaultBody }), wrap((req) => s.defaultAddress.set(req.panel, req.params.domain, req.body, req)));
  r.get('/domains/:domain/forward', validate({ params: domainParam }), wrap((req) => s.domainForward.get(req.panel, req.params.domain)));
  r.put('/domains/:domain/forward', validate({ params: domainParam, body: domainForwardBody }), wrap((req) => s.domainForward.set(req.panel, req.params.domain, req.body, req)));
  r.delete('/domains/:domain/forward', validate({ params: domainParam }), wrap((req) => s.domainForward.remove(req.panel, req.params.domain, req)));

  r.get('/autoresponders', wrap((req) => s.autoresponders.list(req.panel)));
  r.post('/autoresponders', validate({ body: autoresponderBody }), created((req) => s.autoresponders.create(req.panel, req.body, req)));
  r.get('/autoresponders/:id', validate({ params: idParam }), wrap((req) => s.autoresponders.get(req.panel, req.params.id)));
  r.put('/autoresponders/:id', validate({ params: idParam, body: autoresponderPatch }), wrap((req) => s.autoresponders.update(req.panel, req.params.id, req.body, req)));
  r.delete('/autoresponders/:id', validate({ params: idParam }), wrap((req) => s.autoresponders.remove(req.panel, req.params.id, req)));

  r.get('/spam', wrap((req) => s.spam.get(req.panel)));
  r.put('/spam', validate({ body: spamPatch }), wrap((req) => s.spam.set(req.panel, req.body, req)));

  r.get('/deliverability/:domain', validate({ params: domainParam }), wrap((req) => s.deliverability.check(req.panel, req.params.domain)));
  r.post('/deliverability/:domain/fix', validate({ params: domainParam, body: fixBody }), wrap((req) => s.deliverability.fix(req.panel, req.params.domain, req.body, req)));
  r.get('/dkim/:domain', validate({ params: domainParam }), wrap((req) => s.dkim.status(req.panel, req.params.domain)));
  r.post('/dkim/:domain', validate({ params: domainParam, body: dkimBody }), wrap((req) => s.dkim.ensure(req.panel, req.params.domain, req.body, req)));
  r.delete('/dkim/:domain', validate({ params: domainParam }), wrap((req) => s.dkim.remove(req.panel, req.params.domain, req)));

  r.get('/webmail', validate({ query: webmailQuery }), wrap((req) => s.webmail(req.panel, req.query)));
  r.get('/usage', validate({ query: usageQuery }), wrap((req) => s.usage(req.panel, req.query)));

  return { path: '/email', router: r };
}
