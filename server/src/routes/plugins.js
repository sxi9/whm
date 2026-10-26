import express, { Router } from 'express';
import { z, validate, fields } from '../lib/validate.js';
import { requireRoot, requireReseller } from '../middleware/rbac.js';
import { HttpError } from '../lib/errors.js';

// Reverse-DNS plugin id (>= 3 segments), so the reserved first segments
// "manage" and "ui" can never collide with a plugin route.
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const ID_MAX = 128;
const pluginId = z.string().max(ID_MAX).regex(ID_RE, 'Reverse-DNS plugin id with at least three segments');
const idParam = z.object({ id: pluginId });
const jobName = z.string().regex(/^[a-z][a-zA-Z0-9_-]*$/).max(64);
const installBody = z.union([
  z.object({ path: fields.absPath.max(1024) }).strict(),
  z.object({ dir: fields.absPath.max(1024), source: z.enum(['bundled', 'path']).optional() }).strict(),
]);

export function pluginRoutes(ctx) {
  const r = Router();
  const host = () => ctx.plugins;
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const status = (code, fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(code).json({ data: d })).catch(next);

  r.get('/manage', requireRoot, wrap(() => host().list()));
  r.post('/manage/install', requireRoot, express.raw({ type: ['application/gzip', 'application/x-gzip', 'application/octet-stream'], limit: '20mb' }), status(201, (req) => {
    if (Buffer.isBuffer(req.body)) return host().install({ buffer: req.body }, { user: req.user, req });
    const parsed = installBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(422, 'validation_failed', 'Send a .whmplugin body (application/gzip) or JSON { path } / { dir }', { body: parsed.error.issues.map((i) => i.message) });
    return host().install(parsed.data, { user: req.user, req });
  }));
  r.get('/manage/:id', requireRoot, validate({ params: idParam }), wrap((req) => host().detail(req.params.id)));
  r.post('/manage/:id/enable', requireRoot, validate({ params: idParam }), wrap((req) => host().enable(req.params.id, { req })));
  r.post('/manage/:id/disable', requireRoot, validate({ params: idParam }), wrap((req) => host().disable(req.params.id, { req })));
  r.delete('/manage/:id', requireRoot, validate({ params: idParam, query: z.object({ purge: z.enum(['true', 'false']).default('false') }) }), wrap((req) => host().uninstall(req.params.id, { purge: req.query.purge === 'true', req })));
  r.get('/manage/:id/settings', requireRoot, validate({ params: idParam }), wrap((req) => host().settings(req.params.id)));
  r.put('/manage/:id/settings', requireRoot, validate({ params: idParam, body: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]*$/), z.unknown()) }), wrap((req) => host().updateSettings(req.params.id, req.body, req)));
  r.get('/manage/:id/logs', requireRoot, validate({ params: idParam, query: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) }) }), wrap((req) => host().logs(req.params.id, req.query.limit)));
  r.post('/manage/:id/jobs/:name', requireRoot, validate({ params: idParam.extend({ name: jobName }), body: z.object({ params: z.record(z.unknown()).default({}) }).default({}) }),
    status(202, (req) => ({ job: host().runJob(req.params.id, req.params.name, req.body.params, req.user, req) })));
  r.post('/manage/:id/restore-token', requireRoot, validate({ params: idParam, body: z.object({ artefactId: z.union([z.string().regex(/^\d{1,12}$/), z.number().int().positive()]), account: fields.username }).strict() }),
    wrap((req) => host().issueRestoreToken(req.params.id, String(req.body.artefactId), req.body.account, req.user)));
  r.get('/ui', requireReseller, wrap(() => host().uiCatalog()));
  r.get('/ui/:id/file', requireReseller, validate({ params: idParam, query: z.object({ path: z.string().max(512).regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./-]+\.(md|html)$/) }) }), wrap((req) => {
    const f = host().pageFile(req.params.id, req.query.path);
    return { kind: f.kind, content: f.content };
  }));

  // Plugin routes: /api/plugins/<id>/... dispatched by the host with its own role check.
  r.use('/:id', (req, res, next) => {
    const id = req.params.id;
    if (!ID_RE.test(id) || id.length > ID_MAX) return next();
    host().dispatch(id, req, res).catch(next);
  });
  return r;
}
