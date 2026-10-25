import { unauthorized, forbidden } from '../lib/errors.js';

const USER_COLUMNS = 'id, username, email, role, totp_enabled, must_change_password, suspended';

// Resolves the principal for a request from either the session cookie or an
// API token (Authorization: Bearer ...). Sets req.user and req.auth.
export function attachUser({ db, crypto }) {
  const byId = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`);
  const byToken = db.prepare(`SELECT t.id AS token_id, t.scopes, t.expires_at, u.id, u.username, u.email, u.role, u.totp_enabled, u.must_change_password, u.suspended
    FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`);
  const touch = db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?");

  return (req, _res, next) => {
    req.user = null;
    req.auth = null;
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const row = byToken.get(crypto.hashToken(header.slice(7).trim()));
      if (!row || row.suspended) return next(unauthorized('Invalid API token'));
      if (row.expires_at && new Date(row.expires_at) < new Date()) return next(unauthorized('API token has expired'));
      touch.run(row.token_id);
      const { token_id, scopes, expires_at, ...user } = row;
      req.user = user;
      req.auth = { via: 'token', tokenId: token_id, scopes: JSON.parse(scopes || '[]') };
      return next();
    }
    if (req.session?.userId) {
      const user = byId.get(req.session.userId);
      if (!user || user.suspended) {
        req.session.destroy(() => next(unauthorized('Session is no longer valid')));
        return;
      }
      req.user = user;
      req.auth = { via: 'session' };
    }
    next();
  };
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  // A user flagged to change their password may only use the auth endpoints.
  // req.path is relative to the router this runs in, so use the mounted path.
  if (req.user.must_change_password && !(req.baseUrl + req.path).includes('/auth/')) {
    return next(forbidden('You must change your password before continuing'));
  }
  next();
}
