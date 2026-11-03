import { Router } from 'express';
import { z } from '../../lib/validate.js';
import { requireScope } from '../../middleware/rbac.js';
import { HttpError } from '../../lib/errors.js';

// Shared by every /api/panel sub-router (routes/panel/<name>.js). A sub-router
// module exports `register(ctx) -> { path: '/<name>', router }` and is mounted by
// routes/categories/panel.js behind the panelScope middleware, so every handler
// finds the pinned account in req.panel.

export const PANEL_SCOPES = ['panel:read', 'panel:files', 'panel:email', 'panel:dns', 'panel:databases', 'panel:backups', 'panel:cron', 'panel:domains', 'panel:ssl', 'panel:php', 'panel:logs'];

// §3.4: a token whose scopes are all panel:* may call nothing but the panel and
// GET /api/auth/me (middleware/auth.js honours the prefix entry when the
// registry is marked `prefixes = true`, which core does at bootstrap).
export const PANEL_TOKEN_ROUTES = Object.freeze([{ path: '/api/panel', prefix: true }, { method: 'GET', path: '/api/auth/me' }]);
export function confinePanelTokens(ctx) {
  ctx.confinedScopes ??= new Map();
  for (const scope of PANEL_SCOPES) ctx.confinedScopes.set(scope, [...PANEL_TOKEN_ROUTES]);
  return ctx.confinedScopes;
}

// A path relative to the account's home (or public_html): no leading "/", no
// leading "-", no ".." segment, no NUL or newline, at most 512 characters.
export const REL_PATH_RE = /^(?!-)(?!.*(^|\/)\.\.(\/|$))[^\0\n]{1,512}$/;
export const relPath = z.string().regex(REL_PATH_RE, 'A relative path without ".." segments; must not start with "-" or "/"').refine((p) => !p.startsWith('/'), 'Must be relative to your home directory');

export const featureDisabled = (key) => new HttpError(403, 'feature_disabled', `Your hosting package does not include "${key}"`);
export const limitReached = (key, max) => new HttpError(409, 'limit_reached', `Your hosting package allows at most ${max} ${key.replace(/^max_/, '').replace(/_/g, ' ')}`);

// Package features default to enabled (cPanel semantics): only an explicit false disables one.
export const featureEnabled = (scope, key) => scope?.features?.[key] !== false;
export function assertFeature(scope, key) {
  if (!featureEnabled(scope, key)) throw featureDisabled(key);
}
// Plan limits: null/undefined means unlimited. `count` is what the account has now.
export function assertLimit(scope, key, count) {
  const max = scope?.account?.plan?.[key];
  if (max == null) return;
  if (count >= max) throw limitReached(key, max);
}
export const requireFeature = (key) => (req, _res, next) => next(featureEnabled(req.panel, key) ? undefined : featureDisabled(key));

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
export const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);
export const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(202).json({ data: d })).catch(next);

// A router for one panel group: API tokens scoped to panel:* need the group's
// scope (panel:read is enough for reads); session logins pass unchanged.
export function panelRouter(ctx, name) {
  const r = Router();
  const scope = `panel:${name}`;
  if (!PANEL_SCOPES.includes(scope) && name !== 'read') ctx?.logger?.debug?.({ scope }, 'panel router without a token scope');
  r.use((req, res, next) => {
    if (req.auth?.via !== 'token') return next();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return requireScope('panel:read')(req, res, (err) => (err ? requireScope(scope)(req, res, next) : next()));
    return requireScope(scope)(req, res, next);
  });
  return r;
}
