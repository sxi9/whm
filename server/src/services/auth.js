import { unauthorized, forbidden, badRequest, HttpError } from '../lib/errors.js';

const LOCKOUT_CODE = 'locked_out';

export function createAuthService({ db, crypto, settings, logger, sessionStore }) {
  const stmts = {
    byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    recordAttempt: db.prepare('INSERT INTO login_attempts (ip, username, ok) VALUES (?, ?, ?)'),
    recentFailures: db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND created_at > datetime('now', ?)`),
    activeBlock: db.prepare(`SELECT 1 FROM cphulk_blocks WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1`),
    block: db.prepare(`INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES (?, ?, datetime('now', ?))`),
    touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now'), last_login_ip = ? WHERE id = ?"),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?'),
    setTotp: db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = ? WHERE id = ?'),
  };

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

  function publicUser(u) {
    return { id: u.id, username: u.username, email: u.email, role: u.role, totpEnabled: Boolean(u.totp_enabled), mustChangePassword: Boolean(u.must_change_password) };
  }

  return {
    publicUser,

    async login({ username, password, ip }) {
      enforceBruteForce(ip);
      const user = stmts.byUsername.get(username);
      const ok = user && !user.suspended && (await crypto.verifyPassword(password, user.password_hash));
      if (!ok) {
        recordFailure(ip, username);
        throw unauthorized('Invalid username or password');
      }
      stmts.recordAttempt.run(ip, username, 1);
      if (user.totp_enabled) return { pending2fa: true, userId: user.id };
      stmts.touchLogin.run(ip, user.id);
      return { user: publicUser(user) };
    },

    async verify2fa({ userId, code, ip }) {
      enforceBruteForce(ip);
      const user = stmts.byId.get(userId);
      if (!user?.totp_enabled) throw badRequest('Two-factor authentication is not pending for this session');
      const secret = crypto.decrypt(user.totp_secret_enc);
      if (!crypto.totp.verify(code, secret)) {
        recordFailure(ip, user.username);
        throw unauthorized('Invalid verification code');
      }
      stmts.touchLogin.run(ip, user.id);
      return { user: publicUser(user) };
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

    disable2fa(userId) { stmts.setTotp.run(null, 0, userId); },
  };
}
