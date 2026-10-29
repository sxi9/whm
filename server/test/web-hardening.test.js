import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { createTestApp } from './support/app.js';
import { acceptedRequestId, isStreamRequest } from '../src/app.js';

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
