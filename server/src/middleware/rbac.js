import { forbidden, unauthorized } from '../lib/errors.js';

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
