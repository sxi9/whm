import { HttpError, notFound, conflict, unprocessable, serviceUnavailable, forbidden } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { RECORD_TYPES, normalizeRecord, ZoneError } from './dns-zonefile.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const ZONE_CACHE_MS = 60_000;
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);
// Cloudflare: ttl 1 = "auto"; explicit values 60–86400 (30 on Enterprise).
const TTL_AUTO = 1;
const TTL_MIN = 60;
const TTL_MAX = 86400;
const MAX_PAGES = 100;

const stripDot = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '');
const withDot = (h) => `${stripDot(h)}.`;

// Cloudflare returns TXT content quoted ("a" "b" for long strings) since 2023
// and accepts it either way; the panel stores the bare text.
export function unquoteTxt(content) {
  const s = String(content ?? '').trim();
  if (!s.startsWith('"')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '"') { i++; continue; }
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      out += s[i++];
    }
    i++;
  }
  return out;
}

export function relativeName(fqdn, domain) {
  const n = stripDot(fqdn);
  if (n === domain) return '@';
  if (n.endsWith(`.${domain}`)) return n.slice(0, -(domain.length + 1));
  return n;
}

export function absoluteName(name, domain) {
  return name === '@' ? domain : `${name}.${domain}`;
}

// Cloudflare record → panel record (storage shape of normalizeRecord). Returns
// { record } or { skipped: reason }. Apex NS records are Cloudflare's own
// nameservers; BIND keeps the panel's.
export function fromCloudflareRecord(rec, domain) {
  const type = String(rec.type || '').toUpperCase();
  if (!RECORD_TYPES.includes(type)) return { skipped: `${type || 'unknown'} records are not supported by the zone manager` };
  const name = relativeName(rec.name, domain);
  if (!(stripDot(rec.name) === domain || stripDot(rec.name).endsWith(`.${domain}`))) return { skipped: `${rec.name} is outside ${domain}` };
  if (type === 'NS' && name === '@') return { skipped: 'apex NS records stay with the local nameservers' };
  const ttl = Number(rec.ttl) === TTL_AUTO || rec.ttl == null ? null : Number(rec.ttl);
  let value;
  let priority = null;
  switch (type) {
    case 'A': case 'AAAA': value = String(rec.content || '').trim(); break;
    case 'CNAME': case 'NS': case 'PTR': value = withDot(rec.content); break;
    case 'MX': value = withDot(rec.content); priority = rec.priority ?? rec.data?.priority ?? null; break;
    case 'TXT': value = unquoteTxt(rec.content); break;
    case 'SRV': {
      const d = rec.data || {};
      if (d.target != null && d.port != null) {
        priority = d.priority ?? rec.priority ?? 0;
        value = `${Number(d.weight ?? 0)} ${Number(d.port)} ${withDot(d.target)}`;
      } else {
        const parts = String(rec.content || '').trim().split(/\s+/);
        if (parts.length === 4) { priority = Number(parts[0]); value = `${Number(parts[1])} ${Number(parts[2])} ${withDot(parts[3])}`; }
        else if (parts.length === 3) { priority = rec.priority ?? 0; value = `${Number(parts[0])} ${Number(parts[1])} ${withDot(parts[2])}`; }
        else return { skipped: `SRV ${rec.name}: unreadable content "${rec.content}"` };
      }
      break;
    }
    case 'CAA': {
      const d = rec.data || {};
      if (d.tag) value = `${Number(d.flags ?? 0)} ${String(d.tag).toLowerCase()} ${String(d.value ?? '').trim()}`;
      else {
        const m = String(rec.content || '').trim().match(/^(\d{1,3})\s+(\S+)\s+"?([^"]*)"?$/);
        if (!m) return { skipped: `CAA ${rec.name}: unreadable content "${rec.content}"` };
        value = `${Number(m[1])} ${m[2].toLowerCase()} ${m[3].trim()}`;
      }
      break;
    }
    default: return { skipped: `${type} is not supported` };
  }
  try {
    return { record: normalizeRecord({ name, type, ttl, priority, value }, domain), proxied: Boolean(rec.proxied), remoteId: rec.id };
  } catch (err) {
    if (err instanceof ZoneError) return { skipped: `${type} ${rec.name}: ${Object.values(err.fields || {}).flat().join('; ') || err.message}` };
    throw err;
  }
}

// Panel record → Cloudflare request payload plus the (type, name, content)
// identity used by the diff. `key` never includes ttl/priority: those are
// updated in place rather than recreated.
export function toCloudflareRecord(rec, domain) {
  const type = rec.type;
  const name = absoluteName(rec.name, domain);
  let ttl = rec.ttl == null ? TTL_AUTO : Number(rec.ttl);
  let clamped = false;
  if (ttl !== TTL_AUTO && (ttl < TTL_MIN || ttl > TTL_MAX)) { ttl = Math.max(TTL_MIN, Math.min(TTL_MAX, ttl)); clamped = true; }
  const payload = { type, name, ttl };
  let content;
  switch (type) {
    case 'A': case 'AAAA': content = rec.value.toLowerCase(); payload.content = rec.value; break;
    case 'CNAME': case 'NS': case 'PTR': content = stripDot(rec.value); payload.content = content; break;
    case 'MX': content = stripDot(rec.value); payload.content = content; payload.priority = Number(rec.priority ?? 0); break;
    case 'TXT': content = rec.value; payload.content = rec.value; break;
    case 'SRV': {
      const [weight, port, target] = rec.value.split(/\s+/);
      content = `${Number(weight)} ${Number(port)} ${stripDot(target)}`;
      payload.data = { priority: Number(rec.priority ?? 0), weight: Number(weight), port: Number(port), target: stripDot(target) };
      break;
    }
    case 'CAA': {
      const [flags, tag, ...rest] = rec.value.split(/\s+/);
      content = `${Number(flags)} ${tag.toLowerCase()} ${rest.join(' ')}`;
      payload.data = { flags: Number(flags), tag: tag.toLowerCase(), value: rest.join(' ') };
      break;
    }
    default: throw new Error(`unsupported record type ${type}`);
  }
  const priority = ['MX', 'SRV'].includes(type) ? Number(rec.priority ?? 0) : null;
  return { key: `${type}|${stripDot(name)}|${content}`, payload, ttl, priority, clamped };
}

// The identity of a record as Cloudflare holds it, in the same form as toCloudflareRecord().key.
export function remoteKey(rec, domain) {
  const mapped = fromCloudflareRecord(rec, domain);
  if (!mapped.record) return null;
  return toCloudflareRecord(mapped.record, domain).key;
}

// Minimal change set: pair desired and remote records by (type, name, content);
// paired records are updated only when ttl/priority differ, unpaired desired
// ones are created and unpaired remote ones (of managed types) deleted.
export function diffRecords(desired, remote, domain) {
  const pool = new Map();
  for (const r of remote) {
    const key = remoteKey(r, domain);
    if (!key) continue;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(r);
  }
  const creates = [];
  const updates = [];
  let unchanged = 0;
  const clamped = [];
  for (const rec of desired) {
    const d = toCloudflareRecord(rec, domain);
    if (d.clamped) clamped.push(`${rec.type} ${absoluteName(rec.name, domain)} ttl ${rec.ttl} → ${d.ttl}`);
    const match = pool.get(d.key)?.shift();
    if (!match) { creates.push(d); continue; }
    const remoteTtl = Number(match.ttl ?? TTL_AUTO);
    const remotePriority = ['MX', 'SRV'].includes(rec.type) ? Number(match.priority ?? match.data?.priority ?? 0) : null;
    if (remoteTtl !== d.ttl || remotePriority !== d.priority) updates.push({ ...d, remote: match });
    else unchanged++;
  }
  const deletes = [...pool.values()].flat();
  return { creates, updates, deletes, unchanged, clamped };
}

// ctx.dnsCloudflare — mirrors panel zones to Cloudflare DNS. The API token is
// root-only and never leaves the service; zone-level actions go through the
// DNS service's ownership check so a reseller only touches zones they own.
export function createDnsCloudflareService(ctx) {
  const { db, logger, crypto: cryptoSvc, settings } = ctx;
  const stmts = {
    settingsRow: db.prepare('SELECT * FROM dns_cloudflare_settings WHERE id = 1'),
    upsertSettings: db.prepare(`INSERT INTO dns_cloudflare_settings (id, api_token_enc, token_id, account_id, account_name, verified_at, created_by, updated_at)
      VALUES (1, @api_token_enc, @token_id, @account_id, @account_name, datetime('now'), @created_by, datetime('now'))
      ON CONFLICT (id) DO UPDATE SET api_token_enc = excluded.api_token_enc, token_id = excluded.token_id, account_id = excluded.account_id, account_name = excluded.account_name, verified_at = excluded.verified_at, created_by = excluded.created_by, updated_at = excluded.updated_at`),
    deleteSettings: db.prepare('DELETE FROM dns_cloudflare_settings WHERE id = 1'),
    zoneByDomain: db.prepare('SELECT z.*, a.owner_id, a.username AS account FROM dns_zones z LEFT JOIN accounts a ON a.id = z.account_id WHERE z.domain = ?'),
    records: db.prepare('SELECT * FROM dns_records WHERE zone_id = ? ORDER BY line_index, id'),
    setLink: db.prepare("UPDATE dns_zones SET provider = 'cloudflare', cloudflare_zone_id = @zoneId, cloudflare_status = 'linked', cloudflare_last_error = NULL, updated_at = datetime('now') WHERE id = @id"),
    clearLink: db.prepare("UPDATE dns_zones SET provider = 'bind', cloudflare_zone_id = NULL, cloudflare_status = NULL, cloudflare_synced_at = NULL, cloudflare_last_error = NULL, updated_at = datetime('now') WHERE id = ?"),
    setSynced: db.prepare("UPDATE dns_zones SET cloudflare_status = 'ok', cloudflare_synced_at = datetime('now'), cloudflare_last_error = NULL WHERE id = ?"),
    setPending: db.prepare("UPDATE dns_zones SET cloudflare_status = 'pending' WHERE id = ? AND provider = 'cloudflare'"),
    setFailed: db.prepare("UPDATE dns_zones SET cloudflare_status = 'failed', cloudflare_last_error = ? WHERE id = ?"),
    log: db.prepare('INSERT INTO dns_cloudflare_sync (zone_id, domain, action, status, attempt, summary, message, job_id, principal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    logFor: db.prepare('SELECT id, action, status, attempt, summary, message, job_id, principal, created_at FROM dns_cloudflare_sync WHERE zone_id = ? ORDER BY id DESC LIMIT ?'),
    linked: db.prepare("SELECT z.domain, z.cloudflare_zone_id, z.cloudflare_status, z.cloudflare_synced_at, z.cloudflare_last_error, a.username AS account, a.owner_id FROM dns_zones z LEFT JOIN accounts a ON a.id = z.account_id WHERE z.provider = 'cloudflare' ORDER BY z.domain"),
    queuedJobs: db.prepare("SELECT id, params_json FROM jobs WHERE type = 'dns.cloudflare.push' AND status = 'queued'"),
  };

  let zoneCache = { at: 0, list: null };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const apiBase = () => ctx.config?.cloudflareApiBase || CLOUDFLARE_API;

  function tokenOf(row = stmts.settingsRow.get()) {
    if (!row) throw new HttpError(409, 'cloudflare_not_configured', 'Cloudflare is not configured: the root administrator must add an API token in DNS Zone Manager › Cloudflare first');
    return cryptoSvc.decrypt(row.api_token_enc);
  }

  // One Cloudflare API call. A non-2xx answer or success:false becomes a
  // cloudflare_error (502) carrying Cloudflare's own message and code;
  // network failures and timeouts are 503. The token is only ever a header.
  async function cfRequest(path, { method = 'GET', body, token, timeoutMs = 20_000 } = {}) {
    const url = `${apiBase()}${path}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': `whm-panel/${ctx.version || 'dev'}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await globalThis.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (err) {
      throw serviceUnavailable(`Cloudflare API unreachable: ${err.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : err.message}`);
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    if (!res.ok || !parsed || parsed.success === false) {
      const first = parsed?.errors?.[0];
      const message = first?.message || (res.status === 429 ? 'rate limited' : `HTTP ${res.status}`);
      const err = new HttpError(502, 'cloudflare_error', `Cloudflare: ${message}`);
      err.cloudflare = { status: res.status, code: first?.code ?? null, errors: parsed?.errors ?? [], retryAfter: Number(res.headers?.get?.('retry-after')) || null };
      throw err;
    }
    return parsed;
  }

  async function cfPaged(path, { token, perPage, max = MAX_PAGES }) {
    const out = [];
    for (let page = 1; page <= max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await cfRequest(`${path}${sep}per_page=${perPage}&page=${page}`, { token });
      out.push(...(Array.isArray(res.result) ? res.result : []));
      const info = res.result_info || {};
      if (!info.total_pages || page >= info.total_pages || !res.result?.length) break;
    }
    return out;
  }

  const shapeRemoteZone = (z) => ({ id: z.id, name: z.name, status: z.status, paused: Boolean(z.paused), type: z.type ?? null, nameServers: z.name_servers || [], account: z.account ? { id: z.account.id, name: z.account.name } : null, plan: z.plan?.name ?? null, modifiedOn: z.modified_on ?? null });

  async function listRemoteZones(token, { refresh = false } = {}) {
    if (!refresh && zoneCache.list && Date.now() - zoneCache.at < ZONE_CACHE_MS) return zoneCache.list;
    const list = (await cfPaged('/zones', { token, perPage: 50, max: 40 })).map(shapeRemoteZone);
    zoneCache = { at: Date.now(), list };
    return list;
  }

  async function findRemoteZone(token, domain, { zoneId } = {}) {
    if (zoneId) {
      const res = await cfRequest(`/zones/${encodeURIComponent(zoneId)}`, { token });
      const z = shapeRemoteZone(res.result || {});
      if (stripDot(z.name) !== domain) throw unprocessable(`Cloudflare zone ${zoneId} is ${z.name || 'unknown'}, not ${domain}`, { cloudflareZoneId: [`That zone is ${z.name}`] });
      return z;
    }
    const cached = zoneCache.list?.find((z) => stripDot(z.name) === domain);
    if (cached) return cached;
    const res = await cfRequest(`/zones?name=${encodeURIComponent(domain)}&per_page=5`, { token });
    const hit = (res.result || []).map(shapeRemoteZone).find((z) => stripDot(z.name) === domain);
    if (!hit) throw notFound(`Cloudflare zone ${domain} (add the site to the Cloudflare account first)`);
    return hit;
  }

  async function loadLinked(domain, user) {
    const zone = await ctx.dns.loadZone(domain, user);
    if (zone.provider !== 'cloudflare' || !zone.cloudflare_zone_id) throw conflict(`${domain} is not linked to Cloudflare; link it first`);
    return zone;
  }

  function zoneShape(row) {
    return {
      domain: row.domain, account: row.account ?? null, provider: row.provider || 'bind', cloudflareZoneId: row.cloudflare_zone_id ?? null,
      status: row.cloudflare_status ?? null, syncedAt: row.cloudflare_synced_at ?? null, lastError: row.cloudflare_last_error ?? null,
    };
  }

  function record(zone, action, status, { attempt = 1, summary = null, message = null, jobId = null, principal = null } = {}) {
    stmts.log.run(zone.id, zone.domain, action, status, attempt, summary == null ? null : JSON.stringify(summary), message, jobId, principal);
  }

  const service = {
    isConfigured: () => Boolean(stmts.settingsRow.get()),

    // Root sees the token's identity (never the token); resellers only
    // whether the integration is available and their own linked zones.
    status(user) {
      const row = stmts.settingsRow.get();
      const linked = stmts.linked.all().filter((z) => isRoot(user) || z.owner_id === user?.id).map((z) => ({ domain: z.domain, account: z.account ?? null, cloudflareZoneId: z.cloudflare_zone_id, status: z.cloudflare_status, syncedAt: z.cloudflare_synced_at, lastError: z.cloudflare_last_error }));
      const base = { configured: Boolean(row), verifiedAt: row?.verified_at ?? null, linked, failed: linked.filter((z) => z.status === 'failed').length };
      if (!isRoot(user)) return base;
      return { ...base, tokenId: row?.token_id ?? null, accountId: row?.account_id ?? null, accountName: row?.account_name ?? null, createdBy: row?.created_by ?? null, updatedAt: row?.updated_at ?? null, apiBase: apiBase() };
    },

    // Verifies the token (GET /user/tokens/verify) and that it can list zones
    // (Zone:Read) before storing it encrypted; the first zone's account is
    // remembered for display only.
    async configure({ apiToken }, user, req) {
      if (!isRoot(user)) throw forbidden('Only root can configure the Cloudflare API token');
      const token = String(apiToken || '').trim();
      if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw unprocessable('That does not look like a Cloudflare API token', { apiToken: ['Create an API token (not the Global API Key) with Zone:Read and DNS:Edit permissions'] });
      let verify;
      let zones;
      try {
        verify = (await cfRequest('/user/tokens/verify', { token })).result || {};
        if (verify.status && verify.status !== 'active') throw unprocessable(`The Cloudflare token is ${verify.status}`, { apiToken: ['The token must be active'] });
        zones = (await cfRequest('/zones?per_page=50&page=1', { token })).result || [];
      } catch (err) {
        if (err.code === 'cloudflare_error') throw unprocessable(`Cloudflare rejected the token: ${err.message.replace(/^Cloudflare: /, '')}`, { apiToken: ['The token must be valid and allow Zone:Read and DNS:Edit'] });
        throw err;
      }
      const account = zones[0]?.account || null;
      stmts.upsertSettings.run({ api_token_enc: cryptoSvc.encrypt(token), token_id: verify.id ?? null, account_id: account?.id ?? null, account_name: account?.name ?? null, created_by: user.username ?? null });
      zoneCache = { at: Date.now(), list: zones.map(shapeRemoteZone) };
      audit(req, { action: 'dns.cloudflare.configure', target: 'cloudflare', args: { tokenId: verify.id ?? null, accountId: account?.id ?? null, zones: zones.length } });
      return service.status(user);
    },

    remove(user, req) {
      if (!isRoot(user)) throw forbidden('Only root can remove the Cloudflare API token');
      const changed = stmts.deleteSettings.run().changes;
      zoneCache = { at: 0, list: null };
      audit(req, { action: 'dns.cloudflare.remove_token', target: 'cloudflare', args: { removed: Boolean(changed) } });
      return { removed: Boolean(changed), ...service.status(user) };
    },

    // Remote zone list (cached 60 s) with the panel zone each one is linked to.
    async zones({ refresh = false } = {}, user) {
      if (!isRoot(user)) throw forbidden('Only root can list the Cloudflare account\'s zones');
      const list = await listRemoteZones(tokenOf(), { refresh });
      const linked = new Map(stmts.linked.all().map((z) => [z.cloudflare_zone_id, z.domain]));
      const local = new Set(db.prepare('SELECT domain FROM dns_zones').all().map((r) => r.domain));
      return list.map((z) => ({ ...z, linkedDomain: linked.get(z.id) ?? null, localZone: local.has(stripDot(z.name)) }));
    },

    async link(domain, { cloudflareZoneId } = {}, user, req) {
      const zone = await ctx.dns.loadZone(domain, user);
      const remote = await findRemoteZone(tokenOf(), domain, { zoneId: cloudflareZoneId });
      const taken = stmts.linked.all().find((z) => z.cloudflare_zone_id === remote.id && z.domain !== domain);
      if (taken) throw conflict(`Cloudflare zone ${remote.name} is already linked to ${taken.domain}`);
      stmts.setLink.run({ id: zone.id, zoneId: remote.id });
      record(zone, 'link', 'ok', { summary: { cloudflareZoneId: remote.id, remoteStatus: remote.status, nameServers: remote.nameServers }, principal: user?.username ?? null });
      audit(req, { action: 'dns.cloudflare.link', target: domain, args: { cloudflareZoneId: remote.id, remoteStatus: remote.status } });
      return { ...zoneShape(stmts.zoneByDomain.get(domain)), remote };
    },

    async unlink(domain, user, req) {
      const zone = await ctx.dns.loadZone(domain, user);
      if (zone.provider !== 'cloudflare') throw conflict(`${domain} is not linked to Cloudflare`);
      stmts.clearLink.run(zone.id);
      record(zone, 'unlink', 'ok', { summary: { cloudflareZoneId: zone.cloudflare_zone_id }, principal: user?.username ?? null });
      audit(req, { action: 'dns.cloudflare.unlink', target: domain, args: { cloudflareZoneId: zone.cloudflare_zone_id } });
      return zoneShape(stmts.zoneByDomain.get(domain));
    },

    // Remote records replace the panel's (SOA and apex NS stay local); the
    // zone is then published to BIND without mirroring back to Cloudflare.
    async import(domain, user, req) {
      const zone = await loadLinked(domain, user);
      const token = tokenOf();
      let remote;
      try {
        remote = await cfPaged(`/zones/${encodeURIComponent(zone.cloudflare_zone_id)}/dns_records`, { token, perPage: 1000 });
      } catch (err) {
        stmts.setFailed.run(err.message, zone.id);
        record(zone, 'import', 'failed', { message: err.message, principal: user?.username ?? null });
        throw err;
      }
      const records = [];
      const skipped = [];
      for (const r of remote) {
        const mapped = fromCloudflareRecord(r, domain);
        if (mapped.record) records.push(mapped.record); else skipped.push({ type: r.type, name: r.name, reason: mapped.skipped });
      }
      let result;
      try {
        result = await ctx.dns.replaceRecordsFromProvider(domain, records, user, req);
      } catch (err) {
        stmts.setFailed.run(err.message, zone.id);
        record(zone, 'import', 'failed', { message: err.message, principal: user?.username ?? null });
        throw err;
      }
      skipped.push(...result.skipped);
      stmts.setSynced.run(zone.id);
      const summary = { remote: remote.length, imported: result.records, skipped: skipped.length };
      record(zone, 'import', 'ok', { summary, principal: user?.username ?? null });
      audit(req, { action: 'dns.cloudflare.import', target: domain, args: summary });
      return { ...zoneShape(stmts.zoneByDomain.get(domain)), ...summary, skippedRecords: skipped, applied: result.applied, serial: result.serial, reloaded: result.reloaded ?? null };
    },

    // Panel → Cloudflare, computing the minimal change set first. Existing
    // records keep their proxied flag; new ones are DNS-only.
    async push(domain, { user = null, req = null, jobCtx = null, attempt = 1 } = {}) {
      const zone = user ? await loadLinked(domain, user) : stmts.zoneByDomain.get(domain);
      if (!zone) throw notFound(`Zone ${domain}`);
      if (zone.provider !== 'cloudflare' || !zone.cloudflare_zone_id) throw conflict(`${domain} is not linked to Cloudflare`);
      const log = (line, level) => jobCtx?.log?.(line, level);
      const principal = user?.username ?? null;
      try {
        const token = tokenOf();
        const desired = stmts.records.all(zone.id).filter((r) => r.type !== 'SOA' && !(r.type === 'NS' && r.name === '@') && RECORD_TYPES.includes(r.type));
        const remote = await cfPaged(`/zones/${encodeURIComponent(zone.cloudflare_zone_id)}/dns_records`, { token, perPage: 1000 });
        const diff = diffRecords(desired, remote, domain);
        for (const c of diff.clamped) log(`ttl clamped to Cloudflare's range: ${c}`, 'warn');
        const base = `/zones/${encodeURIComponent(zone.cloudflare_zone_id)}/dns_records`;
        let i = 0;
        const total = diff.creates.length + diff.updates.length + diff.deletes.length;
        const step = (what) => { i++; jobCtx?.progress?.((i / Math.max(1, total)) * 100, what); log(what); };
        for (const d of diff.creates) {
          const payload = PROXIABLE.has(d.payload.type) ? { ...d.payload, proxied: false } : d.payload;
          await cfRequest(base, { method: 'POST', body: payload, token });
          step(`created ${d.payload.type} ${d.payload.name}`);
        }
        for (const d of diff.updates) {
          const payload = PROXIABLE.has(d.payload.type) ? { ...d.payload, proxied: Boolean(d.remote.proxied) } : d.payload;
          await cfRequest(`${base}/${encodeURIComponent(d.remote.id)}`, { method: 'PATCH', body: payload, token });
          step(`updated ${d.payload.type} ${d.payload.name}`);
        }
        for (const r of diff.deletes) {
          await cfRequest(`${base}/${encodeURIComponent(r.id)}`, { method: 'DELETE', token });
          step(`deleted ${r.type} ${r.name}`);
        }
        const summary = { created: diff.creates.length, updated: diff.updates.length, deleted: diff.deletes.length, unchanged: diff.unchanged, remote: remote.length, clamped: diff.clamped.length };
        stmts.setSynced.run(zone.id);
        record(zone, 'push', 'ok', { attempt, summary, jobId: jobCtx?.job?.id ?? null, principal });
        audit(req, { action: 'dns.cloudflare.push', target: domain, args: { ...summary, attempt, job: jobCtx?.job?.id ?? null } });
        return { ...zoneShape(stmts.zoneByDomain.get(domain)), ...summary };
      } catch (err) {
        stmts.setFailed.run(err.message, zone.id);
        record(zone, 'push', 'failed', { attempt, message: err.message, jobId: jobCtx?.job?.id ?? null, principal });
        throw err;
      }
    },

    // Called by the DNS service after every committed change of a Cloudflare
    // zone. A push already queued for the domain is reused.
    enqueuePush(domain, { reason = 'zone changed', userId = null } = {}) {
      const zone = stmts.zoneByDomain.get(domain);
      if (!zone || zone.provider !== 'cloudflare' || !zone.cloudflare_zone_id) return null;
      for (const row of stmts.queuedJobs.all()) {
        let params = null;
        try { params = JSON.parse(row.params_json); } catch { params = null; }
        if (params?.domain === domain) return { id: row.id, reused: true };
      }
      const job = ctx.jobs.enqueue('dns.cloudflare.push', { domain, reason }, { userId });
      stmts.setPending.run(zone.id);
      return { id: job.id, reused: false };
    },

    // Manual push from the page: ownership and the link are checked here, the
    // work runs in the job so the UI can follow it.
    async requestPush(domain, user, req) {
      const zone = await loadLinked(domain, user);
      tokenOf();
      const queued = service.enqueuePush(domain, { reason: `manual push by ${user.username}`, userId: user.id });
      audit(req, { action: 'dns.cloudflare.push_requested', target: domain, args: { job: queued?.id ?? null, reused: Boolean(queued?.reused) } });
      return { job: ctx.jobs.get(queued.id), zone: zoneShape(stmts.zoneByDomain.get(zone.domain)) };
    },

    async runPushJob(jobCtx) {
      const { domain, reason } = jobCtx.params;
      const attempts = Math.max(1, Number(settings.get('dns.cloudflare.push_attempts', 3)));
      const backoff = settings.get('dns.cloudflare.retry_backoff_ms', [5000, 20000, 60000]);
      if (reason) jobCtx.log(`${domain}: pushing to Cloudflare (${reason})`);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const result = await service.push(domain, { jobCtx, attempt });
          jobCtx.log(`${domain}: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted, ${result.unchanged} unchanged`);
          return result;
        } catch (err) {
          const last = attempt >= attempts || (err.status && err.status < 500 && err.code !== 'cloudflare_error');
          jobCtx.log(`${domain}: attempt ${attempt} failed: ${err.message}`, last ? 'error' : 'warn');
          if (last) throw err;
          const wait = Math.max(0, Number(err.cloudflare?.retryAfter) * 1000 || Number(backoff[Math.min(attempt - 1, backoff.length - 1)]) || 0);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
      return null;
    },

    async zoneStatus(domain, user) {
      const zone = await ctx.dns.loadZone(domain, user);
      return { ...zoneShape(zone), configured: service.isConfigured(), log: stmts.logFor.all(zone.id, 20).map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null })) };
    },
  };

  return service;
}
