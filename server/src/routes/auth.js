import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate, z, fields } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import { badRequest, notFound, unauthorized, conflict, HttpError } from '../lib/errors.js';
import { constantTimeEqual } from '../lib/crypto.js';
import { redirectHostname } from '../middleware/tls-redirect.js';
import { accountPanelUrl, adminLoginUrl as adminLoginUrlFor } from '../middleware/shell.js';

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

  // The account-panel listeners (middleware/shell.js) sign in account users
  // only: services/auth.js refuses an administrator or reseller with a
  // wrong_port error before recording the login, and the route tells them
  // where their shell lives. The administration shell accepts every role.
  const adminLoginUrl = (req) => adminLoginUrlFor(ctx.config, redirectHostname(req.get('host')) || settings.get('basic.hostname'));
  const isWrongPort = (err) => err instanceof HttpError && err.code === 'wrong_port' && Boolean(err.user);
  const auditWrongPort = (req, err, args) => req.audit({ action: 'auth.login.wrong_port', target: err.user.username, args: { role: err.user.role, ...args }, result: 'refused' });
  const wrongPort = (req, res, err, via) => {
    auditWrongPort(req, err, { via });
    delete req.session.pending2fa;
    delete req.session.pendingNewIp;
    res.status(403).json({ error: { code: 'wrong_port', message: err.message, adminUrl: adminLoginUrl(req) } });
  };

  r.post('/login', validate({ body: z.object({ username: fields.username, password: z.string().min(1).max(256) }).strict() }), async (req, res, next) => {
    try {
      const result = await auth.login({ ...req.body, ip: req.ip, shell: req.shell });
      if (result.pending2fa) {
        req.session.pending2fa = result.userId;
        req.session.pendingNewIp = Boolean(result.newIp);
        return res.json({ data: { requires2fa: true } });
      }
      req.audit({ action: 'auth.login', target: req.body.username, args: result.newIp ? { newIp: true } : null });
      res.json({ data: await establish(req, result) });
    } catch (err) {
      if (isWrongPort(err)) return wrongPort(req, res, err, 'password');
      next(err);
    }
  });

  r.post('/2fa', validate({ body: z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict() }), async (req, res, next) => {
    try {
      if (!req.session.pending2fa) throw badRequest('No login is awaiting verification');
      const result = await auth.verify2fa({ userId: req.session.pending2fa, code: req.body.code, ip: req.ip, newIp: Boolean(req.session.pendingNewIp), shell: req.shell });
      req.user = result.user;
      req.audit({ action: 'auth.login.2fa', target: result.user.username, args: result.newIp ? { newIp: true } : null });
      res.json({ data: await establish(req, result) });
    } catch (err) {
      if (isWrongPort(err)) return wrongPort(req, res, err, '2fa');
      next(err);
    }
  });

  r.post('/logout', (req, res) => {
    const username = req.user?.username;
    req.session.destroy(() => {
      res.clearCookie('whm.sid');
      res.json({ data: { loggedOut: true, username } });
    });
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ data: {
      user: auth.publicUser(req.user), csrfToken: issueCsrfToken(req, crypto), hostname: settings.get('basic.hostname'),
      mustEnroll2fa: Boolean(req.session?.mustEnroll2fa), policy: auth.policy(),
      // Which listener served this session; administrators also get the
      // account holders' sign-in address for the Account panel settings page.
      shell: req.shell || 'admin',
      panelUrl: req.user.role === 'user' ? undefined : `${accountPanelUrl(ctx.config, settings.get('basic.hostname') || redirectHostname(req.get('host')) || 'localhost')}/`,
      // The Server Profile decides which sidebar categories the shell shows.
      profile: ctx.serverConfig?.profile?.summary?.() ?? { name: 'standard', hiddenCategories: [] },
      // Grace/degraded banner in the shell.
      license: ctx.license?.summaryForShell?.() ?? { status: 'unlicensed', edition: null, daysLeft: null, enforce: false, degraded: true },
    } });
  });

  r.post('/password', requireAuth, validate({ body: z.object({ currentPassword: z.string().max(256).optional(), newPassword: fields.password }).strict() }), async (req, res, next) => {
    try {
      // A login linked to a hosting account changes both stores (host first)
      // through the panel; the panel answers null for every other login.
      const input = { ...req.body, force: Boolean(req.user.must_change_password) };
      const r = await ctx.panel?.changePasswordForUser?.(req.user.id, input, req);
      if (!r) await auth.changePassword(req.user.id, input);
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
  r.post('/2fa/disable', requireAuth, validate({ body: z.object({ password: z.string().max(1024).optional(), code: z.string().regex(/^\d{6}$/).optional() }).strict() }), async (req, res, next) => {
    try {
      await auth.disable2fa(req.user.id, req.body);
      req.audit({ action: 'auth.2fa.disable', target: req.user.username, args: { via: req.body.code ? 'code' : 'password' } });
      res.json({ data: { enabled: false } });
    } catch (err) { next(err); }
  });

  // Forgot-password for account users (customer panel, ctx.panel.recovery).
  // Public; the browser fetches /csrf first like any session-less mutation.
  // The request answers 202 whatever happened, so it cannot be used to
  // enumerate logins; the limiter mirrors the login one.
  const recovery = () => ctx.panel?.recovery || null;
  const resetLimiter = rateLimit({ windowMs: ctx.config.loginRateLimit.windowMs, limit: ctx.config.loginRateLimit.max, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many password reset attempts, please wait' } } });
  const resetRequestBody = z.object({ username: fields.username.optional(), email: fields.email.optional() }).strict()
    .refine((b) => Boolean(b.username) !== Boolean(b.email), 'Enter your username or your e-mail address');
  const resetConfirmBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'Malformed reset token'), password: fields.password }).strict();

  r.get('/reset', (_req, res) => res.json({ data: { enabled: Boolean(recovery()?.available()) } }));
  r.post('/reset/request', resetLimiter, validate({ body: resetRequestBody }), async (req, res, next) => {
    try {
      const rc = recovery();
      if (rc) await rc.request(req.body, req);
      res.status(202).json({ data: { accepted: true } });
    } catch (err) { next(err); }
  });
  r.post('/reset/confirm', resetLimiter, validate({ body: resetConfirmBody }), async (req, res, next) => {
    try {
      const rc = recovery();
      if (!rc) throw notFound('Password reset');
      res.json({ data: await rc.confirm(req.body, req) });
    } catch (err) { next(err); }
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
      const result = await auth.externalLogin({ userId: linked.user_id ?? linked.userId, ip: req.ip, provider: req.params.name, shell: req.shell });
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
      if (isWrongPort(err)) {
        auditWrongPort(req, err, { via: 'external', provider: req.params.name });
        // The admin sign-in link never travels through the location: the login
        // page takes it from the branding response, not from a query string.
        return backToLogin(res, { error: 'wrong_port', message: err.message });
      }
      if (err instanceof HttpError && err.status < 500) return backToLogin(res, { error: 'external_failed', message: err.message });
      next(err);
    }
  });

  return r;
}
