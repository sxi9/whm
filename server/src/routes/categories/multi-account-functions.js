import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createMultiAccountService, RUN_KINDS } from '../../services/multi-account-functions.js';

const usernames = z.array(fields.username).min(1).max(1000);
const filter = z.object({
  q: z.string().trim().max(200).optional(), owner: fields.username.optional(), package: fields.packageName.optional(), ip: fields.ip.optional(), suspended: z.boolean().optional(),
}).strict();
const selection = { usernames: usernames.optional(), all: z.boolean().optional(), filter: filter.optional() };
const hasSelection = (b) => b.all === true || (b.usernames?.length ?? 0) > 0;
const mb = z.number().int().min(0).max(1_000_000_000);
const ipBody = z.object({
  changes: z.array(z.object({ username: fields.username, ip: z.string().ip({ version: 'v4' }) }).strict()).min(1).max(1000),
  updateDns: z.boolean().optional(), updateVhosts: z.boolean().optional(), requireDaemons: z.boolean().optional(),
}).strict();
const modifyChanges = z.object({
  package: fields.packageName.optional(), diskQuotaMb: mb.nullable().optional(), bandwidthLimitMb: mb.nullable().optional(), shell: fields.shell.optional(),
  contactEmail: fields.email.nullable().optional(), demoMode: z.boolean().optional(), forcePasswordChange: z.boolean().optional(), owner: fields.username.optional(),
}).strict().refine((c) => Object.values(c).some((v) => v !== undefined), { message: 'Choose at least one change', path: [] });
const modifyBody = z.object({ ...selection, changes: modifyChanges, applyPhp: z.boolean().optional(), requireDaemons: z.boolean().optional() }).strict()
  .refine(hasSelection, { message: 'Select at least one account or all', path: ['usernames'] });
const listQuery = z.object({
  q: z.string().trim().max(200).optional(), owner: fields.username.optional(), package: fields.packageName.optional(), ip: fields.ip.optional(),
  suspended: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['username', 'domain', 'owner', 'package_name', 'ip', 'disk_used_mb', 'created_at', 'suspended']).optional(), dir: fields.sortDir,
});
const runParam = z.object({ id: fields.id });

export async function register(ctx) {
  ctx.multiAccount = createMultiAccountService(ctx);
  ctx.jobs.register('multi_account.change_ip', (job) => ctx.multiAccount.runChangeIp(job));
  ctx.jobs.register('multi_account.modify', (job) => ctx.multiAccount.runModify(job));
  ctx.jobs.register('multi_account.cleanup', (job) => ctx.multiAccount.cleanup(job));
  ctx.scheduler.ensure('multi-account-run-cleanup', '20 4 * * 1', 'multi_account.cleanup');

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.multiAccount;

  // The selection table and run history are deliberately unpaginated: the page
  // selects across the whole visible set (bounded by multi_account.max_batch)
  // and the history is capped by `limit`; meta carries total/all/filters instead.
  r.get('/accounts', requireReseller, validate({ query: listQuery }), wrap((req) => svc().listAccounts(req.query, req.user)));
  r.get('/capabilities', requireReseller, wrap(() => svc().capabilities()));

  // Change Multiple Sites' IP Addresses ----------------------------------------
  r.get('/ip/addresses', requireRoot, wrap(() => svc().ipAddresses()));
  r.post('/ip/preview', requireRoot, validate({ body: ipBody }), wrap((req) => svc().previewChangeIp(req.body, req.user)));
  r.post('/ip', requireRoot, validate({ body: ipBody }), wrap((req) => svc().startChangeIp(req.body, req.user, req), 202));

  // Modify/Upgrade Multiple Accounts --------------------------------------------
  r.post('/modify/preview', requireReseller, validate({ body: modifyBody }), wrap((req) => svc().previewModify(req.body, req.user)));
  r.post('/modify', requireReseller, validate({ body: modifyBody }), wrap((req) => svc().startModify(req.body, req.user, req), 202));

  // Run history and downloadable reports ---------------------------------------
  r.get('/runs', requireReseller, validate({ query: z.object({ kind: z.enum(RUN_KINDS).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }), wrap((req) => svc().listRuns(req.query, req.user)));
  r.get('/runs/:id', requireReseller, validate({ params: runParam }), wrap((req) => svc().getRun(req.params.id, req.user)));
  r.get('/runs/:id/report', requireReseller, validate({ params: runParam, query: z.object({ format: z.enum(['csv', 'json']).default('csv') }) }), (req, res, next) => {
    try {
      const file = svc().report(req.params.id, req.query.format, req.user);
      res.set({ 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Cache-Control': 'no-store' });
      res.send(file.body);
    } catch (err) { next(err); }
  });

  return { path: '/multi-account', router: r };
}
