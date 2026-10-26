import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createIpService, REMOTE_SERVICES } from '../../services/ip-functions.js';

const addressParam = z.object({ address: fields.ip });
const idParam = z.object({ id: fields.id });
const netmask = z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$|^\/?\d{1,3}$/, 'Dotted netmask (255.255.255.0) or prefix length');
const prefix = z.number().int().min(0).max(128);
const iface = z.string().regex(/^[a-zA-Z0-9._-]{1,15}$/, 'Interface name such as eth0');
const rangeName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/, 'Letters, digits, spaces, "_", "." or "-"; max 64 chars');
const cidr6 = z.string().trim().regex(/^[0-9a-fA-F:.]{2,45}\/\d{1,3}$/, 'IPv6 network in CIDR notation, e.g. 2001:db8:1::/64');
const reason = z.string().trim().max(200).nullable().optional();
const mappings = z.array(z.object({ from: fields.ip, to: fields.ip }).strict()).min(1).max(200);
const remoteEntry = z.object({ ipv4: z.union([fields.ipv4, z.literal('')]).optional(), ipv6: z.union([fields.ipv6, z.literal('')]).optional() }).strict();

export async function register(ctx) {
  ctx.ip = createIpService(ctx);
  ctx.jobs.register('ip.migrate', (job) => ctx.ip.runMigration(job));
  ctx.capabilities.register('iproute2', { binaries: ['ip'], required: ['ip'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const ip = () => ctx.ip;

  // Bound addresses ----------------------------------------------------------
  r.get('/addresses', requireRoot, validate({ query: z.object({ family: z.enum(['4', '6']).optional(), live: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
    wrap((req) => ip().listAddresses({ family: req.query.family, live: req.query.live !== false })));
  r.get('/interfaces', requireRoot, wrap(() => ip().interfaces()));
  r.post('/addresses', requireRoot, validate({ body: z.object({
    address: fields.ip, endAddress: fields.ip.optional(), netmask: netmask.optional(), prefix: prefix.optional(), interface: iface.optional(),
    reserved: z.boolean().optional(), reservedReason: z.string().trim().max(200).optional(),
  }).strict() }), wrap((req) => ip().addAddress(req.body, req.user, req), 201));
  r.delete('/addresses/:address', requireRoot, validate({ params: addressParam }), wrap((req) => ip().deleteAddress(req.params.address, req.user, req)));

  // Usage ---------------------------------------------------------------------
  r.get('/usage', requireReseller, wrap((req) => ip().usage(req.user)));

  // Reserved ------------------------------------------------------------------
  r.get('/reserved', requireRoot, wrap(() => ip().listReserved()));
  r.put('/reserved/:address', requireRoot, validate({ params: addressParam, body: z.object({ reserved: z.boolean(), reason }).strict() }),
    wrap((req) => ip().setReserved(req.params.address, req.body, req.user, req)));
  r.put('/reserved', requireRoot, validate({ body: z.object({ items: z.array(z.object({ address: fields.ip, reserved: z.boolean(), reason }).strict()).min(1).max(1000) }).strict() }),
    wrap((req) => ip().setReservedBulk(req.body.items, req.user, req)));

  // Pool ----------------------------------------------------------------------
  r.get('/pool', requireRoot, wrap(() => ip().getPool()));
  r.post('/pool/rebuild', requireRoot, wrap((req) => ip().rebuildPool(req.user, req)));

  // IPv6 ranges ---------------------------------------------------------------
  const rangeBody = z.object({ name: rangeName, range: cidr6, interface: iface.nullable().optional(), enabled: z.boolean().optional(), notes: z.string().trim().max(500).nullable().optional() });
  r.get('/ipv6/ranges', requireRoot, wrap(() => ip().listRanges()));
  r.post('/ipv6/ranges', requireRoot, validate({ body: rangeBody.strict() }), wrap((req) => ip().createRange(req.body, req.user, req), 201));
  r.get('/ipv6/ranges/:id', requireRoot, validate({ params: idParam }), wrap((req) => ip().getRange(req.params.id)));
  r.put('/ipv6/ranges/:id', requireRoot, validate({ params: idParam, body: rangeBody.partial().strict() }), wrap((req) => ip().updateRange(req.params.id, req.body, req.user, req)));
  r.delete('/ipv6/ranges/:id', requireRoot, validate({ params: idParam }), wrap((req) => ip().deleteRange(req.params.id, req.user, req)));
  r.put('/ipv6/ranges/:id/accounts', requireRoot, validate({ params: idParam, body: z.object({ accounts: z.array(fields.username).max(5000) }).strict() }),
    wrap((req) => ip().setRangeAccounts(req.params.id, req.body.accounts, req.user, req)));
  r.get('/ipv6/ranges/:id/preview', requireRoot, validate({ params: idParam, query: z.object({ count: z.coerce.number().int().min(1).max(50).default(5) }) }),
    wrap((req) => ip().previewRange(req.params.id, req.query)));

  // IPv6 assignments ----------------------------------------------------------
  r.get('/ipv6/assignments', requireReseller, validate({ query: z.object({ account: fields.username.optional() }) }), wrap((req) => ip().listAssignments(req.user, req.query)));
  r.post('/ipv6/assign', requireReseller, validate({ body: z.object({ account: fields.username, rangeId: fields.id.optional(), address: fields.ipv6.optional() }).strict() }),
    wrap((req) => ip().assignIpv6(req.body.account, req.body, req.user, req), 201));
  r.delete('/ipv6/assignments/:account', requireReseller, validate({ params: z.object({ account: fields.username }) }), wrap((req) => ip().unassignIpv6(req.params.account, req.user, req)));

  // Remote service IPs --------------------------------------------------------
  r.get('/remote-services', requireRoot, wrap(() => ip().getRemoteServiceIps()));
  r.put('/remote-services', requireRoot, validate({ body: z.object(Object.fromEntries(REMOTE_SERVICES.map((s) => [s.key, remoteEntry.optional()]))).strict() }),
    wrap((req) => ip().setRemoteServiceIps(req.body, req.user, req)));

  // Migration wizard ----------------------------------------------------------
  r.post('/migration/preview', requireRoot, validate({ body: z.object({ mappings }).strict() }), wrap((req) => ip().migrationPreview(req.body)));
  r.post('/migration', requireRoot, validate({ body: z.object({
    mappings, dryRun: z.boolean().optional(), updateDns: z.boolean().optional(), updateVhosts: z.boolean().optional(), removeOld: z.boolean().optional(),
    interface: iface.optional(), prefix: prefix.optional(),
  }).strict() }), wrap((req) => ip().startMigration(req.body, req.user), 202));
  r.get('/migration/history', requireRoot, wrap(() => ip().migrationHistory()));

  return { path: '/ip', router: r };
}
