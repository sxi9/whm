import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { createTestApp, waitForJob } from './support/app.js';
import { parsePeerHost, groupOfKey, isPushableKey, PEER_HOST_RE, GROUP_NAMES, DEFAULT_GROUPS, CONFIG_GROUPS, CONFIG_KEYS, keysOfGroup, tokenAllowed, CLUSTER_TOKEN_ROUTES, CLUSTER_SCOPES, LEGACY_CLUSTER_SCOPE } from '../src/services/clusters.js';
import { validateIncoming, exportValue } from '../src/services/clusters-config.js';
import { DEFAULT_SETTINGS } from '../src/db/seed.js';

const PEER_TOKEN = 'whm_peer-token-0123456789abcdefghij';
const ZONE = (domain, serial = 7) => `$TTL 14400
@   IN  SOA ns1.example.com. hostmaster.${domain}. (
        ${serial}  ; serial
        3600 1800 1209600 86400 )
@       IN  NS    ns1.example.com.
@       IN  NS    ns2.example.com.
@       IN  A     10.0.0.5
www     IN  A     10.0.0.5
`;

// A stand-in for a remote panel: answers the cluster endpoints and records
// what it was sent.
function fakePeer() {
  const received = [];
  const state = { token: PEER_TOKEN, ping: true, status: 200, exportSettings: { 'dns.default_ttl': 3600, 'tweak.max_emails_per_hour': 250, 'basic.hostname': 'peer.example.com', 'contacts.smtp.password': 'nope' } };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${state.token}`) return send(401, { error: { code: 'unauthorized', message: 'Invalid API token' } });
      if (state.status !== 200) return send(state.status, { error: { code: 'boom', message: 'peer exploded' } });
      const path = req.url.split('?')[0];
      if (path === '/api/clusters/ping') return state.ping ? send(200, { data: { hostname: 'peer.example.com', version: '0.9.0', accepts: { dns: true, config: true }, groups: GROUP_NAMES } }) : send(404, { error: { code: 'not_found', message: 'No such API endpoint' } });
      if (path === '/api/system/status') return send(200, { data: { hostname: 'old-peer.example.com', panel: { version: '0.1.0' } } });
      if (path === '/api/clusters/config/receive') { const keys = Object.keys(received.at(-1).body.settings); return send(200, { data: { applied: keys.slice(0, 2), unchanged: keys.length - 2, rejected: [] } }); }
      if (path === '/api/clusters/config/export') return send(200, { data: { hostname: 'peer.example.com', groups: ['dns', 'tweak'], settings: state.exportSettings } });
      send(404, { error: { code: 'not_found', message: 'No such API endpoint' } });
    });
  });
  return { received, state, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))), close: () => new Promise((r) => server.close(r)) };
}

describe('clusters helpers', () => {
  it('parses peer addresses and rejects anything that is not host[:port]', () => {
    expect(parsePeerHost('ns2.example.com').href).toBe('https://ns2.example.com:2087/');
    expect(parsePeerHost('http://10.0.0.9:2086').href).toBe('http://10.0.0.9:2086/');
    expect(parsePeerHost('10.0.0.9').port).toBe('2087');
    for (const bad of ['ns2.example.com/api', 'ns2 example.com', 'https://x.com/?a=b', '-rf', 'a;b', '../x', 'ftp://x.com', '']) {
      expect(PEER_HOST_RE.test(bad), bad).toBe(false);
    }
    expect(() => parsePeerHost('a;b')).toThrow();
  });

  it('maps settings to groups and keeps host identity and secrets local', () => {
    expect(groupOfKey('dns.default_ttl')).toBe('dns');
    expect(groupOfKey('updates.tier')).toBe('software');
    expect(groupOfKey('basic.hostname')).toBeNull();
    expect(groupOfKey('news.html')).toBeNull();
    expect(isPushableKey('contacts.smtp.password')).toBe(false);
    expect(isPushableKey('security.cphulk.enabled')).toBe(true);
    expect(Object.keys(CONFIG_GROUPS)).toEqual(GROUP_NAMES);
    for (const g of GROUP_NAMES) expect(keysOfGroup(g).length, g).toBeGreaterThan(0);
    // Customization, themes, support and the market catalogue replicate; logo files and credentials do not.
    expect(GROUP_NAMES).toContain('branding');
    for (const key of ['branding.company_name', 'branding.login_notice', 'themes.default', 'themes.account_default', 'support.provider_name', 'support.access.max_hours', 'market.providers']) expect(groupOfKey(key), key).toBe('branding');
    for (const key of ['branding.logo', 'branding.favicon', 'cpanel.upgrade.last', 'cpanel.upgrade.last_check', 'support.access.last_cleanup']) expect(isPushableKey(key), key).toBe(false);
    // The login policy and the update feed never replicate unless chosen.
    expect(DEFAULT_GROUPS).toEqual(GROUP_NAMES.filter((g) => g !== 'security' && g !== 'software'));
    expect(DEFAULT_GROUPS).toContain('branding');
  });

  // Host identity, addresses, per-host daemon state, paths, timestamps and
  // secrets must never travel, whatever prefix they sit under.
  const HOST_STATE = /(^|\.)(ip|ipv4|ipv6|hostname|main_ip|main_ipv6|shared_ip|outbound|participant_id|local_dir|staging_dir|archive_dirs|resolvers|allow_transfer|apache_ports|nameserver|ftp_server|active_profile|nginx|ea4|smtp|external_auth|from_address|notification_from|cluster_verify_tls|accept_pushes|auto_push|groups|bind_address_ipv4|bind_address_ipv6)(\.|$)|(^|[._])(last(_[a-z_]+)?|updated_at|[a-z_]*fingerprint|password|password_enc|secret|token|private_key|credential|api_key)$|^service_config\.ftp$/;
  it('never shares a host-identity or per-host key, whatever its prefix', () => {
    const pushable = Object.keys(CONFIG_KEYS);
    for (const key of pushable) expect(key, key).not.toMatch(HOST_STATE);
    for (const key of ['basic.hostname', 'basic.main_ip', 'basic.main_ipv6', 'basic.shared_ip', 'mail.outbound.ipv4', 'mail.outbound.ipv6', 'mail.notification_from', 'service_config.apache_ports', 'service_config.nameserver', 'service_config.ftp_server', 'service_config.ftp', 'service_config.apache_updated_at', 'service_config.webdisk_updated_at', 'backup.local_dir', 'contacts.smtp.host', 'contacts.smtp.username', 'contacts.smtp.password_enc', 'contacts.from_address', 'contacts.exim.primary_hostname', 'contacts.check.last_result', 'contacts.check.last_run_at', 'analytics.participant_id', 'analytics.updated_at', 'analytics.enabled', 'software.nginx.last_fingerprint', 'software.nginx.last_sync', 'software.nginx.enabled', 'software.ea4.active_profile', 'software.updates.last_check', 'software.panel.last_check', 'stats.last_run', 'dns.resolvers', 'dns.allow_transfer', 'dns.cluster_verify_tls', 'security.external_auth.enabled', 'clusters.config.groups', 'clusters.dns.accept_pushes', 'db.client.bind_address_ipv4', 'ip.remote.mail_ipv4', 'transfers.staging_dir', 'dns.bogus_new_key', 'tweak.made_up']) {
      expect(isPushableKey(key), key).toBe(false);
    }
    // Every seeded key is either shared on purpose or matches the host-state pattern / a known local-only prefix.
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (isPushableKey(key)) expect(key, key).not.toMatch(HOST_STATE);
  });

  it('validates incoming values against each key\'s schema and strips per-host fields on export', () => {
    expect(validateIncoming('security.policy.session_timeout_minutes', 'abc')).toMatchObject({ ok: false, reason: expect.stringMatching(/number/i) });
    expect(validateIncoming('tweak.max_emails_per_hour', {})).toMatchObject({ ok: false });
    expect(validateIncoming('service_config.apache', [])).toMatchObject({ ok: false });
    expect(validateIncoming('service_config.apache', { timeout: 10, mpm: { module: 'event' }, unknownField: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknownField|Unrecognized/i) });
    expect(validateIncoming('service_config.apache', { timeout: 10, mpm: { module: 'event' } })).toEqual({ ok: true, value: { timeout: 10, mpm: { module: 'event' } } });
    // Free-form Apache directives are code: refused on receive, stripped on export.
    expect(validateIncoming('service_config.apache', { timeout: 10, customDirectives: 'Include /etc/passwd' })).toMatchObject({ ok: false, reason: expect.stringMatching(/customDirectives|Unrecognized/i) });
    expect(exportValue('service_config.apache', { timeout: 10, customDirectives: 'LoadModule evil' })).toEqual({ ok: true, value: { timeout: 10 } });
    expect(validateIncoming('branding.primary_color', '#12AB')).toMatchObject({ ok: false });
    expect(validateIncoming('branding.primary_color', '#1a2b3c')).toEqual({ ok: true, value: '#1a2b3c' });
    expect(validateIncoming('branding.company_name', '<script>')).toMatchObject({ ok: false });
    expect(validateIncoming('branding.help_url', 'https://u:p@help.example.com/')).toMatchObject({ ok: false, reason: expect.stringMatching(/credentials/i) });
    expect(validateIncoming('themes.default', 'Bad Slug')).toMatchObject({ ok: false });
    expect(validateIncoming('market.providers', [{ name: 'store', displayName: 'Store', url: 'https://u:p@store.example.com/', products: [] }])).toMatchObject({ ok: false });
    expect(validateIncoming('market.providers', [{ name: 'store', displayName: 'Store', enabled: true, url: 'https://store.example.com', adapter: 'generic', commissionPercent: 10, products: [{ id: 'dv', name: 'DV', price: 9.99, basePrice: 9, currency: 'USD', termMonths: 12 }] }])).toMatchObject({ ok: true });
    expect(validateIncoming('basic.home_root', '/home/../etc')).toMatchObject({ ok: false });
    expect(validateIncoming('basic.home_root', 'home')).toMatchObject({ ok: false });
    expect(validateIncoming('basic.home_root', '/srv/www')).toEqual({ ok: true, value: '/srv/www' });
    expect(validateIncoming('backup.schedule', '0 2 * * *')).toEqual({ ok: true, value: '0 2 * * *' });
    expect(validateIncoming('backup.schedule', 'rm -rf /')).toMatchObject({ ok: false });
    expect(validateIncoming('backup.excludes', ['../../etc'])).toMatchObject({ ok: false });
    expect(validateIncoming('dns.dkim_bits', 1536)).toMatchObject({ ok: false });
    expect(validateIncoming('dns.spf_default', 'v=spf1 +mx -all')).toMatchObject({ ok: true });
    expect(validateIncoming('dns.spf_default', 'v=spf1\ninclude:x')).toMatchObject({ ok: false });
    expect(validateIncoming('dns.bogus_new_key', 1)).toMatchObject({ ok: false, reason: 'not a shared setting' });
    // Every tier Tweak Settings offers (UPDATE_TIERS) is accepted from a peer, "current" included.
    for (const tier of ['stable', 'release', 'current', 'edge']) expect(validateIncoming('updates.tier', tier)).toEqual({ ok: true, value: tier });
    expect(validateIncoming('updates.tier', 'nightly')).toMatchObject({ ok: false });
    // Exim's TLS block and Dovecot's cipher/mailbox-layout fields are per host: dropped on export, refused on receive.
    const exim = exportValue('service_config.exim', { rblEnabled: true, rbls: ['zen.spamhaus.org'], tls: { minProtocol: 'TLSv1.2' } });
    expect(exim).toEqual({ ok: true, value: { rblEnabled: true, rbls: ['zen.spamhaus.org'] } });
    expect(validateIncoming('service_config.exim', { rblEnabled: true, tls: null })).toMatchObject({ ok: false });
    expect(exportValue('service_config.mailserver', { protocols: ['imap'], sslCipherList: 'X', mailLocation: 'maildir:~/mail', mailboxFormat: 'maildir' })).toEqual({ ok: true, value: { protocols: ['imap'] } });
    expect(exportValue('service_config.apache', { timeout: 1, defaultPhpVersion: 'ea-php83' })).toEqual({ ok: true, value: { timeout: 1 } });
    expect(exportValue('tweak.max_emails_per_hour', 'oops')).toEqual({ ok: false });
  });

  // A feed URL may carry basic-auth credentials (Software sends them as a
  // header); they are a secret of the host that holds them.
  it('never lets a URL with embedded credentials travel in either direction', () => {
    for (const key of ['software.update_url', 'mail.country_filter.source_url']) {
      expect(validateIncoming(key, 'https://example.com/feed.json')).toEqual({ ok: true, value: 'https://example.com/feed.json' });
      expect(validateIncoming(key, '')).toEqual({ ok: true, value: '' });
      expect(validateIncoming(key, 'https://u:p@example.com/feed.json')).toMatchObject({ ok: false, reason: expect.stringMatching(/credentials/i) });
      expect(validateIncoming(key, 'https://token@example.com/feed.json')).toMatchObject({ ok: false });
      expect(validateIncoming(key, 'ftp://example.com/x')).toMatchObject({ ok: false });
      expect(exportValue(key, 'https://u:p@example.com/feed.json')).toEqual({ ok: false });
      expect(exportValue(key, 'https://example.com/feed.json')).toEqual({ ok: true, value: 'https://example.com/feed.json' });
    }
  });
});

describe('Clusters API', () => {
  let app;
  let csrf;
  let peer;
  let port;
  let resellerHttp;
  let resellerCsrf;
  let peerId;
  const post = (path, body) => app.http.post(`/api/clusters${path}`).set('X-CSRF-Token', csrf).send(body);
  const patch = (path, body) => app.http.patch(`/api/clusters${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body) => app.http.put(`/api/clusters${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/clusters${path}`).set('X-CSRF-Token', csrf);
  const get = (path) => app.http.get(`/api/clusters${path}`);
  const auditCount = (action) => app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;

  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
    app.ctx.settings.set('basic.hostname', 'test.example.com');
    peer = fakePeer();
    port = await peer.listen();
    const reseller = await app.createUser('resell1', 'reseller');
    resellerHttp = request.agent(app.ctx.app);
    resellerCsrf = (await resellerHttp.post('/api/auth/login').send({ username: reseller.username, password: reseller.password })).body.data.csrfToken;
  });
  afterAll(async () => { await peer.close(); await app.close(); });

  describe('RBAC and validation', () => {
    it('keeps resellers out of every route', async () => {
      for (const p of ['/ping', '/peers', '/tokens', '/events', '/dns', '/config']) await resellerHttp.get(`/api/clusters${p}`).expect(403);
      await resellerHttp.post('/api/clusters/peers').set('X-CSRF-Token', resellerCsrf).send({ name: 'x', host: 'ns2.example.com', token: PEER_TOKEN }).expect(403);
      await resellerHttp.post('/api/clusters/config/push').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
      await resellerHttp.post('/api/clusters/config/receive').set('X-CSRF-Token', resellerCsrf).send({ settings: {} }).expect(403);
      await request(app.ctx.app).get('/api/clusters/peers').expect(401);
    });

    it('rejects malformed peers, tokens and bodies with 422', async () => {
      await post('/peers', { name: 'x' }).expect(422);
      await post('/peers', { name: 'x', host: 'bad host', token: PEER_TOKEN }).expect(422);
      await post('/peers', { name: 'x', host: 'ns2.example.com/api', token: PEER_TOKEN }).expect(422);
      await post('/peers', { name: 'x', host: 'ns2.example.com', token: 'short' }).expect(422);
      await post('/peers', { name: 'x', host: 'ns2.example.com', token: 'a;b'.repeat(8) }).expect(422);
      await post('/peers', { name: 'x', host: 'ns2.example.com', token: PEER_TOKEN, role: 'master' }).expect(422);
      await post('/peers', { name: 'x', host: 'ns2.example.com', token: PEER_TOKEN, extra: 1 }).expect(422);
      await post('/peers', { name: 'x', host: 'test.example.com', token: PEER_TOKEN }).expect(422);
      await post('/tokens', { name: '' }).expect(422);
      await post('/tokens', { name: 'ok' }).expect(422);
      await post('/tokens', { name: 'ok', purpose: 'both' }).expect(422);
      await post('/tokens', { name: 'ok', purpose: 'dns', expiresInDays: 0 }).expect(422);
      await get('/tokens?purpose=all').expect(422);
      await put('/dns/settings', {}).expect(422);
      await put('/config/settings', { groups: ['nonsense'] }).expect(422);
      await post('/dns/sync', { domains: ['not a domain'] }).expect(422);
      await post('/dns/receive', { domain: 'x.com' }).expect(422);
      await post('/config/receive', { settings: { 'Bad Key': 1 } }).expect(422);
      await post('/config/receive', { settings: { 'dns.default_ttl': 1 }, source: 'has space' }).expect(422);
      await post('/config/pull', {}).expect(422);
      await post('/config/push', { groups: [] }).expect(422);
      await get('/events?kind=bogus').expect(422);
    });
  });

  describe('peers', () => {
    it('creates, lists, updates and never returns the token', async () => {
      const res = await post('/peers', { name: 'ns2', host: `http://127.0.0.1:${port}`, token: PEER_TOKEN, role: 'sync', configEnabled: true }).expect(201);
      peerId = res.body.data.id;
      expect(res.body.data).toMatchObject({ name: 'ns2', host: `http://127.0.0.1:${port}`, role: 'sync', enabled: true, hasToken: true, verifyTls: true, configEnabled: true, status: 'unknown' });
      expect(JSON.stringify(res.body)).not.toContain(PEER_TOKEN);
      const row = app.ctx.db.prepare('SELECT api_token_enc FROM dns_clusters WHERE id = ?').get(peerId);
      expect(row.api_token_enc).not.toContain(PEER_TOKEN);
      expect(app.ctx.crypto.decrypt(row.api_token_enc)).toBe(PEER_TOKEN);
      const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'clusters.peer.create'").get();
      expect(audit.args_redacted).not.toContain(PEER_TOKEN);
      await post('/peers', { name: 'ns2', host: 'other.example.com', token: PEER_TOKEN }).expect(409);
      await post('/peers', { name: 'other', host: `http://127.0.0.1:${port}`, token: PEER_TOKEN }).expect(409);
      // The same peer written another way is the same peer.
      await post('/peers', { name: 'other', host: `HTTP://127.0.0.1:${port}`, token: PEER_TOKEN }).expect(409);
      const named = await post('/peers', { name: 'ns9', host: 'ns9.example.com', token: PEER_TOKEN, role: 'standalone' }).expect(201);
      await post('/peers', { name: 'ns9b', host: 'https://ns9.example.com:2087', token: PEER_TOKEN }).expect(409);
      await post('/peers', { name: 'ns9c', host: 'NS9.example.com:2087', token: PEER_TOKEN }).expect(409);
      await patch(`/peers/${named.body.data.id}`, { host: `http://127.0.0.1:${port}` }).expect(409);
      await del(`/peers/${named.body.data.id}`).expect(200);
      // This server by any of its names or addresses on its own ports is not a peer.
      for (const self of ['test.example.com', 'TEST.example.com:2087', 'localhost', '127.0.0.1', 'http://127.0.0.1:2086', '[::1]', '10.0.0.5:2087']) {
        app.ctx.settings.set('basic.main_ip', '10.0.0.5');
        const r = await post('/peers', { name: 'me', host: self, token: PEER_TOKEN }).expect(422);
        expect(r.body.error.fields.host[0], self).toMatch(/this server/);
      }
      await patch(`/peers/${peerId}`, { host: 'localhost:2087' }).expect(422);
      const list = await get('/peers').expect(200);
      expect(list.body.data).toHaveLength(1);
      await patch(`/peers/${peerId}`, {}).expect(422);
      const updated = await patch(`/peers/${peerId}`, { role: 'write-only', verifyTls: false }).expect(200);
      expect(updated.body.data).toMatchObject({ role: 'write-only', verifyTls: false, configEnabled: true, hasToken: true });
      await patch('/peers/9999', { role: 'sync' }).expect(404);
      // The DNS module sees the same peer (shared dns_clusters table).
      expect(app.ctx.dns.listClusters()).toEqual([expect.objectContaining({ id: peerId, name: 'ns2', role: 'write-only', has_token: true })]);
    });

    it('tests connectivity through the peer ping endpoint, falling back to system status', async () => {
      const ok = await post(`/peers/${peerId}/test`).expect(200);
      expect(ok.body.data.test).toMatchObject({ ok: true, remote: { hostname: 'peer.example.com', version: '0.9.0', clusterAware: true, accepts: { dns: true, config: true } } });
      expect(ok.body.data.status).toBe('ok');
      expect(peer.received.at(-1)).toMatchObject({ method: 'GET', url: '/api/clusters/ping', auth: `Bearer ${PEER_TOKEN}` });
      peer.state.ping = false;
      const old = await post(`/peers/${peerId}/test`).expect(200);
      expect(old.body.data.test.remote).toMatchObject({ hostname: 'old-peer.example.com', clusterAware: false });
      peer.state.ping = true;
      peer.state.token = 'something-else-entirely-1234';
      const bad = await post(`/peers/${peerId}/test`).expect(200);
      expect(bad.body.data.test.ok).toBe(false);
      expect(bad.body.data.test.error).toMatch(/rejected the token/);
      expect(bad.body.data).toMatchObject({ status: 'error', lastError: expect.stringMatching(/rejected/) });
      peer.state.token = PEER_TOKEN;
      await post('/peers/9999/test').expect(404);
      expect(auditCount('clusters.peer.test')).toBe(3);
      const events = await get('/events?kind=peer.test').expect(200);
      expect(events.body.data.map((e) => e.status)).toEqual(['failed', 'ok', 'ok']);
      expect(events.body.meta.total).toBe(3);
    });

    it('reports a refused connection', async () => {
      const dead = await post('/peers', { name: 'dead', host: 'http://127.0.0.1:1', token: PEER_TOKEN, role: 'standalone' }).expect(201);
      const res = await post(`/peers/${dead.body.data.id}/test`).expect(200);
      expect(res.body.data.test.ok).toBe(false);
      expect(res.body.data.test.error).toMatch(/connection refused/);
      await del(`/peers/${dead.body.data.id}`).expect(200);
      await del(`/peers/${dead.body.data.id}`).expect(404);
    });
  });

  describe('cluster tokens and inbound endpoints', () => {
    let secret;
    let tokenId;
    const asPeer = (method, path, body) => request(app.ctx.app)[method](`/api/clusters${path}`).set('Authorization', `Bearer ${secret}`).send(body);

    let configSecret;
    let configTokenId;
    const asConfigPeer = (method, path, body) => request(app.ctx.app)[method](`/api/clusters${path}`).set('Authorization', `Bearer ${configSecret}`).send(body);

    it('issues a zone token and a settings token for root, each shown exactly once', async () => {
      const res = await post('/tokens', { name: 'ns1 master', purpose: 'dns', expiresInDays: 30 }).expect(201);
      secret = res.body.data.token;
      tokenId = res.body.data.id;
      expect(secret).toMatch(/^whm_[A-Za-z0-9_-]{30,}$/);
      expect(res.body.data).toMatchObject({ name: 'ns1 master', username: 'root', prefix: secret.slice(0, 12), expiresAt: expect.stringMatching(/Z$/), purpose: 'dns', legacy: false });
      const list = await get('/tokens').expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({ id: tokenId, name: 'ns1 master' })]);
      expect(JSON.stringify(list.body)).not.toContain(secret);
      const row = app.ctx.db.prepare('SELECT scopes, token_hash FROM api_tokens WHERE id = ?').get(tokenId);
      expect(JSON.parse(row.scopes)).toEqual(['clustering:dns']);
      expect(row.token_hash).toBe(app.ctx.crypto.hashToken(secret));
      expect(res.body.data).toMatchObject({ access: 'confined', scopes: ['clustering:dns'], allowed: tokenAllowed('clustering:dns') });
      expect(res.body.data.allowed).toEqual(['GET /api/clusters/ping', 'POST /api/clusters/dns/receive', 'POST /api/dns/zones/import']);
      expect(list.body.data[0]).not.toHaveProperty('accessNote');
      expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'clusters.token.create'").get().args_redacted)).toMatchObject({ access: 'confined', purpose: 'dns' });
      const cfg = await post('/tokens', { name: 'ns1 config', purpose: 'config' }).expect(201);
      configSecret = cfg.body.data.token;
      configTokenId = cfg.body.data.id;
      expect(cfg.body.data).toMatchObject({ purpose: 'config', scopes: ['clustering:config'], allowed: ['GET /api/clusters/ping', 'GET /api/clusters/config/export', 'POST /api/clusters/config/receive'] });
      expect(JSON.parse(app.ctx.db.prepare('SELECT scopes FROM api_tokens WHERE id = ?').get(configTokenId).scopes)).toEqual(['clustering:config']);
      // Each page lists the tokens of its own purpose.
      expect((await get('/tokens?purpose=dns').expect(200)).body.data.map((t) => t.id)).toEqual([tokenId]);
      expect((await get('/tokens?purpose=config').expect(200)).body.data.map((t) => t.id)).toEqual([configTokenId]);
      expect((await get('/dns').expect(200)).body.data.tokens.map((t) => t.id)).toEqual([tokenId]);
      expect((await get('/config').expect(200)).body.data.tokens.map((t) => t.id)).toEqual([configTokenId]);
    });

    // The token belongs to root, yet core confines it to the peer endpoints
    // of its purpose everywhere: a compromised DNS slave gets no further than
    // pushing zones, and never reaches the configuration endpoints.
    it('confines a cluster token to its purpose\'s endpoints on every API, not only this module', async () => {
      expect(app.ctx.confinedScopes.get('clustering:dns')).toBe(CLUSTER_TOKEN_ROUTES['clustering:dns']);
      expect(app.ctx.confinedScopes.get('clustering:config')).toBe(CLUSTER_TOKEN_ROUTES['clustering:config']);
      expect(app.ctx.confinedScopes.get('clustering')).toBe(CLUSTER_TOKEN_ROUTES['clustering:dns']);
      const as = (method, path, body, token = secret) => request(app.ctx.app)[method](path).set('Authorization', `Bearer ${token}`).send(body);
      for (const p of ['/peers', '/tokens', '/events', '/dns', '/config']) {
        const r = await asPeer('get', p).expect(403);
        expect(r.body.error.code).toBe('scope_confined');
        expect(r.body.error.message).toMatch(/confined to GET \/api\/clusters\/ping/);
      }
      await asPeer('post', '/config/push', {}).expect(403);
      await asPeer('post', '/tokens', { name: 'escalate', purpose: 'config' }).expect(403);
      for (const p of ['/api/system/status', '/api/accounts', '/api/auth/me', '/api/packages', '/api/dns/zones', '/api/security/hulk/settings', '/api/clusters/config/export/', '/api/clusters/config/export']) {
        const r = await as('get', p).expect(403);
        expect(r.body.error.code).toBe('scope_confined');
      }
      await as('post', '/api/accounts', { username: 'pwned', domain: 'pwned.example.com', password: 'Pwned-Passw0rd!1' }).expect(403);
      await as('post', '/api/auth/password', { newPassword: 'Changed-Passw0rd!1' }).expect(403);
      await as('delete', '/api/clusters/config/export').expect(403);
      await as('post', '/api/clusters/ping').expect(403);
      // Outside the confinement the token is nobody: the refused mutation is
      // audited without a principal, while a peer push inside it is root's.
      expect(app.ctx.db.prepare("SELECT principal FROM audit_log WHERE action = 'POST /api/accounts' ORDER BY id DESC LIMIT 1").get()).toEqual({ principal: null });
      await as('post', '/api/clusters/dns/receive', {}).expect(422);
      expect(app.ctx.db.prepare("SELECT principal FROM audit_log WHERE action = 'POST /api/clusters/dns/receive' ORDER BY id DESC LIMIT 1").get()).toEqual({ principal: 'root' });
      // Public mounts answer a confined token as they answer anyone.
      await as('get', '/api/branding').expect(200);
      // A zone token never pushes settings; a settings token never pushes zones.
      expect((await as('post', '/api/clusters/config/receive', { settings: { 'dns.default_ttl': 1 } }).expect(403)).body.error.code).toBe('scope_confined');
      expect((await as('post', '/api/clusters/dns/receive', { domain: 'x.example.com', body: ZONE('x.example.com') }, configSecret).expect(403)).body.error.code).toBe('scope_confined');
      expect((await as('post', '/api/dns/zones/import', { domain: 'x.example.com', body: ZONE('x.example.com') }, configSecret).expect(403)).body.error.code).toBe('scope_confined');
      expect(app.ctx.dns.zoneExists('x.example.com')).toBe(false);
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('pwned').n).toBe(0);
      for (const [token, scope] of [[secret, 'clustering:dns'], [configSecret, 'clustering:config']]) {
        for (const { method, path } of CLUSTER_TOKEN_ROUTES[scope]) {
          const r = await as(method.toLowerCase(), path, method === 'POST' ? {} : undefined, token);
          expect(r.status, `${method} ${path}`).not.toBe(403);
          expect(r.status, `${method} ${path}`).not.toBe(401);
        }
      }
      // An unscoped root token is not confined, and a token mixing in a scope
      // the registry does not know keeps the per-route scope rules.
      const plain = `whm_${app.ctx.crypto.randomToken(32)}`;
      const insert = app.ctx.db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scopes, prefix) VALUES ((SELECT id FROM users WHERE username = 'root'), ?, ?, ?, ?)");
      insert.run('plain', app.ctx.crypto.hashToken(plain), '[]', plain.slice(0, 12));
      await request(app.ctx.app).get('/api/system/status').set('Authorization', `Bearer ${plain}`).expect(200);
      await request(app.ctx.app).get('/api/clusters/ping').set('Authorization', `Bearer ${plain}`).expect(200);
      await request(app.ctx.app).get('/api/clusters/peers').set('Authorization', `Bearer ${plain}`).expect(200);
      const mixed = `whm_${app.ctx.crypto.randomToken(32)}`;
      insert.run('mixed', app.ctx.crypto.hashToken(mixed), JSON.stringify(['clustering:dns', 'development:read']), mixed.slice(0, 12));
      await request(app.ctx.app).get('/api/clusters/ping').set('Authorization', `Bearer ${mixed}`).expect(200);
      await request(app.ctx.app).get('/api/clusters/peers').set('Authorization', `Bearer ${mixed}`).expect(403);
      await request(app.ctx.app).get('/api/clusters/config/export').set('Authorization', `Bearer ${mixed}`).expect(403);
      app.ctx.db.prepare("DELETE FROM api_tokens WHERE name IN ('plain', 'mixed')").run();
      expect((await get('/tokens').expect(200)).body.data).toHaveLength(2);
    });

    // Tokens issued before the purpose split carry the bare scope: they keep
    // pushing zones and nothing else, and the list says they are old.
    it('keeps a legacy "clustering" token working for zones only and flags it', async () => {
      const legacy = `whm_${app.ctx.crypto.randomToken(32)}`;
      app.ctx.db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scopes, prefix) VALUES ((SELECT id FROM users WHERE username = 'root'), ?, ?, ?, ?)").run('old slave', app.ctx.crypto.hashToken(legacy), JSON.stringify([LEGACY_CLUSTER_SCOPE]), legacy.slice(0, 12));
      const as = (method, path, body) => request(app.ctx.app)[method](path).set('Authorization', `Bearer ${legacy}`).send(body);
      await as('get', '/api/clusters/ping').expect(200);
      expect((await as('post', '/api/clusters/dns/receive', { domain: 'legacy.example.com', body: ZONE('legacy.example.com'), serial: 7 }).expect(200)).body.data.domain).toBe('legacy.example.com');
      expect((await as('get', '/api/clusters/config/export').expect(403)).body.error.code).toBe('scope_confined');
      expect((await as('post', '/api/clusters/config/receive', { settings: { 'dns.default_ttl': 1 } }).expect(403)).body.error.code).toBe('scope_confined');
      const listed = (await get('/tokens?purpose=dns').expect(200)).body.data.find((t) => t.name === 'old slave');
      expect(listed).toMatchObject({ legacy: true, purpose: 'dns', scopes: ['clustering'], allowed: tokenAllowed('clustering:dns') });
      expect((await get('/tokens?purpose=config').expect(200)).body.data.map((t) => t.name)).not.toContain('old slave');
      await del(`/tokens/${listed.id}`).expect(200);
      await as('get', '/api/clusters/ping').expect(401);
    });

    it('answers ping and export to a peer holding the right token, without CSRF', async () => {
      const ping = await asPeer('get', '/ping').expect(200);
      expect(ping.body.data).toMatchObject({ hostname: expect.any(String), accepts: { dns: true, config: false }, groups: GROUP_NAMES, sharedGroups: DEFAULT_GROUPS });
      const exported = await asConfigPeer('get', '/config/export?groups=dns,tweak').expect(200);
      expect(exported.body.data.groups).toEqual(['dns', 'tweak']);
      expect(exported.body.data.settings['dns.default_ttl']).toBe(14400);
      expect(Object.keys(exported.body.data.settings).every((k) => k.startsWith('dns.') || k.startsWith('tweak.'))).toBe(true);
      expect(exported.body.data.settings).not.toHaveProperty('dns.cluster_verify_tls');
      await request(app.ctx.app).get('/api/clusters/config/export').set('Authorization', 'Bearer whm_nope').expect(401);
    });

    // Out of the box a token holder can push nothing: pushes are opt-in, and
    // once on, only the groups this server itself shares are taken.
    it('refuses configuration pushes until the operator opts in, and then only for shared groups', async () => {
      expect(app.ctx.db.prepare("SELECT value FROM settings WHERE key = 'clusters.config.accept_pushes'").get().value).toBe('false');
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'clusters.config.groups'").get().n).toBe(0);
      const overview = await get('/config').expect(200);
      expect(overview.body.data.settings).toMatchObject({ acceptPushes: false, groups: DEFAULT_GROUPS });
      expect(overview.body.data.selectedGroups).not.toContain('security');
      expect(overview.body.data.selectedGroups).not.toContain('software');
      const before = { ttl: app.ctx.settings.get('dns.default_ttl'), twofa: app.ctx.settings.get('security.2fa.required_for_root'), tier: app.ctx.settings.get('updates.tier') };
      const refused = await asConfigPeer('post', '/config/receive', { source: 'ns1.example.com', settings: { 'dns.default_ttl': 3600 } }).expect(403);
      expect(refused.body.error.message).toMatch(/does not accept configuration pushes/);
      expect(app.ctx.settings.get('dns.default_ttl')).toBe(before.ttl);
      await put('/config/settings', { acceptPushes: true }).expect(200);
      // A push touching a group this server has not selected is refused as a whole.
      const unshared = await asConfigPeer('post', '/config/receive', { source: 'ns1.example.com', groups: ['dns', 'security', 'software'], settings: { 'dns.default_ttl': 3600, 'security.2fa.required_for_root': false, 'security.policy.verified_ip_login': false, 'updates.tier': 'edge' } }).expect(422);
      expect(unshared.body.error.code).toBe('group_not_shared');
      expect(unshared.body.error.message).toMatch(/does not share the security, software groups/);
      expect(unshared.body.error.fields.groups).toEqual(['security: not shared on this server', 'software: not shared on this server']);
      expect(app.ctx.settings.get('dns.default_ttl')).toBe(before.ttl);
      expect(app.ctx.settings.get('security.2fa.required_for_root')).toBe(before.twofa);
      expect(app.ctx.settings.get('updates.tier')).toBe(before.tier);
      const ev = app.ctx.db.prepare("SELECT * FROM cluster_events WHERE kind = 'config.receive' ORDER BY id DESC").get();
      expect(ev).toMatchObject({ status: 'skipped', source: 'ns1.example.com', message: expect.stringMatching(/security, software groups are not shared/) });
      expect(JSON.parse(ev.details_json)).toMatchObject({ unshared: ['security', 'software'] });
      expect(JSON.stringify(app.ctx.db.prepare('SELECT args_redacted FROM audit_log').all())).not.toContain('"updates.tier":"edge"');
      // diff() itself refuses such keys too, whatever the caller.
      const diff = app.ctx.clusters.config.diff({ 'security.cphulk.enabled': false, 'dns.default_ttl': 3600 });
      expect(diff.rejected).toEqual(['security.cphulk.enabled']);
      expect(diff.rejections['security.cphulk.enabled']).toMatch(/^group_not_shared/);
      // Pulling a group this server does not share is refused before the peer is contacted.
      const n = peer.received.length;
      const pull = await post('/config/pull', { clusterId: peerId, groups: ['security'] }).expect(422);
      expect(pull.body.error.code).toBe('group_not_shared');
      expect(peer.received.length).toBe(n);
      // The rest of the suite shares everything.
      await put('/config/settings', { groups: GROUP_NAMES }).expect(200);
      expect((await asPeer('get', '/ping').expect(200)).body.data).toMatchObject({ accepts: { config: true }, sharedGroups: GROUP_NAMES });
    });

    it('receives a configuration push, applying only pushable keys', async () => {
      const asPeer = asConfigPeer;
      const res = await asPeer('post', '/config/receive', { source: 'ns1.example.com', settings: { 'dns.default_ttl': 3600, 'tweak.max_emails_per_hour': 250, 'basic.hostname': 'evil.example.com', 'contacts.smtp.password': 'x', 'news.html': '<b>hi</b>', 'dns.soa_retry': 1800 } }).expect(200);
      expect(res.body.data).toMatchObject({ applied: ['dns.default_ttl', 'tweak.max_emails_per_hour'], failed: [], rejected: ['basic.hostname', 'contacts.smtp.password', 'news.html'], unchanged: 1 });
      expect(res.body.data.rejections).toEqual({ 'basic.hostname': 'not a shared setting', 'contacts.smtp.password': 'not a shared setting', 'news.html': 'not a shared setting' });
      expect(res.body.data.results['dns.default_ttl']).toMatchObject({ status: 'applied', stored: true, via: null });
      expect(app.ctx.settings.get('dns.default_ttl')).toBe(3600);
      expect(app.ctx.settings.get('basic.hostname')).not.toBe('evil.example.com');
      expect(auditCount('clusters.config.receive')).toBe(1);
      const ev = app.ctx.db.prepare("SELECT * FROM cluster_events WHERE kind = 'config.receive' AND status = 'ok'").get();
      expect(ev).toMatchObject({ direction: 'in', source: 'ns1.example.com', status: 'ok' });
      await put('/config/settings', { acceptPushes: false }).expect(200);
      await asPeer('post', '/config/receive', { settings: { 'dns.default_ttl': 1 } }).expect(403);
      await put('/config/settings', { acceptPushes: true }).expect(200);
    });

    it('refuses wrong-typed values, unknown keys under a shared prefix and host-state keys', async () => {
      const asPeer = asConfigPeer;
      const before = { timeout: app.ctx.settings.get('security.policy.session_timeout_minutes'), ports: app.ctx.settings.get('service_config.apache_ports'), outbound: app.ctx.settings.get('mail.outbound.ipv4'), home: app.ctx.settings.get('basic.home_root') };
      const res = await asPeer('post', '/config/receive', { settings: {
        'security.policy.session_timeout_minutes': 'abc', 'service_config.apache_ports': { http: 80, https: 443, bind: '10.9.9.9' }, 'tweak.max_emails_per_hour': {}, 'dns.bogus_new_key': 1, 'dns.default_ttl': 3600,
        'mail.outbound.ipv4': '10.9.9.9', 'basic.main_ipv6': '2001:db8::1', 'basic.home_root': '/home/../etc', 'backup.local_dir': '/tmp/x', 'service_config.nameserver': { server: 'powerdns', role: 'master' }, 'service_config.ftp_server': 'vsftpd', 'service_config.apache_updated_at': '2020-01-01', 'backup.schedule': 'rm -rf /',
      } }).expect(200);
      expect(res.body.data.applied).toEqual([]);
      expect(res.body.data.unchanged).toBe(1);
      expect(res.body.data.rejected.sort()).toEqual(['backup.local_dir', 'backup.schedule', 'basic.home_root', 'basic.main_ipv6', 'dns.bogus_new_key', 'mail.outbound.ipv4', 'security.policy.session_timeout_minutes', 'service_config.apache_ports', 'service_config.apache_updated_at', 'service_config.ftp_server', 'service_config.nameserver', 'tweak.max_emails_per_hour']);
      expect(res.body.data.rejections['security.policy.session_timeout_minutes']).toMatch(/number/i);
      expect(res.body.data.rejections['dns.bogus_new_key']).toBe('not a shared setting');
      expect(res.body.data.rejections['basic.home_root']).toMatch(/absolute|\.\./i);
      expect(app.ctx.settings.get('security.policy.session_timeout_minutes')).toBe(before.timeout);
      expect(app.ctx.settings.get('service_config.apache_ports')).toEqual(before.ports);
      expect(app.ctx.settings.get('mail.outbound.ipv4')).toBe(before.outbound);
      expect(app.ctx.settings.get('basic.home_root')).toBe(before.home);
      expect(app.ctx.settings.get('dns.bogus_new_key')).toBeUndefined();
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'dns.bogus_new_key'").get().n).toBe(0);
      // Pushing an unknown field inside a shared object is refused as a whole, so the known fields are not half-applied.
      const partial = await asPeer('post', '/config/receive', { settings: { 'service_config.apache': { timeout: 42, newDirective: 'x' } } }).expect(200);
      expect(partial.body.data.rejected).toEqual(['service_config.apache']);
      expect(app.ctx.settings.get('service_config.apache').timeout).toBe(300);
      // Apache directives are code, not a setting: a peer cannot write them here.
      const code = await asPeer('post', '/config/receive', { settings: { 'service_config.apache': { timeout: 42, customDirectives: 'Include /etc/shadow' } } }).expect(200);
      expect(code.body.data.rejected).toEqual(['service_config.apache']);
      expect(code.body.data.rejections['service_config.apache']).toMatch(/customDirectives|Unrecognized/i);
      expect(app.ctx.settings.get('service_config.apache').timeout).toBe(300);
      expect(app.ctx.settings.get('service_config.apache').customDirectives ?? '').not.toContain('shadow');
      expect(JSON.stringify((await asConfigPeer('get', '/config/export?groups=service_config').expect(200)).body)).not.toContain('customDirectives');
    });

    it('routes accepted keys through the owning services and reports what reached the host', async () => {
      const asPeer = asConfigPeer;
      app.ctx.agent.reset();
      app.ctx.agent.set('ssl.acme.detect', { certbot: false, acmeSh: null, providers: [], provider: null });
      const res = await asPeer('post', '/config/receive', { source: 'ns1.example.com', settings: {
        'service_config.apache': { timeout: 42, keepAlive: false, mpm: { module: 'event', minSpareThreads: 10, maxSpareThreads: 20 } },
        'security.cphulk.lockout_minutes': 45, 'security.cphulk.max_failures_per_ip': 9,
        'ssl.autossl.provider': 'certbot',
        'php.default_version': 'ea-php74',
        'backup.retention_daily': 9, 'backup.schedule': '15 3 * * *',
        'system_health.bpk.signal': 'SIGTERM',
        'contacts.check.ssl_days': 21,
      } }).expect(200);
      const { results } = res.body.data;
      // Apache is not installed on the mock host: the owner saved the value and reported the missing daemon.
      expect(results['service_config.apache']).toMatchObject({ status: 'stored', stored: true, via: 'apache', note: expect.stringMatching(/Apache is not installed/) });
      expect(app.ctx.settings.get('service_config.apache')).toMatchObject({ timeout: 42, keepAlive: false, serverTokens: 'Prod', mpm: expect.objectContaining({ module: 'event', minSpareThreads: 10, maxSpareThreads: 20, startServers: 2 }) });
      expect(auditCount('apache.config.update')).toBe(1);
      // Brute-force settings are read live from the database.
      expect(results['security.cphulk.lockout_minutes']).toMatchObject({ status: 'applied', stored: true, via: 'cphulk' });
      expect(app.ctx.security.cphulk.settings()).toMatchObject({ lockoutMinutes: 45, maxFailuresPerIp: 9 });
      // AutoSSL refuses a provider that is not installed here and stores nothing.
      expect(results['ssl.autossl.provider']).toMatchObject({ status: 'failed', stored: false, via: 'autossl', note: expect.stringMatching(/certbot/) });
      expect(app.ctx.settings.get('ssl.autossl.provider')).toBe('disabled');
      // A PHP version this host does not have is refused by Software.
      expect(results['php.default_version']).toMatchObject({ status: 'failed', stored: false, via: 'phpDefault' });
      expect(app.ctx.settings.get('php.default_version')).toBe('ea-php83');
      // Backup rewrote its schedule row; system health and contacts stored their policy.
      expect(results['backup.schedule']).toMatchObject({ status: 'applied', via: 'backup' });
      expect(app.ctx.scheduler.list().find((x) => x.name === 'backup-run').cron).toBe('15 3 * * *');
      expect(results['system_health.bpk.signal']).toMatchObject({ status: 'applied', via: 'bpk' });
      expect(app.ctx.settings.get('system_health.bpk.signal')).toBe('SIGTERM');
      expect(results['contacts.check.ssl_days']).toMatchObject({ status: 'applied', via: 'contacts' });
      expect(res.body.data.failed.sort()).toEqual(['php.default_version', 'ssl.autossl.provider']);
      expect(res.body.data.applied).toEqual(expect.arrayContaining(['service_config.apache', 'security.cphulk.lockout_minutes', 'backup.schedule']));
      expect(res.body.data.applied).not.toContain('ssl.autossl.provider');
      const ev = app.ctx.db.prepare("SELECT * FROM cluster_events WHERE kind = 'config.receive' ORDER BY id DESC").get();
      expect(ev.status).toBe('failed');
      expect(JSON.parse(ev.details_json).results['service_config.apache'].status).toBe('stored');
      // The same push again changes nothing more.
      const again = await asPeer('post', '/config/receive', { settings: { 'service_config.apache': { timeout: 42, keepAlive: false, mpm: { module: 'event', minSpareThreads: 10, maxSpareThreads: 20 } }, 'security.cphulk.lockout_minutes': 45 } }).expect(200);
      expect(again.body.data).toMatchObject({ applied: [], unchanged: 2 });
    });

    it('replicates branding, themes, support and the market catalogue through their owners', async () => {
      const res = await asConfigPeer('post', '/config/receive', { source: 'ns1.example.com', settings: {
        'branding.company_name': 'Acme Hosting', 'branding.primary_color': '#336699', 'branding.login_notice': 'Authorised staff only', 'branding.help_url': 'https://help.acme.example/',
        'themes.default': 'jupiter', 'themes.allow_user_override': false, 'themes.account_default': 'no-such-theme',
        'support.provider_name': 'Acme Support', 'support.portal_url': 'https://support.acme.example/', 'support.access.default_hours': 12,
        'market.providers': [{ name: 'cpstore', displayName: 'Acme Store', commissionPercent: 15, products: [{ id: 'dv', name: 'DV cert', price: 12.5, basePrice: 10, currency: 'USD', termMonths: 12 }] }],
        'branding.logo': { file: '/etc/passwd' },
      } }).expect(200);
      const { results } = res.body.data;
      expect(res.body.data.rejected).toEqual(['branding.logo']);
      for (const k of ['branding.company_name', 'branding.primary_color', 'branding.login_notice', 'branding.help_url']) expect(results[k], k).toMatchObject({ status: 'applied', via: 'branding' });
      expect(app.ctx.cpanel.branding.get()).toMatchObject({ companyName: 'Acme Hosting', primaryColor: '#336699', loginNotice: 'Authorised staff only', helpUrl: 'https://help.acme.example/' });
      expect(auditCount('branding.update')).toBe(1);
      // Themes validates slugs against what is installed here: the unknown one fails the whole themes patch and nothing of it sticks.
      expect(results['themes.account_default']).toMatchObject({ status: 'failed', via: 'themes', note: expect.stringMatching(/no-such-theme/) });
      expect(app.ctx.settings.get('themes.allow_user_override')).toBe(true);
      expect(results['support.provider_name']).toMatchObject({ status: 'applied', via: 'support' });
      expect(app.ctx.support.settings()).toMatchObject({ providerName: 'Acme Support', portalUrl: 'https://support.acme.example/', access: { defaultHours: 12 } });
      expect(results['market.providers']).toMatchObject({ status: 'applied', via: 'market' });
      const store = app.ctx.market.sslProviders().find((p) => p.name === 'cpstore');
      expect(store).toMatchObject({ displayName: 'Acme Store', commissionPercent: 15, enabled: false });
      expect(store.products).toEqual([expect.objectContaining({ id: 'dv', name: 'DV cert', basePrice: 10, price: 11.5 })]);
      // A provider this host does not have is reported, not created (its adapter and credentials never travel).
      const unknown = await asConfigPeer('post', '/config/receive', { settings: { 'market.providers': [{ name: 'otherstore', displayName: 'Other', adapter: 'generic', url: 'https://other.example.com', products: [] }] } }).expect(200);
      expect(unknown.body.data.results['market.providers']).toMatchObject({ status: 'failed', via: 'market', note: expect.stringMatching(/otherstore/) });
      expect(app.ctx.market.sslProviders().map((p) => p.name)).not.toContain('otherstore');
      // Exported alongside the rest; file descriptors stay local.
      const exported = await asConfigPeer('get', '/config/export?groups=branding').expect(200);
      expect(exported.body.data.settings).toMatchObject({ 'branding.company_name': 'Acme Hosting', 'themes.default': 'jupiter', 'support.provider_name': 'Acme Support' });
      expect(exported.body.data.settings).not.toHaveProperty('branding.logo');
      expect(exported.body.data.settings).not.toHaveProperty('branding.favicon');
      expect(Array.isArray(exported.body.data.settings['market.providers'])).toBe(true);
    });

    it('serves no URL credentials to a peer and refuses to receive them', async () => {
      const asPeer = asConfigPeer;
      const SECRET_URL = 'https://feeduser:feedpass@updates.example.com/feed.json';
      const before = app.ctx.settings.get('software.update_url');
      app.ctx.settings.set('software.update_url', SECRET_URL);
      app.ctx.settings.set('mail.country_filter.source_url', SECRET_URL);
      try {
        const exported = await asPeer('get', '/config/export?groups=software,mail').expect(200);
        expect(exported.body.data.settings).not.toHaveProperty('software.update_url');
        expect(exported.body.data.settings).not.toHaveProperty('mail.country_filter.source_url');
        expect(exported.body.data.settings['updates.tier']).toBeDefined();
        expect(JSON.stringify(exported.body)).not.toContain('feedpass');
        const received = await asPeer('post', '/config/receive', { source: 'ns1.example.com', settings: { 'software.update_url': 'https://other:pw@mirror.example.com/feed.json', 'mail.country_filter.source_url': 'https://x:y@h.example.com/' } }).expect(200);
        expect(received.body.data.rejected.sort()).toEqual(['mail.country_filter.source_url', 'software.update_url']);
        expect(received.body.data.rejections['software.update_url']).toMatch(/credentials/i);
        expect(app.ctx.settings.get('software.update_url')).toBe(SECRET_URL);
        expect(JSON.stringify(received.body)).not.toContain('other:pw');
        // A plain URL is shared like any other setting.
        app.ctx.settings.set('software.update_url', 'https://updates.example.com/feed.json');
        expect((await asPeer('get', '/config/export?groups=software').expect(200)).body.data.settings['software.update_url']).toBe('https://updates.example.com/feed.json');
        const rows = app.ctx.db.prepare('SELECT details_json, message FROM cluster_events').all();
        expect(JSON.stringify(rows)).not.toMatch(/feedpass|other:pw|x:y@/);
        expect(JSON.stringify(app.ctx.db.prepare('SELECT args_redacted FROM audit_log').all())).not.toMatch(/feedpass|other:pw|x:y@/);
      } finally {
        app.ctx.settings.set('software.update_url', before);
        app.ctx.settings.set('mail.country_filter.source_url', '');
      }
    });

    it('receives a DNS zone pushed by a master and logs it', async () => {
      const res = await asPeer('post', '/dns/receive', { domain: 'peerzone.net', body: ZONE('peerzone.net'), serial: 7, source: 'ns1.example.com' }).expect(200);
      expect(res.body.data).toMatchObject({ domain: 'peerzone.net', serial: 7 });
      expect(app.ctx.dns.zoneExists('peerzone.net')).toBe(true);
      await asPeer('post', '/dns/receive', { domain: 'peerzone.net', body: 'garbage', source: 'ns1.example.com' }).expect(422);
      const events = await get('/events?kind=dns.receive').expect(200);
      expect(events.body.data.slice(0, 2).map((e) => e.status)).toEqual(['failed', 'ok']);
      expect(events.body.data[1].message).toBe('peerzone.net serial 7');
      await put('/dns/settings', { acceptPushes: false }).expect(200);
      await asPeer('post', '/dns/receive', { domain: 'peerzone.net', body: ZONE('peerzone.net', 8) }).expect(403);
      await put('/dns/settings', { acceptPushes: true }).expect(200);
    });

    it('enforces "accept pushes" on the DNS module\'s import endpoint that peers actually use, and logs what gets through', async () => {
      const importZone = (body) => request(app.ctx.app).post('/api/dns/zones/import').set('Authorization', `Bearer ${secret}`).send(body);
      const dnsEvents = () => app.ctx.db.prepare("SELECT * FROM cluster_events WHERE kind = 'dns.receive' ORDER BY id DESC").all();
      await put('/dns/settings', { acceptPushes: false }).expect(200);
      const refused = await importZone({ domain: 'peerzone.net', body: ZONE('peerzone.net', 9), serial: 9 }).expect(403);
      expect(refused.body.error.message).toMatch(/does not accept DNS pushes/);
      expect((await app.ctx.dns.getZone('peerzone.net', { role: 'root' })).serial).toBe(7);
      expect(dnsEvents()[0]).toMatchObject({ status: 'skipped', message: expect.stringMatching(/peerzone\.net: refused/) });
      // A root session importing by hand is not a peer push, and is not logged as one.
      const n = dnsEvents().length;
      await app.http.post('/api/dns/zones/import').set('X-CSRF-Token', csrf).send({ domain: 'peerzone.net', body: ZONE('peerzone.net', 9), serial: 9 }).expect(200);
      expect(dnsEvents()).toHaveLength(n);
      await put('/dns/settings', { acceptPushes: true }).expect(200);
      await importZone({ domain: 'peerzone.net', body: ZONE('peerzone.net', 10), serial: 10 }).expect(200);
      expect((await app.ctx.dns.getZone('peerzone.net', { role: 'root' })).serial).toBeGreaterThanOrEqual(10);
      expect(app.ctx.clusters.acceptsDnsPushes()).toBe(true);
      // The exchange log shows the zones that arrived through the DNS module's route, once each, and what failed.
      await new Promise((r) => setImmediate(r));
      expect(dnsEvents()).toHaveLength(n + 1);
      expect(dnsEvents()[0]).toMatchObject({ direction: 'in', status: 'ok', message: 'peerzone.net serial 10 (zone import)' });
      expect(JSON.parse(dnsEvents()[0].details_json)).toMatchObject({ domain: 'peerzone.net', serial: 10, path: '/api/dns/zones/import', status: 200 });
      await importZone({ domain: 'peerzone.net', body: 'garbage', serial: 11 }).expect(422);
      await new Promise((r) => setImmediate(r));
      expect(dnsEvents()[0]).toMatchObject({ status: 'failed', message: expect.stringMatching(/peerzone\.net: import answered HTTP 422/) });
      expect((await get('/events?kind=dns.receive&status=ok').expect(200)).body.data.map((e) => e.message)).toContain('peerzone.net serial 10 (zone import)');
    });

    it('revokes the tokens so the peers are locked out', async () => {
      await del(`/tokens/${tokenId}`).expect(200);
      await asPeer('get', '/ping').expect(401);
      await del(`/tokens/${tokenId}`).expect(404);
      await del(`/tokens/${configTokenId}`).expect(200);
      await asConfigPeer('get', '/ping').expect(401);
      expect((await get('/tokens').expect(200)).body.data).toEqual([]);
    });
  });

  describe('DNS Cluster', () => {
    it('shows peers, the schedule and settings, and toggles them', async () => {
      const res = await get('/dns').expect(200);
      expect(res.body.data).toMatchObject({ dnsModule: true, roles: ['write-only', 'sync', 'standalone'], settings: { verifyTls: true, autoSync: true, acceptPushes: true }, schedule: { name: 'dns-cluster-sync', enabled: true } });
      expect(res.body.data.peers).toEqual([expect.objectContaining({ id: peerId })]);
      const off = await put('/dns/settings', { autoSync: false, verifyTls: false }).expect(200);
      expect(off.body.data).toMatchObject({ autoSync: false, verifyTls: false });
      expect(app.ctx.scheduler.list().find((s) => s.name === 'dns-cluster-sync').enabled).toBe(0);
      expect(app.ctx.settings.get('dns.cluster_verify_tls')).toBe(false);
      await put('/dns/settings', { autoSync: true }).expect(200);
      expect(auditCount('clusters.dns.settings')).toBe(6);
    });

    it('synchronises through the DNS module job and refuses standalone or disabled peers', async () => {
      app.ctx.jobs.start();
      try {
        const res = await post('/dns/sync', { clusterId: peerId, domains: ['peerzone.net'] }).expect(202);
        const job = await waitForJob(app.ctx, res.body.data.job.id, 20000);
        expect(job.status).toBe('done');
        expect(job.result).toMatchObject({ peers: 1, zones: 1 });
        // The fake peer has no /api/dns/zones/import, so the push is recorded as failed.
        expect(peer.received.at(-1)).toMatchObject({ method: 'POST', url: '/api/dns/zones/import', body: expect.objectContaining({ domain: 'peerzone.net' }) });
        expect((await get('/dns').expect(200)).body.data.zones).toEqual([expect.objectContaining({ domain: 'peerzone.net', status: 'failed' })]);
      } finally { app.ctx.jobs.stop(); }
      await patch(`/peers/${peerId}`, { role: 'standalone' }).expect(200);
      await post('/dns/sync', { clusterId: peerId }).expect(422);
      await patch(`/peers/${peerId}`, { role: 'sync', enabled: false }).expect(200);
      await post('/dns/sync', { clusterId: peerId }).expect(422);
      await patch(`/peers/${peerId}`, { enabled: true }).expect(200);
      await post('/dns/sync', { clusterId: 9999 }).expect(404);
    });

    it('degrades to 501 when the DNS module is absent', async () => {
      const original = app.ctx.dns;
      app.ctx.dns = undefined;
      try {
        const res = await post('/dns/sync', {}).expect(501);
        expect(res.body.error.code).toBe('capability_missing');
        const overview = await get('/dns').expect(200);
        expect(overview.body.data).toMatchObject({ dnsModule: false, zones: [] });
        await post('/dns/receive', { domain: 'peerzone.net', body: ZONE('peerzone.net') }).expect(501);
      } finally { app.ctx.dns = original; }
      // Without the schedule, a settings request that includes autoSync is refused before anything is written.
      const schedule = app.ctx.scheduler.list().find((x) => x.name === 'dns-cluster-sync');
      app.ctx.scheduler.remove('dns-cluster-sync');
      try {
        const verify = app.ctx.settings.get('dns.cluster_verify_tls');
        const audits = auditCount('clusters.dns.settings');
        const res = await put('/dns/settings', { autoSync: true, verifyTls: !verify, acceptPushes: false }).expect(501);
        expect(res.body.error.code).toBe('capability_missing');
        expect(app.ctx.settings.get('dns.cluster_verify_tls')).toBe(verify);
        expect(app.ctx.clusters.acceptsDnsPushes()).toBe(true);
        expect(auditCount('clusters.dns.settings')).toBe(audits);
      } finally {
        app.ctx.scheduler.ensure(schedule.name, schedule.cron, schedule.job_type, schedule.params);
        app.ctx.scheduler.update(schedule.name, { enabled: Boolean(schedule.enabled) });
      }
    });
  });

  describe('Configuration Cluster', () => {
    it('lists groups with key counts and saves the selection', async () => {
      const res = await get('/config').expect(200);
      expect(res.body.data.groups.map((g) => g.name)).toEqual(GROUP_NAMES);
      const dnsGroup = res.body.data.groups.find((g) => g.name === 'dns');
      expect(dnsGroup.keyCount).toBeGreaterThan(3);
      expect(dnsGroup.keys).toContain('dns.default_ttl');
      expect(dnsGroup.keys).not.toContain('dns.resolvers');
      expect(res.body.data).toMatchObject({ settings: { autoPush: false, acceptPushes: true }, schedule: { name: 'config-cluster-push', enabled: false } });
      expect(res.body.data.keyCount).toBeGreaterThan(0);
      const saved = await put('/config/settings', { groups: ['dns', 'tweak'], autoPush: true }).expect(200);
      expect(saved.body.data).toMatchObject({ groups: ['dns', 'tweak'], autoPush: true });
      expect(app.ctx.scheduler.list().find((s) => s.name === 'config-cluster-push').enabled).toBe(1);
      await put('/config/settings', { autoPush: false }).expect(200);
      expect(app.ctx.scheduler.list().find((s) => s.name === 'config-cluster-push').enabled).toBe(0);
    });

    it('pushes the selected groups to configuration peers as a job', async () => {
      app.ctx.jobs.start();
      try {
        await patch(`/peers/${peerId}`, { configEnabled: false }).expect(200);
        await post('/config/push', {}).expect(422);
        await patch(`/peers/${peerId}`, { configEnabled: true }).expect(200);
        const res = await post('/config/push', { clusterIds: [peerId] }).expect(202);
        const job = await waitForJob(app.ctx, res.body.data.job.id, 20000);
        expect(job.status).toBe('done');
        expect(job.result).toMatchObject({ peers: 1, ok: 1, failed: 0, changed: 2, groups: ['dns', 'tweak'] });
        const sent = peer.received.at(-1);
        expect(sent).toMatchObject({ method: 'POST', url: '/api/clusters/config/receive', auth: `Bearer ${PEER_TOKEN}` });
        expect(sent.body.groups).toEqual(['dns', 'tweak']);
        expect(sent.body.settings['dns.default_ttl']).toBe(3600);
        expect(Object.keys(sent.body.settings).some((k) => k.startsWith('security.'))).toBe(false);
        expect(app.ctx.settings.get('clusters.config.last_push_at')).toBeTruthy();
        peer.state.status = 500;
        const failed = await waitForJob(app.ctx, (await post('/config/push', { groups: ['security'] }).expect(202)).body.data.job.id, 20000);
        expect(failed.result).toMatchObject({ ok: 0, failed: 1 });
        peer.state.status = 200;
        // A scheduled run with automatic pushes off does nothing.
        const skipped = await waitForJob(app.ctx, app.ctx.jobs.enqueue('clusters.config.push', {}, {}).id, 20000);
        expect(skipped.result).toEqual({ skipped: 'disabled' });
      } finally { app.ctx.jobs.stop(); }
      const events = await get('/events?kind=config.push').expect(200);
      expect(events.body.data.map((e) => e.status)).toEqual(['failed', 'ok']);
    });

    it('pulls from a peer: previews first, then applies allowed keys only', async () => {
      app.ctx.settings.set('tweak.max_emails_per_hour', 0);
      const preview = await post('/config/pull', { clusterId: peerId, groups: ['dns', 'tweak'] }).expect(200);
      expect(preview.body.data).toMatchObject({ applied: false, source: 'peer.example.com', rejected: ['basic.hostname', 'contacts.smtp.password'] });
      expect(preview.body.data.changes).toEqual([expect.objectContaining({ key: 'tweak.max_emails_per_hour', local: 0, remote: 250 })]);
      expect(peer.received.at(-1).url).toBe('/api/clusters/config/export?groups=dns%2Ctweak');
      expect(app.ctx.settings.get('tweak.max_emails_per_hour')).toBe(0);
      const applied = await post('/config/pull', { clusterId: peerId, apply: true }).expect(200);
      expect(applied.body.data.applied).toBe(true);
      expect(applied.body.data.results['tweak.max_emails_per_hour']).toMatchObject({ status: 'applied', stored: true });
      expect(applied.body.data.rejections).toEqual({ 'basic.hostname': 'not a shared setting', 'contacts.smtp.password': 'not a shared setting' });
      expect(app.ctx.settings.get('tweak.max_emails_per_hour')).toBe(250);
      expect(app.ctx.settings.get('basic.hostname')).not.toBe('peer.example.com');
      expect(auditCount('clusters.config.pull')).toBe(1);
      peer.state.token = 'rotated-away-0123456789';
      const rejected = await post('/config/pull', { clusterId: peerId }).expect(502);
      expect(rejected.body.error.code).toBe('peer_rejected');
      peer.state.token = PEER_TOKEN;
      await post('/config/pull', { clusterId: 9999 }).expect(404);
    });

    it('never pushes or previews a URL with embedded credentials', async () => {
      const SECRET_URL = 'https://feeduser:feedpass@updates.example.com/feed.json';
      const before = app.ctx.settings.get('software.update_url');
      app.ctx.settings.set('software.update_url', SECRET_URL);
      await put('/config/settings', { groups: ['dns', 'tweak', 'software'] }).expect(200);
      app.ctx.jobs.start();
      try {
        const job = await waitForJob(app.ctx, (await post('/config/push', { clusterIds: [peerId], groups: ['software'] }).expect(202)).body.data.job.id, 20000);
        expect(job.status).toBe('done');
        const sent = peer.received.at(-1);
        expect(sent.url).toBe('/api/clusters/config/receive');
        expect(sent.body.settings).not.toHaveProperty('software.update_url');
        expect(sent.body.settings['updates.tier']).toBeDefined();
        expect(JSON.stringify(sent.body)).not.toContain('feedpass');
      } finally { app.ctx.jobs.stop(); app.ctx.settings.set('software.update_url', before); }
      peer.state.exportSettings = { ...peer.state.exportSettings, 'software.update_url': 'https://other:pw@mirror.example.com/feed.json' };
      try {
        const preview = await post('/config/pull', { clusterId: peerId, groups: ['software'] }).expect(200);
        expect(preview.body.data.rejected).toContain('software.update_url');
        expect(preview.body.data.rejections['software.update_url']).toMatch(/credentials/i);
        expect(preview.body.data.changes.map((c) => c.key)).not.toContain('software.update_url');
        expect(JSON.stringify(preview.body)).not.toContain('other:pw');
        const applied = await post('/config/pull', { clusterId: peerId, groups: ['software'], apply: true }).expect(200);
        expect(JSON.stringify(applied.body)).not.toContain('other:pw');
        expect(app.ctx.settings.get('software.update_url')).toBe(before);
      } finally { delete peer.state.exportSettings['software.update_url']; await put('/config/settings', { groups: ['dns', 'tweak'] }).expect(200); }
      const rows = app.ctx.db.prepare('SELECT details_json, message FROM cluster_events').all();
      expect(JSON.stringify(rows)).not.toMatch(/feedpass|other:pw/);
      expect(JSON.stringify(app.ctx.db.prepare('SELECT args_redacted FROM audit_log').all())).not.toMatch(/feedpass|other:pw/);
    });

    it('reports an unreachable peer on pull', async () => {
      const dead = await post('/peers', { name: 'gone', host: 'http://127.0.0.1:1', token: PEER_TOKEN, configEnabled: true }).expect(201);
      const res = await post('/config/pull', { clusterId: dead.body.data.id }).expect(502);
      expect(res.body.error.code).toBe('peer_unreachable');
      expect(res.body.error.message).toMatch(/connection refused/);
      await del(`/peers/${dead.body.data.id}`).expect(200);
    });

    it('filters and pages the exchange log, treating LIKE wildcards in the search as text', async () => {
      const all = await get('/events?pageSize=5').expect(200);
      expect(all.body.data).toHaveLength(5);
      expect(all.body.meta.total).toBeGreaterThan(5);
      const failed = await get('/events?status=failed&kind=config.pull').expect(200);
      expect(failed.body.data.every((e) => e.status === 'failed' && e.kind === 'config.pull')).toBe(true);
      expect(failed.body.meta.total).toBe(2);
      app.ctx.clusters.events.record({ kind: 'peer.test', direction: 'out', source: 'test.example.com', status: 'ok', message: 'disk 100% full on peer_9' });
      expect((await get('/events?q=100%25').expect(200)).body.meta.total).toBe(1);
      expect((await get('/events?q=%25').expect(200)).body.meta.total).toBe(1);
      expect((await get('/events?q=peer_9').expect(200)).body.meta.total).toBe(1);
      expect((await get('/events?q=peer_').expect(200)).body.meta.total).toBe(1);
      expect((await get('/events?q=peerX9').expect(200)).body.meta.total).toBe(0);
    });

    // Retention runs from the push job as well as the pages, so a server
    // nobody opens still trims what chatty peers write.
    it('prunes the exchange log from the scheduled push job', async () => {
      app.ctx.db.prepare("INSERT INTO cluster_events (kind, direction, status, message, ts) VALUES ('config.export', 'out', 'ok', 'ancient', datetime('now', '-400 days'))").run();
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM cluster_events WHERE message = 'ancient'").get().n).toBe(1);
      app.ctx.jobs.start();
      try {
        const job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('clusters.config.push', {}, {}).id, 20000);
        expect(job.result).toEqual({ skipped: 'disabled' });
      } finally { app.ctx.jobs.stop(); }
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM cluster_events WHERE message = 'ancient'").get().n).toBe(0);
    });
  });
});
