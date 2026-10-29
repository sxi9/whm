import express from 'express';
import { z, validate, fields, pagination, wrap } from '../../shared/validate.js';
import { HttpError, unauthorized } from '../../shared/errors.js';
import { issueCsrfToken, requireRole, requireStepUp, PORTAL_ROLES } from '../../shared/auth.js';

// Portal sessions for hub/ui: password + TOTP login, step-up, 2FA enrolment,
// password change and (vendor_admin) portal user management. Vendor users then
// call /v1/admin/*, reseller users /v1/reseller/*, with the same session.
export function portalRoutes(ctx) {
  const r = express.Router();
  const requireSession = (req, _res, next) => (req.principal?.type === 'portal' ? next() : next(unauthorized('Sign in first')));
  // While impersonating, `user` is the effective reseller_admin identity the SPA
  // routes on, `impersonating` names the tenant/window and `reseller` carries
  // the tenant's white-label brand (the same shape a real reseller user gets).
  const me = (req) => {
    const user = ctx.portalUsers.publicView(ctx.portalUsers.get(req.principal.userId));
    const imp = req.principal.impersonation || null;
    const resellerId = imp?.reseller_id || user.reseller_id || null;
    // totp_enrol_required: the SPA sends the user to the enrolment page and the
    // hub answers 403 totp_enrol_required everywhere outside /v1/portal/*.
    const out = { user: imp ? { ...user, role: 'reseller_admin', reseller_id: imp.reseller_id } : user, totp_verified_at: req.session.totpVerifiedAt || null, totp_enrol_required: Boolean(user.totp_enrol_required), csrfToken: issueCsrfToken(req, ctx.crypto), impersonating: imp ? { reseller_id: imp.reseller_id, by: imp.by, expires_at: new Date(imp.expires_at).toISOString() } : null };
    if (resellerId) { try { const rs = ctx.resellers.get(resellerId); out.reseller = { id: rs.id, name: rs.name, brand: rs.brand || {} }; } catch { out.reseller = null; } }
    return out;
  };

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
    const enrol = ctx.portalUsers.enrolmentRequired(user);
    ctx.audit.record({ principal: `portal:${user.id}`, ip: req.ip, action: 'portal.login', target: user.id, args: enrol ? { totp_enrol_required: true } : null, result: 'ok' });
    res.json({ data: { user: ctx.portalUsers.publicView(user), csrfToken: issueCsrfToken(req, ctx.crypto), totp_verified_at: req.session.totpVerifiedAt, totp_enrol_required: enrol } });
  }));
  r.post('/logout', requireSession, (req, res) => {
    req.session.destroy(() => res.json({ data: { loggedOut: true } }));
  });
  r.get('/csrf', requireSession, (req, res) => res.json({ data: { csrfToken: issueCsrfToken(req, ctx.crypto) } }));
  r.get('/me', requireSession, (req, res) => res.json({ data: me(req) }));
  r.post('/impersonate/end', requireSession, validate({ body: z.object({}).strict() }), (req, res) => {
    const imp = req.principal.impersonation || null;
    delete req.session.impersonation;
    if (imp) req.audit({ action: 'reseller.impersonate_end', target: imp.reseller_id, args: { reason: 'ended' } });
    res.json({ data: { ended: Boolean(imp), reseller_id: imp?.reseller_id || null } });
  });
  r.post('/stepup', requireSession, validate({ body: z.object({ totp: z.string().regex(/^\d{6}$/) }).strict() }), (req, res) => {
    if (!ctx.portalUsers.verifyTotp(req.principal.userId, req.body.totp)) throw new HttpError(422, 'totp_invalid', 'Wrong code');
    req.session.totpVerifiedAt = ctx.clock.now();
    res.json({ data: { totp_verified_at: req.session.totpVerifiedAt } });
  });
  r.post('/2fa/enroll', requireSession, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/).optional() }).strict() }), (req, res) => {
    const out = ctx.portalUsers.totpEnroll(req.principal.userId, { code: req.body.code });
    if (out.reenrol) req.audit({ action: 'portal.2fa_reenroll', target: req.principal.userId });
    res.json({ data: out });
  });
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
  // Minting or altering portal users is as sensitive as minting keys: fresh TOTP required.
  const mutate = [...admin, requireStepUp(ctx.config.license.stepup_max_age_s, () => ctx.clock.now())];
  // Vendor-wide portal policy (hub.require_totp_for_admins). requireRole
  // refuses an admin who has not enrolled, so the rule cannot be switched off
  // to escape it.
  r.get('/settings', ...admin, (_req, res) => res.json({ data: ctx.portalUsers.settings() }));
  r.patch('/settings', ...mutate, validate({ body: z.object({ require_totp_for_admins: z.boolean() }).strict() }), (req, res) => {
    const out = ctx.portalUsers.updateSettings(req.body, { by: `portal:${req.principal.userId}` });
    req.audit({ action: 'portal.settings_update', target: 'vendor_settings', args: req.body });
    res.json({ data: out });
  });
  r.get('/users', ...admin, validate({ query: pagination }), (req, res) => res.json(ctx.portalUsers.list(req.query)));
  r.post('/users', ...mutate, validate({ body: z.object({ email: fields.email, password: fields.password, role: z.enum(PORTAL_ROLES), reseller_id: fields.id.optional() }).strict() }), wrap(async (req, res) => {
    const user = await ctx.portalUsers.create(req.body);
    req.audit({ action: 'portal.user_create', target: user.id, args: { email: user.email, role: user.role } });
    res.status(201).json({ data: user });
  }));
  r.patch('/users/:id', ...mutate, validate({ params: z.object({ id: fields.id }), body: z.object({ status: z.enum(['active', 'disabled']).optional(), role: z.enum(PORTAL_ROLES).optional() }).strict() }), (req, res) => res.json({ data: ctx.portalUsers.update(req.params.id, req.body) }));
  r.post('/users/:id/reset-password', ...mutate, validate({ params: z.object({ id: fields.id }), body: z.object({ password: fields.password }).strict() }), wrap(async (req, res) => {
    await ctx.portalUsers.resetPassword(req.params.id, req.body.password);
    req.audit({ action: 'portal.password_reset', target: req.params.id });
    res.json({ data: { reset: true } });
  }));
  return r;
}
