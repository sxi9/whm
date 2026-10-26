import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createAccountInformationService } from '../../services/account-information.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Lowercase letters, digits, "_" or "-"; max 64 chars');
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month in YYYY-MM form');
const scope = z.enum(['over', 'warn', 'all']).optional();
const nameParam = z.object({ username: fields.username });
const idParam = z.object({ id: slug });
const limits = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Limit keys are lowercase identifiers'), z.union([z.number().finite(), z.boolean(), z.string().max(200)]))
  .refine((v) => Object.keys(v).length <= 50, 'At most 50 limits');
const enhancementBody = z.object({
  name: z.string().trim().min(1).max(80),
  id: slug.optional(),
  description: z.string().trim().max(500).optional(),
  limits: limits.optional(),
  enabled: z.boolean().optional(),
}).strict();

export async function register(ctx) {
  ctx.accountInfo = createAccountInformationService(ctx);
  ctx.jobs.register('account_info.disk_refresh', (job) => ctx.accountInfo.refreshDiskUsage(job));
  ctx.jobs.register('account_info.bandwidth_collect', (job) => ctx.accountInfo.collectBandwidth(job));
  ctx.scheduler.ensure('account-disk-usage', '25 */6 * * *', 'account_info.disk_refresh');
  ctx.scheduler.ensure('account-bandwidth', '35 * * * *', 'account_info.bandwidth_collect');
  ctx.capabilities.register('quota', { binaries: ['setquota', 'repquota', 'quotacheck', 'quotaon'], required: ['repquota', 'setquota'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.accountInfo;

  r.get('/overview', requireReseller, wrap((req) => svc().overview(req.user)));

  // List Parked Domains / List Subdomains ------------------------------------------
  r.get('/domains', requireReseller, validate({ query: pagination.extend({ type: z.enum(['parked', 'sub', 'addon', 'main', 'all']).optional(), account: fields.username.optional() }) }),
    wrap((req) => svc().listDomains(req.query, req.user)));

  // Show Accounts Over Quota -------------------------------------------------------
  r.get('/quota', requireReseller, validate({ query: pagination.extend({ scope }) }), wrap((req) => svc().quota(req.query, req.user)));
  r.get('/quota/report', requireRoot, validate({ query: z.object({ filesystem: fields.absPath.optional() }) }), wrap((req) => svc().quotaReport(req.query.filesystem)));
  r.post('/quota/refresh', requireRoot, wrap((req) => ({ job: svc().enqueueDiskRefresh(req.user) }), 202));

  // View Bandwidth Usage -----------------------------------------------------------
  r.get('/bandwidth', requireReseller, validate({ query: pagination.extend({ period: period.optional(), scope }) }), wrap((req) => svc().bandwidth(req.query, req.user)));
  r.get('/bandwidth/settings', requireRoot, wrap(() => svc().bandwidthSettings()));
  r.put('/bandwidth/settings', requireRoot, validate({ body: z.object({
    suspendOnExceed: z.boolean().optional(), suspendReason: z.string().trim().min(1).max(200).optional(), warnPercent: z.number().int().min(1).max(100).optional(),
    maxLogBytes: z.number().int().min(65536).max(32 * 1024 * 1024).optional(), extraLogDirs: z.array(fields.absPath).max(10).optional(),
  }).strict() }), wrap((req) => svc().updateBandwidthSettings(req.body, req)));
  r.post('/bandwidth/collect', requireRoot, wrap((req) => ({ job: svc().enqueueBandwidthCollect(req.user) }), 202));
  r.get('/bandwidth/:username', requireReseller, validate({ params: nameParam, query: z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }) }),
    wrap((req) => svc().bandwidthHistory(req.params.username, req.user, req.query.months)));
  r.post('/bandwidth/:username/reset', requireReseller, validate({ params: nameParam, body: z.object({ all: z.boolean().optional(), period: period.optional() }).strict() }),
    wrap((req) => svc().resetBandwidth(req.params.username, req.body, req.user, req)));

  // Manage Account Enhancements ----------------------------------------------------
  r.get('/enhancements', requireReseller, validate({ query: pagination }), wrap((req) => svc().enhancements.list(req.query)));
  r.post('/enhancements', requireRoot, validate({ body: enhancementBody }), wrap((req) => svc().enhancements.create(req.body, req), 201));
  r.get('/enhancements/:id', requireReseller, validate({ params: idParam }), wrap((req) => svc().enhancements.get(req.params.id)));
  r.put('/enhancements/:id', requireRoot, validate({ params: idParam, body: enhancementBody.partial() }), wrap((req) => svc().enhancements.update(req.params.id, req.body, req)));
  r.delete('/enhancements/:id', requireRoot, validate({ params: idParam }), wrap((req) => svc().enhancements.remove(req.params.id, req)));
  r.get('/enhancements/:id/accounts', requireReseller, validate({ params: idParam }), wrap((req) => svc().enhancements.accounts(req.params.id, req.user)));
  r.get('/accounts/:username/enhancements', requireReseller, validate({ params: nameParam }), wrap((req) => svc().enhancements.forAccount(req.params.username, req.user)));
  r.get('/accounts/:username/enhancements/effective', requireReseller, validate({ params: nameParam }), wrap((req) => svc().enhancements.effectiveLimits(req.params.username, req.user)));
  r.put('/accounts/:username/enhancements', requireReseller, validate({ params: nameParam, body: z.object({ enhancements: z.array(slug).max(100) }).strict() }),
    wrap((req) => svc().enhancements.setForAccount(req.params.username, req.body.enhancements, req.user, req)));
  r.post('/accounts/:username/enhancements/:id', requireReseller, validate({ params: nameParam.merge(idParam) }),
    wrap((req) => svc().enhancements.assign(req.params.username, req.params.id, req.user, req), 201));
  r.delete('/accounts/:username/enhancements/:id', requireReseller, validate({ params: nameParam.merge(idParam) }),
    wrap((req) => svc().enhancements.unassign(req.params.username, req.params.id, req.user, req)));

  return { path: '/account-info', router: r };
}
