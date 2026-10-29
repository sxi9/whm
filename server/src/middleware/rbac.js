import { forbidden, unauthorized, HttpError } from '../lib/errors.js';

export const ROLES = ['root', 'reseller', 'user'];

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const requireRoot = requireRole('root');
export const requireReseller = requireRole('root', 'reseller');

export const isRoot = (user) => user?.role === 'root';

// The super admin is the root user who owns the panel (users.superadmin, set
// only by `whm-cli superadmin`). The principal loader does not select the
// column, so the gate reads it itself: a user object that already carries it
// is trusted, anything else is looked up by id.
export function superadminOf(ctx) {
  let stmt = null;
  return (user) => {
    if (!isRoot(user)) return false;
    if (user.superadmin !== undefined) return Boolean(user.superadmin);
    stmt ||= ctx.db.prepare('SELECT superadmin FROM users WHERE id = ?');
    return Boolean(stmt.get(user.id)?.superadmin);
  };
}

export function requireSuperadmin(ctx) {
  const check = superadminOf(ctx);
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!check(req.user)) return next(new HttpError(403, 'superadmin_required', 'Only the owner of this panel (super admin) can do that'));
    next();
  };
}

// API tokens may carry scopes narrower than the user's role. A token with no
// scopes inherits the role; otherwise the route's scope must be listed.
export function requireScope(scope) {
  return (req, _res, next) => {
    const scopes = req.auth?.scopes;
    if (req.auth?.via === 'token' && scopes?.length && !scopes.includes(scope) && !scopes.includes('*')) {
      return next(forbidden(`This API token does not have the "${scope}" scope`));
    }
    next();
  };
}

// Resellers only see accounts they own. Returns the owner filter a service
// should apply, or null for root (no filter).
export function ownerFilter(user) {
  return isRoot(user) ? null : user.id;
}
