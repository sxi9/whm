import express from 'express';
import { z, validate, fields, pagination, wrap } from '../../shared/validate.js';
import { HttpError, unauthorized } from '../../shared/errors.js';
import { issueCsrfToken, requireRole, PORTAL_ROLES } from '../../shared/auth.js';

// Portal sessions for hub/ui: password + TOTP login, step-up, 2FA enrolment,
// password change and (vendor_admin) portal user management. Vendor users then
// call /v1/admin/*, reseller users /v1/reseller/*, with the same session.
export function portalRoutes(ctx) {
  const r = express.Router();
  const requireSession = (req, _res, next) => (req.principal?.type === 'portal' ? next() : next(unauthorized('Sign in first')));
  const me = (req) => ({ user: ctx.portalUsers.publicView(ctx.portalUsers.get(req.principal.userId)), totp_verified_at: req.session.totpVerifiedAt || null, csrfToken: issueCsrfToken(req, ctx.crypto) });

  r.post('/login', ctx.app.limiters.portalLogin, validate({ body: z.object({ email: fields.email, password: z.string().min(1).max(128), totp: z.string().regex(/^\d{6}$/).optional() }).strict() }), wrap(async (req, res) => {
    let user;
    try {
      user = await ctx.portalUsers.authenticate(req.body);
    } catch (err) {
      ctx.audit.record({ principal: `login:${req.body.email}`, ip: req.ip, action: 'portal.login', target: req.body.email, args: null, result: `error:${err.code || 'failed'}` });
      throw err;
    }
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user.id;
    req.session.totpVerifiedAt = user.totp_enabled ? ctx.clock.now() : null;
    req.principal = { type: 'portal', userId: user.id };
    ctx.audit.record({ principal: `portal:${user.id}`, ip: req.ip, action: 'portal.login', target: user.id, args: null, result: 'ok' });
    res.json({ data: { user: ctx.portalUsers.publicView(user), csrfToken: issueCsrfToken(req, ctx.crypto), totp_verified_at: req.session.totpVerifiedAt } });
  }));
  r.post('/logout', requireSession, (req, res) => {
    req.session.destroy(() => res.json({ data: { loggedOut: true } }));
  });
  r.get('/csrf', requireSession, (req, res) => res.json({ data: { csrfToken: issueCsrfToken(req, ctx.crypto) } }));
  r.get('/me', requireSession, (req, res) => res.json({ data: me(req) }));
  r.post('/stepup', requireSession, validate({ body: z.object({ totp: z.string().regex(/^\d{6}$/) }).strict() }), (req, res) => {
    if (!ctx.portalUsers.verifyTotp(req.principal.userId, req.body.totp)) throw new HttpError(422, 'totp_invalid', 'Wrong code');
    req.session.totpVerifiedAt = ctx.clock.now();
    res.json({ data: { totp_verified_at: req.session.totpVerifiedAt } });
  });
  r.post('/2fa/enroll', requireSession, validate({ body: z.object({}).strict() }), (req, res) => res.json({ data: ctx.portalUsers.totpEnroll(req.principal.userId) }));
  r.post('/2fa/confirm', requireSession, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }), (req, res) => {
    const user = ctx.portalUsers.totpConfirm(req.principal.userId, req.body.code);
    req.session.totpVerifiedAt = ctx.clock.now();
    req.audit({ action: 'portal.2fa_enable', target: user.id });
    res.json({ data: user });
  });
  r.post('/2fa/disable', requireSession, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }), (req, res) => {
    const user = ctx.portalUsers.totpDisable(req.principal.userId, req.body.code);
    req.session.totpVerifiedAt = null;
    req.audit({ action: 'portal.2fa_disable', target: user.id });
    res.json({ data: user });
  });
  r.post('/password', requireSession, validate({ body: z.object({ current: z.string().min(1).max(128), next: fields.password }).strict() }), wrap(async (req, res) => {
    await ctx.portalUsers.changePassword(req.principal.userId, req.body);
    req.audit({ action: 'portal.password_change', target: req.principal.userId });
    req.session.destroy(() => res.json({ data: { changed: true, reauthenticate: true } }));
  }));

  const admin = [requireSession, requireRole('vendor_admin')];
  r.get('/users', ...admin, validate({ query: pagination }), (req, res) => res.json(ctx.portalUsers.list(req.query)));
  r.post('/users', ...admin, validate({ body: z.object({ email: fields.email, password: fields.password, role: z.enum(PORTAL_ROLES), reseller_id: fields.id.optional() }).strict() }), wrap(async (req, res) => {
    const user = await ctx.portalUsers.create(req.body);
    req.audit({ action: 'portal.user_create', target: user.id, args: { email: user.email, role: user.role } });
    res.status(201).json({ data: user });
  }));
  r.patch('/users/:id', ...admin, validate({ params: z.object({ id: fields.id }), body: z.object({ status: z.enum(['active', 'disabled']).optional(), role: z.enum(PORTAL_ROLES).optional() }).strict() }), (req, res) => res.json({ data: ctx.portalUsers.update(req.params.id, req.body) }));
  r.post('/users/:id/reset-password', ...admin, validate({ params: z.object({ id: fields.id }), body: z.object({ password: fields.password }).strict() }), wrap(async (req, res) => {
    await ctx.portalUsers.resetPassword(req.params.id, req.body.password);
    req.audit({ action: 'portal.password_reset', target: req.params.id });
    res.json({ data: { reset: true } });
  }));
  return r;
}
