import { Router } from 'express';
import { validate, pagination, z } from '../../lib/validate.js';
import { requireRoot, requireReseller, requireSuperadmin } from '../../middleware/rbac.js';
import { createMarketService, PROVIDER_NAME_RE, HUB_NAME } from '../../services/market.js';
import { ADAPTER_IDS } from '../../services/market-adapters.js';

const name = z.string().trim().regex(PROVIDER_NAME_RE, 'Lowercase letters, digits, "_" or "-"; must start with a letter; max 32 chars');
// ACME rows carry a dot ("acme.sh"), so lookups accept it while creation does not.
const lookupName = z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,31}$/, 'Invalid provider name');
const displayName = z.string().trim().min(1).max(80).regex(/^[^\r\n\0<>]*$/, 'Names are a single line without angle brackets');
const type = z.enum(['ssl', 'plugin']);
// Every adapter id parses; the service tells a reserved one (409/422) from an unknown one.
const adapter = z.enum(ADAPTER_IDS);
const url = z.string().trim().max(512).regex(/^https:\/\/[^\s/$.?#][^\s]*$/i, 'Must be an https:// URL');
const commission = z.coerce.number().min(0).max(100);
const product = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Product ids use letters, digits, ".", "_" or "-"'),
  name: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9 ._()&/-]*$/, 'Product names use letters, digits, spaces and basic punctuation'),
  price: z.coerce.number().min(0).max(1e6).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Three-letter currency code').optional(),
  termMonths: z.coerce.number().int().min(1).max(120).optional(),
  wildcard: z.boolean().optional(),
}).strict();
const products = z.array(product).max(50);
const configValue = z.string().max(2048).nullable();
const config = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), configValue);

const nameParam = z.object({ name: lookupName });
const listQuery = pagination.extend({ type: type.optional() });
const createBody = z.object({ name, displayName, type, adapter, url: url.optional(), commissionPercent: commission.optional(), products: products.optional(), config: config.optional() }).strict();
const updateBody = z.object({ displayName: displayName.optional(), url: url.nullable().optional(), commissionPercent: commission.optional(), products: products.optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field', path: ['displayName'] });
const configureBody = z.object({ url: url.nullable().optional(), config: config.default({}) }).strict();

export async function register(ctx) {
  ctx.market = createMarketService(ctx);
  const s = ctx.market;
  // Make the setting SSL/TLS reads reflect the table from the first boot on.
  s.adoptLegacySetting();
  s.syncSettings();

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);
  // The whm-hub row's URL is the license hub origin: only the panel owner may
  // see, set or probe it (a test answer names the host, and setting a guess
  // would turn hubMismatch into an oracle). Every root user still switches
  // the row on and off.
  const owner = requireSuperadmin(ctx);
  const ownerForHub = (req, res, next) => (req.params.name === HUB_NAME ? owner(req, res, next) : next());
  // The route-level audit row (middleware/audit.js) mirrors req.body when the
  // response finishes, and audit rows are read by every root user: the hub
  // row's URL goes to the service and is replaced on the request first.
  const withoutHubUrl = (fn) => (req) => {
    const body = req.body;
    if (req.params.name === HUB_NAME && body && typeof body === 'object' && body.url != null) req.body = { ...body, url: '[owner-only]' };
    return fn(req, body);
  };

  // Market Provider Manager
  r.get('/adapters', requireRoot, wrap(() => s.adapters()));
  r.get('/providers', requireReseller, validate({ query: listQuery }), wrap((req) => s.list(req.query, req.user)));
  r.post('/providers', requireRoot, validate({ body: createBody }), created((req) => s.create(req.body, req)));
  r.get('/providers/:name', requireReseller, validate({ params: nameParam }), wrap((req) => s.get(req.params.name, req.user)));
  r.put('/providers/:name', requireRoot, validate({ params: nameParam, body: updateBody }), ownerForHub, wrap(withoutHubUrl((req, body) => s.update(req.params.name, body, req))));
  r.put('/providers/:name/config', requireRoot, validate({ params: nameParam, body: configureBody }), ownerForHub, wrap(withoutHubUrl((req, body) => s.configure(req.params.name, body, req))));
  r.post('/providers/:name/enable', requireRoot, validate({ params: nameParam }), wrap((req) => s.setEnabled(req.params.name, true, req)));
  r.post('/providers/:name/disable', requireRoot, validate({ params: nameParam }), wrap((req) => s.setEnabled(req.params.name, false, req)));
  r.post('/providers/:name/test', requireRoot, validate({ params: nameParam }), ownerForHub, wrap((req) => s.test(req.params.name, req)));
  r.post('/providers/:name/products/sync', requireRoot, validate({ params: nameParam }), wrap((req) => s.syncProducts(req.params.name, req)));
  r.delete('/providers/:name', requireRoot, validate({ params: nameParam }), wrap((req) => s.remove(req.params.name, req)));

  return { path: '/market', router: r };
}
