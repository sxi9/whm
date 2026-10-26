import { Router } from 'express';
import { validate, z, fields, pagination } from '../lib/validate.js';
import { requireRoot, requireReseller } from '../middleware/rbac.js';

const nameParam = z.object({ username: fields.username });

export function accountRoutes({ accounts }) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => res.json(data?.meta ? data : { data })).catch(next);

  r.get('/', requireReseller, validate({ query: pagination.extend({ suspended: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), package: fields.packageName.optional(), owner: fields.username.optional() }) }),
    wrap((req) => accounts.list(req.query, req.user)));

  r.post('/', requireReseller, validate({
    body: z.object({
      username: fields.username,
      domain: fields.domain,
      password: fields.password.optional(),
      package: fields.packageName.optional(),
      contactEmail: fields.email.optional(),
      ip: fields.ip.optional(),
      owner: fields.username.optional(),
      // Which subsystems to provision besides the Linux user. All three are on by default (WHM creates the zone and routes mail locally); pass false to opt out.
      provision: z.object({ web: z.boolean().optional(), dns: z.boolean().optional(), mail: z.boolean().optional() }).strict().optional(),
    }).strict(),
  }), (req, res, next) => accounts.create(req.body, req.user, req).then((data) => res.status(201).json({ data })).catch(next));

  r.get('/:username', requireReseller, validate({ params: nameParam }), wrap((req) => accounts.get(req.params.username, req.user)));
  r.get('/:username/domains', requireReseller, validate({ params: nameParam }), wrap((req) => accounts.domains(req.params.username, req.user)));

  r.patch('/:username', requireReseller, validate({
    params: nameParam,
    body: z.object({
      contactEmail: fields.email.nullable().optional(),
      package: fields.packageName.optional(),
      ip: fields.ip.nullable().optional(),
      shell: fields.shell.optional(),
      diskQuotaMb: z.number().int().min(0).nullable().optional(),
      bandwidthLimitMb: z.number().int().min(0).nullable().optional(),
      demoMode: z.boolean().optional(),
      forcePasswordChange: z.boolean().optional(),
      owner: fields.username.optional(),
    }).strict(),
  }), wrap((req) => accounts.modify(req.params.username, req.body, req.user, req)));

  r.post('/:username/suspend', requireReseller, validate({ params: nameParam, body: z.object({ reason: z.string().max(500).optional() }).strict() }),
    wrap((req) => accounts.suspend(req.params.username, req.body.reason, req.user, req)));
  r.post('/:username/unsuspend', requireReseller, validate({ params: nameParam }), wrap((req) => accounts.unsuspend(req.params.username, req.user, req)));
  r.post('/:username/password', requireReseller, validate({ params: nameParam, body: z.object({ password: fields.password }).strict() }),
    wrap((req) => accounts.setPassword(req.params.username, req.body.password, req.user, req)));
  r.delete('/:username', requireReseller, validate({ params: nameParam, query: z.object({ keepDns: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
    wrap((req) => accounts.terminate(req.params.username, req.query, req.user, req)));

  return r;
}

export function packageRoutes({ packages }) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => res.json(data?.meta ? data : { data })).catch(next);
  const limits = {
    disk_mb: z.number().int().min(0).nullable().optional(), bandwidth_mb: z.number().int().min(0).nullable().optional(),
    max_domains: z.number().int().min(0).nullable().optional(), max_subdomains: z.number().int().min(0).nullable().optional(),
    max_addons: z.number().int().min(0).nullable().optional(), max_parked: z.number().int().min(0).nullable().optional(),
    max_db: z.number().int().min(0).nullable().optional(), max_email: z.number().int().min(0).nullable().optional(),
    max_ftp: z.number().int().min(0).nullable().optional(), max_email_per_hour: z.number().int().min(0).nullable().optional(),
    quota_inodes: z.number().int().min(0).nullable().optional(), php_version: z.string().regex(/^[a-z0-9.-]{1,20}$/).nullable().optional(),
    feature_list: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), has_shell: z.boolean().optional(), has_dedicated_ip: z.boolean().optional(),
    cgi: z.boolean().optional(), digest_auth: z.boolean().optional(), theme: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
  };
  const nameParam = z.object({ name: fields.packageName });

  r.get('/', requireReseller, validate({ query: pagination }), wrap((req) => packages.list(req.query, req.user)));
  r.post('/', requireReseller, validate({ body: z.object({ name: fields.packageName, ...limits }).strict() }), (req, res, next) => Promise.resolve(packages.create(req.body, req.user)).then((data) => res.status(201).json({ data })).catch(next));
  r.get('/feature-lists', requireReseller, wrap(() => packages.featureLists.list()));
  r.post('/feature-lists', requireRoot, validate({ body: z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), features: z.record(z.boolean()) }).strict() }), wrap((req) => packages.featureLists.create(req.body.name, req.body.features)));
  r.get('/feature-lists/:name', requireReseller, validate({ params: z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }) }), wrap((req) => packages.featureLists.get(req.params.name)));
  r.put('/feature-lists/:name', requireRoot, validate({ params: z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }), body: z.object({ features: z.record(z.boolean()) }).strict() }), wrap((req) => packages.featureLists.update(req.params.name, req.body.features)));
  r.delete('/feature-lists/:name', requireRoot, validate({ params: z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }) }), wrap((req) => { packages.featureLists.remove(req.params.name); return { deleted: true }; }));
  r.get('/:name', requireReseller, validate({ params: nameParam }), wrap((req) => packages.get(req.params.name, req.user)));
  r.put('/:name', requireReseller, validate({ params: nameParam, body: z.object({ newName: fields.packageName.optional(), ...limits }).strict() }), wrap((req) => packages.update(req.params.name, req.body, req.user)));
  r.delete('/:name', requireReseller, validate({ params: nameParam }), wrap((req) => { packages.remove(req.params.name, req.user); return { deleted: true }; }));

  return r;
}
