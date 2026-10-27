import express from 'express';
import { z, validate, fields, pagination, wrap } from '../../shared/validate.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { requireStepUp, scopeAllows, actorOf } from '../../shared/auth.js';
import { paginate } from '../../shared/db.js';
import { pluginId, semverField } from './public.js';

const idField = z.string().regex(/^[a-z]{2,4}_[0-9A-Za-z]{6,40}$/);
const reasonField = z.string().trim().min(1).max(500);
const reasons = z.array(z.object({ code: z.string().regex(/^[a-z_]{2,40}$/), path: z.string().max(200).optional(), text: z.string().max(2000) }).strict()).min(1).max(50);

// §18.8 admin API under /v1/admin/market: vendor portal session + TOTP step-up
// on mutations, or a vendor api_keys row with market:* (admin:* keeps working).
export function adminRoutes(m) {
  const { ctx } = m;
  const r = express.Router();
  const market = (scope) => (req, _res, next) => {
    if (!req.principal) return next(new HttpError(401, 'unauthorized', 'Authentication required'));
    if (req.principal.ownerType !== 'vendor') return next(new HttpError(403, 'wrong_owner_type', 'This API is for vendor principals'));
    const s = req.principal.scopes;
    const ok = scopeAllows(s, `market:${scope}`) || scopeAllows(s, 'admin:*') || scopeAllows(s, 'admin:write') || (scope === 'read' && scopeAllows(s, 'admin:read'));
    if (!ok) return next(new HttpError(403, 'insufficient_scope', `Scope "market:${scope}" is required`));
    next();
  };
  const stepUp = requireStepUp(ctx.config.license.stepup_max_age_s, () => ctx.clock.now());
  const by = (req) => req.principal.type === 'api_key' ? `apikey:${req.principal.keyId}` : `portal:${req.principal.userId}`;
  const actor = (req) => ({ by: by(req), ip: req.ip });
  const read = market('read');

  // Developer verification queue.
  r.get('/verifications', read, validate({ query: z.object({ status: z.enum(['pending', 'verified', 'rejected', 'suspended']).default('pending') }) }), (req, res) => res.json({ data: m.verification.queue(req.query) }));
  r.get('/verifications/:id/document', market('verify'), validate({ params: z.object({ id: idField }) }), (req, res) => res.json({ data: m.verification.document(req.params.id) }));
  r.post('/verifications/:id/approve', market('verify'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ note: z.string().max(1000).optional() }).strict() }), (req, res) => res.json({ data: m.verification.approve(req.params.id, { ...actor(req), note: req.body.note }) }));
  r.post('/verifications/:id/reject', market('verify'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ code: z.enum(['duplicate_identity', 'evidence_failed', 'namespace_conflict', 'policy']), text: z.string().max(1000).optional() }).strict() }), (req, res) => res.json({ data: m.verification.reject(req.params.id, { ...req.body, ...actor(req) }) }));
  r.post('/verifications/:id/request-evidence', market('verify'), validate({ params: z.object({ id: idField }), body: z.object({ text: z.string().max(1000).optional() }).strict() }), (req, res) => res.json({ data: m.verification.requestEvidence(req.params.id, { ...req.body, ...actor(req) }) }));

  // Developers.
  r.get('/developers', read, validate({ query: pagination.extend({ status: z.enum(['pending', 'verified', 'rejected', 'suspended']).optional() }) }), (req, res) => res.json(m.developers.list(req.query)));
  r.get('/developers/:id', read, validate({ params: z.object({ id: idField }) }), (req, res) => res.json({ data: { ...m.developers.publicView(m.developers.get(req.params.id)), history: m.developers.history(req.params.id) } }));
  r.patch('/developers/:id', market('verify'), validate({ params: z.object({ id: idField }), body: z.object({ display_name: z.string().trim().min(2).max(80).optional(), company: z.string().max(120).nullable().optional(), website: fields.url.nullable().optional(), country: z.string().length(2).nullable().optional(), support_email: fields.email.nullable().optional(), support_url: fields.url.nullable().optional(), status_reason: z.string().max(500).nullable().optional() }).strict() }), (req, res) => res.json({ data: m.developers.adminPatch(req.params.id, req.body, actor(req)) }));
  r.post('/developers/:id/suspend', market('verify'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ reason: reasonField }).strict() }), (req, res) => res.json({ data: m.developers.suspend(req.params.id, { ...req.body, ...actor(req) }) }));
  r.post('/developers/:id/reinstate', market('verify'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({}).strict() }), (req, res) => res.json({ data: m.developers.reinstate(req.params.id, actor(req)) }));
  r.post('/developers/:id/reverify', market('verify'), validate({ params: z.object({ id: idField }), body: z.object({ reason: z.string().max(200).optional() }).strict() }), (req, res) => res.json({ data: m.developers.triggerReverification(req.params.id, req.body.reason || 'manual', actor(req)) }));
  r.post('/developers/:id/close', market('verify'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ reason: reasonField }).strict() }), (req, res) => res.json({ data: m.developers.closeAccount(req.params.id, { ...req.body, ...actor(req) }) }));
  r.put('/developers/:id/revenue-share', market('billing'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ pct: z.number().int().min(0).max(100) }).strict() }), (req, res) => res.json({ data: m.developers.setRevenueShare(req.params.id, req.body.pct, actor(req)) }));
  r.post('/developers/:id/namespaces/:ns/reassign', market('verify'), stepUp, validate({ params: z.object({ id: idField, ns: z.string().trim().min(3).max(200) }), body: z.object({}).strict() }), (req, res) => res.json({ data: m.developers.reassignNamespace(req.params.ns, req.params.id, actor(req)) }));

  // Plugin review queue.
  r.get('/reviews', read, validate({ query: pagination.extend({ risk: z.enum(['normal', 'high']).optional() }) }), (req, res) => res.json(m.review.queue(req.query)));
  r.get('/reviews/:id', read, validate({ params: z.object({ id: idField }) }), (req, res) => res.json({ data: m.review.detail(req.params.id) }));
  r.post('/reviews/:id/approve', market('review'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ notes: z.string().max(5000).optional(), checklist: z.record(z.boolean()).optional() }).strict() }), (req, res) => res.json({ data: m.review.approve(req.params.id, { ...actor(req), notes: req.body.notes, checklist: req.body.checklist || {} }) }));
  r.post('/reviews/:id/request-changes', market('review'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ reasons, notes: z.string().max(5000).optional() }).strict() }), (req, res) => res.json({ data: m.review.requestChanges(req.params.id, { ...req.body, ...actor(req) }) }));
  r.post('/reviews/:id/reject', market('review'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ reasons, notes: z.string().max(5000).optional() }).strict() }), (req, res) => res.json({ data: m.review.reject(req.params.id, { ...req.body, ...actor(req) }) }));

  // Catalog control.
  r.get('/plugins', read, validate({ query: pagination.extend({ status: z.enum(['draft', 'listed', 'unlisted', 'removed']).optional() }) }), (req, res) => {
    const where = []; const params = {};
    if (req.query.status) { where.push('status = @status'); params.status = req.query.status; }
    if (req.query.q) { where.push('(id LIKE @q OR name LIKE @q)'); params.q = `%${req.query.q}%`; }
    const page = paginate(m.db, { from: 'plugins', where, params, sortable: { created_at: 'created_at', name: 'name', install_count: 'install_count' }, defaultSort: 'created_at', query: { dir: 'desc', ...req.query } });
    res.json({ ...page, data: page.data.map((p) => m.submissions.shapePlugin(p)) });
  });
  r.get('/plugins/:id', read, validate({ params: z.object({ id: pluginId }) }), (req, res) => res.json({ data: m.catalog.adminGet(req.params.id) }));
  r.patch('/plugins/:id', market('review'), validate({ params: z.object({ id: pluginId }), body: z.object({ status: z.enum(['draft', 'listed', 'unlisted', 'removed']).optional(), featured: z.boolean().optional(), category_id: z.string().regex(/^cat_[a-z_]{2,40}$/).optional(), bundled_editions: z.array(z.enum(['trial', 'solo', 'pro', 'reseller', 'enterprise'])).optional() }).strict() }), (req, res) => res.json({ data: m.catalog.adminPatch(req.params.id, req.body, actor(req)) }));
  r.post('/plugins/:id/takedown', market('revoke'), stepUp, validate({ params: z.object({ id: pluginId }), body: z.object({ reason: reasonField }).strict() }), (req, res) => res.json({ data: m.revocations.takedown(req.params.id, { ...req.body, ...actor(req) }) }));
  r.post('/plugins/:id/versions/:v/publish', market('review'), stepUp, validate({ params: z.object({ id: pluginId, v: semverField }), body: z.object({ channel: z.enum(['stable', 'beta']).optional() }).strict() }), (req, res) => res.json({ data: m.submissions.publish(null, req.params.id, req.params.v, req.body, actor(req)) }));
  r.post('/plugins/:id/versions/:v/yank', market('revoke'), validate({ params: z.object({ id: pluginId, v: semverField }), body: z.object({ reason: fields.reason }).strict() }), (req, res) => res.json({ data: m.submissions.yank(null, req.params.id, req.params.v, req.body, actor(req)) }));

  // Revocations.
  r.get('/revocations', read, validate({ query: pagination.extend({ plugin_id: pluginId.optional(), severity: z.enum(['info', 'warning', 'critical']).optional() }) }), (req, res) => res.json(m.revocations.list(req.query)));
  r.post('/revocations', market('revoke'), stepUp, validate({ body: z.object({ plugin_id: pluginId, version: semverField.nullable().optional(), severity: z.enum(['info', 'warning', 'critical']), action: z.enum(['disable', 'uninstall']), reason: reasonField }).strict() }), (req, res) => res.status(201).json({ data: m.revocations.create({ ...req.body, version: req.body.version || null }, actor(req)) }));
  r.post('/revocations/kill-switch', market('revoke'), stepUp, validate({ body: z.object({ plugin_id: pluginId, version: z.null().optional(), severity: z.literal('critical').default('critical'), action: z.enum(['disable', 'uninstall']).default('disable'), reason: z.string().max(500).optional() }).strict() }), (req, res) => res.status(201).json({ data: m.revocations.killSwitch(req.body, actor(req)) }));

  // Money in.
  r.get('/entitlements', read, validate({ query: pagination.extend({ license_prefix: fields.licensePrefix.optional(), plugin_id: pluginId.optional(), status: z.enum(['active', 'expired', 'cancelled', 'refunded']).optional() }) }), (req, res) => res.json(m.entitlements.list(req.query)));
  r.post('/entitlements', market('billing'), stepUp, validate({ body: z.object({ license_id: fields.id, plugin_id: pluginId, kind: z.enum(['free', 'one_time', 'subscription', 'trial']).default('one_time'), expires_at: z.string().datetime().nullable().optional() }).strict() }), (req, res) => res.status(201).json({ data: m.entitlements.grant({ ...req.body, source: 'admin', expires_at: req.body.expires_at || null }, actor(req)) }));
  r.post('/entitlements/:id/cancel', market('billing'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({}).strict() }), (req, res) => res.json({ data: m.entitlements.cancel(req.params.id, actor(req)) }));
  r.get('/purchases', read, validate({ query: pagination.extend({ license_prefix: fields.licensePrefix.optional(), plugin_id: pluginId.optional(), developer_id: idField.optional(), status: z.enum(['paid', 'refunded', 'chargeback', 'cancelled']).optional() }) }), (req, res) => res.json(m.billing.listPurchases(req.query)));
  r.post('/purchases/:id/refund', market('billing'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ status: z.enum(['refunded', 'chargeback']).default('refunded') }).strict() }), (req, res) => res.json({ data: m.billing.refund(req.params.id, { ...req.body, ...actor(req) }) }));

  // Money out.
  r.get('/payouts', read, validate({ query: pagination.extend({ status: z.enum(['pending', 'approved', 'paid', 'failed', 'held']).optional(), developer_id: idField.optional() }) }), (req, res) => res.json(m.payouts.list(req.query)));
  r.post('/payouts/close', market('billing'), stepUp, validate({ body: z.object({ period_start: z.string().datetime().optional(), period_end: z.string().datetime().optional() }).strict() }), (req, res) => res.json({ data: m.payouts.close(req.body, actor(req)) }));
  r.post('/payouts/:id/approve', market('billing'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({}).strict() }), (req, res) => res.json({ data: m.payouts.approve(req.params.id, actor(req)) }));
  r.post('/payouts/:id/mark-paid', market('billing'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ provider_ref: z.string().trim().min(1).max(120) }).strict() }), (req, res) => res.json({ data: m.payouts.markPaid(req.params.id, { ...req.body, ...actor(req) }) }));
  r.post('/payouts/:id/hold', market('billing'), stepUp, validate({ params: z.object({ id: idField }), body: z.object({ reason: reasonField }).strict() }), (req, res) => res.json({ data: m.payouts.hold(req.params.id, { ...req.body, ...actor(req) }) }));

  // Review moderation, categories, stats, audit, re-sign status.
  r.get('/plugin-reviews', read, validate({ query: pagination.extend({ status: z.enum(['pending', 'published', 'hidden']).optional(), flagged: z.coerce.boolean().optional(), plugin_id: pluginId.optional() }) }), (req, res) => res.json(m.pluginReviews.list(req.query)));
  r.post('/plugin-reviews/:id/publish', market('review'), validate({ params: z.object({ id: idField }) }), (req, res) => res.json({ data: m.pluginReviews.moderate(req.params.id, 'publish', actor(req)) }));
  r.post('/plugin-reviews/:id/hide', market('review'), validate({ params: z.object({ id: idField }) }), (req, res) => res.json({ data: m.pluginReviews.moderate(req.params.id, 'hide', actor(req)) }));
  r.get('/categories', read, (_req, res) => res.json({ data: m.catalog.categories() }));
  r.post('/categories', market('review'), validate({ body: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().trim().min(1).max(60), position: z.number().int().min(0).max(1000).optional() }).strict() }), (req, res) => res.status(201).json({ data: m.catalog.createCategory(req.body, actor(req)) }));
  r.get('/stats', read, (_req, res) => res.json({ data: m.stats.adminStats() }));
  r.get('/audit', read, validate({ query: pagination.extend({ action: z.string().regex(/^[a-z_.]{2,60}$/).optional(), target: z.string().max(200).optional() }) }), (req, res) => {
    const where = []; const params = {};
    if (req.query.action) { where.push('action LIKE @action'); params.action = `${req.query.action}%`; }
    if (req.query.target) { where.push('target = @target'); params.target = req.query.target; }
    if (req.query.q) { where.push('(principal LIKE @q OR target LIKE @q OR action LIKE @q)'); params.q = `%${req.query.q}%`; }
    res.json(paginate(m.db, { from: 'audit_log', where, params, sortable: { ts: 'ts', id: 'id' }, defaultSort: 'id', query: { dir: 'desc', ...req.query } }));
  });
  r.get('/resign-status', read, (_req, res) => res.json({ data: m.signing.resignStatus() }));
  r.post('/jobs/:name/run', market('review'), validate({ params: z.object({ name: z.enum(['scan-queue', 'verification-rechecks', 'reverify-due', 'payouts-close', 'evidence-purge', 'download-purge', 'resign-packages', 'psl-refresh', 'entitlement-expiry', 'market-housekeeping']) }) }), wrap(async (req, res) => res.json({ data: await ctx.scheduler.run(req.params.name) })));
  return r;
}
