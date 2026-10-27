import { unauthorized, forbidden, badRequest, HttpError } from '../lib/errors.js';

const LOCKOUT_CODE = 'locked_out';
// An address counts as "known" for verified-IP login when it logged in
// successfully within this window.
const KNOWN_IP_WINDOW = '-90 days';
// A second factor is only ever tried after a correct password, so a run of
// wrong codes for one user is an attack on that user rather than on an
// address: the user's 2FA pauses for the window (per user, not per IP, so
// a distributed guess cannot walk the code space) and the lock is audited.
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCK_MS = 15 * 60_000;
// RFC 6238 §5.2: a code that already logged someone in is not accepted again.
const TOTP_REUSE_WINDOW_MS = 2 * 60_000;

export function createAuthService(ctx) {
  const { db, crypto, settings, logger, sessionStore } = ctx;
  const stmts = {
    byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    recordAttempt: db.prepare('INSERT INTO login_attempts (ip, username, ok) VALUES (?, ?, ?)'),
    recentFailures: db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND created_at > datetime('now', ?)`),
    knownIp: db.prepare(`SELECT 1 FROM login_attempts WHERE username = ? AND ip = ? AND ok = 1 AND created_at > datetime('now', ?) LIMIT 1`),
    activeBlock: db.prepare(`SELECT 1 FROM cphulk_blocks WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1`),
    block: db.prepare(`INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES (?, ?, datetime('now', ?))`),
    touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now'), last_login_ip = ? WHERE id = ?"),
    setPassword: db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?"),
    forceChange: db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?'),
    setTotp: db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = ? WHERE id = ?'),
  };

  // Login and session policy is owned by Security Center ("Configure Security
  // Policies"); that module may be absent (minimal installs, tests), so it is
  // read lazily with safe defaults.
  const defaults = () => ({
    verifiedIpLogin: false, passwordMaxAgeDays: 0, require2faForRoot: Boolean(settings.get('security.2fa.required_for_root')),
    require2faForResellers: false, sessionTimeoutMinutes: 0, disallowConcurrentSessions: false, apiTokensRequire2fa: false,
  });
  function policy() {
    try { return { ...defaults(), ...(ctx.security?.policy?.() || {}) }; } catch { return defaults(); }
  }

  function enforceBruteForce(ip) {
    if (!settings.get('security.cphulk.enabled')) return;
    if (stmts.activeBlock.get(ip)) throw new HttpError(429, LOCKOUT_CODE, 'Too many failed logins from your address. Try again later.');
  }

  function recordFailure(ip, username) {
    stmts.recordAttempt.run(ip, username, 0);
    if (!settings.get('security.cphulk.enabled')) return;
    const max = settings.get('security.cphulk.max_failures_per_ip');
    const minutes = settings.get('security.cphulk.lockout_minutes');
    const failures = stmts.recentFailures.get(ip, `-${minutes} minutes`).n;
    if (failures >= max) {
      stmts.block.run(ip, `${failures} failed logins`, `+${minutes} minutes`);
      logger.warn({ ip, failures }, 'cPHulk: blocked address after repeated login failures');
    }
  }

  const totpFailures = new Map();
  const totpAccepted = new Map();
  function verifyTotp(user, code) {
    const now = Date.now();
    const state = totpFailures.get(user.id);
    if (state && state.lockedUntil > now) throw new HttpError(429, LOCKOUT_CODE, 'Too many wrong verification codes; wait a few minutes and try again.');
    const normalized = String(code).replace(/\s+/g, '');
    const last = totpAccepted.get(user.id);
    const reused = Boolean(last && last.code === normalized && now - last.at < TOTP_REUSE_WINDOW_MS);
    if (!reused && crypto.totp.verify(normalized, crypto.decrypt(user.totp_secret_enc))) {
      totpFailures.delete(user.id);
      totpAccepted.set(user.id, { code: normalized, at: now });
      return true;
    }
    const inWindow = state && now - state.firstAt < TOTP_LOCK_MS;
    const count = (inWindow ? state.count : 0) + 1;
    const lockedUntil = count >= TOTP_MAX_FAILURES ? now + TOTP_LOCK_MS : 0;
    totpFailures.set(user.id, { count, firstAt: inWindow ? state.firstAt : now, lockedUntil });
    if (lockedUntil) {
      logger.warn({ username: user.username, failures: count }, 'two-factor login paused after repeated wrong codes');
      ctx.auditRecord?.(null, { action: 'auth.2fa.locked', target: user.username, args: { failures: count, minutes: TOTP_LOCK_MS / 60_000 }, result: 'locked' });
    }
    return false;
  }

  function publicUser(u) {
    return { id: u.id, username: u.username, email: u.email, role: u.role, totpEnabled: Boolean(u.totp_enabled), mustChangePassword: Boolean(u.must_change_password) };
  }

  function passwordExpired(user, p) {
    if (!p.passwordMaxAgeDays) return false;
    const changed = user.password_changed_at || user.created_at;
    if (!changed) return false;
    const ageDays = (Date.now() - new Date(changed.replace(' ', 'T') + 'Z').getTime()) / 86_400_000;
    return ageDays > p.passwordMaxAgeDays;
  }

  const needsEnrollment = (user, p) => !user.totp_enabled && ((user.role === 'root' && p.require2faForRoot) || (user.role === 'reseller' && p.require2faForResellers));

  const isNewAddress = (user, ip, p) => Boolean(p.verifiedIpLogin && user.last_login_ip && user.last_login_ip !== ip && !stmts.knownIp.get(user.username, ip, KNOWN_IP_WINDOW));

  // Applies the policy once credentials (password, TOTP or an external identity)
  // have been accepted, and returns what the session must remember.
  function finishLogin(user, ip, p, { newIp = false, via = 'password' } = {}) {
    if (passwordExpired(user, p) && !user.must_change_password) {
      stmts.forceChange.run(user.id);
      user.must_change_password = 1;
    }
    stmts.touchLogin.run(ip, user.id);
    if (newIp) {
      logger.warn({ username: user.username, ip }, 'login from an address not seen before');
      Promise.resolve(ctx.contacts?.notify?.({ event: 'login.new_ip', subject: `New login address for ${user.username}`, body: `${user.username} logged in to WHM from ${ip}, an address not used in the last 90 days.`, severity: 'warning' })).catch(() => {});
    }
    return { user: publicUser(user), mustEnroll2fa: needsEnrollment(user, p), newIp, via, policy: { sessionTimeoutMinutes: p.sessionTimeoutMinutes, disallowConcurrentSessions: p.disallowConcurrentSessions } };
  }

  return {
    publicUser,
    policy,

    async login({ username, password, ip }) {
      enforceBruteForce(ip);
      const user = stmts.byUsername.get(username);
      const ok = user && !user.suspended && (await crypto.verifyPassword(password, user.password_hash));
      if (!ok) {
        recordFailure(ip, username);
        throw unauthorized('Invalid username or password');
      }
      const p = policy();
      const newIp = isNewAddress(user, ip, p);
      stmts.recordAttempt.run(ip, username, 1);
      if (user.totp_enabled) return { pending2fa: true, userId: user.id, newIp };
      return finishLogin(user, ip, p, { newIp });
    },

    async verify2fa({ userId, code, ip, newIp = false }) {
      enforceBruteForce(ip);
      const user = stmts.byId.get(userId);
      if (!user?.totp_enabled) throw badRequest('Two-factor authentication is not pending for this session');
      if (!verifyTotp(user, code)) {
        recordFailure(ip, user.username);
        throw unauthorized('Invalid verification code');
      }
      return finishLogin(user, ip, policy(), { newIp, via: '2fa' });
    },

    // A verified external (OpenID Connect) identity linked to a panel user.
    // TOTP still applies when the user has it enabled.
    async externalLogin({ userId, ip, provider }) {
      enforceBruteForce(ip);
      const user = stmts.byId.get(userId);
      if (!user || user.suspended) throw unauthorized('This panel user cannot log in');
      const p = policy();
      const newIp = isNewAddress(user, ip, p);
      stmts.recordAttempt.run(ip, user.username, 1);
      if (user.totp_enabled) return { pending2fa: true, userId: user.id, newIp };
      return finishLogin(user, ip, p, { newIp, via: `external:${provider}` });
    },

    async changePassword(userId, { currentPassword, newPassword, force = false }) {
      const user = stmts.byId.get(userId);
      if (!force && !(await crypto.verifyPassword(currentPassword || '', user.password_hash))) throw forbidden('Current password is incorrect');
      stmts.setPassword.run(await crypto.hashPassword(newPassword), userId);
      sessionStore.destroyUserSessions(userId);
    },

    begin2faEnrollment(userId) {
      const user = stmts.byId.get(userId);
      const secret = crypto.totp.generateSecret();
      const issuer = `WHM (${settings.get('basic.hostname')})`;
      // Stored encrypted but not yet enabled until the user proves they can generate a code.
      stmts.setTotp.run(crypto.encrypt(secret), 0, userId);
      return { secret, otpauthUrl: crypto.totp.keyUri(user.username, issuer, secret) };
    },

    confirm2faEnrollment(userId, code) {
      const user = stmts.byId.get(userId);
      if (!user.totp_secret_enc) throw badRequest('Start enrollment first');
      if (!crypto.totp.verify(code, crypto.decrypt(user.totp_secret_enc))) throw badRequest('Invalid verification code');
      stmts.setTotp.run(user.totp_secret_enc, 1, userId);
    },

    disable2fa(userId) {
      const user = stmts.byId.get(userId);
      if (user && needsEnrollment({ ...user, totp_enabled: 0 }, policy())) throw forbidden('Two-factor authentication is required for your role by the server security policy');
      stmts.setTotp.run(null, 0, userId);
    },
  };
}
