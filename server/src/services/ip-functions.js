import { notFound, conflict, forbidden, badRequest, unprocessable, serviceUnavailable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { familyOf, canonical, parseCidr, enumerateRange, nextFreeInCidr, netmaskToPrefix, prefixToNetmask, cidrContains, toValue } from './ip-math.js';

export const REMOTE_SERVICES = [
  { key: 'mail', label: 'Outgoing mail (SMTP)', help: 'Source address Exim uses when delivering mail to other servers.' },
  { key: 'dns', label: 'DNS (outbound queries / cluster sync)', help: 'Source address for recursive lookups and cluster pushes.' },
  { key: 'mysql', label: 'Remote MySQL / MariaDB', help: 'Address the panel and accounts connect from when the database server is remote.' },
  { key: 'ftp', label: 'FTP (passive / data connections)', help: 'Address advertised to FTP clients for passive data connections.' },
  { key: 'panel', label: 'Panel API (outbound requests)', help: 'Source address for license checks, transfers and remote API calls.' },
];

const MAX_RANGE_PER_ADD = 256;

// ctx.ip — bound addresses, reservations, the IP pool, IPv6 ranges and
// assignments, remote-service source IPs and the IP migration job. Other
// categories call it lazily via ctx.ip (see "helpers for other categories").
// Hooks this service calls when the owning category provides them:
//   ctx.mail.setOutboundAddresses({ ipv4, ipv6 }, req)   (email: Exim remote_smtp interface)
//   ctx.dns.setOutboundAddresses({ ipv4, ipv6 }, req)    (dns-functions: BIND query/notify/transfer source)
//   ctx.databases.setClientAddresses({ ipv4, ipv6 }, req) (database-services: MySQL client bind-address)
//   ctx.ftp.setPassiveAddress({ ipv4 }, req)             (service-configuration)
//   ctx.dns.zoneFor / zoneExists / upsertRecords, ctx.web.setAccountIpv6 / replaceIp
// A missing hook or a missing daemon (CapabilityError) leaves the value 'saved'.
// IPv6 assign/unassign is open to resellers for their own accounts (WHM keeps the
// whole category root-only): the service enforces ownership and the range → account
// mapping, so a reseller can only bind addresses root handed out to them.
export function createIpService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;

  const stmts = {
    all: db.prepare(`SELECT i.*, a.username AS dedicated_account, a.owner_id AS dedicated_owner_id FROM ip_addresses i LEFT JOIN accounts a ON a.id = i.dedicated_to ORDER BY i.family, i.is_main DESC, i.address`),
    byAddress: db.prepare(`SELECT i.*, a.username AS dedicated_account, a.owner_id AS dedicated_owner_id FROM ip_addresses i LEFT JOIN accounts a ON a.id = i.dedicated_to WHERE i.address = ?`),
    insert: db.prepare(`INSERT INTO ip_addresses (address, family, netmask, interface, is_main, reserved, reserved_reason, dedicated_to, managed) VALUES (@address, @family, @netmask, @interface, @is_main, @reserved, @reserved_reason, @dedicated_to, @managed)`),
    remove: db.prepare('DELETE FROM ip_addresses WHERE address = ?'),
    persistable: db.prepare('SELECT * FROM ip_addresses WHERE is_main = 0 AND managed = 1 AND interface IS NOT NULL ORDER BY id'),
    setReserved: db.prepare('UPDATE ip_addresses SET reserved = ?, reserved_reason = ? WHERE address = ?'),
    setMain: db.prepare('UPDATE ip_addresses SET is_main = CASE WHEN address = ? THEN 1 ELSE 0 END'),
    setDedicated: db.prepare('UPDATE ip_addresses SET dedicated_to = ? WHERE address = ?'),
    setIface: db.prepare('UPDATE ip_addresses SET interface = COALESCE(?, interface), netmask = COALESCE(?, netmask) WHERE address = ?'),
    nextId: db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ip_addresses'),
    accountsUsing: db.prepare('SELECT id, username, domain, owner_id FROM accounts WHERE ip = ? ORDER BY username'),
    accountsUsingAny: db.prepare('SELECT ip, COUNT(*) AS n FROM accounts WHERE ip IS NOT NULL GROUP BY ip'),
    accountsWithIp: db.prepare('SELECT a.id, a.username, a.domain, a.ip, a.owner_id, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id ORDER BY a.username'),
    accountByUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    accountDomains: db.prepare("SELECT domain FROM account_domains WHERE account_id = ? AND type IN ('main', 'addon', 'parked', 'sub', 'alias') ORDER BY type, domain"),
    updateAccountIp: db.prepare("UPDATE accounts SET ip = ?, updated_at = datetime('now') WHERE ip = ?"),
    setAccountIp: db.prepare("UPDATE accounts SET ip = ?, updated_at = datetime('now') WHERE id = ?"),
    // Pool
    poolClear: db.prepare('DELETE FROM ip_pool'),
    poolInsert: db.prepare(`INSERT INTO ip_pool (address, family, interface, state, account_id, in_db, on_system) VALUES (@address, @family, @interface, @state, @account_id, @in_db, @on_system)`),
    pool: db.prepare('SELECT p.*, a.username AS account FROM ip_pool p LEFT JOIN accounts a ON a.id = p.account_id ORDER BY p.family, p.state, p.address'),
    // IPv6 ranges
    ranges: db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM ipv6_range_accounts ra WHERE ra.range_id = r.id) AS account_count, (SELECT COUNT(*) FROM ipv6_assignments s WHERE s.range_id = r.id) AS assigned_count FROM ipv6_ranges r ORDER BY r.name`),
    rangeById: db.prepare('SELECT * FROM ipv6_ranges WHERE id = ?'),
    rangeByName: db.prepare('SELECT * FROM ipv6_ranges WHERE name = ?'),
    rangeByCidr: db.prepare('SELECT * FROM ipv6_ranges WHERE range_cidr = ?'),
    insertRange: db.prepare('INSERT INTO ipv6_ranges (name, range_cidr, first_address, last_address, interface, enabled, notes) VALUES (@name, @range_cidr, @first_address, @last_address, @interface, @enabled, @notes)'),
    updateRange: db.prepare("UPDATE ipv6_ranges SET name = @name, range_cidr = @range_cidr, first_address = @first_address, last_address = @last_address, interface = @interface, enabled = @enabled, notes = @notes, updated_at = datetime('now') WHERE id = @id"),
    deleteRange: db.prepare('DELETE FROM ipv6_ranges WHERE id = ?'),
    rangeAccounts: db.prepare('SELECT a.id, a.username, a.domain, a.owner_id FROM ipv6_range_accounts ra JOIN accounts a ON a.id = ra.account_id WHERE ra.range_id = ? ORDER BY a.username'),
    rangesForAccount: db.prepare('SELECT r.* FROM ipv6_range_accounts ra JOIN ipv6_ranges r ON r.id = ra.range_id WHERE ra.account_id = ? ORDER BY r.enabled DESC, r.name'),
    clearRangeAccounts: db.prepare('DELETE FROM ipv6_range_accounts WHERE range_id = ?'),
    addRangeAccount: db.prepare('INSERT OR IGNORE INTO ipv6_range_accounts (range_id, account_id) VALUES (?, ?)'),
    assignments: db.prepare(`SELECT s.*, a.username, a.domain, a.owner_id, r.name AS range_name, r.range_cidr FROM ipv6_assignments s JOIN accounts a ON a.id = s.account_id LEFT JOIN ipv6_ranges r ON r.id = s.range_id ORDER BY a.username`),
    assignmentByAccount: db.prepare('SELECT s.*, r.name AS range_name, r.range_cidr, r.interface AS range_interface FROM ipv6_assignments s LEFT JOIN ipv6_ranges r ON r.id = s.range_id WHERE s.account_id = ?'),
    assignmentByAddress: db.prepare('SELECT * FROM ipv6_assignments WHERE address = ?'),
    insertAssignment: db.prepare('INSERT INTO ipv6_assignments (account_id, range_id, address) VALUES (?, ?, ?)'),
    moveAssignment: db.prepare('UPDATE ipv6_assignments SET address = ?, range_id = ? WHERE address = ?'),
    deleteAssignment: db.prepare('DELETE FROM ipv6_assignments WHERE account_id = ?'),
    assignedInRange: db.prepare('SELECT address FROM ipv6_assignments WHERE range_id = ?'),
    dnsRecordsWithValue: db.prepare("SELECT r.id, r.name, r.type, r.value, z.domain, z.account_id FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id WHERE r.type IN ('A', 'AAAA') AND r.value = ? ORDER BY z.domain, r.name"),
    dnsRecordsByNameType: db.prepare("SELECT r.id, r.value, r.ttl FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id WHERE z.domain = ? AND r.name = ? AND r.type = ? ORDER BY r.line_index, r.id"),
  };

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  // A request-like principal for work that runs outside an HTTP request (jobs),
  // so agent ops and audit rows still name who started it.
  function actorRequest(userId, requestId) {
    const user = userId ? db.prepare('SELECT username, role FROM users WHERE id = ?').get(userId) : null;
    if (!user) return null;
    const req = { user, ip: null, id: requestId ?? null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }
  const ipAvailable = () => capabilities.has('iproute2');
  const requireIproute2 = () => { if (!ipAvailable()) throw new CapabilityError('iproute2', 'iproute2 (the `ip` command) is not installed on this server. Install the iproute2 package to bind or remove addresses.'); };
  const setting = (key, fallback) => settings.get(key, fallback);
  const isCapabilityMissing = (err) => err instanceof CapabilityError || err?.code === 'capability_missing';

  // 'applied' | 'pending' (the web service stored the vhost spec but Apache is not
  // installed; the next sync applies it) | 'failed' | 'skipped' (no web service).
  async function applyWebIpv6(username, address, req) {
    if (typeof ctx.web?.setAccountIpv6 !== 'function') return 'skipped';
    try {
      await ctx.web.setAccountIpv6(username, address, req);
      return 'applied';
    } catch (err) {
      if (isCapabilityMissing(err)) return 'pending';
      logger.warn({ err, username }, 'web service could not apply the IPv6 address');
      return 'failed';
    }
  }

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id, address: row.address, family: row.family, netmask: row.netmask, prefix: row.family === 4 ? netmaskToPrefix(row.netmask) : (row.netmask ? Number(row.netmask) : null),
      interface: row.interface, is_main: Boolean(row.is_main), reserved: Boolean(row.reserved), reserved_reason: row.reserved_reason,
      dedicated_to: row.dedicated_account ?? null, managed: Boolean(row.managed), created_at: row.created_at,
    };
  }

  // DHCP/SLAAC leases and rotating IPv6 privacy addresses: the host owns them, so
  // the panel must never re-add them at boot or hand them to an account.
  const isVolatile = (a) => Boolean(a.dynamic || a.temporary || a.deprecated);

  function shapeRange(row) {
    if (!row) return null;
    const c = parseCidr(row.range_cidr);
    return { ...row, enabled: Boolean(row.enabled), prefix: c.prefix, size: c.size > 2n ** 53n ? Number.MAX_SAFE_INTEGER : Number(c.size), size_text: c.size.toString() };
  }

  async function liveInterfaces() {
    try { return await agent.op('net.ip.list', {}); } catch (err) { logger.warn({ err }, 'could not list interfaces'); return null; }
  }

  async function defaultRoutes() {
    try { return await agent.op('net.route.default', {}); } catch { return { ipv4: null, ipv6: null }; }
  }

  // Addresses that count as "on the host": global scope, no loopback/link-local.
  function globalAddresses(live) {
    const out = [];
    for (const iface of live?.interfaces || []) {
      if (iface.loopback) continue;
      for (const a of iface.addresses || []) {
        if (a.scope && a.scope !== 'global') continue;
        if (/^(127\.|169\.254\.|fe80:|::1$)/i.test(a.address)) continue;
        let address;
        try { address = canonical(a.address); } catch { continue; }
        out.push({ ...a, address, interface: iface.name });
      }
    }
    return out;
  }

  async function mainIpDetect(live, routes) {
    const configured = setting('basic.main_ip');
    if (configured) return configured;
    const dbMain = db.prepare('SELECT address FROM ip_addresses WHERE is_main = 1 AND family = 4').get();
    if (dbMain) return dbMain.address;
    if (routes?.ipv4?.prefsrc) return routes.ipv4.prefsrc;
    return globalAddresses(live).find((a) => a.family === 4)?.address ?? null;
  }

  function usersOf(address) {
    const accounts = stmts.accountsUsing.all(address);
    const row = stmts.byAddress.get(address);
    const v6 = stmts.assignmentByAddress.get(address);
    const uses = [];
    if (row?.is_main || setting('basic.main_ip') === address) uses.push('main server IP');
    if (setting('basic.shared_ip') === address) uses.push('shared virtual host IP');
    if (row?.dedicated_to) uses.push(`dedicated to ${row.dedicated_account}`);
    if (v6) uses.push(`IPv6 address of ${stmts.accountById.get(v6.account_id)?.username ?? `account #${v6.account_id}`}`);
    for (const s of REMOTE_SERVICES) for (const f of ['ipv4', 'ipv6']) if (setting(`ip.remote.${s.key}_${f}`) === address) uses.push(`${s.label} source IP`);
    return { accounts, uses, inUse: accounts.length > 0 || uses.length > 0 };
  }

  function loadAccount(username, user) {
    const account = stmts.accountByUsername.get(username);
    if (!account) throw notFound('Account');
    if (!isRoot(user) && account.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return account;
  }

  async function pickInterface(family, live, routes) {
    const route = family === 6 ? routes?.ipv6 : routes?.ipv4;
    if (route?.dev) return route.dev;
    const main = db.prepare('SELECT interface FROM ip_addresses WHERE is_main = 1 AND interface IS NOT NULL').get();
    if (main?.interface) return main.interface;
    const first = globalAddresses(live).find((a) => a.family === family) || globalAddresses(live)[0];
    return first?.interface ?? null;
  }

  // Writes the boot-time inventory from every managed non-main address with a known interface.
  async function persist(req) {
    if (!setting('ip.persist_on_boot', true)) return { skipped: true };
    const rows = stmts.persistable.all();
    const addresses = rows.map((r) => {
      const prefix = r.family === 4 ? (netmaskToPrefix(r.netmask) ?? 32) : (Number(r.netmask) || 128);
      const label = `whm${r.id}`;
      return { address: r.address, prefix, iface: r.interface, ...(r.family === 4 && `${r.interface}:${label}`.length <= 15 ? { label } : {}) };
    });
    try {
      return { ...(await agent.op('net.persist.write', { addresses }, { req })), skipped: false };
    } catch (err) {
      logger.warn({ err }, 'could not persist IP inventory');
      return { skipped: false, error: err.message, code: err.code };
    }
  }

  async function bind(address, { prefix, iface, label }, req) {
    requireIproute2();
    return agent.op('net.ip.add', { address, prefix, iface, ...(label ? { label } : {}) }, { req });
  }

  async function unbind(row, live, req) {
    const bound = globalAddresses(live).find((a) => a.address === row.address);
    if (!bound) return { removed: false, existed: false };
    requireIproute2();
    const prefix = row.family === 4 ? (netmaskToPrefix(row.netmask) ?? bound.prefix ?? 32) : (Number(row.netmask) || bound.prefix || 128);
    return agent.op('net.ip.del', { address: row.address, prefix, iface: row.interface || bound.interface }, { req });
  }

  function insertAddress({ address, family, prefix, interface: iface, reserved = false, reason = null, dedicatedTo = null, managed = true }) {
    stmts.insert.run({ address, family, netmask: family === 4 ? prefixToNetmask(prefix) : String(prefix), interface: iface, is_main: 0, reserved: reserved ? 1 : 0, reserved_reason: reserved ? reason : null, dedicated_to: dedicatedTo, managed: managed ? 1 : 0 });
    return stmts.byAddress.get(address);
  }

  // Shared by "Add a New IP Address" and the migration job.
  async function addAddressesInternal({ addresses, prefix, iface, reserved, reason }, req) {
    const added = [];
    const failed = [];
    for (const address of addresses) {
      const family = familyOf(address);
      try {
        if (stmts.byAddress.get(address)) throw conflict(`${address} is already recorded on this server`);
        const label = family === 4 && `${iface}:whm${stmts.nextId.get().n}`.length <= 15 ? `whm${stmts.nextId.get().n}` : undefined;
        const result = await bind(address, { prefix, iface, label }, req);
        const row = insertAddress({ address, family, prefix, interface: iface, reserved, reason });
        added.push({ ...shape(row), bound: result.added || result.existed, alreadyBound: Boolean(result.existed) });
      } catch (err) {
        if (err instanceof CapabilityError) throw err;
        failed.push({ address, error: err.message, code: err.code || 'error' });
      }
    }
    return { added, failed };
  }

  function dnsRecordsPlan(from) {
    return stmts.dnsRecordsWithValue.all(from).map((r) => ({ id: r.id, domain: r.domain, name: r.name, type: r.type, value: r.value }));
  }

  // Replaces `from` with `to` in every A/AAAA record that carries it, zone by zone,
  // through ctx.dns so the zone files are re-rendered and reloaded.
  async function rewriteDnsRecords(from, to, jobCtx, req) {
    const dns = ctx.dns;
    const touched = { zones: 0, records: 0, failed: 0 };
    if (!dns?.upsertRecords) { jobCtx?.log('DNS service not available; zone records left unchanged', 'warn'); return { ...touched, skipped: true }; }
    const type = familyOf(to) === 6 ? 'AAAA' : 'A';
    const groups = new Map();
    for (const r of stmts.dnsRecordsWithValue.all(from)) {
      if (r.type !== type) continue;
      const key = `${r.domain}\n${r.name}`;
      if (!groups.has(key)) groups.set(key, { domain: r.domain, name: r.name, type: r.type });
    }
    for (const g of groups.values()) {
      const values = stmts.dnsRecordsByNameType.all(g.domain, g.name, g.type).map((r) => ({ value: r.value === from ? to : r.value, ttl: r.ttl }));
      const unique = values.filter((v, i, arr) => arr.findIndex((x) => x.value === v.value) === i);
      try {
        await dns.upsertRecords(g.domain, g.name === '@' ? g.domain : `${g.name}.${g.domain}`, g.type, unique, req);
        touched.zones++;
        touched.records += values.filter((v) => v.value === to).length;
        jobCtx?.log(`DNS: ${g.domain} ${g.name} ${g.type} → ${to}`);
      } catch (err) {
        touched.failed++;
        jobCtx?.log(`DNS: ${g.domain} ${g.name}: ${err.message}`, 'error');
      }
    }
    return touched;
  }

  // The zone that holds `domain`: its own zone, or the closest enclosing one for
  // addon/sub/parked domains that live inside a parent zone.
  function enclosingZone(dns, domain) {
    if (dns.zoneExists?.(domain)) return domain;
    if (typeof dns.zoneFor !== 'function') return null;
    return dns.zoneFor(domain)?.domain ?? null;
  }

  async function updateAccountDns(account, address, type, jobCtx, req) {
    const dns = ctx.dns;
    const results = [];
    if ((!dns?.zoneExists && !dns?.zoneFor) || !dns?.upsertRecords) return { skipped: true, results };
    const domains = [...new Set([account.domain, ...stmts.accountDomains.all(account.id).map((d) => d.domain)])];
    for (const domain of domains) {
      const zone = enclosingZone(dns, domain);
      if (!zone) { results.push({ domain, status: 'no_zone' }); continue; }
      try {
        const values = address ? [{ value: address }] : [];
        await dns.upsertRecords(zone, domain, type, values, req);
        await dns.upsertRecords(zone, `www.${domain}`, type, values, req);
        results.push({ domain, zone, status: 'updated' });
        jobCtx?.log(`DNS: ${domain}${zone !== domain ? ` (zone ${zone})` : ''} ${type} ${address ? `→ ${address}` : 'removed'}`);
      } catch (err) {
        results.push({ domain, zone, status: 'failed', error: err.message });
      }
    }
    return { skipped: false, results };
  }

  // Addresses a service may use as its source: bound on the host right now and
  // not a DHCP/SLAAC lease. Falls back to the managed inventory when the host
  // view is unavailable.
  async function sourceCandidates() {
    const live = await liveInterfaces();
    if (live?.interfaces?.length) {
      const volatileAddresses = new Set(globalAddresses(live).filter(isVolatile).map((a) => a.address));
      const unmanaged = new Set(stmts.all.all().filter((r) => !r.managed).map((r) => r.address));
      return { live: true, addresses: globalAddresses(live).map((a) => a.address).filter((a) => !volatileAddresses.has(a) && !unmanaged.has(a)) };
    }
    return { live: false, addresses: stmts.all.all().filter((r) => r.managed).map((r) => r.address) };
  }

  const service = {
    // ------------------------------------------------------------ addresses
    async listAddresses({ family, live = true } = {}) {
      const rows = stmts.all.all().filter((r) => !family || r.family === Number(family));
      const liveData = live ? await liveInterfaces() : null;
      const routes = live ? await defaultRoutes() : null;
      const bound = new Map(globalAddresses(liveData).map((a) => [a.address, a]));
      const usage = new Map(stmts.accountsUsingAny.all().map((r) => [r.ip, r.n]));
      const mainIp = await mainIpDetect(liveData, routes);
      const data = rows.map((r) => ({
        ...shape(r), is_main: Boolean(r.is_main) || r.address === mainIp,
        bound: liveData ? bound.has(r.address) : null, live_interface: bound.get(r.address)?.interface ?? null,
        accounts: usage.get(r.address) || 0,
        protected: Boolean(r.is_main) || r.address === mainIp || r.address === routes?.ipv4?.prefsrc || r.address === routes?.ipv6?.prefsrc,
      }));
      const unmanaged = [...bound.values()].filter((a) => !rows.some((r) => r.address === a.address)).map((a) => ({ address: a.address, family: a.family, prefix: a.prefix, netmask: a.netmask, interface: a.interface, dynamic: Boolean(a.dynamic), temporary: Boolean(a.temporary), volatile: isVolatile(a) }));
      return { data, meta: { total: data.length, mainIp, source: liveData?.source ?? null, iproute2: ipAvailable(), unmanaged, routes } };
    },

    async interfaces() {
      const live = await liveInterfaces();
      const routes = await defaultRoutes();
      const interfaces = (live?.interfaces || []).filter((i) => !i.loopback).map((i) => ({ name: i.name, state: i.state, up: i.up, mac: i.mac, mtu: i.mtu, addresses: i.addresses }));
      return { interfaces, routes, source: live?.source ?? null, iproute2: ipAvailable(), suggested: { ipv4: await pickInterface(4, live, routes), ipv6: await pickInterface(6, live, routes) } };
    },

    async addAddress(input, user, req) {
      requireIproute2();
      const start = canonical(input.address);
      const family = familyOf(start);
      let prefix = input.prefix ?? netmaskToPrefix(input.netmask);
      if (input.netmask && input.prefix == null && prefix == null) throw unprocessable('Invalid netmask', { netmask: ['Not a contiguous netmask or prefix length'] });
      if (prefix == null) prefix = family === 4 ? 24 : 64;
      if (family === 4 && prefix > 32) throw unprocessable('Invalid netmask', { netmask: ['IPv4 prefixes cannot exceed /32'] });
      // A /0 address would install a default on-link route and break routing.
      if (prefix < 1) throw unprocessable('Invalid netmask', { netmask: ['A /0 prefix cannot be bound to an interface'] });
      let addresses;
      try {
        addresses = input.endAddress ? enumerateRange(start, canonical(input.endAddress), { max: MAX_RANGE_PER_ADD }) : [start];
      } catch (err) { throw unprocessable(err.message, { endAddress: [err.message] }); }
      for (const a of addresses) if (/^(127\.|0\.|169\.254\.|fe80:|::1$|::$)/i.test(a)) throw unprocessable(`${a} is a loopback or link-local address`, { address: ['Loopback and link-local addresses cannot be bound'] });
      const live = await liveInterfaces();
      const routes = await defaultRoutes();
      const iface = input.interface || await pickInterface(family, live, routes);
      if (!iface) throw badRequest('No network interface was given and none could be detected');
      if (live?.interfaces?.length && !live.interfaces.some((i) => i.name === iface)) throw unprocessable(`Interface "${iface}" does not exist on this server`, { interface: [`Known interfaces: ${live.interfaces.map((i) => i.name).join(', ')}`] });
      const { added, failed } = await addAddressesInternal({ addresses, prefix, iface, reserved: Boolean(input.reserved), reason: input.reservedReason || null }, req);
      const persisted = added.length ? await persist(req) : { skipped: true };
      audit(req, { action: 'ip.add', target: addresses.length === 1 ? start : `${start}-${addresses.at(-1)}`, args: { count: addresses.length, prefix, interface: iface, reserved: Boolean(input.reserved), added: added.length, failed: failed.length } });
      if (!added.length && failed.length) throw conflict(failed.length === 1 ? failed[0].error : `None of the ${failed.length} addresses could be added: ${failed[0].error}`);
      return { added, failed, prefix, interface: iface, persisted };
    },

    async deleteAddress(address, user, req) {
      const row = stmts.byAddress.get(canonical(address));
      if (!row) throw notFound(`IP address ${address}`);
      const live = await liveInterfaces();
      if (!live) throw serviceUnavailable('Could not read the host\'s interfaces, so the address was left alone; try again');
      const routes = await defaultRoutes();
      const mainIp = await mainIpDetect(live, routes);
      if (row.is_main || row.address === mainIp || row.address === routes?.ipv4?.prefsrc || row.address === routes?.ipv6?.prefsrc) throw badRequest(`${row.address} is the server's main IP address and cannot be removed`);
      const usage = usersOf(row.address);
      if (usage.inUse) throw conflict(`${row.address} is in use (${[...usage.uses, ...usage.accounts.map((a) => `account ${a.username}`)].join('; ')}). Move those first.`);
      // A DHCP/SLAAC address is the host's: dropping it from the inventory must not touch the interface.
      const result = row.managed ? await unbind(row, live, req) : { removed: false, existed: globalAddresses(live).some((a) => a.address === row.address) };
      stmts.remove.run(row.address);
      const persisted = await persist(req);
      audit(req, { action: 'ip.delete', target: row.address, args: { interface: row.interface, managed: Boolean(row.managed), removedFromSystem: result.removed } });
      return { address: row.address, deleted: true, managed: Boolean(row.managed), removedFromSystem: result.removed, wasBound: result.existed, persisted };
    },

    // ---------------------------------------------------------------- usage
    async usage(user) {
      const live = await liveInterfaces();
      const bound = new Set(globalAddresses(live).map((a) => a.address));
      const accounts = stmts.accountsWithIp.all().filter((a) => isRoot(user) || a.owner_id === user.id);
      const byIp = new Map();
      for (const a of accounts) { if (!a.ip) continue; if (!byIp.has(a.ip)) byIp.set(a.ip, []); byIp.get(a.ip).push({ username: a.username, domain: a.domain, owner: a.owner }); }
      const v6 = new Map(stmts.assignments.all().filter((s) => isRoot(user) || s.owner_id === user.id).map((s) => [s.address, s]));
      const rows = stmts.all.all().filter((r) => isRoot(user) || byIp.has(r.address) || v6.has(r.address) || r.dedicated_owner_id === user.id);
      const mainIp = isRoot(user) ? await mainIpDetect(live, await defaultRoutes()) : null;
      const data = rows.map((r) => {
        const users = byIp.get(r.address) || [];
        const dedicated = r.dedicated_account ? (isRoot(user) || r.dedicated_owner_id === user.id ? r.dedicated_account : '(another reseller)') : null;
        const assignment = v6.get(r.address);
        const status = r.is_main || r.address === mainIp ? 'main' : r.reserved ? 'reserved' : dedicated || assignment ? 'dedicated' : users.length ? 'shared' : !r.managed ? 'unmanaged' : 'free';
        return { ...shape(r), is_main: Boolean(r.is_main) || r.address === mainIp, dedicated_to: dedicated, ipv6_account: assignment?.username ?? null, accounts: users, account_count: users.length, status, bound: live ? bound.has(r.address) : null, shared_ip: setting('basic.shared_ip') === r.address };
      });
      const unknown = [...byIp.entries()].filter(([ip]) => !rows.some((r) => r.address === ip)).map(([ip, users]) => ({ address: ip, family: familyOf(ip), accounts: users, account_count: users.length, status: 'unknown', bound: live ? bound.has(ip) : null, unknown: true }));
      return { data: [...data, ...unknown], meta: { total: data.length + unknown.length, mainIp, sharedIp: isRoot(user) ? setting('basic.shared_ip') || null : null, summary: { main: data.filter((d) => d.status === 'main').length, reserved: data.filter((d) => d.status === 'reserved').length, dedicated: data.filter((d) => d.status === 'dedicated').length, shared: data.filter((d) => d.status === 'shared').length, free: data.filter((d) => d.status === 'free').length, unmanaged: data.filter((d) => d.status === 'unmanaged').length, unknown: unknown.length } } };
    },

    // ------------------------------------------------------------- reserved
    listReserved() {
      const usage = new Map(stmts.accountsUsingAny.all().map((r) => [r.ip, r.n]));
      return stmts.all.all().map((r) => ({ ...shape(r), accounts: usage.get(r.address) || 0, reservable: Boolean(r.managed) && !r.is_main && !r.dedicated_to && !(usage.get(r.address) > 0) && !stmts.assignmentByAddress.get(r.address) }));
    },

    setReserved(address, { reserved, reason }, user, req) {
      const row = stmts.byAddress.get(canonical(address));
      if (!row) throw notFound(`IP address ${address}`);
      if (reserved) {
        if (row.is_main || setting('basic.main_ip') === row.address) throw badRequest('The main IP address cannot be reserved');
        if (!row.managed) throw badRequest(`${row.address} is a dynamic address owned by the host and cannot be reserved`);
        const usage = usersOf(row.address);
        if (usage.inUse) throw conflict(`${row.address} is in use (${[...usage.uses, ...usage.accounts.map((a) => `account ${a.username}`)].join('; ')}) and cannot be reserved`);
      }
      stmts.setReserved.run(reserved ? 1 : 0, reserved ? (reason || null) : null, row.address);
      audit(req, { action: reserved ? 'ip.reserve' : 'ip.unreserve', target: row.address, args: { reason } });
      return shape(stmts.byAddress.get(row.address));
    },

    setReservedBulk(items, user, req) {
      const results = [];
      for (const item of items) {
        try { results.push({ address: item.address, ok: true, row: service.setReserved(item.address, item, user, req) }); } catch (err) { results.push({ address: item.address, ok: false, error: err.message, code: err.code }); }
      }
      return { results };
    },

    // ----------------------------------------------------------------- pool
    async rebuildPool(user, req) {
      const live = await liveInterfaces();
      if (!live) throw new CapabilityError('iproute2', 'Could not read the host\'s network interfaces; the agent did not answer');
      const routes = await defaultRoutes();
      const system = globalAddresses(live);
      const mainIp = await mainIpDetect(live, routes);
      const summary = { added: [], missing: [], updated: [], unmanaged: [], dropped: [], main: mainIp, total: 0, states: {} };
      db.transaction(() => {
        const existing = new Map(stmts.all.all().map((r) => [r.address, r]));
        for (const a of system) {
          const row = existing.get(a.address);
          if (!row) {
            const managed = !isVolatile(a);
            insertAddress({ address: a.address, family: a.family, prefix: a.prefix ?? (a.family === 4 ? 32 : 128), interface: a.interface, managed });
            (managed ? summary.added : summary.unmanaged).push(a.address);
          } else if (row.interface !== a.interface || (a.family === 4 && a.netmask && row.netmask !== a.netmask)) {
            stmts.setIface.run(a.interface, a.family === 4 ? a.netmask : (a.prefix != null ? String(a.prefix) : null), a.address);
            summary.updated.push(a.address);
          }
        }
        if (mainIp) {
          if (!existing.has(mainIp) && !system.some((a) => a.address === mainIp)) insertAddress({ address: mainIp, family: familyOf(mainIp), prefix: familyOf(mainIp) === 4 ? 32 : 128, interface: routes?.ipv4?.dev ?? null });
          stmts.setMain.run(mainIp);
        }
        const usage = new Map(stmts.accountsUsingAny.all().map((r) => [r.ip, r.n]));
        const onSystem = new Set(system.map((a) => a.address));
        stmts.poolClear.run();
        for (const r of stmts.all.all()) {
          const v6 = stmts.assignmentByAddress.get(r.address);
          const inSystem = onSystem.has(r.address);
          let state = 'free';
          let accountId = null;
          if (r.is_main) state = 'main';
          else if (r.reserved) state = 'reserved';
          else if (r.dedicated_to || v6) { state = 'dedicated'; accountId = r.dedicated_to ?? v6?.account_id ?? null; }
          else if (usage.get(r.address) > 0) state = 'shared';
          else if (!r.managed) state = 'unmanaged';
          // A lease or privacy address that left the host is gone for good; it only mirrors host state.
          if (state === 'unmanaged' && !inSystem) { stmts.remove.run(r.address); summary.dropped.push(r.address); continue; }
          if (!inSystem && state === 'free') { state = 'missing'; summary.missing.push(r.address); }
          else if (!inSystem) summary.missing.push(r.address);
          stmts.poolInsert.run({ address: r.address, family: r.family, interface: r.interface, state, account_id: accountId, in_db: 1, on_system: inSystem ? 1 : 0 });
          summary.total++;
          summary.states[state] = (summary.states[state] || 0) + 1;
        }
      })();
      settings.set('ip.pool_last_rebuild', new Date().toISOString());
      const persisted = await persist(req);
      audit(req, { action: 'ip.pool.rebuild', target: 'pool', args: { added: summary.added.length, unmanaged: summary.unmanaged.length, dropped: summary.dropped.length, missing: summary.missing.length, updated: summary.updated.length, main: mainIp } });
      return { ...summary, source: live.source, persisted };
    },

    getPool() {
      return { data: stmts.pool.all().map((p) => ({ ...p, in_db: Boolean(p.in_db), on_system: Boolean(p.on_system) })), meta: { lastRebuild: setting('ip.pool_last_rebuild', null), iproute2: ipAvailable() } };
    },

    // ---------------------------------------------------------- IPv6 ranges
    listRanges() {
      return stmts.ranges.all().map((r) => ({ ...shapeRange(r), accounts: stmts.rangeAccounts.all(r.id).map((a) => a.username) }));
    },

    getRange(id) {
      const row = stmts.rangeById.get(id);
      if (!row) throw notFound('IPv6 range');
      const accounts = stmts.rangeAccounts.all(id);
      const assigned = stmts.assignments.all().filter((s) => s.range_id === id).map((s) => ({ username: s.username, address: s.address, created_at: s.created_at }));
      return { ...shapeRange(row), accounts: accounts.map((a) => a.username), assigned, account_count: accounts.length, assigned_count: assigned.length };
    },

    createRange(input, user, req) {
      const cidr = parseRangeInput(input.range);
      if (stmts.rangeByName.get(input.name)) throw conflict(`A range named "${input.name}" already exists`);
      if (stmts.rangeByCidr.get(cidr.network)) throw conflict(`${cidr.network} is already defined`);
      for (const r of stmts.ranges.all()) {
        const other = parseCidr(r.range_cidr);
        if (cidr.firstValue <= other.lastValue && other.firstValue <= cidr.lastValue) throw conflict(`${cidr.network} overlaps the existing range "${r.name}" (${r.range_cidr})`);
      }
      const { lastInsertRowid } = stmts.insertRange.run({ name: input.name, range_cidr: cidr.network, first_address: cidr.first, last_address: cidr.last, interface: input.interface || null, enabled: input.enabled === false ? 0 : 1, notes: input.notes || null });
      audit(req, { action: 'ipv6.range.create', target: input.name, args: { range: cidr.network } });
      return service.getRange(Number(lastInsertRowid));
    },

    updateRange(id, patch, user, req) {
      const row = stmts.rangeById.get(id);
      if (!row) throw notFound('IPv6 range');
      let cidr = parseCidr(row.range_cidr);
      if (patch.range && parseRangeInput(patch.range).network !== row.range_cidr) {
        if (stmts.assignments.all().some((s) => s.range_id === id)) throw conflict('Change the range only when no address is assigned from it');
        cidr = parseRangeInput(patch.range);
        if (stmts.rangeByCidr.get(cidr.network)) throw conflict(`${cidr.network} is already defined`);
      }
      if (patch.name && patch.name !== row.name && stmts.rangeByName.get(patch.name)) throw conflict(`A range named "${patch.name}" already exists`);
      stmts.updateRange.run({ id, name: patch.name ?? row.name, range_cidr: cidr.network, first_address: cidr.first, last_address: cidr.last, interface: patch.interface === undefined ? row.interface : (patch.interface || null), enabled: patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0), notes: patch.notes === undefined ? row.notes : (patch.notes || null) });
      audit(req, { action: 'ipv6.range.update', target: row.name, args: patch });
      return service.getRange(id);
    },

    deleteRange(id, user, req) {
      const row = stmts.rangeById.get(id);
      if (!row) throw notFound('IPv6 range');
      const inUse = stmts.assignments.all().filter((s) => s.range_id === id);
      if (inUse.length) throw conflict(`${inUse.length} account(s) still hold an address from this range: ${inUse.map((s) => s.username).join(', ')}`);
      stmts.deleteRange.run(id);
      audit(req, { action: 'ipv6.range.delete', target: row.name, args: { range: row.range_cidr } });
      return { deleted: true, id };
    },

    setRangeAccounts(id, usernames, user, req) {
      const row = stmts.rangeById.get(id);
      if (!row) throw notFound('IPv6 range');
      const accounts = usernames.map((u) => { const a = stmts.accountByUsername.get(u); if (!a) throw notFound(`Account ${u}`); return a; });
      db.transaction(() => { stmts.clearRangeAccounts.run(id); for (const a of accounts) stmts.addRangeAccount.run(id, a.id); })();
      audit(req, { action: 'ipv6.range.accounts', target: row.name, args: { accounts: usernames } });
      return service.getRange(id);
    },

    previewRange(id, { count = 5 } = {}) {
      const row = stmts.rangeById.get(id);
      if (!row) throw notFound('IPv6 range');
      const taken = [...stmts.assignedInRange.all(id).map((s) => s.address), ...stmts.all.all().filter((r) => r.family === 6).map((r) => r.address)];
      return { range: row.range_cidr, next: nextFreeInCidr(row.range_cidr, taken, { count }), taken: taken.filter((t) => cidrContains(row.range_cidr, t)).length };
    },

    // ----------------------------------------------------- IPv6 assignments
    listAssignments(user, { account } = {}) {
      return stmts.assignments.all().filter((s) => (isRoot(user) || s.owner_id === user.id) && (!account || s.username === account)).map((s) => ({ account: s.username, domain: s.domain, address: s.address, range_id: s.range_id, range: s.range_name, range_cidr: s.range_cidr, created_at: s.created_at }));
    },

    async assignIpv6(username, { rangeId, address: wanted } = {}, user, req) {
      const account = loadAccount(username, user);
      if (stmts.assignmentByAccount.get(account.id)) throw conflict(`${username} already has an IPv6 address; remove it first`);
      const allowed = stmts.rangesForAccount.all(account.id);
      let range = null;
      if (rangeId) {
        range = stmts.rangeById.get(rangeId);
        if (!range) throw notFound('IPv6 range');
        if (!isRoot(user) && !allowed.some((r) => r.id === range.id)) throw forbidden('That range is not assigned to this account');
      } else {
        range = allowed.find((r) => r.enabled) || (isRoot(user) ? stmts.ranges.all().find((r) => r.enabled) || null : null);
        if (!range) throw badRequest(isRoot(user) ? 'No enabled IPv6 range exists; create one under IPv6 Ranges first' : 'No IPv6 range is assigned to this account');
      }
      if (!range.enabled) throw badRequest(`Range "${range.name}" is disabled`);
      const taken = [...stmts.assignedInRange.all(range.id).map((s) => s.address), ...stmts.all.all().filter((r) => r.family === 6).map((r) => r.address)];
      let address;
      if (wanted) {
        address = canonical(wanted);
        if (!cidrContains(range.range_cidr, address)) throw unprocessable(`${address} is not inside ${range.range_cidr}`, { address: [`Must be inside ${range.range_cidr}`] });
        if (taken.includes(address)) throw conflict(`${address} is already in use`);
      } else {
        [address] = nextFreeInCidr(range.range_cidr, taken, { count: 1 });
        if (!address) throw conflict(`Range "${range.name}" has no free addresses left`);
      }
      requireIproute2();
      const live = await liveInterfaces();
      const routes = await defaultRoutes();
      const iface = range.interface || await pickInterface(6, live, routes) || await pickInterface(4, live, routes);
      if (!iface) throw badRequest('No network interface could be detected for the IPv6 address; set one on the range');
      const prefix = parseCidr(range.range_cidr).prefix;
      const bound = await bind(address, { prefix, iface }, req);
      try {
        db.transaction(() => {
          insertAddress({ address, family: 6, prefix, interface: iface, dedicatedTo: account.id });
          stmts.insertAssignment.run(account.id, range.id, address);
        })();
      } catch (err) {
        // Host first, DB second: a lost race leaves nothing bound that the inventory does not know.
        if (bound.added) await agent.op('net.ip.del', { address, prefix, iface }, { req }).catch((e) => logger.warn({ err: e, address }, 'could not unbind after a failed IPv6 assignment'));
        if (/UNIQUE|constraint/i.test(err.message)) throw conflict(`${address} was taken by another assignment; try again`);
        throw err;
      }
      const dns = await updateAccountDns(account, address, 'AAAA', null, req);
      const web = await applyWebIpv6(username, address, req);
      const persisted = await persist(req);
      audit(req, { action: 'ipv6.assign', target: username, args: { address, range: range.name, interface: iface } });
      return { account: username, address, range: range.name, range_cidr: range.range_cidr, interface: iface, prefix, bound: bound.added || bound.existed, dns, web, persisted };
    },

    async unassignIpv6(username, user, req) {
      const account = loadAccount(username, user);
      const assignment = stmts.assignmentByAccount.get(account.id);
      if (!assignment) throw notFound(`IPv6 address for ${username}`);
      const row = stmts.byAddress.get(assignment.address);
      const live = await liveInterfaces();
      if (!live) throw serviceUnavailable('Could not read the host\'s interfaces, so the IPv6 address was left in place; try again');
      const removed = row ? await unbind(row, live, req) : { removed: false, existed: false };
      const dns = await updateAccountDns(account, null, 'AAAA', null, req);
      const web = await applyWebIpv6(username, null, req);
      db.transaction(() => { stmts.deleteAssignment.run(account.id); if (row) stmts.remove.run(row.address); })();
      const persisted = await persist(req);
      audit(req, { action: 'ipv6.unassign', target: username, args: { address: assignment.address } });
      return { account: username, address: assignment.address, removed: true, removedFromSystem: removed.removed, dns, web, persisted };
    },

    // ---------------------------------------------------- remote service IPs
    async getRemoteServiceIps(candidates) {
      const { live, addresses } = candidates || await sourceCandidates();
      return {
        services: REMOTE_SERVICES.map((s) => ({ ...s, ipv4: setting(`ip.remote.${s.key}_ipv4`, '') || '', ipv6: setting(`ip.remote.${s.key}_ipv6`, '') || '' })),
        candidates: { ipv4: addresses.filter((a) => familyOf(a) === 4), ipv6: addresses.filter((a) => familyOf(a) === 6), live },
        mainIp: setting('basic.main_ip') || null,
      };
    },

    async setRemoteServiceIps(input, user, req) {
      const candidates = await sourceCandidates();
      const known = new Set(candidates.addresses);
      const fields = {};
      const values = {};
      for (const s of REMOTE_SERVICES) {
        const entry = input[s.key];
        if (!entry) continue;
        for (const f of ['ipv4', 'ipv6']) {
          if (entry[f] === undefined) continue;
          const v = entry[f] ? canonical(entry[f]) : '';
          if (v && familyOf(v) !== (f === 'ipv4' ? 4 : 6)) fields[`${s.key}.${f}`] = [`Must be an ${f === 'ipv4' ? 'IPv4' : 'IPv6'} address`];
          else if (v && !known.has(v)) fields[`${s.key}.${f}`] = [`${v} is not bound to this server; add it first`];
          else values[`ip.remote.${s.key}_${f}`] = v;
        }
      }
      if (Object.keys(fields).length) throw unprocessable('Remote service IPs must be addresses bound to this server', fields);
      settings.setMany(values);
      // applied: 'applied' (daemon reconfigured), 'saved' (no owning service or its
      // daemon is not installed; the value is picked up when it is), 'failed'.
      const applied = {};
      const applyErrors = {};
      for (const s of REMOTE_SERVICES) {
        if (!input[s.key]) continue;
        const owner = { mail: ctx.mail, dns: ctx.dns, mysql: ctx.databases, ftp: ctx.ftp, panel: null }[s.key];
        const hook = { mail: owner?.setOutboundAddresses, dns: owner?.setOutboundAddresses, mysql: owner?.setClientAddresses, ftp: owner?.setPassiveAddress, panel: null }[s.key];
        if (typeof hook !== 'function') { applied[s.key] = 'saved'; continue; }
        try {
          await hook.call(owner, { ipv4: setting(`ip.remote.${s.key}_ipv4`, '') || null, ipv6: setting(`ip.remote.${s.key}_ipv6`, '') || null }, req);
          applied[s.key] = 'applied';
        } catch (err) {
          const missing = isCapabilityMissing(err);
          applied[s.key] = missing ? 'saved' : 'failed';
          applyErrors[s.key] = err.message;
          if (!missing) logger.warn({ err, service: s.key }, 'service could not apply its source address');
        }
      }
      audit(req, { action: 'ip.remote_services', target: 'settings', args: values });
      return { ...(await service.getRemoteServiceIps(candidates)), applied, applyErrors };
    },

    // ------------------------------------------------------------ migration
    async migrationPreview({ mappings }) {
      const live = await liveInterfaces();
      const routes = await defaultRoutes();
      const bound = new Set(globalAddresses(live).map((a) => a.address));
      const mainIp = await mainIpDetect(live, routes);
      const sharedIp = setting('basic.shared_ip') || null;
      const seenFrom = new Set();
      const seenTo = new Set();
      const warnings = [];
      const plan = mappings.map(({ from, to }) => {
        const f = canonical(from);
        const t = canonical(to);
        const issues = [];
        if (familyOf(f) !== familyOf(t)) issues.push('Old and new address are different IP families');
        if (f === t) issues.push('Old and new address are identical');
        if (seenFrom.has(f)) issues.push(`${f} is mapped more than once`);
        if (seenTo.has(t)) issues.push(`${t} is the target of more than one mapping`);
        seenFrom.add(f); seenTo.add(t);
        const fromRow = stmts.byAddress.get(f);
        const toRow = stmts.byAddress.get(t);
        const accounts = stmts.accountsUsing.all(f).map((a) => a.username);
        const dns = dnsRecordsPlan(f);
        const v6 = stmts.assignmentByAddress.get(f);
        const v6Target = stmts.assignmentByAddress.get(t);
        const isMain = f === mainIp || Boolean(fromRow?.is_main) || f === routes?.ipv4?.prefsrc || f === routes?.ipv6?.prefsrc;
        if (!fromRow && !accounts.length && !dns.length && !v6) issues.push(`${f} is not known to this server`);
        if (toRow?.dedicated_to && !accounts.includes(toRow.dedicated_account) && toRow.dedicated_to !== v6?.account_id) issues.push(`${t} is dedicated to ${toRow.dedicated_account}`);
        const usingTarget = stmts.accountsUsing.all(t).length;
        if (usingTarget) issues.push(`${t} is already used by ${usingTarget} account(s)`);
        if (v6Target) issues.push(`${t} is the IPv6 address of ${stmts.accountById.get(v6Target.account_id)?.username ?? `account #${v6Target.account_id}`}`);
        if (toRow?.reserved) warnings.push(`${t} is reserved (${toRow.reserved_reason || 'no reason given'}); the reservation is lifted by the migration`);
        if (isMain) warnings.push(`${f} is the server's main IP; it stays bound and is only marked reserved, even when old addresses are removed`);
        else if (f === routes?.ipv4?.prefsrc || f === routes?.ipv6?.prefsrc) warnings.push(`${f} is the source of the default route; it is kept bound and only re-labelled as migrated`);
        return {
          from: f, to: t, family: familyOf(f), isMain, isShared: f === sharedIp, fromKnown: Boolean(fromRow), toKnown: Boolean(toRow), toBound: bound.has(t), fromBound: bound.has(f),
          interface: fromRow?.interface ?? toRow?.interface ?? null, netmask: fromRow?.netmask ?? null,
          accounts, dns, ipv6Account: v6 ? stmts.accountById.get(v6.account_id)?.username : null, issues,
        };
      });
      const totals = { mappings: plan.length, accounts: plan.reduce((n, p) => n + p.accounts.length, 0), dnsRecords: plan.reduce((n, p) => n + p.dns.length, 0), newAddressesToBind: plan.filter((p) => !p.toBound).length, mainIpChanges: plan.filter((p) => p.isMain).length };
      return { plan, totals, warnings, ok: plan.every((p) => !p.issues.length), iproute2: ipAvailable(), web: typeof ctx.web?.replaceIp === 'function' ? 'available' : 'unavailable', dnsService: Boolean(ctx.dns?.upsertRecords) };
    },

    async startMigration(input, user) {
      const preview = await service.migrationPreview({ mappings: input.mappings });
      if (!preview.ok) throw unprocessable('The migration plan has problems', { mappings: preview.plan.flatMap((p) => p.issues.map((i) => `${p.from} → ${p.to}: ${i}`)) });
      if (!input.dryRun && preview.totals.newAddressesToBind && !ipAvailable()) requireIproute2();
      const job = ctx.jobs.enqueue('ip.migrate', { mappings: preview.plan.map((p) => ({ from: p.from, to: p.to })), dryRun: Boolean(input.dryRun), updateDns: input.updateDns !== false, updateVhosts: input.updateVhosts !== false, removeOld: Boolean(input.removeOld), interface: input.interface ?? null, prefix: input.prefix ?? null, userId: user.id }, { userId: user.id });
      return { job, preview };
    },

    async runMigration(jobCtx) {
      const { mappings, dryRun, updateDns, updateVhosts, removeOld, interface: wantedIface, prefix: wantedPrefix, userId } = jobCtx.params;
      const summary = { mappings: mappings.length, dryRun, accounts: 0, dnsZones: 0, dnsRecords: 0, bound: 0, removed: 0, vhosts: null, failed: 0, settings: [] };
      // Re-read after every bind/unbind so a chain A→B, B→C sees B as bound in step 2.
      let live = await liveInterfaces();
      const refreshLive = async () => { live = (await liveInterfaces()) ?? live; };
      const routes = await defaultRoutes();
      const req = actorRequest(userId, `job:${jobCtx.job?.id ?? ''}`);
      // Resolved once, before any setting is rewritten, so a chain A→B, B→C still
      // knows which address is the server's main IP at every step.
      let mainIp = await mainIpDetect(live, routes);
      let i = 0;
      for (const { from, to } of mappings) {
        i++;
        jobCtx.progress((i - 1) / mappings.length * 100, `${from} → ${to}`);
        jobCtx.log(`${dryRun ? '[dry run] ' : ''}Migrating ${from} → ${to}`);
        try {
          const fromRow = stmts.byAddress.get(from);
          const family = familyOf(to);
          const isMain = from === mainIp || Boolean(fromRow?.is_main) || from === routes?.ipv4?.prefsrc || from === routes?.ipv6?.prefsrc;
          const v6 = stmts.assignmentByAddress.get(from);
          const v6Owner = v6 ? stmts.accountById.get(v6.account_id) : null;
          const bound = globalAddresses(live).some((a) => a.address === to);
          if (!bound) {
            const iface = wantedIface || fromRow?.interface || await pickInterface(family, live, routes);
            const prefix = wantedPrefix ?? (fromRow ? (family === 4 ? netmaskToPrefix(fromRow.netmask) ?? 24 : Number(fromRow.netmask) || 64) : (family === 4 ? 24 : 64));
            jobCtx.log(`Binding ${to}/${prefix} on ${iface}`);
            if (!dryRun) {
              if (!iface) throw new Error('no interface could be determined for the new address');
              if (!stmts.byAddress.get(to)) {
                const r = await addAddressesInternal({ addresses: [to], prefix, iface, reserved: false, reason: null }, req);
                if (r.failed.length) throw new Error(r.failed[0].error);
              } else await bind(to, { prefix, iface }, req);
              summary.bound++;
              await refreshLive();
            }
          } else if (!stmts.byAddress.get(to) && !dryRun) {
            const b = globalAddresses(live).find((a) => a.address === to);
            insertAddress({ address: to, family, prefix: b.prefix ?? (family === 4 ? 32 : 128), interface: b.interface });
          }
          const accounts = stmts.accountsUsing.all(from);
          jobCtx.log(`Accounts to update: ${accounts.length ? accounts.map((a) => a.username).join(', ') : 'none'}`);
          if (!dryRun && accounts.length) { stmts.updateAccountIp.run(to, from); summary.accounts += accounts.length; }
          if (v6Owner) {
            const range = v6.range_id ? stmts.rangeById.get(v6.range_id) : null;
            const keepRange = range && cidrContains(range.range_cidr, to);
            jobCtx.log(`IPv6 address of ${v6Owner.username}: ${from} → ${to}${range && !keepRange ? ` (leaves range "${range.name}")` : ''}`);
            if (!dryRun) { stmts.moveAssignment.run(to, keepRange ? range.id : null, from); summary.accounts++; }
          }
          if (!dryRun && fromRow?.dedicated_to) { stmts.setDedicated.run(null, from); stmts.setDedicated.run(fromRow.dedicated_to, to); }
          // The preview promises the target's reservation is lifted; an address in use must not stay reserved.
          if (!dryRun && stmts.byAddress.get(to)?.reserved) { stmts.setReserved.run(0, null, to); jobCtx.log(`${to} is no longer reserved`); }
          for (const key of ['basic.main_ip', 'basic.shared_ip', ...REMOTE_SERVICES.flatMap((s) => [`ip.remote.${s.key}_ipv4`, `ip.remote.${s.key}_ipv6`])]) {
            if (setting(key) === from) { jobCtx.log(`Setting ${key}: ${from} → ${to}`); if (!dryRun) settings.set(key, to); summary.settings.push(key); }
          }
          if (isMain) { jobCtx.log(`${to} becomes the main IP`); if (!dryRun) stmts.setMain.run(to); mainIp = to; }
          if (updateDns) {
            const plan = dnsRecordsPlan(from);
            jobCtx.log(`DNS records carrying ${from}: ${plan.length}`);
            if (!dryRun && plan.length) { const r = await rewriteDnsRecords(from, to, jobCtx, req); summary.dnsZones += r.zones; summary.dnsRecords += r.records; summary.failed += r.failed; }
          }
          if (updateVhosts) {
            if (typeof ctx.web?.replaceIp === 'function') {
              const vhostAccounts = [...accounts.map((a) => a.username), ...(v6Owner && !accounts.some((a) => a.id === v6Owner.id) ? [v6Owner.username] : [])];
              if (!dryRun) {
                try { const r = await ctx.web.replaceIp(from, to, { accounts: vhostAccounts }, req); summary.vhosts = (summary.vhosts || 0) + (r?.updated ?? vhostAccounts.length); jobCtx.log(`Virtual hosts updated for ${vhostAccounts.length} account(s)`); }
                catch (err) {
                  // The web service stores the new vhost spec before throwing for a missing
                  // Apache; that is a pending apply, not a failed mapping.
                  if (isCapabilityMissing(err)) jobCtx.log(`vhosts: ${err.message} The stored vhost specs are applied once it is.`, 'warn');
                  else { summary.failed++; jobCtx.log(`vhosts: ${err.message}`, 'error'); }
                }
              }
              else jobCtx.log(`Virtual hosts of ${vhostAccounts.length} account(s) would be rewritten`);
            } else jobCtx.log('Web server service not available; virtual hosts are rewritten when it is installed', 'warn');
          }
          if (fromRow && !dryRun) {
            const stillUsed = stmts.accountsUsing.all(from).length > 0 || Boolean(stmts.assignmentByAddress.get(from));
            if (removeOld && !isMain && !stillUsed) {
              const r = await unbind(fromRow, live, req).catch((err) => { jobCtx.log(`could not unbind ${from}: ${err.message}`, 'warn'); return { removed: false }; });
              if (r.removed) await refreshLive();
              stmts.remove.run(from);
              summary.removed++;
              jobCtx.log(`${from} removed${r.removed ? ' from the interface' : ''}`);
            } else {
              stmts.setReserved.run(1, `migrated to ${to}`, from);
              jobCtx.log(`${from} kept${isMain ? ' bound (it is the main IP)' : ''} and marked reserved (migrated to ${to})`);
            }
          }
        } catch (err) {
          summary.failed++;
          jobCtx.log(`${from} → ${to}: ${err.message}`, 'error');
        }
      }
      if (!dryRun) {
        const persisted = await persist(req);
        if (persisted.error) jobCtx.log(`persist: ${persisted.error}`, 'warn');
        try { await service.rebuildPool({ role: 'root' }, req); jobCtx.log('IP pool rebuilt'); } catch (err) { jobCtx.log(`pool rebuild: ${err.message}`, 'warn'); }
      }
      jobCtx.progress(100, 'finished');
      audit(req, { action: dryRun ? 'ip.migrate.dry_run' : 'ip.migrate', target: mappings.map((m) => `${m.from}>${m.to}`).join(','), args: { ...summary, userId: userId ?? null } });
      return summary;
    },

    migrationHistory() {
      return ctx.jobs.list({ type: 'ip.migrate', limit: 20 }).map((j) => ({ id: j.id, status: j.status, progress: j.progress, created_at: j.created_at, finished_at: j.finished_at, dryRun: Boolean(j.params?.dryRun), mappings: j.params?.mappings || [], result: j.result, error: j.error }));
    },

    // ----------------------------------------------- helpers for other categories
    // Main IPv4 (settings, then DB, then default route); null when nothing is known.
    async mainIp() { return mainIpDetect(await liveInterfaces(), await defaultRoutes()); },
    sharedIp: () => setting('basic.shared_ip') || setting('basic.main_ip') || null,
    isKnown: (address) => Boolean(stmts.byAddress.get(canonical(address))),
    get: (address) => shape(stmts.byAddress.get(canonical(address))),
    all: () => stmts.all.all().map(shape),
    // Free IPv4 addresses: recorded, not main, not reserved, not dedicated, not used by any account.
    freeAddresses(family = 4) {
      const usage = new Map(stmts.accountsUsingAny.all().map((r) => [r.ip, r.n]));
      return stmts.all.all().filter((r) => r.family === family && r.managed && !r.is_main && !r.reserved && !r.dedicated_to && !(usage.get(r.address) > 0) && !stmts.assignmentByAddress.get(r.address)).map(shape);
    },
    // Dedicates a free IPv4 to an account and sets accounts.ip; used by Create Account with "dedicated IP".
    allocateDedicated(accountId, req, { address } = {}) {
      const account = stmts.accountById.get(accountId);
      if (!account) throw notFound('Account');
      const pick = address ? service.freeAddresses(familyOf(address)).find((r) => r.address === canonical(address)) : service.freeAddresses(4)[0];
      if (!pick) throw conflict(address ? `${address} is not a free address` : 'No free IP address is available; add one under IP Functions');
      db.transaction(() => { stmts.setDedicated.run(accountId, pick.address); stmts.setAccountIp.run(pick.address, accountId); })();
      audit(req, { action: 'ip.dedicate', target: account.username, args: { address: pick.address } });
      return service.get(pick.address);
    },
    // Releases an account's dedicated address(es) back to the pool (account keeps the shared IP).
    releaseDedicated(accountId, req) {
      const rows = stmts.all.all().filter((r) => r.dedicated_to === accountId);
      const shared = service.sharedIp();
      db.transaction(() => { for (const r of rows) stmts.setDedicated.run(null, r.address); stmts.setAccountIp.run(shared, accountId); })();
      return { released: rows.map((r) => r.address), ip: shared };
    },
    ipv6For(accountId) { const s = stmts.assignmentByAccount.get(accountId); return s ? s.address : null; },
    usersOf,
    persist,
    REMOTE_SERVICES,
  };

  function parseRangeInput(text) {
    let cidr;
    try { cidr = parseCidr(text); } catch (err) { throw unprocessable(err.message, { range: [err.message] }); }
    if (cidr.family !== 6) throw unprocessable('IPv6 ranges must be IPv6 networks', { range: ['Use IPv6 CIDR notation such as 2001:db8:1::/64'] });
    if (cidr.prefix > 126) throw unprocessable('Range is too small', { range: ['Prefix length must be /126 or shorter'] });
    if (cidr.prefix < 16) throw unprocessable('Range is too large', { range: ['Prefix length must be /16 or longer'] });
    if (toValue(cidr.first) === 0n) throw unprocessable('Range cannot start at ::', { range: ['Unspecified network'] });
    return cidr;
  }

  return service;
}
