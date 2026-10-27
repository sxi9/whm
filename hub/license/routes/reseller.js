import express from 'express';
import { z, validate, fields, pagination, wrap } from '../../shared/validate.js';
import { apiKeyAuth, requireScope, actorOf, RESELLER_SCOPES } from '../../shared/auth.js';
import { licenseLifecycleRoutes, customerRoutes, webhookRoutes, apiKeyRoutes, jobRoutes } from './admin.js';

const issueBody = z.object({
  sku: fields.sku,
  customer: z.object({ email: fields.email, name: z.string().trim().min(1).max(200).optional(), company: z.string().max(200).optional(), country: z.string().max(2).optional() }).strict().optional(),
  customer_id: fields.id.optional(),
  term_months: fields.termMonths.optional(),
  notes: z.string().max(1000).optional(),
  external_ref: z.string().max(200).optional(),
}).strict().refine((b) => b.customer || b.customer_id, { message: 'customer or customer_id is required', path: ['customer'] });

export function resellerRoutes(ctx) {
  const r = express.Router();
  r.use(ctx.app.limiters.reseller, apiKeyAuth({ ownerType: 'reseller' }));
  const scope = (req) => ({ resellerId: req.principal.ownerId });

  r.get('/licenses', requireScope('license:read'), validate({ query: pagination.extend({ status: z.string().optional(), edition: z.string().optional(), expiring_within: z.coerce.number().int().min(1).max(365).optional() }) }), (req, res) => {
    res.json(ctx.licenses.list(req.query, scope(req)));
  });
  r.post('/licenses', requireScope('license:issue'), validate({ body: issueBody }), wrap(async (req, res) => {
    const { license, key, quota_left } = ctx.licenses.issue(req.body, { actor: actorOf(req), scope: scope(req) });
    res.status(201).json({ data: { license_id: license.id, key, edition: license.edition, expires_at: license.expires_at, max_activations: license.max_activations }, meta: { quota_left } });
  }));
  r.post('/licenses/bulk', requireScope('license:issue'), validate({ body: z.object({ sku: fields.sku, count: z.number().int().min(1).max(500), customer_id: fields.id, notes: z.string().max(1000).optional(), term_months: fields.termMonths.optional() }).strict() }), wrap(async (req, res) => {
    ctx.resellers.assertQuota(req.principal.ownerId, ctx.products.get(req.body.sku).edition, req.body.count);
    const job = ctx.jobs.enqueueBulkIssue(req.body, { actor: actorOf(req), scope: scope(req), owner: req.principal });
    res.status(202).json({ data: { job: { id: job.id } } });
  }));
  r.get('/licenses/:id', requireScope('license:read'), validate({ params: z.object({ id: fields.id }) }), (req, res) => {
    const license = ctx.licenses.get(req.params.id, scope(req));
    res.json({ data: { ...license, status_now: ctx.licenses.statusAt(license), activations: ctx.activations.listForLicense(license.id), usage: ctx.licenses.lastUsage(license.id) } });
  });
  licenseLifecycleRoutes(ctx, r, { scope, scopes: { renew: 'license:renew', change: 'license:renew', suspend: 'license:revoke', revoke: 'license:revoke', rekey: 'license:issue', activations: 'license:read', deactivate: 'license:revoke' } });
  customerRoutes(ctx, r, { scope, scopes: { read: 'license:read', write: 'customer:write' } });

  r.get('/quota', requireScope('license:read'), (req, res) => {
    const rs = ctx.resellers.get(req.principal.ownerId);
    res.json({ data: { quota: rs.quota, issued: rs.issued, quota_left: ctx.resellers.quotaLeft(rs.id), pricing: rs.pricing } });
  });
  r.get('/invoices', requireScope('license:read'), (req, res) => {
    res.json({ data: ctx.resellers.statement(req.principal.ownerId) });
  });
  webhookRoutes(ctx, r, { ownerType: 'reseller', ownerId: (req) => req.principal.ownerId, scope: 'webhook:write' });
  apiKeyRoutes(ctx, r, { ownerType: 'reseller', ownerId: (req) => req.principal.ownerId, scope: 'apikey:write', allowedScopes: RESELLER_SCOPES });
  jobRoutes(ctx, r);
  return r;
}
