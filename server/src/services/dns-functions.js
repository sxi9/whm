import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import {
  RECORD_TYPES, ZoneError, nextSerial, normalizeRecord, renderZone, renderTemplate, parseZone, parseSoaValue, soaValue, checkConflicts, absoluteName,
} from './dns-zonefile.js';

const SPF_RE = /^v=spf1(?: [+\-~?]?(?:all|a|mx|ptr|ip4:[0-9./]+|ip6:[0-9a-f:./]+|include:[a-z0-9._-]+|exists:[a-z0-9._%-]+|redirect=[a-z0-9._-]+|exp=[a-z0-9._-]+)(?:\/\d{1,3})?)*$/i;
const DMARC_POLICIES = ['none', 'quarantine', 'reject'];
const IMPORT_INTERVAL_MS = 5 * 60 * 1000;

// ctx.dns — zones, records, templates, DKIM/SPF/DMARC, routing, parking,
// forwarding and cluster sync. Other categories call it lazily via ctx.dns.
export function createDnsService(ctx) {
  const { db, agent, capabilities, settings, config, logger, crypto: cryptoSvc } = ctx;

  const stmts = {
    zoneByDomain: db.prepare(`SELECT z.*, a.username AS account, a.owner_id, a.ip AS account_ip FROM dns_zones z LEFT JOIN accounts a ON a.id = z.account_id WHERE z.domain = ?`),
    zoneById: db.prepare('SELECT * FROM dns_zones WHERE id = ?'),
    insertZone: db.prepare('INSERT INTO dns_zones (domain, account_id, serial, ttl, type, dnssec_enabled) VALUES (@domain, @account_id, @serial, @ttl, @type, 0)'),
    touchZone: db.prepare("UPDATE dns_zones SET serial = @serial, ttl = @ttl, dnssec_enabled = @dnssec_enabled, account_id = @account_id, updated_at = datetime('now') WHERE id = @id"),
    deleteZone: db.prepare('DELETE FROM dns_zones WHERE id = ?'),
    records: db.prepare('SELECT * FROM dns_records WHERE zone_id = ? ORDER BY line_index, id'),
    recordById: db.prepare('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?'),
    insertRecord: db.prepare('INSERT INTO dns_records (zone_id, name, type, ttl, priority, value, line_index) VALUES (@zone_id, @name, @type, @ttl, @priority, @value, @line_index)'),
    updateRecord: db.prepare('UPDATE dns_records SET name = @name, type = @type, ttl = @ttl, priority = @priority, value = @value WHERE id = @id'),
    deleteRecord: db.prepare('DELETE FROM dns_records WHERE id = ?'),
    deleteRecordsOfZone: db.prepare('DELETE FROM dns_records WHERE zone_id = ?'),
    maxLine: db.prepare('SELECT COALESCE(MAX(line_index), 0) AS n FROM dns_records WHERE zone_id = ?'),
    accountByDomain: db.prepare('SELECT a.* FROM accounts a WHERE a.domain = ?'),
    accountByAnyDomain: db.prepare('SELECT a.*, d.type AS domain_type, d.docroot FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ?'),
    accountByUsername: db.prepare('SELECT * FROM accounts WHERE username = ?'),
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    domainHosted: db.prepare('SELECT 1 FROM account_domains WHERE domain = ? UNION SELECT 1 FROM accounts WHERE domain = ?'),
    templates: db.prepare('SELECT id, name, body, updated_at FROM zone_templates ORDER BY name'),
    template: db.prepare('SELECT id, name, body, updated_at FROM zone_templates WHERE name = ?'),
    upsertTemplate: db.prepare(`INSERT INTO zone_templates (name, body) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`),
    deleteTemplate: db.prepare('DELETE FROM zone_templates WHERE name = ?'),
    dkim: db.prepare('SELECT * FROM dkim_keys WHERE domain = ?'),
    upsertDkim: db.prepare(`INSERT INTO dkim_keys (domain, selector, private_key_enc, public_key) VALUES (?, ?, ?, ?) ON CONFLICT (domain) DO UPDATE SET selector = excluded.selector, private_key_enc = excluded.private_key_enc, public_key = excluded.public_key, created_at = datetime('now')`),
    deleteDkim: db.prepare('DELETE FROM dkim_keys WHERE domain = ?'),
    mailDomain: db.prepare('SELECT * FROM mail_domains WHERE domain = ?'),
    upsertMailDomain: db.prepare('INSERT INTO mail_domains (account_id, domain, routing) VALUES (?, ?, ?) ON CONFLICT (domain) DO UPDATE SET routing = excluded.routing'),
    insertParked: db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, ?, ?)'),
    parkedByDomain: db.prepare("SELECT d.*, a.username AS account, a.owner_id, a.home_dir FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ? AND d.type IN ('parked', 'alias')"),
    deleteParked: db.prepare('DELETE FROM account_domains WHERE id = ?'),
    forwarding: db.prepare('SELECT f.*, a.username AS account, a.owner_id FROM domain_forwarding f LEFT JOIN accounts a ON a.id = f.account_id WHERE f.domain = ?'),
    upsertForwarding: db.prepare(`INSERT INTO domain_forwarding (domain, account_id, target_url, type, match_www, keep_path, status, last_error)
      VALUES (@domain, @account_id, @target_url, @type, @match_www, @keep_path, 'pending', NULL)
      ON CONFLICT (domain) DO UPDATE SET account_id = excluded.account_id, target_url = excluded.target_url, type = excluded.type, match_www = excluded.match_www, keep_path = excluded.keep_path, status = 'pending', last_error = NULL, updated_at = datetime('now')`),
    forwardingStatus: db.prepare("UPDATE domain_forwarding SET status = ?, last_error = ?, updated_at = datetime('now') WHERE domain = ?"),
    deleteForwarding: db.prepare('DELETE FROM domain_forwarding WHERE domain = ?'),
    clusters: db.prepare("SELECT id, name, remote_host, role, enabled, last_sync_at, created_at, api_token_enc IS NOT NULL AS has_token FROM dns_clusters ORDER BY name"),
    clusterById: db.prepare('SELECT * FROM dns_clusters WHERE id = ?'),
    clusterSynced: db.prepare("UPDATE dns_clusters SET last_sync_at = datetime('now') WHERE id = ?"),
    syncRow: db.prepare(`INSERT INTO dns_zone_sync (zone_id, cluster_id, serial, status, message, synced_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (zone_id, cluster_id) DO UPDATE SET serial = excluded.serial, status = excluded.status, message = excluded.message, synced_at = excluded.synced_at`),
    syncStatus: db.prepare('SELECT s.*, z.domain, z.serial AS current_serial, c.name AS cluster FROM dns_zone_sync s JOIN dns_zones z ON z.id = s.zone_id JOIN dns_clusters c ON c.id = s.cluster_id ORDER BY z.domain, c.name'),
  };

  let lastImportAt = 0;
  const strict = () => config.env === 'production';
  const bindAvailable = () => capabilities.has('bind');
  const setting = (key, fallback) => settings.get(key, fallback);
  const nameservers = () => {
    const ns = setting('basic.nameservers', []);
    return { ns1: ns[0] || `ns1.${setting('basic.hostname', 'localhost')}`, ns2: ns[1] || ns[0] || `ns2.${setting('basic.hostname', 'localhost')}` };
  };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));

  function shapeZone(row) {
    if (!row) return null;
    return { ...row, dnssec_enabled: Boolean(row.dnssec_enabled), owner_id: undefined, account_ip: undefined, published: bindAvailable() };
  }

  function shapeRecord(r) {
    return { id: r.id, name: r.name, type: r.type, ttl: r.ttl, priority: r.priority, value: r.value, line_index: r.line_index };
  }

  function visible(zone, user) {
    if (!isRoot(user) && zone.owner_id !== user.id) throw forbidden('That zone belongs to another reseller');
    return zone;
  }

  function assertPublishable() {
    if (!bindAvailable() && strict()) throw new CapabilityError('bind', 'BIND (named) is not installed on this server. Install bind9 / bind to publish DNS zones.');
  }

  // Walks up the labels of a name to find the zone that contains it.
  function zoneContaining(name) {
    const labels = name.toLowerCase().replace(/\.$/, '').split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join('.');
      const row = stmts.zoneByDomain.get(candidate);
      if (row) return row;
    }
    return null;
  }

  function accountForDomain(domain) {
    const direct = stmts.accountByDomain.get(domain) || stmts.accountByAnyDomain.get(domain);
    if (direct) return direct;
    const labels = domain.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join('.');
      const row = stmts.accountByDomain.get(parent) || stmts.accountByAnyDomain.get(parent);
      if (row) return row;
    }
    return null;
  }

  function loadAccount(username, user) {
    const account = stmts.accountByUsername.get(username);
    if (!account) throw notFound('Account');
    if (!isRoot(user) && account.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return account;
  }

  // Pull zones that exist on disk but not in the DB (first run on a host that
  // already had BIND zones). Cheap when nothing changed; throttled.
  async function importFromDisk(force = false) {
    if (!bindAvailable()) return { imported: [] };
    if (!force && Date.now() - lastImportAt < IMPORT_INTERVAL_MS) return { imported: [] };
    lastImportAt = Date.now();
    const imported = [];
    let listing;
    try { listing = await agent.op('dns.zone.list', {}); } catch (err) { logger.warn({ err }, 'could not list zone files'); return { imported }; }
    for (const z of listing?.zones || []) {
      if (!z.exists || stmts.zoneByDomain.get(z.domain)) continue;
      if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(z.domain)) continue;
      try {
        const file = await agent.op('dns.zone.read', { domain: z.domain });
        if (!file?.exists) continue;
        const parsed = parseZone(file.body, z.domain);
        const account = accountForDomain(z.domain);
        insertZoneRows({ domain: z.domain, account_id: account?.id ?? null, serial: parsed.serial || nextSerial(0), ttl: parsed.ttl || setting('dns.default_ttl', 14400) }, parsed.records);
        imported.push(z.domain);
      } catch (err) {
        logger.warn({ err, domain: z.domain }, 'could not import zone file');
      }
    }
    if (imported.length) logger.info({ imported }, 'imported existing zone files into the panel');
    return { imported };
  }

  function insertZoneRows(zone, records) {
    return db.transaction(() => {
      const { lastInsertRowid } = stmts.insertZone.run({ domain: zone.domain, account_id: zone.account_id ?? null, serial: zone.serial, ttl: zone.ttl, type: 'master' });
      records.forEach((r, i) => stmts.insertRecord.run({ zone_id: lastInsertRowid, name: r.name, type: r.type, ttl: r.ttl ?? null, priority: r.priority ?? null, value: r.value, line_index: i + 1 }));
      return stmts.zoneByDomain.get(zone.domain);
    })();
  }

  async function load(domain, user) {
    let row = stmts.zoneByDomain.get(domain);
    if (!row && bindAvailable()) {
      await importFromDisk(true);
      row = stmts.zoneByDomain.get(domain);
    }
    if (!row) throw notFound(`Zone ${domain}`);
    return visible(row, user);
  }

  // Re-renders the zone from the DB, validates it with named-checkzone, writes it
  // to disk and reloads named. On a dev box without BIND the DB is still updated
  // and the caller learns the zone is unpublished.
  async function publish(zone, req, { reload = true } = {}) {
    const fresh = stmts.zoneByDomain.get(zone.domain);
    const records = stmts.records.all(fresh.id);
    const body = renderZone(fresh, records);
    if (!bindAvailable()) {
      if (strict()) throw new CapabilityError('bind', 'BIND (named) is not installed; the zone was saved but cannot be published');
      return { applied: false, reason: 'capability_missing', serial: fresh.serial };
    }
    const check = await agent.op('dns.checkzone', { domain: fresh.domain, body }, { req });
    if (check?.ok === false) throw unprocessable(`Zone ${fresh.domain} failed named-checkzone`, { zone: [check.output || 'named-checkzone reported an error'] });
    await agent.op('dns.zone.write', { domain: fresh.domain, body, allowTransfer: setting('dns.allow_transfer', []), signed: Boolean(fresh.dnssec_enabled) }, { req });
    if (fresh.dnssec_enabled) await agent.op('dns.dnssec.sign', { domain: fresh.domain }, { req });
    let reloaded = false;
    let reloadError = null;
    if (reload) {
      try { await agent.op('dns.reload', { domain: fresh.domain }, { req }); reloaded = true; } catch (err) { reloadError = err.message; logger.warn({ err, domain: fresh.domain }, 'zone written but named reload failed'); }
    }
    return { applied: true, reloaded, reloadError, serial: fresh.serial };
  }

  function bump(zone, patch = {}) {
    stmts.touchZone.run({ id: zone.id, serial: nextSerial(zone.serial), ttl: patch.ttl ?? zone.ttl, dnssec_enabled: patch.dnssec_enabled ?? zone.dnssec_enabled, account_id: patch.account_id === undefined ? zone.account_id : patch.account_id });
    return stmts.zoneById.get(zone.id);
  }

  function replaceByNameType(zone, name, type, values) {
    const existing = stmts.records.all(zone.id).filter((r) => r.name === name && r.type === type);
    for (const r of existing) stmts.deleteRecord.run(r.id);
    let line = stmts.maxLine.get(zone.id).n;
    for (const v of values) stmts.insertRecord.run({ zone_id: zone.id, name, type, ttl: v.ttl ?? null, priority: v.priority ?? null, value: v.value, line_index: ++line });
  }

  async function createZoneInternal({ domain, ip, template = 'standard', accountId = null, ttl }, req) {
    if (stmts.zoneByDomain.get(domain)) throw conflict(`A zone for ${domain} already exists`);
    const tpl = stmts.template.get(template);
    if (!tpl) throw notFound(`Zone template "${template}"`);
    const { ns1, ns2 } = nameservers();
    const zoneTtl = ttl || setting('dns.default_ttl', 14400);
    const serial = nextSerial(0);
    const address = ip || setting('basic.main_ip') || setting('basic.shared_ip') || '127.0.0.1';
    const text = renderTemplate(tpl.body, { domain, ip: address, ns1, ns2, serial, ttl: zoneTtl, hostname: setting('basic.hostname', ''), ipv6: setting('basic.main_ipv6', '') });
    const parsed = parseZone(text, domain);
    if (parsed.errors.length) throw unprocessable(`Template "${template}" renders an invalid zone`, { template: parsed.errors });
    if (!parsed.records.some((r) => r.type === 'SOA')) throw unprocessable(`Template "${template}" has no SOA record`, { template: ['SOA record missing'] });
    const zone = insertZoneRows({ domain, account_id: accountId, serial: parsed.serial || serial, ttl: parsed.ttl || zoneTtl }, parsed.records);
    const result = await publish(zone, req);
    audit(req, { action: 'dns.zone.create', target: domain, args: { template, ip: address, accountId } });
    return { ...shapeZone(stmts.zoneByDomain.get(domain)), records: stmts.records.all(zone.id).map(shapeRecord), ...result };
  }

  async function removeZoneInternal(zone, req) {
    if (bindAvailable()) {
      await agent.op('dns.zone.remove', { domain: zone.domain }, { req });
      try { await agent.op('dns.reload', {}, { req }); } catch (err) { logger.warn({ err }, 'named reload after zone removal failed'); }
    }
    stmts.deleteZone.run(zone.id);
    audit(req, { action: 'dns.zone.delete', target: zone.domain });
    return { domain: zone.domain, deleted: true };
  }

  function visibleZonesWhere(user) {
    return isRoot(user) ? { where: [], params: {} } : { where: ['a.owner_id = @owner'], params: { owner: user.id } };
  }

  function allVisibleZones(user) {
    const { where, params } = visibleZonesWhere(user);
    return db.prepare(`SELECT z.*, a.username AS account, a.owner_id, a.ip AS account_ip FROM dns_zones z LEFT JOIN accounts a ON a.id = z.account_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY z.domain`).all(params);
  }

  function txtAt(records, name, prefix) {
    return records.filter((r) => r.type === 'TXT' && r.name === name && (!prefix || r.value.toLowerCase().startsWith(prefix)));
  }

  function generateDkimKeyPair(bits) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
    return {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
  }

  function dkimSelectorName(selector) { return `${selector}._domainkey`; }

  async function ensureDkimInternal(zone, { selector, bits, rotate = false }, req) {
    const sel = selector || setting('dns.dkim_selector', 'default');
    let key = stmts.dkim.get(zone.domain);
    let generated = false;
    if (!key || rotate || key.selector !== sel) {
      const pair = generateDkimKeyPair(bits || setting('dns.dkim_bits', 2048));
      stmts.upsertDkim.run(zone.domain, sel, cryptoSvc.encrypt(pair.privateKeyPem), pair.publicKeyB64);
      key = stmts.dkim.get(zone.domain);
      generated = true;
    }
    const value = `v=DKIM1; k=rsa; p=${key.public_key}`;
    const current = txtAt(stmts.records.all(zone.id), dkimSelectorName(sel));
    const changed = generated || current.length !== 1 || current[0].value !== value;
    if (changed) {
      db.transaction(() => { replaceByNameType(zone, dkimSelectorName(sel), 'TXT', [{ value }]); bump(zone); })();
    }
    if (generated) {
      try { await ctx.mail?.installDkimKey?.(zone.domain, { selector: sel, privateKeyPem: cryptoSvc.decrypt(key.private_key_enc) }, req); } catch (err) { logger.warn({ err, domain: zone.domain }, 'mail service could not install the DKIM key'); }
    }
    return { selector: sel, record: { name: dkimSelectorName(sel), type: 'TXT', value }, generated, changed };
  }

  function buildDmarc({ p = 'none', sp, rua, ruf, pct, adkim, aspf }) {
    const parts = ['v=DMARC1', `p=${p}`];
    if (sp) parts.push(`sp=${sp}`);
    if (rua) parts.push(`rua=${rua.split(/[,\s]+/).filter(Boolean).map((a) => (a.startsWith('mailto:') ? a : `mailto:${a}`)).join(',')}`);
    if (ruf) parts.push(`ruf=${ruf.split(/[,\s]+/).filter(Boolean).map((a) => (a.startsWith('mailto:') ? a : `mailto:${a}`)).join(',')}`);
    if (pct != null && pct !== 100) parts.push(`pct=${pct}`);
    if (adkim) parts.push(`adkim=${adkim}`);
    if (aspf) parts.push(`aspf=${aspf}`);
    return parts.join('; ');
  }

  function suggestedSpf(records) {
    const ips = records.filter((r) => r.name === '@' && r.type === 'A').map((r) => `ip4:${r.value}`);
    const ip6 = records.filter((r) => r.name === '@' && r.type === 'AAAA').map((r) => `ip6:${r.value}`);
    return `v=spf1 +mx +a ${[...ips, ...ip6].join(' ')} ~all`.replace(/\s+/g, ' ');
  }

  function emailStatusOf(zone) {
    const records = stmts.records.all(zone.id);
    const key = stmts.dkim.get(zone.domain);
    const selector = key?.selector || setting('dns.dkim_selector', 'default');
    const spf = txtAt(records, '@', 'v=spf1')[0] || null;
    const dkim = txtAt(records, dkimSelectorName(selector), 'v=dkim1')[0] || null;
    const dmarc = txtAt(records, '_dmarc', 'v=dmarc1')[0] || null;
    return {
      domain: zone.domain, account: zone.account ?? null, zoneId: zone.id,
      spf: spf ? shapeRecord(spf) : null,
      dkim: dkim ? { ...shapeRecord(dkim), selector } : null,
      dkimKey: key ? { selector: key.selector, publicKey: key.public_key, createdAt: key.created_at } : null,
      dmarc: dmarc ? shapeRecord(dmarc) : null,
      mx: records.filter((r) => r.type === 'MX').map(shapeRecord).sort((a, b) => a.priority - b.priority),
      suggestions: { spf: suggestedSpf(records), dmarc: buildDmarc({ p: 'none', rua: `postmaster@${zone.domain}` }) },
    };
  }

  function parseRemote(host) {
    const url = host.includes('://') ? new URL(host) : new URL(`https://${host}`);
    if (!url.port) url.port = '2087';
    return url;
  }

  function postJson(url, body, { token, verifyTls = true, timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const mod = url.protocol === 'http:' ? http : https;
      const req = mod.request(url, {
        method: 'POST', timeout: timeoutMs, rejectUnauthorized: verifyTls,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed, text: data.slice(0, 500) });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  const service = {
    // ----------------------------------------------------------------- zones
    async listZones(query, user) {
      await importFromDisk();
      const { where, params } = visibleZonesWhere(user);
      if (query.q) { where.push('(z.domain LIKE @q OR a.username LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.account) { where.push('a.username = @account'); params.account = query.account; }
      if (query.orphans) where.push('z.account_id IS NULL');
      const result = paginate(db, {
        select: 'z.*, a.username AS account, a.owner_id, a.ip AS account_ip, (SELECT COUNT(*) FROM dns_records r WHERE r.zone_id = z.id AND r.type != \'SOA\') AS record_count',
        from: 'dns_zones z LEFT JOIN accounts a ON a.id = z.account_id', where, params,
        sortable: { domain: 'z.domain', account: 'a.username', serial: 'z.serial', ttl: 'z.ttl', updated_at: 'z.updated_at', record_count: 'record_count' },
        defaultSort: 'domain', query,
      });
      return { ...result, data: result.data.map(shapeZone) };
    },

    async getZone(domain, user) {
      const zone = await load(domain, user);
      const records = stmts.records.all(zone.id);
      const soaRec = records.find((r) => r.type === 'SOA');
      return { ...shapeZone(zone), soa: { ...parseSoaValue(soaRec?.value, domain), serial: zone.serial, ttl: soaRec?.ttl ?? null }, records: records.filter((r) => r.type !== 'SOA').map(shapeRecord) };
    },

    async createZone(input, user, req) {
      assertPublishable();
      let accountId = null;
      let ip = input.ip || null;
      if (input.account) {
        const account = loadAccount(input.account, user);
        accountId = account.id;
        ip ||= account.ip;
      } else {
        const account = accountForDomain(input.domain);
        if (account) {
          if (!isRoot(user) && account.owner_id !== user.id) throw forbidden('That domain belongs to another reseller\'s account');
          accountId = account.id;
          ip ||= account.ip;
        } else if (!isRoot(user)) throw forbidden('Resellers can only add zones for domains on their own accounts');
      }
      return createZoneInternal({ domain: input.domain, ip, template: input.template, accountId, ttl: input.ttl }, req);
    },

    async deleteZone(domain, user, req) {
      const zone = await load(domain, user);
      return removeZoneInternal(zone, req);
    },

    async rawZone(domain, user) {
      const zone = await load(domain, user);
      const rendered = renderZone(zone, stmts.records.all(zone.id));
      let onDisk = null;
      if (bindAvailable()) {
        try { const file = await agent.op('dns.zone.read', { domain }); onDisk = file?.exists ? file.body : null; } catch (err) { logger.warn({ err, domain }, 'could not read zone file'); }
      }
      return { domain, serial: zone.serial, body: rendered, onDisk, inSync: onDisk == null ? null : onDisk === rendered };
    },

    async validateZone(domain, body, user) {
      if (stmts.zoneByDomain.get(domain)) await load(domain, user);
      const parsed = parseZone(body, domain);
      const errors = [...parsed.errors];
      if (!parsed.records.some((r) => r.type === 'SOA')) errors.push('SOA record missing');
      for (const r of parsed.records) { const c = checkConflicts(parsed.records.filter((x) => x !== r), r); if (c && !errors.includes(c)) errors.push(c); }
      let checkzone = null;
      if (bindAvailable() && !errors.length) {
        try { checkzone = await agent.op('dns.checkzone', { domain, body }); if (checkzone?.ok === false) errors.push(checkzone.output || 'named-checkzone failed'); } catch (err) { checkzone = { ok: null, output: err.message }; }
      }
      return { ok: errors.length === 0, errors, records: parsed.records.length, serial: parsed.serial, ttl: parsed.ttl, checkzone };
    },

    // Raw edit mode: parse → replace every record → re-render canonically.
    async saveRawZone(domain, body, user, req, { create = false } = {}) {
      assertPublishable();
      let zone = stmts.zoneByDomain.get(domain);
      if (!zone) {
        if (!create) throw notFound(`Zone ${domain}`);
        if (!isRoot(user)) throw forbidden('Only root can create zones from raw text');
      } else visible(zone, user);
      const validation = await service.validateZone(domain, body, user);
      if (!validation.ok) throw unprocessable('Zone text is not valid', { body: validation.errors });
      const parsed = parseZone(body, domain);
      const created = !zone;
      if (!zone) {
        zone = insertZoneRows({ domain, account_id: accountForDomain(domain)?.id ?? null, serial: parsed.serial || nextSerial(0), ttl: parsed.ttl || setting('dns.default_ttl', 14400) }, parsed.records);
      } else {
        db.transaction(() => {
          stmts.deleteRecordsOfZone.run(zone.id);
          parsed.records.forEach((r, i) => stmts.insertRecord.run({ zone_id: zone.id, name: r.name, type: r.type, ttl: r.ttl ?? null, priority: r.priority ?? null, value: r.value, line_index: i + 1 }));
          stmts.touchZone.run({ id: zone.id, serial: Math.max(nextSerial(zone.serial), parsed.serial || 0), ttl: parsed.ttl || zone.ttl, dnssec_enabled: zone.dnssec_enabled, account_id: zone.account_id });
        })();
      }
      const result = await publish(zone, req);
      audit(req, { action: 'dns.zone.raw_save', target: domain, args: { records: parsed.records.length, created } });
      return { ...(await service.getZone(domain, user)), ...result };
    },

    async applyZone(domain, user, req) {
      const zone = await load(domain, user);
      const result = await publish(zone, req);
      audit(req, { action: 'dns.zone.apply', target: domain });
      return { domain, ...result };
    },

    // --------------------------------------------------------------- records
    async addRecord(domain, input, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      let rec;
      try { rec = normalizeRecord(input, domain); } catch (err) { if (err instanceof ZoneError) throw unprocessable(err.message, err.fields); throw err; }
      const records = stmts.records.all(zone.id);
      const conflictMsg = checkConflicts(records, rec);
      if (conflictMsg) throw conflict(conflictMsg);
      if (records.some((r) => r.name === rec.name && r.type === rec.type && r.value === rec.value && (r.priority ?? null) === (rec.priority ?? null))) throw conflict('An identical record already exists');
      const id = db.transaction(() => {
        const { lastInsertRowid } = stmts.insertRecord.run({ zone_id: zone.id, ...rec, line_index: stmts.maxLine.get(zone.id).n + 1 });
        bump(zone);
        return Number(lastInsertRowid);
      })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.record.add', target: domain, args: rec });
      return { record: shapeRecord(stmts.recordById.get(id, zone.id)), ...result };
    },

    async updateRecord(domain, id, input, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      const existing = stmts.recordById.get(id, zone.id);
      if (!existing || existing.type === 'SOA') throw notFound('Record');
      let rec;
      try { rec = normalizeRecord({ ...existing, ...input, ttl: input.ttl === undefined ? existing.ttl : input.ttl, priority: input.priority === undefined ? existing.priority : input.priority }, domain); } catch (err) { if (err instanceof ZoneError) throw unprocessable(err.message, err.fields); throw err; }
      const conflictMsg = checkConflicts(stmts.records.all(zone.id), rec, existing.id);
      if (conflictMsg) throw conflict(conflictMsg);
      db.transaction(() => { stmts.updateRecord.run({ id: existing.id, ...rec }); bump(zone); })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.record.update', target: `${domain}#${id}`, args: rec });
      return { record: shapeRecord(stmts.recordById.get(id, zone.id)), ...result };
    },

    async deleteRecord(domain, id, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      const existing = stmts.recordById.get(id, zone.id);
      if (!existing || existing.type === 'SOA') throw notFound('Record');
      db.transaction(() => { stmts.deleteRecord.run(existing.id); bump(zone); })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.record.delete', target: `${domain}#${id}`, args: shapeRecord(existing) });
      return { deleted: true, ...result };
    },

    async setSoa(domain, input, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      const records = stmts.records.all(zone.id);
      const soaRec = records.find((r) => r.type === 'SOA');
      const current = parseSoaValue(soaRec?.value, domain);
      const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
      next.primary = absoluteName(next.primary, domain);
      next.hostmaster = absoluteName(next.hostmaster, domain);
      db.transaction(() => {
        if (soaRec) stmts.updateRecord.run({ id: soaRec.id, name: '@', type: 'SOA', ttl: soaRec.ttl, priority: null, value: soaValue(next) });
        else stmts.insertRecord.run({ zone_id: zone.id, name: '@', type: 'SOA', ttl: null, priority: null, value: soaValue(next), line_index: 0 });
        bump(zone);
      })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.zone.soa', target: domain, args: next });
      return { soa: { ...next, serial: stmts.zoneById.get(zone.id).serial }, ...result };
    },

    async setTtl(domain, ttl, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      db.transaction(() => { bump(zone, { ttl }); })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.zone.ttl', target: domain, args: { ttl } });
      return { domain, ttl, ...result };
    },

    async setTtlBulk(domains, ttl, user, req) {
      const results = [];
      for (const domain of domains) {
        try { results.push(await service.setTtl(domain, ttl, user, req)); } catch (err) { results.push({ domain, error: err.message, code: err.code }); }
      }
      return { ttl, results };
    },

    async setDnssec(domain, enabled, user, req) {
      const zone = await load(domain, user);
      if (!isRoot(user)) throw forbidden('Only root can change DNSSEC');
      if (enabled && !bindAvailable()) throw new CapabilityError('bind', 'DNSSEC signing needs BIND\'s dnssec-keygen and dnssec-signzone');
      let keys = null;
      if (enabled && !zone.dnssec_enabled) keys = await agent.op('dns.dnssec.keygen', { domain, algorithm: 'ECDSAP256SHA256' }, { req });
      if (!enabled && zone.dnssec_enabled && bindAvailable()) await agent.op('dns.dnssec.remove', { domain }, { req });
      db.transaction(() => { bump(zone, { dnssec_enabled: enabled ? 1 : 0 }); })();
      const result = await publish(zone, req);
      audit(req, { action: enabled ? 'dns.dnssec.enable' : 'dns.dnssec.disable', target: domain });
      return { domain, dnssec_enabled: enabled, ds: keys?.ds ?? [], dnskey: keys ? { ksk: keys.ksk?.record, zsk: keys.zsk?.record } : null, ...result };
    },

    // ------------------------------------------------------------- templates
    listTemplates: () => stmts.templates.all().map((t) => ({ ...t, builtin: t.name === 'standard' })),
    getTemplate(name) {
      const t = stmts.template.get(name);
      if (!t) throw notFound(`Zone template "${name}"`);
      return { ...t, builtin: t.name === 'standard' };
    },
    saveTemplate(name, body, req, { create = false } = {}) {
      const exists = stmts.template.get(name);
      if (create && exists) throw conflict(`Template "${name}" already exists`);
      if (!create && !exists) throw notFound(`Zone template "${name}"`);
      const parsed = parseZone(renderTemplate(body, { domain: 'example.com', ip: '192.0.2.1', ns1: 'ns1.example.net', ns2: 'ns2.example.net', serial: 2000010101, ttl: 14400, hostname: 'host.example.net', ipv6: '2001:db8::1' }), 'example.com');
      if (parsed.errors.length) throw unprocessable('Template does not render to a valid zone', { body: parsed.errors });
      if (!parsed.records.some((r) => r.type === 'SOA')) throw unprocessable('Template must contain an SOA record', { body: ['SOA record missing'] });
      stmts.upsertTemplate.run(name, body);
      audit(req, { action: create ? 'dns.template.create' : 'dns.template.update', target: name });
      return service.getTemplate(name);
    },
    deleteTemplate(name, req) {
      if (name === 'standard') throw badRequest('The "standard" template cannot be deleted');
      if (!stmts.deleteTemplate.run(name).changes) throw notFound(`Zone template "${name}"`);
      audit(req, { action: 'dns.template.delete', target: name });
      return { deleted: true };
    },
    previewTemplate(name, vars = {}) {
      const t = service.getTemplate(name);
      const { ns1, ns2 } = nameservers();
      const domain = vars.domain || 'example.com';
      const body = renderTemplate(t.body, { domain, ip: vars.ip || setting('basic.main_ip') || '192.0.2.1', ns1, ns2, serial: nextSerial(0), ttl: setting('dns.default_ttl', 14400), hostname: setting('basic.hostname', ''), ipv6: setting('basic.main_ipv6', '') });
      const parsed = parseZone(body, domain);
      return { name, body, errors: parsed.errors, records: parsed.records.length };
    },

    // -------------------------------------------------------------- hostname
    async hostnameStatus() {
      const hostname = setting('basic.hostname', '');
      const ip = setting('basic.main_ip') || null;
      let detectedIp = null;
      try {
        const info = await agent.op('sys.info', {});
        detectedIp = info?.interfaces?.flatMap((i) => i.addresses || []).find((a) => a.family === 'IPv4' && !/^(127\.|169\.254\.)/.test(a.address))?.address ?? null;
      } catch { /* agent down: status still renders */ }
      const zone = hostname.includes('.') ? zoneContaining(hostname) : null;
      const relative = zone ? (hostname === zone.domain ? '@' : hostname.slice(0, -(zone.domain.length + 1))) : null;
      const record = zone ? stmts.records.all(zone.id).find((r) => r.type === 'A' && r.name === relative) || null : null;
      let resolution = null;
      try { resolution = hostname.includes('.') ? await agent.op('dns.resolve', { name: hostname, type: 'A', servers: setting('dns.resolvers', []).length ? setting('dns.resolvers', []) : undefined, timeoutMs: 3000 }) : null; } catch { resolution = null; }
      const parent = hostname.split('.').slice(1).join('.');
      return {
        hostname, ip: ip || detectedIp, configuredIp: ip, detectedIp,
        zone: zone ? zone.domain : null, suggestedZone: zone ? null : (parent.includes('.') ? parent : null), recordName: relative,
        record: record ? shapeRecord(record) : null,
        resolves: resolution ? { answers: resolution.answers, error: resolution.error, matches: Boolean((ip || detectedIp) && resolution.answers.includes(ip || detectedIp)) } : null,
      };
    },

    async ensureHostnameA(input, user, req) {
      assertPublishable();
      const status = await service.hostnameStatus();
      const hostname = status.hostname;
      if (!hostname.includes('.')) throw badRequest('Set a fully-qualified hostname in Basic WebHost Manager Setup first');
      const ip = input.ip || status.ip;
      if (!ip) throw badRequest('No IP address is configured for this server; set the main IP in Basic Setup');
      let zone = zoneContaining(hostname);
      let createdZone = null;
      if (!zone) {
        const parent = status.suggestedZone;
        if (!parent) throw badRequest(`Cannot derive a zone from hostname ${hostname}`);
        createdZone = await createZoneInternal({ domain: parent, ip, template: 'standard', accountId: accountForDomain(parent)?.id ?? null }, req);
        zone = stmts.zoneByDomain.get(parent);
      }
      const relative = hostname === zone.domain ? '@' : hostname.slice(0, -(zone.domain.length + 1));
      db.transaction(() => { replaceByNameType(zone, relative, 'A', [{ value: ip }]); bump(zone); })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.hostname.a', target: hostname, args: { ip, zone: zone.domain } });
      return { hostname, ip, zone: zone.domain, recordName: relative, createdZone: createdZone?.domain ?? null, ...result };
    },

    // ----------------------------------------------------------------- email
    async emailStatus(domain, user) {
      const zone = await load(domain, user);
      return emailStatusOf(zone);
    },

    emailOverview(user) {
      return allVisibleZones(user).map((z) => {
        const s = emailStatusOf(z);
        return { domain: z.domain, account: z.account ?? null, spf: Boolean(s.spf), dkim: Boolean(s.dkim), dmarc: Boolean(s.dmarc), mx: s.mx.length };
      });
    },

    async setSpf(domain, input, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      const value = (input.value || suggestedSpf(stmts.records.all(zone.id))).trim().replace(/\s+/g, ' ');
      if (!SPF_RE.test(value)) throw unprocessable('Not a valid SPF record', { value: ['SPF must start with v=spf1 and use a, mx, ip4:, ip6:, include:, ~all / -all mechanisms'] });
      db.transaction(() => {
        const others = txtAt(stmts.records.all(zone.id), '@', 'v=spf1');
        for (const r of others) stmts.deleteRecord.run(r.id);
        stmts.insertRecord.run({ zone_id: zone.id, name: '@', type: 'TXT', ttl: null, priority: null, value, line_index: stmts.maxLine.get(zone.id).n + 1 });
        bump(zone);
      })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.email.spf', target: domain, args: { value } });
      return { ...emailStatusOf(stmts.zoneByDomain.get(domain)), ...result };
    },

    async ensureDkim(domain, input, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      const dkim = await ensureDkimInternal(zone, input, req);
      const result = dkim.changed ? await publish(zone, req) : { applied: null };
      audit(req, { action: 'dns.email.dkim', target: domain, args: { selector: dkim.selector, generated: dkim.generated } });
      return { ...emailStatusOf(stmts.zoneByDomain.get(domain)), dkimResult: dkim, ...result };
    },

    async removeDkim(domain, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      db.transaction(() => {
        for (const r of stmts.records.all(zone.id)) if (r.type === 'TXT' && r.name.endsWith('._domainkey')) stmts.deleteRecord.run(r.id);
        stmts.deleteDkim.run(domain);
        bump(zone);
      })();
      const result = await publish(zone, req);
      try { await ctx.mail?.removeDkimKey?.(domain, req); } catch (err) { logger.warn({ err, domain }, 'mail service could not remove DKIM key'); }
      audit(req, { action: 'dns.email.dkim_remove', target: domain });
      return { ...emailStatusOf(stmts.zoneByDomain.get(domain)), ...result };
    },

    async setDmarc(domain, input, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      const value = input.value ? input.value.trim() : buildDmarc(input);
      if (!/^v=DMARC1;\s*p=(none|quarantine|reject)(;\s*[a-z]+=[^;]+)*;?$/i.test(value)) throw unprocessable('Not a valid DMARC record', { value: ['DMARC must start with v=DMARC1; p=none|quarantine|reject'] });
      db.transaction(() => { replaceByNameType(zone, '_dmarc', 'TXT', [{ value }]); bump(zone); })();
      const result = await publish(zone, req);
      audit(req, { action: 'dns.email.dmarc', target: domain, args: { value } });
      return { ...emailStatusOf(stmts.zoneByDomain.get(domain)), ...result };
    },

    // Exposed for the mail category: the decrypted private key to install in Exim.
    getDkimKey(domain) {
      const key = stmts.dkim.get(domain);
      if (!key) return null;
      return { domain, selector: key.selector, privateKeyPem: cryptoSvc.decrypt(key.private_key_enc), publicKey: key.public_key, createdAt: key.created_at };
    },

    enableEmailAuthAll({ dkim = true, spf = true, dmarc = false, domains } = {}, user) {
      assertPublishable();
      const job = ctx.jobs.enqueue('dns.email_auth_all', { dkim, spf, dmarc, domains: domains ?? null, userId: user.id }, { userId: user.id });
      return { job };
    },

    async runEmailAuthAll(jobCtx) {
      const { dkim, spf, dmarc, domains } = jobCtx.params;
      const zones = db.prepare('SELECT z.*, a.username AS account FROM dns_zones z LEFT JOIN accounts a ON a.id = z.account_id ORDER BY z.domain').all().filter((z) => !domains || domains.includes(z.domain));
      const summary = { total: zones.length, changed: 0, skipped: 0, failed: 0 };
      let i = 0;
      for (const zone of zones) {
        i++;
        jobCtx.progress((i / Math.max(1, zones.length)) * 100, zone.domain);
        try {
          const status = emailStatusOf(zone);
          let changed = false;
          if (spf && !status.spf) { db.transaction(() => { replaceByNameType(zone, '@', 'TXT', [...txtAt(stmts.records.all(zone.id), '@').filter((r) => !r.value.toLowerCase().startsWith('v=spf1')).map((r) => ({ value: r.value, ttl: r.ttl })), { value: suggestedSpf(stmts.records.all(zone.id)) }]); bump(zone); })(); changed = true; }
          if (dkim && !status.dkim) { const r = await ensureDkimInternal(zone, {}, null); changed = changed || r.changed; }
          if (dmarc && !status.dmarc) { db.transaction(() => { replaceByNameType(zone, '_dmarc', 'TXT', [{ value: buildDmarc({ p: 'none', rua: `postmaster@${zone.domain}` }) }]); bump(zone); })(); changed = true; }
          if (changed) {
            const r = await publish(zone, null, { reload: false });
            summary.changed++;
            jobCtx.log(`${zone.domain}: updated${r.applied ? '' : ' (not published: BIND missing)'}`);
          } else { summary.skipped++; jobCtx.log(`${zone.domain}: already configured`); }
        } catch (err) {
          summary.failed++;
          jobCtx.log(`${zone.domain}: ${err.message}`, 'error');
        }
      }
      if (summary.changed && bindAvailable()) { try { await agent.op('dns.reload', {}); jobCtx.log('named reloaded'); } catch (err) { jobCtx.log(`reload failed: ${err.message}`, 'warn'); } }
      audit(null, { action: 'dns.email.enable_all', target: 'all', args: { dkim, spf, dmarc, ...summary } });
      return summary;
    },

    // --------------------------------------------------------------- routing
    listRouting(query, user) {
      const zones = allVisibleZones(user).filter((z) => !query.account || z.account === query.account);
      return zones.map((z) => {
        const md = stmts.mailDomain.get(z.domain);
        return { domain: z.domain, account: z.account ?? null, routing: md?.routing ?? 'auto', mx: stmts.records.all(z.id).filter((r) => r.type === 'MX').map(shapeRecord).sort((a, b) => a.priority - b.priority) };
      });
    },

    async setRouting(domain, input, user, req) {
      assertPublishable();
      const zone = await load(domain, user);
      const { routing } = input;
      const exchanges = (input.exchanges || []).map((e) => ({ priority: e.priority, value: absoluteName(e.exchange, domain) }));
      if (['remote', 'backup'].includes(routing) && !exchanges.length) throw unprocessable('Remote and backup routing need at least one external mail exchanger', { exchanges: ['Add at least one MX host'] });
      const localMx = `mail.${domain}.`;
      db.transaction(() => {
        const records = stmts.records.all(zone.id);
        if (routing === 'local') {
          replaceByNameType(zone, '@', 'MX', [{ priority: 0, value: localMx }]);
          if (!records.some((r) => r.name === 'mail' && ['A', 'AAAA', 'CNAME'].includes(r.type))) {
            const apexA = records.find((r) => r.name === '@' && r.type === 'A');
            const ip = apexA?.value || zone.account_ip || setting('basic.main_ip') || null;
            if (ip) replaceByNameType(zone, 'mail', 'A', [{ value: ip }]);
          }
        } else if (routing === 'remote') {
          replaceByNameType(zone, '@', 'MX', exchanges);
        } else if (routing === 'backup') {
          const highest = Math.max(...exchanges.map((e) => e.priority)) + 10;
          replaceByNameType(zone, '@', 'MX', [...exchanges, { priority: highest, value: localMx }]);
        }
        stmts.upsertMailDomain.run(zone.account_id ?? null, domain, routing);
        bump(zone);
      })();
      const result = await publish(zone, req);
      let mailApplied = null;
      try { if (typeof ctx.mail?.setRouting === 'function') { await ctx.mail.setRouting(domain, routing, req); mailApplied = true; } } catch (err) { mailApplied = false; logger.warn({ err, domain }, 'mail service could not apply routing'); }
      audit(req, { action: 'dns.routing', target: domain, args: { routing, exchanges } });
      return { domain, routing, mx: stmts.records.all(zone.id).filter((r) => r.type === 'MX').map(shapeRecord), mailApplied, ...result };
    },

    // ----------------------------------------------------- nameserver report
    async nameserverReport({ domain, limit = 50 } = {}, user) {
      const zones = (domain ? [await load(domain, user)] : allVisibleZones(user)).slice(0, limit);
      const expected = setting('basic.nameservers', []).map((n) => `${n.toLowerCase().replace(/\.$/, '')}.`);
      const servers = setting('dns.resolvers', []);
      const resolve = async (name, type) => {
        try { return await agent.op('dns.resolve', { name: name.replace(/\.$/, ''), type, servers: servers.length ? servers : undefined, timeoutMs: 3000 }); } catch (err) { return { answers: [], error: err.code || 'EFAIL' }; }
      };
      const results = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < zones.length) {
          const zone = zones[cursor++];
          const records = stmts.records.all(zone.id);
          const zoneNs = records.filter((r) => r.type === 'NS' && r.name === '@').map((r) => r.value.toLowerCase());
          const apexA = records.filter((r) => r.type === 'A' && r.name === '@').map((r) => r.value);
          const delegated = await resolve(zone.domain, 'NS');
          const delegatedNs = delegated.answers.map((a) => `${String(a).toLowerCase().replace(/\.$/, '')}.`);
          const publicA = await resolve(zone.domain, 'A');
          const nameserverHosts = [...new Set([...zoneNs, ...delegatedNs])];
          const glue = await Promise.all(nameserverHosts.map(async (ns) => ({ host: ns, ...(await resolve(ns, 'A')) })));
          const issues = [];
          if (delegated.error) issues.push({ level: 'error', message: `Delegation lookup failed (${delegated.error}); the domain may not be registered or the parent has no NS for it` });
          for (const ns of zoneNs) if (delegatedNs.length && !delegatedNs.includes(ns)) issues.push({ level: 'warning', message: `${ns} is in the zone but not delegated at the registrar` });
          for (const ns of delegatedNs) if (!zoneNs.includes(ns)) issues.push({ level: 'warning', message: `${ns} is delegated at the registrar but missing from the zone's NS records` });
          for (const ns of expected) if (!zoneNs.includes(ns)) issues.push({ level: 'info', message: `Server nameserver ${ns} is not listed in the zone` });
          for (const g of glue) if (!g.answers.length) issues.push({ level: 'error', message: `Nameserver ${g.host} does not resolve to an address` });
          if (publicA.answers.length && apexA.length && !publicA.answers.some((a) => apexA.includes(a))) issues.push({ level: 'warning', message: `Public A (${publicA.answers.join(', ')}) differs from the zone (${apexA.join(', ')}); the zone may not be served from here` });
          results.push({
            domain: zone.domain, account: zone.account ?? null, zoneNs, delegatedNs, apexA, publicA: publicA.answers,
            glue: glue.map((g) => ({ host: g.host, addresses: g.answers, error: g.error })),
            status: issues.some((i) => i.level === 'error') ? 'error' : issues.some((i) => i.level === 'warning') ? 'warning' : 'ok',
            issues,
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, zones.length) }, worker));
      results.sort((a, b) => a.domain.localeCompare(b.domain));
      return { resolvers: servers.length ? servers : 'system', expectedNameservers: expected, total: zones.length, zones: results };
    },

    // ------------------------------------------------------------------ park
    listParked(query, user) {
      const where = ["d.type IN ('parked', 'alias')"];
      const params = {};
      if (!isRoot(user)) { where.push('a.owner_id = @owner'); params.owner = user.id; }
      if (query.account) { where.push('a.username = @account'); params.account = query.account; }
      if (query.q) { where.push('(d.domain LIKE @q OR a.username LIKE @q)'); params.q = `%${query.q}%`; }
      const result = paginate(db, {
        select: 'd.id, d.domain, d.type, d.docroot, d.created_at, a.username AS account, a.domain AS target, (SELECT 1 FROM dns_zones z WHERE z.domain = d.domain) AS has_zone',
        from: 'account_domains d JOIN accounts a ON a.id = d.account_id', where, params,
        sortable: { domain: 'd.domain', account: 'a.username', created_at: 'd.created_at' }, defaultSort: 'domain', query,
      });
      return { ...result, data: result.data.map((r) => ({ ...r, has_zone: Boolean(r.has_zone) })) };
    },

    async parkDomain(input, user, req) {
      const { domain, createZone = true } = input;
      const account = loadAccount(input.account, user);
      if (stmts.domainHosted.get(domain, domain)) throw conflict(`${domain} is already hosted on this server`);
      if (createZone) assertPublishable();
      if (account.suspended) throw conflict('That account is suspended');
      const limit = json.parse(account.plan_snapshot_json, {}).max_parked;
      const parkedCount = db.prepare("SELECT COUNT(*) AS n FROM account_domains WHERE account_id = ? AND type IN ('parked', 'alias')").get(account.id).n;
      if (limit != null && limit >= 0 && parkedCount >= limit && !isRoot(user)) throw forbidden(`The account's package allows ${limit} parked domain(s)`);
      const docroot = stmts.accountByAnyDomain.get(account.domain)?.docroot || `${account.home_dir}/public_html`;
      stmts.insertParked.run(account.id, domain, 'parked', docroot);
      let zone = null;
      if (createZone && !stmts.zoneByDomain.get(domain)) zone = await createZoneInternal({ domain, ip: input.ip || account.ip, template: 'standard', accountId: account.id }, req);
      let web = 'pending';
      try {
        if (typeof ctx.web?.addAlias === 'function') { await ctx.web.addAlias({ username: account.username, domain: account.domain, alias: domain, docroot }, req); web = 'applied'; }
        else if (typeof ctx.web?.syncAccount === 'function') { await ctx.web.syncAccount(account.username, req); web = 'applied'; }
      } catch (err) { web = `failed: ${err.message}`; logger.warn({ err, domain }, 'web service could not add the alias'); }
      audit(req, { action: 'dns.park', target: domain, args: { account: account.username, createZone } });
      return { domain, account: account.username, target: account.domain, docroot, zone: zone ? { domain: zone.domain, applied: zone.applied } : null, web };
    },

    async unparkDomain(domain, { removeZone = true } = {}, user, req) {
      const parked = stmts.parkedByDomain.get(domain);
      if (!parked) throw notFound(`Parked domain ${domain}`);
      if (!isRoot(user) && parked.owner_id !== user.id) throw forbidden('That domain belongs to another reseller\'s account');
      stmts.deleteParked.run(parked.id);
      const zone = stmts.zoneByDomain.get(domain);
      if (removeZone && zone) await removeZoneInternal(zone, req);
      let web = 'pending';
      try {
        if (typeof ctx.web?.removeAlias === 'function') { await ctx.web.removeAlias({ username: parked.account, alias: domain }, req); web = 'applied'; }
        else if (typeof ctx.web?.syncAccount === 'function') { await ctx.web.syncAccount(parked.account, req); web = 'applied'; }
      } catch (err) { web = `failed: ${err.message}`; }
      audit(req, { action: 'dns.unpark', target: domain, args: { removeZone } });
      return { domain, unparked: true, zoneRemoved: Boolean(removeZone && zone), web };
    },

    // --------------------------------------------------------------- cleanup
    async cleanupReport() {
      await importFromDisk();
      const hostname = setting('basic.hostname', '');
      const hostZone = hostname.includes('.') ? zoneContaining(hostname)?.domain : null;
      const zones = db.prepare('SELECT z.*, a.username AS account FROM dns_zones z LEFT JOIN accounts a ON a.id = z.account_id ORDER BY z.domain').all();
      const orphans = zones.filter((z) => !z.account && !stmts.domainHosted.get(z.domain, z.domain) && !accountForDomain(z.domain) && z.domain !== hostZone)
        .map((z) => ({ domain: z.domain, serial: z.serial, updated_at: z.updated_at, reason: 'no account owns this domain' }));
      let unmanaged = [];
      let missingOnDisk = [];
      if (bindAvailable()) {
        try {
          const listing = await agent.op('dns.zone.list', {});
          const onDisk = new Set((listing?.zones || []).filter((z) => z.exists).map((z) => z.domain));
          unmanaged = (listing?.zones || []).filter((z) => z.exists && !stmts.zoneByDomain.get(z.domain)).map((z) => ({ domain: z.domain, path: z.path }));
          missingOnDisk = zones.filter((z) => !onDisk.has(z.domain)).map((z) => ({ domain: z.domain, account: z.account }));
        } catch (err) { logger.warn({ err }, 'cleanup: could not list zone files'); }
      }
      return { orphans, unmanaged, missingOnDisk, bindInstalled: bindAvailable(), total: zones.length };
    },

    async cleanup({ domains, all = false, republish = false }, user, req) {
      const report = await service.cleanupReport();
      const targets = all ? report.orphans.map((o) => o.domain) : (domains || []).filter((d) => report.orphans.some((o) => o.domain === d));
      const results = [];
      for (const domain of targets) {
        try { await removeZoneInternal(stmts.zoneByDomain.get(domain), req); results.push({ domain, removed: true }); } catch (err) { results.push({ domain, removed: false, error: err.message }); }
      }
      const republished = [];
      if (republish) {
        for (const m of report.missingOnDisk) {
          try { await publish(stmts.zoneByDomain.get(m.domain), req, { reload: false }); republished.push({ domain: m.domain, ok: true }); } catch (err) { republished.push({ domain: m.domain, ok: false, error: err.message }); }
        }
        if (republished.length && bindAvailable()) { try { await agent.op('dns.reload', {}, { req }); } catch { /* reported per zone */ } }
      }
      audit(req, { action: 'dns.cleanup', target: 'zones', args: { removed: results.filter((r) => r.removed).map((r) => r.domain), republished: republished.length } });
      return { removed: results, republished, skipped: (domains || []).filter((d) => !targets.includes(d)) };
    },

    // ------------------------------------------------------------ forwarding
    listForwarding(query, user) {
      const where = [];
      const params = {};
      if (!isRoot(user)) { where.push('a.owner_id = @owner'); params.owner = user.id; }
      if (query.account) { where.push('a.username = @account'); params.account = query.account; }
      if (query.q) { where.push('(f.domain LIKE @q OR f.target_url LIKE @q)'); params.q = `%${query.q}%`; }
      const result = paginate(db, {
        select: 'f.*, a.username AS account', from: 'domain_forwarding f LEFT JOIN accounts a ON a.id = f.account_id', where, params,
        sortable: { domain: 'f.domain', account: 'a.username', status: 'f.status', updated_at: 'f.updated_at' }, defaultSort: 'domain', query,
      });
      return { ...result, data: result.data.map((r) => ({ ...r, match_www: Boolean(r.match_www), keep_path: Boolean(r.keep_path), webSupported: typeof ctx.web?.setRedirects === 'function' })) };
    },

    async applyForwardingRow(row, req) {
      if (typeof ctx.web?.setRedirects !== 'function') { stmts.forwardingStatus.run('pending', 'web service not available yet', row.domain); return 'pending'; }
      try {
        await ctx.web.setRedirects(row.domain, [{ from: '/', to: row.target_url, type: row.type, matchWww: Boolean(row.match_www), keepPath: Boolean(row.keep_path), account: row.account }], req);
        stmts.forwardingStatus.run('applied', null, row.domain);
        return 'applied';
      } catch (err) {
        stmts.forwardingStatus.run('failed', err.message, row.domain);
        return 'failed';
      }
    },

    async setForwarding(domain, input, user, req) {
      const account = accountForDomain(domain);
      if (!account && !isRoot(user)) throw forbidden('Resellers can only forward domains hosted on their accounts');
      if (account && !isRoot(user) && account.owner_id !== user.id) throw forbidden('That domain belongs to another reseller\'s account');
      let url;
      try { url = new URL(input.targetUrl); } catch { throw unprocessable('Target must be an absolute URL', { targetUrl: ['e.g. https://www.example.com/'] }); }
      if (!['http:', 'https:'].includes(url.protocol)) throw unprocessable('Target must use http or https', { targetUrl: ['Only http:// and https:// targets are allowed'] });
      stmts.upsertForwarding.run({ domain, account_id: account?.id ?? null, target_url: url.toString(), type: input.type || 'permanent', match_www: input.matchWww === false ? 0 : 1, keep_path: input.keepPath === false ? 0 : 1 });
      const status = await service.applyForwardingRow(stmts.forwarding.get(domain), req);
      audit(req, { action: 'dns.forwarding.set', target: domain, args: { targetUrl: url.toString(), type: input.type, status } });
      const row = stmts.forwarding.get(domain);
      return { ...row, match_www: Boolean(row.match_www), keep_path: Boolean(row.keep_path), owner_id: undefined };
    },

    async removeForwarding(domain, user, req) {
      const row = stmts.forwarding.get(domain);
      if (!row) throw notFound(`Forwarding for ${domain}`);
      if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That domain belongs to another reseller\'s account');
      stmts.deleteForwarding.run(domain);
      let web = 'pending';
      try { if (typeof ctx.web?.setRedirects === 'function') { await ctx.web.setRedirects(domain, [], req); web = 'applied'; } } catch (err) { web = `failed: ${err.message}`; }
      audit(req, { action: 'dns.forwarding.remove', target: domain });
      return { domain, removed: true, web };
    },

    async applyForwarding(user, req) {
      const rows = db.prepare("SELECT f.*, a.username AS account FROM domain_forwarding f LEFT JOIN accounts a ON a.id = f.account_id WHERE f.status != 'applied'").all();
      const results = [];
      for (const row of rows) results.push({ domain: row.domain, status: await service.applyForwardingRow(row, req) });
      audit(req, { action: 'dns.forwarding.apply', target: 'pending', args: { count: rows.length } });
      return { results, webSupported: typeof ctx.web?.setRedirects === 'function' };
    },

    // ------------------------------------------------------------------ sync
    listClusters: () => stmts.clusters.all().map((c) => ({ ...c, enabled: Boolean(c.enabled), has_token: Boolean(c.has_token) })),
    syncStatus() {
      return { clusters: service.listClusters(), zones: stmts.syncStatus.all().map((r) => ({ ...r, stale: r.serial !== r.current_serial })) };
    },
    enqueueSync({ domains, clusterId } = {}, user) {
      const job = ctx.jobs.enqueue('dns.sync', { domains: domains ?? null, clusterId: clusterId ?? null, userId: user?.id ?? null }, { userId: user?.id ?? null });
      return { job };
    },

    // Pushes rendered zones to every enabled peer's /api/dns/zones/import.
    async runSync(jobCtx) {
      const { domains, clusterId } = jobCtx.params;
      const peers = db.prepare("SELECT * FROM dns_clusters WHERE enabled = 1 AND role IN ('write-only', 'sync')").all().filter((c) => !clusterId || c.id === clusterId);
      if (!peers.length) { jobCtx.log('No DNS cluster peers are configured; nothing to synchronise'); return { peers: 0, zones: 0, ok: 0, failed: 0 }; }
      const zones = db.prepare('SELECT * FROM dns_zones ORDER BY domain').all().filter((z) => !domains || domains.includes(z.domain));
      const verifyTls = setting('dns.cluster_verify_tls', true);
      const summary = { peers: peers.length, zones: zones.length, ok: 0, failed: 0 };
      let i = 0;
      for (const peer of peers) {
        if (!peer.api_token_enc) { jobCtx.log(`${peer.name}: no API token configured`, 'warn'); summary.failed += zones.length; continue; }
        let token;
        let url;
        try { token = cryptoSvc.decrypt(peer.api_token_enc); url = new URL('/api/dns/zones/import', parseRemote(peer.remote_host)); } catch (err) { jobCtx.log(`${peer.name}: ${err.message}`, 'error'); summary.failed += zones.length; continue; }
        for (const zone of zones) {
          i++;
          jobCtx.progress((i / Math.max(1, peers.length * zones.length)) * 100, `${zone.domain} → ${peer.name}`);
          const body = renderZone(zone, stmts.records.all(zone.id));
          try {
            const res = await postJson(url, { domain: zone.domain, body, serial: zone.serial }, { token, verifyTls });
            if (res.status >= 200 && res.status < 300) { stmts.syncRow.run(zone.id, peer.id, zone.serial, 'ok', null); summary.ok++; jobCtx.log(`${zone.domain} → ${peer.name}: ok`); }
            else { const msg = res.body?.error?.message || `HTTP ${res.status}`; stmts.syncRow.run(zone.id, peer.id, zone.serial, 'failed', msg); summary.failed++; jobCtx.log(`${zone.domain} → ${peer.name}: ${msg}`, 'error'); }
          } catch (err) {
            stmts.syncRow.run(zone.id, peer.id, zone.serial, 'failed', err.message); summary.failed++; jobCtx.log(`${zone.domain} → ${peer.name}: ${err.message}`, 'error');
          }
        }
        stmts.clusterSynced.run(peer.id);
      }
      audit(null, { action: 'dns.sync', target: 'cluster', args: summary });
      return summary;
    },

    // Called by a peer (API token) to receive a zone pushed from its master.
    async importZone({ domain, body }, user, req) {
      return service.saveRawZone(domain, body, user, req, { create: true });
    },

    // ----------------------------------------------- helpers for other categories
    zoneExists: (domain) => Boolean(stmts.zoneByDomain.get(domain)),
    zoneFor: (name) => { const z = zoneContaining(name); return z ? shapeZone(z) : null; },
    renderZoneText(domain) {
      const zone = stmts.zoneByDomain.get(domain);
      if (!zone) throw notFound(`Zone ${domain}`);
      return renderZone(zone, stmts.records.all(zone.id));
    },
    // Idempotent zone provisioning for account creation / addon domains.
    async ensureZoneForDomain(domain, { ip, accountId, template } = {}, req) {
      const existing = stmts.zoneByDomain.get(domain);
      if (existing) {
        if (accountId && existing.account_id !== accountId) db.transaction(() => { bump(existing, { account_id: accountId }); })();
        return { ...shapeZone(stmts.zoneByDomain.get(domain)), created: false };
      }
      if (!bindAvailable() && strict()) return { domain, created: false, applied: false, reason: 'capability_missing' };
      return { ...(await createZoneInternal({ domain, ip, template: template || 'standard', accountId: accountId ?? accountForDomain(domain)?.id ?? null }, req)), created: true };
    },
    // Replaces every record of (name, type) in a zone; e.g. ctx.dns.upsertRecords('example.com', 'www', 'A', [{ value: '10.0.0.2' }]).
    async upsertRecords(domain, name, type, values, req) {
      const zone = stmts.zoneByDomain.get(domain);
      if (!zone) throw notFound(`Zone ${domain}`);
      const rel = name === domain || name === `${domain}.` ? '@' : name.replace(new RegExp(`\\.${domain.replace(/\./g, '\\.')}\\.?$`), '');
      const recs = values.map((v) => normalizeRecord({ name: rel, type, ttl: v.ttl, priority: v.priority, value: v.value }, domain));
      db.transaction(() => { replaceByNameType(zone, rel, type.toUpperCase(), recs); bump(zone); })();
      return publish(zone, req);
    },
    async removeZonesForAccount(accountId, req) {
      const zones = db.prepare('SELECT * FROM dns_zones WHERE account_id = ?').all(accountId);
      const removed = [];
      for (const z of zones) { try { await removeZoneInternal(z, req); removed.push(z.domain); } catch (err) { logger.warn({ err, domain: z.domain }, 'could not remove zone'); } }
      return { removed };
    },
    importFromDisk,
    RECORD_TYPES,
  };

  return service;
}
