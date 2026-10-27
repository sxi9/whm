import { Router } from 'express';
import { z, validate } from '../lib/validate.js';
import { requireRoot, requireReseller } from '../middleware/rbac.js';

// Reverse-DNS plugin id (>= 3 segments), the SDK's ID_PATTERN.
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const pluginId = z.string().max(128).regex(ID_RE, 'Reverse-DNS plugin id with at least three segments');
const idParam = z.object({ id: pluginId });
const semverField = z.string().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, 'Must be semver');
const scope = z.string().max(160).regex(/^[a-z][a-z0-9:._*-]*$/);
const channel = z.enum(['stable', 'beta']);
const catalogQuery = z.object({
  q: z.string().trim().max(200).optional(), category: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), channel: channel.optional(),
  page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional(), sort: z.enum(['installs', 'rating', 'updated', 'name']).optional(), dir: z.enum(['asc', 'desc']).optional(), featured: z.enum(['true', 'false']).optional(),
});
const installBody = z.object({ pluginId, version: semverField.optional(), channel: channel.optional(), consent: z.object({ permissions: z.array(scope).max(200) }).strict().optional(), allowDowngrade: z.boolean().optional() }).strict();
const consentBody = z.object({ permissions: z.array(scope).max(200) }).strict();
const reviewBody = z.object({ rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).optional(), body: z.string().trim().max(4000).optional() }).strict();
const revocationId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

// Root manages; resellers browse (WHM Marketplace is read-only for them).
export function marketplaceRoutes(ctx) {
  const r = Router();
  const m = () => ctx.marketplace;
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);

  r.get('/status', requireReseller, wrap(() => m().status()));
  r.get('/catalog', requireReseller, validate({ query: catalogQuery }), wrap((req) => m().catalog({ ...req.query, featured: req.query.featured === 'true' ? true : undefined })));
  r.get('/categories', requireReseller, wrap(() => m().categories()));
  r.get('/plugins/:id', requireReseller, validate({ params: idParam }), wrap((req) => m().plugin(req.params.id)));
  r.get('/plugins/:id/versions', requireReseller, validate({ params: idParam }), wrap((req) => m().versions(req.params.id)));
  r.get('/installs', requireRoot, wrap(() => m().installs()));
  r.get('/updates', requireRoot, wrap(() => m().updates()));
  r.post('/updates/check', requireRoot, wrap((req) => m().checkUpdates({ req })));
  r.get('/revocations', requireRoot, validate({ query: z.object({ unacknowledged: z.enum(['true', 'false']).default('false') }) }), wrap((req) => m().revocations({ unacknowledged: req.query.unacknowledged === 'true' })));
  r.post('/revocations/poll', requireRoot, wrap((req) => m().pollRevocations({ req, reason: 'manual' })));
  r.post('/revocations/:id/ack', requireRoot, validate({ params: revocationId }), wrap((req) => m().acknowledgeRevocation(req.params.id, req.user, req)));

  r.post('/install', requireRoot, validate({ body: installBody }), wrap((req) => m().install(req.body, req.user, req), 202));
  r.post('/update/:id', requireRoot, validate({ params: idParam }), wrap((req) => m().update(req.params.id, req.user, req), 202));
  r.post('/consent/:id', requireRoot, validate({ params: idParam, body: consentBody }), wrap((req) => m().consent(req.params.id, req.body.permissions, req.user, req)));
  r.post('/plugins/:id/reviews', requireRoot, validate({ params: idParam, body: reviewBody }), wrap((req) => m().review(req.params.id, req.body, req.user, req), 201));
  r.delete('/:id', requireRoot, validate({ params: idParam, query: z.object({ purge: z.enum(['true', 'false']).default('false') }) }), wrap((req) => m().uninstall(req.params.id, { purge: req.query.purge === 'true' }, req.user, req)));
  return r;
}
