import { Router } from 'express';
import { validate, z } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createMarketService, PROVIDER_NAME_RE } from '../../services/market.js';
import { CREATABLE_ADAPTERS } from '../../services/market-adapters.js';

const name = z.string().trim().regex(PROVIDER_NAME_RE, 'Lowercase letters, digits, "_" or "-"; must start with a letter; max 32 chars');
// ACME rows carry a dot ("acme.sh"), so lookups accept it while creation does not.
const lookupName = z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,31}$/, 'Invalid provider name');
const displayName = z.string().trim().min(1).max(80).regex(/^[^\r\n\0<>]*$/, 'Names are a single line without angle brackets');
const type = z.enum(['ssl', 'plugin']);
const adapter = z.enum(CREATABLE_ADAPTERS);
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
const listQuery = z.object({ type: type.optional() });
const createBody = z.object({ name, displayName, type, adapter, url: url.optional(), commissionPercent: commission.optional(), products: products.optional(), config: config.optional() }).strict();
const updateBody = z.object({ displayName: displayName.optional(), url: url.nullable().optional(), commissionPercent: commission.optional(), products: products.optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field', path: ['displayName'] });
const configureBody = z.object({ url: url.nullable().optional(), config: config.default({}) }).strict();

export async function register(ctx) {
  ctx.market = createMarketService(ctx);
  const s = ctx.market;
  // Make the setting SSL/TLS reads reflect the table from the first boot on.
  s.syncSettings();

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  // Market Provider Manager
  r.get('/adapters', requireRoot, wrap(() => s.adapters()));
  r.get('/providers', requireReseller, validate({ query: listQuery }), wrap((req) => s.list(req.query, req.user)));
  r.post('/providers', requireRoot, validate({ body: createBody }), created((req) => s.create(req.body, req)));
  r.get('/providers/:name', requireReseller, validate({ params: nameParam }), wrap((req) => s.get(req.params.name, req.user)));
  r.put('/providers/:name', requireRoot, validate({ params: nameParam, body: updateBody }), wrap((req) => s.update(req.params.name, req.body, req)));
  r.put('/providers/:name/config', requireRoot, validate({ params: nameParam, body: configureBody }), wrap((req) => s.configure(req.params.name, req.body, req)));
  r.post('/providers/:name/enable', requireRoot, validate({ params: nameParam }), wrap((req) => s.setEnabled(req.params.name, true, req)));
  r.post('/providers/:name/disable', requireRoot, validate({ params: nameParam }), wrap((req) => s.setEnabled(req.params.name, false, req)));
  r.post('/providers/:name/test', requireRoot, validate({ params: nameParam }), wrap((req) => s.test(req.params.name, req)));
  r.post('/providers/:name/products/sync', requireRoot, validate({ params: nameParam }), wrap((req) => s.syncProducts(req.params.name, req)));
  r.delete('/providers/:name', requireRoot, validate({ params: nameParam }), wrap((req) => s.remove(req.params.name, req)));

  return { path: '/market', router: r };
}
