import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { redirectHostname } from '../src/middleware/tls-redirect.js';
import { httpRedirectEnabled } from '../src/config.js';

// bootstrap() never opens the certificate files (only start() does), so a
// placeholder pair is enough to flip config.tls on for the app.
const TLS = { tlsCert: '/nonexistent/panel.crt', tlsKey: '/nonexistent/panel.key', tlsPort: 2087 };
const PASSWORD = 'Test-Passw0rd!1';

describe('plain-HTTP guard with TLS configured', () => {
  let app;
  beforeAll(async () => { app = await createTestApp({ overrides: TLS }); });
  afterAll(async () => { await app.close(); });

  it('redirects navigations to the https port, keeping only the hostname', async () => {
    const res = await request(app.ctx.app).get('/').set('Host', 'panel.example.com:2086');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://panel.example.com:2087/');
    const deep = await request(app.ctx.app).get('/login?next=%2Faccounts').set('Host', 'panel.example.com');
    expect(deep.status).toBe(301);
    expect(deep.headers.location).toBe('https://panel.example.com:2087/login?next=%2Faccounts');
    const head = await request(app.ctx.app).head('/').set('Host', '[::1]:2086');
    expect(head.status).toBe(301);
    expect(head.headers.location).toBe('https://[::1]:2087/');
  });

  it('refuses rather than redirects when the Host header is not a plain hostname', async () => {
    const res = await request(app.ctx.app).get('/').set('Host', 'evil.example/path');
    expect(res.status).toBe(426);
    expect(res.body.error.code).toBe('tls_required');
  });

  it('refuses credentials and API calls in clear without reading the body', async () => {
    const login = await request(app.ctx.app).post('/api/auth/login').set('Host', 'panel.example.com').send({ username: 'root', password: PASSWORD });
    expect(login.status).toBe(426);
    expect(login.body).toEqual({ error: { code: 'tls_required', message: 'Use https on port 2087' } });
    expect(login.headers['set-cookie']).toBeUndefined();
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n).toBe(0);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
    const csrf = await request(app.ctx.app).get('/api/auth/csrf').set('Host', 'panel.example.com');
    expect(csrf.status).toBe(426);
    expect(csrf.headers.location).toBeUndefined();
    const put = await request(app.ctx.app).put('/anything').set('Host', 'panel.example.com').send({});
    expect(put.status).toBe(426);
  });

  it('keeps GET /api/health answering in clear for monitors', async () => {
    const res = await request(app.ctx.app).get('/api/health').set('Host', 'panel.example.com');
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    const post = await request(app.ctx.app).post('/api/health').set('Host', 'panel.example.com');
    expect(post.status).toBe(426);
  });

  it('ignores X-Forwarded-Proto from loopback: only a TLS socket passes', async () => {
    const login = await request(app.ctx.app).post('/api/auth/login').set('Host', 'panel.example.com').set('X-Forwarded-Proto', 'https').send({ username: 'root', password: PASSWORD });
    expect(login.status).toBe(426);
    expect(login.body.error.code).toBe('tls_required');
    expect(login.headers['set-cookie']).toBeUndefined();
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
    const nav = await request(app.ctx.app).get('/').set('Host', 'panel.example.com').set('X-Forwarded-Proto', 'https');
    expect(nav.status).toBe(301);
    expect(nav.headers.location).toBe('https://panel.example.com:2087/');
    const csrf = await request(app.ctx.app).get('/api/auth/csrf').set('Host', 'panel.example.com').set('X-Forwarded-Proto', 'https').set('X-Forwarded-For', '203.0.113.9');
    expect(csrf.status).toBe(426);
  });
});

describe('plain-HTTP guard switched off', () => {
  let app;
  beforeAll(async () => { app = await createTestApp({ overrides: { ...TLS, httpRedirect: false } }); });
  afterAll(async () => { await app.close(); });

  it('serves the full panel on the plain port', async () => {
    expect((await request(app.ctx.app).get('/').set('Host', 'panel.example.com')).status).not.toBe(301);
    const login = await request(app.ctx.app).post('/api/auth/login').set('Host', 'panel.example.com').send({ username: 'root', password: PASSWORD });
    expect(login.status).toBe(200);
  });
});

describe('without TLS (development)', () => {
  let app;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => { await app.close(); });

  it('is unchanged: no redirect, API served in clear', async () => {
    expect(app.ctx.config.tls).toBe(false);
    expect(app.ctx.config.httpRedirect).toBe(true);
    expect((await request(app.ctx.app).get('/').set('Host', 'panel.example.com')).status).not.toBe(301);
    expect((await request(app.ctx.app).get('/api/auth/csrf')).status).toBe(200);
    const login = await request(app.ctx.app).post('/api/auth/login').send({ username: 'root', password: PASSWORD });
    expect(login.status).toBe(200);
  });
});

describe('WHM_HTTP_REDIRECT / httpRedirect parsing', () => {
  it('is off only for an explicit false/0/no/off, on for anything else', () => {
    for (const off of ['false', 'FALSE', ' False ', '0', 'no', 'off', 'Off', false, 0]) expect(httpRedirectEnabled(off), String(off)).toBe(false);
    for (const on of ['true', '1', 'yes', 'on', 'flase', 'disabled', 'null', '', ' ', undefined, null, true, 1, {}]) expect(httpRedirectEnabled(on), String(on)).toBe(true);
  });

  it('reaches config from the environment and from a whm.conf string', async () => {
    const { loadConfig } = await import('../src/config.js');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-redirect-'));
    const conf = path.join(dataDir, 'whm.conf');
    const saved = { redirect: process.env.WHM_HTTP_REDIRECT, config: process.env.WHM_CONFIG };
    const withConf = (value) => { fs.writeFileSync(conf, JSON.stringify(value === undefined ? {} : { httpRedirect: value })); return loadConfig({ dataDir }).httpRedirect; };
    try {
      process.env.WHM_CONFIG = conf;
      delete process.env.WHM_HTTP_REDIRECT;
      expect(withConf(undefined)).toBe(true);
      expect(withConf('no')).toBe(false);
      expect(withConf(false)).toBe(false);
      expect(withConf('nope')).toBe(true);
      process.env.WHM_HTTP_REDIRECT = 'off';
      expect(withConf(true)).toBe(false);
      process.env.WHM_HTTP_REDIRECT = 'fasle';
      expect(withConf(false)).toBe(true);
    } finally {
      for (const [key, value] of [['WHM_HTTP_REDIRECT', saved.redirect], ['WHM_CONFIG', saved.config]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('redirectHostname', () => {
  it('accepts hostnames and IP literals, never a port or path from the client', () => {
    expect(redirectHostname('panel.example.com')).toBe('panel.example.com');
    expect(redirectHostname('panel.example.com:9999')).toBe('panel.example.com');
    expect(redirectHostname('203.0.113.7:2086')).toBe('203.0.113.7');
    expect(redirectHostname('[2001:db8::1]:2086')).toBe('[2001:db8::1]');
    expect(redirectHostname('')).toBeNull();
    expect(redirectHostname(undefined)).toBeNull();
    expect(redirectHostname('evil.example/path')).toBeNull();
    expect(redirectHostname('a b')).toBeNull();
    expect(redirectHostname('host:2087@evil.example')).toBeNull();
    expect(redirectHostname('-bad.example')).toBeNull();
    expect(redirectHostname('host\r\nLocation: x')).toBeNull();
  });
});
