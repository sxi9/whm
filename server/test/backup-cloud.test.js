import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { pkceChallenge, authorizationUrl, fetchJson, PROVIDERS } from '../src/services/backup-cloud.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

// A host with tar, curl and rclone. Legacy (curl/S3) ops and rclone ops keep
// separate stores so a test can prove which transport carried a copy; the
// rclone upload for a freshly connected Google account reports a rotated
// refresh token once, like a provider that rotates on refresh.
function cloudAgent() {
  const disk = new Map();
  const plain = new Map();
  const cloud = new Map();
  let counter = 0;
  const agentErr = (message, code = 'destination_failed') => Object.assign(new Error(message), { agentError: true, code, details: {} });
  const archiveName = (username) => { counter += 1; return `backup-10.26.2026_02-00-${String(counter).padStart(2, '0')}_${username}.tar.gz`; };
  const rcloneKey = (config, n) => `${config.kind}:${config.crypt ? 'crypt' : 'plain'}:${n}`;
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['tar', 'gzip', 'curl', 'rclone', 'systemctl', 'useradd', 'usermod', 'userdel', 'chpasswd'].includes(n)])),
    'fs.mkdir': ({ path }) => ({ path }),
    'fs.stat': ({ path }) => (disk.has(path) ? { path, exists: true, isDirectory: false, size: disk.get(path).sizeBytes } : path === '/backup' ? { path, exists: true, isDirectory: true, mode: '700' } : { path, exists: false }),
    'backup.account.archive': ({ username, dest, include }) => {
      const file = `${dest}/${archiveName(username)}`;
      disk.set(file, { sizeBytes: 4096, sha256: 'a'.repeat(64), username });
      return { path: file, name: file.split('/').pop(), top: 'x', sizeBytes: 4096, sha256: 'a'.repeat(64), sha256File: `${file}.sha256`, components: { home: { included: include.home }, mysql: [], users: 0, dnszones: [], metadata: true }, warnings: [], durationMs: 5 };
    },
    'backup.archive.list': ({ dir }) => ({ dir, exists: true, archives: [] }),
    'backup.archive.verify': ({ archive, sha256 }) => { const a = disk.get(archive); if (!a) throw agentErr(`${archive} does not exist`, 'not_found'); return { path: archive, sha256: a.sha256, expected: sha256 ?? null, ok: sha256 ? a.sha256 === sha256 : null, sizeBytes: a.sizeBytes }; },
    'backup.archive.info': ({ archive }) => { const a = disk.get(archive); if (!a) throw agentErr('missing', 'not_found'); return { path: archive, top: 'x', username: a.username, sizeBytes: a.sizeBytes, info: { version: 1, createdAt: '2026-10-25T02:00:00.000Z' }, metadata: null, components: { home: true, mysql: [], users: false, dnszones: [] } }; },
    'backup.archive.remove': ({ archive }) => ({ path: archive, removed: disk.delete(archive) }),
    'backup.destination.test': ({ config }) => ({ ok: true, message: `probe ok on ${config.kind}`, ms: 3 }),
    'backup.destination.upload': ({ config, file }) => { const n = file.split('/').pop(); plain.set(`${config.kind}:${n}`, disk.get(file)); return { kind: config.kind, name: n, remotePath: `s3://${config.bucket}/${n}`, sizeBytes: 4096, encrypted: false, ms: 2 }; },
    'backup.destination.download': ({ config, remoteName, dest }) => { const a = plain.get(`${config.kind}:${remoteName}`); if (!a) throw agentErr('download: not there'); disk.set(`${dest}/${remoteName}`, a); return { path: `${dest}/${remoteName}`, name: remoteName, sizeBytes: a.sizeBytes, sha256: a.sha256, ms: 2 }; },
    'backup.destination.list': ({ config }) => ({ kind: config.kind, encrypted: false, archives: [...plain].filter(([k]) => k.startsWith(`${config.kind}:`)).map(([k, a]) => ({ name: k.split(':')[1], sizeBytes: a.sizeBytes, mtime: null, username: a.username })) }),
    'backup.destination.remove': ({ config, remoteName }) => ({ kind: config.kind, name: remoteName, removed: plain.delete(`${config.kind}:${remoteName}`) }),
    'backup.rclone.test': ({ config }) => ({ ok: true, message: `probe ok via rclone on ${config.kind}${config.crypt ? ' (encrypted)' : ''}`, encrypted: Boolean(config.crypt), ms: 3, tokenUpdate: null }),
    'backup.rclone.upload': ({ config, file }) => {
      const n = file.split('/').pop();
      cloud.set(rcloneKey(config, n), disk.get(file));
      return { kind: config.kind, name: n, remotePath: `${config.kind}://${config.folder || config.bucket}/${n}${config.crypt ? ' (encrypted)' : ''}`, sizeBytes: 4096, encrypted: Boolean(config.crypt), ms: 2, tokenUpdate: config.kind === 'gdrive' && config.refreshToken === 'rt-1' ? { refreshToken: 'rt-2' } : null };
    },
    'backup.rclone.download': ({ config, remoteName, dest }) => { const a = cloud.get(rcloneKey(config, remoteName)); if (!a) throw agentErr(`download from ${config.kind}: file not found`); disk.set(`${dest}/${remoteName}`, a); return { path: `${dest}/${remoteName}`, name: remoteName, sizeBytes: a.sizeBytes, sha256: a.sha256, encrypted: Boolean(config.crypt), ms: 2, tokenUpdate: null }; },
    'backup.rclone.list': ({ config }) => ({ kind: config.kind, encrypted: Boolean(config.crypt), archives: [...cloud].filter(([k]) => k.startsWith(`${config.kind}:${config.crypt ? 'crypt' : 'plain'}:`)).map(([k, a]) => ({ name: k.split(':')[2], sizeBytes: a.sizeBytes, mtime: null, username: a.username })), tokenUpdate: null }),
    'backup.rclone.delete': ({ config, remoteName }) => ({ kind: config.kind, name: remoteName, removed: cloud.delete(rcloneKey(config, remoteName)), tokenUpdate: null }),
    'user.get': () => null,
    'user.delete': ({ username }) => ({ username, existed: true }),
  };
  const agent = createMockAgent(ops);
  agent.disk = disk;
  agent.plain = plain;
  agent.cloud = cloud;
  return agent;
}

// The three providers' token and profile endpoints behind a fetch() stub.
function fakeProviders() {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) });
  const fetch = async (url, init = {}) => {
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ url, method: init.method || 'GET', form, auth: init.headers?.Authorization || null, redirect: init.redirect });
    if (url === 'https://oauth2.googleapis.com/token') return form.code === 'bad-code' ? reply(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' }) : reply(200, { access_token: 'at-google', refresh_token: form.code === 'no-refresh' ? undefined : 'rt-1', expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file' });
    if (url.startsWith('https://www.googleapis.com/drive/v3/about')) return reply(200, { user: { displayName: 'Alice Example', emailAddress: 'alice@example.com' } });
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') return reply(200, { access_token: 'at-ms', refresh_token: 'rt-ms-1', expires_in: 3600, token_type: 'Bearer' });
    if (url === 'https://graph.microsoft.com/v1.0/me') return reply(200, { displayName: 'Bob Example', userPrincipalName: 'bob@contoso.com', mail: 'bob@contoso.com' });
    if (url === 'https://graph.microsoft.com/v1.0/me/drive') return reply(200, { id: 'b!abc123', driveType: 'business' });
    if (url === 'https://api.dropboxapi.com/oauth2/token') return reply(200, { access_token: 'at-dbx', refresh_token: 'rt-dbx-1', token_type: 'bearer' });
    if (url === 'https://api.dropboxapi.com/2/users/get_current_account') return reply(200, { name: { display_name: 'Carol Example' }, email: 'carol@example.com' });
    if (url === 'https://redirect.example.com/') return { ok: false, status: 302, headers: new Headers({ location: 'https://evil.example.com/' }), text: async () => '' };
    return reply(404, { error: 'not_found' });
  };
  return { calls, fetch };
}

const SECRETS = ['google-secret', 'ms-secret', 'dbx-secret', 'rt-1', 'rt-2', 'rt-ms-1', 'rt-dbx-1', 'at-google', 'at-ms', 'at-dbx'];

describe('migration 039', () => {
  it('widens the destination kinds and keeps upload links and the FK across the table rebuild', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files.filter((n) => n < '039')) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    db.prepare("INSERT INTO backup_destinations (id, name, kind, config_enc, enabled, last_test_ok) VALUES (1, 'offsite', 's3', 'v1:x', 1, 1)").run();
    db.prepare("INSERT INTO backups (id, account_name, type, destination_id, path, status) VALUES (5, 'alice', 'full', 1, '/backup/a.tar.gz', 'done')").run();
    db.prepare("INSERT INTO backups (id, account_name, type, path, status) VALUES (6, 'bob', 'full', '/backup/b.tar.gz', 'done')").run();
    db.prepare("INSERT INTO backup_uploads (backup_id, destination_id, destination_name, remote_path, status) VALUES (5, 1, 'offsite', 's3://x/a', 'done')").run();
    db.prepare("INSERT INTO backup_uploads (backup_id, destination_id, destination_name, remote_path, status) VALUES (5, NULL, 'gone', NULL, 'failed')").run();
    db.transaction(() => db.exec(fs.readFileSync(path.join(MIGRATIONS, '039_backup-cloud.sql'), 'utf8')))();
    expect(db.prepare('SELECT destination_id, encrypted FROM backup_uploads ORDER BY id').all()).toEqual([{ destination_id: 1, encrypted: 0 }, { destination_id: null, encrypted: 0 }]);
    expect(db.prepare('SELECT id, destination_id FROM backups ORDER BY id').all()).toEqual([{ id: 5, destination_id: 1 }, { id: 6, destination_id: null }]);
    expect(db.prepare('SELECT id, name, kind, enabled, last_test_ok, last_upload_ok FROM backup_destinations').get()).toEqual({ id: 1, name: 'offsite', kind: 's3', enabled: 1, last_test_ok: 1, last_upload_ok: null });
    for (const kind of ['gdrive', 'onedrive', 'dropbox', 'azureblob', 'b2']) db.prepare('INSERT INTO backup_destinations (name, kind) VALUES (?, ?)').run(kind, kind);
    expect(() => db.prepare("INSERT INTO backup_destinations (name, kind) VALUES ('x', 'box')").run()).toThrow(/CHECK/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'backup_destinations%'").all()).toEqual([{ name: 'backup_destinations' }]);
    // The uploads FK follows the rebuilt table: deleting the destination nulls the link.
    db.prepare('DELETE FROM backup_destinations WHERE id = 1').run();
    expect(db.prepare('SELECT destination_id FROM backup_uploads WHERE id = 1').get().destination_id).toBeNull();
    expect(db.prepare('SELECT destination_id FROM backups WHERE id = 5').get().destination_id).toBeNull();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});

describe('backup cloud helpers', () => {
  it('derives the PKCE challenge like RFC 7636 and builds provider authorization URLs', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const google = new URL(authorizationUrl('gdrive', { clientId: 'cid', redirectUri: 'https://panel.example.com:2087/api/backup/destinations/oauth/gdrive/callback', state: 'st', codeChallenge: 'ch' }));
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(google.searchParams)).toMatchObject({ client_id: 'cid', response_type: 'code', state: 'st', code_challenge: 'ch', code_challenge_method: 'S256', scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent' });
    const ms = new URL(authorizationUrl('onedrive', { clientId: 'cid', redirectUri: 'x', state: 'st', codeChallenge: 'ch' }));
    expect(ms.searchParams.get('scope')).toBe('Files.ReadWrite offline_access User.Read');
    const dbx = new URL(authorizationUrl('dropbox', { clientId: 'cid', redirectUri: 'x', state: 'st', codeChallenge: 'ch' }));
    expect(dbx.searchParams.get('token_access_type')).toBe('offline');
    expect(dbx.searchParams.has('scope')).toBe(false);
    expect(PROVIDERS.map((p) => p.kind)).toEqual(['gdrive', 'onedrive', 'dropbox', 's3', 'azureblob', 'b2']);
  });

  it('fetchJson contacts https endpoints only, never follows redirects and summarises errors without the body', async () => {
    const realFetch = globalThis.fetch;
    const fake = fakeProviders();
    globalThis.fetch = fake.fetch;
    try {
      await expect(fetchJson('http://oauth2.googleapis.com/token')).rejects.toThrow(/https/);
      await expect(fetchJson('https://redirect.example.com/')).rejects.toThrow(/redirect/);
      await expect(fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', body: 'code=bad-code' })).rejects.toThrow('HTTP 400 invalid_grant: Malformed auth code.');
      expect(fake.calls.every((c) => c.redirect === 'manual')).toBe(true);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('Backup cloud API', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;
  let fake;
  const realFetch = globalThis.fetch;
  const get = (p) => app.http.get(`/api/backup${p}`);
  const post = (p, body = {}) => app.http.post(`/api/backup${p}`).set('X-CSRF-Token', csrf).send(body);
  const put = (p, body = {}) => app.http.put(`/api/backup${p}`).set('X-CSRF-Token', csrf).send(body);
  const del = (p) => app.http.delete(`/api/backup${p}`).set('X-CSRF-Token', csrf);
  const auditText = () => JSON.stringify(app.ctx.db.prepare('SELECT action, target, args_redacted FROM audit_log').all());
  const startFlow = async (provider, id) => {
    const res = await get(`/destinations/oauth/${provider}/start?destination=${id}`).expect(302);
    return new URL(res.headers.location);
  };
  const callback = (provider, params) => get(`/destinations/oauth/${provider}/callback?${new URLSearchParams(params).toString()}`);
  let gdriveId;

  beforeAll(async () => {
    app = await createTestApp({ agent: cloudAgent() });
    csrf = await app.login();
    app.ctx.jobs.start();
    const reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com' }).expect(201);
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    fake = fakeProviders();
    globalThis.fetch = fake.fetch;
  });
  afterAll(async () => { globalThis.fetch = realFetch; await app.close(); });
  beforeEach(() => { app.agent.calls.length = 0; fake.calls.length = 0; });

  it('lists the provider catalog with the OAuth client state and the rclone capability', async () => {
    const res = await get('/destinations/providers').expect(200);
    expect(res.body.data.rclone).toEqual({ installed: true });
    expect(res.body.data.providers.map((p) => [p.kind, p.auth])).toEqual([['gdrive', 'oauth'], ['onedrive', 'oauth'], ['dropbox', 'oauth'], ['s3', 'keys'], ['azureblob', 'keys'], ['b2', 'keys']]);
    const gdrive = res.body.data.providers.find((p) => p.kind === 'gdrive');
    expect(gdrive.oauth).toMatchObject({ configured: false, app: null });
    expect(gdrive.oauth.redirectUri).toMatch(/^https?:\/\/[^/]+\/api\/backup\/destinations\/oauth\/gdrive\/callback$/);
    expect(res.body.data.providers.find((p) => p.kind === 's3').oauth).toBeNull();
    expect((await get('/status').expect(200)).body.data.capability.binaries.rclone).toBe(true);
  });

  it('registers OAuth clients with the secret encrypted, keeps it on a blank update and never returns it', async () => {
    const res = await put('/destinations/oauth-apps/gdrive', { clientId: '123.apps.googleusercontent.com', clientSecret: 'google-secret' }).expect(200);
    expect(res.body.data).toMatchObject({ provider: 'gdrive', clientId: '123.apps.googleusercontent.com', hasClientSecret: true });
    expect(res.body.data.redirectUri).toMatch(/\/api\/backup\/destinations\/oauth\/gdrive\/callback$/);
    expect(JSON.stringify(res.body)).not.toContain('google-secret');
    const row = app.ctx.db.prepare('SELECT client_secret_enc FROM backup_oauth_apps WHERE provider = ?').get('gdrive');
    expect(row.client_secret_enc.startsWith('v1:')).toBe(true);
    await put('/destinations/oauth-apps/gdrive', { clientId: '456.apps.googleusercontent.com' }).expect(200);
    expect(app.ctx.backupCloud.agentConfig({ kind: 'gdrive', refreshToken: 'x', folder: '' })).toMatchObject({ clientId: '456.apps.googleusercontent.com', clientSecret: 'google-secret' });
    const first = await put('/destinations/oauth-apps/onedrive', { clientId: 'ms-client' }).expect(422);
    expect(first.body.error.fields.clientSecret).toBeDefined();
    await put('/destinations/oauth-apps/onedrive', { clientId: 'ms-client', clientSecret: '"quoted"' }).expect(422);
    await put('/destinations/oauth-apps/box', { clientId: 'x', clientSecret: 'y' }).expect(422);
    const list = await get('/destinations/oauth-apps').expect(200);
    expect(list.body.data.map((a) => [a.provider, a.hasClientSecret])).toEqual([['gdrive', true], ['onedrive', false], ['dropbox', false]]);
    expect(JSON.stringify(list.body)).not.toContain('google-secret');
    expect((await get('/destinations/providers').expect(200)).body.data.providers.find((p) => p.kind === 'gdrive').oauth.configured).toBe(true);
    expect(auditText()).toContain('backup.oauth_app.set');
    expect(auditText()).not.toContain('google-secret');
  });

  it('creates a Google Drive destination encrypted by default and shows the encryption key once', async () => {
    const res = await post('/destinations', { name: 'gdrive-main', config: { kind: 'gdrive', folder: 'hst/backups' } }).expect(201);
    gdriveId = res.body.data.id;
    expect(res.body.data).toMatchObject({ name: 'gdrive-main', kind: 'gdrive', enabled: true, encrypted: true, engine: 'rclone', connection: { connected: false, account: null }, config: { folder: 'hst/backups', crypt: true, has_crypt_password: true, has_crypt_password2: true } });
    const key = res.body.data.encryptionKey;
    expect(key.cryptPassword).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(key.cryptPassword2).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(key.fileName).toBe('hst-backup-key-gdrive-main.txt');
    expect(key.text).toContain(`Password:  ${key.cryptPassword}`);
    expect(key.text).toContain(`Salt:      ${key.cryptPassword2}`);
    expect(app.ctx.backup.destinationConfig(gdriveId)).toMatchObject({ kind: 'gdrive', crypt: true, cryptPassword: key.cryptPassword, cryptPassword2: key.cryptPassword2 });
    // Shown once: the list and later reads never carry the key, nor does the audit log.
    const list = await get('/destinations').expect(200);
    expect(list.body.data[0]).not.toHaveProperty('encryptionKey');
    expect(JSON.stringify(list.body)).not.toContain(key.cryptPassword);
    expect(auditText()).not.toContain(key.cryptPassword);
    expect(auditText()).not.toContain(key.cryptPassword2);
    // Encryption cannot be switched off, and an unconnected OAuth destination cannot be tested.
    const off = await put(`/destinations/${gdriveId}`, { config: { kind: 'gdrive', folder: 'hst/backups', crypt: false } }).expect(409);
    expect(off.body.error.message).toMatch(/cannot be turned off/);
    expect((await post(`/destinations/${gdriveId}/test`).expect(409)).body.error.message).toMatch(/not connected/);
    await post('/destinations/test', { config: { kind: 'gdrive', folder: 'x' } }).expect(409);
    // A plain local copy stays plain unless asked; a folder update keeps the key.
    const local = await post('/destinations', { name: 'local-copy', enabled: false, config: { kind: 'local', dir: '/backup/offsite' } }).expect(201);
    expect(local.body.data).toMatchObject({ encrypted: false, engine: 'copy' });
    expect(local.body.data).not.toHaveProperty('encryptionKey');
    const renamed = await put(`/destinations/${gdriveId}`, { config: { kind: 'gdrive', folder: 'hst/backups-2' } }).expect(200);
    expect(renamed.body.data.config.folder).toBe('hst/backups-2');
    expect(renamed.body.data).not.toHaveProperty('encryptionKey');
    expect(app.ctx.backup.destinationConfig(gdriveId).cryptPassword).toBe(key.cryptPassword);
  });

  it('starts the OAuth flow with state and PKCE kept in the session', async () => {
    const url = await startFlow('gdrive', gdriveId);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({ client_id: '456.apps.googleusercontent.com', response_type: 'code', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' });
    expect(q.redirect_uri).toMatch(/^http:\/\/[^/]+\/api\/backup\/destinations\/oauth\/gdrive\/callback$/);
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(q)).not.toContain('google-secret');
    // The flow belongs to the destination's provider and needs a registered client.
    await get(`/destinations/oauth/onedrive/start?destination=${gdriveId}`).expect(400);
    const dbx = await post('/destinations', { name: 'dropbox-main', enabled: false, config: { kind: 'dropbox', folder: 'Apps/HST' } }).expect(201);
    const noApp = await get(`/destinations/oauth/dropbox/start?destination=${dbx.body.data.id}`).expect(409);
    expect(noApp.body.error.message).toMatch(/No OAuth client is registered for Dropbox/);
    await get('/destinations/oauth/gdrive/start?destination=999').expect(404);
    await get('/destinations/oauth/box/start?destination=1').expect(422);
  });

  it('completes the callback server-side, stores the refresh token encrypted and never exposes it', async () => {
    const start = await startFlow('gdrive', gdriveId);
    const state = start.searchParams.get('state');
    // A tampered or unknown state is refused before anything is exchanged.
    const wrong = await callback('gdrive', { code: 'good', state: `${state}x` }).expect(302);
    expect(wrong.headers.location).toMatch(/^\/backup\/backup-configuration\?cloud=error&message=/);
    expect(fake.calls).toHaveLength(0);
    // The refused attempt consumed the pending state, so the flow restarts.
    const again = await startFlow('gdrive', gdriveId);
    const res = await callback('gdrive', { code: 'good-code', state: again.searchParams.get('state') }).expect(302);
    expect(res.headers.location).toBe(`/backup/backup-configuration?cloud=connected&destination=${gdriveId}`);
    const token = fake.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
    expect(token.form).toMatchObject({ grant_type: 'authorization_code', code: 'good-code', client_id: '456.apps.googleusercontent.com', client_secret: 'google-secret' });
    expect(token.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(token.form.redirect_uri).toBe(again.searchParams.get('redirect_uri'));
    expect(fake.calls.find((c) => c.url.startsWith('https://www.googleapis.com/drive/v3/about')).auth).toBe('Bearer at-google');
    const dest = (await get('/destinations').expect(200)).body.data.find((d) => d.id === gdriveId);
    expect(dest.connection).toMatchObject({ connected: true, account: 'Alice Example', email: 'alice@example.com' });
    expect(dest.config).toMatchObject({ has_refresh_token: true, accountName: 'Alice Example' });
    expect(app.ctx.backup.destinationConfig(gdriveId)).toMatchObject({ refreshToken: 'rt-1', accountName: 'Alice Example', connectedAt: expect.any(String) });
    expect(app.ctx.db.prepare('SELECT config_enc FROM backup_destinations WHERE id = ?').get(gdriveId).config_enc).toMatch(/^v1:/);
    for (const s of SECRETS) {
      expect(JSON.stringify(dest), s).not.toContain(s);
      expect(auditText(), s).not.toContain(s);
    }
    expect(auditText()).toContain('backup.destination.connect');
    // A replayed callback has no pending request; a provider error goes back to the page.
    const replay = await callback('gdrive', { code: 'good-code', state: again.searchParams.get('state') }).expect(302);
    expect(replay.headers.location).toMatch(/cloud=error/);
    await startFlow('gdrive', gdriveId);
    const denied = await callback('gdrive', { error: 'access_denied', error_description: 'The user denied access' }).expect(302);
    expect(decodeURIComponent(denied.headers.location)).toContain('cloud=error&message=The+user+denied+access');
    // A rejected code and a consent without refresh token are reported, not stored.
    const s1 = (await startFlow('gdrive', gdriveId)).searchParams.get('state');
    expect(decodeURIComponent((await callback('gdrive', { code: 'bad-code', state: s1 }).expect(302)).headers.location)).toContain('invalid_grant');
    const s2 = (await startFlow('gdrive', gdriveId)).searchParams.get('state');
    expect(decodeURIComponent((await callback('gdrive', { code: 'no-refresh', state: s2 }).expect(302)).headers.location)).toContain('no+refresh+token');
    expect(app.ctx.backup.destinationConfig(gdriveId).refreshToken).toBe('rt-1');
    // The connected test probe runs through rclone with the client merged in.
    const probe = await post(`/destinations/${gdriveId}/test`).expect(200);
    expect(probe.body.data).toMatchObject({ ok: true, encrypted: true, destination: { lastTest: { ok: true } } });
    expect(probe.body.data).not.toHaveProperty('tokenUpdate');
    expect(app.agent.callsTo('backup.rclone.test')[0].args.config).toMatchObject({ kind: 'gdrive', clientId: '456.apps.googleusercontent.com', clientSecret: 'google-secret', refreshToken: 'rt-1', crypt: true, folder: 'hst/backups-2' });
    expect(app.agent.callsTo('backup.rclone.test')[0].args.config).not.toHaveProperty('accountName');
    expect(app.agent.callsTo('backup.rclone.test')[0].args.config).not.toHaveProperty('connectedAt');
  });

  it('OneDrive keeps the drive id and type from Graph, Dropbox the account', async () => {
    await put('/destinations/oauth-apps/onedrive', { clientId: 'ms-client', clientSecret: 'ms-secret' }).expect(200);
    await put('/destinations/oauth-apps/dropbox', { clientId: 'dbx-client', clientSecret: 'dbx-secret' }).expect(200);
    const od = await post('/destinations', { name: 'onedrive-main', enabled: false, config: { kind: 'onedrive', folder: 'Backups/HST' } }).expect(201);
    const odState = (await startFlow('onedrive', od.body.data.id)).searchParams.get('state');
    expect((await callback('onedrive', { code: 'c', state: odState }).expect(302)).headers.location).toContain('cloud=connected');
    expect(app.ctx.backup.destinationConfig(od.body.data.id)).toMatchObject({ refreshToken: 'rt-ms-1', driveId: 'b!abc123', driveType: 'business', accountName: 'Bob Example' });
    const dbxId = (await get('/destinations').expect(200)).body.data.find((d) => d.name === 'dropbox-main').id;
    const dbxState = (await startFlow('dropbox', dbxId)).searchParams.get('state');
    expect((await callback('dropbox', { code: 'c', state: dbxState }).expect(302)).headers.location).toContain('cloud=connected');
    expect(app.ctx.backup.destinationConfig(dbxId)).toMatchObject({ refreshToken: 'rt-dbx-1', accountName: 'Carol Example' });
    expect(app.ctx.backupCloud.agentConfig(app.ctx.backup.destinationConfig(od.body.data.id))).toMatchObject({ kind: 'onedrive', clientId: 'ms-client', clientSecret: 'ms-secret', driveId: 'b!abc123' });
    for (const s of SECRETS) expect(auditText(), s).not.toContain(s);
  });

  it('uploads through rclone with the OAuth client merged in, records encrypted copies and stores a rotated token', async () => {
    const run = await post('/runs', { accounts: ['alice'] }).expect(202);
    const job = await waitForJob(app.ctx, run.body.data.job.id);
    expect(job.status).toBe('done');
    const uploads = app.agent.callsTo('backup.rclone.upload');
    expect(uploads).toHaveLength(1);
    expect(uploads[0].args.config).toMatchObject({ kind: 'gdrive', clientId: '456.apps.googleusercontent.com', clientSecret: 'google-secret', refreshToken: 'rt-1', folder: 'hst/backups-2', crypt: true });
    expect(uploads[0].args.config.cryptPassword).toBe(app.ctx.backup.destinationConfig(gdriveId).cryptPassword);
    for (const k of ['accountName', 'accountEmail', 'connectedAt', 'cryptSince']) expect(uploads[0].args.config).not.toHaveProperty(k);
    expect(app.agent.callsTo('backup.destination.upload')).toHaveLength(0);
    const backup = (await get('/backups?account=alice').expect(200)).body.data[0];
    expect(backup.uploads).toEqual([expect.objectContaining({ destination: 'gdrive-main', status: 'done', encrypted: true, remote_path: expect.stringMatching(/^gdrive:\/\/hst\/backups-2\/.*\(encrypted\)$/) })]);
    expect(app.ctx.db.prepare('SELECT encrypted FROM backup_uploads WHERE backup_id = ?').get(backup.id).encrypted).toBe(1);
    const dest = (await get('/destinations').expect(200)).body.data.find((d) => d.id === gdriveId);
    expect(dest.lastUpload).toMatchObject({ ok: true, message: expect.stringContaining('alice') });
    // The provider rotated the refresh token during the upload: the stored one follows.
    expect(app.ctx.backup.destinationConfig(gdriveId).refreshToken).toBe('rt-2');
    expect(auditText()).toContain('backup.destination.token_rotated');
    expect(auditText()).not.toContain('rt-2');
    // Fetching it back decrypts through the same crypt remote.
    app.ctx.db.prepare('UPDATE backups SET local_present = 0 WHERE id = ?').run(backup.id);
    app.agent.disk.delete(backup.path);
    const fetch = await post(`/backups/${backup.id}/fetch`).expect(202);
    expect((await waitForJob(app.ctx, fetch.body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('backup.rclone.download')[0].args).toMatchObject({ remoteName: backup.name, dest: '/backup', config: { kind: 'gdrive', crypt: true, refreshToken: 'rt-2' } });
    expect(app.agent.callsTo('backup.destination.download')).toHaveLength(0);
    // Pruning it removes the ciphertext copy through rclone.
    const removed = await del(`/backups/${backup.id}`).expect(200);
    expect(removed.body.data.remote).toEqual([{ destination: 'gdrive-main', removed: true }]);
    expect(app.agent.callsTo('backup.rclone.delete')[0].args).toMatchObject({ remoteName: backup.name, config: { crypt: true } });
  });

  it('enables encryption on a plain S3 destination: earlier copies stay plain, new ones are ciphertext, each fetched through its own path', async () => {
    await put(`/destinations/${gdriveId}`, { enabled: false }).expect(200);
    const s3 = await post('/destinations', { name: 'offsite-s3', config: { kind: 's3', bucket: 'whm-backups', accessKey: 'AKIA', secretKey: 'topsecret', crypt: false } }).expect(201);
    const s3Id = s3.body.data.id;
    expect(s3.body.data).toMatchObject({ encrypted: false, engine: 'native' });
    expect(s3.body.data).not.toHaveProperty('encryptionKey');
    const first = await waitForJob(app.ctx, (await post('/runs', { accounts: ['alice'] }).expect(202)).body.data.job.id);
    expect(first.status).toBe('done');
    expect(app.agent.callsTo('backup.destination.upload')).toHaveLength(1);
    expect(app.agent.callsTo('backup.rclone.upload')).toHaveLength(0);
    const plainBackup = (await get('/backups?account=alice&sort=created_at&dir=desc').expect(200)).body.data[0];
    expect(plainBackup.uploads[0]).toMatchObject({ destination: 'offsite-s3', encrypted: false });

    const enabled = await post(`/destinations/${s3Id}/encryption`).expect(200);
    expect(enabled.body.data).toMatchObject({ encrypted: true, engine: 'rclone' });
    expect(enabled.body.data.encryptionKey.text).toContain('offsite-s3');
    expect(JSON.stringify(enabled.body)).not.toContain('topsecret');
    await post(`/destinations/${s3Id}/encryption`).expect(409);
    await put(`/destinations/${s3Id}`, { config: { kind: 's3', bucket: 'whm-backups', accessKey: 'AKIA', crypt: false } }).expect(409);
    expect(auditText()).toContain('backup.destination.encrypt');
    expect(auditText()).not.toContain(enabled.body.data.encryptionKey.cryptPassword);

    app.agent.calls.length = 0;
    const second = await waitForJob(app.ctx, (await post('/runs', { accounts: ['alice'] }).expect(202)).body.data.job.id);
    expect(second.status).toBe('done');
    expect(app.agent.callsTo('backup.destination.upload')).toHaveLength(0);
    expect(app.agent.callsTo('backup.rclone.upload')[0].args.config).toMatchObject({ kind: 's3', bucket: 'whm-backups', secretKey: 'topsecret', crypt: true, cryptPassword: enabled.body.data.encryptionKey.cryptPassword });
    const cryptBackup = (await get('/backups?account=alice&sort=created_at&dir=desc').expect(200)).body.data.find((b) => b.id !== plainBackup.id);
    expect(cryptBackup.uploads[0]).toMatchObject({ destination: 'offsite-s3', encrypted: true });

    // The listing shows both layers; the plain one is read through the S3 path.
    const listing = await get(`/destinations/${s3Id}/archives`).expect(200);
    expect(listing.body.data.archives.map((a) => [a.name, a.encrypted]).sort()).toEqual([[cryptBackup.name, true], [plainBackup.name, false]].sort());
    expect(app.agent.callsTo('backup.rclone.list')[0].args.config.crypt).toBe(true);
    expect(app.agent.callsTo('backup.destination.list')[0].args.config).toMatchObject({ crypt: false });
    expect(app.agent.callsTo('backup.destination.list')[0].args.config).not.toHaveProperty('cryptPassword');

    // Each copy comes back through the transport that wrote it.
    app.agent.calls.length = 0;
    for (const b of [plainBackup, cryptBackup]) { app.ctx.db.prepare('UPDATE backups SET local_present = 0 WHERE id = ?').run(b.id); app.agent.disk.delete(b.path); }
    expect((await waitForJob(app.ctx, (await post(`/backups/${plainBackup.id}/fetch`).expect(202)).body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('backup.destination.download')[0].args.config).toMatchObject({ kind: 's3', crypt: false });
    expect((await waitForJob(app.ctx, (await post(`/backups/${cryptBackup.id}/fetch`).expect(202)).body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('backup.rclone.download')[0].args.config).toMatchObject({ kind: 's3', crypt: true });
    // ...and is pruned the same way.
    app.agent.calls.length = 0;
    await del(`/backups/${plainBackup.id}`).expect(200);
    await del(`/backups/${cryptBackup.id}`).expect(200);
    expect(app.agent.callsTo('backup.destination.remove')).toHaveLength(1);
    expect(app.agent.callsTo('backup.rclone.delete')).toHaveLength(1);
  });

  it('imports an archive found on a destination into the local directory as a job', async () => {
    const s3Id = (await get('/destinations').expect(200)).body.data.find((d) => d.name === 'offsite-s3').id;
    const run = await waitForJob(app.ctx, (await post('/runs', { accounts: ['alice'] }).expect(202)).body.data.job.id);
    expect(run.status).toBe('done');
    const backup = (await get('/backups?account=alice').expect(200)).body.data[0];
    // The panel forgot the row (reinstall); the copy is still on the destination.
    app.ctx.db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
    app.agent.disk.delete(backup.path);
    const listing = await get(`/destinations/${s3Id}/archives`).expect(200);
    expect(listing.body.data.archives).toEqual([expect.objectContaining({ name: backup.name, username: 'alice', encrypted: true })]);
    await post(`/destinations/${s3Id}/archives/import`, { name: 'notes.txt', encrypted: true }).expect(422);
    const queued = await post(`/destinations/${s3Id}/archives/import`, { name: backup.name, encrypted: true }).expect(202);
    const job = await waitForJob(app.ctx, queued.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ account: 'alice', path: backup.path });
    const imported = (await get('/backups?account=alice').expect(200)).body.data[0];
    expect(imported).toMatchObject({ name: backup.name, type: 'import', pinned: true, local_present: true, uploads: [expect.objectContaining({ destination: 'offsite-s3', encrypted: true, status: 'done' })] });
    expect(app.agent.callsTo('backup.rclone.download')[0].args).toMatchObject({ remoteName: backup.name, config: { crypt: true } });
    expect((await post(`/destinations/${s3Id}/archives/import`, { name: backup.name, encrypted: true }).expect(409)).body.error.message).toMatch(/already registered/);
    expect(auditText()).toContain('backup.destination.import');
  });

  it('validates provider configurations and reports the rclone capability when the binary is missing', async () => {
    const azure = await post('/destinations', { name: 'bad', config: { kind: 'azureblob', account: 'acct', container: 'backups' } }).expect(422);
    expect(azure.body.error.fields['config.accountKey']).toBeDefined();
    expect((await post('/destinations', { name: 'bad', config: { kind: 'azureblob', account: 'Acct', container: 'backups', accountKey: 'k' } }).expect(422)).body.error.fields['config.account']).toBeDefined();
    expect((await post('/destinations', { name: 'bad', config: { kind: 'b2', keyId: 'id', applicationKey: 'k', bucket: 'ab' } }).expect(422)).body.error.fields['config.bucket']).toBeDefined();
    expect((await post('/destinations', { name: 'bad', config: { kind: 'onedrive', folder: '../x' } }).expect(422)).body.error.fields['config.folder']).toBeDefined();
    await post('/destinations', { name: 'bad', config: { kind: 'onedrive', folder: 'x', driveId: 'smuggled' } }).expect(422);
    await post('/destinations', { name: 'bad', config: { kind: 's3', bucket: 'whm-backups', accessKey: 'a', secretKey: 'b', transport: 'ftp' } }).expect(422);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_destinations WHERE name = 'bad'").get().n).toBe(0);
    const azureOk = await post('/destinations', { name: 'azure-main', enabled: false, config: { kind: 'azureblob', account: 'acct', container: 'backups', sasToken: 'sv=2024&sig=abc%2F' } }).expect(201);
    expect(azureOk.body.data).toMatchObject({ encrypted: true, engine: 'rclone', config: { account: 'acct', container: 'backups', has_sas_token: true } });
    expect(azureOk.body.data.config).not.toHaveProperty('has_account_key');
    expect(JSON.stringify(azureOk.body.data.config)).not.toContain('sig=abc');
    const b2 = await post('/destinations', { name: 'b2-main', enabled: false, config: { kind: 'b2', keyId: '0012abc', applicationKey: 'K00secret', bucket: 'whm-backups', prefix: 'panel' } }).expect(201);
    expect(b2.body.data.config).toMatchObject({ keyId: '0012abc', bucket: 'whm-backups', has_application_key: true });
    expect(JSON.stringify(b2.body)).not.toContain('K00secret');
    const unsaved = await post('/destinations/test', { config: { kind: 'b2', keyId: '0012abc', applicationKey: 'K00secret', bucket: 'whm-backups' } }).expect(200);
    expect(unsaved.body.data.ok).toBe(true);
    expect(app.agent.callsTo('backup.rclone.test')[0].args.config).toMatchObject({ kind: 'b2', crypt: false });
    const s3Rclone = await post('/destinations/test', { config: { kind: 's3', bucket: 'whm-backups', accessKey: 'a', secretKey: 'b', transport: 'rclone' } }).expect(200);
    expect(s3Rclone.body.data.ok).toBe(true);
    expect(app.agent.callsTo('backup.rclone.test')[1].args.config).toMatchObject({ kind: 's3', crypt: false });
    expect(app.agent.callsTo('backup.rclone.test')[1].args.config).not.toHaveProperty('transport');

    app.agent.set('backup.rclone.test', Object.assign(new Error('rclone is not installed on this server; install the rclone package to use cloud storage destinations and encrypted uploads'), { agentError: true, code: 'capability_missing', details: { bin: 'rclone', capability: 'rclone' } }));
    try {
      const missing = await post(`/destinations/${b2.body.data.id}/test`).expect(501);
      expect(missing.body.error).toMatchObject({ code: 'capability_missing', capability: 'rclone' });
    } finally { app.agent.reset('backup.rclone.test'); }
  });

  it('a destination from before encryption existed reports crypt false explicitly and stays plain across an edit', async () => {
    const legacy = app.ctx.db.prepare("INSERT INTO backup_destinations (name, kind, config_enc, enabled) VALUES ('legacy-s3', 's3', ?, 0)").run(app.ctx.crypto.encrypt(JSON.stringify({ bucket: 'old-bucket', region: 'us-east-1', prefix: '', accessKey: 'AKIA', secretKey: 'oldsecret', pathStyle: false, insecure: false }))).lastInsertRowid;
    const listed = (await get('/destinations').expect(200)).body.data.find((d) => d.id === legacy);
    expect(listed).toMatchObject({ encrypted: false, engine: 'native', config: { bucket: 'old-bucket', crypt: false, has_secret_key: true } });
    // The edit form sends the toggle as stored (off) and a blank secret: nothing changes but the field edited.
    const same = await put(`/destinations/${legacy}`, { config: { kind: 's3', bucket: 'old-bucket', accessKey: 'AKIA', secretKey: '', prefix: 'moved', crypt: false } }).expect(200);
    expect(same.body.data).toMatchObject({ encrypted: false, config: { prefix: 'moved', crypt: false } });
    expect(same.body.data).not.toHaveProperty('encryptionKey');
    expect(app.ctx.backup.destinationConfig(legacy)).toMatchObject({ secretKey: 'oldsecret', crypt: false });
    // A script that omits the toggle keeps it plain too; only an explicit true issues a key.
    await put(`/destinations/${legacy}`, { config: { kind: 's3', bucket: 'old-bucket', accessKey: 'AKIA' } }).expect(200);
    expect(app.ctx.backup.destinationConfig(legacy).crypt).toBe(false);
    const on = await put(`/destinations/${legacy}`, { config: { kind: 's3', bucket: 'old-bucket', accessKey: 'AKIA', crypt: true } }).expect(200);
    expect(on.body.data).toMatchObject({ encrypted: true, engine: 'rclone', config: { crypt: true } });
    expect(on.body.data.encryptionKey.cryptPassword).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('an Azure update cannot remove both credentials', async () => {
    const azure = (await get('/destinations').expect(200)).body.data.find((d) => d.name === 'azure-main');
    const body = { kind: 'azureblob', account: 'acct', container: 'backups' };
    for (const patch of [{ sasToken: null }, { accountKey: null, sasToken: null }]) {
      const res = await put(`/destinations/${azure.id}`, { config: { ...body, ...patch } }).expect(422);
      expect(res.body.error.fields['config.accountKey']).toMatch(/account key or a container SAS token/);
    }
    expect(app.ctx.backup.destinationConfig(azure.id).sasToken).toBe('sv=2024&sig=abc%2F');
    const swapped = await put(`/destinations/${azure.id}`, { config: { ...body, accountKey: 'newaccountkey', sasToken: null } }).expect(200);
    expect(swapped.body.data.config).toMatchObject({ has_account_key: true });
    expect(swapped.body.data.config).not.toHaveProperty('has_sas_token');
    expect(app.ctx.backup.destinationConfig(azure.id)).toMatchObject({ accountKey: 'newaccountkey' });
    expect(app.ctx.backup.destinationConfig(azure.id)).not.toHaveProperty('sasToken');
    expect(JSON.stringify(swapped.body)).not.toContain('newaccountkey');
  });

  it('flags an OAuth destination whose grant expired and clears it on the next success or reconnect', async () => {
    const expired = 'test upload: fatal error (authentication or configuration) (Failed to refresh token: oauth2: "invalid_grant" "Token has been expired or revoked.")';
    app.agent.set('backup.rclone.test', () => ({ ok: false, message: expired, code: 'destination_failed', ms: 1, tokenUpdate: null }));
    const failed = await post(`/destinations/${gdriveId}/test`).expect(200);
    expect(failed.body.data).toMatchObject({ ok: false, destination: { connection: { connected: true, reauthRequired: true } } });
    expect(auditText()).toContain('backup.destination.reauth_required');
    expect(app.ctx.backup.destinationConfig(gdriveId).reauthRequired).toBe(true);
    // The flag is panel bookkeeping: the agent never sees it, and a plain failure does not set it.
    app.agent.set('backup.rclone.test', ({ config }) => ({ ok: !('reauthRequired' in config), message: 'probe ok', encrypted: Boolean(config.crypt), ms: 1, tokenUpdate: null }));
    const ok = await post(`/destinations/${gdriveId}/test`).expect(200);
    expect(ok.body.data).toMatchObject({ ok: true, destination: { connection: { connected: true, reauthRequired: false } } });
    expect(app.ctx.backup.destinationConfig(gdriveId)).not.toHaveProperty('reauthRequired');
    app.agent.set('backup.rclone.test', () => ({ ok: false, message: 'test upload: temporary error, retries exhausted', code: 'destination_failed', ms: 1, tokenUpdate: null }));
    expect((await post(`/destinations/${gdriveId}/test`).expect(200)).body.data.destination.connection.reauthRequired).toBe(false);
    // A failed scheduled upload sets it as well; a new sign-in clears it.
    await put(`/destinations/${gdriveId}`, { enabled: true }).expect(200);
    app.agent.set('backup.rclone.upload', ({ config }) => { if (config.kind === 'gdrive') throw Object.assign(new Error(`upload to gdrive: fatal error (authentication or configuration) (oauth2: "invalid_grant")`), { agentError: true, code: 'destination_failed', details: { exitCode: 7 } }); return { kind: config.kind, name: 'x', remotePath: `${config.kind}://x`, sizeBytes: 1, encrypted: Boolean(config.crypt), ms: 1, tokenUpdate: null }; });
    const run = await waitForJob(app.ctx, (await post('/runs', { accounts: ['alice'] }).expect(202)).body.data.job.id);
    expect(run.status).toBe('done');
    expect((await get('/destinations').expect(200)).body.data.find((d) => d.id === gdriveId).connection).toMatchObject({ connected: true, reauthRequired: true });
    const again = await startFlow('gdrive', gdriveId);
    await callback('gdrive', { code: 'good-code', state: again.searchParams.get('state') }).expect(302);
    expect((await get('/destinations').expect(200)).body.data.find((d) => d.id === gdriveId).connection).toMatchObject({ connected: true, reauthRequired: false });
    expect(app.ctx.backup.destinationConfig(gdriveId)).not.toHaveProperty('reauthRequired');
    await put(`/destinations/${gdriveId}`, { enabled: false }).expect(200);
    for (const s of SECRETS) expect(auditText(), s).not.toContain(s);
  });

  it('every cloud endpoint is root-only', async () => {
    const r = (p) => resellerHttp.get(`/api/backup${p}`);
    await r('/destinations/providers').expect(403);
    await r('/destinations/oauth-apps').expect(403);
    await resellerHttp.put('/api/backup/destinations/oauth-apps/gdrive').set('X-CSRF-Token', resellerCsrf).send({ clientId: 'x', clientSecret: 'y' }).expect(403);
    await r(`/destinations/oauth/gdrive/start?destination=${gdriveId}`).expect(403);
    await r('/destinations/oauth/gdrive/callback?code=x&state=y').expect(403);
    await resellerHttp.post(`/api/backup/destinations/${gdriveId}/encryption`).set('X-CSRF-Token', resellerCsrf).expect(403);
    await resellerHttp.post(`/api/backup/destinations/${gdriveId}/archives/import`).set('X-CSRF-Token', resellerCsrf).send({ name: 'backup-10.26.2026_02-00-01_alice.tar.gz' }).expect(403);
  });
});
