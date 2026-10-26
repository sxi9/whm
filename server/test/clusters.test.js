import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { createTestApp, waitForJob } from './support/app.js';
import { parsePeerHost, groupOfKey, isPushableKey, PEER_HOST_RE, GROUP_NAMES, CONFIG_GROUPS } from '../src/services/clusters.js';

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
      await post('/tokens', { name: 'ok', expiresInDays: 0 }).expect(422);
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

    it('issues a clustering-scoped token for root exactly once', async () => {
      const res = await post('/tokens', { name: 'ns1 master', expiresInDays: 30 }).expect(201);
      secret = res.body.data.token;
      tokenId = res.body.data.id;
      expect(secret).toMatch(/^whm_[A-Za-z0-9_-]{30,}$/);
      expect(res.body.data).toMatchObject({ name: 'ns1 master', username: 'root', prefix: secret.slice(0, 12), expiresAt: expect.stringMatching(/Z$/) });
      const list = await get('/tokens').expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({ id: tokenId, name: 'ns1 master' })]);
      expect(JSON.stringify(list.body)).not.toContain(secret);
      const row = app.ctx.db.prepare('SELECT scopes, token_hash FROM api_tokens WHERE id = ?').get(tokenId);
      expect(JSON.parse(row.scopes)).toEqual(['clustering']);
      expect(row.token_hash).toBe(app.ctx.crypto.hashToken(secret));
    });

    it('answers ping and export to a peer holding the token, without CSRF', async () => {
      const ping = await asPeer('get', '/ping').expect(200);
      expect(ping.body.data).toMatchObject({ hostname: expect.any(String), accepts: { dns: true, config: true }, groups: GROUP_NAMES });
      const exported = await asPeer('get', '/config/export?groups=dns,tweak').expect(200);
      expect(exported.body.data.groups).toEqual(['dns', 'tweak']);
      expect(exported.body.data.settings['dns.default_ttl']).toBe(14400);
      expect(Object.keys(exported.body.data.settings).every((k) => k.startsWith('dns.') || k.startsWith('tweak.'))).toBe(true);
      expect(exported.body.data.settings).not.toHaveProperty('dns.cluster_verify_tls');
      await request(app.ctx.app).get('/api/clusters/config/export').set('Authorization', 'Bearer whm_nope').expect(401);
    });

    it('receives a configuration push, applying only pushable keys', async () => {
      const res = await asPeer('post', '/config/receive', { source: 'ns1.example.com', settings: { 'dns.default_ttl': 3600, 'tweak.max_emails_per_hour': 250, 'basic.hostname': 'evil.example.com', 'contacts.smtp.password': 'x', 'news.html': '<b>hi</b>', 'dns.soa_retry': 1800 } }).expect(200);
      expect(res.body.data).toMatchObject({ applied: ['dns.default_ttl', 'tweak.max_emails_per_hour'], rejected: ['basic.hostname', 'contacts.smtp.password', 'news.html'], unchanged: 1 });
      expect(app.ctx.settings.get('dns.default_ttl')).toBe(3600);
      expect(app.ctx.settings.get('basic.hostname')).not.toBe('evil.example.com');
      expect(auditCount('clusters.config.receive')).toBe(1);
      const ev = app.ctx.db.prepare("SELECT * FROM cluster_events WHERE kind = 'config.receive'").get();
      expect(ev).toMatchObject({ direction: 'in', source: 'ns1.example.com', status: 'ok' });
      await put('/config/settings', { acceptPushes: false }).expect(200);
      await asPeer('post', '/config/receive', { settings: { 'dns.default_ttl': 1 } }).expect(403);
      await put('/config/settings', { acceptPushes: true }).expect(200);
    });

    it('receives a DNS zone pushed by a master and logs it', async () => {
      const res = await asPeer('post', '/dns/receive', { domain: 'peerzone.net', body: ZONE('peerzone.net'), serial: 7, source: 'ns1.example.com' }).expect(200);
      expect(res.body.data).toMatchObject({ domain: 'peerzone.net', serial: 7 });
      expect(app.ctx.dns.zoneExists('peerzone.net')).toBe(true);
      await asPeer('post', '/dns/receive', { domain: 'peerzone.net', body: 'garbage', source: 'ns1.example.com' }).expect(422);
      const events = await get('/events?kind=dns.receive').expect(200);
      expect(events.body.data.map((e) => e.status)).toEqual(['failed', 'ok']);
      await put('/dns/settings', { acceptPushes: false }).expect(200);
      await asPeer('post', '/dns/receive', { domain: 'peerzone.net', body: ZONE('peerzone.net', 8) }).expect(403);
      await put('/dns/settings', { acceptPushes: true }).expect(200);
    });

    it('revokes the token so the peer is locked out', async () => {
      await del(`/tokens/${tokenId}`).expect(200);
      await asPeer('get', '/ping').expect(401);
      await del(`/tokens/${tokenId}`).expect(404);
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
      expect(auditCount('clusters.dns.settings')).toBe(4);
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
    });
  });

  describe('Configuration Cluster', () => {
    it('lists groups with key counts and saves the selection', async () => {
      const res = await get('/config').expect(200);
      expect(res.body.data.groups.map((g) => g.name)).toEqual(GROUP_NAMES);
      expect(res.body.data.groups.find((g) => g.name === 'dns').keys).toBeGreaterThan(3);
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
      expect(app.ctx.settings.get('tweak.max_emails_per_hour')).toBe(250);
      expect(app.ctx.settings.get('basic.hostname')).not.toBe('peer.example.com');
      expect(auditCount('clusters.config.pull')).toBe(1);
      peer.state.token = 'rotated-away-0123456789';
      const rejected = await post('/config/pull', { clusterId: peerId }).expect(502);
      expect(rejected.body.error.code).toBe('peer_rejected');
      peer.state.token = PEER_TOKEN;
      await post('/config/pull', { clusterId: 9999 }).expect(404);
    });

    it('reports an unreachable peer on pull', async () => {
      const dead = await post('/peers', { name: 'gone', host: 'http://127.0.0.1:1', token: PEER_TOKEN, configEnabled: true }).expect(201);
      const res = await post('/config/pull', { clusterId: dead.body.data.id }).expect(502);
      expect(res.body.error.code).toBe('peer_unreachable');
      expect(res.body.error.message).toMatch(/connection refused/);
      await del(`/peers/${dead.body.data.id}`).expect(200);
    });

    it('filters and pages the exchange log', async () => {
      const all = await get('/events?pageSize=5').expect(200);
      expect(all.body.data).toHaveLength(5);
      expect(all.body.meta.total).toBeGreaterThan(5);
      const failed = await get('/events?status=failed&kind=config.pull').expect(200);
      expect(failed.body.data.every((e) => e.status === 'failed' && e.kind === 'config.pull')).toBe(true);
      expect(failed.body.meta.total).toBe(2);
    });
  });
});
