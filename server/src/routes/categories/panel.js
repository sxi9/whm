import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRole, requireRoot, requireReseller, requireScope } from '../../middleware/rbac.js';
import { HttpError } from '../../lib/errors.js';
import { createPanelService, LOGIN_AS_TTL } from '../../services/panel.js';
import { createPanelSsoService, SSO_KINDS, SSO_TOKEN_RE } from '../../services/panel-sso.js';
import { PANEL_SCOPES, confinePanelTokens, wrap, created } from '../panel/index.js';
import { LOCALE_CODE_RE } from '../../services/locales-xml.js';

const ssoParams = z.object({ kind: z.enum(SSO_KINDS), token: z.string().regex(SSO_TOKEN_RE) });
const webmailSsoBody = z.object({ enabled: z.boolean().optional(), loginAs: z.boolean().optional() }).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');

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
const domainParam = z.object({ domain: fields.domain });
const contactBody = z.object({
  email: fields.email,
  email2: z.union([z.literal(''), fields.email]).nullable().optional().transform((v) => (v ? v : null)),
  notify: z.object({ quota: z.boolean().optional(), bandwidth: z.boolean().optional(), passwordChange: z.boolean().optional() }).strict().prefault({}),
  // Required by the service unless an administrator is acting as the account.
  currentPassword: z.string().min(1).max(256).optional(),
}).strict();
const localeBody = z.object({ locale: z.union([z.literal(''), z.string().regex(LOCALE_CODE_RE, 'A locale code such as "es" or "pt_br"')]).nullable() }).strict();

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
    if (mode === 'user') {
      try { ctx.panel.assertTwoFactor(req.user, req.path); } catch (err) { return next(err); }
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
  ctx.panelSso = createPanelSsoService(ctx);
  const s = ctx.panel;
  s.subscribe();
  const backfilled = s.backfill();
  if (backfilled.created || backfilled.adopted) ctx.logger.info(backfilled, 'panel: linked account users');
  if (ctx.confinedScopes?.prefixes) confinePanelTokens(ctx);
  else ctx.logger.warn('panel: API tokens are not confined to /api/panel (core requireAuth has no prefix confinement yet)');

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
  admin.post('/accounts/:username/2fa/reset', validate({ params: nameParam }), wrap((req) => s.adminReset2fa(req.params.username, req.user, req)));
  admin.post('/domains/:domain/release-mail', requireRoot, validate({ params: domainParam }), wrap((req) => s.releaseMailDomain(req.params.domain, req)));
  admin.get('/webmail/sso', requireRoot, wrap(() => ctx.web.webmail.sso.status()));
  admin.put('/webmail/sso', requireRoot, validate({ body: webmailSsoBody }), wrap((req) => ctx.web.webmail.sso.set(req.body, req)));
  r.use('/admin', admin);

  // --- Loopback sign-on exchange (§44; no session: the caller is the published
  // app's signon code on this host, holding a token the panel just minted) ----
  const sso = Router();
  sso.get('/:kind/:token', validate({ params: ssoParams }), wrap((req) => ctx.panelSso.exchange(req.params.kind, req.params.token, req)));

  // --- Scoped (one account per session) ---------------------------------------------------
  r.use(panelScope(ctx));
  r.get('/me', wrap((req) => s.me(req)));
  // Preferences (P1-8): the contact address is also the forgot-password
  // address, so it changes from a browser session only, never through a
  // token, and only with the current password (checked in the service).
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'API tokens can only be managed from a browser session')) : next());
  r.put('/me/contact', sessionOnly, validate({ body: contactBody }), wrap((req) => s.preferences.setContact(req.panel, req.body, req)));
  r.put('/me/locale', validate({ body: localeBody }), wrap((req) => s.preferences.setLocale(req.panel, req.body, req)));
  r.get('/overview/quick-links', wrap((req) => s.quickLinks(req)));
  // /tokens* is the browser's credential manager (§2.4, §4.13): a token may
  // read the list with panel:read but never mint or revoke tokens.
  r.get('/tokens', requireScope('panel:read'), wrap((req) => s.tokens.list(req.panel)));
  r.post('/tokens', sessionOnly, validate({ body: tokenBody }), created((req) => s.tokens.create(req.panel, req.body, req)));
  r.get('/tokens/:id', requireScope('panel:read'), validate({ params: idParam }), wrap((req) => s.tokens.get(req.panel, req.params.id)));
  r.delete('/tokens/:id', sessionOnly, validate({ params: idParam }), wrap((req) => s.tokens.remove(req.panel, req.params.id, req)));

  for (const mount of await loadSubRouters(ctx)) {
    r.use(mount.path, mount.router);
    ctx.logger.debug({ file: mount.file, path: `/panel${mount.path}` }, 'mounted panel router');
  }

  return [{ path: '/panel/sso', router: sso, public: true }, { path: '/panel', router: r }];
}
