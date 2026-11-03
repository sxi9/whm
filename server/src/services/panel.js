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
//   panel.audit(req, entry)                        -> audit row carrying actingAs/by while impersonating

export const LOGIN_AS_TTL = { min: 5, max: 480, fallback: 60 };
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
  };

  // Tables owned by the mail and FTP units may not exist on this tree yet.
  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
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
      user: ctx.auth.publicUser(req.user),
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
  function quickLinks(req) {
    const s = req.panel || scope(req);
    const principal = userPrincipal(s);
    const safe = (fn) => { try { return fn() || []; } catch (err) { logger.debug({ err }, 'panel quick links source failed'); return []; } };
    return {
      apps: safe(() => ctx.development?.appconfig?.listFor?.(principal, 'cpanel')),
      news: safe(() => ctx.cpanel?.news?.active?.(principal)),
      webmailUrl: settings.get('panel.webmail_url') || '',
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
  // flagged with must_change_password (the forced-change path of /api/auth/password).
  async function changePassword(s, { currentPassword, newPassword, force = false }, req) {
    assertNotActing(s);
    const user = stmts.userById.get(s.actor.id);
    const link = user ? stmts.linkByUser.get(user.id) : null;
    if (!link || link.account_id !== s.accountId) throw forbidden('This login is not linked to the account');
    const forced = Boolean(force) && Boolean(user.must_change_password);
    if (!forced && !(await crypto.verifyPassword(currentPassword || '', user.password_hash))) throw unauthorized('Current password is incorrect');
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
    audit(req, { action: 'panel.password.change', target: s.username, args: { host, forced } });
    return { changed: true, host };
  }

  // Seam for routes/auth.js POST /password: a login linked to a hosting account
  // changes its password through the §2.2 flow (host first, both stores) so the
  // forced-change path cannot leave the Linux password behind. Returns null
  // when the login is not an account user, and the caller keeps its own flow.
  const linkForUser = (userId) => stmts.linkByUser.get(userId) || null;
  async function changePasswordForUser(userId, { currentPassword, newPassword, force = false }, req) {
    const user = stmts.userById.get(userId);
    const link = user && user.role === 'user' ? stmts.linkByUser.get(user.id) : null;
    if (!link) return null;
    const row = stmts.accountById.get(link.account_id);
    if (!row) return null;
    const s = buildScope({ user }, row, 'user', null);
    return changePassword(s, { currentPassword, newPassword, force }, req);
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
    ensureUser, backfill, syncPassword, setSuspended, subscribe, userStatus, adminEnsureUser, adminSetPassword,
    scope, assertNotActing, loginAs, logoutAs, loginAsHistory, endImpersonation,
    me, quickLinks, counts, userPrincipal,
    changePassword, changePasswordForUser, linkForUser, reestablish, sessions, tokens, settings: panelSettings, audit,
  };
}
