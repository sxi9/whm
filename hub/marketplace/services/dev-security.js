import { HttpError, unauthorized, forbidden } from '../../shared/errors.js';
import { constantTimeEqual } from '../../shared/crypto.js';
import { newId, nowIso, json } from '../../shared/db.js';

export const DEV_SCOPES = ['plugin:read', 'plugin:write', 'version:upload', 'version:publish', 'stats:read', 'webhook:write'];
export const SESSION_COOKIE = 'whmdev.sid';
export const API_KEY_HEADER = 'x-dev-api-key';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX = 10;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Developer identity: a cookie session over developer_sessions (marketplace.db)
// or an API key in X-Dev-Api-Key (Authorization: Bearer is the license hub's
// api_keys and is intercepted before this module runs). Lockout, step-up,
// CSRF, password reset and the security-event trail live here (§18.9).
export function createDevSecurityService(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    session: db.prepare('SELECT * FROM developer_sessions WHERE sid = ?'),
    insertSession: db.prepare('INSERT INTO developer_sessions (sid, developer_id, data, totp_verified_at, created_at, ip_hash, expires_at) VALUES (@sid, @developer_id, @data, @totp_verified_at, @created_at, @ip_hash, @expires_at)'),
    updateSession: db.prepare('UPDATE developer_sessions SET data = @data, totp_verified_at = @totp_verified_at, expires_at = @expires_at WHERE sid = @sid'),
    deleteSession: db.prepare('DELETE FROM developer_sessions WHERE sid = ?'),
    deleteDevSessions: db.prepare('DELETE FROM developer_sessions WHERE developer_id = ?'),
    listSessions: db.prepare('SELECT sid, created_at, expires_at, totp_verified_at, ip_hash FROM developer_sessions WHERE developer_id = ? AND expires_at > ? ORDER BY created_at'),
    pruneSessions: db.prepare('DELETE FROM developer_sessions WHERE expires_at < ?'),
    developer: db.prepare('SELECT * FROM developers WHERE id = ?'),
    apiKey: db.prepare('SELECT * FROM developer_api_keys WHERE key_hash = ? AND revoked_at IS NULL'),
    touchKey: db.prepare('UPDATE developer_api_keys SET last_used_at = ? WHERE id = ?'),
    insertKey: db.prepare('INSERT INTO developer_api_keys (id, developer_id, name, key_hash, key_prefix, scopes_json, expires_at, created_at) VALUES (@id, @developer_id, @name, @key_hash, @key_prefix, @scopes_json, @expires_at, @created_at)'),
    listKeys: db.prepare('SELECT id, name, key_prefix, scopes_json, last_used_at, expires_at, revoked_at, created_at FROM developer_api_keys WHERE developer_id = ? ORDER BY created_at'),
    revokeKey: db.prepare('UPDATE developer_api_keys SET revoked_at = ? WHERE id = ? AND developer_id = ? AND revoked_at IS NULL'),
    revokeAllKeys: db.prepare('UPDATE developer_api_keys SET revoked_at = ? WHERE developer_id = ? AND revoked_at IS NULL'),
    setLogin: db.prepare('UPDATE developers SET failed_logins = @failed_logins, locked_until = @locked_until, lockouts = @lockouts, last_login_ip_hash = COALESCE(@ip_hash, last_login_ip_hash), updated_at = @now WHERE id = @id'),
    insertEvent: db.prepare('INSERT INTO developer_security_events (developer_id, event, ip_hash, detail, ts) VALUES (?, ?, ?, ?, ?)'),
    listEvents: db.prepare('SELECT event, ip_hash, detail, ts FROM developer_security_events WHERE developer_id = ? ORDER BY id DESC LIMIT 100'),
    insertReset: db.prepare('INSERT INTO developer_password_resets (token_hash, developer_id, expires_at) VALUES (?, ?, ?)'),
    reset: db.prepare('SELECT * FROM developer_password_resets WHERE token_hash = ?'),
    useReset: db.prepare('UPDATE developer_password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
    setPassword: db.prepare('UPDATE developers SET password_hash = @hash, password_changed_at = @now, credentials_changed_at = @now, failed_logins = 0, locked_until = NULL, updated_at = @now WHERE id = @id'),
  };

  function securityEvent(developer, event, { ip = null, detail = null, mail = true } = {}) {
    stmts.insertEvent.run(developer.id, event, m.hashIp(ip), detail, m.nowIso());
    m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: `developer.security.${event}`, target: developer.id, args: { detail }, result: 'ok' });
    if (mail) m.mail(developer.email, 'dev.security_event', { event, detail: detail || event, display_name: developer.display_name });
  }

  // Session cookie: a random token; the table stores its hash.
  function createSession(developer, { ip, totpVerified = false, res }) {
    const token = ctx.crypto.randomToken(32);
    const expiresAt = m.now() + cfg.session_ttl_hours * 3600_000;
    const data = { csrfToken: ctx.crypto.randomToken(24) };
    stmts.insertSession.run({ sid: ctx.crypto.hashToken(token), developer_id: developer.id, data: JSON.stringify(data), totp_verified_at: totpVerified ? m.now() : null, created_at: m.nowIso(), ip_hash: m.hashIp(ip), expires_at: expiresAt });
    if (res) res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: !!ctx.config.tls || ctx.config.cookie_secure !== false, path: '/', maxAge: cfg.session_ttl_hours * 3600_000 });
    return { token, csrfToken: data.csrfToken, expiresAt };
  }

  function loadSession(req) {
    const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (!token) return null;
    const row = stmts.session.get(ctx.crypto.hashToken(token));
    if (!row || row.expires_at < m.now()) return null;
    const developer = stmts.developer.get(row.developer_id);
    if (!developer) return null;
    // Any password/e-mail change invalidates every session issued before it.
    if (developer.credentials_changed_at && new Date(developer.credentials_changed_at).getTime() > new Date(row.created_at).getTime()) { stmts.deleteSession.run(row.sid); return null; }
    return { row, developer, data: json.parse(row.data, {}) };
  }

  function attachDeveloper() {
    return (req, _res, next) => {
      req.developer = null;
      req.devPrincipal = null;
      const apiKey = req.get(API_KEY_HEADER);
      if (apiKey) {
        const row = stmts.apiKey.get(ctx.crypto.hashToken(apiKey.trim()));
        if (!row) return next(unauthorized('Invalid developer API key'));
        if (row.expires_at && new Date(row.expires_at).getTime() < m.now()) return next(unauthorized('Developer API key has expired'));
        const developer = stmts.developer.get(row.developer_id);
        if (!developer) return next(unauthorized('Invalid developer API key'));
        if (developer.credentials_changed_at && new Date(developer.credentials_changed_at).getTime() > new Date(row.created_at).getTime()) return next(unauthorized('Developer API key was invalidated by a credential change'));
        stmts.touchKey.run(m.nowIso(), row.id);
        req.developer = developer;
        req.devPrincipal = { type: 'api_key', developerId: developer.id, keyId: row.id, scopes: json.parse(row.scopes_json, []), totpVerifiedAt: null };
        return next();
      }
      const s = loadSession(req);
      if (s) {
        req.developer = s.developer;
        req.devSession = s;
        req.devPrincipal = { type: 'session', developerId: s.developer.id, sid: s.row.sid, scopes: ['*'], totpVerifiedAt: s.row.totp_verified_at, csrfToken: s.data.csrfToken };
      }
      next();
    };
  }

  // Double-submit CSRF for cookie sessions on every mutation except the listed paths.
  function csrf({ exempt = [] } = {}) {
    return (req, _res, next) => {
      if (SAFE_METHODS.has(req.method) || req.devPrincipal?.type !== 'session') return next();
      if (exempt.includes(req.path)) return next();
      const provided = req.get('x-csrf-token');
      if (!provided || !constantTimeEqual(req.devPrincipal.csrfToken || '', provided)) return next(new HttpError(403, 'csrf_failed', 'Missing or invalid CSRF token'));
      next();
    };
  }

  function requireDeveloper({ scope = null } = {}) {
    return (req, _res, next) => {
      if (!req.devPrincipal) return next(unauthorized('A developer session or API key is required'));
      if (scope && req.devPrincipal.type === 'api_key' && !req.devPrincipal.scopes.includes(scope)) return next(forbidden(`Scope "${scope}" is required`, 'insufficient_scope'));
      next();
    };
  }

  // † routes: a session whose TOTP confirmation is ≤ stepup_max_age_s old;
  // API keys cannot call them unless the route names an `apiKeyScope`.
  function requireStepUp({ apiKeyScope = null } = {}) {
    return (req, _res, next) => {
      const p = req.devPrincipal;
      if (!p) return next(unauthorized());
      if (p.type === 'api_key') {
        if (apiKeyScope && p.scopes.includes(apiKeyScope)) return next();
        return next(forbidden('This action needs an interactive session with a TOTP step-up', 'totp_stepup_required'));
      }
      if (!req.developer.totp_enabled) return next(new HttpError(403, 'totp_required', 'Enable two-factor authentication to do that'));
      if (!p.totpVerifiedAt || m.now() - p.totpVerifiedAt > cfg.stepup_max_age_s * 1000) return next(new HttpError(403, 'totp_stepup_required', 'Confirm your TOTP code to continue'));
      next();
    };
  }

  function stepUp(req, totp) {
    const s = req.devSession;
    if (!s) throw unauthorized('A developer session is required');
    if (!s.developer.totp_enabled) throw new HttpError(403, 'totp_required', 'Two-factor authentication is not enabled');
    if (!ctx.crypto.totp.verify(totp, ctx.crypto.decrypt(s.developer.totp_secret_enc))) throw new HttpError(401, 'invalid_totp', 'The code is not valid');
    stmts.updateSession.run({ sid: s.row.sid, data: s.row.data, totp_verified_at: m.now(), expires_at: s.row.expires_at });
    return { totp_verified_at: m.now() };
  }

  function destroySession(req, res) {
    if (req.devSession) stmts.deleteSession.run(req.devSession.row.sid);
    res?.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  // Login throttle: 10 attempts per 15 min per IP+account, then a doubling lockout (§18.9).
  function assertNotLocked(developer) {
    if (developer.locked_until && new Date(developer.locked_until).getTime() > m.now()) {
      throw Object.assign(new HttpError(423, 'account_locked', 'Too many failed logins; try again later'), { retryAfterS: Math.ceil((new Date(developer.locked_until).getTime() - m.now()) / 1000) });
    }
  }
  function recordFailedLogin(developer, ip) {
    const attempts = m.limits.count(`login:${m.hashIp(ip)}:${developer.id}`, LOGIN_WINDOW_MS);
    m.limits.hit(`login:${m.hashIp(ip)}:${developer.id}`);
    const failed = developer.failed_logins + 1;
    if (attempts + 1 >= LOGIN_MAX) {
      const lockouts = developer.lockouts + 1;
      const until = m.nowIso(m.now() + 15 * 60_000 * 2 ** (lockouts - 1));
      stmts.setLogin.run({ id: developer.id, failed_logins: failed, locked_until: until, lockouts, ip_hash: null, now: m.nowIso() });
      securityEvent(developer, 'lockout', { ip, detail: `locked until ${until}` });
      return { locked: true, until };
    }
    stmts.setLogin.run({ id: developer.id, failed_logins: failed, locked_until: developer.locked_until, lockouts: developer.lockouts, ip_hash: null, now: m.nowIso() });
    return { locked: false };
  }
  function recordSuccessfulLogin(developer, ip) {
    const ipHash = m.hashIp(ip);
    const newIp = developer.last_login_ip_hash && developer.last_login_ip_hash !== ipHash;
    stmts.setLogin.run({ id: developer.id, failed_logins: 0, locked_until: null, lockouts: developer.lockouts, ip_hash: ipHash, now: m.nowIso() });
    if (newIp) securityEvent(developer, 'login_new_ip', { ip, detail: 'login from a new address' });
  }

  // Credential changes invalidate every session and API key.
  function invalidateCredentials(developer, { reason, ip, oldEmail = null }) {
    stmts.deleteDevSessions.run(developer.id);
    stmts.revokeAllKeys.run(m.nowIso(), developer.id);
    db.prepare('UPDATE developers SET credentials_changed_at = ?, updated_at = ? WHERE id = ?').run(m.nowIso(), m.nowIso(), developer.id);
    const fresh = stmts.developer.get(developer.id);
    securityEvent(fresh, reason, { ip, detail: `${reason}; all sessions and API keys were invalidated` });
    if (oldEmail && oldEmail !== fresh.email) m.mail(oldEmail, 'dev.security_event', { event: reason, detail: `Your developer account e-mail changed to ${fresh.email}` });
  }

  return {
    SESSION_COOKIE, API_KEY_HEADER, DEV_SCOPES,
    attachDeveloper, csrf, requireDeveloper, requireStepUp, stepUp, createSession, destroySession, securityEvent, assertNotLocked, recordFailedLogin, recordSuccessfulLogin, invalidateCredentials,
    sessions: (developerId) => stmts.listSessions.all(developerId, m.now()).map((s) => ({ id: s.sid.slice(0, 12), created_at: s.created_at, expires_at: new Date(s.expires_at).toISOString(), stepped_up: !!s.totp_verified_at })),
    revokeSessions: (developerId) => stmts.deleteDevSessions.run(developerId).changes,
    pruneSessions: () => stmts.pruneSessions.run(m.now()).changes,
    events: (developerId) => stmts.listEvents.all(developerId),
    createApiKey(developer, { name, scopes, expires_in_days }, { ip } = {}) {
      if (!developer.totp_enabled) throw new HttpError(403, 'totp_required', 'API keys need two-factor authentication enabled');
      const beyond = scopes.filter((s) => !DEV_SCOPES.includes(s));
      if (beyond.length) throw new HttpError(422, 'validation_failed', `Unknown scopes: ${beyond.join(', ')}`);
      const secret = `whd_${ctx.crypto.randomToken(30)}`;
      const id = newId('dky', m.now());
      stmts.insertKey.run({ id, developer_id: developer.id, name, key_hash: ctx.crypto.hashToken(secret), key_prefix: secret.slice(0, 12), scopes_json: JSON.stringify(scopes), expires_at: expires_in_days ? m.nowIso(m.now() + expires_in_days * 86_400_000) : null, created_at: m.nowIso() });
      securityEvent(developer, 'api_key_created', { ip, detail: name });
      return { id, name, key_prefix: secret.slice(0, 12), scopes, key: secret };
    },
    listApiKeys: (developerId) => stmts.listKeys.all(developerId).map((k) => ({ ...k, scopes: json.parse(k.scopes_json, []), scopes_json: undefined })),
    revokeApiKey(developer, id, { ip } = {}) {
      if (!stmts.revokeKey.run(m.nowIso(), id, developer.id).changes) throw new HttpError(404, 'not_found', 'API key not found');
      securityEvent(developer, 'api_key_revoked', { ip, detail: id, mail: false });
      return { revoked: true };
    },
    revokeAllApiKeys: (developerId) => stmts.revokeAllKeys.run(m.nowIso(), developerId).changes,
    // Password reset: 202 always, single-use hashed token, 15-minute TTL.
    requestPasswordReset(email, { ip } = {}) {
      const developer = db.prepare('SELECT * FROM developers WHERE email = ?').get(String(email).toLowerCase());
      if (!developer) return { accepted: true };
      const token = ctx.crypto.randomToken(32);
      stmts.insertReset.run(ctx.crypto.hashToken(token), developer.id, m.nowIso(m.now() + 15 * 60_000));
      m.mail(developer.email, 'dev.password_reset', { link: `${ctx.config.public_url}/dev/password/reset/${token}` });
      m.audit({ principal: 'anonymous', ip, action: 'developer.password_reset.request', target: developer.id, args: null, result: 'ok' });
      return { accepted: true };
    },
    async resetPassword(token, { password, totp }, { ip } = {}) {
      const row = stmts.reset.get(ctx.crypto.hashToken(String(token)));
      if (!row || row.used_at || new Date(row.expires_at).getTime() < m.now()) throw new HttpError(410, 'reset_invalid', 'The reset link is invalid, used or expired');
      const developer = stmts.developer.get(row.developer_id);
      if (developer.totp_enabled && !ctx.crypto.totp.verify(totp || '', ctx.crypto.decrypt(developer.totp_secret_enc))) throw new HttpError(401, 'invalid_totp', 'A valid TOTP code is required');
      if (!stmts.useReset.run(m.nowIso(), row.token_hash).changes) throw new HttpError(410, 'reset_invalid', 'The reset link was already used');
      stmts.setPassword.run({ id: developer.id, hash: await ctx.crypto.hashPassword(password), now: m.nowIso() });
      invalidateCredentials(developer, { reason: 'password_reset', ip });
      return { reset: true };
    },
    async changePassword(developer, { current_password, password }, { ip } = {}) {
      if (!(await ctx.crypto.verifyPassword(current_password, developer.password_hash))) throw new HttpError(401, 'invalid_credentials', 'Current password is wrong');
      stmts.setPassword.run({ id: developer.id, hash: await ctx.crypto.hashPassword(password), now: m.nowIso() });
      invalidateCredentials(developer, { reason: 'password_changed', ip });
      return { changed: true };
    },
  };
}
