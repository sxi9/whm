import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp } from './support/app.js';
import { acceptedRequestId, isStreamRequest, httpsRedirectTarget, forceHttpsExempt } from '../src/app.js';
import { watchTlsFiles } from '../src/index.js';

// Phase 6 hardening of the web platform: headers on a plain-HTTP panel,
// limiter/log matching on the path only, raw upload bodies in the audit log,
// and brute-force protection on the second factor.
// The second-factor tests hash passwords and walk six login rounds; under a
// loaded full-suite run that passes vitest's 5 s default.
vi.setConfig({ testTimeout: 20_000 });
let app;
const PASSWORD = 'Test-Passw0rd!1';
beforeAll(async () => { app = await createTestApp(); });
afterAll(async () => { await app.close(); });

const fresh = () => request.agent(app.ctx.app);
// otplib verifies with a zero-step window; never generate a code at the end of a step.
async function freshStep() {
  if (authenticator.timeRemaining() < 6) await new Promise((r) => setTimeout(r, (authenticator.timeRemaining() + 0.5) * 1000));
}

describe('response headers', () => {
  it('sends a CSP without upgrade-insecure-requests and no HSTS when the panel has no TLS', async () => {
    const res = await fresh().get('/api/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('lets pages on other origins (the hostname landing page, account index pages) embed the branding images, and nothing else', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const csrf = await app.login();
    await app.http.post('/api/cpanel/branding/logo').set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(png).expect(201);
    try {
      const img = await fresh().get('/api/branding/logo').expect(200);
      expect(img.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(img.headers['content-security-policy']).toContain("default-src 'none'");
      expect((await fresh().get('/api/branding')).headers['cross-origin-resource-policy']).toBe('cross-origin');
      for (const url of ['/api/health', '/api/auth/me', '/api/cpanel/branding/logo']) expect((await fresh().get(url)).headers['cross-origin-resource-policy'], url).toBe('same-origin');
      expect((await fresh().post('/api/branding/logo').set('Content-Type', 'image/png').send(png)).headers['cross-origin-resource-policy']).toBe('same-origin');
    } finally { await app.http.delete('/api/cpanel/branding/logo').set('X-CSRF-Token', csrf); }
  });
});

describe('request ids and stream matching', () => {
  it('keeps a caller-supplied request id only when it is short and plain', () => {
    expect(acceptedRequestId('req-123.abc:4')).toBe('req-123.abc:4');
    expect(acceptedRequestId('')).toBeNull();
    expect(acceptedRequestId('x'.repeat(129))).toBeNull();
    expect(acceptedRequestId('bad id\n{"json":1}')).toBeNull();
    expect(acceptedRequestId(undefined)).toBeNull();
  });

  it('matches streams on the path, never on the query string', () => {
    expect(isStreamRequest({ originalUrl: '/api/system/jobs/1/stream' })).toBe(true);
    expect(isStreamRequest({ originalUrl: '/api/system/jobs/1/stream?since=0' })).toBe(true);
    expect(isStreamRequest({ originalUrl: '/api/accounts?x=/stream' })).toBe(false);
    expect(isStreamRequest({ originalUrl: '/api/accounts/stream/create' })).toBe(false);
    expect(isStreamRequest({ url: '/api/server-config/terminal/abc/stream' })).toBe(true);
  });
});

describe('audit log', () => {
  it('records a raw upload body as its size only', async () => {
    const csrf = await app.login();
    const body = Buffer.from('this is not a plugin package');
    const res = await app.http.post('/api/plugins/manage/install').set('X-CSRF-Token', csrf).set('Content-Type', 'application/gzip').send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 30));
    const row = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action LIKE '%/plugins/manage/install' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(row.args_redacted)).toEqual({ bytes: body.length });
  });

  it('records an empty raw body as zero bytes rather than nothing', async () => {
    const csrf = await app.login();
    const res = await app.http.post('/api/plugins/manage/install').set('X-CSRF-Token', csrf).set('Content-Type', 'application/gzip').send(Buffer.alloc(0));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 30));
    const row = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action LIKE '%/plugins/manage/install' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(row.args_redacted)).toEqual({ bytes: 0 });
  });
});

describe('second-factor brute force', () => {
  const enable = (username) => {
    const secret = authenticator.generateSecret();
    app.ctx.db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 1 WHERE username = ?').run(app.ctx.crypto.encrypt(secret), username);
    return secret;
  };
  beforeEach(() => {
    app.ctx.settings.set('security.cphulk.enabled', false);
    app.ctx.db.prepare('DELETE FROM login_attempts').run();
  });

  it('pauses the user after five wrong codes, even for the right code, and audits it', async () => {
    const secret = enable('root');
    const agent = fresh();
    const login = await agent.post('/api/auth/login').send({ username: 'root', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.requires2fa).toBe(true);
    for (let i = 0; i < 5; i++) {
      const r = await agent.post('/api/auth/2fa').send({ code: String(100000 + i) });
      expect(r.status).toBe(401);
    }
    await freshStep();
    const locked = await agent.post('/api/auth/2fa').send({ code: authenticator.generate(secret) });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('locked_out');
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.2fa.locked' AND target = 'root'").get().n).toBe(1);
    // The lock is per user: another user's second factor still works from the same address.
    const other = await app.createUser('secondfactor', 'reseller');
    const otherSecret = enable('secondfactor');
    const b = fresh();
    expect((await b.post('/api/auth/login').send({ username: 'secondfactor', password: other.password })).body.data.requires2fa).toBe(true);
    await freshStep();
    expect((await b.post('/api/auth/2fa').send({ code: authenticator.generate(otherSecret) })).status).toBe(200);
  });

  it('never accepts the same code twice', async () => {
    const user = await app.createUser('replayer', 'reseller');
    const secret = enable('replayer');
    await freshStep();
    const code = authenticator.generate(secret);
    const a = fresh();
    expect((await a.post('/api/auth/login').send({ username: 'replayer', password: user.password })).body.data.requires2fa).toBe(true);
    expect((await a.post('/api/auth/2fa').send({ code })).status).toBe(200);
    const b = fresh();
    expect((await b.post('/api/auth/login').send({ username: 'replayer', password: user.password })).body.data.requires2fa).toBe(true);
    const replay = await b.post('/api/auth/2fa').send({ code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('unauthorized');
  });
});

// loadConfig only checks that both TLS paths are set; the files are read by
// start(), so a test panel "has TLS" without any certificate on disk.
const TLS = { tlsCert: '/etc/whm/tls/cert.pem', tlsKey: '/etc/whm/tls/key.pem' };

describe('HTTPS by default', () => {
  let tls;
  beforeAll(async () => { tls = await createTestApp({ overrides: TLS }); });
  afterAll(async () => { await tls.close(); });
  const plain = () => request.agent(tls.ctx.app);

  it('sends plain-HTTP requests to the TLS port with path and query intact', async () => {
    const res = await plain().get('/api/auth/me?x=1').set('Host', 'panel.example.com:2086');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://panel.example.com:2087/api/auth/me?x=1');
    expect((await plain().get('/some/page').set('Host', 'panel.example.com')).headers.location).toBe('https://panel.example.com:2087/some/page');
    expect((await plain().get('/').set('Host', '[::1]:2086')).headers.location).toBe('https://[::1]:2087/');
    expect((await plain().post('/api/auth/login').set('Host', '10.0.0.5').send({})).headers.location).toBe('https://10.0.0.5:2087/api/auth/login');
    expect(tls.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it('leaves the health probe and the ACME challenge on plain HTTP', async () => {
    expect((await plain().get('/api/health').set('Host', 'panel.example.com')).status).toBe(200);
    expect((await plain().get('/.well-known/acme-challenge/token123').set('Host', 'panel.example.com')).status).not.toBe(301);
    expect((await plain().get('/api/health?x=/stream').set('Host', 'panel.example.com')).status).toBe(200);
  });

  it('never echoes a host it cannot trust into the Location header', async () => {
    for (const host of ['evil.com/..@panel.example.com', 'a b', 'panel.example.com:2086:1', 'panel.example.com?x', 'panel\\example.com', '']) {
      const res = await plain().get('/api/auth/me').set('Host', host);
      expect(res.status, host).not.toBe(301);
      expect(res.headers.location, host).toBeUndefined();
    }
  });

  it('the setting panel.force_https turns the redirect off without a restart', async () => {
    tls.ctx.settings.set('panel.force_https', false);
    try {
      const res = await plain().get('/api/auth/me').set('Host', 'panel.example.com');
      expect(res.status).not.toBe(301);
      expect(res.headers.location).toBeUndefined();
    } finally { tls.ctx.settings.set('panel.force_https', true); }
    expect((await plain().get('/api/auth/me').set('Host', 'panel.example.com')).status).toBe(301);
  });

  it('WHM_FORCE_HTTPS=false and config.forceHttps override the setting', async () => {
    process.env.WHM_FORCE_HTTPS = 'false';
    let env;
    try { env = await createTestApp({ overrides: TLS }); } finally { delete process.env.WHM_FORCE_HTTPS; }
    try { expect((await request.agent(env.ctx.app).get('/api/auth/me').set('Host', 'panel.example.com')).status).not.toBe(301); } finally { await env.close(); }
    const cfg = await createTestApp({ overrides: { ...TLS, forceHttps: false } });
    try { expect((await request.agent(cfg.ctx.app).get('/api/auth/me').set('Host', 'panel.example.com')).status).not.toBe(301); } finally { await cfg.close(); }
  });

  it('a panel without TLS never redirects', async () => {
    const res = await fresh().get('/api/auth/me').set('Host', 'panel.example.com');
    expect(res.status).not.toBe(301);
    expect(res.headers.location).toBeUndefined();
  });

  it('redirect helpers', () => {
    expect(httpsRedirectTarget({ headers: { host: 'h.example.com:2086' }, originalUrl: '/a?b=1' }, 2087)).toBe('https://h.example.com:2087/a?b=1');
    expect(httpsRedirectTarget({ headers: { host: 'h.example.com' }, url: 'a' }, 2087)).toBe('https://h.example.com:2087/a');
    expect(httpsRedirectTarget({ headers: { host: '[2001:db8::1]' }, originalUrl: '/' }, 2087)).toBe('https://[2001:db8::1]:2087/');
    for (const host of ['', 'a/b', 'a b', 'h.example.com:1:2', 'h@example.com', 'h.example.com\n', 'ex ample']) expect(httpsRedirectTarget({ headers: { host }, originalUrl: '/' }, 2087), host).toBeNull();
    expect(forceHttpsExempt('/api/health')).toBe(true);
    expect(forceHttpsExempt('/.well-known/acme-challenge/abc')).toBe(true);
    expect(forceHttpsExempt('/api/healthz')).toBe(false);
    expect(forceHttpsExempt('/')).toBe(false);
  });

  it('watchTlsFiles swaps the secure context when the pair on disk changes, and never on a pair that does not load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-tls-'));
    const cert = path.join(dir, 'cert.pem');
    const key = path.join(dir, 'key.pem');
    fs.writeFileSync(cert, 'CERT-1');
    fs.writeFileSync(key, 'KEY-1');
    const contexts = [];
    const server = { setSecureContext: (o) => { if (o.cert.toString() === 'BROKEN') throw new Error('bad cert'); contexts.push([o.cert.toString(), o.key.toString(), o.minVersion]); } };
    const watch = watchTlsFiles({ server, cert, key, intervalMs: 0 });
    try {
      expect(watch.check()).toBe(false);
      fs.writeFileSync(cert, 'CERT-22');
      fs.writeFileSync(key, 'KEY-22');
      expect(watch.check()).toBe(true);
      expect(contexts).toEqual([['CERT-22', 'KEY-22', 'TLSv1.2']]);
      expect(watch.check()).toBe(false);
      fs.writeFileSync(cert, 'BROKEN');
      expect(watch.check()).toBe(false);
      fs.writeFileSync(cert, 'CERT-333');
      expect(watch.check()).toBe(true);
      expect(contexts).toHaveLength(2);
      fs.rmSync(key);
      expect(watch.check()).toBe(false);
      expect(contexts).toHaveLength(2);
    } finally { watch.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
