import { unauthorized, forbidden, HttpError } from '../lib/errors.js';

const USER_COLUMNS = 'id, username, email, role, totp_enabled, must_change_password, suspended';

// A category that hands tokens to other machines registers the scope it puts
// on them in ctx.confinedScopes (scope -> [{ method, path }], paths as mounted
// under /api). A token whose scopes are all confined can call those routes
// and nothing else, whatever the role of the user it belongs to.
export function confinementOf(registry, scopes) {
  if (!registry?.size || !Array.isArray(scopes) || !scopes.length || scopes.includes('*')) return null;
  if (!scopes.every((s) => registry.has(s))) return null;
  return scopes.flatMap((s) => registry.get(s));
}

// Routes are matched on the path as mounted under /api; attachUser sits on
// /api itself, so baseUrl + path is the same string in both middlewares.
const mountedPath = (req) => req.baseUrl + req.path;
export const confinementAllows = (confined, req) => confined.some((r) => r.path === mountedPath(req) && (!r.method || r.method === req.method));
const scopeConfined = (confined) => new HttpError(403, 'scope_confined', `This API token is confined to ${confined.map((r) => `${r.method || 'ANY'} ${r.path}`).join(', ')}`);

// Resolves the principal for a request from either the session cookie or an
// API token (Authorization: Bearer ...). Sets req.user and req.auth, and
// applies the session parts of the login policy (timeout, token 2FA rule).
export function attachUser(ctx) {
  const { db, crypto } = ctx;
  const byId = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`);
  const byToken = db.prepare(`SELECT t.id AS token_id, t.scopes, t.expires_at, u.id, u.username, u.email, u.role, u.totp_enabled, u.must_change_password, u.suspended
    FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`);
  const touch = db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?");
  const policy = () => { try { return ctx.auth?.policy?.() || ctx.security?.policy?.() || {}; } catch { return {}; } };

  return (req, _res, next) => {
    req.user = null;
    req.auth = null;
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const row = byToken.get(crypto.hashToken(header.slice(7).trim()));
      if (!row || row.suspended) return next(unauthorized('Invalid API token'));
      if (row.expires_at && new Date(row.expires_at) < new Date()) return next(unauthorized('API token has expired'));
      if (policy().apiTokensRequire2fa && !row.totp_enabled) return next(unauthorized('The security policy requires two-factor authentication before API tokens can be used'));
      // Development issues reseller tokens only with the "cpanel-api" ACL;
      // revoking it later must stop the tokens already handed out, too.
      if (row.role === 'reseller' && typeof ctx.resellers?.hasAcl === 'function' && !ctx.resellers.hasAcl({ id: row.id, username: row.username, role: row.role }, 'cpanel-api')) {
        return next(unauthorized('API access is not part of this reseller\'s privileges ("Access the panel API" was revoked)'));
      }
      touch.run(row.token_id);
      const { token_id, scopes, expires_at, ...user } = row;
      const list = JSON.parse(scopes || '[]');
      const confinedTo = confinementOf(ctx.confinedScopes, list);
      req.auth = { via: 'token', tokenId: token_id, scopes: list, confinedTo };
      // Outside its endpoints a confined token carries no principal at all, so
      // a route mounted before requireAuth (public mounts, /auth) never acts
      // for the token's owner; requireAuth still answers scope_confined.
      req.user = confinedTo && !confinementAllows(confinedTo, req) ? null : user;
      return next();
    }
    if (req.session?.userId) {
      const user = byId.get(req.session.userId);
      if (!user || user.suspended) {
        req.session.destroy(() => next(unauthorized('Session is no longer valid')));
        return;
      }
      const timeoutMinutes = Number(policy().sessionTimeoutMinutes) || 0;
      if (timeoutMinutes > 0 && req.session.lastActivity && Date.now() - req.session.lastActivity > timeoutMinutes * 60_000) {
        req.session.destroy(() => next(unauthorized('Your session expired after inactivity; log in again')));
        return;
      }
      req.session.lastActivity = Date.now();
      req.user = user;
      req.auth = { via: 'session' };
    }
    next();
  };
}

export function requireAuth(req, _res, next) {
  const confined = req.auth?.confinedTo;
  if (confined && !confinementAllows(confined, req)) return next(scopeConfined(confined));
  if (!req.user) return next(unauthorized());
  const mounted = mountedPath(req);
  // Users who must change their password or enrol in 2FA may only use the auth
  // endpoints until they have. req.path is relative to the current router, so
  // the mounted path is used.
  if (req.user.must_change_password && !mounted.includes('/auth/')) {
    return next(forbidden('You must change your password before continuing'));
  }
  if (req.session?.mustEnroll2fa && !mounted.includes('/auth/')) {
    return next(new HttpError(403, 'two_factor_required', 'The server security policy requires two-factor authentication for your role. Set it up to continue.'));
  }
  next();
}
