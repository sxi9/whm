import session from 'express-session';
import { HttpError, unauthorized, forbidden } from './errors.js';
import { constantTimeEqual } from './crypto.js';

export const PORTAL_ROLES = ['vendor_admin', 'vendor_support', 'reseller_admin', 'reseller_staff'];
// §16.7 verbatim: webhook:write is the integration scope and also governs /v1/reseller/api-keys.
export const RESELLER_SCOPES = ['license:read', 'license:issue', 'license:renew', 'license:revoke', 'customer:write', 'webhook:write'];
// §18.8: marketplace admin scopes for vendor api_keys; the marketplace guard honours them.
export const MARKET_SCOPES = ['market:*', 'market:read', 'market:review', 'market:verify', 'market:revoke', 'market:billing'];
export const VENDOR_SCOPES = ['admin:*', 'admin:read', 'admin:write', 'billing:webhook', 'report:read', ...MARKET_SCOPES];
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
  const resellerStatus = db.prepare('SELECT status FROM resellers WHERE id = ?');
  // A suspended or closed reseller tenant loses every key and session at once.
  const assertResellerActive = (principal) => {
    if (principal.ownerType !== 'reseller') return null;
    const row = resellerStatus.get(principal.ownerId);
    if (!row || row.status !== 'active') return forbidden(`This reseller account is ${row?.status || 'closed'}`, 'reseller_suspended');
    return null;
  };
  return (req, _res, next) => {
    req.principal = null;
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const row = byHash.get(crypto.hashToken(header.slice(7).trim()));
      if (!row) return next(unauthorized('Invalid API key'));
      if (row.expires_at && new Date(row.expires_at).getTime() < ctx.clock.now()) return next(unauthorized('API key has expired'));
      const principal = { type: 'api_key', keyId: row.id, name: row.name, ownerType: row.owner_type, ownerId: row.owner_id, scopes: JSON.parse(row.scopes_json || '[]'), role: null };
      const refused = assertResellerActive(principal);
      if (refused) return next(refused);
      touch.run(row.id);
      req.principal = principal;
      return next();
    }
    if (req.session?.userId) {
      const user = userById.get(req.session.userId);
      if (!user || user.status !== 'active') {
        req.session.destroy(() => next(unauthorized('Session is no longer valid')));
        return;
      }
      const principal = {
        type: 'portal', userId: user.id, email: user.email, role: user.role, totpEnabled: !!user.totp_enabled,
        ownerType: user.reseller_id ? 'reseller' : 'vendor', ownerId: user.reseller_id || 'vnd_default',
        scopes: ROLE_SCOPES[user.role] || [], totpVerifiedAt: req.session.totpVerifiedAt || null,
      };
      // §16.9 impersonation: a vendor_admin session rebound to one reseller
      // tenant for a short window acts as that tenant's reseller_admin
      // (scopes, row scoping, rate limits) and nothing else; the vendor
      // identity stays on the principal so every audit row names the admin.
      const imp = impersonationOf(req, user, ctx);
      if (imp) Object.assign(principal, { role: 'reseller_admin', ownerType: 'reseller', ownerId: imp.reseller_id, scopes: ROLE_SCOPES.reseller_admin, impersonation: imp });
      const refused = assertResellerActive(principal);
      if (refused) {
        req.session.destroy(() => next(refused));
        return;
      }
      req.principal = principal;
    }
    next();
  };
}

export const IMPERSONATION_TTL_MS = 15 * 60 * 1000;

// The active impersonation of a session, or null. An expired one is removed
// here (and audited as ended) so a stale rebinding never outlives its window.
export function impersonationOf(req, user, ctx) {
  const imp = req.session?.impersonation;
  if (!imp) return null;
  const valid = user?.role === 'vendor_admin' && typeof imp.reseller_id === 'string' && Number.isFinite(imp.expires_at) && imp.by === user.id;
  if (valid && imp.expires_at > ctx.clock.now()) return { reseller_id: imp.reseller_id, by: imp.by, started_at: imp.started_at, expires_at: imp.expires_at };
  delete req.session.impersonation;
  if (valid) ctx.audit?.record({ principal: `portal:${user.id}`, role: 'vendor_admin', ip: req.ip, action: 'reseller.impersonate_end', target: imp.reseller_id, args: { reason: 'expired' }, result: 'ok' });
  return null;
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
    // Secure unless the operator opts out (cookie_secure: false) for a plain-HTTP dev setup.
    cookie: { httpOnly: true, sameSite: 'strict', secure: !!ctx.config.tls || ctx.config.cookie_secure !== false, maxAge: ctx.config.license.session_ttl_hours * 3600 * 1000, path: '/' },
  });
}

// What services receive for audit rows: who and from where.
export function actorOf(req) {
  return { principal: req.principal, ip: req.ip };
}
