import { HttpError, notFound, conflict, unauthorized } from '../../shared/errors.js';
import { newId, nowIso, paginate } from '../../shared/db.js';
import { PORTAL_ROLES } from '../../shared/auth.js';

const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60_000;

export function createPortalUsersService(ctx) {
  const db = ctx.dbs.license;
  const { crypto } = ctx;
  const now = () => ctx.clock.now();
  const stmts = {
    byId: db.prepare('SELECT * FROM portal_users WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM portal_users WHERE email = ?'),
    insert: db.prepare(`INSERT INTO portal_users (id, reseller_id, email, password_hash, role, status, created_at) VALUES (@id, @reseller_id, @email, @password_hash, @role, 'active', @now)`),
    setPassword: db.prepare('UPDATE portal_users SET password_hash = ? WHERE id = ?'),
    setTotp: db.prepare('UPDATE portal_users SET totp_secret_enc = ?, totp_enabled = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE portal_users SET status = ?, role = ? WHERE id = ?'),
    loginOk: db.prepare('UPDATE portal_users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'),
    loginFail: db.prepare('UPDATE portal_users SET failed_logins = failed_logins + 1, locked_until = @locked WHERE id = @id'),
    linkReseller: db.prepare('UPDATE resellers SET portal_user_id = ? WHERE id = ?'),
  };

  function publicView(u) {
    return u ? { id: u.id, email: u.email, role: u.role, reseller_id: u.reseller_id, totp_enabled: !!u.totp_enabled, status: u.status, last_login_at: u.last_login_at, created_at: u.created_at } : null;
  }

  return {
    publicView,
    get(id) {
      const u = stmts.byId.get(id);
      if (!u) throw notFound('Portal user');
      return u;
    },
    list: (query = {}, scope = null) => {
      const where = [];
      const params = {};
      if (scope?.resellerId) { where.push('reseller_id = @reseller'); params.reseller = scope.resellerId; }
      const page = paginate(db, { from: 'portal_users', where, params, sortable: { created_at: 'created_at', email: 'email' }, defaultSort: 'created_at', query });
      return { ...page, data: page.data.map(publicView) };
    },
    async create({ email, password, role, reseller_id = null }) {
      if (!PORTAL_ROLES.includes(role)) throw new HttpError(422, 'validation_failed', 'Unknown role');
      if (role.startsWith('reseller_') && !reseller_id) throw new HttpError(422, 'validation_failed', 'Reseller roles need reseller_id');
      if (role.startsWith('vendor_') && reseller_id) throw new HttpError(422, 'validation_failed', 'Vendor roles cannot belong to a reseller');
      const mail = String(email).toLowerCase();
      if (stmts.byEmail.get(mail)) throw conflict('A portal user with that e-mail already exists', 'user_exists');
      if (reseller_id) ctx.resellers.get(reseller_id);
      const id = newId('usr', now());
      stmts.insert.run({ id, reseller_id, email: mail, password_hash: await crypto.hashPassword(password), role, now: nowIso(now()) });
      if (reseller_id && role === 'reseller_admin') stmts.linkReseller.run(id, reseller_id);
      return publicView(stmts.byId.get(id));
    },
    // Password + (when enrolled) TOTP. 10 failures lock the account for 15 min.
    async authenticate({ email, password, totp }) {
      const u = stmts.byEmail.get(String(email).toLowerCase());
      const fail = () => { if (u) stmts.loginFail.run({ id: u.id, locked: u.failed_logins + 1 >= LOCK_AFTER ? nowIso(now() + LOCK_MS) : null }); throw unauthorized('Invalid e-mail, password or code'); };
      if (!u || u.status !== 'active') fail();
      if (u.locked_until && new Date(u.locked_until).getTime() > now()) throw new HttpError(423, 'locked', 'Account temporarily locked after too many failed logins');
      if (!(await crypto.verifyPassword(password, u.password_hash))) fail();
      if (u.totp_enabled) {
        if (!totp) throw new HttpError(401, 'totp_required', 'Enter your two-factor code');
        if (!crypto.totp.verify(totp, crypto.decrypt(u.totp_secret_enc))) fail();
      }
      stmts.loginOk.run(nowIso(now()), u.id);
      return u;
    },
    verifyTotp(id, code) {
      const u = this.get(id);
      if (!u.totp_enabled) return false;
      return crypto.totp.verify(code, crypto.decrypt(u.totp_secret_enc));
    },
    totpEnroll(id) {
      const u = this.get(id);
      const secret = crypto.totp.generateSecret();
      stmts.setTotp.run(crypto.encrypt(secret), 0, id);
      return { secret, uri: crypto.totp.keyUri(u.email, 'WHM Hub', secret) };
    },
    totpConfirm(id, code) {
      const u = this.get(id);
      if (!u.totp_secret_enc) throw new HttpError(409, 'totp_not_enrolled', 'Start enrolment first');
      if (!crypto.totp.verify(code, crypto.decrypt(u.totp_secret_enc))) throw new HttpError(422, 'totp_invalid', 'Wrong code');
      stmts.setTotp.run(u.totp_secret_enc, 1, id);
      return publicView(stmts.byId.get(id));
    },
    totpDisable(id, code) {
      const u = this.get(id);
      if (u.totp_enabled && !crypto.totp.verify(code, crypto.decrypt(u.totp_secret_enc))) throw new HttpError(422, 'totp_invalid', 'Wrong code');
      stmts.setTotp.run(null, 0, id);
      return publicView(stmts.byId.get(id));
    },
    async changePassword(id, { current, next }) {
      const u = this.get(id);
      if (!(await crypto.verifyPassword(current, u.password_hash))) throw unauthorized('Current password is wrong');
      stmts.setPassword.run(await crypto.hashPassword(next), id);
      ctx.portalSessionStore?.destroyUserSessions(id);
      return true;
    },
    async resetPassword(id, next) {
      this.get(id);
      stmts.setPassword.run(await crypto.hashPassword(next), id);
      ctx.portalSessionStore?.destroyUserSessions(id);
      return true;
    },
    update(id, { status, role }) {
      const u = this.get(id);
      stmts.setStatus.run(status ?? u.status, role ?? u.role, id);
      if (status === 'disabled') ctx.portalSessionStore?.destroyUserSessions(id);
      return publicView(stmts.byId.get(id));
    },
  };
}
