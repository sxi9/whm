import { Router } from 'express';
import { validate, z, fields } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import { badRequest, notFound, unauthorized, conflict, HttpError } from '../lib/errors.js';
import { constantTimeEqual } from '../lib/crypto.js';

const providerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

export function authRoutes(ctx) {
  const { auth, crypto, settings } = ctx;
  const r = Router();

  // Turns an accepted login into a session, applying the session policy.
  function establish(req, result) {
    const { user, mustEnroll2fa = false } = result;
    return new Promise((resolve, reject) => {
      if (auth.policy().disallowConcurrentSessions) ctx.sessionStore.destroyUserSessions(user.id);
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = user.id;
        req.session.lastActivity = Date.now();
        req.session.mustEnroll2fa = Boolean(mustEnroll2fa);
        delete req.session.pending2fa;
        delete req.session.pendingNewIp;
        resolve({ user, csrfToken: issueCsrfToken(req, crypto), mustEnroll2fa: Boolean(mustEnroll2fa), newIp: Boolean(result.newIp) });
      });
    });
  }

  r.get('/csrf', (req, res) => res.json({ data: { csrfToken: issueCsrfToken(req, crypto) } }));

  r.post('/login', validate({ body: z.object({ username: fields.username, password: z.string().min(1).max(256) }).strict() }), async (req, res, next) => {
    try {
      const result = await auth.login({ ...req.body, ip: req.ip });
      if (result.pending2fa) {
        req.session.pending2fa = result.userId;
        req.session.pendingNewIp = Boolean(result.newIp);
        return res.json({ data: { requires2fa: true } });
      }
      req.audit({ action: 'auth.login', target: req.body.username, args: result.newIp ? { newIp: true } : null });
      res.json({ data: await establish(req, result) });
    } catch (err) { next(err); }
  });

  r.post('/2fa', validate({ body: z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict() }), async (req, res, next) => {
    try {
      if (!req.session.pending2fa) throw badRequest('No login is awaiting verification');
      const result = await auth.verify2fa({ userId: req.session.pending2fa, code: req.body.code, ip: req.ip, newIp: Boolean(req.session.pendingNewIp) });
      req.user = result.user;
      req.audit({ action: 'auth.login.2fa', target: result.user.username, args: result.newIp ? { newIp: true } : null });
      res.json({ data: await establish(req, result) });
    } catch (err) { next(err); }
  });

  r.post('/logout', (req, res) => {
    const username = req.user?.username;
    req.session.destroy(() => {
      res.clearCookie('whm.sid');
      res.json({ data: { loggedOut: true, username } });
    });
  });

  r.get('/me', requireAuth, (req, res) => {
    // First-run wizard: root only, until Setup completes (or skips) it. Carried
    // on the user too so the shell can route on it without a context change.
    const setupPending = Boolean(ctx.stack?.setup?.pending?.(req.user));
    const me = auth.publicUser(req.user);
    res.json({ data: {
      user: { ...me, setupPending }, csrfToken: issueCsrfToken(req, crypto), hostname: settings.get('basic.hostname'),
      setupPending,
      // The panel owner: the only user who sees the license hub and key.
      superadmin: me.superadmin,
      mustEnroll2fa: Boolean(req.session?.mustEnroll2fa), policy: auth.policy(),
      // The Server Profile decides which sidebar categories the shell shows.
      profile: ctx.serverConfig?.profile?.summary?.() ?? { name: 'standard', hiddenCategories: [] },
      // Grace/degraded banner in the shell.
      license: ctx.license?.summaryForShell?.() ?? { status: 'unlicensed', edition: null, daysLeft: null, enforce: false, degraded: true },
    } });
  });

  r.post('/password', requireAuth, validate({ body: z.object({ currentPassword: z.string().max(256).optional(), newPassword: fields.password }).strict() }), async (req, res, next) => {
    try {
      await auth.changePassword(req.user.id, { ...req.body, force: Boolean(req.user.must_change_password) });
      req.audit({ action: 'auth.password.change', target: req.user.username });
      // Sessions were invalidated; re-establish this one.
      res.json({ data: await establish(req, { user: auth.publicUser({ ...req.user, must_change_password: 0 }), mustEnroll2fa: req.session.mustEnroll2fa }) });
    } catch (err) { next(err); }
  });

  r.post('/2fa/enroll', requireAuth, (req, res) => res.json({ data: auth.begin2faEnrollment(req.user.id) }));
  r.post('/2fa/confirm', requireAuth, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }), (req, res, next) => {
    try {
      auth.confirm2faEnrollment(req.user.id, req.body.code);
      if (req.session) req.session.mustEnroll2fa = false;
      req.audit({ action: 'auth.2fa.enable', target: req.user.username });
      res.json({ data: { enabled: true } });
    } catch (err) { next(err); }
  });
  r.post('/2fa/disable', requireAuth, (req, res, next) => {
    try { auth.disable2fa(req.user.id); req.audit({ action: 'auth.2fa.disable', target: req.user.username }); res.json({ data: { enabled: false } }); } catch (err) { next(err); }
  });

  // External (OpenID Connect) login. Providers are managed in Security Center ›
  // Manage External Authentications; these public routes run the browser flow.
  const external = () => ctx.security?.externalAuth || null;
  const redirectUri = (req, name) => `${req.protocol}://${req.get('host')}/api/auth/external/${encodeURIComponent(name)}/callback`;
  const backToLogin = (res, params) => res.redirect(`/login?${new URLSearchParams(params).toString()}`);

  r.get('/external', (_req, res) => {
    const ea = external();
    const providers = ea ? ea.list().filter((p) => p.enabled && p.discovery?.authorizationEndpoint).map((p) => ({ name: p.name, displayName: p.displayName })) : [];
    res.json({ data: { providers } });
  });

  r.get('/external/:name/start', validate({ params: z.object({ name: providerName }), query: z.object({ link: z.enum(['1']).optional() }) }), (req, res, next) => {
    try {
      const ea = external();
      if (!ea) throw notFound('External authentication');
      const link = Boolean(req.query.link);
      if (link && !req.user) throw unauthorized('Log in before linking an external identity');
      const state = crypto.randomToken(24);
      const nonce = crypto.randomToken(24);
      req.session.oidc = { name: req.params.name, state, nonce, link, userId: req.user?.id ?? null, at: Date.now() };
      res.redirect(ea.authorizationUrl(req.params.name, { state, nonce, redirectUri: redirectUri(req, req.params.name) }));
    } catch (err) { next(err); }
  });

  r.get('/external/:name/callback', validate({
    params: z.object({ name: providerName }),
    query: z.object({ code: z.string().min(1).max(4096).optional(), state: z.string().min(1).max(256).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() }),
  }), async (req, res, next) => {
    try {
      const ea = external();
      if (!ea) throw notFound('External authentication');
      const pending = req.session.oidc;
      delete req.session.oidc;
      if (req.query.error) return backToLogin(res, { error: 'external_denied', message: req.query.error_description || req.query.error });
      const stale = !pending || pending.name !== req.params.name || !req.query.state || !req.query.code || !constantTimeEqual(pending.state, req.query.state) || Date.now() - pending.at > OIDC_STATE_TTL_MS;
      if (stale) return backToLogin(res, { error: 'external_state' });
      const identity = await ea.exchangeCode(req.params.name, { code: req.query.code, redirectUri: redirectUri(req, req.params.name), nonce: pending.nonce });

      if (pending.link) {
        if (!req.user || req.user.id !== pending.userId) return backToLogin(res, { error: 'external_state' });
        const existing = ea.findLinkedUser(req.params.name, identity.subject);
        const existingUserId = existing ? (existing.user_id ?? existing.userId) : null;
        if (existing && existingUserId !== req.user.id) throw conflict('That external identity is already linked to another panel user');
        if (!existing) ea.link(req.params.name, { userId: req.user.id, subject: identity.subject, email: identity.email });
        req.audit({ action: 'auth.external.link', target: req.params.name, args: { subject: identity.subject } });
        return res.redirect('/security-center/manage-external-authentications?linked=1');
      }

      const linked = ea.findLinkedUser(req.params.name, identity.subject);
      if (!linked) return backToLogin(res, { error: 'external_not_linked', provider: req.params.name });
      const result = await auth.externalLogin({ userId: linked.user_id ?? linked.userId, ip: req.ip, provider: req.params.name });
      if (result.pending2fa) {
        req.session.pending2fa = result.userId;
        req.session.pendingNewIp = Boolean(result.newIp);
        return res.redirect('/login?stage=2fa');
      }
      req.user = result.user;
      req.audit({ action: 'auth.login.external', target: result.user.username, args: { provider: req.params.name, newIp: result.newIp } });
      await establish(req, result);
      res.redirect('/');
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) return backToLogin(res, { error: 'external_failed', message: err.message });
      next(err);
    }
  });

  return r;
}
