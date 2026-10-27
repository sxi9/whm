import express from 'express';
import { z, validate, fields, pagination, wrap } from '../../shared/validate.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { requireScope, requireStepUp, requireRole, actorOf, scopeAllows, VENDOR_SCOPES, RESELLER_SCOPES, IMPERSONATION_TTL_MS } from '../../shared/auth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, nowIso, paginate, json } from '../../shared/db.js';
import { replay as replayDelivery } from '../../shared/webhooks.js';
import { EDITIONS } from '../services/products.js';

const idParam = z.object({ id: fields.id });
const reasonBody = z.object({ reason: fields.reason }).strict();

// Lifecycle sub-routes shared by the reseller (scoped) and admin (unscoped) tables.
export function licenseLifecycleRoutes(ctx, r, { scope, scopes }) {
  const opts = (req) => ({ actor: actorOf(req), scope: scope(req) });
  r.post('/licenses/:id/renew', requireScope(scopes.renew), validate({ params: idParam, body: z.object({ term_months: fields.termMonths }).strict() }), (req, res) => {
    res.json({ data: ctx.licenses.renew(req.params.id, req.body, opts(req)) });
  });
  r.post('/licenses/:id/change-edition', requireScope(scopes.change), validate({ params: idParam, body: z.object({ sku: fields.sku, prorate: z.boolean().optional(), force: z.boolean().optional() }).strict() }), (req, res) => {
    res.json({ data: ctx.licenses.changeEdition(req.params.id, req.body, opts(req)) });
  });
  r.post('/licenses/:id/suspend', requireScope(scopes.suspend), validate({ params: idParam, body: reasonBody }), (req, res) => {
    res.json({ data: ctx.licenses.suspend(req.params.id, req.body, opts(req)) });
  });
  r.post('/licenses/:id/unsuspend', requireScope(scopes.suspend), validate({ params: idParam, body: z.object({}).strict() }), (req, res) => {
    res.json({ data: ctx.licenses.unsuspend(req.params.id, {}, opts(req)) });
  });
  r.post('/licenses/:id/revoke', requireScope(scopes.revoke), validate({ params: idParam, body: reasonBody }), (req, res) => {
    res.json({ data: ctx.licenses.revoke(req.params.id, req.body, opts(req)) });
  });
  r.post('/licenses/:id/rekey', requireScope(scopes.rekey), validate({ params: idParam, body: reasonBody }), (req, res) => {
    const { license, key } = ctx.licenses.rekey(req.params.id, req.body, opts(req));
    res.json({ data: { license_id: license.id, key, key_prefix: license.key_prefix } });
  });
  r.get('/licenses/:id/activations', requireScope(scopes.activations), validate({ params: idParam }), (req, res) => {
    ctx.licenses.get(req.params.id, scope(req));
    res.json({ data: ctx.activations.listForLicense(req.params.id) });
  });
  r.post('/licenses/:id/activations/:aid/deactivate', requireScope(scopes.deactivate), validate({ params: z.object({ id: fields.id, aid: fields.id }), body: reasonBody }), (req, res) => {
    ctx.licenses.get(req.params.id, scope(req));
    const a = ctx.activations.get(req.params.aid);
    if (a.license_id !== req.params.id) throw notFound('Activation');
    res.json({ data: ctx.activations.deactivate(a.id, { reason: req.body.reason, by: actorLabel(req), ip: req.ip }) });
  });
}

export function customerRoutes(ctx, r, { scope, scopes }) {
  const body = z.object({ name: z.string().trim().min(1).max(200), email: fields.email, company: z.string().max(200).optional(), country: z.string().max(2).optional(), external_ref: z.string().max(200).optional(), reseller_id: fields.id.optional() }).strict();
  r.get('/customers', requireScope(scopes.read), validate({ query: pagination.extend({ status: z.enum(['active', 'suspended', 'closed']).optional() }) }), (req, res) => res.json(ctx.customers.list(req.query, scope(req))));
  r.post('/customers', requireScope(scopes.write), validate({ body }), (req, res) => {
    const c = ctx.customers.create(req.body, scope(req));
    req.audit({ action: 'customer.create', target: c.id, args: { email: c.email } });
    res.status(201).json({ data: c });
  });
  r.get('/customers/:id', requireScope(scopes.read), validate({ params: idParam }), (req, res) => res.json({ data: ctx.customers.get(req.params.id, scope(req)) }));
  r.patch('/customers/:id', requireScope(scopes.write), validate({ params: idParam, body: body.partial().extend({ status: z.enum(['active', 'suspended', 'closed']).optional() }).omit({ email: true, reseller_id: true }) }), (req, res) => {
    res.json({ data: ctx.customers.update(req.params.id, req.body, scope(req)) });
  });
}

export function webhookRoutes(ctx, r, { ownerType, ownerId, scope }) {
  const db = ctx.dbs.license;
  const view = (row) => ({ id: row.id, url: row.url, events: json.parse(row.events_json, []), enabled: !!row.enabled, created_at: row.created_at });
  r.get('/webhooks', requireScope(scope), (req, res) => {
    res.json({ data: db.prepare('SELECT * FROM webhook_endpoints WHERE owner_type = ? AND owner_id = ? ORDER BY created_at').all(ownerType, ownerId(req)).map(view) });
  });
  r.post('/webhooks', requireScope(scope), validate({ body: z.object({ url: fields.url, events: z.array(z.string().regex(/^(\*|[a-z_]+\.[a-z_]+)$/)).min(1).max(50).default(['*']), secret: z.string().min(16).max(128).optional() }).strict() }), (req, res) => {
    const secret = req.body.secret || ctx.crypto.randomToken(32);
    const id = newId('whk', ctx.clock.now());
    db.prepare('INSERT INTO webhook_endpoints (id, owner_type, owner_id, url, secret_enc, events_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(id, ownerType, ownerId(req), req.body.url, ctx.crypto.encrypt(secret), JSON.stringify(req.body.events), nowIso(ctx.clock.now()));
    req.audit({ action: 'webhook.create', target: id, args: { url: req.body.url } });
    res.status(201).json({ data: { ...view(db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id)), secret } });
  });
  r.delete('/webhooks/:id', requireScope(scope), validate({ params: idParam }), (req, res) => {
    const n = db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND owner_type = ? AND owner_id = ?').run(req.params.id, ownerType, ownerId(req)).changes;
    if (!n) throw notFound('Webhook');
    res.json({ data: { deleted: true } });
  });
  r.get('/webhooks/:id/deliveries', requireScope(scope), validate({ params: idParam, query: pagination }), (req, res) => {
    const ep = db.prepare('SELECT id FROM webhook_endpoints WHERE id = ? AND owner_type = ? AND owner_id = ?').get(req.params.id, ownerType, ownerId(req));
    if (!ep) throw notFound('Webhook');
    res.json(paginate(db, { select: 'id, event, attempt, status, next_at, last_code, last_error, created_at, delivered_at', from: 'webhook_deliveries', where: ['endpoint_id = @ep'], params: { ep: ep.id }, sortable: { created_at: 'created_at' }, defaultSort: 'created_at', query: { dir: 'desc', ...req.query } }));
  });
  r.post('/webhooks/:id/deliveries/:did/replay', requireScope(scope), validate({ params: z.object({ id: fields.id, did: z.coerce.number().int().positive() }) }), (req, res) => {
    const row = db.prepare('SELECT d.id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = ? AND e.id = ? AND e.owner_type = ? AND e.owner_id = ?').get(req.params.did, req.params.id, ownerType, ownerId(req));
    if (!row) throw notFound('Delivery');
    replayDelivery(db, { ownerType, id: row.id, now: ctx.clock.now() });
    res.json({ data: { replayed: true } });
  });
  r.post('/webhooks/:id/test', requireScope(scope), validate({ params: idParam }), (req, res) => {
    const ep = db.prepare('SELECT id FROM webhook_endpoints WHERE id = ? AND owner_type = ? AND owner_id = ?').get(req.params.id, ownerType, ownerId(req));
    if (!ep) throw notFound('Webhook');
    const n = ctx.webhooks.enqueue(db, { ownerType, ownerId: ownerId(req), event: 'webhook.test', data: { endpoint_id: ep.id }, now: ctx.clock.now() });
    res.status(202).json({ data: { queued: n } });
  });
}

export function apiKeyRoutes(ctx, r, { ownerType, ownerId, scope, allowedScopes }) {
  const db = ctx.dbs.license;
  const view = (row) => ({ id: row.id, name: row.name, key_prefix: row.key_prefix, scopes: json.parse(row.scopes_json, []), expires_at: row.expires_at, last_used_at: row.last_used_at, created_at: row.created_at, revoked_at: row.revoked_at });
  r.get('/api-keys', requireScope(scope), (req, res) => {
    res.json({ data: db.prepare('SELECT * FROM api_keys WHERE owner_type = ? AND owner_id = ? ORDER BY created_at').all(ownerType, ownerId(req)).map(view) });
  });
  r.post('/api-keys', requireScope(scope), requireStepUp(ctx.config.license.stepup_max_age_s, () => ctx.clock.now()), validate({ body: z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(allowedScopes)).min(1).max(20), expires_in_days: z.number().int().min(1).max(3650).optional() }).strict() }), (req, res) => {
    // A key never grants more than its creator holds; portal roles carry the full list.
    if (req.principal.type === 'api_key') {
      const beyond = req.body.scopes.filter((sc) => !scopeAllows(req.principal.scopes, sc));
      if (beyond.length) throw new HttpError(403, 'insufficient_scope', `Your key cannot grant: ${beyond.join(', ')}`);
    }
    const secret = `whk_${ctx.crypto.randomToken(30)}`;
    const id = newId('key', ctx.clock.now());
    db.prepare('INSERT INTO api_keys (id, owner_type, owner_id, name, key_hash, key_prefix, scopes_json, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerType, ownerId(req), req.body.name, ctx.crypto.hashToken(secret), secret.slice(0, 12), JSON.stringify(req.body.scopes), req.body.expires_in_days ? nowIso(ctx.clock.now() + req.body.expires_in_days * 86_400_000) : null, nowIso(ctx.clock.now()), actorLabel(req));
    req.audit({ action: 'api_key.create', target: id, args: { name: req.body.name, scopes: req.body.scopes } });
    res.status(201).json({ data: { ...view(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)), key: secret } });
  });
  r.delete('/api-keys/:id', requireScope(scope), validate({ params: idParam }), (req, res) => {
    const n = db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_type = ? AND owner_id = ? AND revoked_at IS NULL').run(nowIso(ctx.clock.now()), req.params.id, ownerType, ownerId(req)).changes;
    if (!n) throw notFound('API key');
    req.audit({ action: 'api_key.revoke', target: req.params.id });
    res.json({ data: { revoked: true } });
  });
}

// Bulk-issue results carry clear-text keys: the issuing scope and the creating
// principal are both required (ctx.jobs.get checks the creator).
const jobQuery = z.object({ format: z.enum(['json', 'csv']).default('json') });
function sendJob(ctx, req, res) {
  const job = ctx.jobs.get(req.params.id, req.principal);
  if (req.query.format === 'csv' && job.status === 'done' && Array.isArray(job.result?.licenses)) {
    res.type('text/csv').send(ctx.reports.csv(job.result.licenses));
    return;
  }
  res.json({ data: job });
}
export const JOB_SCOPES = { vendor: 'admin:write', reseller: 'license:issue' };
export function jobRoutes(ctx, r, { scope }) {
  r.get('/jobs/:id', requireScope(scope), validate({ params: idParam, query: jobQuery }), (req, res) => sendJob(ctx, req, res));
}
// GET /v1/jobs/:id (§16.6) resolves the scope from the principal's owner type.
export function jobAliasRoutes(ctx) {
  const r = express.Router();
  r.get('/:id', (req, _res, next) => {
    if (!req.principal) return next(new HttpError(401, 'unauthorized', 'Authentication required'));
    const scope = JOB_SCOPES[req.principal.ownerType];
    if (!scope) return next(new HttpError(403, 'wrong_owner_type', 'Unknown principal type'));
    const limiter = ctx.app.limiters[req.principal.ownerType === 'vendor' ? 'admin' : 'reseller'];
    limiter(req, _res, (err) => (err ? next(err) : requireScope(scope)(req, _res, next)));
  }, validate({ params: idParam, query: jobQuery }), (req, res) => sendJob(ctx, req, res));
  return r;
}

export function actorLabel(req) {
  const p = req.principal;
  if (!p) return 'anonymous';
  return p.type === 'api_key' ? `apikey:${p.keyId}` : `portal:${p.userId}`;
}

export function adminRoutes(ctx) {
  const r = express.Router();
  const db = ctx.dbs.license;
  const stepUp = requireStepUp(ctx.config.license.stepup_max_age_s, () => ctx.clock.now());
  r.use(ctx.app.limiters.admin, (req, _res, next) => {
    if (!req.principal) return next(new HttpError(401, 'unauthorized', 'Authentication required'));
    if (req.principal.ownerType !== 'vendor') return next(new HttpError(403, 'wrong_owner_type', 'This API is for vendor principals'));
    next();
  });
  const read = requireScope('admin:read');
  const write = requireScope('admin:write');
  const unscoped = () => null;
  const opts = (req) => ({ actor: actorOf(req) });

  const productBody = z.object({
    sku: fields.sku, name: z.string().trim().min(1).max(100), edition: z.enum(EDITIONS), rank: z.number().int().min(0).max(1000), term: z.enum(['days', 'monthly', 'annual', 'contract']), term_days: z.number().int().min(1).max(3650).nullable().optional(),
    limits: z.record(z.number().int()).optional(), features: z.record(z.boolean()).optional(), price_cents: fields.cents.optional(), currency: z.string().length(3).optional(), active: z.boolean().optional(),
  }).strict();
  r.get('/products', read, (_req, res) => res.json({ data: ctx.products.list() }));
  r.post('/products', write, validate({ body: productBody }), (req, res) => res.status(201).json({ data: ctx.products.create(req.body) }));
  r.put('/products/:sku', write, validate({ params: z.object({ sku: fields.sku }), body: productBody.omit({ sku: true }).partial() }), (req, res) => res.json({ data: ctx.products.update(req.params.sku, req.body) }));

  customerRoutes(ctx, r, { scope: unscoped, scopes: { read: 'admin:read', write: 'admin:write' } });

  const resellerBody = z.object({ name: z.string().trim().min(1).max(200), email: fields.email, quota: z.record(z.enum(EDITIONS), z.number().int().min(-1)).optional(), pricing: z.record(z.enum(EDITIONS), z.record(z.number().int().min(0))).optional(), brand: z.record(z.string().max(500)).optional() }).strict();
  r.get('/resellers', read, validate({ query: pagination }), (req, res) => res.json(ctx.resellers.list(req.query)));
  r.post('/resellers', write, validate({ body: resellerBody }), (req, res) => res.status(201).json({ data: ctx.resellers.create(req.body) }));
  r.get('/resellers/:id', read, validate({ params: idParam }), (req, res) => res.json({ data: { ...ctx.resellers.get(req.params.id), quota_left: ctx.resellers.quotaLeft(req.params.id) } }));
  r.patch('/resellers/:id', write, validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(200).optional(), status: z.enum(['active', 'suspended', 'closed']).optional(), brand: z.record(z.string().max(500)).optional() }).strict() }), (req, res) => res.json({ data: ctx.resellers.update(req.params.id, req.body) }));
  r.put('/resellers/:id/quota', write, validate({ params: idParam, body: z.object({ quota: z.record(z.enum(EDITIONS), z.number().int().min(-1)).optional(), pricing: z.record(z.enum(EDITIONS), z.record(z.number().int().min(0))).optional() }).strict() }), (req, res) => {
    req.audit({ action: 'reseller.quota', target: req.params.id, args: req.body });
    res.json({ data: ctx.resellers.setQuota(req.params.id, req.body) });
  });
  r.get('/resellers/:id/statement', read, validate({ params: idParam }), (req, res) => res.json({ data: ctx.resellers.statement(req.params.id) }));
  // §16.9 impersonate-reseller: rebinds this vendor_admin portal session to the
  // reseller's tenant as reseller_admin for 15 minutes (shared/auth.js
  // impersonationOf); ends early via POST /v1/portal/impersonate/end. API keys
  // cannot impersonate — the rebinding lives in the session.
  r.post('/resellers/:id/impersonate', requireRole('vendor_admin'), stepUp, validate({ params: idParam, body: z.object({}).strict() }), (req, res) => {
    const reseller = ctx.resellers.get(req.params.id);
    if (reseller.status !== 'active') throw new HttpError(409, 'reseller_suspended', `This reseller account is ${reseller.status}`);
    const now = ctx.clock.now();
    req.session.impersonation = { reseller_id: reseller.id, by: req.principal.userId, started_at: now, expires_at: now + IMPERSONATION_TTL_MS };
    req.audit({ action: 'reseller.impersonate', target: reseller.id, args: { expires_at: new Date(req.session.impersonation.expires_at).toISOString() } });
    res.json({ data: { reseller_id: reseller.id, reseller_name: reseller.name, expires_at: new Date(req.session.impersonation.expires_at).toISOString() } });
  });

  const issueBody = z.object({
    sku: fields.sku,
    customer: z.object({ email: fields.email, name: z.string().trim().min(1).max(200).optional(), company: z.string().max(200).optional(), country: z.string().max(2).optional() }).strict().optional(),
    customer_id: fields.id.optional(), reseller_id: fields.id.optional(), term_months: fields.termMonths.optional(), notes: z.string().max(1000).optional(), external_ref: z.string().max(200).optional(),
    starts_at: z.string().datetime().optional(), max_activations: z.number().int().min(1).max(1000).optional(), grace_days: z.number().int().min(0).max(365).optional(),
    limits: z.record(z.number().int()).optional(), features: z.record(z.boolean()).optional(),
  }).strict().refine((b) => b.customer || b.customer_id, { message: 'customer or customer_id is required', path: ['customer'] });
  r.get('/licenses', read, validate({ query: pagination.extend({ status: z.string().optional(), edition: z.string().optional(), customer_id: fields.id.optional(), expiring_within: z.coerce.number().int().min(1).max(365).optional() }) }), (req, res) => res.json(ctx.licenses.list(req.query)));
  r.post('/licenses', write, validate({ body: issueBody }), (req, res) => {
    const { license, key } = ctx.licenses.issue(req.body, opts(req));
    res.status(201).json({ data: { license_id: license.id, key, edition: license.edition, expires_at: license.expires_at, max_activations: license.max_activations } });
  });
  r.post('/licenses/bulk', write, validate({ body: z.object({ sku: fields.sku, count: z.number().int().min(1).max(1000), customer_id: fields.id, reseller_id: fields.id.optional(), notes: z.string().max(1000).optional(), term_months: fields.termMonths.optional() }).strict() }), (req, res) => {
    const job = ctx.jobs.enqueueBulkIssue(req.body, { actor: actorOf(req), scope: null, owner: req.principal });
    res.status(202).json({ data: { job: { id: job.id } } });
  });
  r.get('/licenses/:id', read, validate({ params: idParam }), (req, res) => {
    const license = ctx.licenses.get(req.params.id);
    res.json({ data: { ...license, status_now: ctx.licenses.statusAt(license), customer: ctx.customers.get(license.customer_id), activations: ctx.activations.listForLicense(license.id), usage: ctx.licenses.lastUsage(license.id), checkins: ctx.activations.checkins(license.id, 50), revocations: db.prepare('SELECT * FROM revocations WHERE license_id = ? ORDER BY ts DESC').all(license.id), trial: ctx.trials.forLicense(license.id) } });
  });
  licenseLifecycleRoutes(ctx, r, { scope: unscoped, scopes: { renew: 'admin:write', change: 'admin:write', suspend: 'admin:write', revoke: 'admin:write', rekey: 'admin:write', activations: 'admin:read', deactivate: 'admin:write' } });
  r.post('/licenses/:id/lift-reactivation-limit', write, validate({ params: idParam, body: z.object({ days: z.number().int().min(1).max(90).default(7) }).strict() }), (req, res) => res.json({ data: ctx.licenses.liftReactivationLimit(req.params.id, req.body, opts(req)) }));
  r.post('/licenses/:id/messages', write, validate({ params: idParam, body: z.object({ level: z.enum(['info', 'warning', 'critical']).default('info'), code: z.string().regex(/^[a-z_]{2,40}$/), text: z.string().min(1).max(500) }).strict() }), (req, res) => {
    ctx.licenses.get(req.params.id);
    res.status(201).json({ data: ctx.activations.pushMessage({ licenseId: req.params.id }, req.body) });
  });

  r.get('/activations', read, validate({ query: pagination.extend({ stale: z.string().regex(/^\d{1,4}d$/).optional(), license_id: fields.id.optional(), status: z.string().optional() }) }), (req, res) => {
    res.json(ctx.activations.list({ ...req.query, stale_days: req.query.stale ? Number(req.query.stale.slice(0, -1)) : undefined }));
  });
  for (const action of ['deactivate', 'block', 'reclaim']) {
    r.post(`/activations/:id/${action}`, write, validate({ params: idParam, body: reasonBody }), (req, res) => {
      res.json({ data: ctx.activations[action](req.params.id, { reason: req.body.reason, by: actorLabel(req), ip: req.ip }) });
    });
  }
  r.get('/revocations', read, validate({ query: pagination }), (req, res) => res.json(paginate(db, { select: 'r.*, l.key_prefix, l.edition', from: 'revocations r JOIN licenses l ON l.id = r.license_id', sortable: { ts: 'r.ts' }, defaultSort: 'ts', query: { dir: 'desc', ...req.query } })));
  r.get('/checkins', read, validate({ query: pagination.extend({ license_id: fields.id }) }), (req, res) => {
    res.json(paginate(db, { select: 'id, activation_id, ts, panel_version, accounts_used, resellers_used, domains_used, usage_json, ip, result, latency_ms', from: 'checkins', where: ['license_id = @license'], params: { license: req.query.license_id }, sortable: { ts: 'ts' }, defaultSort: 'ts', query: { dir: 'desc', ...req.query } }));
  });
  r.get('/trials', read, validate({ query: pagination.extend({ converted: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }), (req, res) => res.json({ ...ctx.trials.list(req.query), funnel: ctx.trials.funnel() }));
  r.post('/trials/:id/convert', write, validate({ params: idParam, body: z.object({ sku: fields.sku, term_months: fields.termMonths.optional() }).strict() }), (req, res) => res.json({ data: ctx.trials.convert(req.params.id, req.body, opts(req)) }));

  // Inbound billing is authenticated by the provider's signature over the raw body, not by an API key.
  r.get('/billing/events', read, validate({ query: pagination.extend({ source: z.enum(['stripe', 'whmcs', 'paddle']).optional() }) }), (req, res) => res.json(ctx.billing.list(req.query)));

  r.get('/signing-keys', read, validate({ query: z.object({ purpose: fields.purpose.optional() }) }), (req, res) => res.json({ data: ctx.signingKeys.list(req.query.purpose) }));
  r.post('/signing-keys', write, stepUp, validate({ body: z.object({ purpose: fields.purpose }).strict() }), (req, res) => res.status(201).json({ data: ctx.signingKeys.create(req.body.purpose, opts(req)) }));
  r.post('/signing-keys/:kid/activate', write, stepUp, validate({ params: z.object({ kid: fields.kid }), body: z.object({}).strict() }), (req, res) => res.json({ data: ctx.signingKeys.activate(req.params.kid, opts(req)) }));
  r.post('/signing-keys/:kid/retire', write, stepUp, validate({ params: z.object({ kid: fields.kid }), body: z.object({ force: z.boolean().optional() }).strict() }), (req, res) => res.json({ data: ctx.signingKeys.retire(req.params.kid, { ...opts(req), force: req.body.force }) }));

  r.get('/reports/dashboard', requireScope('report:read'), (_req, res) => res.json({ data: ctx.reports.dashboard() }));
  for (const name of ['activations', 'renewals', 'churn', 'resellers', 'versions']) {
    r.get(`/reports/${name}`, requireScope('report:read'), (_req, res) => res.json({ data: ctx.reports[name]() }));
  }
  r.get('/export.csv', requireScope('report:read'), validate({ query: z.object({ table: z.enum(['licenses', 'activations', 'customers']) }) }), (req, res) => {
    ctx.audit.record({ principal: req.principal, ip: req.ip, action: 'export.csv', target: req.query.table, args: null, result: 'ok' });
    res.type('text/csv').send(ctx.reports.exportCsv(req.query.table));
  });
  // Full database copy for vendor admins (§16.11): admin:* plus a fresh step-up, audited.
  r.get('/export.db', requireScope('admin:*'), stepUp, wrap(async (req, res) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-export-'));
    const file = path.join(dir, 'license.db');
    try {
      await db.backup(file);
      ctx.audit.record({ principal: req.principal, ip: req.ip, action: 'export.db', target: 'license.db', args: { bytes: fs.statSync(file).size }, result: 'ok' });
      res.set('Content-Disposition', `attachment; filename="license-${nowIso(ctx.clock.now()).replace(/[:.]/g, '-')}.db"`);
      res.type('application/vnd.sqlite3').send(fs.readFileSync(file));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));
  r.get('/audit', read, validate({ query: pagination.extend({ action: z.string().max(80).optional(), principal: z.string().max(120).optional() }) }), (req, res) => {
    const where = []; const params = {};
    if (req.query.action) { where.push('action LIKE @action'); params.action = `${req.query.action}%`; }
    if (req.query.principal) { where.push('principal = @principal'); params.principal = req.query.principal; }
    if (req.query.q) { where.push('(action LIKE @q OR target LIKE @q OR principal LIKE @q)'); params.q = `%${req.query.q}%`; }
    res.json(paginate(db, { from: 'audit_log', where, params, sortable: { ts: 'ts', id: 'id' }, defaultSort: 'id', query: { dir: 'desc', ...req.query } }));
  });
  apiKeyRoutes(ctx, r, { ownerType: 'vendor', ownerId: () => 'vnd_default', scope: 'admin:write', allowedScopes: [...VENDOR_SCOPES, ...RESELLER_SCOPES] });
  webhookRoutes(ctx, r, { ownerType: 'vendor', ownerId: () => 'vnd_default', scope: 'admin:write' });
  r.post('/webhooks/deliver-now', write, wrap(async (_req, res) => res.json({ data: await ctx.webhooks.deliverDue() })));
  r.get('/messages', read, (_req, res) => res.json({ data: db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all() }));
  r.post('/messages', write, validate({ body: z.object({ level: z.enum(['info', 'warning', 'critical']).default('info'), code: z.string().regex(/^[a-z_]{2,40}$/), text: z.string().min(1).max(500), all: z.literal(true) }).strict() }), (req, res) => res.status(201).json({ data: ctx.activations.pushMessage({ all: true }, req.body) }));
  r.get('/schedules', read, (_req, res) => res.json({ data: ctx.scheduler.list() }));
  r.post('/schedules/:name/run', write, validate({ params: z.object({ name: z.string().regex(/^[a-z-]{2,40}$/) }) }), wrap(async (req, res) => res.json({ data: await ctx.scheduler.run(req.params.name) })));
  r.post('/ip-blocks/:ip/unblock', write, validate({ params: z.object({ ip: z.string().ip() }) }), (req, res) => res.json({ data: { unblocked: ctx.licenses.lookupGuard.unblock(req.params.ip) } }));
  jobRoutes(ctx, r, { scope: JOB_SCOPES.vendor });
  return r;
}

// POST /v1/admin/billing/webhooks/:source is mounted before the JSON parser
// (raw body for signature verification) and outside the admin auth chain.
export function billingWebhookRoutes(ctx) {
  const r = express.Router();
  r.post('/:source', express.raw({ type: () => true, limit: '1mb' }), validate({ params: z.object({ source: z.enum(['stripe', 'whmcs', 'paddle']) }) }), (req, res, next) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!ctx.billing.verifySignature(req.params.source, raw, req.headers)) {
      ctx.audit.record({ principal: `billing:${req.params.source}`, ip: req.ip, action: 'billing.event', target: null, args: null, result: 'error:signature' });
      return next(new HttpError(401, 'invalid_signature', 'Billing webhook signature is missing or invalid'));
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { return next(new HttpError(400, 'bad_json', 'Billing webhook body is not JSON')); }
    res.json({ data: ctx.billing.handle(req.params.source, payload) });
  });
  return r;
}
