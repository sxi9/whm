import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import {
  RECORD_TYPES, ZoneError, nextSerial, normalizeRecord, renderZone, renderTemplate, parseZone, parseSoaValue, soaValue, checkConflicts,
} from './dns-zonefile.js';

// RFC 7208 grammar, loosely: a/mx/ptr take an optional domain-spec and
// CIDR, include/exists/redirect/exp take a domain-spec, and a domain-spec may
// carry macros such as %{d}. Shell-ish characters never pass.
const SPF_DOMAIN = '[a-z0-9._%{}+=-]+';
const SPF_CIDR = '(?:\\/\\d{1,3})?(?:\\/\\/\\d{1,3})?';
const SPF_RE = new RegExp(`^v=spf1(?: [+\\-~?]?(?:all|(?:a|mx|ptr)(?::${SPF_DOMAIN})?${SPF_CIDR}|ip4:[0-9.]+(?:\\/\\d{1,2})?|ip6:[0-9a-f:.]+(?:\\/\\d{1,3})?|(?:include|exists):${SPF_DOMAIN}|(?:redirect|exp)=${SPF_DOMAIN}))*$`, 'i');
const DMARC_RE = /^v=DMARC1;\s*p=(none|quarantine|reject)(;\s*[a-z]+=[^;\r\n]+)*;?$/i;
const IMPORT_INTERVAL_MS = 5 * 60 * 1000;

// API callers give hostnames as FQDNs (no trailing dot); '@' means the zone apex.
const fqdn = (value, domain) => (value === '@' ? `${domain}.` : String(value).toLowerCase().endsWith('.') ? String(value).toLowerCase() : `${String(value).toLowerCase()}.`);

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
    restoreRecord: db.prepare('INSERT INTO dns_records (id, zone_id, name, type, ttl, priority, value, line_index) VALUES (@id, @zone_id, @name, @type, @ttl, @priority, @value, @line_index)'),
    restoreZone: db.prepare('UPDATE dns_zones SET serial = @serial, ttl = @ttl, dnssec_enabled = @dnssec_enabled, account_id = @account_id, updated_at = @updated_at WHERE id = @id'),
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
    parkedByDomain: db.prepare("SELECT d.*, a.username AS account, a.domain AS target, a.owner_id, a.home_dir FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ? AND d.type IN ('parked', 'alias')"),
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
    syncRow: db.prepare(`INSERT INTO dns_zone_sync (zone_id, cluster_id, serial, status, message, endpoint, synced_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (zone_id, cluster_id) DO UPDATE SET serial = excluded.serial, status = excluded.status, message = excluded.message, endpoint = excluded.endpoint, synced_at = excluded.synced_at`),
    syncStatus: db.prepare('SELECT s.*, z.domain, z.serial AS current_serial, c.name AS cluster FROM dns_zone_sync s JOIN dns_zones z ON z.id = s.zone_id JOIN dns_clusters c ON c.id = s.cluster_id ORDER BY z.domain, c.name'),
    syncRowFor: db.prepare('SELECT * FROM dns_zone_sync WHERE zone_id = ? AND cluster_id = ?'),
  };

  let lastImportAt = 0;
  const strict = () => config.env === 'production';
  const bindAvailable = () => capabilities.has('bind');
  const setting = (key, fallback) => settings.get(key, fallback);
  // The server hostname (and www.<name>) is served by its own landing vhost,
  // never by an account; Service Configuration owns the rule when loaded.
  const isServerName = (domain) => {
    if (typeof ctx.web?.isServerName === 'function') return ctx.web.isServerName(domain);
    const name = String(setting('basic.hostname', '') || '').trim().toLowerCase();
    const d = String(domain || '').trim().toLowerCase();
    return Boolean(name) && (d === name || d === `www.${name}`);
  };
  // A reseller's own nameservers (Edit Reseller Nameservers) take precedence over the server defaults.
  const nameservers = (override) => {
    const ns = Array.isArray(override) && override.length ? override : setting('basic.nameservers', []);
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

  // A zone mirrored to Cloudflare is served from there, so it stays editable
  // on a host without BIND; everything else needs named in production.
  function assertPublishable(domain) {
    if (bindAvailable() || !strict()) return;
    if (domain && stmts.zoneByDomain.get(domain)?.provider === 'cloudflare') return;
    throw new CapabilityError('bind', 'BIND (named) is not installed on this server. Install bind9 / bind to publish DNS zones.');
  }

  // After a committed change of a Cloudflare zone the records are pushed in a
  // job; a failure to queue it is reported on the zone, never to the caller.
  function mirror(fresh, { mirror: enabled = true, req } = {}) {
    if (!enabled || fresh?.provider !== 'cloudflare' || !ctx.dnsCloudflare) return null;
    try {
      const job = ctx.dnsCloudflare.enqueuePush(fresh.domain, { reason: 'zone changed', userId: req?.user?.id ?? null });
      return job ? { provider: 'cloudflare', jobId: job.id } : null;
    } catch (err) {
      logger.warn({ err, domain: fresh.domain }, 'could not queue the Cloudflare push');
      return { provider: 'cloudflare', jobId: null, error: err.message };
    }
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
  // to disk (the agent verifies named-checkconf and reverts on failure) and
  // reloads named, reconfiguring first when the zone's stanza changed. On a
  // dev box without BIND the DB is still updated and the caller learns the
  // zone is unpublished.
  async function publish(zone, req, { reload = true, mirror: mirrorEnabled = true } = {}) {
    const fresh = stmts.zoneByDomain.get(zone.domain);
    const records = stmts.records.all(fresh.id);
    const body = renderZone(fresh, records);
    if (!bindAvailable()) {
      if (strict() && fresh.provider !== 'cloudflare') throw new CapabilityError('bind', 'BIND (named) is not installed; the zone was saved but cannot be published');
      return { applied: false, reason: 'capability_missing', serial: fresh.serial, mirror: mirror(fresh, { mirror: mirrorEnabled, req }) };
    }
    const check = await agent.op('dns.checkzone', { domain: fresh.domain, body }, { req });
    if (check?.ok === false) throw unprocessable(`Zone ${fresh.domain} failed named-checkzone`, { zone: [check.output || 'named-checkzone reported an error'] });
    let written;
    try {
      written = await agent.op('dns.zone.write', { domain: fresh.domain, body, allowTransfer: setting('dns.allow_transfer', []), signed: Boolean(fresh.dnssec_enabled) }, { req });
    } catch (err) {
      if (err.code === 'config_invalid') throw unprocessable(`named-checkconf rejected the configuration for ${fresh.domain}; nothing was changed on disk`, { zone: [err.details?.output || err.message] });
      // The operator's own stanza points named at a file the panel cannot
      // write (or a secondary zone): reporting "published" would be a lie.
      if (err.code === 'zone_external') throw conflict(err.message);
      throw err;
    }
    const external = Boolean(written?.external);
    if (fresh.dnssec_enabled) {
      if (external) throw unprocessable(`${fresh.domain} is declared in named.conf outside the panel include, so the panel cannot point named at the signed zone file`, { dnssec: ['Move the zone declaration into the panel-managed include (or remove it) before enabling DNSSEC'] });
      await agent.op('dns.dnssec.sign', { domain: fresh.domain }, { req });
    }
    const reconfig = Boolean(written?.stanzaAdded || written?.stanzaChanged || written?.includeAdded);
    let reloaded = false;
    let reloadError = null;
    if (reload) {
      try { await agent.op('dns.reload', { domain: fresh.domain, reconfig }, { req }); reloaded = true; } catch (err) { reloadError = err.message; logger.warn({ err, domain: fresh.domain }, 'zone written but named reload failed'); }
    }
    return { applied: true, reloaded, reloadError, reconfigured: reconfig, external, file: written?.path ?? null, serial: fresh.serial, mirror: mirror(fresh, { mirror: mirrorEnabled, req }) };
  }

  // Mutations commit to SQLite (the source of truth) and then publish; when
  // named-checkzone, named-checkconf or the agent rejects the result the rows
  // and serial are put back so the DB never keeps what BIND refused.
  function snapshotZone(zoneId) {
    return { zone: stmts.zoneById.get(zoneId), records: stmts.records.all(zoneId) };
  }

  function restoreZone(snap) {
    db.transaction(() => {
      stmts.deleteRecordsOfZone.run(snap.zone.id);
      for (const r of snap.records) stmts.restoreRecord.run({ id: r.id, zone_id: r.zone_id, name: r.name, type: r.type, ttl: r.ttl, priority: r.priority, value: r.value, line_index: r.line_index });
      stmts.restoreZone.run({ id: snap.zone.id, serial: snap.zone.serial, ttl: snap.zone.ttl, dnssec_enabled: snap.zone.dnssec_enabled, account_id: snap.zone.account_id, updated_at: snap.zone.updated_at });
    })();
  }

  async function commitAndPublish(zone, mutate, req, opts) {
    const snap = snapshotZone(zone.id);
    const out = db.transaction(mutate)();
    try {
      return { out, result: await publish(zone, req, opts) };
    } catch (err) {
      restoreZone(snap);
      throw err;
    }
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

  async function createZoneInternal({ domain, ip, template = 'standard', accountId = null, ttl, nameservers: ownerNs }, req) {
    if (stmts.zoneByDomain.get(domain)) throw conflict(`A zone for ${domain} already exists`);
    const tpl = stmts.template.get(template);
    if (!tpl) throw notFound(`Zone template "${template}"`);
    const { ns1, ns2 } = nameservers(ownerNs);
    const zoneTtl = ttl || setting('dns.default_ttl', 14400);
    const serial = nextSerial(0);
    const address = ip || setting('basic.main_ip') || setting('basic.shared_ip') || '127.0.0.1';
    const text = renderTemplate(tpl.body, { domain, ip: address, ns1, ns2, serial, ttl: zoneTtl, hostname: setting('basic.hostname', ''), ipv6: setting('basic.main_ipv6', '') });
    const parsed = parseZone(text, domain);
    if (parsed.errors.length) throw unprocessable(`Template "${template}" renders an invalid zone`, { template: parsed.errors });
    if (!parsed.records.some((r) => r.type === 'SOA')) throw unprocessable(`Template "${template}" has no SOA record`, { template: ['SOA record missing'] });
    const zone = insertZoneRows({ domain, account_id: accountId, serial: parsed.serial || serial, ttl: parsed.ttl || zoneTtl }, parsed.records);
    const result = await publishNewZone(zone, req);
    audit(req, { action: 'dns.zone.create', target: domain, args: { template, ip: address, accountId } });
    return { ...shapeZone(stmts.zoneByDomain.get(domain)), records: stmts.records.all(zone.id).map(shapeRecord), ...result };
  }

  // A freshly inserted zone that BIND rejects is dropped again entirely.
  async function publishNewZone(zone, req) {
    try {
      return await publish(zone, req);
    } catch (err) {
      db.transaction(() => { stmts.deleteRecordsOfZone.run(zone.id); stmts.deleteZone.run(zone.id); })();
      throw err;
    }
  }

  // The DB row goes only after the host no longer serves the zone: a zone the
  // operator declared outside the panel include would otherwise be re-imported
  // from disk while named keeps answering for it.
  async function removeZoneInternal(zone, req) {
    if (bindAvailable()) {
      let removed;
      try {
        removed = await agent.op('dns.zone.remove', { domain: zone.domain }, { req });
      } catch (err) {
        if (err.code === 'zone_external') throw conflict(err.message);
        throw err;
      }
      if (removed?.external) throw conflict(`${zone.domain} is declared in named.conf outside the panel include; remove that stanza first, then delete the zone again`);
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

  // WHM's "automatically detect" rule: this server is the primary MX → local,
  // a lower-priority MX → backup, not an MX at all → remote. An exchange is
  // local when it is a well-known local name or resolves (within the zone) to
  // one of this server's addresses. No MX at all means mail is delivered here.
  function effectiveRouting(zone, records) {
    const mx = records.filter((r) => r.type === 'MX').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    if (!mx.length) return 'local';
    const localIps = new Set([zone.account_ip, setting('basic.main_ip'), setting('basic.shared_ip'), setting('basic.main_ipv6')].filter(Boolean));
    try { for (const row of db.prepare('SELECT address FROM ip_addresses').all()) localIps.add(row.address); } catch { /* ip table absent */ }
    const hostname = setting('basic.hostname', '');
    const localHosts = new Set([`mail.${zone.domain}.`, `${zone.domain}.`, hostname ? `${hostname.toLowerCase().replace(/\.$/, '')}.` : null].filter(Boolean));
    const suffix = `.${zone.domain}.`;
    const isLocal = (exchange) => {
      const host = exchange.toLowerCase().endsWith('.') ? exchange.toLowerCase() : `${exchange.toLowerCase()}.`;
      if (localHosts.has(host)) return true;
      if (host !== `${zone.domain}.` && !host.endsWith(suffix)) return false;
      const rel = host === `${zone.domain}.` ? '@' : host.slice(0, -suffix.length);
      return records.some((r) => r.name === rel && ['A', 'AAAA'].includes(r.type) && localIps.has(r.value));
    };
    if (isLocal(mx[0].value)) return 'local';
    return mx.some((m) => isLocal(m.value)) ? 'backup' : 'remote';
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

  const isCapabilityMissing = (err) => err?.code === 'capability_missing' || err instanceof CapabilityError;

  // Runs a web-server side effect (alias, redirect). A missing web category or
  // a CapabilityError from it (no Apache yet) leaves the change 'pending' —
  // the vhost sync picks it up once the daemon exists; only real errors fail.
  async function applyWeb(domain, fn) {
    try {
      return { web: (await fn()) ? 'applied' : 'pending', webDetail: null };
    } catch (err) {
      if (isCapabilityMissing(err)) return { web: 'pending', webDetail: err.message };
      logger.warn({ err, domain }, 'web service could not apply the change');
      return { web: `failed: ${err.message}`, webDetail: err.message };
    }
  }

  function parseRemote(host) {
    const url = host.includes('://') ? new URL(host) : new URL(`https://${host}`);
    if (!url.port) url.port = '2087';
    return url;
  }

  function requestJson(url, { method = 'GET', body, token, verifyTls = true, timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const mod = url.protocol === 'http:' ? http : https;
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (payload !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
      const req = mod.request(url, { method, timeout: timeoutMs, rejectUnauthorized: verifyTls, headers }, (res) => {
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
      req.end(payload ?? undefined);
    });
  }
  const postJson = (url, body, opts) => requestJson(url, { ...opts, method: 'POST', body });

  // Peer TLS verification: the per-peer option (Clusters category) wins over
  // the global dns.cluster_verify_tls setting; the table may not exist on a
  // build without that category.
  function peerVerifyTls(peer) {
    try {
      const row = db.prepare('SELECT verify_tls FROM cluster_peer_options WHERE cluster_id = ?').get(peer.id);
      if (row && row.verify_tls != null) return Boolean(row.verify_tls);
    } catch { /* no cluster_peer_options table */ }
    return Boolean(setting('dns.cluster_verify_tls', true));
  }

  // Which endpoint a peer takes zones on: a cluster-aware panel answers
  // /api/clusters/ping and receives on /api/clusters/dns/receive (logged in its
  // exchange log); an older one only has /api/dns/zones/import. The answer
  // is cached per peer for the run.
  const PEER_RECEIVE = '/api/clusters/dns/receive';
  const PEER_IMPORT = '/api/dns/zones/import';
  async function probePeerEndpoint(base, { token, verifyTls }, log) {
    try {
      const res = await requestJson(new URL('/api/clusters/ping', base), { token, verifyTls, timeoutMs: 10_000 });
      if (res.status === 200) {
        const accepts = res.body?.data?.accepts;
        if (accepts && accepts.dns === false) log?.('peer answers ping but does not accept DNS pushes', 'warn');
        return { endpoint: PEER_RECEIVE, reason: 'cluster-aware peer' };
      }
      if (res.status === 401 || res.status === 403) return { endpoint: PEER_IMPORT, reason: `ping answered HTTP ${res.status}` };
      return { endpoint: PEER_IMPORT, reason: res.status === 404 ? 'peer has no cluster endpoints' : `ping answered HTTP ${res.status}` };
    } catch (err) {
      return { endpoint: PEER_IMPORT, reason: `ping failed: ${err.message}` };
    }
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

    // named-checkzone runs as root on the text; resellers may only submit it
    // for zones they own or domains hosted on their accounts.
    async validateZone(domain, body, user) {
      if (stmts.zoneByDomain.get(domain)) await load(domain, user);
      else if (!isRoot(user)) {
        const account = accountForDomain(domain);
        if (!account || account.owner_id !== user.id) throw forbidden('Resellers can only validate zones for domains on their own accounts');
      }
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
    async saveRawZone(domain, body, user, req, { create = false, minSerial = 0 } = {}) {
      assertPublishable(domain);
      let zone = stmts.zoneByDomain.get(domain);
      if (!zone) {
        if (!create) throw notFound(`Zone ${domain}`);
        if (!isRoot(user)) throw forbidden('Only root can create zones from raw text');
      } else visible(zone, user);
      const validation = await service.validateZone(domain, body, user);
      if (!validation.ok) throw unprocessable('Zone text is not valid', { body: validation.errors });
      const parsed = parseZone(body, domain);
      const created = !zone;
      let result;
      if (!zone) {
        zone = insertZoneRows({ domain, account_id: accountForDomain(domain)?.id ?? null, serial: Math.max(parsed.serial || nextSerial(0), minSerial || 0), ttl: parsed.ttl || setting('dns.default_ttl', 14400) }, parsed.records);
        result = await publishNewZone(zone, req);
      } else {
        ({ result } = await commitAndPublish(zone, () => {
          stmts.deleteRecordsOfZone.run(zone.id);
          parsed.records.forEach((r, i) => stmts.insertRecord.run({ zone_id: zone.id, name: r.name, type: r.type, ttl: r.ttl ?? null, priority: r.priority ?? null, value: r.value, line_index: i + 1 }));
          stmts.touchZone.run({ id: zone.id, serial: Math.max(nextSerial(zone.serial), parsed.serial || 0, minSerial || 0), ttl: parsed.ttl || zone.ttl, dnssec_enabled: zone.dnssec_enabled, account_id: zone.account_id });
        }, req));
      }
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
      assertPublishable(domain);
      const zone = await load(domain, user);
      let rec;
      try { rec = normalizeRecord(input, domain); } catch (err) { if (err instanceof ZoneError) throw unprocessable(err.message, err.fields); throw err; }
      const records = stmts.records.all(zone.id);
      const conflictMsg = checkConflicts(records, rec);
      if (conflictMsg) throw conflict(conflictMsg);
      if (records.some((r) => r.name === rec.name && r.type === rec.type && r.value === rec.value && (r.priority ?? null) === (rec.priority ?? null))) throw conflict('An identical record already exists');
      const { out: id, result } = await commitAndPublish(zone, () => {
        const { lastInsertRowid } = stmts.insertRecord.run({ zone_id: zone.id, ...rec, line_index: stmts.maxLine.get(zone.id).n + 1 });
        bump(zone);
        return Number(lastInsertRowid);
      }, req);
      audit(req, { action: 'dns.record.add', target: domain, args: rec });
      return { record: shapeRecord(stmts.recordById.get(id, zone.id)), ...result };
    },

    async updateRecord(domain, id, input, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const existing = stmts.recordById.get(id, zone.id);
      if (!existing || existing.type === 'SOA') throw notFound('Record');
      let rec;
      try { rec = normalizeRecord({ ...existing, ...input, ttl: input.ttl === undefined ? existing.ttl : input.ttl, priority: input.priority === undefined ? existing.priority : input.priority }, domain); } catch (err) { if (err instanceof ZoneError) throw unprocessable(err.message, err.fields); throw err; }
      const conflictMsg = checkConflicts(stmts.records.all(zone.id), rec, existing.id);
      if (conflictMsg) throw conflict(conflictMsg);
      const { result } = await commitAndPublish(zone, () => { stmts.updateRecord.run({ id: existing.id, ...rec }); bump(zone); }, req);
      audit(req, { action: 'dns.record.update', target: `${domain}#${id}`, args: rec });
      return { record: shapeRecord(stmts.recordById.get(id, zone.id)), ...result };
    },

    async deleteRecord(domain, id, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const existing = stmts.recordById.get(id, zone.id);
      if (!existing || existing.type === 'SOA') throw notFound('Record');
      const { result } = await commitAndPublish(zone, () => { stmts.deleteRecord.run(existing.id); bump(zone); }, req);
      audit(req, { action: 'dns.record.delete', target: `${domain}#${id}`, args: shapeRecord(existing) });
      return { deleted: true, ...result };
    },

    async setSoa(domain, input, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const records = stmts.records.all(zone.id);
      const soaRec = records.find((r) => r.type === 'SOA');
      const current = parseSoaValue(soaRec?.value, domain);
      const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
      next.primary = fqdn(next.primary, domain);
      next.hostmaster = fqdn(next.hostmaster, domain);
      const { result } = await commitAndPublish(zone, () => {
        if (soaRec) stmts.updateRecord.run({ id: soaRec.id, name: '@', type: 'SOA', ttl: soaRec.ttl, priority: null, value: soaValue(next) });
        else stmts.insertRecord.run({ zone_id: zone.id, name: '@', type: 'SOA', ttl: null, priority: null, value: soaValue(next), line_index: 0 });
        bump(zone);
      }, req);
      audit(req, { action: 'dns.zone.soa', target: domain, args: next });
      return { soa: { ...next, serial: stmts.zoneById.get(zone.id).serial }, ...result };
    },

    async setTtl(domain, ttl, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const { result } = await commitAndPublish(zone, () => { bump(zone, { ttl }); }, req);
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
      let result;
      try {
        ({ result } = await commitAndPublish(zone, () => { bump(zone, { dnssec_enabled: enabled ? 1 : 0 }); }, req));
      } catch (err) {
        if (keys) { try { await agent.op('dns.dnssec.remove', { domain }, { req }); } catch (cleanupErr) { logger.warn({ err: cleanupErr, domain }, 'could not remove the DNSSEC keys of a zone that failed to publish'); } }
        throw err;
      }
      // Keys and the .signed output go only once named serves the unsigned
      // file again; a failed publish above leaves the signed setup intact.
      if (!enabled && zone.dnssec_enabled && bindAvailable()) {
        try { await agent.op('dns.dnssec.remove', { domain }, { req }); } catch (err) { logger.warn({ err, domain }, 'DNSSEC disabled but the keys could not be removed from disk'); }
      }
      audit(req, { action: enabled ? 'dns.dnssec.enable' : 'dns.dnssec.disable', target: domain });
      return { domain, dnssec_enabled: enabled, keys: Boolean(keys), ds: keys?.ds ?? [], dnskey: keys ? { ksk: keys.ksk?.record ?? null, zsk: keys.zsk?.record ?? null } : null, ...result };
    },

    // The DS/DNSKEY records are read back from the key files on the BIND host,
    // so the operator can fetch them for the registrar at any time without
    // regenerating keys.
    async dnssecStatus(domain, user) {
      const zone = await load(domain, user);
      if (!isRoot(user)) throw forbidden('Only root can read DNSSEC keys');
      const base = { domain, dnssec_enabled: Boolean(zone.dnssec_enabled), keys: false, ds: [], dnskey: null, signed: null, keyDir: null };
      if (!zone.dnssec_enabled) return base;
      if (!bindAvailable()) throw new CapabilityError('bind', 'The DNSSEC keys live on the BIND host; install bind9 / bind to read them');
      const status = await agent.op('dns.dnssec.status', { domain });
      return {
        ...base, keys: Boolean(status?.hasKeys), keyDir: status?.keyDir ?? null, ds: status?.ds ?? [],
        dnskey: status?.ksk || status?.zsk ? { ksk: status.ksk?.record ?? null, zsk: status.zsk?.record ?? null } : null,
        signed: status?.signed ?? null,
      };
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
      const { result } = await commitAndPublish(zone, () => { replaceByNameType(zone, relative, 'A', [{ value: ip }]); bump(zone); }, req);
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
      assertPublishable(domain);
      const zone = await load(domain, user);
      const value = (input.value || suggestedSpf(stmts.records.all(zone.id))).trim().replace(/\s+/g, ' ');
      if (!SPF_RE.test(value)) throw unprocessable('Not a valid SPF record', { value: ['SPF must start with v=spf1 and use a[:host], mx[:host], ptr, ip4:, ip6:, include:, exists:, redirect= and ~all / -all mechanisms'] });
      const { result } = await commitAndPublish(zone, () => {
        const others = txtAt(stmts.records.all(zone.id), '@', 'v=spf1');
        for (const r of others) stmts.deleteRecord.run(r.id);
        stmts.insertRecord.run({ zone_id: zone.id, name: '@', type: 'TXT', ttl: null, priority: null, value, line_index: stmts.maxLine.get(zone.id).n + 1 });
        bump(zone);
      }, req);
      audit(req, { action: 'dns.email.spf', target: domain, args: { value } });
      return { ...emailStatusOf(stmts.zoneByDomain.get(domain)), ...result };
    },

    async ensureDkim(domain, input, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const snap = snapshotZone(zone.id);
      const dkim = await ensureDkimInternal(zone, input, req);
      let result = { applied: null };
      if (dkim.changed) {
        try { result = await publish(zone, req); } catch (err) { restoreZone(snap); throw err; }
      }
      audit(req, { action: 'dns.email.dkim', target: domain, args: { selector: dkim.selector, generated: dkim.generated } });
      return { ...emailStatusOf(stmts.zoneByDomain.get(domain)), dkimResult: dkim, ...result };
    },

    async removeDkim(domain, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const { result } = await commitAndPublish(zone, () => {
        for (const r of stmts.records.all(zone.id)) if (r.type === 'TXT' && r.name.endsWith('._domainkey')) stmts.deleteRecord.run(r.id);
        bump(zone);
      }, req);
      stmts.deleteDkim.run(domain);
      try { await ctx.mail?.removeDkimKey?.(domain, req); } catch (err) { logger.warn({ err, domain }, 'mail service could not remove DKIM key'); }
      audit(req, { action: 'dns.email.dkim_remove', target: domain });
      return { ...emailStatusOf(stmts.zoneByDomain.get(domain)), ...result };
    },

    async setDmarc(domain, input, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const value = input.value ? input.value.trim() : buildDmarc(input);
      if (!DMARC_RE.test(value)) throw unprocessable('Not a valid DMARC record', { value: ['DMARC must start with v=DMARC1; p=none|quarantine|reject'] });
      const { result } = await commitAndPublish(zone, () => { replaceByNameType(zone, '_dmarc', 'TXT', [{ value }]); bump(zone); }, req);
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

    // ---------------------------------------------------------------- dnssec
    // dnssec-signzone signatures expire after 30 days; the nightly schedule
    // re-signs every signed zone whose signed output is older than the window.
    // A re-sign goes through a normal publish (serial bump, write, sign with
    // the new serial, reload) so secondaries notice the fresh signatures.
    async runResign(jobCtx) {
      const zones = db.prepare('SELECT * FROM dns_zones WHERE dnssec_enabled = 1 ORDER BY domain').all();
      const summary = { total: zones.length, signed: 0, skipped: 0, failed: 0 };
      if (!zones.length) { jobCtx.log('No DNSSEC-signed zones'); return summary; }
      if (!bindAvailable()) { jobCtx.log('BIND is not installed; zones cannot be re-signed', 'warn'); summary.failed = zones.length; return summary; }
      const maxAgeSeconds = Math.max(1, Number(setting('dns.dnssec_resign_days', 7))) * 86400;
      let i = 0;
      for (const zone of zones) {
        i++;
        jobCtx.progress((i / zones.length) * 100, zone.domain);
        try {
          const status = await agent.op('dns.dnssec.status', { domain: zone.domain });
          if (!status?.hasKeys) throw new Error('no DNSSEC keys on disk; disable and re-enable DNSSEC to generate new ones');
          const fresh = status.signed?.exists && !status.signed.stale && status.signed.ageSeconds != null && status.signed.ageSeconds < maxAgeSeconds;
          if (fresh) { summary.skipped++; continue; }
          const { result } = await commitAndPublish(zone, () => { bump(zone); }, null);
          summary.signed++;
          jobCtx.log(`${zone.domain}: re-signed with serial ${result.serial}${result.reloaded ? ' and reloaded' : ` (reload failed: ${result.reloadError})`}`);
        } catch (err) {
          summary.failed++;
          jobCtx.log(`${zone.domain}: ${err.message}`, 'error');
        }
      }
      if (summary.signed) audit(null, { action: 'dns.dnssec.resign', target: 'all', args: summary });
      return summary;
    },

    // --------------------------------------------------------------- routing
    listRouting(query, user) {
      const zones = allVisibleZones(user).filter((z) => !query.account || z.account === query.account);
      return zones.map((z) => {
        const md = stmts.mailDomain.get(z.domain);
        const records = stmts.records.all(z.id);
        const routing = md?.routing ?? 'auto';
        return { domain: z.domain, account: z.account ?? null, routing, effective: routing === 'auto' ? effectiveRouting(z, records) : routing, mx: records.filter((r) => r.type === 'MX').map(shapeRecord).sort((a, b) => a.priority - b.priority) };
      });
    },

    async setRouting(domain, input, user, req) {
      assertPublishable(domain);
      const zone = await load(domain, user);
      const { routing } = input;
      const exchanges = (input.exchanges || []).map((e) => ({ priority: e.priority, value: fqdn(e.exchange, domain) }));
      if (['remote', 'backup'].includes(routing) && !exchanges.length) throw unprocessable('Remote and backup routing need at least one external mail exchanger', { exchanges: ['Add at least one MX host'] });
      const localMx = `mail.${domain}.`;
      const { result } = await commitAndPublish(zone, () => {
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
        bump(zone);
      }, req);
      stmts.upsertMailDomain.run(zone.account_id ?? null, domain, routing);
      let mailApplied = null;
      try { if (typeof ctx.mail?.setRouting === 'function') { await ctx.mail.setRouting(domain, routing, req); mailApplied = true; } } catch (err) { mailApplied = false; logger.warn({ err, domain }, 'mail service could not apply routing'); }
      const after = stmts.records.all(zone.id);
      const effective = routing === 'auto' ? effectiveRouting(stmts.zoneByDomain.get(domain), after) : routing;
      audit(req, { action: 'dns.routing', target: domain, args: { routing, effective, exchanges } });
      return { domain, routing, effective, mx: after.filter((r) => r.type === 'MX').map(shapeRecord).sort((a, b) => a.priority - b.priority), mailApplied, ...result };
    },

    // ----------------------------------------------------- nameserver report
    async nameserverReport({ domain, limit = 50 } = {}, user) {
      const zones = (domain ? [await load(domain, user)] : allVisibleZones(user)).slice(0, limit);
      const expected = setting('basic.nameservers', []).map((n) => `${n.toLowerCase().replace(/\.$/, '')}.`);
      const servers = setting('dns.resolvers', []);
      let resolversUsed = null;
      const resolve = async (name, type) => {
        try {
          const r = await agent.op('dns.resolve', { name: name.replace(/\.$/, ''), type, servers: servers.length ? servers : undefined, timeoutMs: 3000 });
          resolversUsed ??= r?.servers ?? null;
          return r;
        } catch (err) { return { answers: [], error: err.code || 'EFAIL' }; }
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
      return { resolvers: servers.length ? servers : 'system', resolversUsed, expectedNameservers: expected, total: zones.length, zones: results };
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
      if (isServerName(domain)) throw conflict(`${domain} is the server hostname; it cannot be parked on an account`);
      if (createZone) assertPublishable();
      if (account.suspended) throw conflict('That account is suspended');
      const limit = json.parse(account.plan_snapshot_json, {}).max_parked;
      const parkedCount = db.prepare("SELECT COUNT(*) AS n FROM account_domains WHERE account_id = ? AND type IN ('parked', 'alias')").get(account.id).n;
      if (limit != null && limit >= 0 && parkedCount >= limit && !isRoot(user)) throw forbidden(`The account's package allows ${limit} parked domain(s)`);
      const docroot = stmts.accountByAnyDomain.get(account.domain)?.docroot || `${account.home_dir}/public_html`;
      // The zone goes first: a parked row without a zone would consume the
      // package quota for a domain that was never provisioned.
      let zone = null;
      if (createZone && !stmts.zoneByDomain.get(domain)) zone = await createZoneInternal({ domain, ip: input.ip || account.ip, template: 'standard', accountId: account.id }, req);
      try {
        stmts.insertParked.run(account.id, domain, 'parked', docroot);
      } catch (err) {
        if (zone) { try { await removeZoneInternal(stmts.zoneByDomain.get(domain), req); } catch (cleanupErr) { logger.warn({ err: cleanupErr, domain }, 'could not remove the zone of a failed park'); } }
        throw err;
      }
      const { web, webDetail } = await applyWeb(domain, async () => {
        if (typeof ctx.web?.addAlias === 'function') { await ctx.web.addAlias({ username: account.username, domain: account.domain, alias: domain, docroot }, req); return true; }
        if (typeof ctx.web?.syncAccount === 'function') { await ctx.web.syncAccount(account.username, req); return true; }
        return false;
      });
      audit(req, { action: 'dns.park', target: domain, args: { account: account.username, createZone, web } });
      return { domain, account: account.username, target: account.domain, docroot, zone: zone ? { domain: zone.domain, applied: zone.applied } : null, web, webDetail };
    },

    async unparkDomain(domain, { removeZone = true } = {}, user, req) {
      const parked = stmts.parkedByDomain.get(domain);
      if (!parked) throw notFound(`Parked domain ${domain}`);
      if (!isRoot(user) && parked.owner_id !== user.id) throw forbidden('That domain belongs to another reseller\'s account');
      stmts.deleteParked.run(parked.id);
      const zone = stmts.zoneByDomain.get(domain);
      if (removeZone && zone) await removeZoneInternal(zone, req);
      const { web, webDetail } = await applyWeb(domain, async () => {
        if (typeof ctx.web?.removeAlias === 'function') { await ctx.web.removeAlias({ username: parked.account, alias: domain, domain: parked.target }, req); return true; }
        if (typeof ctx.web?.syncAccount === 'function') { await ctx.web.syncAccount(parked.account, req); return true; }
        return false;
      });
      audit(req, { action: 'dns.unpark', target: domain, args: { removeZone, web } });
      return { domain, unparked: true, zoneRemoved: Boolean(removeZone && zone), web, webDetail };
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
          unmanaged = (listing?.zones || []).filter((z) => z.exists && !stmts.zoneByDomain.get(z.domain)).map((z) => ({ domain: z.domain, path: z.path, external: Boolean(z.external) }));
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

    // 'pending' means the web server category (or Apache itself) is not there
    // yet; POST /forwarding/apply re-applies those rows once it is. Only a real
    // error marks a row 'failed'.
    async applyForwardingRow(row, req) {
      if (typeof ctx.web?.setRedirects !== 'function') { stmts.forwardingStatus.run('pending', 'web service not available yet', row.domain); return 'pending'; }
      try {
        await ctx.web.setRedirects(row.domain, [{ from: '/', to: row.target_url, type: row.type, matchWww: Boolean(row.match_www), keepPath: Boolean(row.keep_path), account: row.account }], req);
        stmts.forwardingStatus.run('applied', null, row.domain);
        return 'applied';
      } catch (err) {
        const status = isCapabilityMissing(err) ? 'pending' : 'failed';
        stmts.forwardingStatus.run(status, err.message, row.domain);
        return status;
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
      const { web, webDetail } = await applyWeb(domain, async () => {
        if (typeof ctx.web?.setRedirects !== 'function') return false;
        await ctx.web.setRedirects(domain, [], req);
        return true;
      });
      audit(req, { action: 'dns.forwarding.remove', target: domain, args: { web } });
      return { domain, removed: true, web, webDetail };
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
    // A manual push from the page re-sends every zone; the hourly schedule
    // (no force) only sends zones whose serial a peer has not acknowledged.
    enqueueSync({ domains, clusterId, force = true } = {}, user) {
      const job = ctx.jobs.enqueue('dns.sync', { domains: domains ?? null, clusterId: clusterId ?? null, force: Boolean(force), userId: user?.id ?? null }, { userId: user?.id ?? null });
      return { job };
    },

    // Pushes rendered zones to every enabled peer: a cluster-aware peer (one
    // whose /api/clusters/ping answers) takes them on /api/clusters/dns/receive,
    // any other on /api/dns/zones/import. Peers in role 'sync' are pushed to
    // like 'write-only' ones: this version never pulls zones back from a peer.
    async runSync(jobCtx) {
      const { domains, clusterId, force = false } = jobCtx.params;
      const peers = db.prepare("SELECT * FROM dns_clusters WHERE enabled = 1 AND role IN ('write-only', 'sync')").all().filter((c) => !clusterId || c.id === clusterId);
      if (!peers.length) { jobCtx.log('No DNS cluster peers are configured; nothing to synchronise'); return { peers: 0, zones: 0, ok: 0, failed: 0, skipped: 0, endpoints: {} }; }
      const zones = db.prepare('SELECT * FROM dns_zones ORDER BY domain').all().filter((z) => !domains || domains.includes(z.domain));
      const full = Boolean(force || domains);
      const source = setting('basic.hostname', '') || os.hostname();
      const summary = { peers: peers.length, zones: zones.length, ok: 0, failed: 0, skipped: 0, endpoints: {} };
      let i = 0;
      for (const peer of peers) {
        if (!peer.api_token_enc) { jobCtx.log(`${peer.name}: no API token configured`, 'warn'); summary.failed += zones.length; continue; }
        let token;
        let base;
        try { token = cryptoSvc.decrypt(peer.api_token_enc); base = parseRemote(peer.remote_host); } catch (err) { jobCtx.log(`${peer.name}: ${err.message}`, 'error'); summary.failed += zones.length; continue; }
        const verifyTls = peerVerifyTls(peer);
        const pending = zones.filter((zone) => {
          if (full) return true;
          const last = stmts.syncRowFor.get(zone.id, peer.id);
          return !(last?.status === 'ok' && last.serial === zone.serial);
        });
        summary.skipped += zones.length - pending.length;
        if (!pending.length) { i += zones.length; stmts.clusterSynced.run(peer.id); continue; }
        const probe = await probePeerEndpoint(base, { token, verifyTls }, (msg, level) => jobCtx.log(`${peer.name}: ${msg}`, level));
        let endpoint = probe.endpoint;
        summary.endpoints[peer.name] = endpoint;
        jobCtx.log(`${peer.name}: pushing via ${endpoint} (${probe.reason})`);
        const payloadFor = (zone, body) => (endpoint === PEER_RECEIVE ? { domain: zone.domain, body, serial: zone.serial, source } : { domain: zone.domain, body, serial: zone.serial });
        for (const zone of pending) {
          i++;
          jobCtx.progress((i / Math.max(1, peers.length * zones.length)) * 100, `${zone.domain} → ${peer.name}`);
          const body = renderZone(zone, stmts.records.all(zone.id));
          try {
            let res = await postJson(new URL(endpoint, base), payloadFor(zone, body), { token, verifyTls });
            // A peer that answers ping but lacks the receiver (an older
            // cluster-aware build) takes the plain import for the rest of the run.
            if (res.status === 404 && endpoint === PEER_RECEIVE) {
              endpoint = PEER_IMPORT;
              summary.endpoints[peer.name] = endpoint;
              jobCtx.log(`${peer.name}: no ${PEER_RECEIVE} on this peer; falling back to ${PEER_IMPORT}`, 'warn');
              res = await postJson(new URL(endpoint, base), payloadFor(zone, body), { token, verifyTls });
            }
            if (res.status >= 200 && res.status < 300) { stmts.syncRow.run(zone.id, peer.id, zone.serial, 'ok', null, endpoint); summary.ok++; jobCtx.log(`${zone.domain} → ${peer.name}: ok`); }
            else { const msg = res.body?.error?.message || `HTTP ${res.status}`; stmts.syncRow.run(zone.id, peer.id, zone.serial, 'failed', msg, endpoint); summary.failed++; jobCtx.log(`${zone.domain} → ${peer.name}: ${msg}`, 'error'); }
          } catch (err) {
            stmts.syncRow.run(zone.id, peer.id, zone.serial, 'failed', err.message, endpoint); summary.failed++; jobCtx.log(`${zone.domain} → ${peer.name}: ${err.message}`, 'error');
          }
        }
        stmts.clusterSynced.run(peer.id);
      }
      audit(null, { action: 'dns.sync', target: 'cluster', args: summary });
      return summary;
    },

    // Called by a peer (API token) to receive a zone pushed from its master;
    // the master's serial is the floor so the copy never lags behind it.
    async importZone({ domain, body, serial }, user, req) {
      return service.saveRawZone(domain, body, user, req, { create: true, minSerial: serial || 0 });
    },

    // "Configure Remote Service IPs" (ip-functions) hands over the address
    // named should source queries, notifies and transfers from.
    async setOutboundAddresses({ ipv4 = null, ipv6 = null } = {}, req) {
      if (!bindAvailable()) throw new CapabilityError('bind', 'BIND (named) is not installed on this server; the DNS source address is saved and applied once it is');
      const written = await agent.op('dns.options.write', { ipv4: ipv4 || null, ipv6: ipv6 || null }, { req });
      let reloaded = false;
      let reloadError = null;
      if (written?.changed) {
        try { await agent.op('dns.reload', { reconfig: true }, { req }); reloaded = true; } catch (err) { reloadError = err.message; logger.warn({ err }, 'named options written but reload failed'); }
      }
      audit(req, { action: 'dns.outbound_addresses', target: written?.file ?? 'named options', args: { ipv4: ipv4 || null, ipv6: ipv6 || null, changed: Boolean(written?.changed) } });
      return { applied: true, changed: Boolean(written?.changed), file: written?.file ?? null, directives: written?.directives ?? [], reloaded, reloadError };
    },

    // The BIND layout on this host (flavor, paths, tools), for other categories.
    layout: () => agent.op('dns.layout', {}),

    // ----------------------------------------------- helpers for other categories
    // The zone row after the ownership check (resellers: own accounts only).
    loadZone: (domain, user) => load(domain, user),
    // Replaces every record of a zone with records fetched from an external
    // provider (Cloudflare import). The SOA and apex NS stay local, records
    // the panel cannot hold are skipped with a reason, and the publish does
    // not mirror back to the provider.
    async replaceRecordsFromProvider(domain, records, user, req) {
      const zone = await load(domain, user);
      const keep = stmts.records.all(zone.id).filter((r) => r.type === 'SOA' || (r.type === 'NS' && r.name === '@'));
      const accepted = [];
      const skipped = [];
      for (const input of records) {
        let rec;
        try { rec = normalizeRecord(input, domain); } catch (err) {
          if (err instanceof ZoneError) { skipped.push({ type: input.type, name: input.name, reason: Object.values(err.fields || {}).flat().join('; ') || err.message }); continue; }
          throw err;
        }
        const conflictMsg = checkConflicts([...keep, ...accepted], rec);
        if (conflictMsg) { skipped.push({ type: rec.type, name: rec.name, reason: conflictMsg }); continue; }
        if (accepted.some((r) => r.name === rec.name && r.type === rec.type && r.value === rec.value && (r.priority ?? null) === (rec.priority ?? null))) { skipped.push({ type: rec.type, name: rec.name, reason: 'duplicate' }); continue; }
        accepted.push(rec);
      }
      const { result } = await commitAndPublish(zone, () => {
        stmts.deleteRecordsOfZone.run(zone.id);
        let line = 0;
        for (const r of keep) stmts.restoreRecord.run({ id: r.id, zone_id: r.zone_id, name: r.name, type: r.type, ttl: r.ttl, priority: r.priority, value: r.value, line_index: r.type === 'SOA' ? 0 : ++line });
        for (const r of accepted) stmts.insertRecord.run({ zone_id: zone.id, name: r.name, type: r.type, ttl: r.ttl ?? null, priority: r.priority ?? null, value: r.value, line_index: ++line });
        bump(zone);
      }, req, { mirror: false });
      audit(req, { action: 'dns.zone.replace_records', target: domain, args: { records: accepted.length, skipped: skipped.length, kept: keep.length } });
      return { ...result, records: accepted.length, skipped };
    },
    zoneExists: (domain) => Boolean(stmts.zoneByDomain.get(domain)),
    zoneFor: (name) => { const z = zoneContaining(name); return z ? shapeZone(z) : null; },
    renderZoneText(domain) {
      const zone = stmts.zoneByDomain.get(domain);
      if (!zone) throw notFound(`Zone ${domain}`);
      return renderZone(zone, stmts.records.all(zone.id));
    },
    // Idempotent zone provisioning for account creation / addon domains.
    async ensureZoneForDomain(domain, { ip, accountId, template, nameservers } = {}, req) {
      const existing = stmts.zoneByDomain.get(domain);
      if (existing) {
        if (accountId && existing.account_id !== accountId) db.transaction(() => { bump(existing, { account_id: accountId }); })();
        return { ...shapeZone(stmts.zoneByDomain.get(domain)), created: false };
      }
      if (!bindAvailable() && strict()) return { domain, created: false, applied: false, reason: 'capability_missing' };
      return { ...(await createZoneInternal({ domain, ip, template: template || 'standard', accountId: accountId ?? accountForDomain(domain)?.id ?? null, nameservers }, req)), created: true };
    },
    // Replaces every record of (name, type) in a zone; e.g. ctx.dns.upsertRecords('example.com', 'www', 'A', [{ value: '10.0.0.2' }]).
    async upsertRecords(domain, name, type, values, req) {
      const zone = stmts.zoneByDomain.get(domain);
      if (!zone) throw notFound(`Zone ${domain}`);
      const rel = name === domain || name === `${domain}.` ? '@' : name.replace(new RegExp(`\\.${domain.replace(/\./g, '\\.')}\\.?$`), '');
      const recs = values.map((v) => normalizeRecord({ name: rel, type, ttl: v.ttl, priority: v.priority, value: v.value }, domain));
      return (await commitAndPublish(zone, () => { replaceByNameType(zone, rel, type.toUpperCase(), recs); bump(zone); }, req)).result;
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
