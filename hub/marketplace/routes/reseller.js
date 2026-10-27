import express from 'express';
import { z, validate, fields, wrap } from '../../shared/validate.js';
import { apiKeyAuth, requireScope } from '../../shared/auth.js';
import { pluginId } from './public.js';

// §18.5: a reseller grants plugin entitlements to its own customers' licenses
// within the plugin-level wholesale price (resellers.pricing_json.plugins).
// Mounted under /v1/reseller/market, so the license hub's reseller router has
// already applied its rate limiter; the principal checks are repeated here so
// the route never depends on that mount order.
export function resellerRoutes(m) {
  const r = express.Router();
  r.use(apiKeyAuth({ ownerType: 'reseller' }));
  r.post('/entitlements', requireScope('license:issue'), validate({ body: z.object({ license_id: fields.id, plugin_id: pluginId, expires_at: z.string().datetime().nullable().optional() }).strict() }), wrap(async (req, res) => {
    const by = req.principal.type === 'api_key' ? `apikey:${req.principal.keyId}` : `portal:${req.principal.userId}`;
    const out = m.billing.resellerGrant(req.principal.ownerId, { ...req.body, expires_at: req.body.expires_at || null }, { by, ip: req.ip });
    res.status(201).json({ data: out });
  }));
  return r;
}
