import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----\n';
const inspected = (cn) => ({ commonName: cn, sans: [cn, `www.${cn}`], issuerText: 'CN=Test CA', subjectText: `CN=${cn}`, notBefore: '2026-01-01T00:00:00Z', notAfter: '2099-01-01T00:00:00Z', expired: false, selfSigned: false });

function sslAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['openssl', 'certbot'].includes(n)])),
    'ssl.bundle.list': () => ({ bundles: [] }),
    'ssl.bundle.read_for_domain': ({ domain }) => ({ exists: false, paths: { cert: `/etc/whm/ssl/${domain}/cert.pem` }, certPem: null, chainPem: null }),
    'ssl.acme.detect': () => ({ certbot: true, acmeSh: null, providers: ['certbot'], provider: 'certbot' }),
    'ssl.cert.inspect': () => inspected('alice.com'),
    'ssl.cert.verify_chain': () => ({ ok: true, output: '' }),
    'ssl.key.matches': () => ({ matches: true }),
    'ssl.key.inspect': () => ({ type: 'rsa', bits: 2048 }),
    'ssl.bundle.install_for_domain': ({ domain }) => ({ paths: { dir: `/etc/whm/ssl/${domain}`, cert: `/etc/whm/ssl/${domain}/cert.pem`, key: `/etc/whm/ssl/${domain}/key.pem`, fullchain: `/etc/whm/ssl/${domain}/fullchain.pem` } }),
    'ssl.bundle.remove_for_domain': () => ({ removed: true }),
    'ssl.key.generate': () => ({ keyPem: KEY, type: 'rsa', bits: 2048, curve: null }),
    'ssl.csr.generate': () => ({ csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nMIIC\n-----END CERTIFICATE REQUEST-----\n' }),
  });
}

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    get: (p) => http.get(`/api/panel${p}`),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

function setFeature(app, username, key, enabled) {
  const plan = JSON.parse(app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username).plan_snapshot_json || '{}');
  plan.features = { ...(plan.features || {}), [key]: enabled };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(plan), username);
}

describe('Customer panel: SSL', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  let bobCert;
  let aliceCert;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const names = () => app.agent.calls.map((c) => c.name);
  const accountId = (u) => row('SELECT id FROM accounts WHERE username = ?', u).id;

  beforeAll(async () => {
    app = await createTestApp({ agent: sslAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { dns: false, mail: false } }).expect(201);
    const insert = db().prepare('INSERT INTO ssl_certs (account_id, domain, cert_pem, key_enc, subject, issuer, not_after) VALUES (?, ?, ?, ?, ?, ?, ?)');
    bobCert = Number(insert.run(accountId('bob'), 'bob.com', CERT, app.ctx.crypto.encrypt(KEY), 'CN=bob.com', 'CN=Test CA', '2099-01-01T00:00:00Z').lastInsertRowid);
    aliceCert = Number(insert.run(accountId('alice'), 'alice.com', CERT, app.ctx.crypto.encrypt(KEY), 'CN=alice.com', 'CN=Test CA', '2099-01-01T00:00:00Z').lastInsertRowid);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('shows the status of the account\'s own hostnames', async () => {
    const res = await alice.get('/ssl/domains').expect(200);
    expect(res.body.data.domains.map((d) => d.domain)).toEqual(['alice.com']);
    expect(res.body.data.autossl).toMatchObject({ provider: 'disabled', enabled: false });
    expect(res.body.data.domains[0]).toHaveProperty('autossl');
    expect((await alice.get('/ssl/domains/bob.com')).status).toBe(404);
  });

  it('says plainly when an own hostname has no certificate installed', async () => {
    const res = await alice.get('/ssl/domains/alice.com');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found', message: 'No certificate is installed on alice.com' });
    expect(res.body.error.message).not.toMatch(/not found/);
    const foreign = await alice.get('/ssl/domains/bob.com');
    expect(foreign.body.error.message).toBe('Domain "bob.com" not found');
  });

  it('answers 501 for "issue now" while AutoSSL is disabled, then enqueues a never-forced job', async () => {
    const off = await alice.post('/ssl/domains/alice.com/issue', {});
    expect(off.status).toBe(501);
    expect(off.body.error.code).toBe('capability_missing');
    app.ctx.settings.set('ssl.autossl.provider', 'certbot');
    app.ctx.settings.set('ssl.autossl.email', 'admin@example.com');
    expect((await alice.post('/ssl/domains/bob.com/issue', {})).status).toBe(404);
    const res = await alice.post('/ssl/domains/alice.com/issue', {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const job = app.ctx.jobs.get(res.body.data.job.id);
    expect(job.type).toBe('ssl.autossl.run');
    expect(job.params).toMatchObject({ domain: 'alice.com', force: false, account: null });
    expect(row("SELECT * FROM audit_log WHERE action = 'panel.ssl.issue' AND target = 'alice'")).toBeTruthy();
    setFeature(app, 'alice', 'autossl', false);
    expect((await alice.post('/ssl/domains/alice.com/issue', {})).body.error.code).toBe('feature_disabled');
    setFeature(app, 'alice', 'autossl', true);
  });

  it('refuses a stored certificate of another account before openssl sees it', async () => {
    const res = await alice.post('/ssl/domains/alice.com/install', { certId: bobCert });
    expect(res.status).toBe(404);
    expect(names()).toEqual([]);
    const ownOnForeign = await alice.post('/ssl/domains/bob.com/install', { certId: aliceCert });
    expect(ownOnForeign.status).toBe(404);
    expect(names()).toEqual([]);
  });

  it('requires both PEM parts when no stored certificate is chosen', async () => {
    const res = await alice.post('/ssl/domains/alice.com/install', { certPem: CERT });
    expect(res.status).toBe(422);
    expect(names()).toEqual([]);
    expect((await alice.post('/ssl/domains/alice.com/install', { certPem: CERT, keyPem: KEY, force: true })).status).toBe(422);
  });

  it('installs an own stored certificate without force and uninstalls it', async () => {
    const res = await alice.post('/ssl/domains/alice.com/install', { certId: aliceCert });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.cert).toMatchObject({ domain: 'alice.com', accountId: accountId('alice') });
    expect(names()).toContain('ssl.bundle.install_for_domain');
    expect(row('SELECT installed FROM ssl_certs WHERE id = ?', aliceCert).installed).toBeGreaterThan(0);
    expect((await bob.del('/ssl/domains/alice.com')).status).toBe(404);
    const off = await alice.del('/ssl/domains/alice.com').expect(200);
    expect(off.body.data).toMatchObject({ domain: 'alice.com', removed: true });
    expect(row('SELECT installed FROM ssl_certs WHERE id = ?', aliceCert).installed).toBe(0);
  });

  it('lists and downloads only the account\'s own items and never the private key', async () => {
    const list = await alice.get('/ssl/certs').expect(200);
    expect(list.body.data.map((c) => c.id)).toEqual([aliceCert]);
    const storage = await alice.get('/ssl/certs/storage').expect(200);
    expect(storage.body.data.items.every((i) => i.id === aliceCert)).toBe(true);
    expect(storage.body.data.counts.key).toBe(1);
    const cert = await alice.get(`/ssl/certs/${aliceCert}/download?part=cert`).expect(200);
    expect(cert.body.data.content).toBe(CERT);
    expect((await alice.get(`/ssl/certs/${aliceCert}/download?part=key`)).status).toBe(422);
    expect((await alice.get(`/ssl/certs/${bobCert}/download?part=cert`)).status).toBe(404);
    expect((await alice.del(`/ssl/certs/${bobCert}`)).status).toBe(404);
    expect(row('SELECT 1 AS x FROM ssl_certs WHERE id = ?', bobCert)).toBeTruthy();
    expect(row("SELECT 1 AS x FROM audit_log WHERE action = 'ssl.storage.download_key'")).toBeUndefined();
  });

  it('generates CSRs and self-signed certificates for covered names only, pinned to the account', async () => {
    expect((await alice.post('/ssl/certs/csr', { domain: 'shop.bob.com' })).status).toBe(404);
    expect((await alice.post('/ssl/certs/csr', { domain: 'other.example' })).status).toBe(404);
    expect(names()).toEqual([]);
    const csr = await alice.post('/ssl/certs/csr', { domain: '*.alice.com', subject: { O: 'Alice Ltd' } });
    expect(csr.status, JSON.stringify(csr.body)).toBe(201);
    expect(csr.body.data.cert).toMatchObject({ domain: '*.alice.com', accountId: accountId('alice') });
    app.agent.set('ssl.selfsigned.generate', () => ({ certPem: CERT, keyPem: KEY, certificate: inspected('www.alice.com') }));
    const self = await alice.post('/ssl/certs/self-signed', { domain: 'www.alice.com', days: 30 });
    expect(self.status, JSON.stringify(self.body)).toBe(201);
    expect(self.body.data.cert.accountId).toBe(accountId('alice'));
    const removed = await alice.del(`/ssl/certs/${self.body.data.cert.id}`).expect(200);
    expect(removed.body.data.deleted).toBe(true);
  });

  it('is gated by the sslmanager feature', async () => {
    setFeature(app, 'alice', 'sslmanager', false);
    for (const [method, path] of [['get', '/ssl/domains'], ['get', '/ssl/certs'], ['post', '/ssl/certs/csr']]) {
      const res = await alice[method](path, { domain: 'alice.com' });
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
    }
    setFeature(app, 'alice', 'sslmanager', true);
  });
});
