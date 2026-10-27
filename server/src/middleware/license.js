import { HttpError } from '../lib/errors.js';

// Feature flags gate whole API prefixes (403 feature_required). Entries with an
// explicit method match that route exactly (path parameters allowed); `ALL`
// entries cover the prefix and everything under it. The two marketplace rows are
// documented here but applied by the marketplace client per plugin (only when
// the plugin is not free), so the gate skips them.
export const featureGates = {
  'ALL /transfers': 'transfers',
  'ALL /clusters': 'clusters',
  'ALL /dns/zones/import': 'clusters',
  'ALL /server-config/terminal': 'terminal',
  'POST /development/tokens': 'api',
  'PUT /themes/config': 'white_label',
  'POST /marketplace/install': 'marketplace_paid',
  'POST /marketplace/update/:id': 'marketplace_paid',
};
export const manualGates = new Set(['POST /marketplace/install', 'POST /marketplace/update/:id']);

// Mutations that stay allowed while the license is degraded: everything the
// operator needs to rescue data and reach a licensed state again.
export const degradedAllow = [
  'ALL /auth/*', 'ALL /license/*',
  'POST /system/services/:name/restart', 'POST /system/services/:name/start', 'POST /system/services/:name/reload',
  'ALL /backup/*',
  'POST /accounts/:username/unsuspend',
  'GET /plugins/ui', 'GET /plugins/ui/:id/file',
];

export const DEGRADED_ACTION = '/server-configuration/basic-webhost-manager-setup#license';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function compile(pattern) {
  const [method, spec] = pattern.split(' ');
  const base = spec.replace(/\/\*$/, '');
  const prefix = method === 'ALL' || spec.endsWith('/*');
  const re = new RegExp(`^${base.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}${prefix ? '(?:/.*)?' : ''}/?$`);
  return { method, re };
}

export function matchRule(rules, method, path) {
  return rules.find((r) => (r.method === 'ALL' || r.method === method) && r.re.test(path)) || null;
}

const allowRules = degradedAllow.map(compile);
const gateRules = Object.entries(featureGates).filter(([k]) => !manualGates.has(k)).map(([pattern, feature]) => ({ ...compile(pattern), feature }));

export const isAllowedWhileDegraded = (method, path) => Boolean(matchRule(allowRules, method, path));
export const gatedFeatureFor = (method, path) => matchRule(gateRules, method, path)?.feature ?? null;

// Mounted on the /api router right after requireAuth: GETs are never gated; a
// gated feature answers 403; every other mutation answers 423 while degraded.
export function licenseGate(ctx) {
  return (req, res, next) => {
    const license = ctx.license;
    if (!license || !license.enforce()) return next();
    const path = req.path;
    const feature = gatedFeatureFor(req.method, path);
    if (feature && !license.hasFeature(feature)) {
      const l = license.get();
      return next(new HttpError(403, 'feature_required', `Your ${l.editionLabel || 'current'} license does not include "${feature}". Upgrade your license to use this function.`, { feature: [feature] }));
    }
    if (READ_METHODS.has(req.method)) return next();
    if (!license.isDegraded()) return next();
    if (isAllowedWhileDegraded(req.method, path)) return next();
    const l = license.get();
    const why = l.status === 'unlicensed' ? 'This server has no active license' : `The license is ${l.status}${l.reason ? ` (${l.reason})` : ''}`;
    res.status(423).json({ error: { code: 'license_degraded', message: `${why}: the panel is read-only until a valid license is activated. Sites, mail and databases keep running.`, status: l.status, action: DEGRADED_ACTION } });
  };
}

export const requireFeature = (ctx, flag) => (req, res, next) => (ctx.license ? ctx.license.requireFeature(flag)(req, res, next) : next());
