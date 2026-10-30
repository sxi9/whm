import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller, requireScope } from '../../middleware/rbac.js';
import { createDevelopmentService, wireCoreEvents, EVENT_NAME_RE, HOOK_SCRIPT_RE, ENFORCED_SCOPES, APP_NAME_RE, ACL_RE } from '../../services/development.js';

const idParam = z.object({ id: fields.id });
const label = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()\/-]{0,63}$/, 'Letters, digits, spaces, "." "_" "-" "(" ")" or "/"; max 64 chars');
const shortText = z.string().max(300).regex(/^[^\0]*$/).nullable();
const scope = z.enum(ENFORCED_SCOPES, { errorMap: () => ({ message: `Only enforced scopes can be granted: ${ENFORCED_SCOPES.join(', ')}` }) });
const eventName = z.string().regex(EVENT_NAME_RE, 'Event names look like account.created');
const stage = z.enum(['pre', 'post']);
const scriptName = z.string().regex(HOOK_SCRIPT_RE, 'Lowercase letters, digits, ".", "_" or "-"; max 64 chars');
const appName = z.string().regex(APP_NAME_RE, 'Lowercase identifier such as my_billing_app');
const acl = z.string().regex(ACL_RE, 'ACL keys are lowercase words such as list-accts or all');
const appUrl = z.string().max(2048).refine((u) => /^https?:\/\/[^\s]+$/i.test(u) || /^\/[A-Za-z0-9._~\/-]*(\?[^\s#]*)?$/.test(u), 'An http(s) URL or an absolute path on this panel');
const service = z.enum(['whm', 'cpanel', 'webmail']);
const docSlug = z.string().regex(/^[a-z0-9-]{1,60}$/);
const specScope = z.enum(['whm', 'cpanel']).default('whm');
const payload = z.record(z.string().max(64), z.any()).refine((p) => JSON.stringify(p).length <= 64 * 1024, 'Payload too large (64 KB max)');

const tokenBody = z.object({
  name: label, description: shortText.optional(), scopes: z.array(scope).max(50).default([]),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(), expiresAt: z.string().datetime({ offset: true }).optional(), username: fields.username.optional(),
}).strict().refine((b) => !(b.expiresInDays && b.expiresAt), { message: 'Give either expiresInDays or expiresAt', path: ['expiresAt'] });

const hookBody = z.object({
  name: label.optional(), description: shortText.optional(), event: eventName, stage: stage.default('post'), script: scriptName, enabled: z.boolean().optional(),
  blocking: z.boolean().optional(), timeoutSec: z.number().int().min(1).max(600).optional(), position: z.number().int().min(0).max(10000).optional(),
}).strict();

const appBody = z.object({
  name: appName, displayName: label.optional(), url: appUrl, entryUrl: appUrl.nullable().optional(), service: service.default('whm'), description: shortText.optional(), icon: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/).nullable().optional(),
  acls: z.array(acl).max(50).optional(), features: z.array(acl).max(50).optional(), display: z.boolean().optional(), enabled: z.boolean().optional(), phpopts: z.record(z.string().regex(/^[A-Za-z_]{1,40}$/), z.string().max(200)).optional(),
}).strict();

const pluginBody = z.object({
  id: z.string().max(128).regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/, 'Reverse-DNS id with at least three segments, e.g. com.example.hello'),
  name: z.string().trim().min(1).max(80), version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'Semantic version such as 1.0.0').default('1.0.0'),
  description: z.string().trim().min(1).max(500), authorName: z.string().trim().min(1).max(80), authorEmail: z.string().email().max(254).optional(), authorUrl: z.string().url().max(512).optional(),
  homepage: z.string().url().max(512).optional(), license: z.string().regex(/^[A-Za-z0-9.+-]{1,40}$/).default('MIT'), category: z.string().max(40).optional(),
  permissions: z.array(z.string().max(120).regex(/^[a-z][a-z0-9:*._-]*$/)).max(40).default([]),
  hooks: z.array(z.object({ event: eventName, stage: stage.default('post') }).strict()).max(40).default([]),
  withSettings: z.boolean().default(false), withJob: z.boolean().default(false), withPage: z.boolean().default(true),
  isolation: z.enum(['in-process', 'process']).optional(), keywords: z.array(z.string().min(1).max(32)).max(10).optional(),
}).strict();

export async function register(ctx) {
  ctx.development = createDevelopmentService(ctx);
  const s = ctx.development;
  ctx.events.onAny((envelope) => s.hooks.dispatch(envelope));
  wireCoreEvents(ctx);
  for (const [type, handler] of Object.entries(s.jobs)) ctx.jobs.register(type, handler);
  ctx.scheduler.ensure('development-maintenance', '23 3 * * *', 'development.maintenance');
  // Fired once the router is mounted so hooks on panel.started see a live panel.
  setTimeout(() => { ctx.events.emit('panel.started', { hostVersion: ctx.version, bootedAt: new Date().toISOString() }).catch(() => {}); }, 2000).unref();

  const read = requireScope('development:read');
  const write = requireScope('development:write');
  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  r.get('/overview', requireRoot, read, wrap(() => s.overview()));

  // Manage API Tokens (resellers manage their own; root sees everyone's)
  r.get('/tokens/scopes', requireReseller, read, wrap(() => s.tokens.scopes()));
  r.get('/tokens', requireReseller, read, validate({ query: pagination.extend({ user: fields.username.optional() }) }), wrap((req) => s.tokens.list(req.query, req.user)));
  r.post('/tokens', requireReseller, write, validate({ body: tokenBody }), created((req) => s.tokens.create(req.body, req.user, req)));
  r.get('/tokens/:id', requireReseller, read, validate({ params: idParam }), wrap((req) => s.tokens.get(req.params.id, req.user)));
  r.get('/tokens/:id/usage', requireReseller, read, validate({ params: idParam }), wrap((req) => s.tokens.usage(req.params.id, req.user)));
  r.patch('/tokens/:id', requireReseller, write, validate({ params: idParam, body: z.object({ name: label.optional(), description: shortText.optional() }).strict() }), wrap((req) => s.tokens.update(req.params.id, req.body, req.user, req)));
  r.post('/tokens/:id/expire', requireReseller, write, validate({ params: idParam }), wrap((req) => s.tokens.expireNow(req.params.id, req.user, req)));
  r.delete('/tokens/:id', requireReseller, write, validate({ params: idParam }), wrap((req) => s.tokens.revoke(req.params.id, req.user, req)));

  // Manage Hooks
  r.get('/hooks/events', requireRoot, read, wrap(() => s.hooks.events()));
  r.get('/hooks/settings', requireRoot, read, wrap(() => s.hooks.settings()));
  r.put('/hooks/settings', requireRoot, write, validate({ body: z.object({ enabled: z.boolean().optional(), defaultTimeoutSec: z.number().int().min(1).max(600).optional(), keepRuns: z.number().int().min(10).max(100000).optional() }).strict() }), wrap((req) => s.hooks.updateSettings(req.body, req)));
  r.get('/hooks/runs', requireRoot, read, validate({ query: pagination.extend({ hookId: fields.id.optional(), event: eventName.optional(), status: z.enum(['ok', 'failed', 'error', 'skipped']).optional() }) }), wrap((req) => s.hooks.runs(req.query)));
  r.get('/hooks/recent-events', requireRoot, read, wrap(() => s.hooks.recentEvents()));
  r.post('/hooks/emit', requireRoot, write, validate({ body: z.object({ event: eventName, stage: stage.default('post'), payload: payload.default({}) }).strict() }), wrap((req) => s.hooks.emit(req.body.event, req.body.stage, req.body.payload, req)));
  r.get('/hooks/scripts', requireRoot, read, wrap(() => s.hooks.scripts.list()));
  r.post('/hooks/scripts/init', requireRoot, write, wrap((req) => s.hooks.scripts.init(req)));
  r.get('/hooks/scripts/:name', requireRoot, read, validate({ params: z.object({ name: scriptName }) }), wrap((req) => s.hooks.scripts.read(req.params.name)));
  r.put('/hooks/scripts/:name', requireRoot, write, validate({ params: z.object({ name: scriptName }), body: z.object({ content: z.string().min(3).max(256 * 1024) }).strict() }), wrap((req) => s.hooks.scripts.write(req.params.name, req.body.content, req)));
  r.delete('/hooks/scripts/:name', requireRoot, write, validate({ params: z.object({ name: scriptName }) }), wrap((req) => s.hooks.scripts.remove(req.params.name, req)));
  r.get('/hooks', requireRoot, read, wrap(() => s.hooks.list()));
  r.post('/hooks', requireRoot, write, validate({ body: hookBody }), created((req) => s.hooks.create(req.body, req)));
  r.get('/hooks/:id', requireRoot, read, validate({ params: idParam }), wrap((req) => s.hooks.get(req.params.id)));
  r.put('/hooks/:id', requireRoot, write, validate({ params: idParam, body: hookBody.partial() }), wrap((req) => s.hooks.update(req.params.id, req.body, req)));
  r.patch('/hooks/:id', requireRoot, write, validate({ params: idParam, body: z.object({ enabled: z.boolean() }).strict() }), wrap((req) => s.hooks.setEnabled(req.params.id, req.body.enabled, req)));
  r.post('/hooks/:id/test', requireRoot, write, validate({ params: idParam, body: z.object({ payload: payload.optional() }).strict() }), wrap((req) => s.hooks.test(req.params.id, req.body.payload, req)));
  r.delete('/hooks/:id', requireRoot, write, validate({ params: idParam }), wrap((req) => s.hooks.remove(req.params.id, req)));

  // Apps Managed by AppConfig
  r.get('/appconfig/acls', requireRoot, read, wrap(() => s.appconfig.acls()));
  r.get('/appconfig/launch', requireReseller, read, validate({ query: z.object({ service: service.optional() }) }), wrap((req) => s.appconfig.listFor(req.user, req.query.service)));
  r.post('/appconfig/parse', requireRoot, read, validate({ body: z.object({ text: z.string().max(64 * 1024) }).strict() }), wrap((req) => s.appconfig.parse(req.body.text)));
  r.get('/appconfig', requireRoot, read, wrap(() => s.appconfig.list()));
  r.post('/appconfig', requireRoot, write, validate({ body: appBody }), created((req) => s.appconfig.create(req.body, req)));
  r.get('/appconfig/:id', requireRoot, read, validate({ params: idParam }), wrap((req) => s.appconfig.get(req.params.id)));
  r.get('/appconfig/:id/export', requireRoot, read, validate({ params: idParam }), wrap((req) => s.appconfig.export(req.params.id)));
  r.put('/appconfig/:id', requireRoot, write, validate({ params: idParam, body: appBody.partial() }), wrap((req) => s.appconfig.update(req.params.id, req.body, req)));
  r.delete('/appconfig/:id', requireRoot, write, validate({ params: idParam }), wrap((req) => s.appconfig.remove(req.params.id, req)));

  // cPanel Plugin File Generator
  r.get('/plugin-generator/vocabulary', requireRoot, read, wrap(() => s.pluginGen.vocabulary()));
  r.post('/plugin-generator/preview', requireRoot, read, validate({ body: pluginBody }), wrap((req) => s.pluginGen.preview(req.body)));
  r.post('/plugin-generator/generate', requireRoot, write, validate({ body: pluginBody }), wrap((req) => s.pluginGen.generate(req.body, req)));
  r.post('/plugin-generator/validate', requireRoot, read, validate({ body: z.object({ manifest: z.record(z.any()) }).strict() }), wrap((req) => s.pluginGen.validate(req.body.manifest)));

  // OpenAPI Documentation for WHM / cPanel
  r.get('/openapi.json', requireReseller, read, validate({ query: z.object({ scope: specScope }) }), wrap((req) => s.openapi.spec(req.query.scope)));
  r.get('/openapi/endpoints', requireReseller, read, validate({ query: z.object({ scope: specScope }) }), wrap((req) => s.openapi.endpoints(req.query.scope)));

  // Developer Documentation / cPanel Development Forum
  r.get('/docs', requireReseller, read, wrap((req) => s.docs.list(req.user)));
  r.get('/docs/:slug', requireReseller, read, validate({ params: z.object({ slug: docSlug }), query: z.object({ section: docSlug.optional() }) }), wrap((req) => s.docs.get(req.params.slug, req.query.section, req.user)));

  return { path: '/development', router: r };
}
