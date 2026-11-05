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
// Mirrors fields.password in lib/validate.js (zod's min has no public getter).
export const PASSWORD_MIN_LENGTH = 8;
// Mirrors agent/src/ops/vmail.js (vmail.mailbox.expunge): the agent refuses anything else.
export const EMPTIABLE_FOLDERS = ['Trash', 'Junk'];
export const EXPUNGE_MIN_DAYS = 7;
export const EXPUNGE_MAX_DAYS = 3650;
export const FOLDER_NAME = /^(?!\.)(?!.*\.\.)(?!.*\.$)[^\0-\x1f\x7f"\\*%]{1,200}$/;
export const MESSAGE_STATUSES = ['delivered', 'completed', 'failed', 'rejected', 'deferred', 'queued'];

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

// Mail filters (P1-3): structured rules rendered into Sieve here, never
// accepted as script text. Every value lands inside a Sieve quoted string, so
// the grammar refuses what a quoted string cannot carry (control characters,
// a second line) and the renderer escapes the two characters that end or
// escape one. Folder names and redirect targets are grammar-checked too; the
// compiled script is the agent's business (vmail.sieve.write runs sievec).
export const FILTER_HEADERS = ['from', 'to', 'subject', 'body', 'any_header', 'custom'];
export const FILTER_OPS = ['contains', 'is', 'matches', 'not_contains'];
export const FILTER_ACTION_TYPES = ['fileinto', 'discard', 'redirect', 'stop'];
export const FILTER_ANY_HEADERS = ['from', 'to', 'cc', 'subject', 'reply-to', 'sender', 'list-id'];
export const FILTER_DEFAULT_FOLDERS = ['INBOX', 'Junk', 'Trash', 'Archive', 'Drafts', 'Sent'];
export const FILTER_MAX_MATCH = 10;
export const FILTER_MAX_ACTIONS = 5;
// sieve_max_redirects (Pigeonhole default 4) caps a script run; one filter stays under it.
export const FILTER_MAX_REDIRECTS = 4;
export const FILTER_NAME = /^[^\u0000-\u001f\u007f]{1,80}$/u;
export const FILTER_VALUE = /^[^\u0000-\u001f\u007f]{1,998}$/u;
export const FILTER_HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
// An IMAP folder name as Dovecot's Maildir++ layout takes it: "." separates
// levels, so no leading, trailing or doubled dots; no control characters.
export const FILTER_FOLDER = /^(?!\.)(?!.*\.\.)(?!.*\.$)[^\u0000-\u001f\u007f/\\"]{1,200}$/u;
export const FILTER_ADDRESS = /^(?=.{3,254}$)[A-Za-z0-9][A-Za-z0-9._+=-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const SIEVE_HEADER = '# Keel (customer panel mail filters) - managed script, edits are overwritten';

export function sieveString(value) {
  if (typeof value !== 'string' || !FILTER_VALUE.test(value)) throw unprocessable('A filter value must be a single line of 1 to 998 characters without control characters', { rules: ['Invalid value'] });
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Canonical rules object from a validated body; every string is re-checked
// against the grammar of where it lands.
export function normalizeRules(rules) {
  const bad = (message, key = 'rules') => unprocessable(message, { [key]: [message] });
  if (!rules || typeof rules !== 'object') throw bad('Rules are required');
  const match = Array.isArray(rules.match) ? rules.match : [];
  const actions = Array.isArray(rules.actions) ? rules.actions : [];
  if (match.length < 1 || match.length > FILTER_MAX_MATCH) throw bad(`A filter needs 1 to ${FILTER_MAX_MATCH} conditions`);
  if (actions.length < 1 || actions.length > FILTER_MAX_ACTIONS) throw bad(`A filter needs 1 to ${FILTER_MAX_ACTIONS} actions`);
  const out = { matchAll: rules.matchAll !== false, match: [], actions: [] };
  for (const m of match) {
    if (!FILTER_HEADERS.includes(m?.header)) throw bad('Unknown condition field');
    if (!FILTER_OPS.includes(m?.op)) throw bad('Unknown condition operator');
    if (typeof m.value !== 'string' || !FILTER_VALUE.test(m.value)) throw bad('A condition value must be a single line of 1 to 998 characters without control characters');
    const entry = { header: m.header, op: m.op, value: m.value };
    if (m.header === 'custom') {
      if (typeof m.name !== 'string' || !FILTER_HEADER_NAME.test(m.name)) throw bad('A custom header name uses letters, digits and "-" only (64 characters)');
      entry.name = m.name.toLowerCase();
    }
    out.match.push(entry);
  }
  let redirects = 0;
  for (const a of actions) {
    if (!FILTER_ACTION_TYPES.includes(a?.type)) throw bad('Unknown action');
    const entry = { type: a.type };
    if (a.type === 'fileinto') {
      if (typeof a.folder !== 'string' || !FILTER_FOLDER.test(a.folder)) throw bad('A folder name has 1 to 200 characters, no control characters, quotes, slashes or leading, trailing or doubled dots');
      entry.folder = a.folder;
    } else if (a.type === 'redirect') {
      if (typeof a.address !== 'string' || !FILTER_ADDRESS.test(a.address)) throw bad('A redirect target must be an email address');
      entry.address = a.address.toLowerCase();
      if (++redirects > FILTER_MAX_REDIRECTS) throw bad(`At most ${FILTER_MAX_REDIRECTS} redirects per filter`);
    }
    out.actions.push(entry);
  }
  return out;
}

export function renderSieveTest(m) {
  const op = { contains: ':contains', is: ':is', matches: ':matches', not_contains: ':contains' }[m.op];
  const not = m.op === 'not_contains' ? 'not ' : '';
  const value = sieveString(m.value);
  if (m.header === 'body') return `${not}body :text ${op} ${value}`;
  const names = m.header === 'any_header' ? `[${FILTER_ANY_HEADERS.map(sieveString).join(', ')}]` : sieveString(m.header === 'custom' ? m.name : m.header);
  return `${not}header ${op} ${names} ${value}`;
}

export function renderSieveAction(a) {
  if (a.type === 'fileinto') return `fileinto :create ${sieveString(a.folder)};`;
  if (a.type === 'redirect') return `redirect ${sieveString(a.address)};`;
  return `${a.type};`;
}

// The whole script of one scope: enabled filters in position order; only the
// extensions the rules use are required.
export function renderSieve(filters) {
  const requires = new Set();
  const blocks = [];
  for (const f of filters) {
    if (!f.enabled) continue;
    const rules = normalizeRules(f.rules);
    const tests = rules.match.map(renderSieveTest);
    if (rules.match.some((m) => m.header === 'body')) requires.add('body');
    if (rules.actions.some((a) => a.type === 'fileinto')) { requires.add('fileinto'); requires.add('mailbox'); }
    const name = FILTER_NAME.test(f.name || '') ? f.name : 'filter';
    const condition = tests.length === 1 ? tests[0] : `${rules.matchAll ? 'allof' : 'anyof'} (${tests.join(', ')})`;
    blocks.push(`# ${name}`, `if ${condition} {`, ...rules.actions.map((a) => `  ${renderSieveAction(a)}`), '}');
  }
  const lines = [SIEVE_HEADER];
  if (requires.size) lines.push(`require [${[...requires].map((r) => `"${r}"`).join(', ')}];`);
  if (blocks.length) lines.push('', ...blocks);
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
  // A domain the customer explicitly routed 'remote' is never flipped back
  // behind their back: the mailbox is refused until the routing page says local.
  async function routeLocally(domain, warnings, req) {
    if (typeof ctx.mail?.setRouting !== 'function') return;
    const current = stmts.mailDomain.get(domain);
    if (current?.routing === 'local') return;
    if (current?.routing === 'remote') throw new HttpError(409, 'routing_remote', `Mail for ${domain} is routed to another mail server; switch its email routing to local or automatic before creating mailboxes`);
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

  // What a mailbox password must satisfy, so the forms show the server's rule:
  // the route's length floor (fields.password) and Security Center's effective
  // minimum for the `email` context (security.password.strength.email, else
  // security.min_password_strength).
  function passwordPolicy() {
    const fn = ctx.security?.passwordStrength;
    const minStrength = typeof fn === 'function' ? Number(fn('', 'email')?.minimum) || 0 : 0;
    return { context: 'email', minLength: PASSWORD_MIN_LENGTH, minStrength };
  }

  // The service certificate the mail daemons present, so the Connect sheet can
  // name what a mail app will see; one agent read per minute at most.
  let serviceCertMemo = { at: 0, value: null };
  async function mailCertificate(host) {
    if (typeof ctx.ssl?.serviceCertStatus !== 'function') return null;
    if (!serviceCertMemo.value || Date.now() - serviceCertMemo.at > 60_000) {
      let rows = [];
      try { rows = await ctx.ssl.serviceCertStatus(); } catch (err) { logger.debug({ err }, 'panel-email: service certificate status unavailable'); }
      serviceCertMemo = { at: Date.now(), value: rows };
    }
    const pick = (service) => serviceCertMemo.value.find((r) => r.service === service);
    const shape = (r) => (r?.hasCertificate && r.certificate ? { name: r.certificate.commonName ?? null, sans: r.certificate.sans ?? [], issuer: r.certificate.issuerOrganization ?? r.certificate.issuerCommonName ?? null, selfSigned: Boolean(r.certificate.selfSigned), notAfter: r.certificate.notAfter ?? null, matchesHostname: [r.certificate.commonName, ...(r.certificate.sans || [])].filter(Boolean).includes(host) } : null);
    return { dovecot: shape(pick('dovecot')), exim: shape(pick('exim')) };
  }

  // Mirrors what Exim Configuration Manager renders into daemon_smtp_ports:
  // without the submission ports only 25 with STARTTLS listens, 465 exists only
  // with the Exim TLS preset, and SMTP AUTH only once the virtual-mail wiring
  // is live.
  function smtpSettings(host) {
    const ex = ctx.web?.exim?.settings?.() || {};
    const auth = virtualMailLive() ? 'password' : null;
    const ports = (enabled, tls) => ({ enabled, port465: enabled && tls, port587: enabled });
    if (!ex.submissionPorts) return { host, port: 25, ssl: false, starttls: true, alternative: null, auth, submissionPorts: false, ports: ports(false, false) };
    if (!ex.tls) return { host, port: 587, ssl: false, starttls: true, alternative: null, auth, submissionPorts: true, ports: ports(true, false) };
    return { host, port: 465, ssl: true, alternative: { port: 587, starttls: true }, auth, submissionPorts: true, ports: ports(true, true) };
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
      // The wiring warning also matters before the first mailbox exists: the
      // empty state tells the customer what a new mailbox will and will not do.
      const warnings = [];
      virtualMailWarning(warnings);
      return { data, meta: { ...page.meta, limits: { max_email: limit }, used: stmts.mailboxCount.get(scope.accountId).n, domains: domainNames(scope), defaultQuotaMb: Number(settings.get('panel.mail.default_quota_mb') ?? 1024), passwordPolicy: passwordPolicy(), warnings } };
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
      if (mailDomain.routing === 'remote') throw new HttpError(409, 'routing_remote', `Mail for ${d.domain} is routed to another mail server; switch its email routing to local or automatic before creating mailboxes`);
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
      virtualMailWarning(warnings, { request: true });
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

    async clientSettings(scope, id) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      const ms = ctx.web?.mailserver?.settings?.() || {};
      const protocols = Array.isArray(ms.protocols) ? ms.protocols : ['imap', 'pop3'];
      const host = hostname();
      const tls = ms.ssl !== 'no';
      const plainAllowed = ms.ssl === 'no' || ms.disablePlaintextAuth === false;
      const srv = (securePort, plainPort) => ({ host, port: securePort, ssl: true, alternative: tls ? { port: plainPort, starttls: true, plainAllowed } : { port: plainPort, starttls: false, plainAllowed: true } });
      const warnings = [];
      virtualMailWarning(warnings);
      return {
        address: `${row.local_part}@${row.domain}`, username: `${row.local_part}@${row.domain}`, hostname: host,
        imap: protocols.includes('imap') ? srv(993, 143) : null,
        pop3: protocols.includes('pop3') ? srv(995, 110) : null,
        smtp: smtpSettings(host),
        certificate: await mailCertificate(host),
        virtualMailLive: virtualMailLive(),
        warnings,
        passwordPolicy: passwordPolicy(),
        webmail: await webmailUrl().catch(() => null),
        webmailSso: await detectWebmail().then((d) => ssoAvailable(d, webmailUrlFrom(d))).catch(() => false),
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

  // -------------------------------------------------------------- filters ---

  // Sieve filters per mailbox (personal script) and per account (sieve_before).
  // Host first: the whole script of the scope is re-rendered from the rows as
  // they would be after the change and handed to vmail.sieve.write (compiled
  // as the account before activation); the rows change only when that
  // succeeded. An empty scope removes the script instead.
  const fstmts = {
    list: db.prepare('SELECT * FROM panel_mail_filters WHERE account_id = ? AND scope = ? AND mailbox_id IS ? ORDER BY position, id'),
    get: db.prepare('SELECT * FROM panel_mail_filters WHERE id = ? AND account_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM panel_mail_filters WHERE account_id = ? AND scope = ? AND mailbox_id IS ?'),
    insert: db.prepare('INSERT INTO panel_mail_filters (account_id, scope, mailbox_id, name, position, rules_json, enabled) VALUES (@account_id, @scope, @mailbox_id, @name, @position, @rules_json, @enabled)'),
    update: db.prepare("UPDATE panel_mail_filters SET name = @name, rules_json = @rules_json, enabled = @enabled, updated_at = datetime('now') WHERE id = @id AND account_id = @account_id"),
    setPosition: db.prepare("UPDATE panel_mail_filters SET position = ?, updated_at = datetime('now') WHERE id = ? AND account_id = ?"),
    remove: db.prepare('DELETE FROM panel_mail_filters WHERE id = ? AND account_id = ?'),
  };
  const maxFilters = () => Number(settings.get('panel.mail.max_filters_per_scope') ?? 100);
  const shapeFilter = (r) => ({ id: r.id, scope: r.scope, mailboxId: r.mailbox_id, name: r.name, position: r.position, enabled: Boolean(r.enabled), rules: json.parse(r.rules_json, { matchAll: true, match: [], actions: [] }), createdAt: r.created_at, updatedAt: r.updated_at });
  const sieveAvailable = () => capabilities.has('dovecot') && capabilities.has('sieve');

  // The script a request addresses: one of the account's mailboxes, or the
  // account itself. A foreign or unknown mailbox id is "not found" (§3.2).
  function filterTarget(scope, mailboxId) {
    if (mailboxId == null) return { scope: 'account', mailboxId: null, address: null };
    const row = loadMailbox(scope, mailboxId);
    return { scope: 'mailbox', mailboxId: row.id, address: `${row.local_part}@${row.domain}` };
  }
  const filterRows = (scope, target) => fstmts.list.all(scope.accountId, target.scope, target.mailboxId);
  const opTarget = (scope, target) => ({ username: scope.username, scope: target.scope, ...(target.address ? { mailbox: target.address } : {}) });

  // A row reached by id must belong to the route's scope family and, for a
  // mailbox, to a mailbox the account still owns.
  function loadFilter(scope, id, expectedScope) {
    const row = fstmts.get.get(id, scope.accountId);
    if (!row || row.scope !== expectedScope) throw notFound('Filter');
    return { row, target: filterTarget(scope, row.mailbox_id) };
  }

  async function applyFilters(scope, target, rows, req) {
    capabilities.require('dovecot', 'Dovecot is not installed on this server, so mail filters cannot be applied yet');
    const args = opTarget(scope, target);
    try {
      if (!rows.length) return { ...(await op('vmail.sieve.remove', args, req, 'sieve')), script: null };
      const script = renderSieve(rows.map(shapeFilter));
      return { ...(await op('vmail.sieve.write', { ...args, script }, req, 'sieve')), script };
    } catch (err) {
      if (err?.code === 'invalid_sieve') throw new HttpError(422, 'sieve_compile_failed', err.message, { rules: (err.details?.errors || []).map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)) });
      throw err;
    }
  }

  const filterAudit = (req, scope, action, target, row, extra = {}) => audit(req, scope, action, { scope: target.scope, mailbox: target.address, name: row?.name ?? null, id: row?.id ?? null, ...extra });

  const filters = {
    target: filterTarget,

    list(scope, mailboxId = null) {
      assertFeature(scope, 'emailfilters');
      const target = filterTarget(scope, mailboxId);
      const data = filterRows(scope, target).map(shapeFilter);
      return {
        data,
        meta: {
          scope: target.scope, mailbox: target.address ? { id: target.mailboxId, address: target.address } : null,
          max: maxFilters(), folders: FILTER_DEFAULT_FOLDERS, headers: FILTER_HEADERS, ops: FILTER_OPS, actions: FILTER_ACTION_TYPES,
          sieve: { available: sieveAvailable(), dovecot: capabilities.has('dovecot'), sievec: capabilities.has('sieve') },
          script: renderSieve(data),
        },
      };
    },

    async create(scope, mailboxId, input, req) {
      assertFeature(scope, 'emailfilters');
      const target = filterTarget(scope, mailboxId);
      const rules = normalizeRules(input.rules);
      const rows = filterRows(scope, target);
      const max = maxFilters();
      if (rows.length >= max) throw new HttpError(409, 'limit_reached', `At most ${max} filters per ${target.scope === 'account' ? 'account' : 'mailbox'}`);
      const row = { account_id: scope.accountId, scope: target.scope, mailbox_id: target.mailboxId, name: input.name, position: rows.reduce((m, r) => Math.max(m, r.position), 0) + 1, rules_json: JSON.stringify(rules), enabled: input.enabled === false ? 0 : 1 };
      const applied = await applyFilters(scope, target, [...rows, row], req);
      const id = Number(fstmts.insert.run(row).lastInsertRowid);
      filterAudit(req, scope, 'panel.email.filter.create', target, { ...row, id }, { enabled: Boolean(row.enabled) });
      return { data: shapeFilter(fstmts.get.get(id, scope.accountId)), meta: { activated: applied.activated ?? null, warnings: applied.warnings ?? [] } };
    },

    async update(scope, id, input, req, expectedScope = 'mailbox') {
      assertFeature(scope, 'emailfilters');
      const { row: current, target } = loadFilter(scope, id, expectedScope);
      const next = { ...current, name: input.name ?? current.name, rules_json: input.rules === undefined ? current.rules_json : JSON.stringify(normalizeRules(input.rules)), enabled: input.enabled === undefined ? current.enabled : (input.enabled ? 1 : 0) };
      const rows = filterRows(scope, target).map((r) => (r.id === current.id ? next : r));
      const applied = await applyFilters(scope, target, rows, req);
      fstmts.update.run({ ...next, account_id: scope.accountId });
      filterAudit(req, scope, 'panel.email.filter.update', target, next, { enabled: Boolean(next.enabled) });
      return { data: shapeFilter(fstmts.get.get(id, scope.accountId)), meta: { activated: applied.activated ?? null, warnings: applied.warnings ?? [] } };
    },

    async remove(scope, id, req, expectedScope = 'mailbox') {
      assertFeature(scope, 'emailfilters');
      const { row, target } = loadFilter(scope, id, expectedScope);
      await applyFilters(scope, target, filterRows(scope, target).filter((r) => r.id !== row.id), req);
      fstmts.remove.run(row.id, scope.accountId);
      filterAudit(req, scope, 'panel.email.filter.delete', target, row);
      return { id: row.id, removed: true };
    },

    // The new order is the complete list of the scope's filter ids.
    async reorder(scope, mailboxId, { ids }, req) {
      assertFeature(scope, 'emailfilters');
      const target = filterTarget(scope, mailboxId);
      const rows = filterRows(scope, target);
      const have = rows.map((r) => r.id).sort((a, b) => a - b);
      const want = [...ids].sort((a, b) => a - b);
      if (have.length !== want.length || have.some((v, i) => v !== want[i])) throw unprocessable('The order must list every filter of this scope exactly once', { ids: ['Must contain every filter id exactly once'] });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id, i) => ({ ...byId.get(id), position: i + 1 }));
      await applyFilters(scope, target, ordered, req);
      db.transaction(() => { for (const r of ordered) fstmts.setPosition.run(r.position, r.id, scope.accountId); })();
      filterAudit(req, scope, 'panel.email.filter.reorder', target, null, { ids });
      return filterRows(scope, target).map(shapeFilter);
    },

    // The "Test" button: compile one filter's script (sievec -d) without touching the live one.
    async test(scope, mailboxId, input, req) {
      assertFeature(scope, 'emailfilters');
      const target = filterTarget(scope, mailboxId);
      capabilities.require('dovecot', 'Dovecot is not installed on this server, so mail filters cannot be compiled yet');
      const script = renderSieve([{ name: input.name ?? 'test', enabled: true, rules: normalizeRules(input.rules) }]);
      const r = await op('vmail.sieve.test', { ...opTarget(scope, target), script }, req, 'sieve');
      return { ok: Boolean(r.ok), errors: r.errors ?? [], warnings: r.warnings ?? [], script };
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

  // Whether saved spam settings take effect on this host (ctx.web.spamScanning:
  // content-scanning Exim build + running spamd); without service-configuration
  // only the SpamAssassin binary is known.
  async function spamAvailability({ fresh = false } = {}) {
    if (typeof ctx.web?.spamScanning === 'function') {
      try { return await ctx.web.spamScanning({ fresh }); } catch (err) { logger.debug({ err }, 'panel-email: spam scanning status unavailable'); }
    }
    const installed = capabilities.has('spamassassin');
    return { available: installed, reason: installed ? null : 'spamd_missing', detail: installed ? null : 'SpamAssassin is not installed on this server, so incoming mail is not scored.', exim: null, spamd: { installed, active: null, unit: null } };
  }

  // Seam for the Security Advisor (security-center): the host state plus how
  // many accounts have saved settings that depend on it.
  async function spamStatus() {
    const st = await spamAvailability();
    return { ...st, configuredAccounts: stmts.spamAll.all().length };
  }

  const spam = {
    async get(scope) {
      assertFeature(scope, 'spamassassin');
      const st = await spamAvailability();
      return { ...shapeSpam(stmts.spam.get(scope.accountId)), available: st.available, reason: st.reason, detail: st.detail, exim: st.exim, spamd: st.spamd };
    },

    async set(scope, input, req) {
      assertFeature(scope, 'spamassassin');
      capabilities.require('spamassassin', 'SpamAssassin is not installed on this server, so spam settings cannot be applied yet');
      // Settings that cannot take effect are refused rather than stored as if
      // they filtered anything: a missing build is an install prompt (501), a
      // stopped daemon an operator action (422).
      const st = await spamAvailability({ fresh: true });
      if (!st.available) {
        if (st.reason === 'spamd_not_running') throw new HttpError(422, 'spamd_not_running', st.detail);
        throw new CapabilityError(st.reason === 'spamd_missing' ? 'spamassassin' : 'exim', st.detail);
      }
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

  // Public DNS may be delegated elsewhere (ctx.panelDns.delegation): the
  // records are then handed back to copy instead of written into BIND, which
  // nobody would read. `records` names where each suggested record goes.
  const delegationOf = async (domain) => (typeof ctx.panelDns?.delegationOrNull === 'function' ? ctx.panelDns.delegationOrNull(domain) : null);
  const RECORD_NAMES = { spf: (domain) => domain, dkim: (domain, item) => `${item.selector || 'default'}._domainkey.${domain}`, dmarc: (domain) => `_dmarc.${domain}` };
  const copyRecords = (status) => (status?.items || [])
    .filter((i) => RECORD_NAMES[i.id] && i.expected)
    .map((i) => ({ id: i.id, name: RECORD_NAMES[i.id](status.domain, i), type: 'TXT', value: i.expected, status: i.status }));
  const withDelegation = (status, delegation) => ({ ...status, delegation, records: copyRecords(status) });

  // ------------------------------------------------------------- routing ---

  // Per-domain mail routing (P1-4): 'auto'/'local' deliver here, 'remote' lets
  // Exim look the MX up like any outside domain. The public MX is read through
  // the Email category's resolver (ctx.mail.mxStatus) and the delegation
  // banner tells the customer where that MX record is edited.
  const ROUTING_VALUES = ['auto', 'local', 'remote'];
  const mailboxesOfDomain = db.prepare('SELECT COUNT(*) AS n FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE md.domain = ? AND md.account_id = ?');
  const mxStatusOf = async (domain) => {
    if (typeof ctx.mail?.mxStatus !== 'function') return null;
    try { return await ctx.mail.mxStatus(domain); } catch (err) { return { ok: false, error: err.message, records: [], pointsHere: null }; }
  };
  async function routingRow(scope, d) {
    const row = stmts.mailDomain.get(d.domain);
    const routing = row && row.account_id === scope.accountId ? (ROUTING_VALUES.includes(row.routing) ? row.routing : 'auto') : 'auto';
    const [mx, delegation] = await Promise.all([mxStatusOf(d.domain), delegationOf(d.domain)]);
    const mailboxes = mailboxesOfDomain.get(d.domain, scope.accountId).n;
    const effective = routing === 'remote' ? 'remote' : 'local';
    const hints = [];
    if (mx?.pointsHere === false && effective === 'local') hints.push(`The MX records of ${d.domain} point at another server (${mx.exchanges?.join(', ') || 'unresolved'}), so mail from the internet does not arrive here; fix the MX record or set the routing to remote.`);
    if (mx?.pointsHere === true && effective === 'remote') hints.push(`The MX records of ${d.domain} point at this server while the routing is remote: mail sent from here is handed to this same server and bounces.`);
    return { domain: d.domain, type: d.type, routing, effective, mailboxes, canRemote: mailboxes === 0, mx, delegation, hints };
  }
  const routing = {
    async list(scope) {
      const rows = await Promise.all(domainsOf(scope).map((d) => routingRow(scope, d)));
      return { data: rows, meta: { hostname: hostname(), values: ROUTING_VALUES } };
    },
    async get(scope, domain) {
      return routingRow(scope, assertDomain(scope, domain));
    },
    async set(scope, domain, { routing: wanted }, req) {
      const d = assertDomain(scope, domain);
      if (!ROUTING_VALUES.includes(wanted)) throw unprocessable('routing must be auto, local or remote', { routing: ['auto, local or remote'] });
      const mailboxes = mailboxesOfDomain.get(d.domain, scope.accountId).n;
      if (wanted === 'remote' && mailboxes > 0) throw new HttpError(409, 'mailboxes_exist', `${d.domain} has ${mailboxes} mailbox${mailboxes === 1 ? '' : 'es'} on this server; delete them before routing its mail elsewhere`);
      ensureMailDomain(scope, d.domain, req);
      let result = { applied: null, reason: 'the Email category is not loaded', hint: null };
      if (typeof ctx.mail?.setRouting === 'function') {
        try {
          const r = await ctx.mail.setRouting(d.domain, wanted, req);
          result = { applied: Boolean(r?.applied), reason: r?.reason ?? null, hint: r?.hint ?? null };
        } catch (err) {
          if (err.code !== 'routing_not_applied') throw err;
          result = { applied: false, reason: err.reason || err.message, hint: err.hint ?? null };
        }
      }
      audit(req, scope, 'panel.email.routing.set', { domain: d.domain, routing: wanted, applied: result.applied });
      return { ...(await routingRow(scope, d)), ...result };
    },
  };

  const deliverability = {
    async check(scope, domain) {
      const d = assertDomain(scope, domain);
      const [status, delegation] = await Promise.all([requireMail().deliverability.check(d.domain, scope.ownerPrincipal), delegationOf(d.domain)]);
      return withDelegation(status, delegation);
    },
    async fix(scope, domain, { items }, req) {
      const d = assertDomain(scope, domain);
      if (!stmts.zoneOwned.get(d.domain, scope.accountId)) throw notFound(`DNS zone for "${d.domain}"`);
      const delegation = await delegationOf(d.domain);
      if (delegation?.delegatedHere === false) {
        const status = withDelegation(await requireMail().deliverability.check(d.domain, scope.ownerPrincipal), delegation);
        const results = Object.fromEntries(items.map((item) => {
          const record = status.records.find((r) => r.id === item) || null;
          if (record) return [item, { ok: true, applied: false, reason: 'not_delegated', record }];
          return [item, { ok: false, error: item === 'dkim' ? 'Generate the DKIM key first; its record then appears here to copy' : `No ${item.toUpperCase()} record could be suggested` }];
        }));
        audit(req, scope, 'panel.email.deliverability.fix', { domain: d.domain, items, delegatedHere: false, written: false });
        return { domain: d.domain, applied: false, reason: 'not_delegated', delegation, records: status.records, results, status };
      }
      const result = await requireMail().deliverability.fix(d.domain, items, scope.ownerPrincipal, req);
      audit(req, scope, 'panel.email.deliverability.fix', { domain: d.domain, items, delegatedHere: delegation?.delegatedHere ?? null });
      return { ...result, applied: true, delegation, status: withDelegation(result.status, delegation) };
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

  // The operator's panel.webmail_url wins; otherwise the alias the agent found
  // (the Keel drop-in under the hostname site, or a distro fragment) under the
  // FQDN hostname the site and its certificate carry. Invalidated after a
  // publish/unpublish by the next detection (60 s) at most.
  function webmailUrlFrom(detected) {
    const configured = String(settings.get('panel.webmail_url') || '').trim();
    if (configured) return { url: configured, configuredUrl: configured, alias: null, published: false };
    const alias = detected.published?.alias ?? detected.apacheAlias ?? null;
    const host = ctx.web?.hostname?.hostname?.() || hostname();
    const url = detected.installed && alias ? `https://${host}${alias.replace(/\/?$/, '/')}` : null;
    return { url, configuredUrl: null, alias, published: Boolean(url) };
  }

  // The panel home's quick link: the same URL the Webmail page shows, with no scope needed.
  async function webmailUrl() {
    return webmailUrlFrom(await detectWebmail()).url;
  }

  // Single sign-on (contract §44) is offered only for the Roundcube the panel
  // published itself (the Keel plugin lives there; an operator-configured
  // Webmail URL is another installation) and once root switched it on.
  function ssoAvailable(detected, urlInfo) {
    const sso = ctx.web?.webmail?.sso;
    return Boolean(sso?.enabled?.() && detected.flavor === 'roundcube' && urlInfo.published && !urlInfo.configuredUrl && settings.get('panel.webmail.master_enc'));
  }

  async function webmail(scope, query = {}) {
    const detected = await detectWebmail();
    const { url, configuredUrl: configured, alias, published } = webmailUrlFrom(detected);
    let prefillUser = null;
    if (query.user) {
      const { localPart, domain } = splitAddress(query.user);
      const d = domainsOf(scope).find((x) => x.domain === domain);
      if (d && stmts.mailboxByAddress.get(domain, localPart, scope.accountId)) prefillUser = `${localPart}@${domain}`;
    }
    if (!prefillUser) { const first = stmts.mailboxesOf.get(scope.accountId); prefillUser = first ? `${first.local_part}@${first.domain}` : null; }
    return { installed: Boolean(detected.installed), flavor: detected.flavor ?? null, version: detected.version ?? null, url, configuredUrl: configured || null, alias, published, prefillUser, hostname: hostname(), sso: ssoAvailable(detected, { published, configuredUrl: configured }) };
  }

  // POST /email/webmail/sso: a 60 s single-use token for one of the account's
  // mailboxes, handed to Roundcube as ?_keel=. Refused while an administrator
  // acts as the account unless panel.login_as_webmail allows it (the mailbox's
  // contents are the customer's, not the operator's).
  async function webmailSso(scope, { mailbox }, req) {
    assertFeature(scope, 'emailaccts');
    if (scope.mode === 'acting' && !ctx.web?.webmail?.sso?.loginAs?.()) throw new HttpError(403, 'not_while_impersonating', 'Opening a mailbox is not available while logged in as the account');
    const { localPart, domain } = splitAddress(mailbox);
    const owned = domainsOf(scope).find((x) => x.domain === domain) && stmts.mailboxByAddress.get(domain, localPart, scope.accountId);
    const row = owned ? stmts.mailbox.get(owned.id, scope.accountId) : null;
    if (!row) throw notFound('Mailbox');
    if (row.suspended) throw conflict(`The mailbox ${localPart}@${domain} is suspended`);
    const detected = await detectWebmail();
    const urlInfo = webmailUrlFrom(detected);
    if (!ssoAvailable(detected, urlInfo)) throw conflict('Webmail single sign-on is not available on this server');
    if (!ctx.panelSso) throw conflict('Webmail single sign-on is not available on this server');
    const address = `${localPart}@${domain}`;
    const { token, expiresAt } = ctx.panelSso.issue({ kind: 'webmail', userId: scope.actor?.id ?? null, account: scope.username, payload: { mailbox: address } });
    audit(req, scope, 'panel.email.webmail.sso', { mailbox: address, expiresAt });
    return { url: `${urlInfo.url}?_keel=${token}`, mailbox: address, expiresAt };
  }

  // The loopback exchange (GET /api/panel/sso/webmail/:token): the master
  // credential leaves the server only through this handler, to a process on
  // this host that holds a fresh token.
  function registerSso() {
    ctx.panelSso?.register('webmail', (claim) => {
      const mailbox = String(claim.payload?.mailbox || '');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9.-]+$/.test(mailbox)) throw notFound('Mailbox');
      const sso = ctx.web?.webmail?.sso;
      if (!sso) throw conflict('Webmail single sign-on is not available on this server');
      const c = sso.credentials();
      return { user: `${mailbox}*${c.user}`, password: c.password, host: c.host, mailbox };
    });
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

  // The report rows that belong to this account: a domain of its own on
  // either side, or a message its mailbox authenticated.
  function accountRows(scope, report) {
    const domains = new Set(domainNames(scope));
    const mailboxSet = new Set(stmts.mailboxesOf.all(scope.accountId).map((r) => `${r.local_part}@${r.domain}`));
    return report.data.filter((r) => domains.has(domainOf(r.sender)) || domains.has(domainOf(r.recipient)) || mailboxSet.has(String(r.authUser || '').toLowerCase()));
  }

  // P1-12: the delivery log as a paginated, filterable list. The mail
  // category's report is post-filtered to the account (it cannot be asked for
  // "these domains only"), then searched and paged here.
  const shapeMessage = (r) => ({ id: r.id, key: r.key ?? r.id, arrivedAt: r.arrivedAt, sender: r.sender, recipient: r.recipient, status: r.status, subject: r.subject ?? null, size: r.size ?? null, detail: r.detail ?? null, deliveredAt: r.deliveredAt ?? null, remoteHost: r.remoteHost ?? null });
  async function usageMessages(scope, { sinceHours = 24, q = '', status = null, page = 1, pageSize = 25 } = {}) {
    assertFeature(scope, 'emailaccts');
    const mail = requireMail();
    const report = await mail.reports.delivery({ hours: sinceHours, page: 1, pageSize: 20_000 });
    let rows = accountRows(scope, report);
    if (status) rows = rows.filter((r) => r.status === status);
    const needle = String(q || '').trim().toLowerCase();
    if (needle) rows = rows.filter((r) => [r.sender, r.recipient, r.subject, r.detail, r.id].some((v) => String(v || '').toLowerCase().includes(needle)));
    const total = rows.length;
    const start = (page - 1) * pageSize;
    return {
      data: rows.slice(start, start + pageSize).map(shapeMessage),
      meta: { page, pageSize, total, hours: sinceHours, q: needle || null, status: status || null, log: { from: report.meta?.logFrom ?? null, truncated: Boolean(report.meta?.logTruncated), exists: report.meta?.logExists ?? null } },
    };
  }

  // Folders of one mailbox through doveadm (vmail.mailbox.status); the
  // per-folder size is what Dovecot indexes (vsize), the quota line is the
  // same figure the account list shows.
  const folders = {
    async list(scope, id) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      capabilities.require('dovecot', 'Dovecot is not installed on this server, so mailbox folders cannot be read');
      const address = `${row.local_part}@${row.domain}`;
      const r = await agent().op('vmail.mailbox.status', { user: address });
      const data = (r.folders || []).map((f) => ({ name: f.name, messages: f.messages ?? null, bytes: f.bytes ?? null, unseen: f.unseen ?? null, emptiable: EMPTIABLE_FOLDERS.includes(f.name) }));
      return { data, meta: { mailbox: { id: row.id, address }, usage: await mailboxUsage(scope, row), minOlderThanDays: EXPUNGE_MIN_DAYS } };
    },

    // Trash and Junk may be emptied outright; any other folder only loses
    // mail older than olderThanDays (>= EXPUNGE_MIN_DAYS). The agent enforces
    // the same rule; the message here is the customer-facing one.
    async empty(scope, id, folder, { olderThanDays = null } = {}, req) {
      assertFeature(scope, 'emailaccts');
      const row = loadMailbox(scope, id);
      capabilities.require('dovecot', 'Dovecot is not installed on this server, so mailbox folders cannot be emptied');
      if (olderThanDays == null && !EMPTIABLE_FOLDERS.includes(folder)) throw unprocessable(`Only ${EMPTIABLE_FOLDERS.join(' and ')} can be emptied outright`, { olderThanDays: [`Give an age in days (at least ${EXPUNGE_MIN_DAYS}) to delete old messages from "${folder}"`] });
      const address = `${row.local_part}@${row.domain}`;
      const r = await agent().op('vmail.mailbox.expunge', { user: address, folder, ...(olderThanDays != null ? { olderThanDays } : {}) }, { req });
      audit(req, scope, 'panel.email.folder.empty', { mailbox: address, folder, olderThanDays: olderThanDays ?? null, before: r.before ?? null, after: r.after ?? null, removed: r.removed ?? null });
      return { mailbox: { id: row.id, address }, folder, olderThanDays: olderThanDays ?? null, before: r.before ?? null, after: r.after ?? null, removed: r.removed ?? null };
    },
  };

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
  // server-wide root-level rewrite of Exim/Dovecot. It runs as the panel from
  // the VIRTUAL_MAIL_JOB (queued at boot by the route module and again by a
  // mailbox mutation that finds the wiring not live) and from the admin route,
  // never inside a customer request: there is no request principal, the audit
  // row names the panel, and every outcome is memoised with a backoff so a
  // broken host is not re-applied in a loop.
  const APPLY_RETRY_MS = 10 * 60_000;
  const VIRTUAL_MAIL_JOB = 'panel.virtual_mail.ensure';
  let virtualMailApplied = null;
  let virtualMailFailure = null;
  async function ensureVirtualMail(_req = null, { force = false } = {}) {
    if (virtualMailApplied && !force && (virtualMailApplied.live !== false || Date.now() - virtualMailApplied.at < APPLY_RETRY_MS)) return virtualMailApplied;
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
      virtualMailApplied = { applied: true, ...(r || {}), at: Date.now() };
      if (virtualMailApplied.live === false) logger.warn({ error: virtualMailApplied.lastApply?.error ?? null, manualIncludes: virtualMailApplied.manualIncludes ?? null }, 'panel-email: virtual mail is written but not live; panel mailboxes are not served yet');
      return virtualMailApplied;
    } catch (err) {
      logger.warn({ err }, 'panel-email: applyVirtualMail failed');
      return fail(err.message);
    }
  }

  // Whether Exim and Dovecot serve the panel's mailboxes, from the persisted
  // outcome of the last apply (shared with the admin route) or this process's
  // memo; never from a host probe on the request path.
  const virtualMailLive = () => {
    if (virtualMailDisabledByOperator()) return false;
    const last = ctx.web?.virtualMail?.lastApplied?.();
    if (last) return last.ok === true;
    return virtualMailApplied?.live === true;
  };

  function virtualMailWarning(warnings, { request = false } = {}) {
    if (virtualMailDisabledByOperator()) { warnings.push({ code: 'virtual_mail_disabled', message: 'Virtual mailboxes are switched off under Service Configuration; the mailbox is saved but Exim/Dovecot do not serve it until the operator enables them' }); return; }
    if (virtualMailLive()) return;
    warnings.push({ code: 'virtual_mail_not_live', message: 'Exim/Dovecot are not yet wired for virtual mailboxes; the mailbox is saved but mail is not delivered or authenticated until the operator applies the virtual-mail configuration under Service Configuration' });
    if (request) requestVirtualMail();
  }

  // Queues the root-level apply as a panel job instead of running it here: the
  // worker has no customer principal and the memo above throttles retries.
  // Nothing is queued on a host without the panel or without both daemons, or
  // while a queued/running apply exists, so a mail-less host never accumulates
  // a job row per restart.
  function requestVirtualMail(trigger = 'mailbox') {
    const jobs = ctx.jobs;
    if (!jobs?.types?.().includes(VIRTUAL_MAIL_JOB)) return null;
    if (!settings.get('panel.enabled') || !capabilities.has('exim') || !capabilities.has('dovecot')) return null;
    if (virtualMailFailure && Date.now() - virtualMailFailure.at < APPLY_RETRY_MS) return null;
    if (virtualMailApplied?.live === false && Date.now() - virtualMailApplied.at < APPLY_RETRY_MS) return null;
    if (jobs.list({ type: VIRTUAL_MAIL_JOB, limit: 5 }).some((j) => j.status === 'queued' || j.status === 'running')) return null;
    try { return jobs.enqueue(VIRTUAL_MAIL_JOB, { trigger }); } catch (err) { logger.warn({ err }, 'panel-email: could not queue the virtual-mail apply'); return null; }
  }

  async function renderCheck() {
    try { return await agent().op('vmail.render.check', {}); } catch (err) { return { error: err.message, dovecot: { installed: false }, exim: { installed: false }, routerHooked: false, authHooked: false, transportHooked: false }; }
  }

  // Security Advisor findings for the virtual-mail wiring (seam S4), called
  // from security-center's advisor.scan.
  async function advisorFindings() {
    if (!settings.get('panel.enabled')) return [];
    const r = await renderCheck();
    const fix = { label: 'Exim Configuration Manager', path: '/service-configuration/exim-configuration-manager' };
    const findings = [];
    if (r.error) return [{ id: 'panel.mail.check', grade: 'info', title: 'Could not check the virtual-mail configuration', detail: r.error }];
    if (!r.exim?.installed || !r.dovecot?.installed) return [{ id: 'panel.mail.daemons', grade: 'info', title: 'Virtual mailboxes need Exim and Dovecot', detail: r.hint || 'Install both to let account users create mailboxes.' }];
    if (r.exim.configOk === false) findings.push({ id: 'panel.mail.exim', grade: 'critical', title: 'Exim rejects its configuration', detail: r.exim.output || 'exim -bV failed', fix });
    if (r.dovecot.configOk === false) findings.push({ id: 'panel.mail.dovecot', grade: 'critical', title: 'Dovecot rejects its configuration', detail: r.dovecot.output || 'doveconf -n failed', fix: { label: 'Mailserver Configuration', path: '/service-configuration/mailserver-configuration' } });
    if (r.exim.configOk !== false) {
      const last = ctx.web?.virtualMail?.lastApplied?.() ?? null;
      const applied = last ? ` The last apply (${last.at}) ${last.ok ? 'succeeded' : `was not live: ${last.error || 'see Service Configuration'}`}.` : ' The virtual-mail configuration was never applied on this server.';
      findings.push(r.routerHooked
        ? { id: 'panel.mail.router', grade: 'ok', title: 'Exim delivers to virtual mailboxes (whm_virtual_user router present)' }
        : { id: 'panel.mail.router', grade: 'warning', title: 'Exim has no virtual-mailbox router', detail: `Mail for panel-created mailboxes is not delivered until the whm_virtual_user router and whm_dovecot_lmtp transport are loaded.${applied}${r.hint ? ` ${r.hint}.` : ''}`, fix });
      findings.push(r.authHooked
        ? { id: 'panel.mail.auth', grade: 'ok', title: 'SMTP authentication uses Dovecot (dovecot_plain authenticator present)' }
        : { id: 'panel.mail.auth', grade: 'warning', title: 'Exim has no Dovecot authenticator', detail: `Mailbox users cannot authenticate to send mail until the dovecot_plain/dovecot_login authenticators are loaded.${applied}`, fix });
      if (r.routerHooked && r.authHooked && !ctx.web?.exim?.settings?.()?.submissionPorts) findings.push({ id: 'panel.mail.submission', grade: 'info', title: 'SMTP submission ports 465/587 are not enabled', detail: 'Mail clients can only submit through port 25 with STARTTLS; enable the submission ports under Exim Configuration Manager.', fix });
    }
    return findings;
  }

  return {
    LOCAL_PART, SYSTEM_ROOT,
    domainsOf, assertDomain, assertDomainClean, ensureMailDomain, releaseDomain, subscribe,
    accounts, forwarders, defaultAddress, domainForward, autoresponders, filters, spam, routing, deliverability, dkim, webmail, webmailUrl, webmailSso, registerSso, usage, usageMessages, folders,
    ensureVirtualMail, renderCheck, advisorFindings, virtualMailLive, requestVirtualMail, VIRTUAL_MAIL_JOB, spamStatus, passwordPolicy,
  };
}
