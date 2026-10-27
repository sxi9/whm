import express from 'express';
import rateLimit from 'express-rate-limit';
import { z, validate, fields, pagination, wrap } from '../../shared/validate.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { newId, nowIso, json, paginate } from '../../shared/db.js';
import { replay as replayDelivery } from '../../shared/webhooks.js';
import { DEV_SCOPES } from '../services/dev-security.js';
import { METHODS } from '../services/verification.js';
import { pluginId, semverField } from './public.js';

const devScope = z.enum(DEV_SCOPES);
const nsField = z.string().trim().min(3).max(200);
const kidField = z.string().regex(/^[0-9a-f]{8}$/);
const idField = z.string().regex(/^[a-z]{2,4}_[0-9A-Za-z]{6,40}$/);
const pricing = z.object({ model: z.enum(['free', 'one_time', 'subscription']), cents: z.number().int().optional(), currency: z.string().length(3).optional(), interval: z.enum(['month', 'year']).optional(), trial_days: z.number().int().optional() }).strict();
const listingBody = z.object({
  id: pluginId, name: z.string().trim().min(2).max(80), slug: z.string().regex(/^[a-z0-9-]{2,60}$/).optional(), summary: z.string().trim().max(200).optional(), description_md: z.string().max(20000).optional(), category_id: z.string().regex(/^cat_[a-z_]{2,40}$/).optional(),
  keywords: z.array(z.string().trim().min(1).max(30)).max(10).optional(), homepage: fields.url.optional(), support_url: fields.url.optional(), license_spdx: z.string().max(60).optional(), pricing: pricing.optional(),
}).strict();
const justifications = z.record(z.string().regex(/^[a-z:*._-]{3,80}$/), z.string().max(500));

// §18.8 developer API: portal session (cookie + CSRF) or X-Dev-Api-Key with
// scopes; † routes need a TOTP step-up and are closed to API keys.
export function developerRoutes(m) {
  const { ctx, cfg } = m;
  const sec = m.devSecurity;
  const r = express.Router();
  const limiter = ({ max, windowMs }, key, message) => rateLimit({ windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, validate: false, keyGenerator: key, handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message } }) });
  const loginLimiter = limiter(cfg.rate_limits.dev_login, (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}`, 'Too many login attempts');
  const auth = sec.requireDeveloper();
  const scoped = (scope) => sec.requireDeveloper({ scope });
  const stepUp = sec.requireStepUp();
  const ip = (req) => ({ ip: req.ip });

  r.use(sec.attachDeveloper());
  r.use(sec.csrf({ exempt: ['/register', '/verify-email', '/login', '/password/reset'] }));

  // Account.
  r.post('/register', validate({ body: z.object({ email: fields.email, password: fields.password, display_name: z.string().trim().min(2).max(80) }).strict() }), wrap(async (req, res) => {
    const out = await m.developers.register(req.body, ip(req));
    res.status(202).json({ data: { id: out.id, status: out.status, email_verification_required: true } });
  }));
  r.post('/verify-email', validate({ body: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) }).strict() }), (req, res) => res.json({ data: m.developers.verifyEmail(req.body.token) }));
  r.post('/login', loginLimiter, validate({ body: z.object({ email: fields.email, password: z.string().min(1).max(128), totp: z.string().regex(/^\d{6}$/).optional() }).strict() }), wrap(async (req, res) => {
    const { developer, totpVerified } = await m.developers.login(req.body, ip(req));
    const session = sec.createSession(developer, { ip: req.ip, totpVerified, res });
    res.json({ data: { developer: m.developers.publicView(developer), csrfToken: session.csrfToken, totp_verified_at: totpVerified ? m.now() : null } });
  }));
  r.post('/logout', auth, (req, res) => { sec.destroySession(req, res); res.json({ data: { logged_out: true } }); });
  r.get('/me', auth, (req, res) => res.json({ data: { developer: m.developers.publicView(req.developer), principal: req.devPrincipal.type, scopes: req.devPrincipal.scopes, csrfToken: req.devPrincipal.csrfToken || null, totp_verified_at: req.devPrincipal.totpVerifiedAt } }));
  r.post('/2fa/start', auth, (req, res) => { if (req.devPrincipal.type !== 'session') throw new HttpError(403, 'portal_session_required', 'Use the portal'); res.json({ data: m.developers.totpStart(req.developer) }); });
  r.post('/2fa/confirm', auth, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }), (req, res) => {
    const out = m.developers.totpConfirm(req.developer, req.body.code, ip(req));
    if (req.devSession) sec.markStepUp(req);
    res.json({ data: out });
  });
  r.post('/2fa/disable', auth, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }), (req, res) => res.json({ data: m.developers.totpDisable(req.developer, req.body.code, ip(req)) }));
  r.post('/2fa/stepup', auth, validate({ body: z.object({ totp: z.string().regex(/^\d{6}$/) }).strict() }), (req, res) => res.json({ data: sec.stepUp(req, req.body.totp) }));
  r.post('/password/reset', limiter(cfg.rate_limits.dev_login, (req) => req.ip, 'Too many reset requests'), validate({ body: z.object({ email: fields.email }).strict() }), (req, res) => res.status(202).json({ data: sec.requestPasswordReset(req.body.email, ip(req)) }));
  r.post('/password/reset/:token', validate({ params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) }), body: z.object({ password: fields.password, totp: z.string().regex(/^\d{6}$/).optional() }).strict() }), wrap(async (req, res) => res.json({ data: await sec.resetPassword(req.params.token, req.body, ip(req)) })));
  r.post('/password/change', auth, validate({ body: z.object({ current_password: z.string().min(1).max(128), password: fields.password }).strict() }), wrap(async (req, res) => { const out = await sec.changePassword(req.developer, req.body, ip(req)); res.clearCookie(sec.SESSION_COOKIE, { path: '/' }); res.json({ data: out }); }));

  // Profile and namespaces.
  r.get('/profile', auth, (req, res) => res.json({ data: m.developers.publicView(req.developer) }));
  const profileBody = z.object({ display_name: z.string().trim().min(2).max(80).optional(), company: z.string().max(120).nullable().optional(), website: fields.url.nullable().optional(), country: z.string().length(2).nullable().optional(), support_email: fields.email.nullable().optional(), support_url: fields.url.nullable().optional(), email: fields.email.optional(), payout: z.record(z.unknown()).nullable().optional() }).strict();
  r.patch('/profile', auth, validate({ body: profileBody }), (req, res, next) => {
    if (req.body.email !== undefined || req.body.payout !== undefined) return stepUp(req, res, (err) => (err ? next(err) : res.json({ data: m.developers.updateProfile(req.developer, req.body, ip(req)) })));
    res.json({ data: m.developers.updateProfile(req.developer, req.body, ip(req)) });
  });
  r.get('/namespaces', auth, (req, res) => res.json({ data: m.developers.namespacesOf(req.developer.id) }));
  r.post('/namespaces', auth, stepUp, validate({ body: z.object({ ns: nsField }).strict() }), (req, res) => res.status(201).json({ data: m.developers.claimNamespace(req.developer, req.body.ns, ip(req)) }));
  r.delete('/namespaces/:ns', auth, stepUp, validate({ params: z.object({ ns: nsField }) }), (req, res) => res.json({ data: m.developers.releaseNamespace(req.developer, req.params.ns, ip(req)) }));

  // Verification evidence.
  r.get('/verification', auth, (req, res) => res.json({ data: m.verification.listFor(req.developer.id) }));
  r.post('/verification', auth, validate({ body: z.object({ method: z.enum(METHODS), ns: nsField.optional(), domain: z.string().trim().max(253).optional(), org: z.string().max(40).optional(), login: z.string().max(40).optional(), document: z.string().max(8_000_000).optional(), content_type: z.string().max(80).optional() }).strict() }), (req, res) => {
    res.status(201).json({ data: m.verification.submit(req.developer, req.body, ip(req)) });
  });
  r.post('/verification/:id/recheck', auth, validate({ params: z.object({ id: idField }) }), wrap(async (req, res) => res.json({ data: await m.verification.recheck(req.developer, req.params.id, ip(req)) })));
  r.get('/verification/github/start', auth, validate({ query: z.object({ id: idField }) }), (req, res) => res.json({ data: m.verification.githubStart(req.developer, req.query.id) }));
  r.get('/verification/github/callback', auth, validate({ query: z.object({ code: z.string().max(200), state: z.string().max(200) }) }), wrap(async (req, res) => res.json({ data: await m.verification.githubCallback(req.developer, req.query) })));

  // Signing keys (challenge → registration → revoke).
  r.get('/keys', auth, (req, res) => res.json({ data: m.devKeys.list(req.developer.id) }));
  r.post('/keys', auth, stepUp, (req, res) => res.status(201).json({ data: m.devKeys.challenge(req.developer) }));
  r.post('/keys/:challenge', auth, stepUp, validate({ params: z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), body: z.object({ public_key_pem: z.string().max(4000), label: z.string().trim().max(60).optional(), sig: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(120) }).strict() }), (req, res) => {
    res.status(201).json({ data: m.devKeys.register(req.developer, req.params.challenge, req.body, ip(req)) });
  });
  r.post('/keys/:kid/revoke', auth, stepUp, validate({ params: z.object({ kid: kidField }), body: z.object({ reason: fields.reason }).strict() }), (req, res) => res.json({ data: m.devKeys.revoke(req.developer, req.params.kid, { ...req.body, ...ip(req) }) }));

  // Listings.
  r.get('/plugins', scoped('plugin:read'), validate({ query: pagination }), (req, res) => res.json(m.submissions.listFor(req.developer, req.query)));
  r.post('/plugins', scoped('plugin:write'), validate({ body: listingBody }), (req, res) => res.status(201).json({ data: m.submissions.create(req.developer, req.body, ip(req)) }));
  r.get('/plugins/:id', scoped('plugin:read'), validate({ params: z.object({ id: pluginId }) }), (req, res) => {
    const p = m.submissions.owned(req.developer, req.params.id);
    res.json({ data: { ...m.submissions.shapePlugin(p), versions: m.submissions.versionsOf(p.id).map((v) => m.submissions.shapeVersion(v)), assets: m.submissions.assetsOf(p.id) } });
  });
  r.patch('/plugins/:id', scoped('plugin:write'), validate({ params: z.object({ id: pluginId }), body: listingBody.omit({ id: true, slug: true }).partial() }), (req, res) => res.json({ data: m.submissions.update(req.developer, req.params.id, req.body, ip(req)) }));
  r.post('/plugins/:id/assets', scoped('plugin:write'), validate({ params: z.object({ id: pluginId }), body: z.object({ kind: z.enum(['screenshot', 'icon', 'banner']), content_type: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']), data: z.string().max(3_000_000), position: z.number().int().min(0).max(20).optional() }).strict() }), (req, res) => {
    res.status(201).json({ data: m.submissions.addAsset(req.developer, req.params.id, req.body, ip(req)) });
  });
  r.delete('/plugins/:id/assets/:aid', scoped('plugin:write'), validate({ params: z.object({ id: pluginId, aid: idField }) }), (req, res) => res.json({ data: m.submissions.deleteAsset(req.developer, req.params.id, req.params.aid) }));

  // Submission pipeline.
  const rawPackage = express.raw({ type: ['application/gzip', 'application/x-gzip', 'application/octet-stream'], limit: cfg.max_package_bytes });
  r.post('/plugins/:id/versions', scoped('version:upload'), validate({ params: z.object({ id: pluginId }), query: z.object({ channel: z.enum(['stable', 'beta']).default('stable') }) }), rawPackage, wrap(async (req, res) => {
    const decode = (h) => (h ? Buffer.from(String(h), 'base64').toString('utf8') : null);
    let just = null;
    if (req.get('x-whm-justifications')) {
      try { just = justifications.parse(JSON.parse(decode(req.get('x-whm-justifications')))); } catch { throw new HttpError(422, 'validation_failed', 'X-WHM-Justifications must be base64 JSON { scope: text }'); }
    }
    const out = await m.submissions.upload(req.developer, req.params.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { channel: req.query.channel, changelog_md: decode(req.get('x-whm-changelog')), justifications: just }, ip(req));
    res.status(201).json({ data: out });
  }));
  r.get('/plugins/:id/versions', scoped('plugin:read'), validate({ params: z.object({ id: pluginId }) }), (req, res) => { m.submissions.owned(req.developer, req.params.id); res.json({ data: m.submissions.versionsOf(req.params.id).map((v) => m.submissions.shapeVersion(v)) }); });
  r.get('/plugins/:id/versions/:v', scoped('plugin:read'), validate({ params: z.object({ id: pluginId, v: semverField }) }), (req, res) => {
    m.submissions.owned(req.developer, req.params.id);
    const v = m.submissions.version(req.params.id, req.params.v);
    res.json({ data: { ...m.submissions.shapeVersion(v, { full: true }), review: v.review_id ? m.review.view(m.review.get(v.review_id)) : null, signatures: m.signing.signaturesOf(v.id) } });
  });
  r.patch('/plugins/:id/versions/:v', scoped('version:upload'), validate({ params: z.object({ id: pluginId, v: semverField }), body: z.object({ changelog_md: z.string().max(20000).optional(), permission_justifications: justifications.optional() }).strict() }), wrap(async (req, res) => {
    res.json({ data: await m.submissions.updateVersion(req.developer, req.params.id, req.params.v, req.body, ip(req)) });
  }));
  r.post('/plugins/:id/versions/:v/publish', auth, sec.requireStepUp({ apiKeyScope: 'version:publish' }), validate({ params: z.object({ id: pluginId, v: semverField }), body: z.object({ channel: z.enum(['stable', 'beta']).optional() }).strict() }), (req, res) => {
    res.json({ data: m.submissions.publish(req.developer, req.params.id, req.params.v, req.body, ip(req)) });
  });
  r.post('/plugins/:id/versions/:v/yank', scoped('version:publish'), validate({ params: z.object({ id: pluginId, v: semverField }), body: z.object({ reason: fields.reason }).strict() }), (req, res) => res.json({ data: m.submissions.yank(req.developer, req.params.id, req.params.v, req.body, ip(req)) }));

  // Stats, reviews, money.
  r.get('/plugins/:id/stats', scoped('stats:read'), validate({ params: z.object({ id: pluginId }), query: z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }) }), (req, res) => res.json({ data: m.stats.pluginStats(req.developer, req.params.id, req.query) }));
  r.get('/plugins/:id/reviews', scoped('plugin:read'), validate({ params: z.object({ id: pluginId }) }), (req, res) => res.json({ data: m.pluginReviews.forDeveloper(req.developer, req.params.id) }));
  r.post('/plugins/:id/reviews/:rid/reply', scoped('plugin:write'), validate({ params: z.object({ id: pluginId, rid: idField }), body: z.object({ text: z.string().trim().min(1).max(2000) }).strict() }), (req, res) => res.json({ data: m.pluginReviews.reply(req.developer, req.params.rid, req.body.text, ip(req)) }));
  r.get('/payouts', scoped('stats:read'), (req, res) => res.json({ data: m.payouts.forDeveloper(req.developer.id) }));
  r.get('/payouts/:id/statement.csv', scoped('stats:read'), validate({ params: z.object({ id: idField }) }), (req, res) => res.type('text/csv').send(m.payouts.statementCsv(req.params.id, req.developer.id)));

  // Integration & security.
  r.get('/api-keys', auth, (req, res) => res.json({ data: sec.listApiKeys(req.developer.id) }));
  r.post('/api-keys', auth, stepUp, validate({ body: z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(devScope).min(1).max(10), expires_in_days: z.number().int().min(1).max(3650).optional() }).strict() }), (req, res) => res.status(201).json({ data: sec.createApiKey(req.developer, req.body, ip(req)) }));
  r.delete('/api-keys/:id', auth, validate({ params: z.object({ id: idField }) }), (req, res) => res.json({ data: sec.revokeApiKey(req.developer, req.params.id, ip(req)) }));
  const db = m.db;
  const hookView = (row) => ({ id: row.id, url: row.url, events: json.parse(row.events_json, []), enabled: !!row.enabled, created_at: row.created_at });
  r.get('/webhooks', scoped('webhook:write'), (req, res) => res.json({ data: db.prepare('SELECT * FROM developer_webhooks WHERE developer_id = ? ORDER BY created_at').all(req.developer.id).map(hookView) }));
  r.post('/webhooks', scoped('webhook:write'), validate({ body: z.object({ url: fields.url, events: z.array(z.string().regex(/^(\*|[a-z_]+\.[a-z_]+)$/)).min(1).max(20).default(['*']), secret: z.string().min(16).max(128).optional() }).strict() }), (req, res) => {
    const secret = req.body.secret || ctx.crypto.randomToken(32);
    const id = newId('dwh', m.now());
    db.prepare('INSERT INTO developer_webhooks (id, developer_id, url, secret_enc, events_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, req.developer.id, req.body.url, ctx.crypto.encrypt(secret), JSON.stringify(req.body.events), nowIso(m.now()));
    m.audit({ principal: `developer:${req.developer.id}`, role: 'developer', ip: req.ip, action: 'developer.webhook.create', target: id, args: { url: req.body.url }, result: 'ok' });
    res.status(201).json({ data: { ...hookView(db.prepare('SELECT * FROM developer_webhooks WHERE id = ?').get(id)), secret } });
  });
  r.delete('/webhooks/:id', scoped('webhook:write'), validate({ params: z.object({ id: idField }) }), (req, res) => {
    if (!db.prepare('DELETE FROM developer_webhooks WHERE id = ? AND developer_id = ?').run(req.params.id, req.developer.id).changes) throw notFound('Webhook');
    res.json({ data: { deleted: true } });
  });
  r.get('/webhooks/:id/deliveries', scoped('webhook:write'), validate({ params: z.object({ id: idField }), query: pagination }), (req, res) => {
    if (!db.prepare('SELECT 1 FROM developer_webhooks WHERE id = ? AND developer_id = ?').get(req.params.id, req.developer.id)) throw notFound('Webhook');
    res.json(paginate(db, { select: 'id, event, attempt, status, next_at, last_code, last_error, created_at, delivered_at', from: 'developer_webhook_deliveries', where: ['webhook_id = @wh'], params: { wh: req.params.id }, sortable: { created_at: 'created_at' }, defaultSort: 'created_at', query: { dir: 'desc', ...req.query } }));
  });
  r.post('/webhooks/:id/deliveries/:did/replay', scoped('webhook:write'), validate({ params: z.object({ id: idField, did: z.coerce.number().int().positive() }) }), (req, res) => {
    const row = db.prepare('SELECT d.id FROM developer_webhook_deliveries d JOIN developer_webhooks w ON w.id = d.webhook_id WHERE d.id = ? AND w.id = ? AND w.developer_id = ?').get(req.params.did, req.params.id, req.developer.id);
    if (!row) throw notFound('Delivery');
    replayDelivery(db, { ownerType: 'developer', id: row.id, now: m.now() });
    res.json({ data: { replayed: true } });
  });
  r.get('/sessions', auth, (req, res) => res.json({ data: { sessions: sec.sessions(req.developer.id), events: sec.events(req.developer.id) } }));
  r.delete('/sessions', auth, (req, res) => { const n = sec.revokeSessions(req.developer.id); res.clearCookie(sec.SESSION_COOKIE, { path: '/' }); res.json({ data: { revoked: n } }); });
  return r;
}
