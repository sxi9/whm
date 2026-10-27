import session from 'express-session';
import { HttpError, unauthorized, forbidden } from './errors.js';
import { constantTimeEqual } from './crypto.js';

export const PORTAL_ROLES = ['vendor_admin', 'vendor_support', 'reseller_admin', 'reseller_staff'];
export const RESELLER_SCOPES = ['license:read', 'license:issue', 'license:renew', 'license:revoke', 'customer:write', 'webhook:write', 'apikey:write'];
export const VENDOR_SCOPES = ['admin:*', 'admin:read', 'admin:write', 'billing:webhook', 'report:read'];
const ROLE_SCOPES = {
  vendor_admin: ['*'],
  vendor_support: ['admin:read', 'report:read'],
  reseller_admin: ['*'],
  reseller_staff: ['license:read', 'license:issue', 'license:renew', 'customer:write'],
};

// A 40-line express-session store over portal_sessions.
export class PortalSessionStore extends session.Store {
  constructor(db, { ttlMs = 12 * 60 * 60 * 1000, pruneIntervalMs = 10 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM portal_sessions WHERE sid = ?'),
      set: db.prepare('INSERT INTO portal_sessions (sid, data, expires_at) VALUES (@sid, @data, @expiresAt) ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at'),
      touch: db.prepare('UPDATE portal_sessions SET expires_at = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM portal_sessions WHERE sid = ?'),
      destroyUser: db.prepare("DELETE FROM portal_sessions WHERE json_extract(data, '$.userId') = ?"),
      prune: db.prepare('DELETE FROM portal_sessions WHERE expires_at < ?'),
    };
    this.timer = setInterval(() => { try { this.stmts.prune.run(Date.now()); } catch { /* best effort */ } }, pruneIntervalMs);
    this.timer.unref();
  }
  expiry(sess) {
    const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    return cookieExpiry || Date.now() + this.ttlMs;
  }
  get(sid, cb) {
    try { const row = this.stmts.get.get(sid); cb(null, !row || row.expires_at < Date.now() ? null : JSON.parse(row.data)); } catch (err) { cb(err); }
  }
  set(sid, sess, cb) {
    try { this.stmts.set.run({ sid, data: JSON.stringify(sess), expiresAt: this.expiry(sess) }); cb?.(null); } catch (err) { cb?.(err); }
  }
  touch(sid, sess, cb) {
    try { this.stmts.touch.run(this.expiry(sess), sid); cb?.(null); } catch (err) { cb?.(err); }
  }
  destroy(sid, cb) {
    try { this.stmts.destroy.run(sid); cb?.(null); } catch (err) { cb?.(err); }
  }
  destroyUserSessions(userId) { this.stmts.destroyUser.run(userId); }
  close() { clearInterval(this.timer); }
}

export function scopeAllows(scopes, wanted) {
  if (!Array.isArray(scopes)) return false;
  return scopes.some((s) => s === '*' || s === wanted || (s.endsWith(':*') && wanted.startsWith(s.slice(0, -1))));
}

// Resolves req.principal from either an API key (Authorization: Bearer whk_…)
// or a portal session. Principals carry ownerType (vendor|reseller), ownerId,
// scopes and, for portal users, the role.
export function attachPrincipal(ctx) {
  const { crypto } = ctx;
  const db = ctx.dbs.license;
  const byHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL');
  const touch = db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?");
  const userById = db.prepare('SELECT id, email, role, reseller_id, totp_enabled, status FROM portal_users WHERE id = ?');
  return (req, _res, next) => {
    req.principal = null;
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const row = byHash.get(crypto.hashToken(header.slice(7).trim()));
      if (!row) return next(unauthorized('Invalid API key'));
      if (row.expires_at && new Date(row.expires_at).getTime() < ctx.clock.now()) return next(unauthorized('API key has expired'));
      touch.run(row.id);
      req.principal = { type: 'api_key', keyId: row.id, name: row.name, ownerType: row.owner_type, ownerId: row.owner_id, scopes: JSON.parse(row.scopes_json || '[]'), role: null };
      return next();
    }
    if (req.session?.userId) {
      const user = userById.get(req.session.userId);
      if (!user || user.status !== 'active') {
        req.session.destroy(() => next(unauthorized('Session is no longer valid')));
        return;
      }
      req.principal = {
        type: 'portal', userId: user.id, email: user.email, role: user.role, totpEnabled: !!user.totp_enabled,
        ownerType: user.reseller_id ? 'reseller' : 'vendor', ownerId: user.reseller_id || 'vnd_default',
        scopes: ROLE_SCOPES[user.role] || [], totpVerifiedAt: req.session.totpVerifiedAt || null,
      };
    }
    next();
  };
}

export function apiKeyAuth({ ownerType }) {
  return (req, _res, next) => {
    if (!req.principal) return next(unauthorized());
    if (ownerType && req.principal.ownerType !== ownerType) return next(forbidden(`This API is for ${ownerType} principals`, 'wrong_owner_type'));
    next();
  };
}

export function requireScope(scope) {
  return (req, _res, next) => {
    if (!req.principal) return next(unauthorized());
    if (!scopeAllows(req.principal.scopes, scope)) return next(forbidden(`Scope "${scope}" is required`, 'insufficient_scope'));
    next();
  };
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.principal) return next(unauthorized());
    if (req.principal.type !== 'portal') return next(forbidden('A portal session is required', 'portal_session_required'));
    if (!roles.includes(req.principal.role)) return next(forbidden('Your role cannot do that', 'insufficient_role'));
    next();
  };
}

// Sensitive portal actions need a fresh TOTP confirmation (POST /v1/portal/stepup).
// API-key principals are exempt: a key is already a second factor of its owner.
export function requireStepUp(maxAgeS = 300, now = () => Date.now()) {
  return (req, _res, next) => {
    if (!req.principal) return next(unauthorized());
    if (req.principal.type !== 'portal') return next();
    const at = req.principal.totpVerifiedAt;
    if (!req.principal.totpEnabled) return next(new HttpError(403, 'totp_required', 'Enable two-factor authentication to do that'));
    if (!at || now() - at > maxAgeS * 1000) return next(new HttpError(403, 'totp_stepup_required', 'Confirm your TOTP code to continue'));
    next();
  };
}

export function issueCsrfToken(req, crypto) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomToken(24);
  return req.session.csrfToken;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Double-submit CSRF for portal sessions; Bearer keys and the signed panel API
// are exempt because browsers cannot forge those requests.
export function csrf({ exempt = [] } = {}) {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || req.principal?.type === 'api_key' || !req.session?.userId) return next();
    if (exempt.some((p) => req.path === p || req.originalUrl.split('?')[0] === p)) return next();
    const expected = req.session.csrfToken;
    const provided = req.get('x-csrf-token');
    if (!expected || !provided || !constantTimeEqual(expected, provided)) return next(new HttpError(403, 'csrf_failed', 'Missing or invalid CSRF token'));
    next();
  };
}

export function portalSession(ctx) {
  const store = ctx.portalSessionStore || (ctx.portalSessionStore = new PortalSessionStore(ctx.dbs.license, { ttlMs: ctx.config.license.session_ttl_hours * 3600 * 1000 }));
  return session({
    name: 'whmhub.sid',
    secret: ctx.config.session_secret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: !!ctx.config.tls || ctx.config.cookie_secure === true, maxAge: ctx.config.license.session_ttl_hours * 3600 * 1000, path: '/' },
  });
}

// What services receive for audit rows: who and from where.
export function actorOf(req) {
  return { principal: req.principal, ip: req.ip };
}
