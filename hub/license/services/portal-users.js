import { authenticator } from 'otplib';
import { HttpError, notFound, conflict, unauthorized } from '../../shared/errors.js';
import { newId, nowIso, paginate } from '../../shared/db.js';
import { PORTAL_ROLES } from '../../shared/auth.js';

const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60_000;
const TOTP_STEP_MS = 30_000;
// Every code the account presents (login, step-up, re-enrol, confirm, disable)
// draws on one budget, so a stolen session cookie cannot be stepped up by
// guessing and a distributed guess cannot walk the code space either.
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCK_MS = 15 * 60_000;
// Compared against when the e-mail is unknown so login timing does not reveal
// which portal accounts exist (same bcrypt cost as real hashes).
const DUMMY_HASH = '$2a$12$LL9KdAMmGS4Dx5kqDJb.O.eY7dDnLy6NYwhdUcAhZzs8Uw1zVx2.G';

// hub.require_totp_for_admins: the roles that must enrol an authenticator app
// at their first login (vendor_support and reseller_staff may enrol freely).
export const TOTP_ENFORCED_ROLES = ['vendor_admin', 'reseller_admin'];
export const REQUIRE_TOTP_SETTING = 'hub.require_totp_for_admins';
const SETTING_DEFAULTS = { [REQUIRE_TOTP_SETTING]: true };

function assertRoleTenant(role, resellerId) {
  if (!PORTAL_ROLES.includes(role)) throw new HttpError(422, 'validation_failed', 'Unknown role');
  if (role.startsWith('reseller_') && !resellerId) throw new HttpError(422, 'validation_failed', 'Reseller roles need reseller_id');
  if (role.startsWith('vendor_') && resellerId) throw new HttpError(422, 'validation_failed', 'Vendor roles cannot belong to a reseller');
}

export function createPortalUsersService(ctx) {
  const db = ctx.dbs.license;
  const { crypto } = ctx;
  const now = () => ctx.clock.now();
  const stmts = {
    byId: db.prepare('SELECT * FROM portal_users WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM portal_users WHERE email = ?'),
    insert: db.prepare(`INSERT INTO portal_users (id, reseller_id, email, password_hash, role, status, created_at) VALUES (@id, @reseller_id, @email, @password_hash, @role, 'active', @now)`),
    setPassword: db.prepare('UPDATE portal_users SET password_hash = ? WHERE id = ?'),
    setTotp: db.prepare('UPDATE portal_users SET totp_secret_enc = ?, totp_enabled = ?, totp_pending_enc = NULL, totp_enrolled_at = ? WHERE id = ?'),
    setPendingTotp: db.prepare('UPDATE portal_users SET totp_pending_enc = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE portal_users SET status = ?, role = ? WHERE id = ?'),
    loginOk: db.prepare('UPDATE portal_users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'),
    loginFail: db.prepare('UPDATE portal_users SET failed_logins = failed_logins + 1, locked_until = @locked WHERE id = @id'),
    totpOk: db.prepare('UPDATE portal_users SET totp_failures = 0, totp_locked_until = NULL, totp_last_step = @step WHERE id = @id'),
    totpFail: db.prepare('UPDATE portal_users SET totp_failures = @failures, totp_locked_until = @locked WHERE id = @id'),
    linkReseller: db.prepare('UPDATE resellers SET portal_user_id = ? WHERE id = ?'),
    setting: db.prepare('SELECT value_json FROM vendor_settings WHERE key = ?'),
    putSetting: db.prepare(`INSERT INTO vendor_settings (key, value_json, updated_at, updated_by) VALUES (@key, @value, @now, @by)
      ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  };

  function getSetting(key, fallback = SETTING_DEFAULTS[key]) {
    const row = stmts.setting.get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value_json); } catch { return fallback; }
  }
  function setSetting(key, value, { by = null } = {}) {
    stmts.putSetting.run({ key, value: JSON.stringify(value), now: nowIso(now()), by });
  }
  const requireTotpForAdmins = () => getSetting(REQUIRE_TOTP_SETTING) === true;
  // True when this user may only reach /v1/portal/* until an authenticator is confirmed.
  function enrolmentRequired(u) {
    return Boolean(u) && !u.totp_enabled && TOTP_ENFORCED_ROLES.includes(u.role) && requireTotpForAdmins();
  }

  function publicView(u) {
    return u ? { id: u.id, email: u.email, role: u.role, reseller_id: u.reseller_id, totp_enabled: !!u.totp_enabled, totp_enrolled_at: u.totp_enrolled_at || null, totp_enrol_required: enrolmentRequired(u), status: u.status, last_login_at: u.last_login_at, created_at: u.created_at } : null;
  }

  const totpLocked = (u) => Boolean(u.totp_locked_until && new Date(u.totp_locked_until).getTime() > now());

  // The time step a code belongs to, or null when it does not verify. otplib
  // reads the clock itself, so the same instant is handed to it and used for
  // the index: a step boundary between two reads could not shift the result.
  // Wall-clock time on purpose (ctx.clock is for the hub's own bookkeeping):
  // authenticator apps are on wall-clock time too.
  function codeStep(code, secretEnc) {
    if (!secretEnc) return null;
    const epoch = Date.now();
    const delta = authenticator.clone({ epoch }).checkDelta(String(code || '').replace(/\s+/g, ''), crypto.decrypt(secretEnc));
    return delta === null ? null : Math.floor(epoch / TOTP_STEP_MS) + delta;
  }

  // Verifies one code against the live secret (or the pending one during
  // enrolment). 429 while the budget is exhausted; a wrong code counts, a right
  // one resets the count. RFC 6238 §5.2: a code is accepted once per account,
  // so a step at or before the last accepted one (totp_last_step) is a replay
  // and refused, whatever the purpose the first use had; it did verify, so it
  // is no guessing signal and leaves the budget alone.
  function checkCode(u, code, secretEnc = u.totp_secret_enc) {
    if (totpLocked(u)) throw Object.assign(new HttpError(429, 'totp_rate_limited', 'Too many wrong codes; wait a few minutes and try again'), { retryAfterS: Math.ceil(TOTP_LOCK_MS / 1000) });
    const step = codeStep(code, secretEnc);
    if (step !== null) {
      if (u.totp_last_step == null || step > u.totp_last_step) {
        stmts.totpOk.run({ id: u.id, step });
        return true;
      }
      throw new HttpError(422, 'totp_reused', 'That code was already used; wait for the next one');
    }
    // A lock that has lapsed starts a fresh budget.
    const failures = (u.totp_locked_until ? 0 : u.totp_failures || 0) + 1;
    stmts.totpFail.run({ id: u.id, failures, locked: failures >= TOTP_MAX_FAILURES ? nowIso(now() + TOTP_LOCK_MS) : null });
    return false;
  }

  return {
    publicView,
    enrolmentRequired,
    requireTotpForAdmins,
    // Vendor-wide portal policy, read by the admin Security page.
    settings() {
      return { require_totp_for_admins: requireTotpForAdmins(), enforced_roles: TOTP_ENFORCED_ROLES };
    },
    updateSettings({ require_totp_for_admins }, { by = null } = {}) {
      if (typeof require_totp_for_admins === 'boolean') setSetting(REQUIRE_TOTP_SETTING, require_totp_for_admins, { by });
      return this.settings();
    },
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
      assertRoleTenant(role, reseller_id);
      const mail = String(email).toLowerCase();
      if (stmts.byEmail.get(mail)) throw conflict('A portal user with that e-mail already exists', 'user_exists');
      if (reseller_id) ctx.resellers.get(reseller_id);
      const id = newId('usr', now());
      stmts.insert.run({ id, reseller_id, email: mail, password_hash: await crypto.hashPassword(password), role, now: nowIso(now()) });
      if (reseller_id && role === 'reseller_admin') stmts.linkReseller.run(id, reseller_id);
      return publicView(stmts.byId.get(id));
    },
    // Password + (when enrolled) TOTP. 10 failures lock the account for 15 min;
    // a wrong code also spends the TOTP budget.
    async authenticate({ email, password, totp }) {
      const u = stmts.byEmail.get(String(email).toLowerCase());
      const fail = () => { if (u) stmts.loginFail.run({ id: u.id, locked: u.failed_logins + 1 >= LOCK_AFTER ? nowIso(now() + LOCK_MS) : null }); throw unauthorized('Invalid e-mail, password or code'); };
      if (!u || u.status !== 'active') { await crypto.verifyPassword(password, DUMMY_HASH); fail(); }
      if (u.locked_until && new Date(u.locked_until).getTime() > now()) throw new HttpError(423, 'locked', 'Account temporarily locked after too many failed logins');
      if (!(await crypto.verifyPassword(password, u.password_hash))) fail();
      if (u.reseller_id) ctx.resellers.assertActive(u.reseller_id);
      if (u.totp_enabled) {
        if (!totp) throw new HttpError(401, 'totp_required', 'Enter your two-factor code');
        if (!checkCode(u, totp)) fail();
      }
      stmts.loginOk.run(nowIso(now()), u.id);
      return u;
    },
    verifyTotp(id, code) {
      const u = this.get(id);
      if (!u.totp_enabled) return false;
      return checkCode(u, code);
    },
    // Enrolment never weakens an enabled account: re-enrolling needs the
    // current code, and the new secret waits in totp_pending_enc until
    // totpConfirm proves it, so a hijacked session with a lapsed step-up can
    // neither drop 2FA nor swap in a secret it controls.
    totpEnroll(id, { code = null } = {}) {
      const u = this.get(id);
      if (u.totp_enabled) {
        if (!code) throw new HttpError(403, 'totp_required', 'Enter your current two-factor code to re-enrol');
        if (!checkCode(u, code)) throw new HttpError(422, 'totp_invalid', 'Wrong code');
      }
      const secret = crypto.totp.generateSecret();
      stmts.setPendingTotp.run(crypto.encrypt(secret), id);
      return { secret, uri: crypto.totp.keyUri(u.email, ctx.config?.license?.vendor?.name || 'WHM Hub', secret), reenrol: !!u.totp_enabled, required: enrolmentRequired(u) };
    },
    totpConfirm(id, code) {
      const u = this.get(id);
      if (!u.totp_pending_enc) throw new HttpError(409, 'totp_not_enrolled', 'Start enrolment first');
      if (!checkCode(u, code, u.totp_pending_enc)) throw new HttpError(422, 'totp_invalid', 'Wrong code');
      stmts.setTotp.run(u.totp_pending_enc, 1, nowIso(now()), id);
      return publicView(stmts.byId.get(id));
    },
    totpDisable(id, code) {
      const u = this.get(id);
      if (u.totp_enabled && !checkCode(u, code)) throw new HttpError(422, 'totp_invalid', 'Wrong code');
      stmts.setTotp.run(null, 0, null, id);
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
      if (role) assertRoleTenant(role, u.reseller_id);
      stmts.setStatus.run(status ?? u.status, role ?? u.role, id);
      if (status === 'disabled') ctx.portalSessionStore?.destroyUserSessions(id);
      return publicView(stmts.byId.get(id));
    },
  };
}
