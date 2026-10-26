import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createResellersService, ACL_KEYS } from '../../services/resellers.js';

const nameParam = z.object({ username: fields.username });
const aclKey = z.enum(ACL_KEYS);
const aclListName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Lowercase letters, digits, "_" or "-"; max 40 chars');
const mb = z.number().int().min(0).max(1_000_000_000);
const usernames = z.array(fields.username).min(1).max(1000);
const limitFields = {
  maxAccounts: z.number().int().min(0).max(1_000_000).nullable().optional(),
  maxDiskMb: mb.nullable().optional(),
  maxBandwidthMb: mb.nullable().optional(),
  oversellDisk: z.boolean().optional(),
  oversellBandwidth: z.boolean().optional(),
  ownsNameservers: z.boolean().optional(),
  nameservers: z.array(fields.hostname).max(8).optional(),
  sharedIp: fields.ip.nullable().optional(),
  allowedPackages: z.array(fields.packageName).max(500).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  email: fields.email.nullable().optional(),
  acls: z.array(aclKey).max(ACL_KEYS.length).optional(),
  aclList: aclListName.optional(),
};

export async function register(ctx) {
  ctx.resellers = createResellersService(ctx);
  ctx.jobs.register('resellers.email_all', (job) => ctx.resellers.runEmailAll(job));

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.resellers;

  // Reseller Center -------------------------------------------------------------
  r.get('/', requireRoot, validate({ query: pagination }), wrap((req) => svc().list(req.query)));
  r.get('/catalog', requireRoot, wrap(() => svc().catalog()));
  r.post('/', requireRoot, validate({ body: z.object({
    username: fields.username, password: fields.password.optional(), fromAccount: z.boolean().optional(), forcePasswordChange: z.boolean().optional(), ...limitFields,
  }).strict() }), wrap((req) => svc().create(req.body, req.user, req), 201));

  // Usage overview / email / ownership / reset / ACL lists (static paths before /:username)
  r.get('/usage', requireRoot, wrap(() => svc().usageAll()));
  r.get('/email/recipients', requireRoot, wrap(() => svc().recipients()));
  r.get('/email/history', requireRoot, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }), wrap((req) => svc().emailHistory(req.query.limit)));
  r.post('/email', requireRoot, validate({ body: z.object({ subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, 'Single line'), text: z.string().min(1).max(200_000), from: fields.email.optional() }).strict() }),
    wrap((req) => svc().emailAll(req.body, req.user, req), 202));
  r.post('/reset', requireRoot, validate({ body: z.object({ usernames: usernames.optional(), all: z.boolean().optional() }).strict().refine((b) => b.all === true || (b.usernames?.length ?? 0) > 0, { message: 'Select at least one reseller or all', path: ['usernames'] }) }),
    wrap((req) => svc().reset(req.body, req.user, req)));
  r.get('/acl-lists', requireRoot, wrap(() => svc().aclLists.list()));
  r.put('/acl-lists/:name', requireRoot, validate({ params: z.object({ name: aclListName }), body: z.object({ acls: z.array(aclKey).max(ACL_KEYS.length) }).strict() }), wrap((req) => svc().aclLists.save(req.params.name, req.body.acls, req)));
  r.delete('/acl-lists/:name', requireRoot, validate({ params: z.object({ name: aclListName }) }), wrap((req) => svc().aclLists.remove(req.params.name, req)));
  r.put('/ownership/:username', requireRoot, validate({ params: nameParam, body: z.object({ owner: fields.username }).strict() }), wrap((req) => svc().changeOwner(req.params.username, req.body, req.user, req)));
  r.post('/ownership', requireRoot, validate({ body: z.object({ usernames, owner: fields.username }).strict() }), wrap((req) => svc().changeOwnerBulk(req.body, req.user, req)));

  // Per reseller -----------------------------------------------------------------
  r.get('/:username', requireReseller, validate({ params: nameParam }), wrap((req) => svc().get(req.params.username, req.user)));
  r.put('/:username', requireRoot, validate({ params: nameParam, body: z.object(limitFields).strict() }), wrap((req) => svc().update(req.params.username, req.body, req.user, req)));
  r.put('/:username/privileges', requireRoot, validate({ params: nameParam, body: z.object({ acls: z.array(aclKey).max(ACL_KEYS.length).optional(), aclList: aclListName.optional(), nameservers: z.array(fields.hostname).max(8).optional(), ownsNameservers: z.boolean().optional() }).strict() }),
    wrap((req) => svc().setPrivileges(req.params.username, req.body, req.user, req)));
  r.post('/:username/suspend', requireRoot, validate({ params: nameParam, body: z.object({ reason: z.string().trim().max(500).optional() }).strict() }), wrap((req) => svc().setSuspended(req.params.username, { suspend: true, reason: req.body.reason }, req.user, req)));
  r.post('/:username/unsuspend', requireRoot, validate({ params: nameParam }), wrap((req) => svc().setSuspended(req.params.username, { suspend: false }, req.user, req)));
  r.get('/:username/ips', requireReseller, validate({ params: nameParam }), wrap((req) => svc().delegation(req.params.username, req.user)));
  r.put('/:username/ips', requireRoot, validate({ params: nameParam, body: z.object({ addresses: z.array(fields.ip).max(1000) }).strict() }), wrap((req) => svc().setDelegation(req.params.username, req.body, req.user, req)));
  r.put('/:username/shared-ip', requireRoot, validate({ params: nameParam, body: z.object({ sharedIp: fields.ip.nullable() }).strict() }), wrap((req) => svc().setSharedIp(req.params.username, req.body, req.user, req)));
  r.get('/:username/accounts', requireReseller, validate({ params: nameParam, query: pagination.extend({ suspended: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }), wrap((req) => svc().accounts(req.params.username, req.query, req.user)));
  r.get('/:username/usage', requireReseller, validate({ params: nameParam }), wrap((req) => svc().usage(req.params.username, req.user)));

  return { path: '/resellers', router: r };
}
