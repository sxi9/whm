import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/plugin-sdk.js';
import net from 'node:net';
import dns from 'node:dns/promises';
import nodeCrypto from 'node:crypto';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, unprocessable, CapabilityError } from '../lib/errors.js';

// Security Center. Attached as ctx.security; other categories may call:
//   security.policy()                         -> current login/session policy settings
//   security.passwordStrength(pw, context)    -> { score, minimum, ok }
//   security.cphulk.shouldBlock(ip)           -> CIDR-aware: active blocks + denylist, minus allowlist
//   security.cphulk.isAllowlisted(ip)         -> exact or CIDR match on the allowlist
//   security.cphulk.block(ip, opts) / unblock(id)
//   security.firewall.block(ip, req, { comment }) / unblock(ip) / list()
//        blocks are recorded in firewall_entries and restored at boot / hourly;
//        the hourly sync never removes an address it did not add itself
//   security.firewall.reconcile(job)          -> re-apply recorded blocks + SMTP restriction
//   security.reloadApache(req)                -> uses ctx.web.reload when that category exists
//   security.modsec.detect() / security.ssh.config() / security.externalAuth.*
//   security.externalAuth.exchangeCode(name, { code, redirectUri, nonce })
//        -> verified id_token claims (signature via jwks_uri or client secret,
//           iss/aud/azp/exp/iat/nonce checked) merged with userinfo
// Follow-up owned by the auth layer (services/auth.js + middleware/auth.js): consume
// security.policy() (verified-IP login, session timeout, concurrent sessions, password
// age, 2FA requirements), security.cphulk.shouldBlock()/isAllowlisted() on login, the
// security.questions.* settings, and mount a public OIDC login/callback on top of
// externalAuth.authorizationUrl()/exchangeCode()/findLinkedUser()/link(). Until then
// those settings are stored, not enforced.

const KNOWN_SERVICES = ['ALL', 'sshd', 'vsftpd', 'proftpd', 'pure-ftpd', 'exim', 'dovecot', 'imap', 'pop3', 'named', 'mysqld', 'whm-panel', 'ftpd', 'telnetd'];
const PASSWORD_CONTEXTS = ['account', 'email', 'ftp', 'mysql', 'panel', 'ssh'];
const stripSlash = (u) => String(u || '').replace(/\/+$/, '');

// JWS algorithms accepted for id_tokens: [digest, key kind].
const JWS_ALGS = {
  RS256: ['sha256', 'rsa'], RS384: ['sha384', 'rsa'], RS512: ['sha512', 'rsa'],
  PS256: ['sha256', 'pss'], PS384: ['sha384', 'pss'], PS512: ['sha512', 'pss'],
  ES256: ['sha256', 'ec'], ES384: ['sha384', 'ec'], ES512: ['sha512', 'ec'],
  HS256: ['sha256', 'hmac'], HS384: ['sha384', 'hmac'], HS512: ['sha512', 'hmac'],
};

function decodeJwtPart(part) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

// OpenID Connect Core 3.1.3.7: the id_token must be signature-checked and its
// iss/aud/azp/exp/iat/nonce claims validated before anything trusts `sub`.
export function verifyIdToken(idToken, { issuer, clientId, nonce = null, jwks = [], clientSecret = null, now = Date.now(), skewSeconds = 60 }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('id_token is not a compact JWS');
  const [h, p, s] = parts;
  const header = decodeJwtPart(h);
  const claims = decodeJwtPart(p);
  if (!header || !claims || typeof claims !== 'object') throw new Error('id_token header or payload is not valid JSON');
  const alg = JWS_ALGS[header.alg];
  if (!alg) throw new Error(`id_token uses unsupported alg "${header.alg}"`);
  const signed = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  let ok = false;
  if (alg[1] === 'hmac') {
    if (!clientSecret) throw new Error('id_token is HMAC-signed but the provider has no client secret');
    const expected = nodeCrypto.createHmac(alg[0], clientSecret).update(signed).digest();
    ok = expected.length === sig.length && nodeCrypto.timingSafeEqual(expected, sig);
  } else {
    const kty = alg[1] === 'ec' ? 'EC' : 'RSA';
    const candidates = jwks.filter((k) => k && k.kty === kty && (!header.kid || !k.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
    for (const jwk of candidates) {
      let key;
      try { key = nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { continue; }
      const keyObject = alg[1] === 'pss' ? { key, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST } : alg[1] === 'ec' ? { key, dsaEncoding: 'ieee-p1363' } : key;
      try { if (nodeCrypto.verify(alg[0], signed, keyObject, sig)) { ok = true; break; } } catch { /* key/alg mismatch */ }
    }
  }
  if (!ok) throw new Error('id_token signature could not be verified with the provider keys');
  if (stripSlash(claims.iss) !== stripSlash(issuer)) throw new Error(`id_token issuer "${claims.iss}" does not match the provider issuer ${issuer}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('id_token audience does not include this client');
  if (aud.length > 1 && claims.azp !== clientId) throw new Error('id_token lists several audiences and azp is not this client');
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + skewSeconds < nowSec) throw new Error('id_token has expired');
  if (typeof claims.iat !== 'number' || claims.iat - skewSeconds > nowSec) throw new Error('id_token was issued in the future');
  if ((nonce != null || claims.nonce != null) && claims.nonce !== nonce) throw new Error('id_token nonce does not match this login attempt');
  if (!claims.sub || typeof claims.sub !== 'string') throw new Error('id_token has no subject');
  return claims;
}

// Discovery metadata must be served over TLS and, unless the operator opts in,
// stay on the issuer's host: the token endpoint receives the client secret.
export function checkDiscoveryDocument(doc, issuerUrl, { allowForeignEndpoints = false } = {}) {
  if (!doc || typeof doc !== 'object') throw badRequest('The discovery document is not a JSON object');
  if (doc.issuer && stripSlash(doc.issuer) !== stripSlash(issuerUrl)) throw badRequest(`The discovery document declares issuer "${doc.issuer}", which does not match the configured issuer ${issuerUrl}`);
  const issuerHost = new URL(issuerUrl).host;
  const endpoints = { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, userinfoEndpoint: doc.userinfo_endpoint, jwksUri: doc.jwks_uri };
  if (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint) throw badRequest('The discovery document lacks authorization_endpoint or token_endpoint');
  const foreign = [];
  for (const [name, value] of Object.entries(endpoints)) {
    if (value == null) continue;
    let u;
    try { u = new URL(String(value)); } catch { throw badRequest(`${name} in the discovery document is not a valid URL`); }
    if (u.protocol !== 'https:') throw badRequest(`${name} must use https:// (the provider published ${value})`);
    if (u.host !== issuerHost) foreign.push(`${name} on ${u.host}`);
  }
  if (foreign.length && !allowForeignEndpoints) throw badRequest(`The discovery document points at hosts other than ${issuerHost}: ${foreign.join(', ')}. Re-run discovery allowing endpoints on other hosts if that is expected for this provider.`, { allowForeignEndpoints: ['Endpoints on other hosts need explicit approval'] });
  return { ...endpoints, issuer: doc.issuer || issuerUrl, scopesSupported: doc.scopes_supported || [], foreignEndpoints: foreign, fetchedAt: new Date().toISOString() };
}

export function passwordStrength(pw) {
  if (!pw) return 0;
  let score = Math.min(40, pw.length * 4);
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 15;
  if (/\d/.test(pw)) score += 15;
  if (/[^A-Za-z0-9]/.test(pw)) score += 20;
  if (/(.)\1{2,}/.test(pw)) score -= 15;
  if (/^(password|123456|qwerty|letmein)/i.test(pw)) score = 5;
  return Math.max(0, Math.min(100, score));
}

export function ipInCidr(ip, cidr) {
  const [network, prefixStr] = cidr.split('/');
  if (prefixStr === undefined) return ip === network;
  const family = net.isIP(ip);
  if (!family || family !== net.isIP(network)) return false;
  const prefix = Number(prefixStr);
  const toBits = (addr) => {
    if (family === 4) return addr.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('');
    const [head, tail = ''] = addr.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return groups.map((g) => parseInt(g || '0', 16).toString(2).padStart(16, '0')).join('');
  };
  return toBits(ip).slice(0, prefix) === toBits(network).slice(0, prefix);
}

function addressToBigInt(ip, family) {
  if (family === 4) return ip.split('.').reduce((n, o) => (n << 8n) + BigInt(o), 0n);
  const expand = (part) => (part ? part.split(':').flatMap((g) => {
    if (!g.includes('.')) return [g];
    const v = Number(addressToBigInt(g, 4));
    return [(v >>> 16).toString(16), (v & 0xffff).toString(16)];
  }) : []);
  const [head, tail] = ip.split('::');
  const h = expand(head);
  const t = tail === undefined ? [] : expand(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

function bigIntToAddress(n, family) {
  if (family === 4) return [24, 16, 8, 0].map((s) => Number((n >> BigInt(s)) & 255n)).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt((7 - i) * 16)) & 0xffffn));
  let best = { start: -1, len: 0 };
  let cur = { start: -1, len: 0 };
  groups.forEach((g, i) => {
    if (g !== 0) { cur = { start: -1, len: 0 }; return; }
    if (cur.start < 0) cur = { start: i, len: 0 };
    cur.len++;
    if (cur.len > best.len) best = { ...cur };
  });
  const hex = groups.map((g) => g.toString(16));
  if (best.len < 2) return hex.join(':');
  return `${hex.slice(0, best.start).join(':')}::${hex.slice(best.start + best.len).join(':')}`;
}

// Canonical form shared by what the operator types, what is recorded and what
// iptables/nft print back: host-length prefixes dropped, IPv6 compressed and
// lower-cased, network host bits cleared. Returns null for anything that is not
// an address or network.
export function normalizeIpOrCidr(value) {
  const parts = String(value ?? '').trim().split('/');
  if (parts.length > 2) return null;
  const [addr, prefixStr] = parts;
  const family = net.isIP(addr);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  if (prefixStr !== undefined && (!/^\d{1,3}$/.test(prefixStr) || Number(prefixStr) > max)) return null;
  const n = addressToBigInt(addr, family);
  if (prefixStr === undefined || Number(prefixStr) === max) return bigIntToAddress(n, family);
  const prefix = Number(prefixStr);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(max)) - 1n) ^ ((1n << BigInt(max - prefix)) - 1n);
  return `${bigIntToAddress(n & mask, family)}/${prefix}`;
}

const NON_PUBLIC_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];

export function isPublicAddress(addr) {
  const family = net.isIP(addr);
  if (family === 4) return !NON_PUBLIC_V4.some((cidr) => ipInCidr(addr, cidr));
  if (family !== 6) return false;
  const a = addr.toLowerCase();
  if (a.startsWith('::ffff:') && net.isIP(a.slice(7)) === 4) return isPublicAddress(a.slice(7));
  if (a === '::' || a === '::1') return false;
  return !/^(fe[89ab]|f[cd])/.test(a);
}

// Server-side fetch of operator-supplied provider URLs: https only, redirects
// are not followed (a redirect could steer the panel at internal services),
// hosts that resolve to non-public addresses are refused and the body is capped.
export async function fetchJson(url, { method = 'GET', body, headers = {}, maxBytes = 1024 * 1024, timeoutMs = 10_000, lookup = (host) => dns.lookup(host, { all: true }) } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https:// URLs are fetched');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses = net.isIP(host) ? [host] : [];
  if (!addresses.length) { try { addresses = (await lookup(host)).map((a) => a.address); } catch { addresses = []; } }
  const internal = addresses.find((a) => !isPublicAddress(a));
  if (internal) throw new Error(`${host} resolves to a non-public address (${internal}); the panel only contacts public identity providers`);
  const res = await fetch(url, { method, body, redirect: 'manual', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status} redirect to ${res.headers?.get?.('location') || 'another location'} was not followed`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text;
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`the response exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('the response is not valid JSON'); }
}

const HOME_ROOT_SHAPE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export function createSecurityCenterService(ctx) {
  const { db, agent, capabilities, settings, crypto, config, logger } = ctx;

  const stmts = {
    hostRules: db.prepare('SELECT * FROM host_access_rules ORDER BY position, id'),
    clearHostRules: db.prepare('DELETE FROM host_access_rules'),
    insertHostRule: db.prepare('INSERT INTO host_access_rules (service, source, action, comment, position) VALUES (?, ?, ?, ?, ?)'),
    activeBlocks: db.prepare(`SELECT * FROM cphulk_blocks WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY created_at DESC`),
    activeBlockByIp: db.prepare(`SELECT * FROM cphulk_blocks WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1`),
    blockById: db.prepare('SELECT * FROM cphulk_blocks WHERE id = ?'),
    insertBlock: db.prepare('INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES (?, ?, ?)'),
    expireBlock: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE id = ?`),
    expireBlocksByIp: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`),
    expireAllBlocks: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE expires_at IS NULL OR expires_at > datetime('now')`),
    purgeBlocks: db.prepare(`DELETE FROM cphulk_blocks WHERE expires_at IS NOT NULL AND expires_at < datetime('now', ?)`),
    purgeAttempts: db.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now', ?)`),
    lists: db.prepare('SELECT * FROM cphulk_lists ORDER BY kind, ip'),
    listByKind: db.prepare('SELECT * FROM cphulk_lists WHERE kind = ? ORDER BY ip'),
    listById: db.prepare('SELECT * FROM cphulk_lists WHERE id = ?'),
    insertList: db.prepare('INSERT INTO cphulk_lists (kind, ip, comment) VALUES (?, ?, ?)'),
    deleteList: db.prepare('DELETE FROM cphulk_lists WHERE id = ?'),
    fwEntries: db.prepare('SELECT * FROM firewall_entries ORDER BY ip, source'),
    fwByIp: db.prepare('SELECT * FROM firewall_entries WHERE ip = ?'),
    fwInsert: db.prepare('INSERT OR IGNORE INTO firewall_entries (ip, source, comment) VALUES (?, ?, ?)'),
    fwDeleteIp: db.prepare('DELETE FROM firewall_entries WHERE ip = ?'),
    fwDeleteSource: db.prepare('DELETE FROM firewall_entries WHERE ip = ? AND source = ?'),
    attemptStats: db.prepare(`SELECT COUNT(*) AS attempts, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures FROM login_attempts WHERE created_at > datetime('now', '-1 day')`),
    topOffenders: db.prepare(`SELECT ip, COUNT(*) AS failures, MAX(created_at) AS last_seen FROM login_attempts WHERE ok = 0 AND created_at > datetime('now', '-1 day') GROUP BY ip ORDER BY failures DESC LIMIT 10`),
    disabledRules: db.prepare('SELECT * FROM modsec_disabled_rules ORDER BY rule_id'),
    disableRule: db.prepare('INSERT OR REPLACE INTO modsec_disabled_rules (rule_id, reason) VALUES (?, ?)'),
    enableRule: db.prepare('DELETE FROM modsec_disabled_rules WHERE rule_id = ?'),
    vendors: db.prepare('SELECT * FROM modsec_vendors ORDER BY name'),
    vendorByName: db.prepare('SELECT * FROM modsec_vendors WHERE name = ?'),
    insertVendor: db.prepare('INSERT INTO modsec_vendors (name, url, enabled) VALUES (?, ?, ?)'),
    updateVendor: db.prepare("UPDATE modsec_vendors SET url = @url, enabled = @enabled, installed_at = datetime('now') WHERE id = @id"),
    setVendorEnabled: db.prepare('UPDATE modsec_vendors SET enabled = ? WHERE id = ?'),
    deleteVendor: db.prepare('DELETE FROM modsec_vendors WHERE id = ?'),
    providers: db.prepare('SELECT * FROM external_auth_providers ORDER BY name'),
    providerByName: db.prepare('SELECT * FROM external_auth_providers WHERE name = ?'),
    insertProvider: db.prepare('INSERT INTO external_auth_providers (name, display_name, issuer_url, client_id, client_secret_enc, scopes, enabled) VALUES (@name, @display_name, @issuer_url, @client_id, @client_secret_enc, @scopes, @enabled)'),
    updateProvider: db.prepare(`UPDATE external_auth_providers SET display_name = @display_name, issuer_url = @issuer_url, client_id = @client_id, client_secret_enc = @client_secret_enc, scopes = @scopes, enabled = @enabled, discovery_json = @discovery_json, updated_at = datetime('now') WHERE id = @id`),
    deleteProvider: db.prepare('DELETE FROM external_auth_providers WHERE id = ?'),
    providerLinks: db.prepare('SELECT COUNT(*) AS n FROM external_auth_links WHERE provider_id = ?'),
    linkFind: db.prepare('SELECT l.*, u.username, u.role FROM external_auth_links l JOIN users u ON u.id = l.user_id WHERE l.provider_id = ? AND l.subject = ?'),
    linkInsert: db.prepare('INSERT OR REPLACE INTO external_auth_links (provider_id, user_id, subject, email) VALUES (?, ?, ?, ?)'),
    lastRun: db.prepare('SELECT * FROM security_advisor_runs ORDER BY id DESC LIMIT 1'),
    insertRun: db.prepare(`INSERT INTO security_advisor_runs (trigger, finished_at, summary_json, findings_json) VALUES (?, datetime('now'), ?, ?)`),
    pruneRuns: db.prepare('DELETE FROM security_advisor_runs WHERE id NOT IN (SELECT id FROM security_advisor_runs ORDER BY id DESC LIMIT 20)'),
    rootUser: db.prepare("SELECT username, totp_enabled FROM users WHERE role = 'root' ORDER BY id LIMIT 1"),
    shellAccounts: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE shell NOT IN ('/usr/sbin/nologin', '/usr/local/bin/jailshell')"),
    accountUsers: db.prepare('SELECT username FROM accounts ORDER BY username'),
  };

  const op = (name, args, req) => agent.op(name, args, { req });

  // Apache reloads are owned by the Service Configuration / web category when it
  // exists; until then (or on a host where it is absent) go through systemd.
  async function reloadApache(req) {
    if (typeof ctx.web?.reload === 'function') return ctx.web.reload(req);
    await capabilities.ensureFresh();
    const unit = capabilities.unitFor('httpd');
    if (!unit) throw new CapabilityError('apache', 'Apache is not installed on this server');
    return op('svc.reload', { unit }, req);
  }

  function requireFirewallBackend(detect) {
    capabilities.require('firewall', 'No firewall tooling (iptables or nftables) is installed on this server');
    if (!detect.backend) throw new CapabilityError('firewall', 'Only iptables and nftables backends are supported; install iptables or nft');
    return detect.backend;
  }

  let modsecCache = { at: 0, layout: null };
  async function detectModsec(force = false) {
    if (!force && modsecCache.layout && Date.now() - modsecCache.at < 60_000) return modsecCache.layout;
    const layout = await op('sec.modsec.detect');
    modsecCache = { at: Date.now(), layout };
    return layout;
  }
  async function requireModsec() {
    capabilities.require('apache', 'Apache is not installed; ModSecurity runs as an Apache module');
    const layout = await detectModsec();
    if (!layout.installed) throw new CapabilityError('modsecurity', 'ModSecurity is not installed (no /etc/modsecurity or mod_security.conf found). Install libapache2-mod-security2 / mod_security.');
    return layout;
  }

  const hostAccess = {
    list() {
      return stmts.hostRules.all().map((r) => ({ id: r.id, service: r.service, source: r.source, action: r.action, comment: r.comment, position: r.position }));
    },
    async files() { return op('sec.hosts_allow.read'); },
    // The host file is written first; the stored rule set only changes once the
    // agent accepted the new file.
    async replace(rules, req) {
      const result = await op('sec.hosts_allow.write', { rules: rules.map((r) => ({ service: r.service, source: r.source, action: r.action, ...(r.comment ? { comment: r.comment } : {}) })) }, req);
      db.transaction(() => {
        stmts.clearHostRules.run();
        rules.forEach((r, i) => stmts.insertHostRule.run(r.service, r.source, r.action, r.comment || null, i));
      })();
      req?.audit?.({ action: 'security.host_access.update', args: { rules: rules.length } });
      return { rules: hostAccess.list(), written: result };
    },
    services: () => KNOWN_SERVICES,
  };

  const ssh = {
    async config() {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      const cfg = await op('sec.sshd.get');
      const keys = await op('sec.ssh_keys.list').catch(() => ({ authorized: [] }));
      return { ...cfg, authorizedKeyCount: keys.authorized?.length ?? 0 };
    },
    // Turning passwords off with no authorized root key locks root out of SSH,
    // so that combination needs an explicit force flag from any API client.
    async setConfig(settingsIn, req, { force = false } = {}) {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      if (settingsIn.PasswordAuthentication === 'no' && !force) {
        const keys = await op('sec.ssh_keys.list').catch(() => ({ authorized: [] }));
        if (!(keys.authorized?.length > 0)) throw unprocessable('Disabling SSH password authentication while no root key is authorized would lock root out of SSH. Authorize a key first (Manage root\'s SSH Keys) or resend with force: true to proceed anyway.', { force: ['Required to disable passwords without an authorized root key'] });
      }
      const result = await op('sec.sshd.set', { settings: settingsIn }, req);
      req?.audit?.({ action: 'security.sshd.update', args: { ...settingsIn, ...(force ? { force } : {}) } });
      return result;
    },
    async keys() {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      return op('sec.ssh_keys.list');
    },
    async importKey(publicKey, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.add', { publicKey }, req);
      req?.audit?.({ action: 'security.ssh_keys.authorize', target: result.fingerprint });
      return result;
    },
    async generate(input, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.generate', input, req);
      req?.audit?.({ action: 'security.ssh_keys.generate', target: input.name, args: { type: input.type, bits: input.bits, authorize: input.authorize } });
      return result;
    },
    async authorize(name, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.authorize', { name }, req);
      req?.audit?.({ action: 'security.ssh_keys.authorize', target: name });
      return result;
    },
    async deauthorize(fingerprint, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.remove', { fingerprint }, req);
      req?.audit?.({ action: 'security.ssh_keys.deauthorize', target: fingerprint });
      return result;
    },
    async deletePair(name, deauthorize, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.delete_pair', { name, deauthorize }, req);
      req?.audit?.({ action: 'security.ssh_keys.delete', target: name, args: { deauthorize } });
      return result;
    },
    async exportPrivate(name, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.export', { name }, req);
      req?.audit?.({ action: 'security.ssh_keys.export_private', target: name });
      return result;
    },
  };

  const cphulk = {
    settings() {
      return {
        enabled: Boolean(settings.get('security.cphulk.enabled')),
        maxFailuresPerIp: settings.get('security.cphulk.max_failures_per_ip'),
        lockoutMinutes: settings.get('security.cphulk.lockout_minutes'),
        firewallSync: Boolean(settings.get('security.cphulk.firewall_sync')),
        historyRetentionDays: settings.get('security.cphulk.history_retention_days'),
        blockDenylistPermanently: Boolean(settings.get('security.cphulk.block_denylist_permanently')),
      };
    },
    updateSettings(input, req) {
      const map = { enabled: 'security.cphulk.enabled', maxFailuresPerIp: 'security.cphulk.max_failures_per_ip', lockoutMinutes: 'security.cphulk.lockout_minutes', firewallSync: 'security.cphulk.firewall_sync', historyRetentionDays: 'security.cphulk.history_retention_days', blockDenylistPermanently: 'security.cphulk.block_denylist_permanently' };
      const values = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined && map[k]) values[map[k]] = v;
      settings.setMany(values);
      req?.audit?.({ action: 'security.cphulk.settings', args: values });
      return cphulk.settings();
    },
    overview() {
      const stats = stmts.attemptStats.get();
      return { settings: cphulk.settings(), blocks: cphulk.blocks(), stats: { attempts24h: stats.attempts || 0, failures24h: stats.failures || 0, activeBlocks: stmts.activeBlocks.all().length, topOffenders: stmts.topOffenders.all() } };
    },
    blocks: () => stmts.activeBlocks.all().map((b) => ({ ...b, permanent: b.expires_at == null })),
    isAllowlisted: (ip) => stmts.listByKind.all('allow').some((e) => ipInCidr(ip, e.ip)),
    shouldBlock(ip) {
      if (cphulk.isAllowlisted(ip)) return false;
      return stmts.activeBlocks.all().some((b) => ipInCidr(ip, b.ip)) || stmts.listByKind.all('deny').some((e) => ipInCidr(ip, e.ip));
    },
    isBlocked: (ip) => cphulk.shouldBlock(ip),
    history(query) {
      const where = [];
      const params = {};
      if (query.q) { where.push('(ip LIKE @q OR username LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.failed) where.push('ok = 0');
      return paginate(db, { select: '*', from: 'login_attempts', where, params, sortable: { created_at: 'created_at', ip: 'ip', username: 'username' }, defaultSort: 'created_at', query: { ...query, dir: query.dir || 'desc' } });
    },
    async block(ip, { minutes = null, reason = 'manual block', firewall = false } = {}, req) {
      const viaFirewall = firewall || Boolean(settings.get('security.cphulk.firewall_sync'));
      // The panel login path matches exact addresses only; a network block is
      // only meaningful when the firewall drops it.
      if (ip.includes('/') && !viaFirewall) throw unprocessable('A CIDR network can only be blocked in the firewall: enable "Also drop blocked addresses in the firewall" or send firewall: true. Panel logins are matched per address.', { ip: ['Networks require a firewall block'] });
      if (cphulk.isAllowlisted(ip)) throw conflict(`${ip} is on the allowlist`);
      if (stmts.activeBlockByIp.get(ip)) throw conflict(`${ip} is already blocked`);
      const { lastInsertRowid } = stmts.insertBlock.run(ip, reason, minutes ? new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19) : null);
      let firewalled = false;
      if (viaFirewall) {
        try { await firewallApi.block(ip, req, { source: 'cphulk', comment: reason }); firewalled = true; } catch (err) { logger.warn({ err, ip }, 'cPHulk: firewall block failed'); }
      }
      req?.audit?.({ action: 'security.cphulk.block', target: ip, args: { minutes, reason, firewalled } });
      return { ...stmts.blockById.get(lastInsertRowid), firewalled };
    },
    // Drops the firewall rule cPHulk added for an address; a manual block of the
    // same address (firewall_entries source 'manual') is left alone.
    async releaseFirewall(ip, req) {
      if (!stmts.fwByIp.all(ip).some((e) => e.source === 'cphulk')) return false;
      if (!capabilities.has('firewall')) return false;
      try { return (await firewallApi.release(ip, 'cphulk', req)).removed; } catch (err) { logger.warn({ err, ip }, 'cPHulk: firewall unblock failed'); return false; }
    },
    async unblock(id, req) {
      const row = stmts.blockById.get(id);
      if (!row) throw notFound('Block');
      stmts.expireBlocksByIp.run(row.ip);
      const firewalled = stmts.listByKind.all('deny').some((e) => e.ip === row.ip) ? false : await cphulk.releaseFirewall(row.ip, req);
      req?.audit?.({ action: 'security.cphulk.unblock', target: row.ip });
      return { ip: row.ip, unblocked: true, firewalled };
    },
    async flush(req) {
      const ips = stmts.activeBlocks.all().map((b) => b.ip);
      const n = stmts.expireAllBlocks.run().changes;
      const deny = new Set(stmts.listByKind.all('deny').map((e) => e.ip));
      let firewalled = 0;
      for (const ip of new Set(ips)) if (!deny.has(ip) && await cphulk.releaseFirewall(ip, req)) firewalled++;
      req?.audit?.({ action: 'security.cphulk.flush', args: { blocks: n, firewalled } });
      return { cleared: n, firewalled };
    },
    lists: () => stmts.lists.all(),
    async addToList(kind, ip, comment, req) {
      if (stmts.lists.all().some((e) => e.kind === kind && e.ip === ip)) throw conflict(`${ip} is already on the ${kind} list`);
      const { lastInsertRowid } = stmts.insertList.run(kind, ip, comment || null);
      if (kind === 'allow') {
        for (const b of stmts.activeBlocks.all()) if (b.ip === ip || ipInCidr(b.ip, ip)) { stmts.expireBlock.run(b.id); await cphulk.releaseFirewall(b.ip, req); }
      }
      let firewalled = false;
      if (kind === 'deny') {
        if (settings.get('security.cphulk.block_denylist_permanently') && !ip.includes('/') && !stmts.activeBlockByIp.get(ip)) stmts.insertBlock.run(ip, 'denylist', null);
        if (settings.get('security.cphulk.firewall_sync') && capabilities.has('firewall')) {
          try { await firewallApi.block(ip, req, { source: 'cphulk', comment: 'denylist' }); firewalled = true; } catch (err) { logger.warn({ err, ip }, 'cPHulk: firewall block failed'); }
        }
      }
      req?.audit?.({ action: `security.cphulk.${kind}list.add`, target: ip, args: { comment, firewalled } });
      return { ...stmts.listById.get(lastInsertRowid), firewalled };
    },
    async removeFromList(id, req) {
      const row = stmts.listById.get(id);
      if (!row) throw notFound('List entry');
      stmts.deleteList.run(id);
      let firewalled = false;
      if (row.kind === 'deny') {
        db.prepare("UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE ip = ? AND reason = 'denylist' AND expires_at IS NULL").run(row.ip);
        if (!stmts.activeBlockByIp.get(row.ip)) firewalled = await cphulk.releaseFirewall(row.ip, req);
      }
      req?.audit?.({ action: `security.cphulk.${row.kind}list.remove`, target: row.ip });
      return { removed: true, firewalled };
    },
    // Hourly job: purge history, expire blocks that match the allowlist, then
    // reconcile the firewall (recorded blocks, cPHulk entries, SMTP restriction).
    async maintenance(job) {
      const days = Number(settings.get('security.cphulk.history_retention_days')) || 30;
      const purgedAttempts = stmts.purgeAttempts.run(`-${days} days`).changes;
      const purgedBlocks = stmts.purgeBlocks.run(`-${days} days`).changes;
      let lifted = 0;
      for (const b of stmts.activeBlocks.all()) if (cphulk.isAllowlisted(b.ip)) { stmts.expireBlock.run(b.id); lifted++; }
      const sync = await firewallApi.reconcile(job);
      const result = { purgedAttempts, purgedBlocks, liftedAllowlisted: lifted, firewall: sync.firewall, smtp: sync.smtp };
      job?.log?.(`cPHulk maintenance: ${JSON.stringify(result)}`);
      return result;
    },
  };

  // Addresses are stored and compared in canonical form (see normalizeIpOrCidr);
  // the live listing is normalised the same way before any comparison.
  const canon = (ip) => normalizeIpOrCidr(ip) ?? String(ip);
  const liveEntries = (entries) => entries.map((e) => ({ ...e, ip: canon(e.ip) }));

  const firewallApi = {
    recorded: () => stmts.fwEntries.all(),
    annotate(entriesIn) {
      const entries = liveEntries(entriesIn);
      const rows = stmts.fwEntries.all();
      const byIp = new Map();
      for (const r of rows) (byIp.get(r.ip) || byIp.set(r.ip, []).get(r.ip)).push(r);
      const active = new Set(entries.map((e) => e.ip));
      const shaped = entries.map((e) => {
        const mine = byIp.get(e.ip) || [];
        return { ...e, sources: mine.map((r) => r.source), comment: mine.find((r) => r.comment)?.comment || null, active: true, persistent: mine.length > 0 };
      });
      for (const [ip, mine] of byIp) if (!active.has(ip)) shaped.push({ ip, sources: mine.map((r) => r.source), comment: mine.find((r) => r.comment)?.comment || null, active: false, persistent: true });
      return shaped;
    },
    async status() {
      const detect = await op('sec.firewall.detect');
      if (!capabilities.has('firewall') || !detect.backend) return { ...detect, installed: false, entries: firewallApi.annotate([]) };
      const list = await op('sec.firewall.list');
      return { ...detect, installed: true, entries: firewallApi.annotate(list.entries) };
    },
    async block(ipIn, req, { source = 'manual', comment = null } = {}) {
      const ip = canon(ipIn);
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.firewall.block', { ip }, req);
      stmts.fwInsert.run(ip, source, comment);
      req?.audit?.({ action: 'security.firewall.block', target: ip, args: { source } });
      return { ...result, ip, source, persistent: true };
    },
    // An explicit unblock drops every record for the address, including cPHulk's.
    async unblock(ipIn, req) {
      const ip = canon(ipIn);
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.firewall.unblock', { ip }, req);
      stmts.fwDeleteIp.run(ip);
      req?.audit?.({ action: 'security.firewall.unblock', target: ip });
      return { ...result, ip };
    },
    async release(ipIn, source, req) {
      const ip = canon(ipIn);
      stmts.fwDeleteSource.run(ip, source);
      if (stmts.fwByIp.all(ip).length) return { ip, removed: false, kept: true };
      const result = await op('sec.firewall.unblock', { ip }, req);
      return { ip, removed: Boolean(result.removed), kept: false };
    },
    async list() { requireFirewallBackend(await op('sec.firewall.detect')); return firewallApi.annotate((await op('sec.firewall.list')).entries); },
    // Makes the live WHM_BLOCK chain contain every recorded manual block plus
    // (when sync is on) every active cPHulk block and denylist entry, removing
    // only cPHulk entries the panel added earlier. Addresses that reached the
    // chain by other means are counted as "untracked" and never touched. Also
    // re-applies the SMTP restriction when it is switched on. Runs at boot and
    // from the hourly cPHulk maintenance job.
    async reconcile(job) {
      const out = { firewall: null, smtp: null };
      if (!capabilities.has('firewall')) return out;
      try {
        const detect = await op('sec.firewall.detect');
        if (!detect.backend) return out;
        const sync = Boolean(settings.get('security.cphulk.firewall_sync'));
        const rows = stmts.fwEntries.all();
        const manual = new Set(rows.filter((r) => r.source === 'manual').map((r) => r.ip));
        const tracked = new Set(rows.filter((r) => r.source === 'cphulk').map((r) => r.ip));
        const activeIps = new Set([...stmts.activeBlocks.all().map((b) => b.ip), ...stmts.listByKind.all('deny').map((e) => e.ip)].map(canon));
        const wantCphulk = sync ? activeIps : new Set([...tracked].filter((ip) => activeIps.has(ip)));
        const current = new Set(liveEntries((await op('sec.firewall.list')).entries).map((e) => e.ip));
        let added = 0; let removed = 0;
        const ensure = async (ip) => { if (current.has(ip)) return; await op('sec.firewall.block', { ip }); current.add(ip); added++; };
        for (const ip of manual) await ensure(ip);
        for (const ip of wantCphulk) { await ensure(ip); stmts.fwInsert.run(ip, 'cphulk', null); }
        for (const ip of tracked) {
          if (wantCphulk.has(ip)) continue;
          stmts.fwDeleteSource.run(ip, 'cphulk');
          if (!manual.has(ip) && current.has(ip)) { await op('sec.firewall.unblock', { ip }); current.delete(ip); removed++; }
        }
        const untracked = [...current].filter((ip) => !manual.has(ip) && !wantCphulk.has(ip)).length;
        out.firewall = { backend: detect.backend, added, removed, manual: manual.size, cphulk: wantCphulk.size, untracked };
      } catch (err) {
        job?.log?.(`firewall sync skipped: ${err.message}`, 'warn');
        out.firewall = { error: err.message };
      }
      try { out.smtp = await smtp.reconcile(job); } catch (err) {
        job?.log?.(`SMTP restriction re-apply failed: ${err.message}`, 'warn');
        out.smtp = { desired: true, reapplied: false, error: err.message };
      }
      return out;
    },
  };

  const smtp = {
    desired: () => Boolean(settings.get('security.smtp_restrictions.enabled')),
    async status() {
      const state = await op('sec.smtp_restrict.get');
      return { ...state, installed: capabilities.has('firewall') && Boolean(state.backend), desired: smtp.desired() };
    },
    // The live rules vanish on reboot or a firewall restart; the setting is the
    // source of truth and reconcile() puts them back.
    async set(enabled, req) {
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.smtp_restrict.set', { enabled }, req);
      settings.set('security.smtp_restrictions.enabled', enabled);
      req?.audit?.({ action: 'security.smtp_restrictions.set', args: { enabled } });
      return { ...result, desired: enabled };
    },
    async reconcile(job) {
      if (!smtp.desired()) return { desired: false, reapplied: false };
      if (!capabilities.has('firewall')) return { desired: true, reapplied: false, error: 'no firewall tooling is installed' };
      const state = await op('sec.smtp_restrict.get');
      if (!state.backend) return { desired: true, reapplied: false, error: 'no supported firewall backend' };
      if (state.enabled) return { desired: true, reapplied: false, families: state.families };
      const result = await op('sec.smtp_restrict.set', { enabled: true });
      job?.log?.(`SMTP restriction re-applied (${result.backend}: ${JSON.stringify(result.families)})`);
      return { desired: true, reapplied: true, families: result.families };
    },
  };

  const compilers = {
    status: () => op('sec.compiler_access.get'),
    async set(allow, req) {
      const result = await op('sec.compiler_access.set', { allow }, req);
      req?.audit?.({ action: 'security.compiler_access.set', args: { allow } });
      return result;
    },
  };

  const traceroute = {
    status: () => op('sec.traceroute.get'),
    async set(enabled, req) {
      const result = await op('sec.traceroute.set', { enabled }, req);
      req?.audit?.({ action: 'security.traceroute.set', args: { enabled } });
      return result;
    },
  };

  const forkBomb = {
    status: () => op('sec.fork_bomb.get'),
    async set(input, req) {
      const result = await op('sec.fork_bomb.set', input, req);
      req?.audit?.({ action: 'security.fork_bomb.set', args: input });
      return result;
    },
  };

  const wheel = {
    async group() {
      for (const g of ['wheel', 'sudo']) {
        const info = await op('user.groups.members', { group: g });
        if (info.exists) return info;
      }
      return { group: 'wheel', exists: false, members: [] };
    },
    async list() {
      const group = await wheel.group();
      const linux = await op('user.list_managed').catch(() => []);
      const candidates = [...new Set([...linux.map((u) => u.username), ...stmts.accountUsers.all().map((a) => a.username)])].filter((u) => !group.members.includes(u)).sort();
      return { ...group, candidates };
    },
    async add(username, req) {
      const group = await wheel.group();
      if (!group.exists) throw badRequest('Neither a "wheel" nor a "sudo" group exists on this server');
      if (group.members.includes(username)) throw conflict(`${username} is already in ${group.group}`);
      await op('user.groups.set_membership', { username, group: group.group, member: true }, req);
      req?.audit?.({ action: 'security.wheel.add', target: username, args: { group: group.group } });
      return wheel.list();
    },
    async remove(username, req) {
      const group = await wheel.group();
      if (!group.exists) throw badRequest('Neither a "wheel" nor a "sudo" group exists on this server');
      if (!group.members.includes(username)) throw notFound(`${username} in ${group.group}`);
      await op('user.groups.set_membership', { username, group: group.group, member: false }, req);
      req?.audit?.({ action: 'security.wheel.remove', target: username, args: { group: group.group } });
      return wheel.list();
    },
  };

  const userdir = {
    async status() {
      const state = await op('sec.userdir.get');
      return { ...state, installed: Boolean(state.installed) && capabilities.has('apache'), accounts: stmts.accountUsers.all().map((a) => a.username) };
    },
    // The Basic Setup home root is accepted with a trailing slash there but lands
    // inside an Apache <Directory "..."> block here, so it is normalised first.
    homeRoot() {
      const raw = String(settings.get('basic.home_root') || '/home').trim();
      const normalized = raw.replace(/\/+$/, '').replace(/\/{2,}/g, '/') || '/';
      if (!HOME_ROOT_SHAPE.test(normalized) || normalized.split('/').includes('..')) throw unprocessable(`The home directory root "${raw}" from Basic Setup cannot be used in the Apache mod_userdir include; set it to a plain absolute path such as /home on the Basic Setup page.`, { homeRoot: ['Must be a plain absolute path without ".." or special characters'] });
      return normalized;
    },
    async set({ enabled, excludeUsers }, req) {
      capabilities.require('apache', 'Apache is not installed on this server');
      const result = await op('sec.userdir.set', { enabled, excludeUsers, homeRoot: userdir.homeRoot() }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: 'security.userdir.set', args: { enabled, excludeUsers } });
      return { ...result, reload };
    },
  };

  const modsec = {
    detect: detectModsec,
    async status() {
      capabilities.require('apache', 'Apache is not installed; ModSecurity runs as an Apache module');
      const layout = await detectModsec(true);
      if (!layout.installed) return { installed: false, layout };
      const config = await op('sec.modsec.get_config');
      return { installed: true, layout, ...config, disabledRules: stmts.disabledRules.all(), vendors: stmts.vendors.all().map((v) => ({ ...v, enabled: Boolean(v.enabled) })) };
    },
    async setConfig(directives, req) {
      await requireModsec();
      const result = await op('sec.modsec.set_config', { directives }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: 'security.modsec.config', args: directives });
      return { ...result, reload };
    },
    async rules(query) {
      await requireModsec();
      const { files, rules, truncated } = await op('sec.modsec.list_rules', { limit: 20000 });
      const disabled = new Set(stmts.disabledRules.all().map((r) => r.rule_id));
      let list = rules.map((r) => ({ ...r, disabled: disabled.has(r.id) }));
      if (query.q) { const q = query.q.toLowerCase(); list = list.filter((r) => String(r.id).includes(q) || (r.msg || '').toLowerCase().includes(q) || (r.file || '').toLowerCase().includes(q) || (r.tag || '').toLowerCase().includes(q)); }
      if (query.vendor) list = list.filter((r) => (r.vendor || 'base') === query.vendor);
      if (query.disabled) list = list.filter((r) => r.disabled);
      const page = query.page || 1; const pageSize = query.pageSize || 50;
      return { data: list.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: list.length, files: files.length, truncated } };
    },
    disabledRules: () => stmts.disabledRules.all(),
    // The include is written (and validated by Apache) before the rule's state is
    // recorded, so a rejected include never leaves a rule marked disabled.
    async setRuleDisabled(ruleId, disabled, reason, req) {
      await requireModsec();
      const ids = [...new Set([...stmts.disabledRules.all().map((r) => r.rule_id).filter((id) => id !== ruleId), ...(disabled ? [ruleId] : [])])].sort((a, b) => a - b);
      const result = await op('sec.modsec.set_disabled', { ids }, req);
      if (disabled) stmts.disableRule.run(ruleId, reason || null); else stmts.enableRule.run(ruleId);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: disabled ? 'security.modsec.rule.disable' : 'security.modsec.rule.enable', target: String(ruleId), args: { reason } });
      return { ruleId, disabled, ids, path: result.path, reload };
    },
    async hits(limit) {
      await requireModsec();
      return op('sec.modsec.hits', { limit });
    },
    vendors: () => stmts.vendors.all().map((v) => ({ ...v, enabled: Boolean(v.enabled) })),
    async addVendor({ name, url, enabled = true }, user, req) {
      await requireModsec();
      if (stmts.vendorByName.get(name)) throw conflict(`Vendor "${name}" already exists`);
      stmts.insertVendor.run(name, url, enabled ? 1 : 0);
      req?.audit?.({ action: 'security.modsec.vendor.add', target: name, args: { url } });
      return { vendor: stmts.vendorByName.get(name), job: ctx.jobs.enqueue('security.modsec.vendor.install', { name }, { userId: user?.id ?? null }) };
    },
    async updateVendor(name, user, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      req?.audit?.({ action: 'security.modsec.vendor.update', target: name });
      return { vendor, job: ctx.jobs.enqueue('security.modsec.vendor.install', { name }, { userId: user?.id ?? null }) };
    },
    // Vendor state changes are applied to Apache first and recorded only once the
    // include validated, so the stored flags never claim more than the host does.
    async setVendorEnabled(name, enabled, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      const desired = stmts.vendors.all().map((v) => ({ name: v.name, enabled: v.name === name ? enabled : Boolean(v.enabled) }));
      const applied = await modsec.applyVendors(req, desired);
      stmts.setVendorEnabled.run(enabled ? 1 : 0, vendor.id);
      req?.audit?.({ action: 'security.modsec.vendor.toggle', target: name, args: { enabled } });
      return { ...stmts.vendorByName.get(name), enabled, applied };
    },
    async removeVendor(name, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      const remaining = stmts.vendors.all().filter((v) => v.name !== name).map((v) => ({ name: v.name, enabled: Boolean(v.enabled) }));
      const applied = await modsec.applyVendors(req, remaining);
      await op('sec.modsec.vendor.remove', { name }, req);
      stmts.deleteVendor.run(vendor.id);
      req?.audit?.({ action: 'security.modsec.vendor.remove', target: name });
      return { removed: true, applied };
    },
    async applyVendors(req, vendors = stmts.vendors.all().map((v) => ({ name: v.name, enabled: Boolean(v.enabled) }))) {
      const result = await op('sec.modsec.vendors.apply', { vendors }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      return { ...result, reload };
    },
    async installVendorJob(job) {
      const vendor = stmts.vendorByName.get(job.params.name);
      if (!vendor) throw new Error(`vendor "${job.params.name}" no longer exists`);
      job.log(`Downloading ${vendor.url}`);
      job.progress(10, 'downloading');
      const result = await agent.op('sec.modsec.vendor.install', { name: vendor.name, url: vendor.url });
      job.log(`Installed ${result.ruleFiles} rule files (${result.rules} rules) into ${result.dir}`);
      job.progress(70, 'applying includes');
      stmts.updateVendor.run({ id: vendor.id, url: vendor.url, enabled: vendor.enabled });
      const applied = await modsec.applyVendors(null);
      job.log(applied.reload?.error ? `Apache reload failed: ${applied.reload.error}` : 'Apache reloaded');
      job.progress(100, 'done');
      return { ...result, applied };
    },
  };

  function policy() {
    return {
      verifiedIpLogin: Boolean(settings.get('security.policy.verified_ip_login')),
      passwordMaxAgeDays: Number(settings.get('security.policy.password_max_age_days')) || 0,
      require2faForRoot: Boolean(settings.get('security.2fa.required_for_root')),
      require2faForResellers: Boolean(settings.get('security.policy.require_2fa_for_resellers')),
      sessionTimeoutMinutes: Number(settings.get('security.policy.session_timeout_minutes')) || 0,
      disallowConcurrentSessions: Boolean(settings.get('security.policy.disallow_concurrent_sessions')),
      apiTokensRequire2fa: Boolean(settings.get('security.policy.api_tokens_require_2fa')),
    };
  }

  function passwordPolicy(password, context = 'account') {
    const fallback = Number(settings.get('security.min_password_strength')) || 0;
    const specific = PASSWORD_CONTEXTS.includes(context) ? settings.get(`security.password.strength.${context}`) : null;
    const minimum = specific == null ? fallback : Number(specific);
    const score = passwordStrength(password);
    return { score, minimum, ok: score >= minimum, context };
  }

  const jwksCache = new Map();
  const externalAuth = {
    shape(row) {
      if (!row) return null;
      return { id: row.id, name: row.name, displayName: row.display_name, issuerUrl: row.issuer_url, clientId: row.client_id, hasClientSecret: Boolean(row.client_secret_enc), scopes: row.scopes, enabled: Boolean(row.enabled), discovery: json.parse(row.discovery_json, null), links: stmts.providerLinks.get(row.id).n, createdAt: row.created_at, updatedAt: row.updated_at };
    },
    list: () => stmts.providers.all().map(externalAuth.shape),
    get(name) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      return externalAuth.shape(row);
    },
    create(input, req) {
      if (stmts.providerByName.get(input.name)) throw conflict(`Provider "${input.name}" already exists`);
      stmts.insertProvider.run({ name: input.name, display_name: input.displayName, issuer_url: input.issuerUrl.replace(/\/+$/, ''), client_id: input.clientId, client_secret_enc: input.clientSecret ? crypto.encrypt(input.clientSecret) : null, scopes: input.scopes || 'openid email profile', enabled: input.enabled === false ? 0 : 1 });
      req?.audit?.({ action: 'security.external_auth.create', target: input.name, args: { issuerUrl: input.issuerUrl, clientId: input.clientId } });
      return externalAuth.get(input.name);
    },
    update(name, input, req) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      const issuer = input.issuerUrl ? input.issuerUrl.replace(/\/+$/, '') : row.issuer_url;
      stmts.updateProvider.run({
        id: row.id, display_name: input.displayName ?? row.display_name, issuer_url: issuer, client_id: input.clientId ?? row.client_id,
        client_secret_enc: input.clientSecret ? crypto.encrypt(input.clientSecret) : row.client_secret_enc, scopes: input.scopes ?? row.scopes,
        enabled: input.enabled == null ? row.enabled : input.enabled ? 1 : 0, discovery_json: issuer === row.issuer_url ? row.discovery_json : null,
      });
      req?.audit?.({ action: 'security.external_auth.update', target: name, args: input });
      return externalAuth.get(name);
    },
    remove(name, req) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      stmts.deleteProvider.run(row.id);
      req?.audit?.({ action: 'security.external_auth.delete', target: name });
      return { deleted: true };
    },
    async discover(name, req, { allowForeignEndpoints = false } = {}) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      const url = `${row.issuer_url}/.well-known/openid-configuration`;
      let doc;
      try {
        doc = await fetchJson(url, { timeoutMs: 10_000 });
      } catch (err) {
        throw badRequest(`OpenID discovery failed for ${url}: ${err.message}`);
      }
      const discovery = checkDiscoveryDocument(doc, row.issuer_url, { allowForeignEndpoints });
      db.prepare("UPDATE external_auth_providers SET discovery_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(discovery), row.id);
      jwksCache.delete(row.id);
      req?.audit?.({ action: 'security.external_auth.discover', target: name, args: { allowForeignEndpoints, foreignEndpoints: discovery.foreignEndpoints } });
      return externalAuth.get(name);
    },
    async jwks(row, discovery) {
      if (!discovery?.jwksUri) return [];
      const cached = jwksCache.get(row.id);
      if (cached && Date.now() - cached.at < 3_600_000) return cached.keys;
      if (!discovery.jwksUri.startsWith('https://')) throw badRequest('jwks_uri must use https://');
      let keys;
      try { keys = (await fetchJson(discovery.jwksUri, { timeoutMs: 15_000 })).keys || []; } catch (err) { throw badRequest(`Fetching the provider keys failed: ${err.message}`); }
      jwksCache.set(row.id, { at: Date.now(), keys });
      return keys;
    },
    // Helpers for the auth category to wire a login/link flow:
    authorizationUrl(name, { state, nonce, redirectUri }) {
      const p = externalAuth.get(name);
      if (!p.enabled) throw badRequest(`Provider "${name}" is disabled`);
      if (!p.discovery?.authorizationEndpoint) throw badRequest(`Run discovery for "${name}" first`);
      const u = new URL(p.discovery.authorizationEndpoint);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri, scope: p.scopes, state, nonce })) if (v) u.searchParams.set(k, v);
      return u.toString();
    },
    // `nonce` must be the value sent in authorizationUrl() for this login; the
    // returned claims are trustworthy only because the id_token was verified.
    async exchangeCode(name, { code, redirectUri, nonce = null }) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      if (!row.enabled) throw badRequest(`Provider "${name}" is disabled`);
      const discovery = json.parse(row.discovery_json, null);
      if (!discovery?.tokenEndpoint) throw badRequest(`Run discovery for "${name}" first`);
      if (!discovery.tokenEndpoint.startsWith('https://')) throw badRequest('The token endpoint must use https://; run discovery again');
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: row.client_id });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      const clientSecret = row.client_secret_enc ? crypto.decrypt(row.client_secret_enc) : null;
      if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(row.client_id)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
      let tokens;
      try { tokens = await fetchJson(discovery.tokenEndpoint, { method: 'POST', headers, body, timeoutMs: 15_000 }); } catch (err) { throw badRequest(`Token exchange failed: ${err.message}`); }
      if (!tokens.id_token) throw badRequest('The token response has no id_token: the provider is not OpenID Connect or "openid" is missing from the scopes');
      const header = decodeJwtPart(String(tokens.id_token).split('.')[0]) || {};
      const jwks = /^HS/.test(header.alg || '') ? [] : await externalAuth.jwks(row, discovery);
      let claims;
      try {
        claims = verifyIdToken(tokens.id_token, { issuer: discovery.issuer || row.issuer_url, clientId: row.client_id, nonce, jwks, clientSecret });
      } catch (err) {
        throw badRequest(`The provider's id_token was rejected: ${err.message}`);
      }
      if (discovery.userinfoEndpoint && tokens.access_token) {
        const extra = await fetchJson(discovery.userinfoEndpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, timeoutMs: 15_000 }).catch(() => null);
        if (extra && typeof extra === 'object') {
          if (extra.sub && extra.sub !== claims.sub) throw badRequest('The userinfo subject does not match the id_token');
          claims = { ...extra, ...claims };
        }
      }
      return { claims, subject: claims.sub, email: claims.email_verified === false ? null : claims.email || null, tokens: { tokenType: tokens.token_type, expiresIn: tokens.expires_in } };
    },
    findLinkedUser(name, subject) {
      const row = stmts.providerByName.get(name);
      return row ? stmts.linkFind.get(row.id, subject) || null : null;
    },
    link(name, { userId, subject, email }) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      stmts.linkInsert.run(row.id, userId, subject, email || null);
      return stmts.linkFind.get(row.id, subject);
    },
  };

  // Read-only scanner. Every probe is isolated so one failing check never hides
  // the rest; "fix" links point at the panel's own pages.
  const advisor = {
    last() {
      const row = stmts.lastRun.get();
      return row ? { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, trigger: row.trigger, summary: json.parse(row.summary_json, {}), findings: json.parse(row.findings_json, []) } : null;
    },
    async scan(trigger = 'manual', req) {
      const findings = [];
      const add = (f) => findings.push({ grade: 'info', ...f });
      const probe = async (id, title, fn) => {
        try { await fn(); } catch (err) { add({ id, grade: 'info', title: `Could not check: ${title}`, detail: err.message }); }
      };
      await capabilities.ensureFresh();

      await probe('ssh', 'SSH configuration', async () => {
        if (!capabilities.has('sshd')) { add({ id: 'ssh.installed', grade: 'info', title: 'OpenSSH server is not installed', detail: 'No sshd binary was found, so SSH hardening checks were skipped.' }); return; }
        const cfg = await op('sec.sshd.get');
        const e = cfg.effective;
        const pw = (e.passwordauthentication || 'yes').toLowerCase();
        add(pw === 'yes'
          ? { id: 'ssh.password', grade: 'warning', title: 'SSH password authentication is enabled', detail: 'Attackers can brute-force passwords over SSH. Prefer key-based authentication and disable passwords once a key is authorized.', fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } }
          : { id: 'ssh.password', grade: 'ok', title: 'SSH password authentication is disabled' });
        const root = (e.permitrootlogin || 'yes').toLowerCase();
        add(root === 'yes'
          ? { id: 'ssh.root', grade: 'warning', title: 'Root may log in over SSH with a password', detail: `PermitRootLogin is "${root}". Set it to prohibit-password or no.`, fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } }
          : { id: 'ssh.root', grade: 'ok', title: `Root SSH login is restricted (PermitRootLogin ${root})` });
        if (e.port && e.port !== '22') add({ id: 'ssh.port', grade: 'ok', title: `SSH listens on a non-default port (${e.port})` });
        for (const s of cfg.shadowed || []) add({ id: `ssh.shadowed.${s.key}`, grade: 'warning', title: `${s.key} ${s.managed} from the panel is overridden (sshd uses ${s.effective})`, detail: s.by ? `${s.by} sets it first and sshd keeps the first value it reads.` : 'Another sshd configuration file read before the panel drop-in sets it.', fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } });
      });

      await probe('2fa', 'two-factor authentication', async () => {
        const root = stmts.rootUser.get();
        const required = Boolean(settings.get('security.2fa.required_for_root'));
        if (root && !root.totp_enabled) add({ id: '2fa.root', grade: 'critical', title: 'The root panel user has no two-factor authentication', detail: 'A leaked root password gives full control of the server. Enroll an authenticator app.', fix: { label: 'Two-Factor Authentication', path: '/security-center/two-factor-authentication' } });
        else add({ id: '2fa.root', grade: 'ok', title: 'Root has two-factor authentication enabled' });
        if (!required) add({ id: '2fa.policy', grade: 'warning', title: 'Two-factor authentication is not required for root', detail: 'Enable the policy so it cannot be silently disabled.', fix: { label: 'Two-Factor Authentication', path: '/security-center/two-factor-authentication' } });
      });

      await probe('integrity', 'panel integrity', async () => {
        // Release builds ship /opt/whm/MANIFEST.sha256 (sha256 + path per line) beside the panel;
        // a development checkout has none, which is reported but not graded.
        const manifest = [path.join(REPO_ROOT, 'MANIFEST.sha256'), '/opt/whm/MANIFEST.sha256'].find((f) => fs.existsSync(f));
        if (!manifest) { add({ id: 'integrity.manifest', grade: 'info', title: 'No release manifest found', detail: 'MANIFEST.sha256 is written by release packaging; development checkouts and manual installs have none, so panel files cannot be verified against a known-good list.' }); return; }
        const root = path.dirname(manifest);
        const entries = fs.readFileSync(manifest, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.match(/^([0-9a-f]{64})\s+\*?(.+)$/)).filter(Boolean);
        const changed = []; const missing = [];
        for (const [, digest, rel] of entries) {
          const file = path.resolve(root, rel);
          if (!file.startsWith(root + path.sep)) continue;
          if (!fs.existsSync(file)) { missing.push(rel); continue; }
          if (nodeCrypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) changed.push(rel);
        }
        if (!entries.length) add({ id: 'integrity.manifest', grade: 'warning', title: 'The release manifest is empty or unreadable', detail: `${manifest} holds no "<sha256>  <path>" lines.` });
        else if (changed.length || missing.length) add({ id: 'integrity.files', grade: 'critical', title: `${changed.length + missing.length} panel file(s) differ from the release manifest`, detail: [...changed.map((f) => `${f}: modified`), ...missing.map((f) => `${f}: missing`)].slice(0, 20).join('\n'), fix: { label: 'Upgrade to Latest Version', path: '/cpanel/upgrade-to-latest-version' } });
        else add({ id: 'integrity.files', grade: 'ok', title: `All ${entries.length} manifest files match the release manifest` });
      });

      await probe('firewall', 'firewall', async () => {
        const detect = await op('sec.firewall.detect');
        if (!capabilities.has('firewall') || !detect.backend) add({ id: 'firewall.present', grade: 'critical', title: 'No supported firewall is installed', detail: 'Install iptables or nftables so the panel can block abusive addresses and restrict SMTP.', fix: { label: 'cPHulk Brute Force Protection', path: '/security-center/cphulk-brute-force-protection' } });
        else {
          add({ id: 'firewall.present', grade: 'ok', title: `Firewall available (${detect.backend})` });
          const smtpState = await op('sec.smtp_restrict.get');
          const open = smtpState.unprotected || [];
          add(!smtpState.enabled
            ? smtp.desired()
              ? { id: 'smtp.restricted', grade: 'warning', title: 'SMTP restrictions are enabled but not active in the firewall', detail: 'The rules were lost (reboot or firewall restart). They are re-applied by the hourly maintenance job; re-enable the restriction to apply them now.', fix: { label: 'SMTP Restrictions', path: '/security-center/smtp-restrictions' } }
              : { id: 'smtp.restricted', grade: 'warning', title: 'SMTP restrictions are disabled', detail: 'Compromised scripts can send spam directly on port 25. Restrict outbound SMTP to root and the mail groups.', fix: { label: 'SMTP Restrictions', path: '/security-center/smtp-restrictions' } }
            : open.length
              ? { id: 'smtp.restricted', grade: 'warning', title: `Outbound SMTP is restricted for IPv4 only (${open.join(', ')} open)`, detail: 'ip6tables is not installed, so unprivileged processes can still reach port 25 over IPv6. Install ip6tables or switch to nftables.', fix: { label: 'SMTP Restrictions', path: '/security-center/smtp-restrictions' } }
              : { id: 'smtp.restricted', grade: 'ok', title: 'Outbound SMTP is restricted to mail services (IPv4 and IPv6)' });
        }
      });

      await probe('cphulk', 'cPHulk', async () => {
        add(settings.get('security.cphulk.enabled')
          ? { id: 'cphulk.enabled', grade: 'ok', title: `cPHulk brute force protection is on (${settings.get('security.cphulk.max_failures_per_ip')} failures → ${settings.get('security.cphulk.lockout_minutes')} min block)` }
          : { id: 'cphulk.enabled', grade: 'warning', title: 'cPHulk brute force protection is disabled', detail: 'Repeated failed panel logins are not being blocked.', fix: { label: 'cPHulk Brute Force Protection', path: '/security-center/cphulk-brute-force-protection' } });
      });

      // The pending-update check lives in the Software category
      // (ctx.software.update.status(), backed by the pkg.upgradable op).
      await probe('packages', 'outdated packages', async () => {
        const software = ctx.software;
        const pkg = ctx.pkg || software?.pkg;
        if (!software && !pkg) { add({ id: 'pkg.updates', grade: 'info', title: 'Package update check unavailable', detail: 'The Software category is not loaded on this panel.' }); return; }
        if (!capabilities.has('pkg')) {
          add({ id: 'pkg.updates', grade: 'info', title: 'Package update check unavailable', detail: 'No supported package manager (apt-get, dnf or yum) was found on this server.' });
          return;
        }
        let count = 0; let security = 0;
        if (typeof software?.update?.status === 'function') {
          const status = await software.update.status();
          count = Number(status?.count ?? (Array.isArray(status?.packages) ? status.packages.length : 0)) || 0;
          security = Number(status?.security ?? 0) || 0;
        } else {
          const fn = pkg && (pkg.outdated || pkg.listUpdates || pkg.updates);
          if (typeof fn !== 'function') { add({ id: 'pkg.updates', grade: 'info', title: 'Package update check unavailable', detail: 'The loaded Software category exposes no update check.' }); return; }
          const result = await fn.call(pkg);
          count = Array.isArray(result) ? result.length : Number(result?.count ?? result?.total ?? 0) || 0;
          security = Number(result?.security ?? 0) || 0;
        }
        add(count > 0
          ? { id: 'pkg.updates', grade: security > 0 ? 'critical' : 'warning', title: `${count} package update${count === 1 ? '' : 's'} available${security > 0 ? ` (${security} security)` : ''}`, detail: 'Outdated packages may carry known vulnerabilities.', fix: { label: 'System Update', path: '/software/system-update' } }
          : { id: 'pkg.updates', grade: 'ok', title: 'All distribution packages are up to date' });
      });

      await probe('filesystem', 'filesystem permissions', async () => {
        const fsScan = await op('sec.scan.filesystem', { root: settings.get('basic.home_root') || '/home', limit: 25 });
        for (const f of fsScan.sensitive) if (!f.ok) add({ id: `fs.${f.path}`, grade: 'critical', title: `${f.path} is too permissive (${f.mode})`, detail: `Expected at most ${f.maxMode}.` });
        if (fsScan.worldWritable.length) add({ id: 'fs.world_writable', grade: 'warning', title: `${fsScan.worldWritable.length} world-writable director${fsScan.worldWritable.length === 1 ? 'y' : 'ies'} under ${fsScan.root}`, detail: fsScan.worldWritable.slice(0, 10).join(', ') });
        else if (fsScan.scanned) add({ id: 'fs.world_writable', grade: 'ok', title: `No world-writable directories found under ${fsScan.root} (depth 3)` });
      });

      await probe('settings', 'panel settings', async () => {
        const min = Number(settings.get('security.min_password_strength')) || 0;
        add(min < 50
          ? { id: 'password.strength', grade: 'warning', title: `Minimum password strength is low (${min})`, detail: 'Raise it to at least 65 to reject weak account and panel passwords.', fix: { label: 'Password Strength Configuration', path: '/security-center/password-strength-configuration' } }
          : { id: 'password.strength', grade: 'ok', title: `Minimum password strength is ${min}` });
        if (!config.tls) add({ id: 'panel.tls', grade: 'warning', title: 'The panel is served over plain HTTP', detail: 'Credentials and session cookies travel unencrypted. Configure WHM_TLS_CERT/WHM_TLS_KEY to serve on port 2087.' });
        else add({ id: 'panel.tls', grade: 'ok', title: 'The panel is served over HTTPS' });
        const fb = await op('sec.fork_bomb.get');
        add(fb.enabled ? { id: 'forkbomb', grade: 'ok', title: 'Shell fork bomb protection is enabled' } : { id: 'forkbomb', grade: 'info', title: 'Shell fork bomb protection is disabled', detail: 'Users with shell access can exhaust process and memory limits.', fix: { label: 'Shell Fork Bomb Protection', path: '/security-center/shell-fork-bomb-protection' } });
        const cc = await op('sec.compiler_access.get');
        if (cc.installed) add(cc.allowed ? { id: 'compilers', grade: 'info', title: 'Compilers are available to all users', detail: 'Exploit kits often need a compiler. Deny access unless accounts need it.', fix: { label: 'Compiler Access', path: '/security-center/compiler-access' } } : { id: 'compilers', grade: 'ok', title: 'Compilers are restricted to privileged users' });
        const shells = stmts.shellAccounts.get().n;
        if (shells > 0) add({ id: 'accounts.shell', grade: 'info', title: `${shells} hosting account${shells === 1 ? ' has' : 's have'} shell access` });
        const p = policy();
        const stored = [p.verifiedIpLogin && 'verified-IP login', p.require2faForRoot && '2FA for root', p.require2faForResellers && '2FA for resellers', p.apiTokensRequire2fa && '2FA for API tokens', p.sessionTimeoutMinutes > 0 && 'session timeout', p.disallowConcurrentSessions && 'single session', p.passwordMaxAgeDays > 0 && 'password age', settings.get('security.questions.enabled') && 'security questions'].filter(Boolean);
        if (stored.length) add({ id: 'policy.unenforced', grade: 'warning', title: `${stored.length} login polic${stored.length === 1 ? 'y is' : 'ies are'} stored but not enforced yet`, detail: `${stored.join(', ')}: the authentication layer does not read these settings yet, so they provide no protection today.`, fix: { label: 'Configure Security Policies', path: '/security-center/configure-security-policies' } });
      });

      await probe('apache', 'web server hardening', async () => {
        if (!capabilities.has('apache')) return;
        const layout = await detectModsec(true);
        if (!layout.installed) add({ id: 'modsec.installed', grade: 'warning', title: 'ModSecurity is not installed', detail: 'A web application firewall blocks common injection and scanner traffic.', fix: { label: 'ModSecurity Configuration', path: '/security-center/modsecurity-configuration' } });
        else {
          const cfg = await op('sec.modsec.get_config');
          add(cfg.effective.SecRuleEngine === 'On' ? { id: 'modsec.engine', grade: 'ok', title: 'ModSecurity rule engine is on' } : { id: 'modsec.engine', grade: 'warning', title: `ModSecurity rule engine is ${cfg.effective.SecRuleEngine || 'Off'}`, fix: { label: 'ModSecurity Configuration', path: '/security-center/modsecurity-configuration' } });
          if (!stmts.vendors.all().some((v) => v.enabled)) add({ id: 'modsec.vendors', grade: 'info', title: 'No ModSecurity vendor rule set is enabled', fix: { label: 'ModSecurity Vendors', path: '/security-center/modsecurity-vendors' } });
        }
        const ud = await op('sec.userdir.get');
        if (ud.enabled) add({ id: 'userdir', grade: 'info', title: 'Apache mod_userdir (~user URLs) is enabled', detail: 'Sites served from ~user URLs share the main IP and bypass per-domain SSL.', fix: { label: 'Apache mod_userdir Tweak', path: '/security-center/apache-mod-userdir-tweak' } });
      });

      await probe('hostaccess', 'host access control', async () => {
        if (!stmts.hostRules.all().length) add({ id: 'hostaccess', grade: 'info', title: 'No host access rules are defined', detail: 'TCP wrappers can limit SSH and FTP to trusted networks.', fix: { label: 'Host Access Control', path: '/security-center/host-access-control' } });
      });

      const order = { critical: 0, warning: 1, info: 2, ok: 3 };
      findings.sort((a, b) => order[a.grade] - order[b.grade]);
      const summary = { critical: 0, warning: 0, info: 0, ok: 0 };
      for (const f of findings) summary[f.grade]++;
      const { lastInsertRowid } = stmts.insertRun.run(trigger, JSON.stringify(summary), JSON.stringify(findings));
      stmts.pruneRuns.run();
      req?.audit?.({ action: 'security.advisor.scan', args: summary });
      return { id: Number(lastInsertRowid), trigger, finishedAt: new Date().toISOString(), summary, findings };
    },
  };

  return {
    reloadApache,
    policy,
    passwordStrength: passwordPolicy,
    passwordContexts: PASSWORD_CONTEXTS,
    hostAccess, ssh, cphulk, firewall: firewallApi, smtp, compilers, traceroute, forkBomb, wheel, userdir, modsec, externalAuth, advisor,
  };
}
