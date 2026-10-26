import dns from 'node:dns';
import net from 'node:net';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, forbidden, unprocessable, CapabilityError, HttpError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Email category. Attached as ctx.mail; other categories may call:
//   mail.sendNotification({ to, subject, text, from? }, req)   -> hands a message to Exim (throws CapabilityError without Exim)
//   mail.installDkimKey(domain, { selector, privateKeyPem }, req) / mail.removeDkimKey(domain, req)
//   mail.setRouting(domain, 'local'|'remote'|'backup'|'auto', req) -> mail_domains + Exim domain lists. Resolves { applied: true } only
//       when exim -bP confirms its local_domains/relay_to_domains read the lists; without Exim it resolves { applied: false, reason };
//       with Exim present but not reading them it saves the routing and throws routing_not_applied (409) carrying { hint }.
//   mail.setOutboundAddresses({ ipv4, ipv6 }, req)             -> Exim remote_smtp source interface (ip-functions "Configure Remote
//       Service IPs" hook). Resolves { applied: true } once exim -bP shows the addresses, throws CapabilityError without Exim and
//       outbound_not_applied (409, with { hint }) when the file is written but the running configuration does not use it.
//   mail.detect() / mail.status()                               -> Exim/Dovecot/spamd layout on this host
//   mail.deliverability.check(domain, user)                     -> SPF/DKIM/DMARC/MX/PTR status
//   mail.filters.apply(req)                                     -> re-render every filter into Exim
//   mail.queue.list(query) / mail.stats.summary({ hours })

// Email writes only this ACL file. On hosts with Service Configuration loaded,
// its RCPT ACL chain (acl-rcpt-local.conf) ends with an include of it and owns
// Exim's CHECK_RCPT_LOCAL_ACL_FILE macro; without it the agent sets the macro.
const ACL_FILE = 'acl-email-filters.conf';
// A pasted/uploaded list travels in the JSON body (app-wide limit 2 MB).
export const MAX_LIST_BYTES = 1_900_000;
// Same shape the agent's sendmail op enforces for argv-bound addresses.
const SENDER_SHAPE = /^[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;
const LISTS = {
  countryBlock: 'country_blocklist.lst', countryAllow: 'country_allowlist.lst',
  domainBlock: 'domain_blocklist.lst', domainAllow: 'domain_allowlist.lst',
  greyHosts: 'greylist_trusted_hosts.lst', greySenders: 'greylist_trusted_senders.lst', greyRecipients: 'greylist_trusted_recipients.lst',
  localDomains: 'local_domains.lst', relayDomains: 'relay_domains.lst',
};
const GREYLIST_DB = '/var/lib/whm/greylist/greylist.db';
const MANAGED = '# Managed by WHM panel';

export function isCidr(value) {
  const [addr, prefix] = String(value).split('/');
  const family = net.isIP(addr);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

// Accepts the common list formats (ipdeny .zone files, one CIDR per line,
// comments with # or ;, CSV first column).
export function parseCidrList(text) {
  const out = new Set();
  const bad = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const token = line.split(/[\s,]+/)[0];
    if (isCidr(token)) out.add(token.toLowerCase()); else bad.push(token);
  }
  return { cidrs: [...out], invalid: bad.slice(0, 20), invalidCount: bad.length };
}

// In-memory list pagination. Sort keys are snake_case because the shared
// pagination schema only accepts /^[a-z_]+$/; `sortable` maps them to row
// fields. Without an explicit sort the default column is used in its natural
// (descending) order, since validation defaults dir to asc.
function pageOf(list, query, sortable = {}, defaultSort = null) {
  const page = query.page || 1; const pageSize = query.pageSize || 50;
  let rows = list;
  const sort = query.sort && sortable[query.sort] ? query.sort : defaultSort;
  if (sort && sortable[sort]) {
    const key = sortable[sort];
    const dir = query.sort && sortable[query.sort] ? query.dir : 'desc';
    rows = [...rows].sort((a, b) => { const x = a[key] ?? ''; const y = b[key] ?? ''; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * (dir === 'desc' ? -1 : 1); });
  }
  return { data: rows.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: rows.length } };
}

const windowHours = (q, fallback) => (q?.hours != null ? Number(q.hours) : fallback);

// Renders the panel's acl_check_rcpt include from the enabled filters. Pure so
// tests can pin the Exim syntax.
export function renderAcl({ dir, country, domain, greylist }) {
  const lines = [`${MANAGED} (Email filters). Generated ${new Date().toISOString()}.`, '# Reached from acl_check_rcpt (before the final accept) through the Exim Configuration Manager ACL chain or CHECK_RCPT_LOCAL_ACL_FILE. Edit through the panel; manual changes are overwritten.', ''];
  // Host lists carry ::1, so the separator is switched to ";" (a colon-separated
  // list would split the IPv6 address). The leading empty item matches local
  // (non-TCP) submissions.
  const loopback = (file) => `<; ; 127.0.0.1 ; ::1 ; /${dir}/${file}`;
  if (country.blockCount > 0) {
    lines.push('# Filter Incoming Emails by Country: blocked countries', 'deny    !authenticated = *', `        hosts = /${dir}/${LISTS.countryBlock}`, `        message = ${country.message}`, '        log_message = WHM country filter (blocked country)', '');
  }
  if (country.allowCount > 0) {
    lines.push('# Filter Incoming Emails by Country: only allowed countries may send', 'deny    !authenticated = *', `        !hosts = ${loopback(LISTS.countryAllow)}`, `        message = ${country.message}`, '        log_message = WHM country filter (country not allowed)', '');
  }
  if (domain.blockCount > 0) {
    lines.push('# Filter Incoming Emails by Domain: blocked sender domains', 'deny    !authenticated = *');
    if (domain.allowCount > 0) lines.push(`        !senders = /${dir}/${LISTS.domainAllow}`);
    lines.push(`        senders = /${dir}/${LISTS.domainBlock}`, `        message = ${domain.message}`, '        log_message = WHM domain filter', '');
  }
  if (greylist.enabled && greylist.backend) {
    const delay = greylist.initialDelayMinutes * 60;
    const retry = greylist.mustRetryHours * 3600;
    const triplet = `sender='\${quote_sqlite:$sender_address}' AND recipient='\${quote_sqlite:$local_part@$domain}' AND host='\${quote_sqlite:$sender_host_address}'`;
    const skip = ['warn    set acl_m_whmgrey = check', 'warn    authenticated = *', '        set acl_m_whmgrey = skip', `warn    hosts = ${loopback(LISTS.greyHosts)}`, '        set acl_m_whmgrey = skip', `warn    senders = /${dir}/${LISTS.greySenders}`, '        set acl_m_whmgrey = skip', `warn    domains = /${dir}/${LISTS.greyRecipients}`, '        set acl_m_whmgrey = skip'];
    if (greylist.backend === 'sqlite') {
      // Exim >= 4.94 taint-checks the query, so the file name must come from the
      // sqlite_dbfile main option (written by the agent's managed block); older
      // Exim only knows the "filename query" form.
      const db = greylist.dbfileOption ? '' : `${GREYLIST_DB} `;
      lines.push(`# Greylisting (Exim SQLite lookup, ${greylist.dbfileOption ? `sqlite_dbfile = ${GREYLIST_DB}` : GREYLIST_DB}): defer ${greylist.initialDelayMinutes} min, retry within ${greylist.mustRetryHours} h`, ...skip,
        'warn    condition = ${if eq{$acl_m_whmgrey}{check}}',
        `        set acl_m_whmgrey = \${lookup sqlite {${db}SELECT CASE WHEN passed = 1 THEN 'pass' WHEN (\${tod_epoch} - first_seen) >= ${delay} AND (\${tod_epoch} - first_seen) <= ${retry} THEN 'pass' WHEN (\${tod_epoch} - first_seen) > ${retry} THEN 'reset' ELSE 'defer' END FROM greylist WHERE ${triplet}}{$value}{new}}`,
        'warn    condition = ${if eq{$acl_m_whmgrey}{new}}',
        `        set acl_m_whmgrey_db = \${lookup sqlite {${db}INSERT OR IGNORE INTO greylist (sender, recipient, host, first_seen, last_seen, passed, count) VALUES ('\${quote_sqlite:$sender_address}', '\${quote_sqlite:$local_part@$domain}', '\${quote_sqlite:$sender_host_address}', \${tod_epoch}, \${tod_epoch}, 0, 1)}{ok}{failed}}`,
        'warn    condition = ${if eq{$acl_m_whmgrey}{reset}}',
        `        set acl_m_whmgrey_db = \${lookup sqlite {${db}UPDATE greylist SET first_seen = \${tod_epoch}, last_seen = \${tod_epoch}, count = count + 1 WHERE ${triplet}}{ok}{failed}}`,
        'warn    condition = ${if eq{$acl_m_whmgrey}{defer}}',
        `        set acl_m_whmgrey_db = \${lookup sqlite {${db}UPDATE greylist SET last_seen = \${tod_epoch}, count = count + 1 WHERE ${triplet}}{ok}{failed}}`,
        'warn    condition = ${if eq{$acl_m_whmgrey}{pass}}',
        `        set acl_m_whmgrey_db = \${lookup sqlite {${db}UPDATE greylist SET last_seen = \${tod_epoch}, passed = 1, count = count + 1 WHERE ${triplet}}{ok}{failed}}`,
        'defer   condition = ${if or{{eq{$acl_m_whmgrey}{new}}{eq{$acl_m_whmgrey}{defer}}{eq{$acl_m_whmgrey}{reset}}}}',
        `        message = ${greylist.message}`, '        log_message = WHM greylisting', '');
    } else {
      lines.push('# Greylisting (greylistd)', ...skip,
        'defer   condition = ${if eq{$acl_m_whmgrey}{check}}',
        '        condition = ${if eq {${readsocket{/var/run/greylistd/socket}{--grey $sender_host_address $sender_address $local_part@$domain}{5s}{}{}}}{grey}}',
        `        message = ${greylist.message}`, '        log_message = WHM greylisting (greylistd)', '');
    }
  }
  if (lines.length === 3) lines.push('# No filters are enabled.', '');
  return `${lines.join('\n')}\n`;
}

const safeMessage = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/[${}\\]/g, '').trim().slice(0, 200) || 'Rejected by server policy';

export function createEmailService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;
  const op = (name, args, req) => agent.op(name, args, { req });
  const audit = (req, entry) => req?.audit?.(entry);
  const setting = (key, fallback) => { const v = settings.get(key); return v == null || v === '' ? fallback : v; };

  const stmts = {
    countries: db.prepare('SELECT f.*, (SELECT COUNT(*) FROM mail_country_cidrs c WHERE c.code = f.code) AS cidr_count FROM mail_country_filters f ORDER BY f.code'),
    countryByCode: db.prepare('SELECT f.*, (SELECT COUNT(*) FROM mail_country_cidrs c WHERE c.code = f.code) AS cidr_count FROM mail_country_filters f WHERE f.code = ?'),
    upsertCountry: db.prepare(`INSERT INTO mail_country_filters (code, name, action, enabled, source) VALUES (@code, @name, @action, @enabled, @source)
      ON CONFLICT (code) DO UPDATE SET name = COALESCE(excluded.name, name), action = excluded.action, enabled = excluded.enabled, source = COALESCE(excluded.source, source), updated_at = datetime('now')`),
    touchCountry: db.prepare(`UPDATE mail_country_filters SET source = COALESCE(?, source), updated_at = datetime('now') WHERE code = ?`),
    deleteCountry: db.prepare('DELETE FROM mail_country_filters WHERE code = ?'),
    cidrsFor: db.prepare('SELECT cidr FROM mail_country_cidrs WHERE code = ? ORDER BY id'),
    cidrsForAction: db.prepare('SELECT c.cidr FROM mail_country_cidrs c JOIN mail_country_filters f ON f.code = c.code WHERE f.enabled = 1 AND f.action = ? ORDER BY c.code, c.id'),
    clearCidrs: db.prepare('DELETE FROM mail_country_cidrs WHERE code = ?'),
    insertCidr: db.prepare('INSERT OR IGNORE INTO mail_country_cidrs (code, cidr) VALUES (?, ?)'),
    domainFilters: db.prepare('SELECT * FROM mail_domain_filters ORDER BY kind, domain'),
    domainFilterById: db.prepare('SELECT * FROM mail_domain_filters WHERE id = ?'),
    domainFilter: db.prepare('SELECT * FROM mail_domain_filters WHERE domain = ? AND kind = ?'),
    insertDomainFilter: db.prepare('INSERT INTO mail_domain_filters (domain, kind, comment, enabled) VALUES (?, ?, ?, ?)'),
    setDomainFilterEnabled: db.prepare('UPDATE mail_domain_filters SET enabled = ? WHERE id = ?'),
    deleteDomainFilter: db.prepare('DELETE FROM mail_domain_filters WHERE id = ?'),
    trusted: db.prepare('SELECT * FROM mail_greylist_trusted ORDER BY kind, value'),
    trustedById: db.prepare('SELECT * FROM mail_greylist_trusted WHERE id = ?'),
    insertTrusted: db.prepare('INSERT INTO mail_greylist_trusted (kind, value, comment) VALUES (?, ?, ?)'),
    deleteTrusted: db.prepare('DELETE FROM mail_greylist_trusted WHERE id = ?'),
    insertApply: db.prepare('INSERT INTO mail_filter_applies (ok, summary, error) VALUES (?, ?, ?)'),
    lastApply: db.prepare('SELECT * FROM mail_filter_applies ORDER BY id DESC LIMIT 1'),
    pruneApplies: db.prepare('DELETE FROM mail_filter_applies WHERE id NOT IN (SELECT id FROM mail_filter_applies ORDER BY id DESC LIMIT 50)'),
    accounts: db.prepare('SELECT a.id, a.username, a.domain, a.owner_id, a.home_dir, a.suspended, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id ORDER BY a.username'),
    accountByUsername: db.prepare('SELECT * FROM accounts WHERE username = ?'),
    visibleDomains: db.prepare(`SELECT d.domain, d.type, a.username AS account, a.owner_id, a.ip FROM account_domains d JOIN accounts a ON a.id = d.account_id
      UNION SELECT a.domain, 'main' AS type, a.username AS account, a.owner_id, a.ip FROM accounts a
      UNION SELECT m.domain, 'mail' AS type, a.username AS account, a.owner_id, a.ip FROM mail_domains m LEFT JOIN accounts a ON a.id = m.account_id ORDER BY 1`),
    dkimKey: db.prepare('SELECT domain, selector, public_key, created_at FROM dkim_keys WHERE domain = ?'),
    mailDomain: db.prepare('SELECT * FROM mail_domains WHERE domain = ?'),
    upsertMailDomain: db.prepare(`INSERT INTO mail_domains (domain, account_id, routing) VALUES (@domain, @account_id, @routing) ON CONFLICT (domain) DO UPDATE SET routing = excluded.routing, account_id = COALESCE(excluded.account_id, account_id)`),
    mailDomainsAll: db.prepare('SELECT domain, routing FROM mail_domains ORDER BY domain'),
  };

  const eximMissing = 'Exim is not installed on this server. Install exim4 (Debian/Ubuntu) or exim (RHEL) and refresh.';
  function requireExim(detail = eximMissing) { capabilities.require('exim', detail); }

  let detectCache = { at: 0, value: null };
  async function detect(force = false) {
    if (!force && detectCache.value && Date.now() - detectCache.at < 60_000) return detectCache.value;
    const value = await op('mail.detect');
    detectCache = { at: Date.now(), value };
    return value;
  }

  // Pages poll this on every load, so the layout comes from the 60 s cache
  // unless the caller asks for a refresh (the install-prompt retry button).
  async function status({ refresh = false } = {}) {
    await capabilities.ensureFresh();
    const layout = await detect(refresh).catch((err) => ({ installed: false, error: err.message }));
    const installed = capabilities.has('exim') && layout.installed !== false;
    let queue = null;
    if (installed) { try { const q = await op('mail.queue.list', { limit: 1 }); queue = { total: q.total, frozen: q.frozen }; } catch (err) { queue = { error: err.message }; } }
    const last = stmts.lastApply.get();
    return {
      installed, exim: layout, dovecot: capabilities.has('dovecot'), spamassassin: capabilities.has('spamassassin'), queue,
      filters: { countries: stmts.countries.all().filter((c) => c.enabled).length, domains: stmts.domainFilters.all().filter((d) => d.enabled).length, greylisting: Boolean(setting('mail.greylist.enabled', false)), lastApply: last ? { at: last.applied_at, ok: Boolean(last.ok), summary: json.parse(last.summary, null), error: last.error } : null },
    };
  }

  // -------------------------------------------------------------- queue ---

  const queue = {
    // Every queued message matching the filter (one exim -bp run).
    async matching(query = {}) {
      requireExim();
      const { messages, total, frozen, truncated } = await op('mail.queue.list', { limit: 50_000 });
      let list = messages;
      if (query.frozen === true) list = list.filter((m) => m.frozen);
      if (query.frozen === false) list = list.filter((m) => !m.frozen);
      if (query.q) { const q = query.q.toLowerCase(); list = list.filter((m) => m.id.toLowerCase().includes(q) || (m.sender || '').toLowerCase().includes(q) || m.recipients.some((r) => r.address.toLowerCase().includes(q))); }
      if (query.olderThanMinutes) list = list.filter((m) => (m.ageSeconds ?? 0) >= query.olderThanMinutes * 60);
      return { list, total, frozen, truncated };
    },
    async list(query = {}) {
      const { list, total, frozen, truncated } = await queue.matching(query);
      const result = pageOf(list, query, { age: 'ageSeconds', size: 'sizeBytes', sender: 'sender', id: 'id' }, 'age');
      return { ...result, meta: { ...result.meta, queueTotal: total, queueFrozen: frozen, truncated } };
    },
    async message(id) { requireExim(); return op('mail.queue.message', { id }); },
    async action(kind, ids, req) {
      requireExim();
      const opName = { deliver: 'mail.queue.deliver', freeze: 'mail.queue.freeze', thaw: 'mail.queue.thaw', remove: 'mail.queue.remove' }[kind];
      if (!opName) throw badRequest(`Unknown queue action "${kind}"`);
      const results = [];
      for (let i = 0; i < ids.length; i += 100) results.push(await op(opName, { ids: ids.slice(i, i + 100) }, req));
      const merged = { kind, ids, ok: results.every((r) => r.ok), results: results.flatMap((r) => r.results), output: results.map((r) => r.output).filter(Boolean).join('\n') };
      audit(req, { action: `mail.queue.${kind}`, target: ids.length === 1 ? ids[0] : `${ids.length} messages`, args: { count: ids.length, ok: merged.ok } });
      return merged;
    },
    // Bulk cleanup over every message matching the filter, not just one page.
    async actionMatching(kind, { frozen, q, olderThanMinutes }, req) {
      const { list } = await queue.matching({ frozen, q, olderThanMinutes });
      if (!list.length) return { kind, ids: [], ok: true, results: [], matched: 0 };
      return { ...(await queue.action(kind, list.map((m) => m.id), req)), matched: list.length };
    },
    // A queue run can take as long as the slowest remote host, so it is a job.
    flush(force, user, req) {
      requireExim();
      const job = ctx.jobs.enqueue('mail.queue.flush', { force: Boolean(force) }, { userId: user?.id ?? null });
      audit(req, { action: 'mail.queue.flush', args: { force: Boolean(force), job: job.id } });
      return { job };
    },
    async flushJob(jobCtx) {
      const { force } = jobCtx.params;
      jobCtx.log(`running the queue with exim ${force ? '-qff' : '-qf'}`);
      jobCtx.progress(5, 'queue run');
      const result = await agent.op('mail.queue.flush', { force });
      jobCtx.log(`queue run ${result.ok ? 'finished' : 'ended with errors'}: ${result.delivered} delivered, ${result.deferred} deferred, ${result.failed} failed`, result.ok ? 'info' : 'warn');
      jobCtx.progress(100, 'done');
      return result;
    },
  };

  // ------------------------------------------------------------ reports ---

  const reports = {
    async delivery(query = {}) {
      requireExim();
      const hours = windowHours(query, Number(setting('mail.log.default_window_hours', 24)));
      const r = await op('mail.log.report', { sinceHours: hours, sender: query.sender || undefined, recipient: query.recipient || undefined, limit: 20_000 });
      let rows = r.messages.flatMap((m) => {
        const rcpts = m.recipients.length ? m.recipients : [{ address: null, status: m.completedAt ? 'completed' : 'queued', at: null, detail: m.completedAt ? 'No delivery line in the log window' : 'Still queued or delivered outside the log window' }];
        return rcpts.map((x, i) => ({ key: `${m.id}:${i}`, id: m.id, arrivedAt: m.arrivedAt, sender: m.sender, authUser: m.authUser, host: m.host, size: m.size, subject: m.subject, recipient: x.address, status: x.status, deliveredAt: x.at, router: x.router, transport: x.transport, remoteHost: x.host, detail: x.detail }));
      });
      if (query.recipient) { const q = query.recipient.toLowerCase(); rows = rows.filter((x) => (x.recipient || '').toLowerCase().includes(q)); }
      if (query.status) rows = rows.filter((x) => x.status === query.status);
      if (query.q) { const q = query.q.toLowerCase(); rows = rows.filter((x) => JSON.stringify(x).toLowerCase().includes(q)); }
      const result = pageOf(rows, query, { arrived_at: 'arrivedAt', sender: 'sender', recipient: 'recipient', status: 'status', size: 'size' }, 'arrived_at');
      return { ...result, meta: { ...result.meta, hours, file: r.file, logExists: r.logExists, logTruncated: r.logTruncated, logFrom: r.logFrom ?? null, rejects: r.rejects.length, messages: r.total } };
    },
  };

  const stats = {
    async summary(query = {}) {
      requireExim();
      const hours = windowHours(query, Number(setting('mail.log.default_window_hours', 24)));
      const s = await op('mail.log.stats', { sinceHours: hours });
      return { hours, file: s.file, logExists: s.logExists, logTruncated: s.logTruncated, logFrom: s.logFrom ?? null, logBytes: s.logBytes, totals: s.totals, byHour: s.byHour, topDomains: s.topDomains, topHosts: s.topHosts, topSenders: s.senders.slice(0, 10), relayers: s.relayers.length };
    },
    async sent(query = {}) {
      requireExim();
      const hours = windowHours(query, Number(setting('mail.log.default_window_hours', 24)));
      const s = await op('mail.log.stats', { sinceHours: hours });
      let rows = s.senders;
      if (query.q) { const q = query.q.toLowerCase(); rows = rows.filter((x) => x.sender.toLowerCase().includes(q)); }
      if (query.authenticated != null) rows = rows.filter((x) => x.authenticated === query.authenticated);
      const result = pageOf(rows, query, { messages: 'messages', sender: 'sender', delivered: 'delivered', failed: 'failed', bytes: 'bytes', recipients: 'recipients', last_seen: 'lastSeen' }, 'messages');
      return { ...result, meta: { ...result.meta, hours, totals: s.totals, logExists: s.logExists, logTruncated: s.logTruncated, logFrom: s.logFrom ?? null } };
    },
    async relayers(query = {}) {
      requireExim();
      const hours = windowHours(query, Number(setting('mail.log.default_window_hours', 24)));
      const s = await op('mail.log.stats', { sinceHours: hours });
      let rows = s.relayers;
      if (query.q) { const q = query.q.toLowerCase(); rows = rows.filter((x) => x.user.toLowerCase().includes(q) || x.senders.some((y) => y.toLowerCase().includes(q))); }
      const result = pageOf(rows, query, { messages: 'messages', user: 'user', recipients: 'recipients', bytes: 'bytes', failed: 'failed', last_seen: 'lastSeen' }, 'messages');
      return { ...result, meta: { ...result.meta, hours, totals: s.totals, logExists: s.logExists, logTruncated: s.logTruncated, logFrom: s.logFrom ?? null } };
    },
  };

  // ---------------------------------------------------------- DNS helpers ---

  let resolver = null;
  function getResolver() {
    if (!resolver) resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
    return resolver;
  }
  const lookupSafe = async (fn) => { try { return { ok: true, value: await fn() }; } catch (err) { return { ok: false, error: err.code || err.message, value: null }; } };
  const txtAt = async (name) => { const r = await lookupSafe(() => getResolver().resolveTxt(name)); return { ...r, value: r.ok ? r.value.map((chunks) => chunks.join('')) : [] }; };

  // Probes an MX on port 25 and reads the banner; proves the path from this
  // host. Replaceable (useBannerProber) so tests never open a socket.
  let bannerProber = smtpBanner;
  function useBannerProber(fn) { bannerProber = fn || smtpBanner; }
  function smtpBanner(host, port = 25, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
      socket.setTimeout(timeoutMs, () => done({ ok: false, error: 'timeout' }));
      socket.once('error', (err) => done({ ok: false, error: err.code || err.message }));
      socket.once('data', (buf) => done({ ok: true, banner: String(buf).trim().slice(0, 200) }));
      socket.once('connect', () => setTimeout(() => done({ ok: true, banner: null }), timeoutMs));
    });
  }

  async function serverAddresses() {
    const main = setting('basic.main_ip', '');
    const out = main ? [main] : [];
    try {
      const info = await op('sys.info');
      for (const i of info.interfaces || []) for (const a of i.addresses || []) if (a.family === 'IPv4' && !out.includes(a.address) && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a.address)) out.push(a.address);
    } catch { /* agent unavailable */ }
    return out.slice(0, 4);
  }

  // ------------------------------------------------------ troubleshooter ---

  async function troubleshoot(address, req) {
    const [, domain] = address.split('@');
    const result = { address, domain, local: null, mx: null, smtp: null, exim: null, hints: [] };
    const known = stmts.visibleDomains.all().find((d) => d.domain === domain.toLowerCase());
    const routing = stmts.mailDomain.get(domain.toLowerCase())?.routing || null;
    result.local = { hosted: Boolean(known), account: known?.account || null, routing };
    const mx = await lookupSafe(() => getResolver().resolveMx(domain));
    result.mx = mx.ok ? { ok: true, records: [...mx.value].sort((a, b) => a.priority - b.priority) } : { ok: false, error: mx.error, records: [] };
    if (!mx.ok || !mx.value.length) {
      const a = await lookupSafe(() => getResolver().resolve4(domain));
      result.mx.fallbackA = a.ok ? a.value : [];
      if (!a.ok) result.hints.push(`No MX or A record resolves for ${domain}; mail cannot be routed to it.`);
      else result.hints.push(`${domain} has no MX records; mail falls back to its A record (${a.value.join(', ')}).`);
    }
    const first = result.mx.records[0]?.exchange || result.mx.fallbackA?.[0];
    if (first) {
      result.smtp = { host: first, ...(await bannerProber(first)) };
      if (!result.smtp.ok) result.hints.push(`Could not reach ${first} on port 25 (${result.smtp.error}). Outbound SMTP may be firewalled (see Security Center → SMTP Restrictions) or the remote server is down.`);
    }
    if (capabilities.has('exim')) {
      try { result.exim = { available: true, ...(await op('mail.test_delivery', { address }, req)) }; } catch (err) { result.exim = { available: true, error: err.message }; }
      if (result.exim.routable === false) result.hints.push('Exim cannot route this address with the current configuration (see the exim -bt output).');
    } else {
      result.exim = { available: false, reason: eximMissing };
    }
    if (known && result.mx.ok && result.mx.records.length) {
      const addrs = await serverAddresses();
      const mxIps = (await Promise.all(result.mx.records.slice(0, 3).map((m) => lookupSafe(() => getResolver().resolve4(m.exchange))))).flatMap((r) => r.value || []);
      result.local.mxPointsHere = mxIps.some((ip) => addrs.includes(ip));
      if (!result.local.mxPointsHere && routing !== 'remote') result.hints.push(`${domain} is hosted here but its MX records point elsewhere (${mxIps.join(', ') || 'unresolved'}). Set Email Routing to "remote" or fix the MX records.`);
    }
    audit(req, { action: 'mail.troubleshoot', target: address });
    return result;
  }

  // ------------------------------------------------------ deliverability ---

  function visibleDomains(user) {
    const rows = stmts.visibleDomains.all();
    const filtered = isRoot(user) ? rows : rows.filter((r) => r.owner_id === user.id);
    const seen = new Map();
    for (const r of filtered) if (!seen.has(r.domain)) seen.set(r.domain, r);
    return [...seen.values()];
  }
  function assertDomain(domain, user) {
    const row = stmts.visibleDomains.all().find((r) => r.domain === domain);
    if (!row) throw notFound(`Domain ${domain}`);
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That domain belongs to another reseller');
    return row;
  }

  const deliverability = {
    useResolver(r) { resolver = r; },
    // Is the key for this domain installed for Exim and does the running
    // configuration sign with it? installed:false when Exim itself is missing.
    async signingStatus(domain) {
      if (!capabilities.has('exim')) return { installed: false, signing: null, detail: eximMissing, hint: null };
      try {
        const r = await op('mail.dkim.list');
        const installed = r.keys.some((k) => k.domain === domain);
        return { installed, signing: installed ? r.signing : false, detail: installed ? r.signingDetail : 'the private key is not installed under the Exim configuration directory', hint: r.hint || null };
      } catch (err) { return { installed: null, signing: null, detail: err.message, hint: null }; }
    },
    domains(user) {
      return visibleDomains(user).map((d) => ({ domain: d.domain, type: d.type, account: d.account, dkimKey: Boolean(stmts.dkimKey.get(d.domain)), zone: Boolean(ctx.dns) && Boolean(db.prepare('SELECT 1 FROM dns_zones WHERE domain = ?').get(d.domain)) }));
    },
    async check(domain, user) {
      const row = assertDomain(domain, user);
      const key = stmts.dkimKey.get(domain);
      const selector = key?.selector || setting('dns.dkim_selector', 'default');
      let expected = null;
      if (typeof ctx.dns?.emailStatus === 'function') { try { expected = await ctx.dns.emailStatus(domain, user); } catch { expected = null; } }
      const [spf, dkim, dmarc, mx] = await Promise.all([txtAt(domain), txtAt(`${selector}._domainkey.${domain}`), txtAt(`_dmarc.${domain}`), lookupSafe(() => getResolver().resolveMx(domain))]);
      const spfRecords = spf.value.filter((v) => /^v=spf1\b/i.test(v));
      const dkimRecord = dkim.value.find((v) => /^v=DKIM1\b/i.test(v) || /\bp=/.test(v)) || null;
      const dmarcRecord = dmarc.value.find((v) => /^v=DMARC1\b/i.test(v)) || null;
      const addrs = await serverAddresses();
      const hostname = setting('basic.hostname', '');
      const ptr = await Promise.all(addrs.map(async (ip) => {
        const r = await lookupSafe(() => getResolver().reverse(ip));
        const names = r.ok ? r.value : [];
        const forward = names.length ? await lookupSafe(() => getResolver().resolve4(names[0])) : { ok: false, value: [] };
        return { ip, names, forwardConfirmed: Boolean(forward.ok && forward.value.includes(ip)), matchesHostname: Boolean(hostname) && names.some((n) => n.toLowerCase() === hostname.toLowerCase()), error: r.ok ? null : r.error };
      }));
      const dkimPublished = dkimRecord ? (dkimRecord.match(/\bp=([A-Za-z0-9+/=]*)/)?.[1] || '') : '';
      const dkimMatches = key ? dkimPublished.replace(/\s+/g, '') === key.public_key.replace(/\s+/g, '') : null;
      // A published record is only half of DKIM: Exim must sign with the installed key.
      const signing = key ? await deliverability.signingStatus(domain) : { installed: null, signing: null, detail: null, hint: null };
      const dkimRecordOk = Boolean(dkimRecord) && dkimMatches !== false;
      const dkimStatus = !dkimRecord ? 'missing' : !dkimRecordOk ? 'warning' : signing.signing === false ? 'warning' : 'ok';
      const dkimDetail = !key ? 'No DKIM key has been generated for this domain yet.' : !dkimRecord ? `No TXT record at ${selector}._domainkey.${domain}.` : dkimMatches === false ? 'The published public key differs from the key stored on this server.'
        : signing.signing === false ? `DKIM record published, but outbound mail is not signed: ${signing.detail || 'Exim is not configured to sign with the installed key'}.` : signing.installed === false ? 'DKIM record published; the key is not installed in Exim on this server (Exim is missing), so nothing signs outbound mail.' : null;
      const items = [
        { id: 'spf', label: 'SPF', status: spfRecords.length === 1 ? 'ok' : spfRecords.length > 1 ? 'warning' : 'missing', current: spfRecords, expected: expected?.suggestions?.spf || expected?.spf?.value || null, detail: spfRecords.length > 1 ? 'More than one SPF record; receivers treat this as a permanent error.' : spfRecords.length ? null : 'No v=spf1 TXT record found at the zone apex.', fixable: Boolean(ctx.dns) && Boolean(expected) },
        { id: 'dkim', label: 'DKIM', selector, status: dkimStatus, current: dkimRecord ? [dkimRecord] : [], expected: key ? `v=DKIM1; k=rsa; p=${key.public_key}` : null, detail: dkimDetail, fixable: Boolean(ctx.dns) && Boolean(expected), signing: signing.signing, signingHint: signing.hint },
        { id: 'dmarc', label: 'DMARC', status: dmarcRecord ? 'ok' : 'missing', current: dmarcRecord ? [dmarcRecord] : [], expected: expected?.suggestions?.dmarc || `v=DMARC1; p=none; rua=mailto:postmaster@${domain}`, detail: dmarcRecord ? (/p=none/i.test(dmarcRecord) ? 'Policy is "none" (monitor only).' : null) : 'No _dmarc TXT record; receivers cannot apply your policy.', fixable: Boolean(ctx.dns) && Boolean(expected) },
        { id: 'mx', label: 'MX', status: mx.ok && mx.value.length ? 'ok' : 'missing', current: mx.ok ? mx.value.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`) : [], expected: null, detail: mx.ok && mx.value.length ? null : 'No MX records; inbound mail relies on the A record.', fixable: false },
        { id: 'ptr', label: 'Reverse DNS (PTR)', status: ptr.length === 0 ? 'unknown' : ptr.every((p) => p.names.length && p.forwardConfirmed) ? (ptr.some((p) => p.matchesHostname) || !hostname ? 'ok' : 'warning') : 'missing', current: ptr.map((p) => `${p.ip} → ${p.names.join(', ') || '(none)'}`), expected: hostname ? `${addrs.join(', ')} → ${hostname}` : null, detail: ptr.some((p) => !p.names.length) ? 'An outbound address has no PTR record. Ask your provider to set it to the server hostname.' : ptr.some((p) => !p.forwardConfirmed) ? 'The PTR name does not resolve back to the address (no forward-confirmed reverse DNS).' : ptr.length && hostname && !ptr.some((p) => p.matchesHostname) ? `The PTR does not match the server hostname (${hostname}).` : null, fixable: false, addresses: ptr },
      ];
      const score = Math.round((items.filter((i) => i.status === 'ok').length / items.length) * 100);
      return { domain, account: row.account, zone: Boolean(expected), items, score, checkedAt: new Date().toISOString(), lookups: { spf: spf.ok || spf.error, dkim: dkim.ok || dkim.error, dmarc: dmarc.ok || dmarc.error, mx: mx.ok || mx.error } };
    },
    async fix(domain, items, user, req) {
      assertDomain(domain, user);
      if (!ctx.dns) throw new CapabilityError('dns', 'The DNS Functions category is not loaded, so records cannot be created automatically. Add the suggested records at your DNS provider.');
      const results = {};
      for (const item of items) {
        try {
          if (item === 'spf') results.spf = { ok: true, ...(await ctx.dns.setSpf(domain, {}, user, req)) };
          else if (item === 'dkim') results.dkim = { ok: true, ...(await ctx.dns.ensureDkim(domain, {}, user, req)) };
          else if (item === 'dmarc') results.dmarc = { ok: true, ...(await ctx.dns.setDmarc(domain, { p: 'none', rua: `postmaster@${domain}` }, user, req)) };
          else results[item] = { ok: false, error: `${item} cannot be fixed automatically` };
        } catch (err) { results[item] = { ok: false, error: err.message, code: err.code }; }
      }
      audit(req, { action: 'mail.deliverability.fix', target: domain, args: { items, ok: Object.values(results).every((r) => r.ok) } });
      return { domain, results, status: await deliverability.check(domain, user) };
    },
  };

  // ------------------------------------------------------------ filters ---

  function countryShape(row) {
    return { code: row.code, name: row.name, action: row.action, enabled: Boolean(row.enabled), cidrs: row.cidr_count, source: row.source, updatedAt: row.updated_at };
  }

  function filterSummary() {
    const countries = stmts.countries.all().filter((c) => c.enabled && c.cidr_count > 0);
    const domains = stmts.domainFilters.all().filter((d) => d.enabled);
    return {
      country: { blockCount: countries.filter((c) => c.action === 'block').length, allowCount: countries.filter((c) => c.action === 'allow').length, message: safeMessage(setting('mail.country_filter.message')) },
      domain: { blockCount: domains.filter((d) => d.kind === 'block').length, allowCount: domains.filter((d) => d.kind === 'allow').length, message: safeMessage(setting('mail.domain_filter.message')) },
      greylist: { ...greylist.settings(), message: safeMessage(setting('mail.greylist.message')) },
    };
  }

  const filters = {
    // Writes every list file and the ACL include. With exim missing this
    // records "not applied" and returns applied:false instead of throwing,
    // unless `strict` (the explicit Apply button).
    async apply(req, { strict = false } = {}) {
      await capabilities.ensureFresh();
      if (!capabilities.has('exim')) {
        if (strict) requireExim();
        stmts.insertApply.run(0, null, 'Exim is not installed'); stmts.pruneApplies.run();
        return { applied: false, reason: 'Exim is not installed on this server; filters are saved and will be applied once it is.' };
      }
      const layout = await detect();
      const summary = filterSummary();
      let backend = null;
      let dbfileOption = false;
      if (summary.greylist.enabled) {
        const be = await op('mail.greylist.backend').catch(() => ({ backend: null }));
        backend = be.backend;
        dbfileOption = Boolean(be.dbfileOption);
        if (backend === 'sqlite') await op('mail.greylist.init', {}, req);
      }
      summary.greylist.backend = backend;
      summary.greylist.dbfileOption = dbfileOption;
      const sqliteDbfile = backend === 'sqlite' && dbfileOption ? GREYLIST_DB : null;
      // Who hooks the ACL into acl_check_rcpt: Service Configuration's chain
      // when it is loaded (its chain file includes ours), else the agent's macro.
      let aclMacro = true;
      if (typeof ctx.web?.ensureEximAclChain === 'function') {
        try { await ctx.web.ensureEximAclChain(); aclMacro = false; } catch (err) { logger.warn({ err }, 'mail filters: ACL chain unavailable, falling back to the CHECK_RCPT_LOCAL_ACL_FILE macro'); }
      }
      const dir = layout.whmDir.replace(/^\//, '');
      const domainsOf = (kind) => stmts.domainFilters.all().filter((d) => d.enabled && d.kind === kind).flatMap((d) => [`*@${d.domain}`, `*@*.${d.domain}`]);
      const trustedOf = (kind) => stmts.trusted.all().filter((t) => t.kind === kind).map((t) => t.value);
      const files = {
        [LISTS.countryBlock]: stmts.cidrsForAction.all('block').map((r) => r.cidr),
        [LISTS.countryAllow]: stmts.cidrsForAction.all('allow').map((r) => r.cidr),
        [LISTS.domainBlock]: domainsOf('block'),
        [LISTS.domainAllow]: domainsOf('allow'),
        [LISTS.greyHosts]: trustedOf('host'),
        [LISTS.greySenders]: trustedOf('sender_domain').flatMap((d) => [`*@${d}`, `*@*.${d}`]),
        [LISTS.greyRecipients]: trustedOf('recipient_domain'),
      };
      const written = [];
      try {
        for (const [name, entries] of Object.entries(files)) {
          await op('mail.config.include.write', { name, content: `${MANAGED} (${name})\n${entries.join('\n')}\n`, reload: false, hook: false }, req);
          written.push({ name, entries: entries.length });
        }
        const acl = await op('mail.config.include.write', { name: ACL_FILE, content: renderAcl({ dir, ...summary }), reload: true, hook: true, sqliteDbfile, aclMacro }, req);
        // The agent verifies the hook against the generated config; `hooked`
        // false means the files are written but Exim is not reading them yet.
        const hooked = acl.hooked ?? null;
        const includeMode = hooked === false ? 'manual' : (acl.includeMode || layout.includeMode);
        const warnings = [];
        let hint = acl.hint || null;
        if (includeMode === 'manual' && !hint) hint = `Add ".include ${layout.aclChainFile || layout.aclFile}" inside acl_check_rcpt (before the final accept) in ${layout.configFile || '/etc/exim.conf'} once; the panel keeps that file current.`;
        if (hooked === false) warnings.push(`Filters were written to ${acl.path} but the running Exim configuration does not include them${acl.hookDetail ? ` (${acl.hookDetail})` : ''}.`);
        let selfTest = null;
        if (backend === 'sqlite') {
          selfTest = await op('mail.greylist.selftest').catch((err) => ({ backend: 'sqlite', ok: false, output: err.message }));
          if (selfTest.ok === false) warnings.push(`The greylist SQLite lookup failed its self-test (${(selfTest.output || '').split('\n').pop() || 'no output'}); until it works, greylisted mail is deferred for everyone who is not exempt.`);
        }
        const result = { applied: true, enforced: hooked !== false && selfTest?.ok !== false, aclPath: acl.path, reloaded: acl.reloaded, unit: acl.unit, includeMode, aclMacro, hookVia: acl.hookVia ?? null, hooked, hint, warnings, selfTest, files: written, summary };
        stmts.insertApply.run(1, JSON.stringify({ countries: summary.country, domains: summary.domain, greylist: { enabled: summary.greylist.enabled, backend, dbfileOption }, hooked, includeMode, aclMacro, selfTest: selfTest ? { ok: selfTest.ok, form: selfTest.form || null } : null, warnings }), null); stmts.pruneApplies.run();
        audit(req, { action: 'mail.filters.apply', args: { countries: summary.country, domains: summary.domain, greylist: summary.greylist.enabled, hooked, selfTest: selfTest?.ok ?? null } });
        return result;
      } catch (err) {
        stmts.insertApply.run(0, null, err.message); stmts.pruneApplies.run();
        if (strict) throw err;
        logger.warn({ err }, 'mail filters: apply failed');
        return { applied: false, reason: err.message, code: err.code };
      }
    },
    lastApply() { const last = stmts.lastApply.get(); return last ? { at: last.applied_at, ok: Boolean(last.ok), summary: json.parse(last.summary, null), error: last.error } : null; },

    country: {
      list() { return { countries: stmts.countries.all().map(countryShape), sourceUrl: setting('mail.country_filter.source_url'), message: setting('mail.country_filter.message'), lastApply: filters.lastApply(), installed: capabilities.has('exim') }; },
      async upsert(code, { name, action = 'block', enabled = true }, req) {
        const existed = Boolean(stmts.countryByCode.get(code));
        stmts.upsertCountry.run({ code, name: name ?? null, action, enabled: enabled ? 1 : 0, source: null });
        audit(req, { action: existed ? 'mail.filters.country.update' : 'mail.filters.country.add', target: code, args: { action, enabled } });
        return { country: countryShape(stmts.countryByCode.get(code)), apply: await filters.apply(req) };
      },
      async setCidrs(code, text, { source = 'upload', replace = true } = {}, req) {
        if (!stmts.countryByCode.get(code)) throw notFound(`Country filter ${code}`);
        if (source === 'upload' && Buffer.byteLength(text) > MAX_LIST_BYTES) throw unprocessable(`The list is larger than ${Math.round(MAX_LIST_BYTES / 1024)} KB; use "Download" to fetch large country lists from the configured source URL`, { text: ['Too large to paste or upload'] });
        const parsed = parseCidrList(text);
        if (!parsed.cidrs.length) throw unprocessable('No valid CIDR networks found in the list', { text: ['Provide one IPv4/IPv6 network per line, e.g. 203.0.113.0/24'] });
        db.transaction(() => {
          if (replace) stmts.clearCidrs.run(code);
          for (const c of parsed.cidrs) stmts.insertCidr.run(code, c);
          stmts.touchCountry.run(source, code);
        })();
        audit(req, { action: 'mail.filters.country.cidrs', target: code, args: { cidrs: parsed.cidrs.length, invalid: parsed.invalidCount, source, replace } });
        return { country: countryShape(stmts.countryByCode.get(code)), imported: parsed.cidrs.length, invalid: parsed.invalid, invalidCount: parsed.invalidCount, apply: await filters.apply(req) };
      },
      async fetch(code, req) {
        if (!stmts.countryByCode.get(code)) throw notFound(`Country filter ${code}`);
        const template = String(setting('mail.country_filter.source_url', ''));
        if (!/^https:\/\//.test(template) || !template.includes('{cc}')) throw badRequest('mail.country_filter.source_url must be an https:// URL containing {cc}');
        const url = template.replace('{cc}', code.toLowerCase()).replace('{CC}', code.toUpperCase());
        let text;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/plain' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text = await res.text();
          if (text.length > 16 * 1024 * 1024) throw new Error('list is larger than 16 MB');
        } catch (err) { throw badRequest(`Could not download the CIDR list from ${url}: ${err.message}`); }
        return filters.country.setCidrs(code, text, { source: url, replace: true }, req);
      },
      cidrs(code, query = {}) {
        if (!stmts.countryByCode.get(code)) throw notFound(`Country filter ${code}`);
        let rows = stmts.cidrsFor.all(code).map((r) => r.cidr);
        if (query.q) rows = rows.filter((c) => c.includes(query.q));
        return pageOf(rows.map((cidr) => ({ cidr })), query);
      },
      async remove(code, req) {
        if (!stmts.countryByCode.get(code)) throw notFound(`Country filter ${code}`);
        stmts.deleteCountry.run(code);
        audit(req, { action: 'mail.filters.country.remove', target: code });
        return { removed: true, apply: await filters.apply(req) };
      },
    },

    domain: {
      list() { return { rules: stmts.domainFilters.all().map((d) => ({ ...d, enabled: Boolean(d.enabled) })), message: setting('mail.domain_filter.message'), lastApply: filters.lastApply(), installed: capabilities.has('exim') }; },
      async add({ domain, kind, comment }, req) {
        if (stmts.domainFilter.get(domain, kind)) throw conflict(`${domain} is already on the ${kind} list`);
        const { lastInsertRowid } = stmts.insertDomainFilter.run(domain, kind, comment || null, 1);
        audit(req, { action: `mail.filters.domain.${kind}`, target: domain, args: { comment } });
        return { rule: { ...stmts.domainFilterById.get(lastInsertRowid), enabled: true }, apply: await filters.apply(req) };
      },
      async setEnabled(id, enabled, req) {
        const row = stmts.domainFilterById.get(id);
        if (!row) throw notFound('Domain filter rule');
        stmts.setDomainFilterEnabled.run(enabled ? 1 : 0, id);
        audit(req, { action: 'mail.filters.domain.toggle', target: row.domain, args: { enabled } });
        return { rule: { ...stmts.domainFilterById.get(id), enabled }, apply: await filters.apply(req) };
      },
      async remove(id, req) {
        const row = stmts.domainFilterById.get(id);
        if (!row) throw notFound('Domain filter rule');
        stmts.deleteDomainFilter.run(id);
        audit(req, { action: 'mail.filters.domain.remove', target: row.domain, args: { kind: row.kind } });
        return { removed: true, apply: await filters.apply(req) };
      },
    },

    async setMessages({ country, domain, greylist: grey }, req) {
      const values = {};
      if (country != null) values['mail.country_filter.message'] = safeMessage(country);
      if (domain != null) values['mail.domain_filter.message'] = safeMessage(domain);
      if (grey != null) values['mail.greylist.message'] = safeMessage(grey);
      settings.setMany(values);
      audit(req, { action: 'mail.filters.messages', args: values });
      return { messages: values, apply: await filters.apply(req) };
    },
  };

  // ---------------------------------------------------------- greylisting ---

  const greylist = {
    settings() {
      return {
        enabled: Boolean(setting('mail.greylist.enabled', false)),
        initialDelayMinutes: Number(setting('mail.greylist.initial_delay_minutes', 5)),
        mustRetryHours: Number(setting('mail.greylist.must_retry_hours', 4)),
        recordExpiresDays: Number(setting('mail.greylist.record_expires_days', 35)),
        message: setting('mail.greylist.message', 'Greylisted: please try again later'),
      };
    },
    async status() {
      await capabilities.ensureFresh();
      let backend = { backend: null, reason: eximMissing };
      if (capabilities.has('exim')) backend = await op('mail.greylist.backend').catch((err) => ({ backend: null, reason: err.message }));
      return { settings: greylist.settings(), trusted: stmts.trusted.all(), backend, installed: capabilities.has('exim'), lastApply: filters.lastApply() };
    },
    async update(input, req) {
      const map = { enabled: 'mail.greylist.enabled', initialDelayMinutes: 'mail.greylist.initial_delay_minutes', mustRetryHours: 'mail.greylist.must_retry_hours', recordExpiresDays: 'mail.greylist.record_expires_days', message: 'mail.greylist.message' };
      if (input.enabled === true) {
        requireExim();
        const be = await op('mail.greylist.backend');
        if (!be.backend) throw new CapabilityError('greylisting', be.reason || 'No greylisting backend is available on this host');
      }
      const values = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined && map[k]) values[map[k]] = k === 'message' ? safeMessage(v) : v;
      settings.setMany(values);
      audit(req, { action: 'mail.greylist.settings', args: values });
      return { settings: greylist.settings(), apply: await filters.apply(req) };
    },
    async addTrusted({ kind, value, comment }, req) {
      if (stmts.trusted.all().some((t) => t.kind === kind && t.value === value)) throw conflict(`${value} is already trusted`);
      const { lastInsertRowid } = stmts.insertTrusted.run(kind, value, comment || null);
      audit(req, { action: 'mail.greylist.trusted.add', target: value, args: { kind, comment } });
      return { entry: stmts.trustedById.get(lastInsertRowid), apply: await filters.apply(req) };
    },
    async removeTrusted(id, req) {
      const row = stmts.trustedById.get(id);
      if (!row) throw notFound('Trusted entry');
      stmts.deleteTrusted.run(id);
      audit(req, { action: 'mail.greylist.trusted.remove', target: row.value });
      return { removed: true, apply: await filters.apply(req) };
    },
    async triplets(query = {}) { requireExim(); return op('mail.greylist.triplets', { limit: query.limit || 500, ...(query.q ? { q: query.q } : {}) }); },
    async purge({ all = false } = {}, req) {
      requireExim();
      const result = await op('mail.greylist.purge', { all, olderThanDays: greylist.settings().recordExpiresDays }, req);
      audit(req, { action: 'mail.greylist.purge', args: { all, deleted: result.deleted } });
      return result;
    },
    async purgeJob(job) {
      if (!capabilities.has('exim') || !greylist.settings().enabled) return { skipped: true };
      const result = await agent.op('mail.greylist.purge', { all: false, olderThanDays: greylist.settings().recordExpiresDays });
      job?.log?.(`greylist purge: ${JSON.stringify(result)}`);
      return result;
    },
  };

  // ----------------------------------------------------------- mailboxes ---

  const homeOf = (account) => account.home_dir || `${setting('basic.home_root', '/home')}/${account.username}`;

  const mailbox = {
    accounts() { return stmts.accounts.all().map((a) => ({ username: a.username, domain: a.domain, owner: a.owner, homeDir: homeOf(a), suspended: Boolean(a.suspended) })); },
    async inspect(username) {
      const account = stmts.accountByUsername.get(username);
      if (!account) throw notFound(`Account ${username}`);
      return op('mail.mailbox.inspect', { homeDir: homeOf(account) });
    },
    repair({ usernames, all = false }, user, req) {
      const targets = all ? stmts.accounts.all().map((a) => a.username) : usernames || [];
      if (!targets.length) throw badRequest('Select at least one account');
      for (const u of targets) if (!stmts.accountByUsername.get(u)) throw notFound(`Account ${u}`);
      const job = ctx.jobs.enqueue('mail.mailbox.repair', { usernames: targets }, { userId: user?.id ?? null });
      audit(req, { action: 'mail.mailbox.repair', target: all ? 'all' : targets.join(','), args: { count: targets.length, job: job.id } });
      return { job };
    },
    async repairJob(jobCtx) {
      const { usernames } = jobCtx.params;
      const summary = { total: usernames.length, repaired: 0, skipped: 0, failed: 0, results: [] };
      let i = 0;
      for (const username of usernames) {
        i++;
        jobCtx.progress((i / usernames.length) * 100, username);
        const account = stmts.accountByUsername.get(username);
        if (!account) { summary.skipped++; jobCtx.log(`${username}: account no longer exists`, 'warn'); continue; }
        try {
          const r = await agent.op('mail.mailbox.fix_perms', { username, homeDir: homeOf(account) });
          const fixed = r.results.filter((x) => x.exists && !x.skipped);
          for (const s of r.results.filter((x) => x.skipped)) jobCtx.log(`${username}: skipped ${s.path} (${s.skipped})`, 'warn');
          if (!fixed.length) { summary.skipped++; jobCtx.log(`${username}: ${r.results.some((x) => x.skipped) ? 'nothing repaired' : 'no mail directory yet'}`); } else { summary.repaired++; jobCtx.log(`${username}: ${fixed.map((x) => `${x.path} (${x.entries} entries${x.ownerChanged ? ', owner fixed' : ''})`).join(', ')}`); }
          summary.results.push({ username, ...r });
        } catch (err) {
          summary.failed++;
          jobCtx.log(`${username}: ${err.message}`, 'error');
          summary.results.push({ username, error: err.message });
        }
      }
      return summary;
    },
    convert(input, user, req) {
      capabilities.require('dovecot', 'Dovecot (doveadm) is not installed on this server; mailbox conversion uses dsync.');
      const account = stmts.accountByUsername.get(input.username);
      if (!account) throw notFound(`Account ${input.username}`);
      const home = homeOf(account);
      const resolve = (p) => (p.startsWith('/') ? p : `${home}/${p}`);
      const source = { format: input.source.format, path: resolve(input.source.path) };
      const target = { format: input.target.format, path: resolve(input.target.path) };
      for (const p of [source.path, target.path]) if (!p.startsWith(`${home}/`) && p !== home) throw unprocessable('Mailbox paths must stay inside the account home', { path: [`${p} is outside ${home}`] });
      const job = ctx.jobs.enqueue('mail.mailbox.convert', { username: input.username, user: input.mailUser || input.username, homeDir: home, source, target, dryRun: Boolean(input.dryRun) }, { userId: user?.id ?? null });
      audit(req, { action: 'mail.mailbox.convert', target: input.username, args: { source, target, dryRun: Boolean(input.dryRun), job: job.id } });
      return { job };
    },
    async convertJob(jobCtx) {
      const { user, homeDir, source, target, dryRun, username } = jobCtx.params;
      jobCtx.log(`${username}: converting ${source.format}:${source.path} → ${target.format}:${target.path}${dryRun ? ' (dry run)' : ''}`);
      jobCtx.progress(5, 'doveadm sync');
      const account = stmts.accountByUsername.get(username);
      const result = await agent.op('mail.mailbox.convert', { user, homeDir: homeDir || (account ? homeOf(account) : undefined), source, target, dryRun });
      jobCtx.log(dryRun ? `would run: ${result.command.join(' ')}` : `done; target is ${result.targetBytes ?? 'unknown'} bytes`);
      jobCtx.progress(100, 'done');
      return result;
    },
  };

  // --------------------------------------------------------------- spamd ---

  const spamd = {
    async status() {
      await capabilities.ensureFresh();
      const state = await op('mail.spamd.config.read');
      return { ...state, installed: capabilities.has('spamassassin') && state.installed };
    },
    async update(input, req) {
      capabilities.require('spamassassin', 'SpamAssassin is not installed on this server. Install the spamassassin package to configure spamd.');
      const result = await op('mail.spamd.config.write', { settings: input }, req);
      audit(req, { action: 'mail.spamd.config', args: input });
      return result;
    },
  };

  // ------------------------------------------------ cross-category helpers ---

  async function sendNotification({ to, subject, text, from, headers }, req) {
    requireExim('Exim is not installed, so the panel cannot send email notifications');
    const sender = from || setting('mail.notification_from', '') || `whm@${setting('basic.hostname', '') || 'localhost'}`;
    if (!SENDER_SHAPE.test(sender)) throw unprocessable(`"${sender}" is not a usable sender address: set mail.notification_from or a fully-qualified basic.hostname before sending notifications`, { from: ['Must be a full email address with a dotted domain'] });
    const recipients = Array.isArray(to) ? to : [to];
    const result = await op('mail.sendmail', { from: sender, to: recipients, subject, text, ...(headers ? { headers } : {}) }, req);
    audit(req, { action: 'mail.send', target: recipients.join(','), args: { subject } });
    return result;
  }

  async function installDkimKey(domain, { selector, privateKeyPem }, req) {
    await capabilities.ensureFresh();
    if (!capabilities.has('exim')) return { installed: false, reason: 'Exim is not installed' };
    const result = await op('mail.dkim.install', { domain, selector, privateKeyPem }, req);
    if (result.signing === false) logger.warn({ domain, detail: result.signingDetail }, 'mail: DKIM key installed but Exim is not signing with it');
    audit(req, { action: 'mail.dkim.install', target: domain, args: { selector, signing: result.signing ?? null } });
    return { installed: true, ...result };
  }

  async function removeDkimKey(domain, req) {
    if (!capabilities.has('exim')) return { removed: 0 };
    const result = await op('mail.dkim.remove', { domain }, req);
    audit(req, { action: 'mail.dkim.remove', target: domain });
    return result;
  }

  // Every hosted domain is local unless it was explicitly routed elsewhere:
  // mail_domains rows only exist for domains someone routed, so the rest
  // (implicitly "auto") are added from the account/domain tables.
  function routingLists() {
    const explicit = new Map(stmts.mailDomainsAll.all().map((r) => [r.domain, r.routing]));
    const local = new Set();
    for (const d of stmts.visibleDomains.all()) if (['local', 'auto'].includes(explicit.get(d.domain) ?? 'auto')) local.add(d.domain);
    for (const [d, r] of explicit) if (r === 'local' || r === 'auto') local.add(d);
    const relay = [...explicit].filter(([, r]) => r === 'backup').map(([d]) => d);
    return { local: [...local].sort(), relay: relay.sort() };
  }

  async function setOutboundAddresses({ ipv4 = null, ipv6 = null } = {}, req) {
    await capabilities.ensureFresh();
    requireExim('Exim is not installed, so no outbound source address can be applied; it is saved and used once Exim is installed');
    const result = await op('mail.outbound.set', { ipv4: ipv4 || null, ipv6: ipv6 || null }, req);
    settings.setMany({ 'mail.outbound.ipv4': ipv4 || '', 'mail.outbound.ipv6': ipv6 || '' });
    audit(req, { action: 'mail.outbound.set', target: [ipv4, ipv6].filter(Boolean).join(',') || 'none', args: { ipv4, ipv6, applied: result.applied, hooked: result.hooked } });
    if (result.hooked === false) throw Object.assign(new HttpError(409, 'outbound_not_applied', `Exim does not send from ${[ipv4, ipv6].filter(Boolean).join(' / ')} yet${result.detail ? ` (${result.detail})` : ''}${result.hint ? `. ${result.hint}` : ''}`), { ipv4, ipv6, applied: false, hooked: false, hint: result.hint });
    return { applied: true, ipv4, ipv6, hooked: result.hooked, file: result.file, reloaded: result.reloaded };
  }

  async function setRouting(domain, routing, req) {
    const account = stmts.visibleDomains.all().find((d) => d.domain === domain);
    stmts.upsertMailDomain.run({ domain, account_id: account ? stmts.accountByUsername.get(account.account)?.id ?? null : null, routing });
    // "applied" means Exim's local_domains / relay_to_domains lists read the
    // panel's files (verified through exim -bP), not merely that they were written.
    let applied = false;
    let hooked = null;
    let hint = null;
    let reason = null;
    if (capabilities.has('exim')) {
      const { local, relay } = routingLists();
      try {
        await op('mail.config.include.write', { name: LISTS.localDomains, content: `${MANAGED} (local mail domains)\n${local.join('\n')}\n`, reload: false, hook: false }, req);
        const write = await op('mail.config.include.write', { name: LISTS.relayDomains, content: `${MANAGED} (backup MX relay domains)\n${relay.join('\n')}\n`, reload: true, hook: true }, req);
        hooked = write.domainListsHooked ?? null;
        hint = write.hint || null;
        applied = hooked === true;
        if (!applied) reason = `Exim does not read the panel's domain lists yet${write.domainListsDetail ? ` (${write.domainListsDetail})` : ''}`;
      } catch (err) { reason = err.message; logger.warn({ err, domain }, 'mail: could not write routing lists'); }
    } else reason = eximMissing;
    audit(req, { action: 'mail.routing.set', target: domain, args: { routing, applied, hooked } });
    // The routing is saved either way; with Exim present but not reading the
    // lists the caller must not report success, so that case is an error.
    if (!applied && capabilities.has('exim')) throw Object.assign(new HttpError(409, 'routing_not_applied', `${reason}${hint ? `. ${hint}` : ''}`), { domain, routing, applied, hooked, hint, reason });
    return { domain, routing, applied, hooked, hint, reason };
  }

  return {
    detect, status, queue, reports, stats, troubleshoot, useBannerProber, deliverability, filters, greylist, mailbox, spamd,
    sendNotification, installDkimKey, removeDkimKey, setRouting, setOutboundAddresses, routingLists,
    renderAcl: () => renderAcl({ dir: 'etc/exim4/whm', ...filterSummary() }),
  };
}
