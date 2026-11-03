import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRole, requireRoot, requireReseller } from '../../middleware/rbac.js';
import { HttpError } from '../../lib/errors.js';
import { createPanelService, LOGIN_AS_TTL } from '../../services/panel.js';
import { PANEL_SCOPES, wrap, created } from '../panel/index.js';

const panelDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel');

const nameParam = z.object({ username: fields.username });
const idParam = z.object({ id: fields.id });
const tokenName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()\/-]{0,63}$/, 'Letters, digits, spaces, "." "_" "-" "(" ")" or "/"; max 64 chars');
const tokenBody = z.object({
  name: tokenName,
  scopes: z.array(z.enum(PANEL_SCOPES)).max(PANEL_SCOPES.length).default([]),
  expiresAt: z.string().datetime({ offset: true }).refine((d) => new Date(d).getTime() > Date.now(), 'Expiry must be in the future').optional(),
}).strict();
const settingsBody = z.object({
  enabled: z.boolean().optional(),
  require2faForUsers: z.boolean().optional(),
  loginAsTtlMinutes: z.number().int().min(LOGIN_AS_TTL.min).max(LOGIN_AS_TTL.max).optional(),
  webmailUrl: z.union([z.literal(''), z.url().max(2048).refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL')]).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const adminUserBody = z.object({ password: fields.password.optional() }).strict();
const adminPasswordBody = z.object({ password: fields.password }).strict();

// Runs scope() once per request and applies the §2.3–§2.5 gates. Only the
// paths listed stay reachable while a gate is closed.
const FORCE_PASSWORD_PATHS = new Set(['/me', '/security/password']);
export function panelScope(ctx) {
  return (req, _res, next) => {
    try {
      req.panel = ctx.panel.scope(req);
    } catch (err) { return next(err); }
    const { account, mode } = req.panel;
    if (account.suspended) return next(new HttpError(423, 'account_suspended', 'This account is suspended'));
    if (account.demo_mode && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next(new HttpError(403, 'demo_mode', 'This account is in demo mode; changes are not saved'));
    if (account.force_password_change && mode === 'user' && !FORCE_PASSWORD_PATHS.has(req.path)) {
      return next(new HttpError(403, 'password_change_required', 'You must change your password before continuing'));
    }
    if (mode === 'user' && ctx.settings.get('panel.require_2fa_for_users') && !req.user.totp_enabled && req.path !== '/me' && !req.path.startsWith('/security/two-factor')) {
      return next(new HttpError(403, 'two_factor_required', 'Two-factor authentication is required for your account. Set it up to continue.'));
    }
    next();
  };
}

// Sub-routers (routes/panel/<group>.js) are built by other units and may not
// exist on this tree yet; a missing file is fine, a broken one only fails a
// production boot.
async function loadSubRouters(ctx) {
  const files = fs.existsSync(panelDir) ? fs.readdirSync(panelDir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort() : [];
  const mounts = [];
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(panelDir, file)).href);
      if (typeof mod.register !== 'function') throw new Error('must export register(ctx)');
      for (const mount of [].concat(await mod.register(ctx)).filter(Boolean)) {
        if (!mount.path || !mount.router) throw new Error('register() must return { path, router }');
        mounts.push({ ...mount, file });
      }
    } catch (err) {
      if (ctx.config.env === 'production') throw new Error(`routes/panel/${file}: ${err.message}`);
      ctx.logger.warn({ err, file }, 'panel sub-router not mounted');
    }
  }
  return mounts;
}

export async function register(ctx) {
  ctx.panel = createPanelService(ctx);
  const s = ctx.panel;
  s.subscribe();
  const backfilled = s.backfill();
  if (backfilled.created || backfilled.adopted) ctx.logger.info(backfilled, 'panel: linked account users');

  const r = Router();
  r.use(requireRole('user', 'root', 'reseller'));
  r.use((req, _res, next) => {
    if (s.settings.enabled() || req.path === '/admin/settings') return next();
    next(new HttpError(403, 'panel_disabled', 'The account panel is disabled on this server'));
  });

  // --- Admin (root/reseller; never behind panelScope) -------------------------------------
  const admin = Router();
  admin.use(requireReseller);
  admin.get('/settings', requireRoot, wrap(() => s.settings.get()));
  admin.put('/settings', requireRoot, validate({ body: settingsBody }), wrap((req) => s.settings.update(req.body, req)));
  admin.get('/login-as/history', validate({ query: pagination }), wrap((req) => s.loginAsHistory(req.query, req.user)));
  admin.post('/login-as/:username', validate({ params: nameParam }), wrap((req) => s.loginAs(req.params.username, req.user, req)));
  admin.post('/logout-as', wrap((req) => s.logoutAs(req)));
  admin.get('/accounts/:username/user', validate({ params: nameParam }), wrap((req) => s.userStatus(req.params.username, req.user)));
  admin.post('/accounts/:username/user', validate({ params: nameParam, body: adminUserBody }), created((req) => s.adminEnsureUser(req.params.username, req.body, req.user, req)));
  admin.post('/accounts/:username/password', validate({ params: nameParam, body: adminPasswordBody }), wrap((req) => s.adminSetPassword(req.params.username, req.body.password, req.user, req)));
  r.use('/admin', admin);

  // --- Scoped (one account per session) ---------------------------------------------------
  r.use(panelScope(ctx));
  r.get('/me', wrap((req) => s.me(req)));
  r.get('/overview/quick-links', wrap((req) => s.quickLinks(req)));
  r.get('/tokens', wrap((req) => s.tokens.list(req.panel)));
  r.post('/tokens', validate({ body: tokenBody }), created((req) => s.tokens.create(req.panel, req.body, req)));
  r.get('/tokens/:id', validate({ params: idParam }), wrap((req) => s.tokens.get(req.panel, req.params.id)));
  r.delete('/tokens/:id', validate({ params: idParam }), wrap((req) => s.tokens.remove(req.panel, req.params.id, req)));

  for (const mount of await loadSubRouters(ctx)) {
    r.use(mount.path, mount.router);
    ctx.logger.debug({ file: mount.file, path: `/panel${mount.path}` }, 'mounted panel router');
  }

  return { path: '/panel', router: r };
}
