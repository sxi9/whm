import { json, paginate } from '../db/index.js';
import { HttpError, forbidden, notFound, conflict, unauthorized, unprocessable } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import { PANEL_SCOPES } from '../routes/panel/index.js';

// Customer panel core (ctx.panel):
//   panel.ensureUser(usernameOrAccount, req)      -> link a role-user login to a hosting account (idempotent)
//   panel.backfill()                               -> ensureUser for every account without a link
//   panel.syncPassword(username, password)         -> write the bcrypt hash the Linux side was just set to
//   panel.scope(req)                               -> the single account for this session (§3.1), or throws
//   panel.loginAs(username, user, req) / logoutAs(req)
//   panel.changePassword(scope, input, req)        -> §2.2 panel-side flow (host first, both stores, sessions)
//   panel.changePasswordForUser(userId, input, req) -> the same flow for routes/auth.js (null when not an account user)
//   panel.recovery.request({ username | email }, req) / confirm({ token, password }, req)
//                                                  -> forgot-password by e-mail (routes/auth.js, public)
//   panel.adminReset2fa(username, user, req)       -> clear the account login's authenticator (console)
//   panel.assertTwoFactor(user, path?)             -> the panel 2FA policy (panelScope + the core password seam)
//   panel.preferences.get/setContact/setLocale(scope, …) / notifyFor(username) -> contact, language, notifications (§50)
//   panel.audit(req, entry)                        -> audit row carrying actingAs/by while impersonating

export const LOGIN_AS_TTL = { min: 5, max: 480, fallback: 60 };
export const RESET_TOKEN_TTL_MS = 30 * 60_000;
// Requests per login per hour beyond which further mails are silently skipped
// (the address limiter in routes/auth.js bounds the rest).
const RESET_MAX_PER_HOUR = 3;
const SETTING_KEYS = ['panel.enabled', 'panel.require_2fa_for_users', 'panel.login_as_ttl_minutes', 'panel.login_as_acl', 'panel.webmail_url', 'panel.upload_chunk_bytes'];
const SOFT_OP_CODES = new Set(['capability_missing', 'binary_not_found', 'path_not_allowed', 'command_failed', 'spawn_failed']);

export const SYSTEM_ROOT = Object.freeze({ id: null, username: 'panel', role: 'root' });

const nowIso = () => new Date().toISOString();

export function createPanelService(ctx) {
  const { db, crypto, settings, logger, config } = ctx;
  const stmts = {
    accountByUsername: db.prepare('SELECT * FROM accounts WHERE username = ?'),
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    accountForUser: db.prepare('SELECT a.* FROM accounts a JOIN account_users au ON au.account_id = a.id WHERE au.user_id = ?'),
    linkByAccount: db.prepare('SELECT * FROM account_users WHERE account_id = ?'),
    linkByUser: db.prepare('SELECT * FROM account_users WHERE user_id = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare("INSERT INTO users (username, email, role, password_hash, suspended) VALUES (?, ?, 'user', NULL, ?)"),
    insertLink: db.prepare('INSERT INTO account_users (user_id, account_id) VALUES (?, ?)'),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ? AND role = 'user'"),
    setUserSuspended: db.prepare('UPDATE users SET suspended = ? WHERE id = ?'),
    setUserEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
    stripCredentials: db.prepare('UPDATE users SET password_hash = NULL, totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ?'),
    setPasswordHash: db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?"),
    setSyncedAt: db.prepare('UPDATE account_users SET password_synced_at = ? WHERE user_id = ?'),
    clearForcePassword: db.prepare("UPDATE accounts SET force_password_change = 0, updated_at = datetime('now') WHERE id = ?"),
    unlinkedAccounts: db.prepare('SELECT a.username FROM accounts a LEFT JOIN account_users au ON au.account_id = a.id WHERE au.user_id IS NULL ORDER BY a.username'),
    domains: db.prepare('SELECT * FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    domainCounts: db.prepare('SELECT type, COUNT(*) AS n FROM account_domains WHERE account_id = ? GROUP BY type'),
    mailboxCount: db.prepare('SELECT COUNT(*) AS n FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE md.account_id = ?'),
    databaseCount: db.prepare('SELECT COUNT(*) AS n FROM databases WHERE account_id = ?'),
    insertLoginAs: db.prepare('INSERT INTO panel_login_as (actor_id, account_id, started_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)'),
    loginAsById: db.prepare('SELECT * FROM panel_login_as WHERE id = ?'),
    endLoginAs: db.prepare('UPDATE panel_login_as SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    endActorLoginAs: db.prepare('UPDATE panel_login_as SET ended_at = ? WHERE actor_id = ? AND ended_at IS NULL'),
    tokensForUser: db.prepare('SELECT id, name, scopes, expires_at, last_used_at, created_at, prefix FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC'),
    tokenForUser: db.prepare('SELECT id, name, scopes, expires_at, last_used_at, created_at, prefix FROM api_tokens WHERE id = ? AND user_id = ?'),
    tokenCount: db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?'),
    insertToken: db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at, prefix, created_ip) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    deleteToken: db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?'),
    sessionsForUser: db.prepare('SELECT sid, expires_at FROM sessions WHERE user_id = ? AND expires_at >= ?'),
    hostingAccountOf: db.prepare('SELECT account_id FROM account_domains WHERE domain = ? UNION SELECT id AS account_id FROM accounts WHERE domain = ?'),
    usernameOfAccount: db.prepare('SELECT username FROM accounts WHERE id = ?'),
    accountUserByUsername: db.prepare("SELECT u.*, a.contact_email AS account_email, a.suspended AS account_suspended FROM users u JOIN account_users au ON au.user_id = u.id JOIN accounts a ON a.id = au.account_id WHERE u.role = 'user' AND u.username = ?"),
    accountUsersByEmail: db.prepare("SELECT u.*, a.contact_email AS account_email, a.suspended AS account_suspended FROM users u JOIN account_users au ON au.user_id = u.id JOIN accounts a ON a.id = au.account_id WHERE u.role = 'user' AND lower(a.contact_email) = lower(?) ORDER BY u.id LIMIT 5"),
    recentResets: db.prepare("SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')"),
    voidOtherResets: db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND id <> ?'),
    insertReset: db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)'),
    deleteReset: db.prepare('DELETE FROM password_reset_tokens WHERE id = ?'),
    resetByHash: db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?'),
    burnReset: db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL'),
    purgeResets: db.prepare("DELETE FROM password_reset_tokens WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')"),
    clearTotp: db.prepare("UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ? AND role = 'user'"),
    usersWithoutTotp: db.prepare("SELECT COUNT(*) AS n FROM users u JOIN account_users au ON au.user_id = u.id WHERE u.role = 'user' AND u.totp_enabled = 0"),
    linkedUsers: db.prepare("SELECT COUNT(*) AS n FROM users u JOIN account_users au ON au.user_id = u.id WHERE u.role = 'user'"),
    setContactEmail: db.prepare("UPDATE accounts SET contact_email = ?, updated_at = datetime('now') WHERE id = ?"),
    setUserLocale: db.prepare("UPDATE users SET locale = ? WHERE id = ? AND role = 'user'"),
    prefs: db.prepare('SELECT * FROM panel_account_prefs WHERE account_id = ?'),
    upsertPrefs: db.prepare(`INSERT INTO panel_account_prefs (account_id, email2, notify_quota, notify_bandwidth, notify_password_change, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (account_id) DO UPDATE SET email2 = excluded.email2, notify_quota = excluded.notify_quota, notify_bandwidth = excluded.notify_bandwidth, notify_password_change = excluded.notify_password_change, updated_at = excluded.updated_at`),
  };

  // Tables owned by the mail and FTP units may not exist on this tree yet.
  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  // Accounts with mail rows for a domain (tables of the mail unit, 033b, may be absent).
  const mailHoldersOf = (domain) => {
    const tables = ['mail_domains', 'mail_forwarders', 'mail_domain_forwarders', 'mail_autoresponders'].filter(tableExists);
    if (!tables.length) return [];
    return db.prepare(tables.map((t) => `SELECT account_id FROM ${t} WHERE domain = ? AND account_id IS NOT NULL`).join(' UNION ')).all(...tables.map(() => domain)).map((r) => r.account_id);
  };
  const optionalCount = (table, column = 'account_id') => {
    let stmt = null;
    let checked = false;
    return (accountId) => {
      if (!checked) {
        checked = true;
        if (tableExists(table)) {
          const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (cols.includes(column)) stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`);
        }
      }
      return stmt ? stmt.get(accountId).n : 0;
    };
  };
  const forwarderCount = optionalCount('mail_forwarders');
  const ftpCount = optionalCount('ftp_accounts');

  function shapeAccount(row) {
    if (!row) return null;
    return {
      ...row,
      suspended: Boolean(row.suspended), demo_mode: Boolean(row.demo_mode), force_password_change: Boolean(row.force_password_change),
      plan: json.parse(row.plan_snapshot_json, {}), plan_snapshot_json: undefined,
    };
  }

  function audit(req, entry) {
    const acting = req?.panel?.mode === 'acting' ? { actingAs: req.panel.username, by: req.panel.actor?.username ?? null } : null;
    const full = acting ? { ...entry, args: { ...(entry.args || {}), ...acting } } : entry;
    if (req?.audit) return req.audit(full);
    return ctx.auditRecord?.(null, full);
  }

  const principalOf = (user) => (user ? { id: user.id, username: user.username, role: user.role } : null);

  // ---------------------------------------------------------------- identity

  // Adopting an unlinked role-user row that happens to carry the new account's
  // username hands that account's panel to whoever holds the row's password, so
  // credentials survive only on the boot backfill (an account that pre-dates a
  // reseller demotion) and `suspended` is never lowered by an implicit path.
  function ensureUser(target, req, { keepCredentials = false, alignSuspended = false, by = null } = {}) {
    const username = typeof target === 'string' ? target : target?.username;
    const account = username ? stmts.accountByUsername.get(username) : null;
    if (!account) throw notFound('Account');
    const link = stmts.linkByAccount.get(account.id);
    if (link) return { userId: link.user_id, accountId: account.id, username: account.username, created: false, adopted: false, linked: true };
    const existing = stmts.userByUsername.get(account.username);
    if (existing && existing.role !== 'user') {
      return { userId: null, accountId: account.id, username: account.username, created: false, adopted: false, linked: false, reason: 'username_is_admin' };
    }
    if (existing) {
      if (stmts.linkByUser.get(existing.id)) throw conflict(`The login "${account.username}" is already linked to another account`);
      const suspended = alignSuspended ? (account.suspended ? 1 : 0) : Math.max(existing.suspended ? 1 : 0, account.suspended ? 1 : 0);
      db.transaction(() => {
        stmts.insertLink.run(existing.id, account.id);
        stmts.setUserSuspended.run(suspended, existing.id);
        if (!keepCredentials) stmts.stripCredentials.run(existing.id);
        if (!existing.email && account.contact_email) stmts.setUserEmail.run(account.contact_email, existing.id);
      })();
      if (!keepCredentials) ctx.sessionStore?.destroyUserSessions?.(existing.id);
      audit(req, { action: 'panel.user.adopt', target: account.username, args: { userId: existing.id, credentialsKept: keepCredentials, suspended: Boolean(suspended), by: req?.user?.username ?? by } });
      return { userId: existing.id, accountId: account.id, username: account.username, created: false, adopted: true, linked: true, credentialsKept: keepCredentials };
    }
    const userId = db.transaction(() => {
      const { lastInsertRowid } = stmts.insertUser.run(account.username, account.contact_email || null, account.suspended ? 1 : 0);
      stmts.insertLink.run(lastInsertRowid, account.id);
      return Number(lastInsertRowid);
    })();
    audit(req, { action: 'panel.user.create', target: account.username, args: { userId } });
    return { userId, accountId: account.id, username: account.username, created: true, adopted: false, linked: true };
  }

  function backfill() {
    const result = { created: 0, adopted: 0, skipped: 0 };
    for (const { username } of stmts.unlinkedAccounts.all()) {
      try {
        const r = ensureUser(username, null, { keepCredentials: true, by: 'boot' });
        if (r.created) result.created++;
        else if (r.adopted) result.adopted++;
        else result.skipped++;
      } catch (err) {
        result.skipped++;
        logger.warn({ err, username }, 'panel backfill: could not link account user');
      }
    }
    return result;
  }

  // The Linux password was just set by the caller (accounts.create/setPassword
  // or the panel's own flow); only the bcrypt hash is written here.
  async function syncPassword(username, password) {
    const account = stmts.accountByUsername.get(username);
    if (!account) throw notFound('Account');
    let link = stmts.linkByAccount.get(account.id);
    if (!link) {
      const r = ensureUser(username, null);
      if (!r.linked) return { synced: false, reason: r.reason };
      link = stmts.linkByAccount.get(account.id);
    }
    const hash = await crypto.hashPassword(password);
    db.transaction(() => {
      stmts.setPasswordHash.run(hash, link.user_id);
      stmts.setSyncedAt.run(nowIso(), link.user_id);
    })();
    return { synced: true, userId: link.user_id };
  }

  function setSuspended(username, suspended) {
    const account = stmts.accountByUsername.get(username);
    const link = account ? stmts.linkByAccount.get(account.id) : null;
    if (!link) return { applied: false };
    stmts.setUserSuspended.run(suspended ? 1 : 0, link.user_id);
    if (suspended) ctx.sessionStore?.destroyUserSessions?.(link.user_id);
    return { applied: true, userId: link.user_id };
  }

  // account.terminated fires its 'pre' stage before accounts.terminate checks
  // ownership, so only the 'post' stage (the account row is gone, the link has
  // cascaded, the role-user row is still there) may touch sessions.
  function onTerminated(envelope) {
    const username = envelope?.payload?.username;
    if (!username || envelope.stage !== 'post') return;
    const user = stmts.userByUsername.get(username);
    if (!user || user.role !== 'user' || stmts.linkByUser.get(user.id) || stmts.accountByUsername.get(username)) return;
    ctx.sessionStore?.destroyUserSessions?.(user.id);
    stmts.deleteUser.run(user.id);
    audit(null, { action: 'panel.user.remove', target: username, args: { userId: user.id } });
  }

  function subscribe(events = ctx.events) {
    if (!events?.on) return () => {};
    const offs = [
      events.on('account.created', (e) => { if (e.stage === 'post') { try { ensureUser(e.payload?.username, null, { by: e.principal ?? null }); } catch (err) { logger.warn({ err }, 'panel: ensureUser after account.created failed'); } } }),
      events.on('account.suspended', (e) => { if (e.stage === 'post') setSuspended(e.payload?.username, true); }),
      events.on('account.unsuspended', (e) => { if (e.stage === 'post') setSuspended(e.payload?.username, false); }),
      events.on('account.terminated', onTerminated),
    ];
    return () => offs.forEach((off) => off?.());
  }

  function userStatus(username, user) {
    const account = ctx.accounts.get(username, user);
    const link = stmts.linkByAccount.get(account.id);
    const row = link ? stmts.userById.get(link.user_id) : null;
    const warnings = [];
    if (link && !link.password_synced_at) warnings.push('password_not_synced');
    if (link && !row?.password_hash) warnings.push('no_password');
    return {
      username: account.username, linked: Boolean(link), userId: link?.user_id ?? null,
      passwordSet: Boolean(row?.password_hash), passwordSyncedAt: link?.password_synced_at ?? null,
      totpEnabled: Boolean(row?.totp_enabled), suspended: Boolean(row?.suspended),
      lastLoginAt: row?.last_login_at ?? null, lastLoginIp: row?.last_login_ip ?? null,
      forcePasswordChange: Boolean(account.force_password_change), demoMode: Boolean(account.demo_mode), warnings,
    };
  }

  async function adminEnsureUser(username, { password } = {}, user, req) {
    ctx.accounts.get(username, user);
    const r = ensureUser(username, req, { alignSuspended: true });
    if (!r.linked) throw conflict(`"${username}" is the login of an administrator and cannot become an account user`);
    let password_synced = false;
    if (password) { await adminSetPassword(username, password, user, req); password_synced = true; }
    return { ...r, passwordSynced: password_synced };
  }

  // Both stores: the host (accounts.setPassword: Linux user, ACL "passwd",
  // force flag, audit) and then the panel hash.
  async function adminSetPassword(username, password, user, req) {
    await ctx.accounts.setPassword(username, password, user, req);
    const r = await syncPassword(username, password);
    audit(req, { action: 'panel.password.admin_set', target: username, args: { synced: r.synced } });
    return { username, synced: r.synced };
  }

  // ------------------------------------------------------------------- scope

  const loginAsAclKey = () => String(settings.get('panel.login_as_acl') || 'login-as');
  function assertLoginAsAcl(user) {
    if (isRoot(user)) return;
    if (!ctx.resellers?.assertAcl) throw forbidden('Reseller privileges are not available on this server, so only root may log in as an account');
    ctx.resellers.assertAcl(user, loginAsAclKey());
  }

  function endImpersonation(req, reason) {
    const acting = req.session?.panelActingAs;
    if (!acting) return;
    stmts.endLoginAs.run(nowIso(), acting.id);
    delete req.session.panelActingAs;
    audit(req, { action: 'panel.login_as.ended', target: acting.username, args: { reason, by: req.user?.username ?? null } });
  }

  function limitsFor(username, ownerPrincipal) {
    try {
      const fn = ctx.accountInfo?.effectiveLimits || ctx.accountInfo?.enhancements?.effectiveLimits;
      return fn ? fn(username, ownerPrincipal) || {} : {};
    } catch (err) {
      logger.debug({ err, username }, 'panel: effective limits unavailable');
      return {};
    }
  }

  function buildScope(req, row, mode, actingAs) {
    const account = shapeAccount(row);
    const owner = stmts.userById.get(account.owner_id) || null;
    const ownerPrincipal = principalOf(owner) || { id: account.owner_id, username: null, role: 'reseller' };
    return {
      account, accountId: account.id, username: account.username, mode,
      actor: req.user, actingAs, owner, ownerPrincipal,
      limits: limitsFor(account.username, ownerPrincipal),
      features: account.plan?.features && typeof account.plan.features === 'object' ? account.plan.features : {},
    };
  }

  function scope(req) {
    const user = req.user;
    if (!user) throw unauthorized();
    if (user.role === 'user') {
      const row = stmts.accountForUser.get(user.id);
      if (!row) throw new HttpError(403, 'no_account', 'This login is not linked to a hosting account');
      return buildScope(req, row, 'user', null);
    }
    const acting = req.session?.panelActingAs;
    if (!acting || (user.role !== 'root' && user.role !== 'reseller')) {
      throw new HttpError(403, 'panel_scope_required', 'The account panel is only available to account users, or to an administrator who is logged in as an account');
    }
    const ended = (reason, message) => { endImpersonation(req, reason); return new HttpError(403, 'login_as_ended', message); };
    const record = stmts.loginAsById.get(acting.id);
    if (!record || record.ended_at || record.actor_id !== user.id) throw ended('ended', 'The "log in as" session has ended');
    if (new Date(record.expires_at).getTime() <= Date.now()) throw ended('expired', 'The "log in as" session has expired');
    const row = stmts.accountById.get(record.account_id);
    if (!row) throw ended('account_removed', 'The account no longer exists');
    try { ctx.accounts.get(row.username, user); } catch { throw ended('ownership', 'You no longer own this account'); }
    try { assertLoginAsAcl(user); } catch { throw ended('acl', 'Your reseller privileges no longer allow logging in as an account'); }
    if (row.suspended) throw ended('account_suspended', 'The account was suspended');
    return buildScope(req, row, 'acting', { by: user.username, byId: user.id, expiresAt: record.expires_at, id: record.id });
  }

  function assertNotActing(scope) {
    if (scope?.mode === 'acting') throw new HttpError(403, 'not_while_impersonating', 'This action is not available while logged in as the account');
  }

  // The panel-side 2FA policy (§2.5), checked in one place: panelScope in
  // routes/categories/panel.js passes the request path so /me and the enrolment
  // routes stay reachable; the core password seam passes none. Administrators
  // acting as the account answer to the console's own policy, not this one.
  const TWO_FACTOR_OPEN = (p) => p === '/me' || p.startsWith('/security/two-factor');
  function assertTwoFactor(user, path = null) {
    if (!user || user.role !== 'user' || user.totp_enabled) return;
    if (!settings.get('panel.require_2fa_for_users')) return;
    if (path != null && TWO_FACTOR_OPEN(path)) return;
    throw new HttpError(403, 'two_factor_required', 'Two-factor authentication is required for your account. Set it up to continue.');
  }

  function ttlMinutes() {
    const n = Number(settings.get('panel.login_as_ttl_minutes'));
    if (!Number.isFinite(n)) return LOGIN_AS_TTL.fallback;
    return Math.min(LOGIN_AS_TTL.max, Math.max(LOGIN_AS_TTL.min, Math.round(n)));
  }

  function loginAs(username, user, req) {
    const account = ctx.accounts.get(username, user);
    assertLoginAsAcl(user);
    if (account.suspended) throw new HttpError(409, 'account_suspended', `${username} is suspended; unsuspend it before logging in as it`);
    if (req.auth?.via !== 'session' || !req.session) throw forbidden('"Log in as" needs a browser session');
    if (req.session.panelActingAs) endImpersonation(req, 'replaced');
    const startedAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlMinutes() * 60_000).toISOString();
    const { lastInsertRowid } = stmts.insertLoginAs.run(user.id, account.id, startedAt, expiresAt, req.ip ?? null);
    req.session.panelActingAs = { id: Number(lastInsertRowid), accountId: account.id, username: account.username, by: user.id, expiresAt };
    audit(req, { action: 'panel.login_as', target: username, args: { target: username, expiresAt } });
    return { account: { username: account.username, domain: account.domain, owner: account.owner }, expiresAt, url: '/panel' };
  }

  function logoutAs(req) {
    const acting = req.session?.panelActingAs;
    if (!acting) return { ended: false };
    const username = acting.username;
    endImpersonation(req, 'logout');
    audit(req, { action: 'panel.logout_as', target: username });
    return { ended: true, username };
  }

  function loginAsHistory(query, user) {
    const where = [];
    const params = {};
    if (!isRoot(user)) { where.push('l.actor_id = @actor'); params.actor = user.id; }
    const result = paginate(db, {
      select: 'l.id, l.started_at, l.expires_at, l.ended_at, l.ip, u.username AS actor, a.username AS account',
      from: 'panel_login_as l JOIN users u ON u.id = l.actor_id LEFT JOIN accounts a ON a.id = l.account_id',
      where, params, sortable: { started_at: 'l.started_at', account: 'a.username', actor: 'u.username' }, defaultSort: 'started_at', query: { ...query, dir: query.dir || 'desc' },
    });
    return { ...result, data: result.data.map((r) => ({ ...r, active: !r.ended_at && new Date(r.expires_at).getTime() > Date.now() })) };
  }

  // ---------------------------------------------------------------------- me

  function counts(accountId) {
    const byType = Object.fromEntries(stmts.domainCounts.all(accountId).map((r) => [r.type, r.n]));
    return {
      domains: Object.values(byType).reduce((a, b) => a + b, 0),
      subdomains: byType.sub || 0, addons: byType.addon || 0, parked: (byType.parked || 0) + (byType.alias || 0),
      mailboxes: stmts.mailboxCount.get(accountId).n, forwarders: forwarderCount(accountId),
      databases: stmts.databaseCount.get(accountId).n, ftp: ftpCount(accountId),
    };
  }

  function me(req) {
    const s = req.panel || scope(req);
    const a = s.account;
    const userRow = s.mode === 'user' ? stmts.userById.get(req.user.id) : null;
    return {
      user: { ...ctx.auth.publicUser(req.user), locale: userRow?.locale ?? null },
      preferences: preferences.get(s),
      account: {
        username: a.username, domain: a.domain, ip: a.ip, package: a.package_name, plan: a.plan, features: s.features, limits: s.limits,
        suspended: a.suspended, forcePasswordChange: a.force_password_change, demoMode: a.demo_mode, contactEmail: a.contact_email, homeDir: a.home_dir, shell: a.shell,
        createdAt: a.created_at, domains: stmts.domains.all(a.id),
      },
      usage: { diskUsedMb: a.disk_used_mb ?? 0, diskQuotaMb: a.disk_quota_mb ?? null, bandwidthUsedMb: a.bandwidth_used_mb ?? 0, bandwidthLimitMb: a.bandwidth_limit_mb ?? null },
      counts: counts(a.id),
      actingAs: s.actingAs ? { account: a.username, by: s.actingAs.by, expiresAt: s.actingAs.expiresAt } : null,
      policy: { require2fa: Boolean(settings.get('panel.require_2fa_for_users')), passwordSynced: Boolean(userRow && stmts.linkByUser.get(userRow.id)?.password_synced_at) },
      hostname: settings.get('basic.hostname'),
      csrfToken: req.auth?.via === 'session' && req.session ? issueCsrfToken(req, crypto) : null,
    };
  }

  const userPrincipal = (s) => ({ id: s.mode === 'user' ? s.actor.id : null, username: s.username, role: 'user' });
  async function quickLinks(req) {
    const s = req.panel || scope(req);
    const principal = userPrincipal(s);
    const safe = (fn) => { try { return fn() || []; } catch (err) { logger.debug({ err }, 'panel quick links source failed'); return []; } };
    // The operator's URL, else the webmail the agent found published under the hostname site (panel-email.webmailUrl).
    let webmailUrl = settings.get('panel.webmail_url') || '';
    if (!webmailUrl && typeof ctx.panelEmail?.webmailUrl === 'function') {
      try { webmailUrl = (await ctx.panelEmail.webmailUrl()) || ''; } catch (err) { logger.debug({ err }, 'panel quick links: webmail detection failed'); }
    }
    return {
      apps: safe(() => ctx.development?.appconfig?.listFor?.(principal, 'cpanel')),
      news: safe(() => ctx.cpanel?.news?.active?.(principal)),
      webmailUrl,
    };
  }

  // ---------------------------------------------------------------- password

  const strict = () => config.env === 'production';
  async function hostSetPassword(s, password, req) {
    if (s.account.uid == null) return { applied: false, reason: 'no_system_user' };
    try {
      await ctx.agent.op('user.set_password', { username: s.username, password }, { req });
      return { applied: true };
    } catch (err) {
      if (strict() || !SOFT_OP_CODES.has(err.code)) throw err;
      logger.warn({ code: err.code, username: s.username }, 'panel: Linux password not set (development mode)');
      return { applied: false, reason: err.code };
    }
  }

  // `force` skips the current-password check only for a login core already
  // flagged with must_change_password (the forced-change path of /api/auth/password);
  // `recovery` is the e-mailed reset token, already burned by recovery.confirm.
  // Neither reaches here from a request body (strict schemas).
  async function changePassword(s, { currentPassword, newPassword, force = false, recovery = false }, req) {
    assertNotActing(s);
    const user = stmts.userById.get(s.actor.id);
    const link = user ? stmts.linkByUser.get(user.id) : null;
    if (!link || link.account_id !== s.accountId) throw forbidden('This login is not linked to the account');
    const forced = Boolean(force) && Boolean(user.must_change_password);
    if (!forced && !recovery && !(await crypto.verifyPassword(currentPassword || '', user.password_hash))) throw unauthorized('Current password is incorrect');
    const strength = ctx.security?.passwordStrength?.(newPassword, 'account');
    if (strength && !strength.ok) throw unprocessable(`Password is too weak (strength ${strength.score}, minimum ${strength.minimum})`, { newPassword: ['Choose a stronger password'] });
    const host = await hostSetPassword(s, newPassword, req);
    const hash = await crypto.hashPassword(newPassword);
    db.transaction(() => {
      stmts.setPasswordHash.run(hash, user.id);
      stmts.setSyncedAt.run(nowIso(), user.id);
      stmts.clearForcePassword.run(s.accountId);
    })();
    ctx.sessionStore?.destroyUserSessions?.(user.id);
    audit(req, { action: 'panel.password.change', target: s.username, args: { host, forced, recovery: Boolean(recovery) } });
    notifyPasswordChanged(s, req);
    return { changed: true, host };
  }

  // Seam for routes/auth.js POST /password: a login linked to a hosting account
  // changes its password through the §2.2 flow (host first, both stores) so the
  // forced-change path cannot leave the Linux password behind. Returns null
  // when the login is not an account user, and the caller keeps its own flow.
  const linkForUser = (userId) => stmts.linkByUser.get(userId) || null;
  async function changePasswordForUser(userId, { currentPassword, newPassword, force = false, recovery = false }, req) {
    const user = stmts.userById.get(userId);
    const link = user && user.role === 'user' ? stmts.linkByUser.get(user.id) : null;
    if (!link) return null;
    const row = stmts.accountById.get(link.account_id);
    if (!row) return null;
    const s = buildScope({ user }, row, 'user', null);
    // The gates of routes/categories/panel.js (panelScope) and of the panel's
    // own password route, which this seam bypasses: a demo account's shared
    // credentials never change, a suspended account changes nothing, the
    // package may withhold password changes, and the 2FA policy holds; only
    // core's forced change (must_change_password) and a mailed reset (a
    // lockout path: the user may have no authenticator left) get through the last two.
    if (s.account.demo_mode) throw new HttpError(403, 'demo_mode', 'This account is in demo mode; changes are not saved');
    if (s.account.suspended) throw new HttpError(423, 'account_suspended', 'This account is suspended');
    const forced = (Boolean(force) && Boolean(user.must_change_password)) || Boolean(recovery);
    if (!forced) {
      if (s.features?.passwordchange === false) throw new HttpError(403, 'feature_disabled', 'Your hosting package does not include password changes');
      assertTwoFactor(user);
    }
    return changePassword(s, { currentPassword, newPassword, force, recovery }, req);
  }

  // ------------------------------------------------------------- preferences

  // Contact addresses live on the account row (the console's contactEmail,
  // also the forgot-password address) and are mirrored to the linked login;
  // the switches and the second address are the account's own row; the
  // language is the login's (never written while acting: that row is root's).
  const enabledLocales = () => {
    try { return (ctx.locales?.list?.()?.data || []).filter((l) => l.enabled).map((l) => ({ code: l.code, name: l.name })); } catch { return []; }
  };
  const preferences = {
    get(s) {
      const a = stmts.accountById.get(s.accountId) || s.account;
      const row = stmts.prefs.get(s.accountId);
      const link = stmts.linkByAccount.get(s.accountId);
      const login = link ? stmts.userById.get(link.user_id) : null;
      return {
        email: a.contact_email || null, email2: row?.email2 || null,
        notify: { quota: row ? Boolean(row.notify_quota) : true, bandwidth: row ? Boolean(row.notify_bandwidth) : true, passwordChange: row ? Boolean(row.notify_password_change) : true },
        locale: login?.locale ?? null, locales: enabledLocales(), defaultLocale: ctx.locales?.defaultCode?.() ?? 'en',
      };
    },
    // The contact address is the forgot-password address, so a live session
    // alone cannot move it: the login's password is checked again (an
    // administrator acting as the account already authenticated to the
    // console) and the previous address is told.
    async setContact(s, { email, email2 = null, notify = {}, currentPassword }, req) {
      if (s.mode !== 'acting') await assertCurrentPassword(s, currentPassword);
      const before = preferences.get(s);
      const next = { quota: notify.quota ?? before.notify.quota, bandwidth: notify.bandwidth ?? before.notify.bandwidth, passwordChange: notify.passwordChange ?? before.notify.passwordChange };
      const link = stmts.linkByAccount.get(s.accountId);
      db.transaction(() => {
        stmts.setContactEmail.run(email, s.accountId);
        if (link) stmts.setUserEmail.run(email, link.user_id);
        stmts.upsertPrefs.run(s.accountId, email2 || null, next.quota ? 1 : 0, next.bandwidth ? 1 : 0, next.passwordChange ? 1 : 0);
      })();
      audit(req, { action: 'panel.me.contact', target: s.username, args: { email, email2: email2 || null, notify: next, previousEmail: before.email } });
      if (before.email && before.email !== email) notifyContactChanged(s, before.email, email, req);
      return preferences.get(s);
    },
    setLocale(s, { locale }, req) {
      assertNotActing(s);
      const code = locale || null;
      if (code && !enabledLocales().some((l) => l.code === code)) throw unprocessable('That language is not available on this server', { locale: ['Pick one of the enabled languages'] });
      stmts.setUserLocale.run(code, s.actor.id);
      audit(req, { action: 'panel.me.locale', target: s.username, args: { locale: code } });
      return preferences.get(s);
    },
    // Seam for whoever mails the account (quota/bandwidth warnings): the
    // addresses to use and whether the customer wants that kind of message.
    notifyFor(username) {
      const account = stmts.accountByUsername.get(username);
      if (!account) return null;
      const p = preferences.get({ accountId: account.id, account, username });
      return { to: [p.email, p.email2].filter(Boolean), notify: p.notify };
    },
  };

  async function assertCurrentPassword(s, currentPassword) {
    const user = stmts.userById.get(s.actor?.id);
    const link = user ? stmts.linkByUser.get(user.id) : null;
    if (!link || link.account_id !== s.accountId) throw forbidden('This login is not linked to the account');
    if (!currentPassword) throw unprocessable('Confirm the change with your current password', { currentPassword: ['Enter your current password'] });
    if (!(await crypto.verifyPassword(currentPassword, user.password_hash))) throw unauthorized('Current password is incorrect');
  }

  // The address that just stopped being the recovery address hears about it,
  // detached like the password notice. Forgot-password now mails the new
  // address, so the advice is to reach the provider, not the sign-in page.
  function notifyContactChanged(s, previous, email, req) {
    if (!ctx.contacts?.sendMail) return;
    const company = companyName();
    const body = `The contact (password recovery) address of the ${company} account "${s.username}" on ${settings.get('basic.hostname') || 'this server'} was changed from ${previous} to ${email} from ${req?.ip || 'an unknown address'}. If that was not you, contact your hosting provider right away: password resets now go to the new address.`;
    try {
      Promise.resolve(ctx.contacts.sendMail({ to: previous, subject: `[${company}] Contact address changed for ${s.username}`, body }, req)).catch((err) => logger.debug({ err, username: s.username }, 'panel: contact-change notice not sent'));
    } catch (err) { logger.debug({ err, username: s.username }, 'panel: contact-change notice not sent'); }
  }

  // The customer asked to hear about password changes: a plain note to the
  // contact addresses, detached (never delays or fails the change itself).
  function notifyPasswordChanged(s, req) {
    const p = preferences.notifyFor(s.username);
    if (!p?.notify.passwordChange || !p.to.length || !ctx.contacts?.sendMail) return;
    const company = companyName();
    const body = `The password of the ${company} account "${s.username}" on ${settings.get('basic.hostname') || 'this server'} was changed from ${req?.ip || 'an unknown address'}. If that was not you, use "Forgot password" on the sign-in page right away.`;
    for (const to of p.to) {
      try {
        Promise.resolve(ctx.contacts.sendMail({ to, subject: `[${company}] Password changed for ${s.username}`, body }, req)).catch((err) => logger.debug({ err, username: s.username }, 'panel: password-change notice not sent'));
      } catch (err) { logger.debug({ err, username: s.username }, 'panel: password-change notice not sent'); }
    }
  }

  // ---------------------------------------------------------------- recovery

  // Forgot-password for account users (routes/auth.js, public). A request
  // never says whether the login exists: the outcome lives only in the audit
  // row, and the response never waits for the token or the mail transport
  // (hundreds of ms through Exim or a relay) — only the lookups run before the
  // 202, the rest continues detached, so an unknown login and a real one
  // answer alike. Tokens are random, stored hashed, valid RESET_TOKEN_TTL_MS,
  // single-use; a delivered request voids the login's earlier unused ones.
  const panelUrl = () => {
    const host = settings.get('basic.hostname') || 'localhost';
    return config.tls ? `https://${host}:${config.tlsPort}` : `http://${host}:${config.port}`;
  };
  const companyName = () => {
    try { return ctx.cpanel?.branding?.get?.()?.companyName || 'Keel'; } catch { return 'Keel'; }
  };
  // The new link is stored before the mail leaves and the earlier unused ones
  // are voided only once it did: a failed transport leaves the previous link
  // working and the attempt does not count toward RESET_MAX_PER_HOUR.
  async function deliverResets(users, req) {
    stmts.purgeResets.run();
    const sentTo = [];
    let reason = null;
    for (const user of users) {
      if (stmts.recentResets.get(user.id).n >= RESET_MAX_PER_HOUR) { reason = 'throttled'; continue; }
      const token = crypto.randomToken(32);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      const id = Number(stmts.insertReset.run(user.id, crypto.hashToken(token), expiresAt, req?.ip ?? null).lastInsertRowid);
      const company = companyName();
      const host = settings.get('basic.hostname') || 'this server';
      const body = [
        `Hello ${user.username},`,
        '',
        `Someone asked to reset the password of the ${company} account "${user.username}" on ${host}. If that was you, open this link within ${RESET_TOKEN_TTL_MS / 60_000} minutes:`,
        '',
        `${panelUrl()}/login/reset/${token}`,
        '',
        'If you did not ask for a reset, ignore this message; your password stays unchanged.',
      ].join('\n');
      try {
        await ctx.contacts.sendMail({ to: user.account_email, subject: `[${company}] Reset the password of ${user.username}`, body }, req);
        stmts.voidOtherResets.run(nowIso(), user.id, id);
        sentTo.push(user.username);
      } catch (err) {
        stmts.deleteReset.run(id);
        reason = 'mail_failed';
        logger.warn({ err, username: user.username }, 'panel recovery: reset mail not sent');
      }
    }
    return { sentTo, reason };
  }

  let resetsInFlight = Promise.resolve();
  const recovery = {
    available: () => panelSettings.enabled() && Boolean(ctx.contacts?.sendMail),
    // Settles once every detached request so far has written its audit row (tests, shutdown).
    pending: () => resetsInFlight,

    request({ username, email }, req) {
      const via = username ? 'username' : 'email';
      const target = username || String(email).toLowerCase();
      const done = (sent, reason, extra = {}) => {
        audit(req, { action: 'auth.reset.request', target, args: { via, sent, reason, ...extra }, result: sent ? 'ok' : 'skipped' });
        return { accepted: true };
      };
      if (!recovery.available()) return done(false, panelSettings.enabled() ? 'mail_unavailable' : 'panel_disabled');
      const candidates = username ? [stmts.accountUserByUsername.get(username)].filter(Boolean) : stmts.accountUsersByEmail.all(email);
      const users = candidates.filter((u) => !u.suspended && !u.account_suspended && u.account_email);
      if (!users.length) return done(false, candidates.length ? 'not_eligible' : 'unknown');
      const work = deliverResets(users, req).then(
        ({ sentTo, reason }) => done(sentTo.length > 0, sentTo.length ? null : reason, { users: sentTo }),
        (err) => { logger.warn({ err, target }, 'panel recovery: reset request failed'); done(false, 'error'); },
      );
      resetsInFlight = Promise.allSettled([resetsInFlight, work]).then(() => undefined);
      return { accepted: true };
    },

    async confirm({ token, password }, req) {
      const invalid = () => new HttpError(400, 'reset_token_invalid', 'This reset link is invalid, has expired or was already used. Request a new one.');
      const row = stmts.resetByHash.get(crypto.hashToken(token));
      if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) throw invalid();
      if (!panelSettings.enabled()) throw new HttpError(403, 'panel_disabled', 'The account panel is disabled on this server');
      const user = stmts.userById.get(row.user_id);
      if (!user || user.role !== 'user' || user.suspended) throw invalid();
      // Burned before the password is written: a token that raced a second
      // submit, or one whose host write failed, is spent either way.
      if (stmts.burnReset.run(nowIso(), row.id).changes !== 1) throw invalid();
      const r = await changePasswordForUser(user.id, { newPassword: password, recovery: true }, req);
      if (!r) throw invalid();
      audit(req, { action: 'auth.reset.confirm', target: user.username, args: { host: r.host } });
      return { username: user.username, changed: true };
    },
  };

  // The console's answer to a customer who lost the authenticator: the
  // account login's TOTP secret is dropped and its sessions end. Resellers may
  // do it for the accounts they own (ctx.accounts.get checks ownership), the
  // same bar as setting the account's password.
  function adminReset2fa(username, user, req) {
    const account = ctx.accounts.get(username, user);
    const link = stmts.linkByAccount.get(account.id);
    const row = link ? stmts.userById.get(link.user_id) : null;
    if (!row) throw notFound('Account login');
    const wasEnabled = Boolean(row.totp_enabled);
    stmts.clearTotp.run(row.id);
    ctx.sessionStore?.destroyUserSessions?.(row.id);
    audit(req, { action: 'panel.admin.2fa.reset', target: username, args: { userId: row.id, wasEnabled } });
    return { username, totpEnabled: false, wasEnabled, enrollmentRequired: Boolean(settings.get('panel.require_2fa_for_users')) };
  }

  // Root's answer to a 409 domain_stale: the mail rows and host files of
  // `domain` that accounts other than its current owner left behind are
  // released; when no other account holds any, the current (or last) owner's
  // are. Every release is audited by the mail unit itself.
  async function releaseMailDomain(domain, req) {
    if (typeof ctx.panelEmail?.releaseDomain !== 'function') throw new HttpError(503, 'service_unavailable', 'The panel mail unit is not loaded');
    const current = stmts.hostingAccountOf.get(domain, domain)?.account_id ?? null;
    const holders = [...new Set(mailHoldersOf(domain))];
    let targets = holders.filter((id) => id !== current);
    if (!targets.length && current != null) targets = [current];
    if (!targets.length) throw notFound(`Mail settings of ${domain}`);
    const results = [];
    for (const accountId of targets) {
      const username = stmts.usernameOfAccount.get(accountId)?.username ?? null;
      const r = await ctx.panelEmail.releaseDomain(domain, accountId, req, { username });
      results.push({ accountId, username, released: Boolean(r.released), rows: r.rows ?? null, autoresponders: r.autoresponders, passwdPurged: r.passwdPurged, errors: (r.errors || []).map((e) => ({ op: e.op, code: e.code ?? null, message: e.message })) });
    }
    const released = results.every((r) => r.released);
    audit(req, { action: 'panel.admin.domain.release_mail', target: domain, args: { accounts: results.map((r) => r.username ?? r.accountId), currentAccountId: current, released } });
    return { domain, currentAccountId: current, released, results };
  }

  // After destroyUserSessions the caller's own session is gone too: give it a
  // fresh id bound to the same user, the way routes/auth.js re-creates sessions.
  function reestablish(req) {
    return new Promise((resolve, reject) => {
      if (!req.session?.regenerate) return resolve({ csrfToken: null });
      const userId = req.user.id;
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = userId;
        req.session.lastActivity = Date.now();
        resolve({ csrfToken: issueCsrfToken(req, crypto) });
      });
    });
  }

  function sessions(s) {
    assertNotActing(s);
    return stmts.sessionsForUser.all(s.actor.id, Date.now()).map((r) => ({ id: crypto.hashToken(r.sid).slice(0, 16), expiresAt: new Date(r.expires_at).toISOString() }));
  }

  // ------------------------------------------------------------------ tokens

  const shapeToken = (t) => ({ id: t.id, name: t.name, scopes: json.parse(t.scopes, []), prefix: t.prefix, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, createdAt: t.created_at });
  const tokens = {
    list(s) {
      assertNotActing(s);
      return stmts.tokensForUser.all(s.actor.id).map(shapeToken);
    },
    get(s, id) {
      assertNotActing(s);
      const row = stmts.tokenForUser.get(id, s.actor.id);
      if (!row) throw notFound('API token');
      return shapeToken(row);
    },
    create(s, { name, scopes, expiresAt }, req) {
      assertNotActing(s);
      if (req.auth?.via !== 'session') throw forbidden('API tokens can only be issued from a browser session');
      if (s.features.api === false) throw new HttpError(403, 'feature_disabled', 'Your hosting package does not include API access');
      if (ctx.auth.policy().apiTokensRequire2fa && !req.user.totp_enabled) throw new HttpError(403, 'two_factor_required', 'The security policy requires two-factor authentication before API tokens can be issued');
      const bad = (scopes || []).filter((sc) => !PANEL_SCOPES.includes(sc));
      if (bad.length) throw unprocessable('Only panel scopes can be granted', { scopes: [`Unknown scope(s): ${bad.join(', ')}`] });
      const max = Number(settings.get('development.tokens.max_per_user') ?? 50) || 50;
      if (stmts.tokenCount.get(s.actor.id).n >= max) throw conflict(`At most ${max} API tokens per login`);
      const token = crypto.randomToken(32);
      const list = [...new Set(scopes?.length ? scopes : ['panel:read'])];
      const { lastInsertRowid } = stmts.insertToken.run(s.actor.id, name, crypto.hashToken(token), JSON.stringify(list), expiresAt ?? null, token.slice(0, 8), req.ip ?? null);
      audit(req, { action: 'panel.token.create', target: s.username, args: { name, scopes: list, expiresAt: expiresAt ?? null } });
      return { ...shapeToken(stmts.tokenForUser.get(lastInsertRowid, s.actor.id)), token };
    },
    remove(s, id, req) {
      assertNotActing(s);
      const row = stmts.tokenForUser.get(id, s.actor.id);
      if (!row) throw notFound('API token');
      stmts.deleteToken.run(id, s.actor.id);
      audit(req, { action: 'panel.token.revoke', target: s.username, args: { name: row.name, id } });
      return { id, deleted: true };
    },
  };

  // ---------------------------------------------------------------- settings

  const panelSettings = {
    get() {
      const raw = Object.fromEntries(SETTING_KEYS.map((k) => [k, settings.get(k)]));
      return {
        enabled: raw['panel.enabled'] !== false, require2faForUsers: Boolean(raw['panel.require_2fa_for_users']),
        loginAsTtlMinutes: ttlMinutes(), loginAsAcl: loginAsAclKey(), webmailUrl: String(raw['panel.webmail_url'] || ''),
        uploadChunkBytes: Number(raw['panel.upload_chunk_bytes']) || 1310720,
        // What switching require2faForUsers on will force at next login.
        linkedUsers: stmts.linkedUsers.get().n, usersWithoutTotp: stmts.usersWithoutTotp.get().n,
      };
    },
    update(input, req) {
      const values = {};
      if (input.enabled !== undefined) values['panel.enabled'] = Boolean(input.enabled);
      if (input.require2faForUsers !== undefined) values['panel.require_2fa_for_users'] = Boolean(input.require2faForUsers);
      if (input.loginAsTtlMinutes !== undefined) values['panel.login_as_ttl_minutes'] = input.loginAsTtlMinutes;
      if (input.webmailUrl !== undefined) values['panel.webmail_url'] = input.webmailUrl;
      settings.setMany(values);
      audit(req, { action: 'panel.settings.update', target: 'panel', args: values });
      return panelSettings.get();
    },
    enabled: () => settings.get('panel.enabled') !== false,
  };

  return {
    SYSTEM_ROOT,
    ensureUser, backfill, syncPassword, setSuspended, subscribe, userStatus, adminEnsureUser, adminSetPassword, adminReset2fa, recovery,
    scope, assertNotActing, assertTwoFactor, loginAs, logoutAs, loginAsHistory, endImpersonation,
    me, quickLinks, counts, userPrincipal, preferences,
    changePassword, changePasswordForUser, linkForUser, reestablish, sessions, tokens, settings: panelSettings, audit, releaseMailDomain,
  };
}
