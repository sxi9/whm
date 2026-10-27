import { Router } from 'express';
import { validate, z, fields } from '../lib/validate.js';
import { requireRoot } from '../middleware/rbac.js';

const keyField = z.string().trim().min(16).max(40).regex(/^[A-Za-z0-9 -]+$/, 'A license key looks like WHM-XXXX-XXXX-XXXX-XXXX');
const activationId = z.string().regex(/^[A-Za-z0-9_-]{3,64}$/);

// Root only; mounted before the license gate so every route here stays
// reachable while the panel is degraded (that is how it gets out of it).
export function licenseRoutes(ctx) {
  const r = Router();
  const license = () => ctx.license;
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => data !== undefined && res.status(status).json(data?.meta ? data : { data })).catch(next);

  r.get('/', requireRoot, wrap(() => ({ ...license().get(), events: license().events(30), pinnedKeys: license().keys() })));
  r.get('/activations', requireRoot, wrap(() => license().activations()));
  r.get('/events', requireRoot, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }) }), wrap((req) => license().events(req.query.limit)));

  r.post('/key', requireRoot, validate({ body: z.object({ key: keyField.optional(), transferFrom: activationId.optional() }).strict() }), wrap(async (req) => {
    const out = await license().activate(req.body.key, req.user, req, { transferFrom: req.body.transferFrom ?? null });
    req.audit({ action: 'license.key', target: out.keyPrefix, args: { transferFrom: req.body.transferFrom ?? null, replaced: Boolean(req.body.key) } });
    return out;
  }));

  r.post('/checkin', requireRoot, wrap(async (req) => {
    const out = await license().checkin({ force: true }, { req });
    req.audit({ action: 'license.checkin', target: out.status ?? null, args: { ok: out.ok, code: out.code ?? null }, result: out.ok ? 'ok' : `error:${out.code}` });
    return out;
  }));

  r.post('/deactivate', requireRoot, validate({ body: z.object({ reason: z.string().trim().max(500).optional() }).strict() }), wrap(async (req) => {
    const out = await license().deactivate(req.body.reason, req.user, req);
    req.audit({ action: 'license.deactivate', args: { reason: req.body.reason ?? null } });
    return out;
  }));

  r.post('/trial', requireRoot, validate({ body: z.object({ email: fields.email }).strict() }), wrap(async (req) => {
    const out = await license().startTrial(req.body.email, req.user, req);
    req.audit({ action: 'license.trial', target: out.keyPrefix, args: { email: req.body.email } });
    return out;
  }, 201));

  return r;
}
