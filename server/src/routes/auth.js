import { Router } from 'express';
import { validate, z, fields } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import { badRequest } from '../lib/errors.js';

export function authRoutes({ auth, crypto, settings }) {
  const r = Router();

  function establish(req, user) {
    return new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = user.id;
        delete req.session.pending2fa;
        resolve({ user, csrfToken: issueCsrfToken(req, crypto) });
      });
    });
  }

  r.get('/csrf', (req, res) => res.json({ data: { csrfToken: issueCsrfToken(req, crypto) } }));

  r.post('/login', validate({ body: z.object({ username: fields.username, password: z.string().min(1).max(256) }).strict() }), async (req, res, next) => {
    try {
      const result = await auth.login({ ...req.body, ip: req.ip });
      if (result.pending2fa) {
        req.session.pending2fa = result.userId;
        return res.json({ data: { requires2fa: true } });
      }
      req.audit({ action: 'auth.login', target: req.body.username });
      res.json({ data: await establish(req, result.user) });
    } catch (err) { next(err); }
  });

  r.post('/2fa', validate({ body: z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict() }), async (req, res, next) => {
    try {
      if (!req.session.pending2fa) throw badRequest('No login is awaiting verification');
      const result = await auth.verify2fa({ userId: req.session.pending2fa, code: req.body.code, ip: req.ip });
      req.user = result.user;
      req.audit({ action: 'auth.login.2fa', target: result.user.username });
      res.json({ data: await establish(req, result.user) });
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
    res.json({ data: { user: auth.publicUser(req.user), csrfToken: issueCsrfToken(req, crypto), hostname: settings.get('basic.hostname') } });
  });

  r.post('/password', requireAuth, validate({ body: z.object({ currentPassword: z.string().max(256).optional(), newPassword: fields.password }).strict() }), async (req, res, next) => {
    try {
      await auth.changePassword(req.user.id, { ...req.body, force: Boolean(req.user.must_change_password) });
      req.audit({ action: 'auth.password.change', target: req.user.username });
      // Sessions were invalidated; re-establish this one.
      res.json({ data: await establish(req, auth.publicUser({ ...req.user, must_change_password: 0 })) });
    } catch (err) { next(err); }
  });

  r.post('/2fa/enroll', requireAuth, (req, res) => res.json({ data: auth.begin2faEnrollment(req.user.id) }));
  r.post('/2fa/confirm', requireAuth, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }), (req, res, next) => {
    try { auth.confirm2faEnrollment(req.user.id, req.body.code); req.audit({ action: 'auth.2fa.enable', target: req.user.username }); res.json({ data: { enabled: true } }); } catch (err) { next(err); }
  });
  r.post('/2fa/disable', requireAuth, (req, res) => { auth.disable2fa(req.user.id); req.audit({ action: 'auth.2fa.disable', target: req.user.username }); res.json({ data: { enabled: false } }); });

  return r;
}
