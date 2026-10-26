import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createAccountFunctionsService, TEMPLATE_NAMES, HOME_ROOTS } from '../../services/account-functions.js';

const nameParam = z.object({ username: fields.username });
const usernames = z.array(fields.username).min(1).max(1000);
const selection = { usernames: usernames.optional(), all: z.boolean().optional() };
const hasSelection = (b) => b.all === true || (b.usernames?.length ?? 0) > 0;
const templateName = z.enum(TEMPLATE_NAMES);
const logKind = z.enum(['apache', 'nginx']);
const logFile = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/, 'Log file name');
const mb = z.number().int().min(0).max(1_000_000_000);

export async function register(ctx) {
  ctx.accountFunctions = createAccountFunctionsService(ctx);
  ctx.jobs.register('accounts.email_all', (job) => ctx.accountFunctions.runEmailAll(job));
  ctx.jobs.register('accounts.rearrange', (job) => ctx.accountFunctions.rearrange.run(job));
  ctx.jobs.register('accounts.log_archive', (job) => ctx.accountFunctions.logRetention.run(job));
  ctx.jobs.register('accounts.bandwidth_enforce', (job) => ctx.accountFunctions.runBandwidthEnforce(job));
  ctx.jobs.register('accounts.bandwidth_monthly_reset', (job) => ctx.accountFunctions.runMonthlyBandwidthReset(job));
  ctx.scheduler.ensure('account-log-archive', '15 0 1 * *', 'accounts.log_archive');
  ctx.scheduler.ensure('account-bandwidth-monthly-reset', '5 0 1 * *', 'accounts.bandwidth_monthly_reset');
  ctx.scheduler.ensure('account-bandwidth-enforce', '40 * * * *', 'accounts.bandwidth_enforce');
  // The enforcement schedule follows its setting so it never enqueues work that is skipped.
  ctx.scheduler.update('account-bandwidth-enforce', { enabled: Boolean(ctx.settings.get('account_functions.bandwidth_enforce', false)) });
  ctx.capabilities.register('jailshell', { binaries: ['jailshell'], required: ['jailshell'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.accountFunctions;

  r.get('/summary', requireReseller, wrap((req) => svc().summary(req.user)));

  // Change Site's IP Address ----------------------------------------------------
  r.put('/ip/:username', requireReseller, validate({ params: nameParam, body: z.object({ ip: fields.ip }).strict() }), wrap((req) => svc().changeIp(req.params.username, req.body, req.user, req)));

  // Email All Users -------------------------------------------------------------
  r.get('/email/recipients', requireReseller, validate({ query: z.object({ scope: z.enum(['all', 'active', 'suspended']).default('all'), owner: fields.username.optional() }) }), wrap((req) => svc().recipients(req.query, req.user)));
  r.post('/email', requireReseller, validate({ body: z.object({ subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, 'Single line'), text: z.string().min(1).max(200_000), scope: z.enum(['all', 'active', 'suspended']).default('all'), owner: fields.username.optional(), from: fields.email.optional() }).strict() }),
    wrap((req) => svc().emailAll(req.body, req.user, req), 202));

  // Force Password Change / Manage Demo Mode (bulk flags) -----------------------
  const flagBody = z.object({ ...selection, enabled: z.boolean() }).strict().refine(hasSelection, { message: 'Select at least one account or all', path: ['usernames'] });
  r.post('/force-password-change', requireReseller, validate({ body: flagBody }), wrap((req) => svc().forcePasswordChange(req.body, req.user, req)));
  r.post('/demo-mode', requireReseller, validate({ body: flagBody }), wrap((req) => svc().setDemoMode(req.body, req.user, req)));

  // Bandwidth ------------------------------------------------------------------
  r.put('/bandwidth/:username', requireReseller, validate({ params: nameParam, body: z.object({ limitMb: mb.nullable() }).strict() }), wrap((req) => svc().setBandwidthLimit(req.params.username, req.body, req.user, req)));
  r.post('/bandwidth/reset', requireReseller, validate({ body: z.object({ ...selection, unsuspend: z.boolean().optional() }).strict().refine(hasSelection, { message: 'Select at least one account or all', path: ['usernames'] }) }),
    wrap((req) => svc().resetBandwidth(req.body, req.user, req)));
  r.get('/bandwidth/exceeders', requireReseller, wrap((req) => svc().exceeders(req.user)));
  r.post('/bandwidth/unsuspend-exceeders', requireReseller, validate({ body: z.object({ usernames: usernames.optional(), all: z.boolean().optional(), resetCounters: z.boolean().optional() }).strict() }),
    wrap((req) => svc().unsuspendExceeders(req.body, req.user, req)));
  r.put('/bandwidth-enforcement', requireRoot, validate({ body: z.object({ enabled: z.boolean(), reason: z.string().trim().min(1).max(200).optional() }).strict() }), wrap((req) => {
    ctx.settings.set('account_functions.bandwidth_enforce', req.body.enabled);
    if (req.body.reason) ctx.settings.set('account_functions.bandwidth_suspend_reason', req.body.reason.startsWith('bandwidth') ? req.body.reason : `bandwidth: ${req.body.reason}`);
    ctx.scheduler.update('account-bandwidth-enforce', { enabled: req.body.enabled });
    req.audit({ action: 'account.bandwidth.enforcement', args: req.body });
    return { enabled: req.body.enabled, reason: ctx.settings.get('account_functions.bandwidth_suspend_reason') };
  }));
  r.get('/bandwidth-enforcement', requireReseller, wrap(() => ({ enabled: Boolean(ctx.settings.get('account_functions.bandwidth_enforce', false)), reason: ctx.settings.get('account_functions.bandwidth_suspend_reason') })));

  // Manage Shell Access ---------------------------------------------------------
  r.put('/shell/:username', requireReseller, validate({ params: nameParam, body: z.object({ shell: fields.shell }).strict() }), wrap((req) => svc().setShell(req.params.username, req.body, req.user, req)));

  // Quota Modification ----------------------------------------------------------
  r.get('/quota/report', requireReseller, wrap((req) => svc().quotaReport(req.user)));
  r.put('/quota/:username', requireReseller, validate({ params: nameParam, body: z.object({ diskQuotaMb: mb.nullable() }).strict() }), wrap((req) => svc().setQuota(req.params.username, req.body, req.user, req)));

  // Raw Apache / NGINX Log Download ---------------------------------------------
  r.get('/logs/:kind/:username', requireReseller, validate({ params: z.object({ kind: logKind, username: fields.username }) }), wrap((req) => svc().logs.list(req.params.username, req.params.kind, req.user)));
  r.get('/logs/:kind/:username/download', requireReseller, validate({ params: z.object({ kind: logKind, username: fields.username }), query: z.object({ file: logFile }) }),
    (req, res, next) => svc().logs.download(req.params.username, req.params.kind, req.query.file, req.user, req, res).catch(next));

  // Rearrange an Account ---------------------------------------------------------
  r.get('/rearrange/partitions', requireRoot, wrap(() => svc().rearrange.partitions()));
  r.post('/rearrange/:username', requireRoot, validate({ params: nameParam, body: z.object({ target: z.enum(HOME_ROOTS) }).strict() }), wrap((req) => svc().rearrange.start(req.params.username, req.body, req.user, req), 202));

  // Web Log Retention -----------------------------------------------------------
  r.get('/log-retention', requireReseller, wrap((req) => svc().logRetention.list(req.user)));
  r.post('/log-retention/archive', requireReseller, validate({ body: z.object({ username: fields.username.optional() }).strict() }), wrap((req) => svc().logRetention.archiveNow(req.body, req.user, req), 202));
  r.get('/log-retention/:username', requireReseller, validate({ params: nameParam }), wrap((req) => svc().logRetention.get(req.params.username, req.user)));
  r.put('/log-retention/:username', requireReseller, validate({ params: nameParam, body: z.object({ archiveLogs: z.boolean().optional(), removeOldArchives: z.boolean().optional(), retainMonths: z.number().int().min(1).max(120).optional() }).strict() }),
    wrap((req) => svc().logRetention.set(req.params.username, req.body, req.user, req)));

  // Web Template Editor ---------------------------------------------------------
  r.get('/templates', requireRoot, wrap(() => svc().templates.list()));
  r.get('/templates/:name', requireRoot, validate({ params: z.object({ name: templateName }) }), wrap((req) => svc().templates.get(req.params.name)));
  r.put('/templates/:name', requireRoot, validate({ params: z.object({ name: templateName }), body: z.object({ body: z.string().min(1).max(512 * 1024) }).strict() }), wrap((req) => svc().templates.save(req.params.name, req.body.body, req)));
  r.post('/templates/:name/reset', requireRoot, validate({ params: z.object({ name: templateName }) }), wrap((req) => svc().templates.reset(req.params.name, req)));
  r.post('/templates/:name/preview', requireRoot, validate({ params: z.object({ name: templateName }), body: z.object({ body: z.string().max(512 * 1024).optional(), domain: fields.domain.optional(), username: fields.username.optional(), status: z.string().regex(/^[0-9]{3}$/).optional(), status_text: z.string().max(80).optional(), reason: z.string().max(200).optional() }).strict() }),
    wrap((req) => svc().templates.preview(req.params.name, req.body)));

  return { path: '/account-functions', router: r };
}
