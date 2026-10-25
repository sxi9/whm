import { HttpError } from '../lib/errors.js';
import { constantTimeEqual } from '../lib/crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = new Set(['/auth/login', '/auth/2fa', '/auth/csrf', '/health']);

export function issueCsrfToken(req, crypto) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomToken(24);
  return req.session.csrfToken;
}

// Double-submit CSRF: the SPA reads the token from GET /api/auth/csrf (or the
// login response) and echoes it in X-CSRF-Token on every mutating request.
// Bearer-token API clients are exempt because browsers cannot forge that header.
export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method) || EXEMPT_PATHS.has(req.path) || req.auth?.via === 'token') return next();
  const expected = req.session?.csrfToken;
  const provided = req.get('x-csrf-token');
  if (!expected || !provided || !constantTimeEqual(expected, provided)) {
    return next(new HttpError(403, 'csrf_failed', 'Missing or invalid CSRF token'));
  }
  next();
}
