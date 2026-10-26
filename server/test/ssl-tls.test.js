import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { certCovers, daysUntil, TLS_PRESETS } from '../src/services/ssl-tls.js';

const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n';
const OTHER_KEY = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIOtherKeyBytesHere\n-----END EC PRIVATE KEY-----\n';
const ENCRYPTED_KEY = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI\n-----END ENCRYPTED PRIVATE KEY-----\n';
const agentError = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDtestcertificatebody\n-----END CERTIFICATE-----\n';
const CHAIN = '-----BEGIN CERTIFICATE-----\nMIIDintermediate\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIDroot\n-----END CERTIFICATE-----\n';
const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIICtestcsr\n-----END CERTIFICATE REQUEST-----\n';
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
const PATHS = (d) => ({ dir: `/etc/ssl/whm/${d}`, cert: `/etc/ssl/whm/${d}/cert.pem`, key: `/etc/ssl/whm/${d}/key.pem`, chain: `/etc/ssl/whm/${d}/chain.pem`, fullchain: `/etc/ssl/whm/${d}/fullchain.pem` });
let certInfo = { subject: { CN: 'bob.com' }, subjectText: 'CN=bob.com', commonName: 'bob.com', issuer: { CN: 'R3', O: "Let's Encrypt" }, issuerText: "CN=R3,O=Let's Encrypt", issuerCommonName: 'R3', issuerOrganization: "Let's Encrypt", notBefore: inDays(-1), notAfter: inDays(60), daysRemaining: 60, expired: false, serial: '01', fingerprintSha256: 'AA:BB', sans: ['bob.com', 'www.bob.com'], selfSigned: false, keyAlgorithm: 'RSA', keyBits: 2048, curve: null, signatureAlgorithm: 'sha256WithRSAEncryption' };

const BIN_FULL = { openssl: true, certbot: true, apache2ctl: true, exim4: true, dovecot: true };

let app;
let csrf;
let reseller;
let resellerCsrf;
const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const put = (url, body) => mutate(app.http, 'put', url, body, csrf);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);

async function provision(installed, { acme = installed } = {}) {
  app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, installed ? Boolean(BIN_FULL[n]) : false])));
  app.agent.set('svc.list_units', () => (installed ? ['apache2', 'exim4', 'dovecot'] : []));
  app.agent.set('ssl.acme.detect', () => (acme ? { certbot: true, acmeSh: null, providers: ['certbot'], provider: 'certbot' } : { certbot: false, acmeSh: null, providers: [], provider: null }));
  await app.ctx.capabilities.refresh();
}

beforeAll(async () => {
  const agent = createMockAgent({
    'ssl.key.generate': ({ type = 'rsa', bits = 2048 }) => ({ keyPem: KEY, type, bits: type === 'rsa' ? bits : 256, curve: type === 'ec' ? 'prime256v1' : null, publicKeySha256: 'deadbeef' }),
    'ssl.key.inspect': () => ({ type: 'rsa', bits: 2048, curve: null, publicKeyPem: 'pub', publicKeySha256: 'deadbeef' }),
    'ssl.key.matches': ({ keyPem }) => ({ matches: keyPem === KEY, publicKeySha256: 'deadbeef' }),
    'ssl.csr.generate': ({ subject, sans }) => ({ csrPem: CSR, subject, sans: [subject.CN, ...sans] }),
    'ssl.csr.inspect': () => ({ subject: { CN: 'csr.example.com' }, commonName: 'csr.example.com', sans: ['csr.example.com'], keyAlgorithm: 'RSA', keyBits: 2048 }),
    'ssl.selfsigned.generate': ({ subject }) => ({ certPem: CERT, keyPem: KEY, certificate: { ...certInfo, subject, subjectText: `CN=${subject.CN}`, commonName: subject.CN, issuerText: `CN=${subject.CN}`, sans: [subject.CN], selfSigned: true } }),
    'ssl.cert.inspect': () => certInfo,
    'ssl.cert.verify_chain': () => ({ ok: true, output: 'cert.pem: OK', chainLength: 2, error: null }),
    'ssl.bundle.install_for_domain': ({ domain }) => ({ domain, paths: PATHS(domain), certificate: certInfo }),
    'ssl.bundle.remove_for_domain': ({ domain }) => ({ domain, removed: true }),
    'ssl.bundle.read_for_domain': ({ domain }) => ({ domain, exists: false, paths: PATHS(domain) }),
    'ssl.bundle.list': () => ({ root: '/etc/ssl/whm', bundles: [{ domain: 'orphan.example.net', paths: PATHS('orphan.example.net'), hasKey: true, hasChain: false, inspected: true, certificate: { ...certInfo, commonName: 'orphan.example.net', subjectText: 'CN=orphan.example.net', sans: ['orphan.example.net'] } }] }),
    'ssl.acme.remove': ({ provider, name }) => ({ provider, name, removed: true, output: '' }),
    'ssl.acme.detect': () => ({ certbot: false, acmeSh: null, providers: [], provider: null }),
    'ssl.acme.issue': ({ provider, domains }) => ({ provider, domains, primary: domains[0], renewed: true, paths: PATHS(domains[0]), certPem: CERT, keyPem: KEY, chainPem: CHAIN, certificate: { ...certInfo, commonName: domains[0], subjectText: `CN=${domains[0]}`, sans: domains }, output: 'Successfully received certificate.' }),
    'ssl.tls_config.status': () => ({ apache: { present: true, path: '/etc/apache2/conf-enabled/zz-whm-tls.conf', content: null }, exim: { present: true, path: '/etc/exim4/conf.d/main/000_whm_tls', splitConfig: true, content: null }, dovecot: { present: false } }),
    'ssl.tls_config.apply': ({ services }) => ({ applied: services, results: Object.fromEntries(services.map((s) => [s, { path: `/etc/${s}/whm-tls`, validated: true, reload: { reloaded: true, unit: s } }])) }),
    'ssl.service_cert.install': ({ service }) => ({ service, paths: PATHS(`service/${service}`), applied: [`/etc/${service}/whm`], reload: { reloaded: true, unit: service }, certificate: certInfo, note: null }),
    'ssl.service_cert.status': () => ({ exim: { service: 'exim', daemonPresent: true, hasCertificate: false, paths: PATHS('service/exim'), certificate: null } }),
  });
  app = await createTestApp({ agent });
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  await post('/api/accounts', { username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
  await post('/api/accounts', { username: 'bob', domain: 'bob.com' }).expect(201);
  await provision(true);
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('pure helpers', () => {
  it('certCovers handles exact, SAN and wildcard names', () => {
    const c = { commonName: 'example.com', sans: ['example.com', 'www.example.com', '*.shop.example.com'] };
    expect(certCovers(c, 'example.com')).toBe(true);
    expect(certCovers(c, 'www.example.com')).toBe(true);
    expect(certCovers(c, 'a.shop.example.com')).toBe(true);
    expect(certCovers(c, 'b.a.shop.example.com')).toBe(false);
    expect(certCovers(c, 'mail.example.com')).toBe(false);
  });
  it('daysUntil and presets', () => {
    expect(daysUntil(inDays(10))).toBeGreaterThanOrEqual(9);
    expect(daysUntil(inDays(10))).toBeLessThanOrEqual(10);
    expect(daysUntil(inDays(-3))).toBeLessThan(0);
    expect(daysUntil(null)).toBeNull();
    expect(TLS_PRESETS.modern.protocols).toEqual(['TLSv1.3']);
  });
});

describe('module registration and RBAC', () => {
  it('attaches ctx.ssl, the AutoSSL job and its daily schedule', () => {
    expect(typeof app.ctx.ssl.install).toBe('function');
    expect(typeof app.ctx.ssl.installServiceCert).toBe('function');
    expect(app.ctx.jobs.types()).toContain('ssl.autossl.run');
    expect(app.ctx.scheduler.list().find((s) => s.name === 'autossl-daily')?.cron).toBe('17 3 * * *');
  });

  it('server-wide functions are root only', async () => {
    for (const url of ['/api/ssl/autossl', '/api/ssl/autossl/runs', '/api/ssl/tls-config', '/api/ssl/service-certs']) {
      const res = await reseller.get(url);
      expect(res.status, url).toBe(403);
    }
    expect((await mutate(reseller, 'post', '/api/ssl/autossl/run', {}, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/ssl/tls-config', { preset: 'modern' }, resellerCsrf)).status).toBe(403);
  });

  it('resellers cannot touch other resellers\' accounts or domains', async () => {
    expect((await mutate(reseller, 'post', '/api/ssl/certs/csr', { domain: 'bob.com' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/ssl/certs/csr', { account: 'bob', domain: 'x.bob.com' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: KEY }, resellerCsrf)).status).toBe(403);
    // An unknown hostname is a 404 for resellers but fine for root (server hostname certs).
    expect((await mutate(reseller, 'post', '/api/ssl/certs/csr', { domain: 'nobody.example.org' }, resellerCsrf)).status).toBe(404);
  });
});

describe('validation (422)', () => {
  it('rejects malformed CSR requests before any agent call', async () => {
    app.agent.calls.length = 0;
    for (const body of [
      { domain: '-d' }, { domain: 'bob.com', sans: ['a;b'] }, { domain: 'bob.com', sans: ['../etc'] }, { domain: 'bob.com', subject: { O: 'Acme/CN=evil' } },
      { domain: 'bob.com', subject: { C: 'USA' } }, { domain: 'bob.com', key: { bits: 1024 } }, { domain: 'bob.com', key: { type: 'dsa' } }, { domain: 'bob.com', extra: 1 },
    ]) {
      const res = await post('/api/ssl/certs/csr', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect(app.agent.callsTo('ssl.key.generate')).toHaveLength(0);
  });

  it('rejects non-PEM material, bad parts and bad TLS policies', async () => {
    expect((await post('/api/ssl/install', { domain: 'bob.com', certPem: 'not a cert', keyPem: KEY })).status).toBe(422);
    expect((await post('/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: 'ssh-rsa AAAA' })).status).toBe(422);
    expect((await post('/api/ssl/certs/inspect', { certPem: `${CERT}; rm -rf /` })).status).toBe(422);
    expect((await get('/api/ssl/certs/1/download?part=shadow')).status).toBe(422);
    expect((await put('/api/ssl/tls-config', { ciphers: 'HIGH; id' })).status).toBe(422);
    expect((await put('/api/ssl/tls-config', { protocols: ['SSLv3'] })).status).toBe(422);
    expect((await put('/api/ssl/tls-config', { protocols: [] })).status).toBe(422);
    expect((await post('/api/ssl/autossl/exclusions', { kind: 'user', value: 'bob' })).status).toBe(422);
    expect((await post('/api/ssl/autossl/exclusions', { kind: 'account', value: 'Bob;' })).status).toBe(422);
    expect((await put('/api/ssl/autossl/settings', { renewDays: 120 })).status).toBe(422);
    expect((await put('/api/ssl/autossl/settings', { email: '-x@example.com' })).status).toBe(422);
    expect((await post('/api/ssl/service-certs/nginx', { certPem: CERT, keyPem: KEY })).status).toBe(422);
  });

  it('refuses passphrase-protected keys with a hint instead of letting openssl prompt', async () => {
    app.agent.calls.length = 0;
    for (const [url, body] of [['/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: ENCRYPTED_KEY }], ['/api/ssl/certs/upload', { keyPem: ENCRYPTED_KEY, domain: 'bob.com' }], ['/api/ssl/service-certs/exim', { certPem: CERT, keyPem: ENCRYPTED_KEY }]]) {
      const res = await post(url, body);
      expect(res.status, url).toBe(422);
      expect(res.body.error.fields.keyPem[0]).toMatch(/decrypt/i);
    }
    expect(app.agent.calls.filter((c) => c.name.startsWith('ssl.'))).toHaveLength(0);
  });

  it('turns openssl/daemon rejections raised by the agent into 422 with the field named', async () => {
    const restore = {
      'ssl.cert.inspect': () => certInfo,
      'ssl.key.inspect': () => ({ type: 'rsa', bits: 2048, curve: null, publicKeyPem: 'pub', publicKeySha256: 'deadbeef' }),
      'ssl.key.matches': ({ keyPem }) => ({ matches: keyPem === KEY, publicKeySha256: 'deadbeef' }),
      'ssl.service_cert.install': ({ service }) => ({ service, paths: PATHS(`service/${service}`), applied: [`/etc/${service}/whm`], removed: [], reload: { reloaded: true, unit: service }, certificate: certInfo, note: null }),
      'ssl.tls_config.apply': ({ services }) => ({ applied: services, results: Object.fromEntries(services.map((s) => [s, { path: `/etc/${s}/whm-tls`, validated: true, reload: { reloaded: true, unit: s } }])), removed: {} }),
    };
    try {
      app.agent.fail('ssl.cert.inspect', 'invalid_certificate', 'openssl could not parse the certificate: asn1 encoding routines');
      for (const [url, body] of [['/api/ssl/certs/inspect', { certPem: CERT }], ['/api/ssl/certs/upload', { certPem: CERT }], ['/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: KEY }]]) {
        const res = await post(url, body);
        expect(res.status, url).toBe(422);
        expect(res.body.error.code).toBe('validation_failed');
        expect(res.body.error.message).toMatch(/could not parse the certificate/);
        expect(res.body.error.fields.certPem).toHaveLength(1);
      }
      app.agent.set('ssl.cert.inspect', restore['ssl.cert.inspect']);
      app.agent.fail('ssl.key.inspect', 'invalid_key', 'openssl could not read the private key: bad decrypt');
      const keyOnly = await post('/api/ssl/certs/upload', { keyPem: KEY, domain: 'bob.com' });
      expect(keyOnly.status).toBe(422);
      expect(keyOnly.body.error.fields.keyPem[0]).toMatch(/could not read the private key/);
      app.agent.set('ssl.key.inspect', restore['ssl.key.inspect']);
      // The matcher itself can reject a corrupt key: the key field is blamed, not a 500.
      app.agent.fail('ssl.key.matches', 'invalid_key', 'openssl could not read the key: unsupported');
      expect((await post('/api/ssl/service-certs/exim', { certPem: CERT, keyPem: KEY })).status).toBe(422);
      expect((await post('/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: KEY })).body.error.fields.keyPem).toBeDefined();
      app.agent.set('ssl.key.matches', restore['ssl.key.matches']);
      // A daemon rejecting the written configuration (already rolled back by the agent) is the caller's 422 too.
      app.agent.fail('ssl.service_cert.install', 'config_invalid', 'Dovecot rejected the certificate drop-in; the previous file was restored: ssl_cert: Cannot open file');
      const svc = await post('/api/ssl/service-certs/dovecot', { certPem: CERT, keyPem: KEY });
      expect(svc.status).toBe(422);
      expect(svc.body.error.code).toBe('config_invalid');
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ssl_service_certs WHERE service = ?').get('dovecot').n).toBe(0);
      app.agent.fail('ssl.tls_config.apply', 'config_invalid', 'Apache rejected the new configuration; the previous file was restored: SSLCipherSuite takes one argument');
      const tls = await put('/api/ssl/tls-config', { preset: 'modern', services: ['apache'] });
      expect(tls.status).toBe(422);
      expect(tls.body.error).toMatchObject({ code: 'config_invalid', message: expect.stringMatching(/Apache rejected/) });
    } finally {
      for (const [name, handler] of Object.entries(restore)) app.agent.set(name, handler);
    }
    await put('/api/ssl/tls-config', { preset: 'intermediate', services: ['apache', 'exim', 'dovecot'], apply: false });
  });
});

describe('capability degradation', () => {
  it('needs openssl for key/CSR work and an ACME client for AutoSSL', async () => {
    await provision(false);
    const csr = await post('/api/ssl/certs/csr', { domain: 'bob.com' });
    expect(csr.status).toBe(501);
    expect(csr.body.error.code).toBe('capability_missing');
    expect(csr.body.error.capability).toBe('ssl');
    expect((await post('/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: KEY })).status).toBe(501);
    const prov = await put('/api/ssl/autossl/settings', { provider: 'certbot' });
    expect(prov.status).toBe(501);
    expect(prov.body.error.capability).toBe('acme');
    const tls = await put('/api/ssl/tls-config', { preset: 'modern' });
    expect(tls.status).toBe(501);
    // Status pages still answer so the UI can show the install prompt next to data.
    expect((await get('/api/ssl/autossl')).status).toBe(200);
    expect((await get('/api/ssl/tls-config')).body.data.daemons.apache).toBe(false);
    expect((await get('/api/ssl/hosts')).status).toBe(200);
    await provision(true);
  });

  it('refuses to run AutoSSL while it is disabled', async () => {
    const res = await post('/api/ssl/autossl/run', {});
    expect(res.status).toBe(400);
  });
});

describe('generate CSR / self-signed / upload / inspect', () => {
  let csrId;
  it('generates a key + CSR for an account domain and stores them encrypted', async () => {
    const res = await post('/api/ssl/certs/csr', { domain: 'bob.com', sans: ['www.bob.com'], subject: { O: 'Bob Inc', C: 'US' }, key: { type: 'rsa', bits: 4096 } });
    expect(res.status).toBe(201);
    expect(res.body.data.csrPem).toBe(CSR);
    expect(res.body.data.keyPem).toBe(KEY);
    expect(res.body.data.cert).toMatchObject({ domain: 'bob.com', account: 'bob', hasKey: true, hasCsr: true, hasCert: false, state: 'stored' });
    csrId = res.body.data.cert.id;
    const call = app.agent.callsTo('ssl.csr.generate').pop();
    expect(call.args.subject).toEqual({ O: 'Bob Inc', C: 'US', CN: 'bob.com' });
    expect(call.args.sans).toEqual(['www.bob.com']);
    const row = app.ctx.db.prepare('SELECT key_enc, csr_pem FROM ssl_certs WHERE id = ?').get(csrId);
    expect(row.key_enc.startsWith('v1:')).toBe(true);
    expect(app.ctx.crypto.decrypt(row.key_enc)).toBe(KEY);
  });

  it('resellers generate for their own accounts and only see their own rows', async () => {
    const res = await mutate(reseller, 'post', '/api/ssl/certs/csr', { domain: 'alice.com' }, resellerCsrf);
    expect(res.status).toBe(201);
    expect(res.body.data.cert.account).toBe('alice');
    const list = await reseller.get('/api/ssl/certs');
    expect(list.body.data.every((c) => c.account === 'alice')).toBe(true);
    expect((await reseller.get(`/api/ssl/certs/${csrId}`)).status).toBe(403);
    expect((await mutate(reseller, 'delete', `/api/ssl/certs/${csrId}`, undefined, resellerCsrf)).status).toBe(403);
  });

  it('lists, filters and downloads stored items (key downloads are audited)', async () => {
    const list = await get('/api/ssl/certs?kind=csr&q=bob');
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(list.body.data.some((c) => c.id === csrId)).toBe(true);
    const key = await get(`/api/ssl/certs/${csrId}/download?part=key`);
    expect(key.body.data).toMatchObject({ part: 'key', content: KEY, filename: 'bob.com.key.key' });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ssl.storage.download_key'").get().n).toBeGreaterThanOrEqual(1);
    expect((await get(`/api/ssl/certs/${csrId}/download?part=cert`)).status).toBe(404);
  });

  it('generates a self-signed certificate', async () => {
    const res = await post('/api/ssl/certs/self-signed', { domain: 'bob.com', days: 30 });
    expect(res.status).toBe(201);
    expect(res.body.data.cert).toMatchObject({ hasCert: true, hasKey: true, selfSigned: true });
    expect(res.body.data.certificate.selfSigned).toBe(true);
  });

  it('uploads certificates and rejects a key that does not match', async () => {
    const bad = await post('/api/ssl/certs/upload', { certPem: CERT, keyPem: OTHER_KEY });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.keyPem).toBeDefined();
    const ok = await post('/api/ssl/certs/upload', { certPem: CERT, keyPem: KEY, chainPem: CHAIN });
    expect(ok.status).toBe(201);
    expect(ok.body.data.cert).toMatchObject({ domain: 'bob.com', account: 'bob', hasCert: true, hasKey: true, hasChain: true });
    const keyOnly = await post('/api/ssl/certs/upload', { keyPem: KEY, domain: 'bob.com' });
    expect(keyOnly.status).toBe(201);
    expect((await post('/api/ssl/certs/upload', { keyPem: KEY })).status).toBe(422);
    expect((await post('/api/ssl/certs/upload', {})).status).toBe(422);
  });

  it('inspects pasted certificates', async () => {
    const res = await post('/api/ssl/certs/inspect', { certPem: CERT, chainPem: CHAIN, domain: 'bob.com' });
    expect(res.status).toBe(200);
    expect(res.body.data.certificate.commonName).toBe('bob.com');
    expect(res.body.data.chain.ok).toBe(true);
  });
});

describe('install on a domain, hosts and storage', () => {
  let storedId;
  let savedWeb;
  beforeAll(() => { savedWeb = app.ctx.web; app.ctx.web = undefined; });
  afterAll(() => { app.ctx.web = savedWeb; });

  it('installs a stored certificate; without the web category the vhost stays pending', async () => {
    storedId = (await post('/api/ssl/certs/upload', { certPem: CERT, keyPem: KEY, chainPem: CHAIN })).body.data.cert.id;
    const res = await post('/api/ssl/install', { domain: 'bob.com', certId: storedId });
    expect(res.status).toBe(200);
    expect(res.body.data.web).toBe('pending');
    expect(res.body.data.cert).toMatchObject({ domain: 'bob.com', state: 'pending', installed: 2 });
    expect(res.body.data.paths.key).toBe('/etc/ssl/whm/bob.com/key.pem');
    const call = app.agent.callsTo('ssl.bundle.install_for_domain').pop();
    expect(call.args).toMatchObject({ domain: 'bob.com', certPem: CERT, keyPem: KEY, chainPem: CHAIN });
  });

  it('applies through ctx.web.applySsl when the web category is present', async () => {
    const applied = [];
    app.ctx.web = { applySsl: async (domain, paths) => { applied.push({ domain, paths }); return { vhost: domain }; } };
    const res = await post('/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: KEY });
    expect(res.status).toBe(200);
    expect(res.body.data.web).toBe('applied');
    expect(res.body.data.cert.state).toBe('installed');
    expect(applied[0]).toMatchObject({ domain: 'bob.com', paths: { fullchain: '/etc/ssl/whm/bob.com/fullchain.pem' } });
    app.ctx.web = undefined;
    expect(app.ctx.ssl.certForDomain('bob.com')).toMatchObject({ domain: 'bob.com', installed: 1 });
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ssl_certs WHERE domain = ? AND installed > 0').get('bob.com').n).toBe(1);
  });

  it('finds the matching stored key when only a certificate is pasted and rejects wrong keys', async () => {
    const ok = await post('/api/ssl/install', { domain: 'www.bob.com', certPem: CERT });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const bad = await post('/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: OTHER_KEY });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.keyPem).toBeDefined();
  });

  it('installing a stored certificate on another hostname moves the row instead of copying key and certificate', async () => {
    const before = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ssl_certs WHERE key_enc IS NOT NULL').get().n;
    const wildcard = (await post('/api/ssl/certs/upload', { certPem: CERT, keyPem: KEY, domain: 'bob.com' })).body.data.cert.id;
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ssl_certs WHERE key_enc IS NOT NULL').get().n).toBe(before + 1);
    const res = await post('/api/ssl/install', { domain: 'shop.bob.com', certId: wildcard, force: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.cert.id).toBe(wildcard);
    // shop.bob.com is no account's domain, so root installs it as a server hostname (no account).
    expect(res.body.data.cert).toMatchObject({ domain: 'shop.bob.com', account: null, installed: 2 });
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ssl_certs WHERE key_enc IS NOT NULL').get().n).toBe(before + 1);
    // Once it is installed somewhere, a second hostname needs its own row.
    const second = await post('/api/ssl/install', { domain: 'mail.bob.com', certId: wildcard, force: true });
    expect(second.body.data.cert.id).not.toBe(wildcard);
    await del('/api/ssl/hosts/shop.bob.com');
    await del('/api/ssl/hosts/mail.bob.com');
  });

  it('refuses a certificate that does not cover the domain unless forced', async () => {
    const res = await post('/api/ssl/install', { domain: 'alice.com', certPem: CERT, keyPem: KEY });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.domain).toBeDefined();
    const forced = await post('/api/ssl/install', { domain: 'alice.com', certPem: CERT, keyPem: KEY, force: true });
    expect(forced.status).toBe(200);
  });

  it('lists hosts (root sees unmanaged bundle directories too) and resellers only their own', async () => {
    const res = await get('/api/ssl/hosts');
    expect(res.status).toBe(200);
    const domains = res.body.data.hosts.map((h) => h.domain);
    expect(domains).toEqual(expect.arrayContaining(['bob.com', 'www.bob.com', 'alice.com', 'orphan.example.net']));
    expect(res.body.data.hosts.find((h) => h.domain === 'orphan.example.net').state).toBe('unmanaged');
    expect(res.body.data.hosts.find((h) => h.domain === 'bob.com').files.present).toBe(false);
    expect(res.body.data.bundlesListed).toBe(true);
    // Known rows are passed to the agent so it does not run openssl on every directory.
    expect(app.agent.callsTo('ssl.bundle.list').pop().args.knownDomains).toEqual(expect.arrayContaining(['bob.com', 'alice.com']));
    const mine = await reseller.get('/api/ssl/hosts');
    expect(mine.body.data.hosts.map((h) => h.domain)).toEqual(['alice.com']);
    expect(mine.body.data.hosts[0].files.present).toBeNull();
    const domainsList = await get('/api/ssl/domains');
    expect(domainsList.body.data.find((d) => d.domain === 'bob.com').certificate.installed).toBeGreaterThan(0);
  });

  it('a failed directory listing leaves file presence unknown rather than marking every host missing', async () => {
    app.agent.fail('ssl.bundle.list', 'command_failed', 'EACCES');
    const res = await get('/api/ssl/hosts');
    expect(res.status).toBe(200);
    expect(res.body.data.bundlesListed).toBe(false);
    expect(res.body.data.hosts.every((h) => h.files.present === null)).toBe(true);
    app.agent.set('ssl.bundle.list', () => ({ root: '/etc/ssl/whm', bundles: [{ domain: 'orphan.example.net', paths: PATHS('orphan.example.net'), hasKey: true, hasChain: false, inspected: true, certificate: { ...certInfo, commonName: 'orphan.example.net', subjectText: 'CN=orphan.example.net', sans: ['orphan.example.net'] } }] }));
  });

  it('shows one host from disk, including unmanaged directories without a row', async () => {
    app.agent.set('ssl.bundle.read_for_domain', ({ domain }) => ({ domain, exists: true, paths: PATHS(domain), certPem: CERT, chainPem: CHAIN, certificate: { ...certInfo, commonName: domain, sans: [domain] } }));
    const orphan = await get('/api/ssl/hosts/orphan.example.net');
    expect(orphan.status, JSON.stringify(orphan.body)).toBe(200);
    expect(orphan.body.data).toMatchObject({ state: 'unmanaged', cert: null, files: { exists: true, hasChain: true }, certificate: { commonName: 'orphan.example.net' }, chain: { ok: true } });
    const bob = await get('/api/ssl/hosts/bob.com');
    expect(bob.body.data.cert.domain).toBe('bob.com');
    expect(bob.body.data.state).toBe('installed');
    expect((await reseller.get('/api/ssl/hosts/bob.com')).status).toBe(403);
    expect((await reseller.get('/api/ssl/hosts/alice.com')).status).toBe(200);
    app.agent.set('ssl.bundle.read_for_domain', ({ domain }) => ({ domain, exists: false, paths: PATHS(domain) }));
    expect((await get('/api/ssl/hosts/nothing.example.org')).status).toBe(404);
  });

  it('uninstall is authorised by the domain owner, not by whoever stored the certificate', async () => {
    // Root installs a certificate that alice's reseller stored onto bob's domain: the row follows the domain.
    const stored = (await mutate(reseller, 'post', '/api/ssl/certs/upload', { certPem: CERT, keyPem: KEY, domain: 'alice.com' }, resellerCsrf)).body.data.cert.id;
    const res = await post('/api/ssl/install', { domain: 'bob.com', certId: stored, force: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.cert.account).toBe('bob');
    expect((await mutate(reseller, 'delete', '/api/ssl/hosts/bob.com', undefined, resellerCsrf)).status).toBe(403);
    expect(app.ctx.ssl.certForDomain('bob.com')).not.toBeNull();
    // ...and a reseller may uninstall from their own domain whatever root installed there.
    const applied = await post('/api/ssl/install', { domain: 'alice.com', certPem: CERT, keyPem: KEY, force: true });
    expect(applied.status).toBe(200);
    const un = await mutate(reseller, 'delete', '/api/ssl/hosts/alice.com', undefined, resellerCsrf);
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    expect(app.ctx.ssl.certForDomain('alice.com')).toBeNull();
  });

  it('storage refuses to delete installed material until it is uninstalled', async () => {
    const storage = await get('/api/ssl/storage');
    expect(storage.status).toBe(200);
    expect(storage.body.data.counts.key).toBeGreaterThan(0);
    const installed = storage.body.data.items.find((i) => i.domain === 'bob.com' && i.kind === 'cert' && i.installed > 0);
    expect(installed).toBeDefined();
    expect((await del(`/api/ssl/certs/${installed.id}/key`)).status).toBe(409);
    expect((await del(`/api/ssl/certs/${installed.id}`)).status).toBe(409);
    const un = await del('/api/ssl/hosts/bob.com');
    expect(un.status).toBe(200);
    expect(un.body.data.removed).toBe(true);
    expect(app.agent.callsTo('ssl.bundle.remove_for_domain').pop().args.domain).toBe('bob.com');
    expect(app.ctx.ssl.certForDomain('bob.com')).toBeNull();
    expect((await del(`/api/ssl/certs/${installed.id}/key`)).body.data.deleted).toBe(true);
    expect((await get(`/api/ssl/certs/${installed.id}`)).body.data.hasKey).toBe(false);
    expect((await del(`/api/ssl/certs/${installed.id}`)).body.data.deleted).toBe(true);
    expect((await get(`/api/ssl/certs/${installed.id}`)).status).toBe(404);
    expect((await del('/api/ssl/hosts/alice.com')).status).toBe(200);
    expect((await del('/api/ssl/hosts/www.bob.com')).status).toBe(200);
  });
});

describe('AutoSSL', () => {
  let savedWeb;
  beforeAll(() => { savedWeb = app.ctx.web; app.ctx.web = undefined; });
  afterAll(() => { app.ctx.web = savedWeb; });

  it('selects a provider once it is installed and reports coverage; the daily schedule follows the feature', async () => {
    // Disabled at boot: the scheduler must not queue passes that would only be skipped.
    expect(app.ctx.scheduler.list().find((x) => x.name === 'autossl-daily').enabled).toBe(0);
    const res = await put('/api/ssl/autossl/settings', { provider: 'certbot', email: 'admin@example.com', renewDays: 20 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: 'certbot', email: 'admin@example.com', renewDays: 20 });
    const status = await get('/api/ssl/autossl');
    expect(status.body.data.providerInstalled).toBe(true);
    expect(status.body.data.schedule).toMatchObject({ cron: '17 3 * * *', enabled: true });
    expect(status.body.data.coverage.map((d) => d.domain)).toEqual(expect.arrayContaining(['alice.com', 'bob.com']));
    await put('/api/ssl/autossl/settings', { provider: 'disabled' });
    expect((await get('/api/ssl/autossl')).body.data.schedule.enabled).toBe(false);
    await put('/api/ssl/autossl/settings', { provider: 'certbot' });
    expect((await get('/api/ssl/autossl')).body.data.schedule.enabled).toBe(true);
  });

  it('manages exclusions', async () => {
    expect((await post('/api/ssl/autossl/exclusions', { kind: 'account', value: 'nobody' })).status).toBe(404);
    const ex = await post('/api/ssl/autossl/exclusions', { kind: 'account', value: 'alice', reason: 'customer brings own cert' });
    expect(ex.status).toBe(201);
    expect((await post('/api/ssl/autossl/exclusions', { kind: 'account', value: 'alice' })).status).toBe(409);
    const status = await get('/api/ssl/autossl');
    expect(status.body.data.coverage.find((d) => d.domain === 'alice.com').excluded).toBe('account');
    expect((await del(`/api/ssl/autossl/exclusions/${ex.body.data.id}`)).body.data.removed).toBe(true);
    expect((await del(`/api/ssl/autossl/exclusions/${ex.body.data.id}`)).status).toBe(404);
    await post('/api/ssl/autossl/exclusions', { kind: 'domain', value: 'alice.com' });
  });

  it('run-now enqueues a job that issues for eligible domains and records a run', async () => {
    const res = await post('/api/ssl/autossl/run', {});
    expect(res.status).toBe(202);
    expect(res.body.data.job.type).toBe('ssl.autossl.run');
    app.ctx.jobs.start();
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10_000);
    expect(job.status, JSON.stringify(job)).toBe('done');
    expect(job.result.issued).toBeGreaterThanOrEqual(1);
    expect(job.result.skipped).toBeGreaterThanOrEqual(1);
    const bob = job.result.entries.find((e) => e.domain === 'bob.com');
    expect(bob.action).toBe('issued');
    expect(job.result.entries.find((e) => e.domain === 'alice.com')).toMatchObject({ action: 'skip', message: 'excluded (domain)' });
    const issue = app.agent.callsTo('ssl.acme.issue').find((c) => c.args.domains[0] === 'bob.com');
    expect(issue.args).toMatchObject({ provider: 'certbot', domains: ['bob.com', 'www.bob.com'], method: 'webroot', email: 'admin@example.com', webroot: '/home/bob/public_html' });
    const cert = app.ctx.ssl.certForDomain('bob.com');
    expect(cert).toMatchObject({ autossl: true, state: 'pending' });
    const runs = await get('/api/ssl/autossl/runs');
    expect(runs.body.data[0]).toMatchObject({ status: 'done', trigger: 'manual', provider: 'certbot' });
    const one = await get(`/api/ssl/autossl/runs/${runs.body.data[0].id}`);
    expect(one.body.data.entries.length).toBeGreaterThan(0);
    // A second pass skips the fresh certificate.
    const again = await post('/api/ssl/autossl/run', { domain: 'bob.com' });
    const job2 = await waitForJob(app.ctx, again.body.data.job.id, 10_000);
    expect(job2.result.entries[0].message).toMatch(/valid for \d+ more days/);
    const forced = await post('/api/ssl/autossl/run', { domain: 'bob.com', force: true });
    expect((await waitForJob(app.ctx, forced.body.data.job.id, 10_000)).result.renewed).toBe(1);
    app.ctx.jobs.stop();
  });

  it('records failures per domain and keeps going', async () => {
    app.agent.fail('ssl.acme.issue', 'acme_failed', 'DNS problem: NXDOMAIN');
    app.ctx.jobs.start();
    const res = await post('/api/ssl/autossl/run', { domain: 'bob.com', force: true });
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10_000);
    app.ctx.jobs.stop();
    expect(job.status).toBe('done');
    expect(job.result.failed).toBe(1);
    expect(job.result.entries[0]).toMatchObject({ action: 'failed', message: 'DNS problem: NXDOMAIN' });
    // Both the www+apex attempt and the apex-only retry were made before giving up.
    expect(app.agent.callsTo('ssl.acme.issue').slice(-2).map((c) => c.args.domains)).toEqual([['bob.com', 'www.bob.com'], ['bob.com']]);
    app.agent.reset('ssl.acme.issue');
    app.agent.set('ssl.acme.issue', ({ provider, domains }) => ({ provider, domains, primary: domains[0], renewed: true, paths: PATHS(domains[0]), certPem: CERT, keyPem: KEY, chainPem: CHAIN, certificate: { ...certInfo, commonName: domains[0], sans: domains }, output: '' }));
  });

  it('drops a www name that fails validation and still secures the primary domain', async () => {
    const issue = app.agent.callsTo('ssl.acme.issue').length;
    app.agent.set('ssl.acme.issue', ({ provider, domains }) => {
      if (domains.length > 1) throw agentError('acme_failed', 'certbot failed: Challenge failed for domain www.bob.com');
      return { provider, domains, primary: domains[0], renewed: true, paths: PATHS(domains[0]), certPem: CERT, keyPem: KEY, chainPem: CHAIN, certificate: { ...certInfo, commonName: domains[0], sans: domains }, output: '' };
    });
    app.ctx.jobs.start();
    const res = await post('/api/ssl/autossl/run', { domain: 'bob.com', force: true });
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10_000);
    app.ctx.jobs.stop();
    expect(job.result.entries[0].action).toBe('renewed');
    expect(job.result.entries[0].message).toMatch(/www\.bob\.com failed validation/);
    expect(app.agent.callsTo('ssl.acme.issue').slice(issue).map((c) => c.args.domains)).toEqual([['bob.com', 'www.bob.com'], ['bob.com']]);
    // A non-ACME failure is not retried.
    app.agent.fail('ssl.acme.issue', 'path_not_allowed', 'webroot outside allowed roots');
    const result = await app.ctx.ssl.autossl.run({ params: { trigger: 'manual', domain: 'bob.com', force: true }, log() {}, progress() {} });
    expect(result.entries[0].action).toBe('failed');
    expect(app.agent.callsTo('ssl.acme.issue').length).toBe(issue + 3);
    app.agent.set('ssl.acme.issue', ({ provider, domains }) => ({ provider, domains, primary: domains[0], renewed: true, paths: PATHS(domains[0]), certPem: CERT, keyPem: KEY, chainPem: CHAIN, certificate: { ...certInfo, commonName: domains[0], sans: domains }, output: '' }));
  });

  it('counts a pass the client kept the old certificate on as skipped, not renewed', async () => {
    app.agent.set('ssl.acme.issue', ({ provider, domains }) => ({ provider, domains, primary: domains[0], renewed: false, paths: PATHS(domains[0]), certPem: CERT, keyPem: KEY, chainPem: CHAIN, certificate: { ...certInfo, commonName: domains[0], sans: domains }, output: 'Certificate not yet due for renewal' }));
    const result = await app.ctx.ssl.autossl.run({ params: { trigger: 'manual', domain: 'bob.com', force: true }, log() {}, progress() {} });
    expect(result.renewed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]).toMatchObject({ action: 'skip', message: expect.stringMatching(/not due according to certbot/) });
    app.agent.set('ssl.acme.issue', ({ provider, domains }) => ({ provider, domains, primary: domains[0], renewed: true, paths: PATHS(domains[0]), certPem: CERT, keyPem: KEY, chainPem: CHAIN, certificate: { ...certInfo, commonName: domains[0], sans: domains }, output: '' }));
  });

  it('skips silently when the scheduled pass finds AutoSSL disabled', async () => {
    await put('/api/ssl/autossl/settings', { provider: 'disabled' });
    const result = await app.ctx.ssl.autossl.run({ params: { trigger: 'scheduled' }, log() {}, progress() {} });
    expect(result.status).toBe('skipped');
    await put('/api/ssl/autossl/settings', { provider: 'certbot' });
  });

  it('issue-now for one domain is a 202 job scoped to the caller\'s domain, never a forced re-issue for resellers', async () => {
    // ACME runs for minutes, so the reseller route enqueues the same job as run-now.
    const res = await mutate(reseller, 'post', '/api/ssl/autossl/issue', { domain: 'alice.com' }, resellerCsrf);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.data.job).toMatchObject({ type: 'ssl.autossl.run', params: { trigger: 'manual', domain: 'alice.com', force: false } });
    expect(res.body.data.cert).toBeUndefined();
    const forced = await mutate(reseller, 'post', '/api/ssl/autossl/issue', { domain: 'alice.com', force: true }, resellerCsrf);
    expect(forced.status).toBe(403);
    expect(forced.body.error.message).toMatch(/root/i);
    expect((await mutate(reseller, 'post', '/api/ssl/autossl/issue', { domain: 'bob.com' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/ssl/autossl/issue', { domain: 'alice.com', force: 'yes' }, resellerCsrf)).status).toBe(422);
    expect((await mutate(reseller, 'post', '/api/ssl/autossl/issue', {}, resellerCsrf)).status).toBe(422);
    // Root may force; the job only touches the one domain.
    const callsBefore = app.agent.callsTo('ssl.acme.issue').length;
    const rootForced = await post('/api/ssl/autossl/issue', { domain: 'bob.com', force: true });
    expect(rootForced.status).toBe(202);
    expect(rootForced.body.data.job.params).toMatchObject({ domain: 'bob.com', force: true });
    app.ctx.jobs.start();
    const job = await waitForJob(app.ctx, rootForced.body.data.job.id, 10_000);
    const alice = await waitForJob(app.ctx, res.body.data.job.id, 10_000);
    app.ctx.jobs.stop();
    expect(job.status).toBe('done');
    expect(job.result.entries.map((e) => e.domain)).toEqual(['bob.com']);
    expect(job.result.entries[0].action).toBe('renewed');
    // alice.com is excluded by the earlier exclusion test, so the unforced job records a skip instead of calling ACME.
    expect(alice.result.entries).toEqual([expect.objectContaining({ domain: 'alice.com', action: 'skip', message: 'excluded (domain)' })]);
    expect(app.agent.callsTo('ssl.acme.issue').slice(callsBefore).map((c) => c.args.domains[0])).toEqual(['bob.com']);
    const audit = app.ctx.db.prepare('SELECT action, target FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get('ssl.autossl.run');
    expect(audit).toMatchObject({ action: 'ssl.autossl.run', target: 'bob.com' });
  });

  it('issueFor stays available to internal callers (synchronous) and 501s with the route when the client vanished', async () => {
    const result = await app.ctx.ssl.issueFor('bob.com', { role: 'root' }, null, { force: true });
    expect(result.cert).toMatchObject({ domain: 'bob.com', autossl: true });
    await provision(true, { acme: false });
    expect((await post('/api/ssl/autossl/issue', { domain: 'bob.com' })).status).toBe(501);
    expect((await mutate(reseller, 'post', '/api/ssl/autossl/issue', { domain: 'alice.com' }, resellerCsrf)).status).toBe(501);
    expect((await post('/api/ssl/autossl/run', {})).status).toBe(501);
    await provision(true);
  });
});

describe('purchase flow', () => {
  let orderId;
  it('lists providers from market.* settings and refuses disabled ones', async () => {
    const providers = await get('/api/ssl/market/providers');
    expect(providers.status).toBe(200);
    expect(providers.body.data[0]).toMatchObject({ name: 'cpstore', enabled: false });
    const res = await post('/api/ssl/market/orders', { provider: 'cpstore', product: 'dv', domain: 'bob.com' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Market Provider Manager/);
    expect((await post('/api/ssl/market/orders', { provider: 'nope', product: 'dv', domain: 'bob.com' })).status).toBe(404);
  });

  it('records an order with a generated CSR and installs the pasted certificate on completion', async () => {
    const providers = app.ctx.settings.get('market.providers');
    app.ctx.settings.set('market.providers', providers.map((p) => ({ ...p, enabled: true })));
    const res = await post('/api/ssl/market/orders', { provider: 'cpstore', product: 'dv', domain: 'bob.com' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.order).toMatchObject({ provider: 'cpstore', product: 'dv', domain: 'bob.com', status: 'pending', price: 9.99 });
    expect(res.body.data.csrPem).toBe(CSR);
    orderId = res.body.data.order.id;
    expect((await reseller.get('/api/ssl/market/orders')).body.data.find((o) => o.id === orderId)).toBeUndefined();
    const done = await post(`/api/ssl/market/orders/${orderId}/complete`, { certPem: CERT, chainPem: CHAIN, orderRef: 'CP-1234' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.order).toMatchObject({ status: 'installed', orderRef: 'CP-1234' });
    expect(done.body.data.cert.domain).toBe('bob.com');
    expect((await del(`/api/ssl/market/orders/${orderId}`)).status).toBe(409);
    const pending = await post('/api/ssl/market/orders', { provider: 'cpstore', product: 'wildcard', domain: 'bob.com' });
    expect(app.agent.callsTo('ssl.csr.generate').pop().args.sans).toEqual(['*.bob.com']);
    expect((await del(`/api/ssl/market/orders/${pending.body.data.order.id}`)).body.data.status).toBe('cancelled');
    expect((await post('/api/ssl/market/orders/999/complete', { certPem: CERT })).status).toBe(404);
  });
});

describe('TLS configuration and service certificates', () => {
  it('returns presets, settings and the managed include status', async () => {
    const res = await get('/api/ssl/tls-config');
    expect(res.status).toBe(200);
    // The degradation test above saved "modern" before its 501, so the policy persists even without daemons.
    expect(res.body.data.settings.preset).toBe('modern');
    expect(res.body.data.settings.protocols).toEqual(['TLSv1.3']);
    expect(Object.keys(res.body.data.presets)).toEqual(['modern', 'intermediate', 'old']);
    expect(res.body.data.daemons).toEqual({ apache: true, exim: true, dovecot: true });
  });

  it('applies a preset: Apache through its own include, Exim and Dovecot through Service Configuration', async () => {
    const savedWeb = app.ctx.web;
    const hooks = [];
    app.ctx.web = { applyEximTls: async (p) => { hooks.push(['exim', p]); return { path: '/etc/exim4/conf.d/main/000_whm_mail', validated: true, reload: { reloaded: true, unit: 'exim4' } }; }, applyMailserverTls: async (p) => { hooks.push(['dovecot', p]); return { path: '/etc/dovecot/conf.d/97-whm-mailserver.conf', validated: true, reload: { reloaded: true, unit: 'dovecot' } }; } };
    try {
      const res = await put('/api/ssl/tls-config', { preset: 'modern', hsts: { enabled: true, maxAge: 63_072_000, preload: true } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.settings).toMatchObject({ preset: 'modern', protocols: ['TLSv1.3'], hsts: { enabled: true, maxAge: 63_072_000, preload: true, includeSubdomains: true } });
      expect(res.body.data.applied.applied).toEqual(expect.arrayContaining(['apache', 'exim', 'dovecot']));
      const call = app.agent.callsTo('ssl.tls_config.apply').pop();
      // The agent only renders Apache; the Exim/Dovecot includes earlier builds wrote are removed.
      expect(call.args).toMatchObject({ services: ['apache'], removeLegacy: ['exim', 'dovecot'] });
      expect(call.args.policy.protocols).toEqual(['TLSv1.3']);
      expect(call.args.policy.hsts.enabled).toBe(true);
      expect(hooks.map(([svc]) => svc)).toEqual(['exim', 'dovecot']);
      expect(hooks[1][1]).toMatchObject({ minProtocol: 'TLSv1.3', protocols: ['TLSv1.3'], cipherList: TLS_PRESETS.modern.ciphers, cipherSuites: TLS_PRESETS.modern.ciphersuites, preferServerCiphers: false });
      expect(res.body.data.applied.results.dovecot).toMatchObject({ via: 'service-configuration', path: '/etc/dovecot/conf.d/97-whm-mailserver.conf' });
      expect((await get('/api/ssl/tls-config')).body.data.delegated).toEqual({ exim: true, dovecot: true });
    } finally { app.ctx.web = savedWeb; }
    // Without Service Configuration the mail daemons are reported pending; Exim falls back to this category's fragment.
    app.ctx.web = undefined;
    try {
      const res = await put('/api/ssl/tls-config', { preset: 'intermediate' });
      expect(res.status).toBe(200);
      expect(app.agent.callsTo('ssl.tls_config.apply').pop().args).toMatchObject({ services: ['apache', 'exim'], removeLegacy: ['dovecot'] });
      expect(res.body.data.applied.applied).toEqual(['apache', 'exim']);
      expect(res.body.data.applied.results.dovecot).toMatchObject({ pending: true, via: 'service-configuration' });
      const custom = await put('/api/ssl/tls-config', { protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'ECDHE-RSA-AES256-GCM-SHA384', services: ['apache'], apply: false });
      expect(custom.body.data.settings).toMatchObject({ preset: 'custom', ciphers: 'ECDHE-RSA-AES256-GCM-SHA384', services: ['apache'] });
      expect(custom.body.data.applied).toBeNull();
      const saved = await put('/api/ssl/tls-config', { preset: 'intermediate' });
      expect(saved.body.data.applied.applied).toEqual(['apache']);
      expect(app.agent.callsTo('ssl.tls_config.apply').pop().args.removeLegacy).toEqual([]);
    } finally { app.ctx.web = savedWeb; }
  });

  it('installs a certificate for a service and records it', async () => {
    const bad = await post('/api/ssl/service-certs/exim', { certPem: CERT, keyPem: OTHER_KEY });
    expect(bad.status).toBe(422);
    const res = await post('/api/ssl/service-certs/exim', { certPem: CERT, keyPem: KEY, chainPem: CHAIN });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.reload).toEqual({ reloaded: true, unit: 'exim' });
    const row = app.ctx.db.prepare('SELECT * FROM ssl_service_certs WHERE service = ?').get('exim');
    expect(row.cert_pem).toBe(CERT);
    expect(app.ctx.crypto.decrypt(row.key_enc)).toBe(KEY);
    const status = await get('/api/ssl/service-certs');
    expect(status.body.data.find((s) => s.service === 'exim').stored).toBeTruthy();
    expect(status.body.data.map((s) => s.service)).toEqual(['exim', 'dovecot', 'apache', 'ftp', 'panel']);
  });

  it('removeAccountCerts uninstalls every installed bundle (files, vhost, ACME client) before purging rows', async () => {
    const bobId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id;
    await post('/api/accounts', { username: 'bob', domain: 'bob.com' }).catch(() => {});
    app.ctx.db.prepare("INSERT OR IGNORE INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'www2.bob.com', 'sub', '/home/bob/public_html/www2')").run(bobId);
    expect((await post('/api/ssl/install', { domain: 'bob.com', certPem: CERT, keyPem: KEY })).status).toBe(200);
    expect((await post('/api/ssl/install', { domain: 'www2.bob.com', certPem: CERT, keyPem: KEY, force: true })).status).toBe(200);
    // One AutoSSL row too, so the ACME client is told to forget the name.
    app.ctx.db.prepare('UPDATE ssl_certs SET autossl = 1 WHERE domain = ? AND installed > 0').run('www2.bob.com');
    const installed = app.ctx.db.prepare('SELECT domain FROM ssl_certs WHERE account_id = ? AND installed > 0').all(bobId).map((r) => r.domain);
    expect(installed).toEqual(expect.arrayContaining(['bob.com', 'www2.bob.com']));
    const removedSsl = [];
    const savedWeb = app.ctx.web;
    app.ctx.web = { removeSsl: async (domain) => { removedSsl.push(domain); } };
    const before = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ssl_certs WHERE account_id = ?').get(bobId).n;
    expect(before).toBeGreaterThan(0);
    app.agent.calls.length = 0;
    // A bundle the agent cannot remove is reported, not fatal.
    app.agent.set('ssl.bundle.remove_for_domain', ({ domain }) => { if (domain === 'bob.com') throw agentError('command_failed', 'EBUSY'); return { domain, removed: true }; });
    let result;
    try { result = await app.ctx.ssl.removeAccountCerts(bobId); } finally { app.ctx.web = savedWeb; }
    expect(result.removed).toBe(before);
    expect(result.uninstalled).toEqual(['www2.bob.com']);
    expect(result.failed).toEqual([{ domain: 'bob.com', error: 'EBUSY' }]);
    expect(app.agent.callsTo('ssl.bundle.remove_for_domain').map((c) => c.args.domain).sort()).toEqual(['bob.com', 'www2.bob.com']);
    expect(removedSsl).toEqual(['www2.bob.com']);
    expect(app.agent.callsTo('ssl.acme.remove').map((c) => c.args)).toEqual([{ provider: 'certbot', name: 'www2.bob.com' }]);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ssl_certs WHERE account_id = ?').get(bobId).n).toBe(0);
    app.agent.set('ssl.bundle.remove_for_domain', ({ domain }) => ({ domain, removed: true }));
  });
});
