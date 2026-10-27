import fs from 'node:fs';
import express from 'express';
import { z, validate, fields, wrap } from '../../shared/validate.js';
import { sdk } from '../lib/package.js';

export const pluginId = z.string().max(128).regex(sdk.ID_PATTERN, 'Malformed plugin id');
export const semverField = z.string().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, 'Must be semver');
const channel = z.enum(['stable', 'beta']);
const signedBase = { token: fields.token, nonce: fields.nonce, ts: fields.ts };

const catalogQuery = z.object({
  q: z.string().trim().max(200).optional(), category: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), channel: channel.default('stable'),
  page: fields.page, pageSize: z.coerce.number().int().min(1).max(100).default(24), sort: z.enum(['installs', 'rating', 'updated', 'name']).default('installs'), dir: fields.sortDir.default('desc'), featured: z.coerce.boolean().optional(),
});
// §18.4: a descriptor is issued only to the machine the activation belongs to.
const downloadBody = z.object({ plugin_id: pluginId, version: semverField.optional(), channel: channel.optional(), fingerprint: fields.fingerprint, fp_components: fields.fpComponents.optional(), panel_version: fields.panelVersion.optional(), host_api: semverField.optional(), ...signedBase }).strict();
const updatesBody = z.object({ installed: z.array(z.object({ id: pluginId, version: z.string().max(64) }).strict()).max(500), host: semverField.optional(), channel: channel.optional(), ...signedBase }).strict();
const revocationsBody = z.object({ since: z.number().int().min(0).default(0), ...signedBase }).strict();
const reviewBody = z.object({ rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).optional(), body: z.string().trim().max(4000).optional(), ...signedBase }).strict();

// §18.4: public GET catalog (unsigned, cached) and the signed POST panel API.
export function publicRoutes(m) {
  const { ctx } = m;
  const r = express.Router();
  const { signed, limiters } = ctx.app;
  const cache = (res, s = 300) => res.set('Cache-Control', `public, max-age=${s}`);
  const etag = (res, body) => { const tag = `"${ctx.crypto.hashToken(JSON.stringify(body)).slice(0, 32)}"`; res.set('ETag', tag); return tag; };
  const sendCached = (req, res, body, maxAge) => {
    cache(res, maxAge);
    const tag = etag(res, body);
    if (req.get('if-none-match') === tag) return res.status(304).end();
    return res.json(body);
  };

  r.get('/catalog', limiters.public, validate({ query: catalogQuery }), (req, res) => sendCached(req, res, m.catalog.catalog(req.query), 120));
  r.get('/categories', limiters.public, (req, res) => sendCached(req, res, { data: m.catalog.categories() }, 600));
  r.get('/plugins/:id', limiters.public, validate({ params: z.object({ id: pluginId }), query: z.object({ host: semverField.optional() }) }), (req, res) => sendCached(req, res, { data: m.catalog.detail(req.params.id, { host: req.query.host }) }, 120));
  r.get('/plugins/:id/versions', limiters.public, validate({ params: z.object({ id: pluginId }) }), (req, res) => sendCached(req, res, { data: m.catalog.versions(req.params.id) }, 120));
  r.get('/keys', limiters.public, (req, res) => sendCached(req, res, { data: m.catalog.keys() }, 300));
  r.get('/assets/:id/:file', limiters.public, validate({ params: z.object({ id: pluginId, file: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/) }) }), (req, res) => {
    const a = m.submissions.assetFile(req.params.id, req.params.file);
    cache(res, 3600);
    // Developer-uploaded images (SVG included) are served from the portal origin:
    // a route-level sandbox keeps them inert even if the app-wide CSP ever relaxes.
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.set('Content-Disposition', `inline; filename="${req.params.file}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(a.content_type).sendFile(a.file);
  });

  // Signed panel API: the nonce/timestamp checks and the license-key signature come from ctx.app.signed.
  r.post('/download', ...signed(validate({ body: downloadBody }), wrap(async (req, res) => {
    res.json({ data: m.distribution.descriptor(req.body, { ip: req.ip }) });
  })));
  r.post('/updates', ...signed(validate({ body: updatesBody }), wrap(async (req, res) => {
    res.json({ data: m.distribution.updates(req.body, { ip: req.ip }), meta: { now: Math.floor(m.now() / 1000) } });
  })));
  r.post('/revocations', ...signed(validate({ body: revocationsBody }), wrap(async (req, res) => {
    const { activation } = m.distribution.resolvePanel({ token: req.body.token });
    m.limits.assert(`revocations:${activation.id}`, m.cfg.rate_limits.feed.max, m.cfg.rate_limits.feed.windowMs, 'Revocation feed limit reached for this activation');
    const feed = m.revocations.feed(req.body.since);
    res.json({ data: feed.data, meta: { now: Math.floor(m.now() / 1000), head_ts: feed.head_ts } });
  })));
  r.post('/plugins/:id/reviews', ...signed(validate({ params: z.object({ id: pluginId }), body: reviewBody }), wrap(async (req, res) => {
    res.status(201).json({ data: m.pluginReviews.submit({ token: req.body.token }, req.params.id, req.body, { ip: req.ip }) });
  })));

  // The descriptor URL: single use, HMAC-bound to the activation.
  r.get('/packages/:dl', limiters.public, validate({ params: z.object({ dl: z.string().regex(/^dl_[0-9A-Z]{18}$/) }), query: z.object({ exp: z.coerce.number().int(), sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }) }), (req, res) => {
    const out = m.distribution.serve(req.params.dl, req.query, { ip: req.ip });
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    res.set('X-Checksum-Sha256', out.sha256);
    res.set('Content-Length', String(out.bytes));
    fs.createReadStream(out.file).pipe(res);
  });

  // Customer checkout helpers (§18.5): magic link issue (signed, token-bound) and consumption.
  r.post('/magic-links', ...signed(validate({ body: z.object({ plugin_id: pluginId.optional(), ...signedBase }).strict() }), wrap(async (req, res) => {
    const { license } = m.distribution.resolvePanel({ token: req.body.token });
    res.status(202).json({ data: { accepted: m.billing.issueMagicLink({ customer_id: license.customer_id, plugin_id: req.body.plugin_id || null, license_id: license.id }, { ip: req.ip }).accepted } });
  })));
  r.post('/magic-links/:token', limiters.public, validate({ params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) }), body: z.object({ email: fields.email }).strict() }), (req, res) => {
    // The request audit records req.params as the target; a still-valid token must not land there.
    const token = req.params.token;
    req.params = { token: `sha256:${ctx.crypto.hashToken(token).slice(0, 16)}` };
    res.json({ data: m.billing.consumeMagicLink(token, { email: req.body.email, ip: req.ip }) });
  });
  return r;
}
