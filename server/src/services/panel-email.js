import { HttpError, notFound, conflict, unprocessable, CapabilityError } from '../lib/errors.js';
import { json, paginate } from '../db/index.js';
import { fields } from '../lib/validate.js';
import { assertFeature, limitReached } from '../routes/panel/index.js';

// Customer panel: email of one hosting account (design §4.6). Every method takes
// the scope pinned by ctx.panel.scope(req); a domain, mailbox id, forwarder id or
// autoresponder id the client sends is matched against scope.accountId here
// before anything is delegated. Delegates that take a principal get
// scope.ownerPrincipal (§3.3), never the customer's req.user. Mail objects live
// in mail_accounts/mail_domains (001) and the 033b tables; the host side is the
// agent's vmail.* data files (Dovecot passwd-file, Exim lsearch lists) and the
// maildir created as the account through files.*.

export const LOCAL_PART = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SPECIAL_DESTINATIONS = [':fail:', ':blackhole:'];
export const DEFAULT_ACTIONS = ['fail', 'blackhole', 'forward'];
export const SYSTEM_ROOT = Object.freeze({ id: null, username: 'panel', role: 'root' });

const MB = 1024 * 1024;

// The audit args always say who really acted (§2.4).
export function auditArgs(scope, args = {}) {
  if (scope.mode !== 'acting' || !scope.actingAs) return args;
  return { ...args, actingAs: scope.username, by: scope.actingAs.by ?? scope.actor?.username ?? null };
}

// The highest of the plan value and any enhancement; null means unlimited.
export function limitOf(scope, key) {
  const values = [scope.account?.plan?.[key], scope.limits?.[key]].filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

export function assertLimit(scope, key, count) {
  const limit = limitOf(scope, key);
  if (limit != null && limit >= 0 && count >= limit) throw limitReached(key, limit);
}

export function splitAddress(address) {
  const at = String(address || '').lastIndexOf('@');
  if (at <= 0) throw unprocessable('An email address is required', { address: ['Must be local@domain'] });
  return { localPart: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() };
}

// ~/.spamassassin/user_prefs: key/value lines only. Addresses are validated by
// the route, so a value can never start a new directive.
export function renderUserPrefs({ enabled, requiredScore, whitelist = [], blacklist = [] }) {
  const lines = ['# Keel (customer panel) - managed file, edits are overwritten', `required_score ${Number(requiredScore).toFixed(1)}`];
  if (!enabled) lines.push('# Spam filtering is disabled for this account');
  for (const a of whitelist) lines.push(`whitelist_from ${a}`);
  for (const a of blacklist) lines.push(`blacklist_from ${a}`);
  return `${lines.join('\n')}\n`;
}

const domainOf = (address) => String(address || '').split('@')[1]?.toLowerCase() || null;

export function createPanelEmailService(ctx) {
  const { db, settings, capabilities, logger } = ctx;
  const agent = () => ctx.agent;

  const stmts = {
    accountDomains: db.prepare('SELECT domain, type FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    mailDomain: db.prepare('SELECT * FROM mail_domains WHERE domain = ?'),
    mailDomainOwned: db.prepare('SELECT * FROM mail_domains WHERE domain = ? AND account_id = ?'),
    insertMailDomain: db.prepare("INSERT INTO mail_domains (domain, account_id, routing) VALUES (?, ?, 'auto')"),
    claimMailDomain: db.prepare('UPDATE mail_domains SET account_id = ? WHERE id = ? AND account_id IS NULL'),
    mailboxCount: db.prepare('SELECT COUNT(*) AS n FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE md.account_id = ?'),
    mailbox: db.prepare('SELECT ma.*, md.domain, md.routing FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE ma.id = ? AND md.account_id = ?'),
    mailboxByAddress: db.prepare('SELECT ma.id FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE md.domain = ? AND ma.local_part = ? AND md.account_id = ?'),
    mailboxesOf: db.prepare('SELECT ma.local_part, md.domain, ma.quota_mb FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE md.account_id = ? ORDER BY md.domain, ma.local_part'),
    insertMailbox: db.prepare('INSERT INTO mail_accounts (domain_id, local_part, quota_mb, password_hash, suspended) VALUES (?, ?, ?, ?, 0)'),
    setMailboxHash: db.prepare('UPDATE mail_accounts SET password_hash = ? WHERE id = ?'),
    setMailboxQuota: db.prepare('UPDATE mail_accounts SET quota_mb = ? WHERE id = ?'),
    setMailboxSuspended: db.prepare('UPDATE mail_accounts SET suspended = ? WHERE id = ?'),
    deleteMailbox: db.prepare('DELETE FROM mail_accounts WHERE id = ?'),

    forwardersOf: db.prepare('SELECT * FROM mail_forwarders WHERE account_id = ? AND local_part IS NOT NULL ORDER BY domain, local_part, id'),
    forwardersOfDomain: db.prepare('SELECT * FROM mail_forwarders WHERE account_id = ? AND domain = ? AND local_part IS NOT NULL ORDER BY local_part, id'),
    forwarderRowsOfDomain: db.prepare('SELECT * FROM mail_forwarders WHERE domain = ? AND account_id = ? ORDER BY local_part, id'),
    forwarder: db.prepare('SELECT * FROM mail_forwarders WHERE id = ? AND account_id = ?'),
    forwarderCountOfDomain: db.prepare('SELECT COUNT(*) AS n FROM mail_forwarders WHERE domain = ? AND account_id = ?'),
    forwarderExists: db.prepare("SELECT id FROM mail_forwarders WHERE domain = ? AND COALESCE(local_part, '*') = ? AND destination = ?"),
    insertForwarder: db.prepare('INSERT INTO mail_forwarders (account_id, domain, local_part, destination) VALUES (?, ?, ?, ?)'),
    insertForwarderFull: db.prepare('INSERT INTO mail_forwarders (id, account_id, domain, local_part, destination, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    deleteForwarder: db.prepare('DELETE FROM mail_forwarders WHERE id = ? AND account_id = ?'),
    catchAll: db.prepare('SELECT * FROM mail_forwarders WHERE domain = ? AND account_id = ? AND local_part IS NULL'),
    deleteCatchAll: db.prepare('DELETE FROM mail_forwarders WHERE domain = ? AND account_id = ? AND local_part IS NULL'),

    domainForwards: db.prepare('SELECT domain, target_domain FROM mail_domain_forwarders ORDER BY domain'),
    domainForward: db.prepare('SELECT * FROM mail_domain_forwarders WHERE domain = ? AND account_id = ?'),
    upsertDomainForward: db.prepare("INSERT INTO mail_domain_forwarders (account_id, domain, target_domain) VALUES (?, ?, ?) ON CONFLICT (domain) DO UPDATE SET target_domain = excluded.target_domain, updated_at = datetime('now') WHERE account_id = excluded.account_id"),
    deleteDomainForward: db.prepare('DELETE FROM mail_domain_forwarders WHERE domain = ? AND account_id = ?'),

    autoresponders: db.prepare('SELECT * FROM mail_autoresponders WHERE account_id = ? ORDER BY domain, local_part'),
    autoresponder: db.prepare('SELECT * FROM mail_autoresponders WHERE id = ? AND account_id = ?'),
    autoresponderByAddress: db.prepare('SELECT id FROM mail_autoresponders WHERE domain = ? AND local_part = ?'),
    insertAutoresponder: db.prepare('INSERT INTO mail_autoresponders (account_id, domain, local_part, from_name, subject, body, charset, interval_hours, start_at, stop_at, enabled) VALUES (@account_id, @domain, @local_part, @from_name, @subject, @body, @charset, @interval_hours, @start_at, @stop_at, @enabled)'),
    updateAutoresponder: db.prepare("UPDATE mail_autoresponders SET from_name = @from_name, subject = @subject, body = @body, charset = @charset, interval_hours = @interval_hours, start_at = @start_at, stop_at = @stop_at, enabled = @enabled, updated_at = datetime('now') WHERE id = @id"),
    deleteAutoresponder: db.prepare('DELETE FROM mail_autoresponders WHERE id = ? AND account_id = ?'),

    spam: db.prepare('SELECT * FROM mail_spam_settings WHERE account_id = ?'),
    upsertSpam: db.prepare(`INSERT INTO mail_spam_settings (account_id, enabled, required_score, auto_delete, auto_delete_score, whitelist_json, blacklist_json, updated_at)
      VALUES (@account_id, @enabled, @required_score, @auto_delete, @auto_delete_score, @whitelist_json, @blacklist_json, datetime('now'))
      ON CONFLICT (account_id) DO UPDATE SET enabled = excluded.enabled, required_score = excluded.required_score, auto_delete = excluded.auto_delete, auto_delete_score = excluded.auto_delete_score, whitelist_json = excluded.whitelist_json, blacklist_json = excluded.blacklist_json, updated_at = datetime('now')`),
    deleteSpam: db.prepare('DELETE FROM mail_spam_settings WHERE account_id = ?'),
    spamAll: db.prepare('SELECT s.*, a.username, a.domain AS main_domain FROM mail_spam_settings s JOIN accounts a ON a.id = s.account_id ORDER BY a.username'),
    domainsOfAccount: db.prepare('SELECT domain FROM account_domains WHERE account_id = ?'),

    zoneOwned: db.prepare('SELECT id, domain FROM dns_zones WHERE domain = ? AND account_id = ?'),
    dkimKey: db.prepare('SELECT domain, selector, created_at FROM dkim_keys WHERE domain = ?'),

    accountByUsername: db.prepare('SELECT id, username, domain FROM accounts WHERE username = ?'),
    autoresponderCountOfDomain: db.prepare('SELECT COUNT(*) AS n FROM mail_autoresponders WHERE domain = ? AND account_id = ?'),
    staleOwners: db.prepare(`SELECT account_id FROM mail_forwarders WHERE domain = @domain AND account_id <> @accountId
      UNION SELECT account_id FROM mail_domain_forwarders WHERE domain = @domain AND account_id <> @accountId
      UNION SELECT account_id FROM mail_autoresponders WHERE domain = @domain AND account_id <> @accountId`),
    forwarderRowsOfDomainAny: db.prepare('SELECT * FROM mail_forwarders WHERE domain = ? ORDER BY local_part, id'),
    autorespondersOfDomain: db.prepare('SELECT domain, local_part FROM mail_autoresponders WHERE domain = ? AND account_id = ?'),
    releaseForwarders: db.prepare('DELETE FROM mail_forwarders WHERE domain = ? AND account_id = ?'),
    releaseDomainForward: db.prepare('DELETE FROM mail_domain_forwarders WHERE domain = ? AND account_id = ?'),
    releaseAutoresponders: db.prepare('DELETE FROM mail_autoresponders WHERE domain = ? AND account_id = ?'),
    releaseMailDomain: db.prepare('DELETE FROM mail_domains WHERE domain = ? AND account_id = ?'),
  };

  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: auditArgs(scope, args) };
    if (req?.audit) return req.audit(entry);
    return ctx.auditRecord?.(null, entry);
  };

  const hostname = () => settings.get('basic.hostname') || 'localhost';
  const homeOf = (scope) => scope.account.home_dir || `${settings.get('basic.home_root') || '/home'}/${scope.username}`;
  const maildirOf = (scope, domain, local) => `${homeOf(scope)}/mail/${domain}/${local}`;

  function translate(err, capability = 'dovecot') {
    if (!err || !err.code || err instanceof HttpError) return err;
    if (err.code === 'capability_missing' || err.code === 'binary_not_found') return new CapabilityError(capability, err.message);
    if (err.code === 'invalid_args') return unprocessable(`The agent rejected the request: ${err.message}`, err.details?.fields);
    if (err.code === 'not_found') return notFound(err.message);
    if (err.code === 'exists') return conflict(err.message);
    if (['refused', 'unsupported', 'config_invalid', 'path_not_allowed'].includes(err.code)) return new HttpError(422, err.code, err.message);
    return err;
  }

  async function op(name, args, req, capability = 'dovecot') {
    try { return await agent().op(name, args, { req }); } catch (err) { throw translate(err, capability); }
  }

  // Every hostname the account answers for: the main domain plus its rows.
  function domainsOf(scope) {
    const rows = stmts.accountDomains.all(scope.accountId);
    if (!rows.some((r) => r.domain === scope.account.domain)) rows.unshift({ domain: scope.account.domain, type: 'main' });
    return rows;
  }
  const domainNames = (scope) => domainsOf(scope).map((d) => d.domain);

  // A domain name from the client is only ever one of the account's own; a
  // foreign or unknown domain is "not found", never "forbidden" (§3.2).
  function assertDomain(scope, domain) {
    const row = domainsOf(scope).find((d) => d.domain === String(domain || '').toLowerCase());
    if (!row) throw notFound(`Domain "${domain}"`);
    return row;
  }

  // Mail objects are keyed by domain. Rows of another account for this domain
  // are leftovers of a previous owner that releaseDomain() did not get to run
  // for; writing next to them would merge two accounts' routing into one host
  // file, so every write path refuses until root releases them.
  function assertDomainClean(scope, domain) {
    const stale = stmts.staleOwners.all({ domain, accountId: scope.accountId });
    if (stale.length) throw new HttpError(409, 'domain_stale', `Mail settings of a previous owner of ${domain} still exist; ask your provider to release the domain`);
    const md = stmts.mailDomain.get(domain);
    if (md && md.account_id != null && md.account_id !== scope.accountId) throw conflict(`The mail domain ${domain} belongs to another account`);
  }

  // Seam S3: ctx.mail.ensureMailDomain(domain, accountId, req) owns the row;
  // the local fallback carries the same rule (never re-point another account's row).
  function ensureMailDomain(scope, domain, req) {
    assertDomainClean(scope, domain);
    if (typeof ctx.mail?.ensureMailDomain === 'function') {
      ctx.mail.ensureMailDomain(domain, scope.accountId, req);
    } else {
      const existing = stmts.mailDomain.get(domain);
      if (existing && existing.account_id != null && existing.account_id !== scope.accountId) throw conflict(`The mail domain ${domain} belongs to another account`);
      if (!existing) stmts.insertMailDomain.run(domain, scope.accountId);
      else if (existing.account_id == null) stmts.claimMailDomain.run(scope.accountId, existing.id);
    }
    const row = stmts.mailDomainOwned.get(domain, scope.accountId);
    if (!row) throw conflict(`The mail domain ${domain} could not be assigned to this account`);
    return row;
  }

  // Routing 'local' is wanted once a mailbox exists; Exim not reading the lists
  // is a warning the caller surfaces, never a failure of the mailbox itself.
  async function routeLocally(domain, warnings, req) {
    if (typeof ctx.mail?.setRouting !== 'function') return;
    const current = stmts.mailDomain.get(domain);
    if (current?.routing === 'local') return;
    try {
      const r = await ctx.mail.setRouting(domain, 'local', req);
      if (r && r.applied === false) warnings.push({ code: 'routing_not_applied', message: r.reason || 'Mail routing was saved but Exim does not read it yet' });
    } catch (err) {
      warnings.push({ code: err.code === 'routing_not_applied' ? 'routing_not_applied' : 'routing_failed', message: err.message, hint: err.hint ?? null });
    }
  }

  function checkPasswordStrength(password) {
    const fn = ctx.security?.passwordStrength;
    if (typeof fn !== 'function') return;
    const r = fn(password, 'email');
    if (r && r.ok === false) throw unprocessable(`The password is too weak (strength ${r.score}, minimum ${r.minimum})`, { password: [`Strength ${r.score} is below the required ${r.minimum}`] });
  }

  const shapeMailbox = (row, usage = null) => ({
    id: row.id, address: `${row.local_part}@${row.domain}`, localPart: row.local_part, domain: row.domain,
    quotaMb: row.quota_mb, suspended: Boolean(row.suspended), routing: row.routing ?? null, createdAt: row.created_at, usage,
  });

  async function mailboxUsage(scope, row) {
    const address = `${row.local_part}@${row.domain}`;
    try {
      if (capabilities.has('dovecot')) {
        const q = await agent().op('vmail.quota.get', { user: address });
        return { bytes: q.bytes ?? null, limitBytes: q.limitBytes ?? (row.quota_mb ? row.quota_mb * MB : null), messages: q.messages ?? null, source: 'dovecot' };
      }
      const du = await agent().op('files.du', { username: scope.username, path: maildirOf(scope, row.domain, row.local_part), depth: 0 });
      return { bytes: Number(du.totalKb || 0) * 1024, limitBytes: row.quota_mb ? row.quota_mb * MB : null, messages: null, source: 'du' };
    } catch (err) {
      logger.debug({ err, address }, 'panel-email: mailbox usage unavailable');
      return null;
    }
  }

  // A row found by id is only usable while its domain is still one of the
  // account's: a domain that was moved away leaves the row to root cleanup.
  function loadMailbox(scope, id) {
    const row = stmts.mailbox.get(id, scope.accountId);
    if (!row) throw notFound('Mailbox');
    assertDomain(scope, row.domain);
    return row;
  }

  // ------------------------------------------------------------- accounts ---

  const accounts = {
    async list(scope, query = {}) {
      assertFeature(scope, 'emailaccts');
      const where = ['md.account_id = @accountId'];
      const params = { accountId: scope.accountId };
      if (query.domain) { assertDomain(scope, query.domain); where.push('md.domain = @domain'); params.domain = query.domain; }
      if (query.q) { where.push("(ma.local_part LIKE @q OR md.domain LIKE @q)"); params.q = `%${query.q}%`; }
      const page = paginate(db, {
        select: 'ma.*, md.domain, md.routing', from: 'mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id', where, params,
        sortable: { address: 'md.domain, ma.local_part', local_part: 'ma.local_part', domain: 'md.domain', quota_mb: 'ma.quota_mb', created_at: 'ma.created_at' }, defaultSort: 'address', query,
      });
      const withUsage = query.usage !== false;
      const data = await Promise.all(page.data.map(async (row) => shapeMailbox(row, withUsage ? await mailboxUsage(scope, row) : null)));
      const limit = limitOf(scope, 'max_email');
      return { data, meta: { ...page.meta, limits: { max_email: limit }, used: stmts.mailboxCount.get(scope.accountId).n, domains: domainNames(scope), defaultQuotaMb: Number(settings.get('panel.mail.default_quota_mb') ?? 1024) } };
    },

    async get(scope, id) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      return shapeMailbox(row, await mailboxUsage(scope, row));
    },

    // Order (design §4.6): domain check → ensureMailDomain → hash → maildir as
    // the account → passwd line → row (compensate: passwd.remove) → routing warning.
    async create(scope, { localPart, domain, password, quotaMb }, req) {
      assertFeature(scope, 'emailaccts');
      const d = assertDomain(scope, domain);
      capabilities.require('dovecot', 'Dovecot is not installed on this server, so mailboxes cannot be created yet');
      assertLimit(scope, 'max_email', stmts.mailboxCount.get(scope.accountId).n);
      if (stmts.mailboxByAddress.get(d.domain, localPart, scope.accountId)) throw conflict(`The mailbox ${localPart}@${d.domain} already exists`);
      checkPasswordStrength(password);
      const quota = quotaMb === undefined ? Number(settings.get('panel.mail.default_quota_mb') ?? 1024) || null : quotaMb;
      const mailDomain = ensureMailDomain(scope, d.domain, req);
      const warnings = [];
      const hashed = await op('vmail.hash', { password }, req);
      if (typeof hashed?.hash !== 'string' || !hashed.hash.startsWith('$')) throw new HttpError(502, 'agent_error', 'The agent did not return a password hash');
      const maildir = maildirOf(scope, d.domain, localPart);
      for (const sub of ['', 'cur', 'new', 'tmp']) await op('files.mkdir', { username: scope.username, path: sub ? `${maildir}/${sub}` : maildir, mode: '0700' }, req, 'panel-files');
      await op('vmail.passwd.set', { domain: d.domain, localPart, hash: hashed.hash, username: scope.username, quotaBytes: quota ? quota * MB : null, disabled: false }, req);
      let id;
      try {
        id = Number(stmts.insertMailbox.run(mailDomain.id, localPart, quota, hashed.hash).lastInsertRowid);
      } catch (err) {
        try { await agent().op('vmail.passwd.remove', { domain: d.domain, localPart }, { req }); } catch (undoErr) { logger.warn({ err: undoErr, domain: d.domain, localPart }, 'panel-email: could not undo passwd line after row insert failed'); }
        if (/UNIQUE/.test(err.message)) throw conflict(`The mailbox ${localPart}@${d.domain} already exists`);
        throw err;
      }
      await routeLocally(d.domain, warnings, req);
      if (virtualMailDisabledByOperator()) warnings.push({ code: 'virtual_mail_disabled', message: 'Virtual mailboxes are switched off under Service Configuration; the mailbox is saved but Exim/Dovecot do not serve it until the operator enables them' });
      audit(req, scope, 'panel.email.account.create', { address: `${localPart}@${d.domain}`, quotaMb: quota, warnings: warnings.map((w) => w.code) });
      return { data: shapeMailbox({ ...loadMailbox(scope, id) }), meta: { warnings } };
    },

    async setPassword(scope, id, { password }, req) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      capabilities.require('dovecot');
      checkPasswordStrength(password);
      const hashed = await op('vmail.hash', { password }, req);
      if (typeof hashed?.hash !== 'string' || !hashed.hash.startsWith('$')) throw new HttpError(502, 'agent_error', 'The agent did not return a password hash');
      await op('vmail.passwd.set', { domain: row.domain, localPart: row.local_part, hash: hashed.hash, username: scope.username, quotaBytes: row.quota_mb ? row.quota_mb * MB : null, disabled: Boolean(row.suspended) }, req);
      stmts.setMailboxHash.run(hashed.hash, row.id);
      audit(req, scope, 'panel.email.account.password', { address: `${row.local_part}@${row.domain}` });
      return shapeMailbox({ ...row, password_hash: hashed.hash });
    },

    async setQuota(scope, id, { quotaMb }, req) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      capabilities.require('dovecot');
      if (!row.password_hash) throw new HttpError(422, 'no_password', 'Set a password for this mailbox before changing its quota');
      await op('vmail.passwd.set', { domain: row.domain, localPart: row.local_part, hash: row.password_hash, username: scope.username, quotaBytes: quotaMb ? quotaMb * MB : null, disabled: Boolean(row.suspended) }, req);
      stmts.setMailboxQuota.run(quotaMb, row.id);
      audit(req, scope, 'panel.email.account.quota', { address: `${row.local_part}@${row.domain}`, quotaMb });
      return shapeMailbox({ ...row, quota_mb: quotaMb });
    },

    async patch(scope, id, { suspended }, req) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      if (suspended === undefined) return shapeMailbox(row);
      capabilities.require('dovecot');
      if (!row.password_hash) throw new HttpError(422, 'no_password', 'Set a password for this mailbox before changing its state');
      await op('vmail.passwd.set', { domain: row.domain, localPart: row.local_part, hash: row.password_hash, username: scope.username, quotaBytes: row.quota_mb ? row.quota_mb * MB : null, disabled: Boolean(suspended) }, req);
      stmts.setMailboxSuspended.run(suspended ? 1 : 0, row.id);
      audit(req, scope, suspended ? 'panel.email.account.suspend' : 'panel.email.account.unsuspend', { address: `${row.local_part}@${row.domain}` });
      return shapeMailbox({ ...row, suspended: suspended ? 1 : 0 });
    },

    async remove(scope, id, { removeMail = false } = {}, req) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      await op('vmail.passwd.remove', { domain: row.domain, localPart: row.local_part }, req);
      stmts.deleteMailbox.run(row.id);
      let mailRemoved = false;
      if (removeMail) {
        await op('files.remove', { username: scope.username, paths: [maildirOf(scope, row.domain, row.local_part)] }, req, 'panel-files');
        mailRemoved = true;
      }
      audit(req, scope, 'panel.email.account.delete', { address: `${row.local_part}@${row.domain}`, removeMail: mailRemoved });
      return { id: row.id, address: `${row.local_part}@${row.domain}`, removed: true, mailRemoved };
    },

    clientSettings(scope, id) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      const ms = ctx.web?.mailserver?.settings?.() || {};
      const protocols = Array.isArray(ms.protocols) ? ms.protocols : ['imap', 'pop3'];
      const host = hostname();
      const tls = ms.ssl !== 'no';
      const plainAllowed = ms.ssl === 'no' || ms.disablePlaintextAuth === false;
      const srv = (securePort, plainPort) => ({ host, port: securePort, ssl: true, alternative: tls ? { port: plainPort, starttls: true, plainAllowed } : { port: plainPort, starttls: false, plainAllowed: true } });
      return {
        address: `${row.local_part}@${row.domain}`, username: `${row.local_part}@${row.domain}`, hostname: host,
        imap: protocols.includes('imap') ? srv(993, 143) : null,
        pop3: protocols.includes('pop3') ? srv(995, 110) : null,
        smtp: { host, port: 465, ssl: true, alternative: { port: 587, starttls: true }, auth: 'password' },
        webmail: settings.get('panel.webmail_url') || null,
      };
    },
  };

  // ----------------------------------------------------------- forwarders ---

  const shapeForwarder = (r) => ({ id: r.id, domain: r.domain, localPart: r.local_part, address: r.local_part == null ? `*@${r.domain}` : `${r.local_part}@${r.domain}`, destination: r.destination, catchAll: r.local_part == null, createdAt: r.created_at });

  // The structured entries the agent renders for one domain: every row of the
  // domain grouped by local part ('*' for the default address).
  function aliasEntries(scope, domain) {
    const groups = new Map();
    for (const r of stmts.forwarderRowsOfDomain.all(domain, scope.accountId)) {
      const key = r.local_part == null ? '*' : r.local_part;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.destination);
    }
    return [...groups.entries()].map(([localPart, targets]) => ({ localPart, targets }));
  }

  async function renderAliases(scope, domain, req) {
    const entries = aliasEntries(scope, domain);
    if (!entries.length) return op('vmail.aliases.remove', { domain }, req, 'exim');
    return op('vmail.aliases.write', { domain, entries }, req, 'exim');
  }

  // Runs `mutate` (DB) and then re-renders the domain's alias file; when the
  // host write fails the rows are put back as they were.
  async function withAliasRender(scope, domain, mutate, req) {
    const before = stmts.forwarderRowsOfDomain.all(domain, scope.accountId);
    const result = db.transaction(mutate)();
    try {
      await renderAliases(scope, domain, req);
    } catch (err) {
      db.transaction(() => {
        db.prepare('DELETE FROM mail_forwarders WHERE domain = ? AND account_id = ?').run(domain, scope.accountId);
        for (const r of before) stmts.insertForwarderFull.run(r.id, r.account_id, r.domain, r.local_part, r.destination, r.created_at);
      })();
      throw err;
    }
    return result;
  }

  const forwarders = {
    list(scope, query = {}) {
      assertFeature(scope, 'forwarders');
      let rows;
      if (query.domain) { assertDomain(scope, query.domain); rows = stmts.forwardersOfDomain.all(scope.accountId, query.domain); } else rows = stmts.forwardersOf.all(scope.accountId);
      if (query.q) { const q = query.q.toLowerCase(); rows = rows.filter((r) => `${r.local_part}@${r.domain}`.includes(q) || r.destination.toLowerCase().includes(q)); }
      return { data: rows.map(shapeForwarder), meta: { total: rows.length, domains: domainNames(scope), maxPerDomain: Number(settings.get('panel.mail.max_forwarders_per_domain') ?? 200) } };
    },

    async create(scope, { domain, localPart = null, destination }, req) {
      assertFeature(scope, 'forwarders');
      const d = assertDomain(scope, domain);
      if (localPart == null) {
        const action = destination === ':fail:' ? 'fail' : destination === ':blackhole:' ? 'blackhole' : 'forward';
        return defaultAddress.set(scope, d.domain, { action, destination: action === 'forward' ? destination : undefined }, req);
      }
      if (destination.toLowerCase() === `${localPart}@${d.domain}`) throw unprocessable('A forwarder cannot point at itself', { destination: ['Same as the forwarded address'] });
      assertDomainClean(scope, d.domain);
      const max = Number(settings.get('panel.mail.max_forwarders_per_domain') ?? 200);
      if (stmts.forwarderCountOfDomain.get(d.domain, scope.accountId).n >= max) throw new HttpError(409, 'limit_reached', `At most ${max} forwarders per domain`);
      if (stmts.forwarderExists.get(d.domain, localPart, destination)) throw conflict(`${localPart}@${d.domain} already forwards to ${destination}`);
      const id = await withAliasRender(scope, d.domain, () => Number(stmts.insertForwarder.run(scope.accountId, d.domain, localPart, destination).lastInsertRowid), req);
      audit(req, scope, 'panel.email.forwarder.create', { address: `${localPart}@${d.domain}`, destination });
      return shapeForwarder(stmts.forwarder.get(id, scope.accountId));
    },

    async remove(scope, id, req) {
      assertFeature(scope, 'forwarders');
      const row = stmts.forwarder.get(id, scope.accountId);
      if (!row) throw notFound('Forwarder');
      assertDomain(scope, row.domain);
      await withAliasRender(scope, row.domain, () => stmts.deleteForwarder.run(row.id, scope.accountId), req);
      audit(req, scope, 'panel.email.forwarder.delete', { address: row.local_part == null ? `*@${row.domain}` : `${row.local_part}@${row.domain}`, destination: row.destination });
      return { id: row.id, removed: true };
    },
  };

  const defaultAddress = {
    get(scope, domain) {
      assertFeature(scope, 'defaultaddress');
      const d = assertDomain(scope, domain);
      const row = stmts.catchAll.get(d.domain, scope.accountId);
      if (!row) return { domain: d.domain, action: 'fail', destination: null, configured: false };
      const action = row.destination === ':fail:' ? 'fail' : row.destination === ':blackhole:' ? 'blackhole' : 'forward';
      return { domain: d.domain, action, destination: action === 'forward' ? row.destination : null, configured: true, id: row.id };
    },

    async set(scope, domain, { action, destination }, req) {
      assertFeature(scope, 'defaultaddress');
      const d = assertDomain(scope, domain);
      if (action === 'forward' && !destination) throw unprocessable('A destination is required to forward the default address', { destination: ['Required when action is "forward"'] });
      assertDomainClean(scope, d.domain);
      const value = action === 'forward' ? destination : `:${action}:`;
      await withAliasRender(scope, d.domain, () => {
        stmts.deleteCatchAll.run(d.domain, scope.accountId);
        stmts.insertForwarder.run(scope.accountId, d.domain, null, value);
      }, req);
      audit(req, scope, 'panel.email.default.set', { domain: d.domain, action, destination: action === 'forward' ? destination : null });
      return defaultAddress.get(scope, d.domain);
    },
  };

  async function renderDomainForwards(req) {
    const entries = stmts.domainForwards.all().map((r) => ({ domain: r.domain, target: r.target_domain }));
    return op('vmail.domainfwd.write', { entries }, req, 'exim');
  }

  const domainForward = {
    get(scope, domain) {
      assertFeature(scope, 'forwarders');
      const d = assertDomain(scope, domain);
      const row = stmts.domainForward.get(d.domain, scope.accountId);
      return { domain: d.domain, targetDomain: row?.target_domain ?? null, configured: Boolean(row), updatedAt: row?.updated_at ?? null };
    },

    async set(scope, domain, { targetDomain }, req) {
      assertFeature(scope, 'forwarders');
      const d = assertDomain(scope, domain);
      if (targetDomain === d.domain) throw unprocessable('A domain cannot forward to itself', { targetDomain: ['Same as the domain'] });
      assertDomainClean(scope, d.domain);
      const before = stmts.domainForward.get(d.domain, scope.accountId);
      const info = stmts.upsertDomainForward.run(scope.accountId, d.domain, targetDomain);
      if (info.changes === 0) throw conflict(`The domain forwarder for ${d.domain} belongs to another account`);
      try { await renderDomainForwards(req); } catch (err) {
        if (before) stmts.upsertDomainForward.run(scope.accountId, d.domain, before.target_domain); else stmts.deleteDomainForward.run(d.domain, scope.accountId);
        throw err;
      }
      audit(req, scope, 'panel.email.domain_forward.set', { domain: d.domain, targetDomain });
      return domainForward.get(scope, d.domain);
    },

    async remove(scope, domain, req) {
      assertFeature(scope, 'forwarders');
      const d = assertDomain(scope, domain);
      const before = stmts.domainForward.get(d.domain, scope.accountId);
      if (!before) throw notFound('Domain forwarder');
      stmts.deleteDomainForward.run(d.domain, scope.accountId);
      try { await renderDomainForwards(req); } catch (err) { stmts.upsertDomainForward.run(scope.accountId, d.domain, before.target_domain); throw err; }
      audit(req, scope, 'panel.email.domain_forward.delete', { domain: d.domain });
      return { domain: d.domain, removed: true };
    },
  };

  // ------------------------------------------------------- autoresponders ---

  const shapeAutoresponder = (r) => ({ id: r.id, address: `${r.local_part}@${r.domain}`, domain: r.domain, localPart: r.local_part, fromName: r.from_name, subject: r.subject, body: r.body, charset: r.charset, intervalHours: r.interval_hours, startAt: r.start_at, stopAt: r.stop_at, enabled: Boolean(r.enabled), createdAt: r.created_at, updatedAt: r.updated_at });

  const autoresponderOpArgs = (r) => ({ domain: r.domain, localPart: r.local_part, fromName: r.from_name ?? '', subject: r.subject, body: r.body, charset: r.charset || 'utf-8', intervalHours: r.interval_hours, ...(r.start_at ? { startAt: r.start_at } : {}), ...(r.stop_at ? { stopAt: r.stop_at } : {}), enabled: true });
  const maxAutoresponders = () => Number(settings.get('panel.mail.max_autoresponders_per_domain') ?? 50);

  async function applyAutoresponder(row, req) {
    if (row.enabled) return op('vmail.autoresponder.write', autoresponderOpArgs(row), req, 'exim');
    return op('vmail.autoresponder.remove', { domain: row.domain, localPart: row.local_part }, req, 'exim');
  }

  const autoresponders = {
    list(scope) {
      assertFeature(scope, 'autoresponders');
      return { data: stmts.autoresponders.all(scope.accountId).map(shapeAutoresponder), meta: { domains: domainNames(scope), maxPerDomain: maxAutoresponders() } };
    },

    get(scope, id) {
      assertFeature(scope, 'autoresponders');
      const row = stmts.autoresponder.get(id, scope.accountId);
      if (!row) throw notFound('Autoresponder');
      return shapeAutoresponder(row);
    },

    async create(scope, input, req) {
      assertFeature(scope, 'autoresponders');
      const { localPart, domain } = splitAddress(input.address);
      if (!LOCAL_PART.test(localPart)) throw unprocessable('Invalid address', { address: ['Local part: lowercase letters, digits, ".", "_" or "-"'] });
      const d = assertDomain(scope, domain);
      assertDomainClean(scope, d.domain);
      // Each autoresponder is a body on the root filesystem outside the
      // account's quota, so the count per domain is bounded.
      const max = maxAutoresponders();
      if (stmts.autoresponderCountOfDomain.get(d.domain, scope.accountId).n >= max) throw new HttpError(409, 'limit_reached', `At most ${max} autoresponders per domain`);
      if (stmts.autoresponderByAddress.get(d.domain, localPart)) throw conflict(`${localPart}@${d.domain} already has an autoresponder`);
      if (input.startAt && input.stopAt && new Date(input.stopAt) <= new Date(input.startAt)) throw unprocessable('The stop time must be after the start time', { stopAt: ['Must be after startAt'] });
      const row = { account_id: scope.accountId, domain: d.domain, local_part: localPart, from_name: input.fromName ?? '', subject: input.subject, body: input.body, charset: input.charset || 'utf-8', interval_hours: input.intervalHours ?? 24, start_at: input.startAt ?? null, stop_at: input.stopAt ?? null, enabled: input.enabled === false ? 0 : 1 };
      await applyAutoresponder(row, req);
      let id;
      try { id = Number(stmts.insertAutoresponder.run(row).lastInsertRowid); } catch (err) {
        try { await agent().op('vmail.autoresponder.remove', { domain: d.domain, localPart }, { req }); } catch { /* best effort */ }
        if (/UNIQUE/.test(err.message)) throw conflict(`${localPart}@${d.domain} already has an autoresponder`);
        throw err;
      }
      audit(req, scope, 'panel.email.autoresponder.create', { address: `${localPart}@${d.domain}`, enabled: Boolean(row.enabled) });
      return shapeAutoresponder(stmts.autoresponder.get(id, scope.accountId));
    },

    async update(scope, id, patch, req) {
      assertFeature(scope, 'autoresponders');
      const current = stmts.autoresponder.get(id, scope.accountId);
      if (!current) throw notFound('Autoresponder');
      assertDomain(scope, current.domain);
      if (patch.address !== undefined) {
        const { localPart, domain } = splitAddress(patch.address);
        if (localPart !== current.local_part || domain !== current.domain) throw unprocessable('The address of an autoresponder cannot be changed; delete it and create a new one', { address: ['Read-only'] });
      }
      const next = {
        ...current,
        from_name: patch.fromName ?? current.from_name, subject: patch.subject ?? current.subject, body: patch.body ?? current.body, charset: patch.charset ?? current.charset,
        interval_hours: patch.intervalHours ?? current.interval_hours,
        start_at: patch.startAt === undefined ? current.start_at : patch.startAt, stop_at: patch.stopAt === undefined ? current.stop_at : patch.stopAt,
        enabled: patch.enabled === undefined ? current.enabled : (patch.enabled ? 1 : 0),
      };
      if (next.start_at && next.stop_at && new Date(next.stop_at) <= new Date(next.start_at)) throw unprocessable('The stop time must be after the start time', { stopAt: ['Must be after startAt'] });
      await applyAutoresponder(next, req);
      stmts.updateAutoresponder.run(next);
      audit(req, scope, 'panel.email.autoresponder.update', { address: `${current.local_part}@${current.domain}`, enabled: Boolean(next.enabled) });
      return shapeAutoresponder(stmts.autoresponder.get(id, scope.accountId));
    },

    async remove(scope, id, req) {
      assertFeature(scope, 'autoresponders');
      const row = stmts.autoresponder.get(id, scope.accountId);
      if (!row) throw notFound('Autoresponder');
      assertDomain(scope, row.domain);
      await op('vmail.autoresponder.remove', { domain: row.domain, localPart: row.local_part }, req, 'exim');
      stmts.deleteAutoresponder.run(row.id, scope.accountId);
      audit(req, scope, 'panel.email.autoresponder.delete', { address: `${row.local_part}@${row.domain}` });
      return { id: row.id, removed: true };
    },
  };

  // ----------------------------------------------------------------- spam ---

  const shapeSpam = (row) => (row
    ? { enabled: Boolean(row.enabled), requiredScore: row.required_score, autoDelete: Boolean(row.auto_delete), autoDeleteScore: row.auto_delete_score, whitelist: json.parse(row.whitelist_json, []), blacklist: json.parse(row.blacklist_json, []), updatedAt: row.updated_at, configured: true }
    : { enabled: false, requiredScore: 5, autoDelete: false, autoDeleteScore: null, whitelist: [], blacklist: [], updatedAt: null, configured: false });

  // One entry per domain of every account with settings (the file is server-wide).
  function spamEntries() {
    const entries = [];
    for (const s of stmts.spamAll.all()) {
      const domains = new Set([s.main_domain, ...stmts.domainsOfAccount.all(s.account_id).map((d) => d.domain)]);
      for (const domain of domains) entries.push({ domain, username: s.username, enabled: Boolean(s.enabled), threshold: Math.max(10, Math.min(200, Math.round(s.required_score * 10))), autoDelete: Boolean(s.auto_delete) });
    }
    return entries;
  }

  const spam = {
    get(scope) {
      assertFeature(scope, 'spamassassin');
      return { ...shapeSpam(stmts.spam.get(scope.accountId)), available: capabilities.has('spamassassin') };
    },

    async set(scope, input, req) {
      assertFeature(scope, 'spamassassin');
      capabilities.require('spamassassin', 'SpamAssassin is not installed on this server, so spam settings cannot be applied yet');
      const before = stmts.spam.get(scope.accountId);
      const current = shapeSpam(before);
      const next = {
        enabled: input.enabled ?? current.enabled, requiredScore: input.requiredScore ?? current.requiredScore, autoDelete: input.autoDelete ?? current.autoDelete,
        autoDeleteScore: input.autoDeleteScore === undefined ? current.autoDeleteScore : input.autoDeleteScore,
        whitelist: input.whitelist ?? current.whitelist, blacklist: input.blacklist ?? current.blacklist,
      };
      next.whitelist = [...new Set(next.whitelist.map((a) => a.toLowerCase()))];
      next.blacklist = [...new Set(next.blacklist.map((a) => a.toLowerCase()))];
      if (next.autoDelete && next.autoDeleteScore != null && next.autoDeleteScore < next.requiredScore) throw unprocessable('The auto-delete score cannot be lower than the required score', { autoDeleteScore: ['Must be at least the required score'] });
      stmts.upsertSpam.run({ account_id: scope.accountId, enabled: next.enabled ? 1 : 0, required_score: next.requiredScore, auto_delete: next.autoDelete ? 1 : 0, auto_delete_score: next.autoDelete ? (next.autoDeleteScore ?? next.requiredScore) : null, whitelist_json: JSON.stringify(next.whitelist), blacklist_json: JSON.stringify(next.blacklist) });
      try {
        const home = homeOf(scope);
        await op('files.mkdir', { username: scope.username, path: `${home}/.spamassassin`, mode: '0700' }, req, 'panel-files');
        await op('files.write', { username: scope.username, path: `${home}/.spamassassin/user_prefs`, content: renderUserPrefs(next), mode: '0600' }, req, 'panel-files');
        await op('vmail.spam_users.write', { entries: spamEntries() }, req, 'exim');
      } catch (err) {
        if (before) stmts.upsertSpam.run({ account_id: before.account_id, enabled: before.enabled, required_score: before.required_score, auto_delete: before.auto_delete, auto_delete_score: before.auto_delete_score, whitelist_json: before.whitelist_json, blacklist_json: before.blacklist_json });
        else stmts.deleteSpam.run(scope.accountId);
        throw err;
      }
      audit(req, scope, 'panel.email.spam.update', { enabled: next.enabled, requiredScore: next.requiredScore, autoDelete: next.autoDelete, whitelist: next.whitelist.length, blacklist: next.blacklist.length });
      return spam.get(scope);
    },
  };

  // ----------------------------------------------- deliverability + DKIM ---

  const requireMail = () => { if (!ctx.mail?.deliverability) throw new HttpError(503, 'service_unavailable', 'The Email category is not loaded'); return ctx.mail; };
  const requireDns = () => { if (!ctx.dns) throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded'); return ctx.dns; };

  const deliverability = {
    async check(scope, domain) {
      const d = assertDomain(scope, domain);
      return requireMail().deliverability.check(d.domain, scope.ownerPrincipal);
    },
    async fix(scope, domain, { items }, req) {
      const d = assertDomain(scope, domain);
      if (!stmts.zoneOwned.get(d.domain, scope.accountId)) throw notFound(`DNS zone for "${d.domain}"`);
      const result = await requireMail().deliverability.fix(d.domain, items, scope.ownerPrincipal, req);
      audit(req, scope, 'panel.email.deliverability.fix', { domain: d.domain, items });
      return result;
    },
  };

  const dkim = {
    async ensure(scope, domain, { rotate = false } = {}, req) {
      const d = assertDomain(scope, domain);
      if (!stmts.zoneOwned.get(d.domain, scope.accountId)) throw notFound(`DNS zone for "${d.domain}"`);
      const result = await requireDns().ensureDkim(d.domain, rotate ? { rotate: true } : {}, scope.ownerPrincipal, req);
      audit(req, scope, 'panel.email.dkim.ensure', { domain: d.domain, rotate: Boolean(rotate) });
      return result;
    },
    async remove(scope, domain, req) {
      const d = assertDomain(scope, domain);
      if (!stmts.zoneOwned.get(d.domain, scope.accountId)) throw notFound(`DNS zone for "${d.domain}"`);
      const result = await requireDns().removeDkim(d.domain, scope.ownerPrincipal, req);
      audit(req, scope, 'panel.email.dkim.remove', { domain: d.domain });
      return result;
    },
    status(scope, domain) {
      const d = assertDomain(scope, domain);
      const key = stmts.dkimKey.get(d.domain);
      return { domain: d.domain, zone: Boolean(stmts.zoneOwned.get(d.domain, scope.accountId)), key: key ? { selector: key.selector, createdAt: key.created_at } : null };
    },
  };

  // -------------------------------------------------------------- webmail ---

  let webmailCache = { at: 0, value: null };
  async function detectWebmail() {
    if (webmailCache.value && Date.now() - webmailCache.at < 60_000) return webmailCache.value;
    let value;
    try { value = await agent().op('web.webmail.detect', {}); } catch (err) { value = { installed: false, error: err.message }; }
    webmailCache = { at: Date.now(), value };
    return value;
  }

  async function webmail(scope, query = {}) {
    const detected = await detectWebmail();
    const configured = String(settings.get('panel.webmail_url') || '').trim();
    const url = configured || (detected.installed && detected.apacheAlias ? `https://${hostname()}${detected.apacheAlias.replace(/\/?$/, '/')}` : null);
    let prefillUser = null;
    if (query.user) {
      const { localPart, domain } = splitAddress(query.user);
      const d = domainsOf(scope).find((x) => x.domain === domain);
      if (d && stmts.mailboxByAddress.get(domain, localPart, scope.accountId)) prefillUser = `${localPart}@${domain}`;
    }
    if (!prefillUser) { const first = stmts.mailboxesOf.get(scope.accountId); prefillUser = first ? `${first.local_part}@${first.domain}` : null; }
    return { installed: Boolean(detected.installed), flavor: detected.flavor ?? null, version: detected.version ?? null, url, configuredUrl: configured || null, prefillUser, hostname: hostname() };
  }

  // ---------------------------------------------------------------- usage ---

  async function usage(scope, { sinceHours = 24 } = {}) {
    assertFeature(scope, 'emailaccts');
    const mail = requireMail();
    const domains = new Set(domainNames(scope));
    const mailboxes = stmts.mailboxesOf.all(scope.accountId).map((r) => `${r.local_part}@${r.domain}`);
    const mailboxSet = new Set(mailboxes);
    const report = await mail.reports.delivery({ hours: sinceHours, page: 1, pageSize: 20_000 });
    const rows = report.data.filter((r) => domains.has(domainOf(r.sender)) || domains.has(domainOf(r.recipient)) || mailboxSet.has(String(r.authUser || '').toLowerCase()));
    const totals = { messages: 0, sent: 0, received: 0, delivered: 0, failed: 0, deferred: 0, queued: 0 };
    const perMailbox = new Map(mailboxes.map((a) => [a, { address: a, sent: 0, received: 0, failed: 0 }]));
    const seen = new Set();
    for (const r of rows) {
      const sender = String(r.sender || '').toLowerCase();
      const recipient = String(r.recipient || '').toLowerCase();
      const outbound = domains.has(domainOf(sender)) || mailboxSet.has(String(r.authUser || '').toLowerCase());
      if (!seen.has(r.id)) { seen.add(r.id); totals.messages++; if (outbound) totals.sent++; }
      if (domains.has(domainOf(recipient))) totals.received++;
      if (r.status in totals) totals[r.status]++;
      if (outbound && perMailbox.has(sender)) { perMailbox.get(sender).sent++; if (r.status === 'failed') perMailbox.get(sender).failed++; }
      if (perMailbox.has(recipient)) perMailbox.get(recipient).received++;
    }
    let byDomain = [];
    try {
      const summary = await mail.stats.summary({ hours: sinceHours });
      byDomain = (summary.topDomains || []).filter((d) => domains.has(d.domain));
    } catch (err) { logger.debug({ err }, 'panel-email: stats summary unavailable'); }
    const quotaMb = stmts.mailboxesOf.all(scope.accountId).reduce((sum, r) => sum + (r.quota_mb || 0), 0);
    return {
      hours: sinceHours, domains: [...domains], totals, byDomain, mailboxes: [...perMailbox.values()],
      recent: rows.slice(0, 100).map((r) => ({ id: r.id, arrivedAt: r.arrivedAt, sender: r.sender, recipient: r.recipient, status: r.status, subject: r.subject ?? null, size: r.size ?? null, detail: r.detail ?? null })),
      storage: { mailboxes: mailboxes.length, quotaMb, limit: limitOf(scope, 'max_email') },
      log: { from: report.meta?.logFrom ?? null, truncated: Boolean(report.meta?.logTruncated), exists: report.meta?.logExists ?? null },
    };
  }

  // ------------------------------------------------- releasing a domain ---

  // The domains an account answers for, from its id (the scope is not
  // available while an account is being terminated).
  function domainsOfAccountId(accountId, mainDomain) {
    const names = new Set(stmts.domainsOfAccount.all(accountId).map((d) => d.domain));
    if (mainDomain) names.add(mainDomain);
    return [...names];
  }

  // An agent answer that means "there is nothing on the host for this": the
  // daemon is not installed or the file never existed.
  const nothingOnHost = (err) => ['capability_missing', 'binary_not_found', 'not_found'].includes(err?.code) || (err instanceof CapabilityError);

  // Seam for U3 (addon/sub/parked removal) and the account.terminated
  // listener below: every mail object of `domain` that belongs to `accountId`
  // leaves the host and the panel DB, so the next account that registers the
  // domain starts from an empty passwd/alias/domainfwd/autoresponder state.
  // Host first: a host write that fails for another reason than "nothing
  // there" keeps the rows, which then block the next owner (409
  // domain_stale) until root re-runs the release. `snapshot` carries the rows
  // of an account whose DB rows are already gone (termination cascade).
  async function releaseDomain(domain, accountId, req = null, { snapshot = null, username = null } = {}) {
    domain = String(domain || '').toLowerCase();
    if (!fields.domain.safeParse(domain).success || !Number.isInteger(accountId)) throw unprocessable('A domain and an account id are required');
    const errors = [];
    const hostOp = async (name, args) => {
      try { await agent().op(name, args, { req }); return true; } catch (err) {
        if (nothingOnHost(err)) return true;
        errors.push({ op: name, code: err.code ?? null, message: err.message });
        return false;
      }
    };
    const autoresponders = snapshot?.autoresponders ?? stmts.autorespondersOfDomain.all(domain, accountId);
    const result = { domain, accountId, autoresponders: 0, passwdPurged: false, aliases: false, domainForward: false, released: true, errors };
    for (const r of autoresponders) { if (await hostOp('vmail.autoresponder.remove', { domain, localPart: r.local_part })) result.autoresponders++; }
    // The passwd file is the domain's, whoever wrote it; it goes unless the
    // mail domain already belongs to another account (the file is theirs now,
    // and vmail.passwd.set drops any foreign-uid line it still carries).
    const md = stmts.mailDomain.get(domain);
    const ownedElsewhere = md && md.account_id != null && md.account_id !== accountId;
    if (!ownedElsewhere) result.passwdPurged = await hostOp('vmail.passwd.purge', { domain });
    const record = (rows) => {
      const entry = { action: 'panel.email.domain.release', target: username ?? String(accountId), args: { domain, accountId, rows, autoresponders: result.autoresponders, passwdPurged: result.passwdPurged, errors: errors.map((e) => `${e.op}: ${e.message}`) } };
      if (req?.audit) req.audit(entry); else ctx.auditRecord?.(null, entry);
      if (errors.length) logger.warn({ domain, accountId, errors }, 'panel-email: domain release left host files behind');
    };
    if (errors.length) { result.released = false; result.rows = null; record(null); return result; }
    const rowsRemoved = db.transaction(() => ({ forwarders: stmts.releaseForwarders.run(domain, accountId).changes, domainForward: stmts.releaseDomainForward.run(domain, accountId).changes, autoresponders: stmts.releaseAutoresponders.run(domain, accountId).changes, mailDomain: ownedElsewhere ? 0 : stmts.releaseMailDomain.run(domain, accountId).changes }))();
    // The alias file follows what is left for the domain (the new owner's
    // rows when it was re-homed first), the server-wide lists are re-rendered.
    const remaining = new Map();
    for (const r of stmts.forwarderRowsOfDomainAny.all(domain)) {
      const key = r.local_part == null ? '*' : r.local_part;
      if (!remaining.has(key)) remaining.set(key, []);
      remaining.get(key).push(r.destination);
    }
    result.aliases = remaining.size
      ? await hostOp('vmail.aliases.write', { domain, entries: [...remaining.entries()].map(([localPart, targets]) => ({ localPart, targets })) })
      : await hostOp('vmail.aliases.remove', { domain });
    result.domainForward = await hostOp('vmail.domainfwd.write', { entries: stmts.domainForwards.all().map((r) => ({ domain: r.domain, target: r.target_domain })) });
    await hostOp('vmail.spam_users.write', { entries: spamEntries() });
    result.released = errors.length === 0;
    result.rows = rowsRemoved;
    record(rowsRemoved);
    return result;
  }

  // account.terminated: the rows go with the account (ON DELETE CASCADE), so
  // what the host has to forget is read at the 'pre' stage and released after
  // the account is gone. Nothing here can veto a termination.
  const terminating = new Map();
  async function onTerminated(envelope) {
    const username = envelope?.payload?.username;
    if (!username) return;
    if (envelope.stage === 'pre') {
      const account = stmts.accountByUsername.get(username);
      if (!account) return;
      const domains = domainsOfAccountId(account.id, account.domain);
      terminating.set(username, { accountId: account.id, domains, autoresponders: Object.fromEntries(domains.map((d) => [d, stmts.autorespondersOfDomain.all(d, account.id)])) });
      return;
    }
    const snap = terminating.get(username);
    terminating.delete(username);
    if (!snap) return;
    if (stmts.accountByUsername.get(username)) return;
    for (const domain of snap.domains) {
      try { await releaseDomain(domain, snap.accountId, null, { snapshot: { autoresponders: snap.autoresponders[domain] || [] }, username }); } catch (err) { logger.warn({ err, domain, username }, 'panel-email: release after termination failed'); }
    }
  }

  function subscribe(events = ctx.events) {
    if (!events?.on) return () => {};
    const off = events.on('account.terminated', onTerminated);
    return () => off?.();
  }

  // --------------------------------------------------- seam S4 + advisor ---

  // The operator's switch under Service Configuration. An absent row means the
  // feature was never configured and the panel may wire it in at boot; an
  // explicit false was set by the operator and is never overridden here.
  const virtualMailDisabledByOperator = () => settings.get('service_config.virtual_mail', null)?.enabled === false;

  // ctx.web.applyVirtualMail({ enabled }, req) (service-configuration) is a
  // server-wide root-level rewrite of Exim/Dovecot. It runs from the
  // integrator's boot code (after capabilities.refresh) and from the admin
  // side, never from a customer request: there is no request principal, the
  // audit row names the panel, and a failure is memoised with a backoff so a
  // broken host is not re-applied in a loop.
  const APPLY_RETRY_MS = 10 * 60_000;
  let virtualMailApplied = null;
  let virtualMailFailure = null;
  async function ensureVirtualMail(_req = null, { force = false } = {}) {
    if (virtualMailApplied && !force) return virtualMailApplied;
    if (virtualMailFailure && !force && Date.now() - virtualMailFailure.at < APPLY_RETRY_MS) return virtualMailFailure.result;
    const fail = (reason) => { virtualMailApplied = null; virtualMailFailure = { at: Date.now(), result: { applied: false, reason } }; return virtualMailFailure.result; };
    if (!settings.get('panel.enabled')) return { applied: false, reason: 'the customer panel is disabled (panel.enabled)' };
    if (virtualMailDisabledByOperator()) return { applied: false, reason: 'virtual mail is switched off under Service Configuration' };
    const apply = ctx.web?.applyVirtualMail;
    if (typeof apply !== 'function') return { applied: false, reason: 'service-configuration does not provide applyVirtualMail yet' };
    if (!capabilities.has('exim') || !capabilities.has('dovecot')) return { applied: false, reason: 'Exim and Dovecot are both needed' };
    try {
      const r = await apply({ enabled: true }, null);
      virtualMailFailure = null;
      virtualMailApplied = { applied: true, ...(r || {}) };
      return virtualMailApplied;
    } catch (err) {
      logger.warn({ err }, 'panel-email: applyVirtualMail failed');
      return fail(err.message);
    }
  }

  async function renderCheck() {
    try { return await agent().op('vmail.render.check', {}); } catch (err) { return { error: err.message, dovecot: { installed: false }, exim: { installed: false }, routerHooked: false, authHooked: false, transportHooked: false }; }
  }

  // Security Advisor findings for the virtual-mail wiring (seam S4): the
  // integrator calls this from security-center's advisor.scan.
  async function advisorFindings() {
    if (!settings.get('panel.enabled')) return [];
    const r = await renderCheck();
    const fix = { label: 'Exim Configuration Manager', path: '/service-configuration/exim-configuration-manager' };
    const findings = [];
    if (r.error) return [{ id: 'panel.mail.check', grade: 'info', title: 'Could not check the virtual-mail configuration', detail: r.error }];
    if (!r.exim.installed || !r.dovecot.installed) return [{ id: 'panel.mail.daemons', grade: 'info', title: 'Virtual mailboxes need Exim and Dovecot', detail: r.hint || 'Install both to let account users create mailboxes.' }];
    if (r.exim.configOk === false) findings.push({ id: 'panel.mail.exim', grade: 'critical', title: 'Exim rejects its configuration', detail: r.exim.output || 'exim -bV failed', fix });
    if (r.dovecot.configOk === false) findings.push({ id: 'panel.mail.dovecot', grade: 'critical', title: 'Dovecot rejects its configuration', detail: r.dovecot.output || 'doveconf -n failed', fix: { label: 'Mailserver Configuration', path: '/service-configuration/mailserver-configuration' } });
    if (r.exim.configOk !== false) {
      findings.push(r.routerHooked
        ? { id: 'panel.mail.router', grade: 'ok', title: 'Exim delivers to virtual mailboxes (whm_virtual_user router present)' }
        : { id: 'panel.mail.router', grade: 'warning', title: 'Exim has no virtual-mailbox router', detail: 'Mail for panel-created mailboxes is not delivered until the whm_virtual_user router and whm_dovecot_lmtp transport are applied.', fix });
      findings.push(r.authHooked
        ? { id: 'panel.mail.auth', grade: 'ok', title: 'SMTP authentication uses Dovecot (dovecot_plain authenticator present)' }
        : { id: 'panel.mail.auth', grade: 'warning', title: 'Exim has no Dovecot authenticator', detail: 'Mailbox users cannot authenticate to send mail until the dovecot_plain/dovecot_login authenticators are applied.', fix });
    }
    return findings;
  }

  return {
    LOCAL_PART, SYSTEM_ROOT,
    domainsOf, assertDomain, assertDomainClean, ensureMailDomain, releaseDomain, subscribe,
    accounts, forwarders, defaultAddress, domainForward, autoresponders, spam, deliverability, dkim, webmail, usage,
    ensureVirtualMail, renderCheck, advisorFindings,
  };
}
