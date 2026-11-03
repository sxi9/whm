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

// Row-level ownership for category services: root sees every row, a reseller
// the rows whose owner_id is its own user id, and a role-`user` principal only
// the rows of the single account it is pinned to (`user.accountId`, set by the
// account panel's scope). For that role nothing else counts: a users row never
// owns accounts, and username equality is not ownership. `accountId` names the
// row's account column (default account_id); pass `row.id` for an accounts row.
export function ownsRow(user, row, { accountId = row?.account_id } = {}) {
  if (!user || !row) return false;
  if (isRoot(user)) return true;
  if (user.role === 'user') return user.accountId != null && accountId != null && accountId === user.accountId;
  return row.owner_id === user.id;
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
