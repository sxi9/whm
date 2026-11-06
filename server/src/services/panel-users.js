import { HttpError, notFound, conflict, badRequest } from '../lib/errors.js';
import { assertFeature, assertLimit } from '../routes/panel/index.js';

// Customer panel: sub-users of one hosting account (cPanel User Manager,
// contract §69). A sub-user is a name on one of the account's domains whose
// services are the account's own objects: the mailbox is created through
// ctx.panelEmail (so every rule of Email accounts applies: feature, plan
// limit, Dovecot, routing) and the FTP login through ctx.panelFtp (home pinned
// under the account home by that service). One password serves every enabled
// service; it is never stored here — each service keeps its own hash — so
// enabling a service later needs the password again. Never a Linux user.

export const SUBUSER_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const SERVICE_KEYS = ['email', 'ftp', 'dav'];
export const DEFAULT_SERVICES = Object.freeze({ email: { enabled: false, quotaMb: null }, ftp: { enabled: false, homeDir: 'public_html' }, dav: { enabled: false } });

export function normalizeServices(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    email: { enabled: Boolean(s.email?.enabled), quotaMb: s.email?.quotaMb ?? null, mailboxId: s.email?.mailboxId ?? null },
    ftp: { enabled: Boolean(s.ftp?.enabled), homeDir: s.ftp?.homeDir || 'public_html', accountId: s.ftp?.accountId ?? null },
    dav: { enabled: Boolean(s.dav?.enabled) },
  };
}

export function createPanelUsersService(ctx) {
  const { db } = ctx;

  const stmts = {
    list: db.prepare('SELECT * FROM panel_subusers WHERE account_id = ? ORDER BY domain, username'),
    byId: db.prepare('SELECT * FROM panel_subusers WHERE id = ? AND account_id = ?'),
    byName: db.prepare('SELECT id FROM panel_subusers WHERE username = ? AND domain = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM panel_subusers WHERE account_id = ?'),
    accountDomains: db.prepare('SELECT domain FROM account_domains WHERE account_id = ?'),
    mailbox: db.prepare('SELECT ma.id FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE ma.id = ? AND md.account_id = ?'),
    ftp: db.prepare('SELECT id FROM ftp_accounts WHERE id = ? AND account_id = ?'),
    insert: db.prepare('INSERT INTO panel_subusers (account_id, username, domain, full_name, contact_email, services_json) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare("UPDATE panel_subusers SET full_name = ?, contact_email = ?, services_json = ?, updated_at = datetime('now') WHERE id = ?"),
    touch: db.prepare("UPDATE panel_subusers SET updated_at = datetime('now') WHERE id = ?"),
    remove: db.prepare('DELETE FROM panel_subusers WHERE id = ?'),
  };

  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: { ...args, ...(scope.mode === 'acting' ? { actingAs: scope.username, by: scope.actor?.username } : {}) } };
    if (req?.audit) return req.audit(entry);
    return ctx.auditRecord?.(null, entry);
  };
  const email = () => { if (!ctx.panelEmail?.accounts) throw new HttpError(501, 'capability_missing', 'Email accounts are not available on this server'); return ctx.panelEmail.accounts; };
  const ftp = () => { if (!ctx.panelFtp) throw new HttpError(501, 'capability_missing', 'FTP accounts are not available on this server'); return ctx.panelFtp; };

  function domainNames(scope) {
    const names = stmts.accountDomains.all(scope.accountId).map((r) => r.domain);
    if (!names.includes(scope.account.domain)) names.unshift(scope.account.domain);
    return names;
  }
  function assertDomain(scope, domain) {
    const d = String(domain || '').toLowerCase();
    if (!domainNames(scope).includes(d)) throw notFound(`Domain "${domain}"`);
    return d;
  }

  function checkPassword(password) {
    const fn = ctx.security?.passwordStrength;
    if (typeof fn !== 'function') return;
    const verdict = fn(password, 'account');
    if (verdict && verdict.ok === false) throw badRequest(`Password too weak (strength ${verdict.score}, minimum ${verdict.minimum})`, { password: [`Strength ${verdict.score} is below the required minimum ${verdict.minimum}`] });
  }

  // A service row deleted elsewhere (Email accounts, FTP accounts) leaves the
  // flag on: the shape reports present:false so the page can say so.
  function shape(scope, row) {
    const s = normalizeServices(JSON.parse(row.services_json || '{}'));
    const login = `${row.username}@${row.domain}`;
    return {
      id: row.id, username: row.username, domain: row.domain, login, fullName: row.full_name || '', contactEmail: row.contact_email || null,
      services: {
        email: { enabled: s.email.enabled, quotaMb: s.email.quotaMb, address: s.email.enabled ? login : null, present: s.email.enabled ? Boolean(s.email.mailboxId && stmts.mailbox.get(s.email.mailboxId, scope.accountId)) : null },
        ftp: { enabled: s.ftp.enabled, homeDir: s.ftp.homeDir, present: s.ftp.enabled ? Boolean(s.ftp.accountId && stmts.ftp.get(s.ftp.accountId, scope.accountId)) : null },
        dav: { enabled: s.dav.enabled, login: s.dav.enabled ? login : null },
      },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  function owned(scope, id) {
    const row = stmts.byId.get(id, scope.accountId);
    if (!row) throw notFound('Sub-user');
    return row;
  }
  const servicesOf = (row) => normalizeServices(JSON.parse(row.services_json || '{}'));

  async function createMailbox(scope, row, password, quotaMb, req) {
    const r = await email().create(scope, { localPart: row.username, domain: row.domain, password, quotaMb: quotaMb ?? undefined }, req);
    return { mailboxId: r.data.id, quotaMb: r.data.quotaMb, warnings: r.meta?.warnings || [] };
  }
  async function removeMailbox(scope, mailboxId, req) {
    if (!mailboxId) return false;
    try { await email().remove(scope, mailboxId, { removeMail: true }, req); return true; } catch (err) { if (err?.status === 404) return false; throw err; }
  }
  async function createFtp(scope, row, password, homeDir, req) {
    const r = await ftp().create(scope, { login: row.username, password, dir: homeDir || 'public_html', quotaMb: null }, req);
    return { accountId: r.id, login: r.login };
  }
  async function removeFtp(scope, accountId, req) {
    if (!accountId) return false;
    try { await ftp().remove(scope, accountId, req); return true; } catch (err) { if (err?.status === 404) return false; throw err; }
  }

  function list(scope) {
    assertFeature(scope, 'usermanager');
    const rows = stmts.list.all(scope.accountId);
    const max = scope.account?.plan?.max_subusers ?? null;
    return {
      data: rows.map((r) => shape(scope, r)),
      meta: { total: rows.length, max, domains: domainNames(scope), features: { email: scope.features?.emailaccts !== false, ftp: scope.features?.ftpaccts !== false }, defaults: DEFAULT_SERVICES },
    };
  }

  function get(scope, id) {
    assertFeature(scope, 'usermanager');
    return shape(scope, owned(scope, id));
  }

  // Services first (mailbox, then FTP; the FTP failure undoes the mailbox),
  // row last; a row failure undoes both.
  async function create(scope, input, req) {
    assertFeature(scope, 'usermanager');
    const domain = assertDomain(scope, input.domain);
    assertLimit(scope, 'max_subusers', stmts.count.get(scope.accountId).n);
    if (stmts.byName.get(input.username, domain)) throw conflict(`The user ${input.username}@${domain} already exists`);
    checkPassword(input.password);
    const wanted = normalizeServices(input.services);
    const probe = { username: input.username, domain };
    const services = normalizeServices({ dav: wanted.dav });
    const warnings = [];
    if (wanted.email.enabled) {
      const m = await createMailbox(scope, probe, input.password, wanted.email.quotaMb, req);
      services.email = { enabled: true, quotaMb: m.quotaMb, mailboxId: m.mailboxId };
      warnings.push(...m.warnings);
    }
    if (wanted.ftp.enabled) {
      try {
        const f = await createFtp(scope, probe, input.password, wanted.ftp.homeDir, req);
        services.ftp = { enabled: true, homeDir: wanted.ftp.homeDir, accountId: f.accountId };
      } catch (err) {
        await removeMailbox(scope, services.email.mailboxId, req).catch(() => {});
        throw err;
      }
    }
    let id;
    try {
      ({ lastInsertRowid: id } = stmts.insert.run(scope.accountId, input.username, domain, input.fullName || '', input.contactEmail || null, JSON.stringify(services)));
    } catch (err) {
      await removeFtp(scope, services.ftp.accountId, req).catch(() => {});
      await removeMailbox(scope, services.email.mailboxId, req).catch(() => {});
      if (/UNIQUE/.test(err.message)) throw conflict(`The user ${input.username}@${domain} already exists`);
      throw err;
    }
    audit(req, scope, 'panel.users.create', { login: `${input.username}@${domain}`, services: SERVICE_KEYS.filter((k) => services[k].enabled) });
    return { data: shape(scope, stmts.byId.get(id, scope.accountId)), meta: { warnings } };
  }

  // Toggling a service on creates it (password required), off removes it; a
  // quota or home change on a service that stays on is applied in place
  // (quota through the mailbox, the FTP home by recreate, which needs the
  // password too).
  async function update(scope, id, input, req) {
    assertFeature(scope, 'usermanager');
    const row = owned(scope, id);
    const current = servicesOf(row);
    const next = { ...current };
    const wanted = input.services ? normalizeServices({ ...current, ...input.services, email: { ...current.email, ...(input.services.email || {}) }, ftp: { ...current.ftp, ...(input.services.ftp || {}) }, dav: { ...current.dav, ...(input.services.dav || {}) } }) : current;
    const probe = { username: row.username, domain: row.domain };
    const needsPassword = (!current.email.enabled && wanted.email.enabled) || (!current.ftp.enabled && wanted.ftp.enabled) || (current.ftp.enabled && wanted.ftp.enabled && wanted.ftp.homeDir !== current.ftp.homeDir);
    if (needsPassword && !input.password) throw new HttpError(422, 'password_required', 'Enabling a service needs the password of this user', { password: ['Required to enable a service'] });
    if (input.password) checkPassword(input.password);
    const warnings = [];
    const changed = [];

    if (current.email.enabled && !wanted.email.enabled) {
      await removeMailbox(scope, current.email.mailboxId, req);
      next.email = { enabled: false, quotaMb: null, mailboxId: null };
      changed.push('email:off');
    } else if (!current.email.enabled && wanted.email.enabled) {
      const m = await createMailbox(scope, probe, input.password, wanted.email.quotaMb, req);
      next.email = { enabled: true, quotaMb: m.quotaMb, mailboxId: m.mailboxId };
      warnings.push(...m.warnings);
      changed.push('email:on');
    } else if (current.email.enabled && wanted.email.quotaMb !== current.email.quotaMb) {
      await email().setQuota(scope, current.email.mailboxId, { quotaMb: wanted.email.quotaMb }, req);
      next.email = { ...current.email, quotaMb: wanted.email.quotaMb };
      changed.push('email:quota');
    }

    if (current.ftp.enabled && !wanted.ftp.enabled) {
      await removeFtp(scope, current.ftp.accountId, req);
      next.ftp = { enabled: false, homeDir: wanted.ftp.homeDir, accountId: null };
      changed.push('ftp:off');
    } else if (!current.ftp.enabled && wanted.ftp.enabled) {
      const f = await createFtp(scope, probe, input.password, wanted.ftp.homeDir, req);
      next.ftp = { enabled: true, homeDir: wanted.ftp.homeDir, accountId: f.accountId };
      changed.push('ftp:on');
    } else if (current.ftp.enabled && wanted.ftp.homeDir !== current.ftp.homeDir) {
      await removeFtp(scope, current.ftp.accountId, req);
      const f = await createFtp(scope, probe, input.password, wanted.ftp.homeDir, req);
      next.ftp = { enabled: true, homeDir: wanted.ftp.homeDir, accountId: f.accountId };
      changed.push('ftp:home');
    }
    if (wanted.dav.enabled !== current.dav.enabled) {
      next.dav = { enabled: wanted.dav.enabled };
      if (!wanted.dav.enabled) await forgetDav(scope, row, req, 'dav_off');
      changed.push(wanted.dav.enabled ? 'dav:on' : 'dav:off');
    }

    // One password for every service: whatever the edit was for, a password
    // sent with it is applied to each service that stays on (a service created
    // or recreated above already carries it).
    if (input.password) {
      if (next.email.enabled && current.email.enabled) await email().setPassword(scope, next.email.mailboxId, { password: input.password }, req);
      if (next.ftp.enabled && current.ftp.enabled && !changed.includes('ftp:home')) await ftp().setPassword(scope, next.ftp.accountId, input.password, req);
      changed.push('password');
    }

    const fullName = input.fullName ?? row.full_name ?? '';
    const contactEmail = input.contactEmail === undefined ? row.contact_email : input.contactEmail;
    stmts.update.run(fullName, contactEmail, JSON.stringify(next), row.id);
    audit(req, scope, 'panel.users.update', { login: `${row.username}@${row.domain}`, changed });
    return { data: shape(scope, stmts.byId.get(row.id, scope.accountId)), meta: { warnings, changed } };
  }

  async function setPassword(scope, id, password, req) {
    assertFeature(scope, 'usermanager');
    const row = owned(scope, id);
    checkPassword(password);
    const s = servicesOf(row);
    const applied = [];
    if (s.email.enabled && s.email.mailboxId) { await email().setPassword(scope, s.email.mailboxId, { password }, req); applied.push('email'); }
    if (s.ftp.enabled && s.ftp.accountId) { await ftp().setPassword(scope, s.ftp.accountId, password, req); applied.push('ftp'); }
    stmts.touch.run(row.id);
    audit(req, scope, 'panel.users.password', { login: `${row.username}@${row.domain}`, applied });
    return { id: row.id, login: `${row.username}@${row.domain}`, changed: true, applied };
  }

  async function remove(scope, id, req) {
    assertFeature(scope, 'usermanager');
    const row = owned(scope, id);
    const s = servicesOf(row);
    const removed = [];
    if (s.email.enabled && await removeMailbox(scope, s.email.mailboxId, req)) removed.push('email');
    if (s.ftp.enabled && await removeFtp(scope, s.ftp.accountId, req)) removed.push('ftp');
    if (s.dav.enabled && (await forgetDav(scope, row, req, 'subuser_removed'))?.removed) removed.push('dav');
    stmts.remove.run(row.id);
    audit(req, scope, 'panel.users.delete', { login: `${row.username}@${row.domain}`, removed });
    return { id: row.id, login: `${row.username}@${row.domain}`, removed: true, services: removed };
  }

  // The DAV login P4-3 keeps for a sub-user (htpasswd line + panel_dav_logins
  // row) goes with the service; without P4-3 loaded there is nothing to forget.
  function forgetDav(scope, row, req, reason) {
    if (!ctx.panelDav?.forgetLogin) return null;
    return ctx.panelDav.forgetLogin(scope, `${row.username}@${row.domain}`, req, reason);
  }

  // Read seam for P4-3: every sub-user with DAV on, as { login, id } per account.
  function davLogins(accountId) {
    return stmts.list.all(accountId).map((r) => ({ row: r, s: servicesOf(r) })).filter(({ s }) => s.dav.enabled).map(({ row }) => ({ id: row.id, login: `${row.username}@${row.domain}` }));
  }

  return { list, get, create, update, setPassword, remove, davLogins, normalizeServices };
}
