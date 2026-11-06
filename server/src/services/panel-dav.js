import { HttpError, notFound, unprocessable, CapabilityError } from '../lib/errors.js';
import { auditArgs } from './panel-domains.js';
import { DAV_LOGIN_RE } from './dav.js';

// Calendars and Contacts for one account (contract §70): the account's own DAV
// login <username>@<main domain> plus every P4-2 sub-user with the `dav`
// service on. The password is bcrypt-hashed here and only the hash reaches
// the agent (dav.user.set); panel_dav_logins records that one exists.

export const PASSWORD_MIN_LENGTH = 8;

export function createPanelDavService(ctx) {
  const { db, crypto, logger } = ctx;
  const dav = () => { if (!ctx.dav) throw new HttpError(503, 'service_unavailable', 'The calendar server integration is not loaded'); return ctx.dav; };
  const stmts = {
    list: db.prepare('SELECT * FROM panel_dav_logins WHERE account_id = ? ORDER BY login'),
    byLogin: db.prepare('SELECT * FROM panel_dav_logins WHERE login = ?'),
    upsert: db.prepare(`INSERT INTO panel_dav_logins (account_id, login, subuser_id) VALUES (?, ?, ?)
      ON CONFLICT (login) DO UPDATE SET account_id = excluded.account_id, subuser_id = excluded.subuser_id, updated_at = datetime('now')`),
    remove: db.prepare('DELETE FROM panel_dav_logins WHERE login = ? AND account_id = ?'),
  };
  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: auditArgs(scope, args) };
    if (req?.audit) return req.audit(entry);
    return ctx.auditRecord?.(null, entry);
  };
  const assertFeature = (scope) => { if (scope?.features?.caldav === false) throw new HttpError(403, 'feature_disabled', 'Your hosting package does not include "caldav"'); };

  // Sub-users come from P4-2 when it is loaded; the table may not exist on an
  // older database, which simply means no sub-user logins.
  function subuserLogins(scope) {
    if (ctx.panelUsers?.davLogins) {
      try { return ctx.panelUsers.davLogins(scope.accountId).map((u) => ({ login: u.login, id: u.id })); } catch (err) { logger.debug({ err }, 'panel-dav: sub-user logins unavailable'); return []; }
    }
    try {
      return db.prepare('SELECT id, username, domain, services_json FROM panel_subusers WHERE account_id = ? ORDER BY domain, username').all(scope.accountId)
        .filter((r) => { try { return Boolean(JSON.parse(r.services_json || '{}').dav?.enabled); } catch { return false; } })
        .map((r) => ({ login: `${r.username}@${r.domain}`, id: r.id }));
    } catch { return []; }
  }

  const accountLogin = (scope) => `${scope.username}@${String(scope.account.domain || '').toLowerCase()}`;

  function logins(scope) {
    const rows = new Map(stmts.list.all(scope.accountId).map((r) => [r.login, r]));
    const own = accountLogin(scope);
    const out = [];
    if (DAV_LOGIN_RE.test(own)) out.push({ login: own, kind: 'account', subuserId: null });
    for (const u of subuserLogins(scope)) if (DAV_LOGIN_RE.test(u.login) && u.login !== own) out.push({ login: u.login, kind: 'subuser', subuserId: u.id });
    return out.map((l) => { const r = rows.get(l.login); return { ...l, hasPassword: Boolean(r), passwordSetAt: r?.updated_at ?? null }; });
  }

  function resolveLogin(scope, login) {
    const l = logins(scope).find((x) => x.login === login);
    if (!l) throw notFound('DAV login');
    // A row left by another account for the same address (a domain that moved) is never silently taken over.
    const row = stmts.byLogin.get(login);
    if (row && row.account_id !== scope.accountId) throw new HttpError(409, 'login_taken', `${login} is registered to another account; ask your hosting provider to release it`);
    return l;
  }

  const urlsFor = (base, login) => (base ? { principal: `${base}${encodeURIComponent(login)}/`, caldav: `${base}${encodeURIComponent(login)}/`, carddav: `${base}${encodeURIComponent(login)}/`, discovery: base } : null);

  return {
    logins,
    accountLogin,

    async status(scope) {
      assertFeature(scope);
      const a = await dav().available();
      const base = a.url || dav().serverUrl();
      return {
        available: a, serverUrl: base, hostname: dav().serverHostname(),
        logins: logins(scope).map((l) => ({ ...l, urls: urlsFor(base, l.login) })),
        passwordMinLength: PASSWORD_MIN_LENGTH,
      };
    },

    async setPassword(scope, login, { password }, req) {
      assertFeature(scope);
      const l = resolveLogin(scope, login);
      if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) throw unprocessable('The password is too short', { password: [`At least ${PASSWORD_MIN_LENGTH} characters`] });
      const a = await dav().available();
      if (!a.installed) throw new CapabilityError('radicale', 'The calendar server is not installed on this server yet; ask your hosting provider to enable Calendars and Contacts.');
      const hash = await crypto.hashPassword(password);
      const r = await dav().setUser(l.login, hash, req);
      stmts.upsert.run(scope.accountId, l.login, l.subuserId);
      audit(req, scope, 'panel.dav.password.set', { login: l.login, kind: l.kind, created: Boolean(r.created) });
      return { login: l.login, kind: l.kind, hasPassword: true, created: Boolean(r.created), urls: urlsFor(a.url || dav().serverUrl(), l.login) };
    },

    async removePassword(scope, login, req) {
      assertFeature(scope);
      const l = resolveLogin(scope, login);
      let removed = false;
      try { removed = Boolean((await dav().removeUser(l.login, req)).removed); } catch (err) {
        // No htpasswd file (never installed) means nothing to remove; any other failure keeps the row.
        if (!(err instanceof CapabilityError)) throw err;
      }
      stmts.remove.run(l.login, scope.accountId);
      audit(req, scope, 'panel.dav.password.remove', { login: l.login, kind: l.kind, removed });
      return { login: l.login, kind: l.kind, hasPassword: false, removed };
    },

    async collections(scope, login) {
      assertFeature(scope);
      const l = resolveLogin(scope, login);
      const r = await dav().collections(l.login);
      return { login: l.login, kind: l.kind, exists: Boolean(r.exists), collections: r.collections || [], error: r.error ?? null };
    },

    // A login that stops existing (sub-user deleted, its dav service switched
    // off) loses its htpasswd line and row without going through the listing,
    // which no longer names it. A row another account holds for the same
    // address is never touched.
    async forgetLogin(scope, login, req, reason = 'subuser_removed') {
      const row = stmts.byLogin.get(login);
      if (row && row.account_id !== scope.accountId) return { login, removed: false, forgotten: false };
      const removed = await tryRemoveUser(login, req);
      stmts.remove.run(login, scope.accountId);
      if (row || removed) audit(req, scope, 'panel.dav.password.remove', { login, kind: 'subuser', removed, reason });
      return { login, removed, forgotten: Boolean(row) };
    },

    // accounts.cleanupAccount hook: every htpasswd line of the account goes
    // before its panel_dav_logins rows cascade away with the account.
    async removeAccountLogins(accountId, req) {
      const out = [];
      for (const r of stmts.list.all(accountId)) {
        let removed = false;
        let error = null;
        try { removed = await tryRemoveUser(r.login, req); } catch (err) { error = err.message; logger.warn({ err, login: r.login }, 'panel-dav: htpasswd line not removed on termination'); }
        stmts.remove.run(r.login, accountId);
        out.push(error ? { login: r.login, removed, error } : { login: r.login, removed });
      }
      return out.length ? { logins: out } : null;
    },
  };

  // No htpasswd file or no Radicale (never installed) means nothing to remove.
  async function tryRemoveUser(login, req) {
    if (!DAV_LOGIN_RE.test(login)) return false;
    try { return Boolean((await dav().removeUser(login, req)).removed); } catch (err) {
      if (err instanceof CapabilityError || err?.code === 'service_unavailable') return false;
      throw err;
    }
  }
}
