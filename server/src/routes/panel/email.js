import { validate, z, fields, pagination, patchOf } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, created } from './index.js';
import { createPanelEmailService, LOCAL_PART, SPECIAL_DESTINATIONS, DEFAULT_ACTIONS, FILTER_HEADERS, FILTER_OPS, FILTER_ACTION_TYPES, FILTER_MAX_MATCH, FILTER_MAX_ACTIONS, FILTER_NAME, FILTER_VALUE, FILTER_HEADER_NAME, FILTER_FOLDER, FILTER_ADDRESS, FOLDER_NAME, EXPUNGE_MIN_DAYS, EXPUNGE_MAX_DAYS, MESSAGE_STATUSES } from '../../services/panel-email.js';

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
const webmailSsoBody = z.object({ mailbox: z.string().max(254).regex(/^[a-z0-9][a-z0-9._-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, 'Must be one of your mailbox addresses').transform((s) => s.toLowerCase()) }).strict();
const usageQuery = z.object({ sinceHours: z.coerce.number().int().min(1).max(168).default(24) });
const usageMessagesQuery = usageQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const folderParam = z.object({ id: fields.id, folder: z.string().regex(FOLDER_NAME, 'Folder: no control characters, quotes, backslashes, wildcards or leading, trailing or doubled dots; max 200 chars') });
const emptyFolderBody = z.object({ olderThanDays: z.number().int().min(EXPUNGE_MIN_DAYS).max(EXPUNGE_MAX_DAYS).optional() }).strict();

// Mail filters: structured rules only (the service renders Sieve); values
// are single lines, every string lands in a Sieve quoted string.
const filterValue = z.string().min(1).max(998).regex(FILTER_VALUE, 'Must be a single line without control characters');
const filterMatch = z.object({
  header: z.enum(FILTER_HEADERS),
  name: z.string().regex(FILTER_HEADER_NAME, 'Header name: letters, digits and "-"; max 64 chars').optional(),
  op: z.enum(FILTER_OPS),
  value: filterValue,
}).strict();
const filterAction = z.object({
  type: z.enum(FILTER_ACTION_TYPES),
  folder: z.string().max(200).regex(FILTER_FOLDER, 'Folder: no control characters, quotes, slashes or leading, trailing or doubled dots').optional(),
  address: z.string().max(254).regex(FILTER_ADDRESS, 'Must be an email address').transform((s) => s.toLowerCase()).optional(),
}).strict();
const filterRules = z.object({ matchAll: z.boolean().default(true), match: z.array(filterMatch).min(1).max(FILTER_MAX_MATCH), actions: z.array(filterAction).min(1).max(FILTER_MAX_ACTIONS) }).strict();
const filterName = z.string().trim().min(1).max(80).regex(FILTER_NAME, 'Must be a single line');
const filterBody = z.object({ name: filterName, rules: filterRules, enabled: z.boolean().default(true) }).strict();
const filterPatch = patchOf(filterBody).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const filterTestBody = z.object({ name: filterName.optional(), rules: filterRules }).strict();
const filterReorderBody = z.object({ ids: z.array(fields.id).min(1).max(1000) }).strict();
const filterMailboxQuery = z.object({ mailbox: fields.id });

const createdWithMeta = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json(d?.meta ? d : { data: d })).catch(next);

export async function register(ctx) {
  ctx.panelEmail = createPanelEmailService(ctx);
  const s = ctx.panelEmail;
  s.registerSso();

  // Seam S4 (ctx.web.applyVirtualMail) is a root-level Exim/Dovecot rewrite
  // that only ever runs as a panel job: queued here once per boot (the worker
  // starts after capabilities.refresh, so the job never delays listen and a
  // missing daemon is a no-op), re-queued by a mailbox mutation that finds the
  // wiring not live, and triggered by root through Service Configuration.
  // Never from a customer request. Domains that leave an account
  // (addon/sub/parked removal in U3) are released with
  // ctx.panelEmail.releaseDomain(domain, accountId, req); termination is
  // handled by the account.terminated listener subscribed here.
  s.subscribe();
  ctx.jobs.register(s.VIRTUAL_MAIL_JOB, async (job) => {
    const r = await s.ensureVirtualMail(null, { force: job.params?.force === true });
    job.log(r.applied ? (r.live === false ? `applied but not live: ${r.lastApply?.error || 'see Service Configuration > virtual mail'}` : 'applied') : `not applied: ${r.reason}`, r.applied && r.live !== false ? 'info' : 'warn');
    return { applied: Boolean(r.applied), live: r.live ?? null, reason: r.reason ?? null, manualIncludes: r.manualIncludes ?? [] };
  });
  // Capabilities are detected after the routes register (bootstrap refreshes
  // once every module is in), so the boot request waits for that snapshot;
  // without one (agent unreachable) the first mailbox mutation queues it instead.
  if (ctx.config.env !== 'test') {
    let attempts = 0;
    const bootRequest = () => {
      if (ctx.capabilities.snapshot().at === 0 && attempts++ < 60) { setTimeout(bootRequest, 2_000).unref(); return; }
      s.requestVirtualMail('boot');
    };
    bootRequest();
  }

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

  // Mail filters (Sieve): per mailbox (?mailbox=<id>) and account-wide.
  ctx.capabilities.register('sieve', { binaries: ['sievec'], required: ['sievec'] });
  const mailboxId = (req) => req.query.mailbox;
  r.get('/filters', validate({ query: filterMailboxQuery }), wrap((req) => s.filters.list(req.panel, mailboxId(req))));
  r.post('/filters', validate({ query: filterMailboxQuery, body: filterBody }), createdWithMeta((req) => s.filters.create(req.panel, mailboxId(req), req.body, req)));
  r.post('/filters/test', validate({ query: filterMailboxQuery, body: filterTestBody }), wrap((req) => s.filters.test(req.panel, mailboxId(req), req.body, req)));
  r.post('/filters/reorder', validate({ query: filterMailboxQuery, body: filterReorderBody }), wrap((req) => s.filters.reorder(req.panel, mailboxId(req), req.body, req)));
  r.put('/filters/:id', validate({ params: idParam, body: filterPatch }), wrap((req) => s.filters.update(req.panel, req.params.id, req.body, req, 'mailbox')));
  r.delete('/filters/:id', validate({ params: idParam }), wrap((req) => s.filters.remove(req.panel, req.params.id, req, 'mailbox')));
  r.get('/global-filters', wrap((req) => s.filters.list(req.panel, null)));
  r.post('/global-filters', validate({ body: filterBody }), createdWithMeta((req) => s.filters.create(req.panel, null, req.body, req)));
  r.post('/global-filters/test', validate({ body: filterTestBody }), wrap((req) => s.filters.test(req.panel, null, req.body, req)));
  r.post('/global-filters/reorder', validate({ body: filterReorderBody }), wrap((req) => s.filters.reorder(req.panel, null, req.body, req)));
  r.put('/global-filters/:id', validate({ params: idParam, body: filterPatch }), wrap((req) => s.filters.update(req.panel, req.params.id, req.body, req, 'account')));
  r.delete('/global-filters/:id', validate({ params: idParam }), wrap((req) => s.filters.remove(req.panel, req.params.id, req, 'account')));

  // Per-domain mail routing (P1-4): 'remote' is refused (409) while mailboxes exist.
  r.get('/routing', wrap((req) => s.routing.list(req.panel)));
  r.get('/domains/:domain/routing', validate({ params: domainParam }), wrap((req) => s.routing.get(req.panel, req.params.domain)));
  r.put('/domains/:domain/routing', validate({ params: domainParam, body: z.object({ routing: z.enum(['auto', 'local', 'remote']) }).strict() }), wrap((req) => s.routing.set(req.panel, req.params.domain, req.body, req)));

  r.get('/webmail', validate({ query: webmailQuery }), wrap((req) => s.webmail(req.panel, req.query)));
  // Single sign-on is a browser hand-off (§44): never minted for an API token.
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Webmail sign-on is only available from a browser session')) : next());
  r.post('/webmail/sso', sessionOnly, validate({ body: webmailSsoBody }), wrap((req) => s.webmailSso(req.panel, req.body, req)));
  r.get('/usage', validate({ query: usageQuery }), wrap((req) => s.usage(req.panel, req.query)));
  // Delivery tracking + mailbox folders (P1-12). `/usage/messages` is
  // registered before any `/usage/:x` pattern could shadow it.
  r.get('/usage/messages', validate({ query: usageMessagesQuery }), wrap((req) => s.usageMessages(req.panel, req.query)));
  r.get('/accounts/:id/folders', validate({ params: idParam }), wrap((req) => s.folders.list(req.panel, req.params.id)));
  r.post('/accounts/:id/folders/:folder/empty', validate({ params: folderParam, body: emptyFolderBody }), wrap((req) => s.folders.empty(req.panel, req.params.id, req.params.folder, req.body, req)));

  return { path: '/email', router: r };
}
