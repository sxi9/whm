import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireScope } from '../../middleware/rbac.js';
import { HttpError } from '../../lib/errors.js';
import { createPanelDatabasesService, DB_NAME, DB_USER_NAME, ACCESS_HOST, ALL_PRIVILEGES } from '../../services/panel-databases.js';

// /api/panel/databases — mounted by routes/categories/panel.js behind
// requireRole('user','root','reseller') + panelScope (design §3.1). Each
// handler takes the pinned account from req.panel (set by that middleware) or
// asks ctx.panel.scope(req) itself, and never a username from the client.

const dbName = z.string().regex(DB_NAME, 'Lowercase letters, digits or "_"; max 54 chars');
const fullDbName = fields.dbName;
const userName = z.string().regex(DB_USER_NAME, 'Lowercase letters, digits or "_"; max 22 chars');
const fullUserName = z.string().regex(/^[a-z0-9_]{1,32}$/);
const charset = z.string().regex(/^[a-z0-9_]{1,32}$/).optional();
const createDbBody = z.object({ name: dbName, charset, collation: z.string().regex(/^[a-z0-9_]{1,64}$/).optional() }).strict();
const checkBody = z.object({ action: z.enum(['check', 'repair', 'optimize']).default('check') }).strict();
const createUserBody = z.object({ name: userName, password: fields.password, databases: z.array(fullDbName).max(100).optional() }).strict();
const passwordBody = z.object({ password: fields.password }).strict();
const grantsBody = z.object({ grants: z.array(z.object({ database: fullDbName, privileges: z.array(z.enum(ALL_PRIVILEGES)).min(1).max(ALL_PRIVILEGES.length) }).strict()).max(100) }).strict();
const hostBody = z.object({ host: z.string().trim().regex(ACCESS_HOST, 'Host name, IP or wildcard pattern') }).strict();
const nameParam = z.object({ name: fullDbName });
const userParam = z.object({ name: fullUserName });
const idParam = z.object({ id: fields.id });

async function scopeOf(ctx, req) {
  if (req.panel) return req.panel;
  if (typeof ctx.panel?.scope !== 'function') throw new HttpError(403, 'panel_scope_required', 'This endpoint needs a customer panel session');
  return ctx.panel.scope(req);
}

export function register(ctx) {
  ctx.panelDatabases = createPanelDatabasesService(ctx);
  ctx.jobs.register('panel.db.dump', (job) => ctx.panelDatabases.runDump(job));
  ctx.panelDatabases.registerSso();
  const svc = () => ctx.panelDatabases;
  // A sign-on link is a browser hand-off: never minted for an API token.
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'phpMyAdmin single sign-on is only available from a browser session')) : next());

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(scopeOf(ctx, req).then((scope) => fn(scope, req, res))).then((d) => { if (!res.headersSent) res.status(status).json(d?.meta ? d : { data: d }); }).catch(next);
  r.use(requireScope('panel:databases'));

  r.get('/', wrap((scope) => svc().list(scope)));
  r.post('/', validate({ body: createDbBody }), wrap((scope, req) => svc().create(scope, req.body, req), 201));
  r.get('/users', wrap((scope) => svc().listUsers(scope)));
  r.post('/users', validate({ body: createUserBody }), wrap((scope, req) => svc().createUser(scope, req.body, req), 201));
  r.put('/users/:name/password', validate({ params: userParam, body: passwordBody }), wrap((scope, req) => svc().setUserPassword(scope, req.params.name, req.body.password, req)));
  r.delete('/users/:name', validate({ params: userParam }), wrap((scope, req) => svc().dropUser(scope, req.params.name, req)));
  r.get('/users/:name/grants', validate({ params: userParam }), wrap((scope, req) => svc().grantsFor(scope, req.params.name)));
  r.put('/users/:name/grants', validate({ params: userParam, body: grantsBody }), wrap((scope, req) => svc().setGrants(scope, req.params.name, req.body.grants, req)));
  r.get('/access-hosts', wrap((scope) => svc().listAccessHosts(scope)));
  r.post('/access-hosts', validate({ body: hostBody }), wrap((scope, req) => svc().addAccessHost(scope, req.body.host, req), 201));
  r.delete('/access-hosts/:id', validate({ params: idParam }), wrap((scope, req) => svc().removeAccessHost(scope, req.params.id, req)));
  r.get('/phpmyadmin', wrap((scope) => svc().phpMyAdmin(scope)));
  r.post('/phpmyadmin/sso', sessionOnly, validate({ body: z.object({}).strict() }), wrap((scope, req) => svc().phpMyAdminSso(scope, req)));
  // The account's check/repair/optimize and dump jobs (/api/system/jobs is
  // reseller-only). The stream writes SSE itself, so it stays outside wrap().
  r.get('/jobs/:id', validate({ params: idParam }), wrap((scope, req) => svc().getJob(scope, req.params.id)));
  r.get('/jobs/:id/stream', validate({ params: idParam }), (req, res, next) => {
    scopeOf(ctx, req).then((scope) => svc().streamJob(scope, req.params.id, req, res)).catch(next);
  });
  r.delete('/:name', validate({ params: nameParam }), wrap((scope, req) => svc().drop(scope, req.params.name, req)));
  r.post('/:name/check', validate({ params: nameParam, body: checkBody }), wrap((scope, req) => svc().check(scope, req.params.name, req.body.action, req), 202));
  r.post('/:name/dump', validate({ params: nameParam, body: z.object({}).strict() }), wrap((scope, req) => svc().enqueueDump(scope, req.params.name, req), 202));

  return { path: '/databases', router: r };
}
