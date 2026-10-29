import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createApplicationManagerService, schemas, createSchema, updateSchema, templateSchema, policySchema } from '../../services/application-manager.js';

const idParam = z.object({ id: fields.id });
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export async function register(ctx) {
  ctx.apps = createApplicationManagerService(ctx);
  const s = ctx.apps;
  for (const [type, handler] of Object.entries(s.jobs)) ctx.jobs.register(type, handler);
  ctx.capabilities.register('node', { binaries: ['node', 'nodejs'], required: ['node', 'nodejs'] });
  ctx.capabilities.register('python', { binaries: ['python3'], required: ['python3'] });
  ctx.capabilities.register('git', { binaries: ['git'], required: ['git'] });
  ctx.capabilities.register('acl', { binaries: ['setfacl'], required: ['setfacl'] });

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);
  const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(202).json({ data: d })).catch(next);
  // The audit middleware records req.body when the response finishes and env
  // values are secrets under arbitrary names, so the real map leaves the body
  // before the handler runs and only the key names are kept for the record.
  const takeEnv = (req) => {
    const env = req.body.env;
    if (env) req.body.env = Object.fromEntries(Object.keys(env).map((k) => [k, '[redacted]']));
    return env;
  };

  // Application Manager
  r.get('/', requireReseller, validate({ query: pagination.extend({ account: fields.username.optional(), kind: schemas.kind.optional(), status: schemas.status.optional() }) }), wrap((req) => s.list(req.query, req.user)));
  r.post('/', requireReseller, validate({ body: createSchema }), accepted((req) => s.create({ ...req.body, env: takeEnv(req) }, req.user, req)));
  r.get('/presets', requireReseller, wrap(() => s.presets()));
  r.post('/inspect', requireReseller, validate({ body: z.object({ username: fields.username, root: fields.absPath.max(512) }).strict() }), wrap((req) => s.inspect(req.body, req.user)));
  r.get('/accounts/:username/domains', requireReseller, validate({ params: z.object({ username: fields.username }) }), wrap((req) => s.domainsFor(req.params.username, req.user)));

  // Runtime Versions
  r.get('/runtimes', requireReseller, wrap(() => s.runtimes.list()));
  r.get('/runtimes/node/available', requireRoot, wrap(() => s.runtimes.available()));
  r.post('/runtimes/node/install', requireRoot, validate({ body: z.object({ version: schemas.nodeVersion }).strict() }), accepted((req) => s.runtimes.installNode(req.body.version, req.user, req)));
  r.delete('/runtimes/node/:version', requireRoot, validate({ params: z.object({ version: schemas.nodeVersion }) }), wrap((req) => s.runtimes.removeNode(req.params.version, req.user, req)));
  r.put('/runtimes/defaults', requireRoot, validate({ body: z.object({ node: z.union([z.literal('system'), schemas.nodeVersion]).optional(), python: z.union([z.literal('system'), schemas.pythonVersion]).optional() }).strict() }), wrap((req) => s.runtimes.setDefaults(req.body, req)));
  r.get('/settings', requireRoot, wrap(() => s.policy.get()));
  r.put('/settings', requireRoot, validate({ body: policySchema }), wrap((req) => s.policy.update(req.body, req)));

  // Application Templates
  r.get('/templates', requireRoot, wrap(() => s.templates.list()));
  r.post('/templates', requireRoot, validate({ body: templateSchema }), created((req) => s.templates.create(req.body, req.user, req)));
  r.get('/templates/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.templates.get(req.params.id)));
  r.put('/templates/:id', requireRoot, validate({ params: idParam, body: templateSchema.partial() }), wrap((req) => s.templates.update(req.params.id, req.body, req)));
  r.delete('/templates/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.templates.remove(req.params.id, req)));

  // One application
  r.get('/:id', requireReseller, validate({ params: idParam }), wrap((req) => s.get(req.params.id, req.user)));
  r.put('/:id', requireReseller, validate({ params: idParam, body: updateSchema }), wrap((req) => s.update(req.params.id, { ...req.body, env: takeEnv(req) }, req.user, req)));
  r.delete('/:id', requireReseller, validate({ params: idParam, query: z.object({ deleteFiles: boolQuery.default('false') }) }), wrap((req) => s.remove(req.params.id, req.query, req.user, req)));
  r.post('/:id/rebuild', requireReseller, validate({ params: idParam }), accepted((req) => s.rebuild(req.params.id, req.user, req)));
  r.post('/:id/deploy', requireReseller, validate({ params: idParam }), accepted((req) => s.deploy(req.params.id, req.user, req)));
  r.get('/:id/logs', requireReseller, validate({ params: idParam, query: z.object({ lines: z.coerce.number().int().min(1).max(2000).default(200) }) }), wrap((req) => s.logs(req.params.id, req.query, req.user)));
  r.post('/:id/:verb', requireReseller, validate({ params: idParam.extend({ verb: z.enum(['start', 'stop', 'restart']) }) }), wrap((req) => s.control(req.params.id, req.params.verb, req.user, req)));

  return { path: '/apps', router: r };
}
