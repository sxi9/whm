import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { createTestApp, createMockAgent } from './support/app.js';
import { SSH_KEY, parseAuthorizedKeys, fingerprintOf } from '../src/routes/panel/security.js';

const BINS = { setpriv: true, chpasswd: true, useradd: true, usermod: true, userdel: true };
const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7l7p0R9r8F1D9qkzJ1Zx6Q5n3bq7Qq3rWwQm3a1xC alice@laptop';
const RSA = `ssh-rsa ${Buffer.from('ssh-rsa-key-material-for-tests-0123456789').toString('base64')} alice@desk`;
const ECDSA = `ecdsa-sha2-nistp256 ${Buffer.from('ecdsa-material-0123456789abcdef').toString('base64')}`;

function hostAgent(state) {
  const notFound = (p) => Object.assign(new Error(`${p} does not exist`), { agentError: true, code: 'not_found', details: {} });
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])),
    'user.set_password': ({ username }) => { state.linuxPasswords.push(username); return { username }; },
    'files.read': ({ path }) => { if (!(path in state.files)) throw notFound(path); return { path, content: state.files[path], binary: false, size: state.files[path].length, truncated: false }; },
    'files.mkdir': ({ path, mode }) => ({ path, mode }),
    'files.write': ({ path, content, mode }) => { state.files[path] = content; return { path, bytes: content.length, mode, created: true }; },
  });
}

describe('SSH key parsing', () => {
  it('accepts OpenSSH public key lines of the allowed types and refuses everything else', () => {
    for (const k of [ED25519, RSA, ECDSA, `${ECDSA} comment with spaces`]) expect(SSH_KEY.test(k), k).toBe(true);
    for (const k of ['ssh-dss AAAA x', 'ssh-ed25519', 'ssh-ed25519 ', `command="rm -rf /" ${ED25519}`, 'ssh-ed25519 not+base64! c', `${ED25519}\nssh-rsa AAAA`, `ssh-ed25519 AAAA ${'c'.repeat(256)}`, 'ecdsa-sha2-nistp128 AAAA']) expect(SSH_KEY.test(k), k).toBe(false);
  });

  it('parses authorized_keys keeping comments and unknown lines verbatim', () => {
    const entries = parseAuthorizedKeys(`# managed\n${ED25519}\n\nno-pty,command="x" ${RSA}\ngarbage line\n`);
    expect(entries.map((e) => (e.key ? e.key.type : null))).toEqual([null, 'ssh-ed25519', 'ssh-rsa', null]);
    expect(entries[1].key).toMatchObject({ comment: 'alice@laptop', options: '', fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/) });
    expect(entries[2].key).toMatchObject({ comment: 'alice@desk', options: 'no-pty,command="x"' });
    expect(entries[1].key.id).toBe(fingerprintOf(ED25519.split(' ')[1]).id);
    expect(entries.map((e) => e.raw)).toEqual(['# managed', ED25519, `no-pty,command="x" ${RSA}`, 'garbage line']);
  });
});

describe('Panel security API', () => {
  let app;
  let state;
  let alice;
  let aliceCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const setPlan = (username, key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.${key}', json(?)) WHERE username = ?`).run(JSON.stringify(value), username);
  const lastAudit = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  const get = (p) => alice.get(`/api/panel/security${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel/security${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const del = (p) => alice.delete(`/api/panel/security${p}`).set('X-CSRF-Token', aliceCsrf);
  async function login(username, password) {
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username, password });
    if (res.status !== 200) throw new Error(`login ${username}: ${res.status} ${JSON.stringify(res.body)}`);
    return { http, csrf: res.body.data.csrfToken };
  }

  beforeAll(async () => {
    state = { linuxPasswords: [], files: {} };
    app = await createTestApp({ agent: hostAgent(state) });
    rootCsrf = await app.login();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    ({ http: alice, csrf: aliceCsrf } = await login('alice', 'Alice-Passw0rd!'));
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; state.linuxPasswords.length = 0; });

  describe('password', () => {
    it('refuses a wrong current password without touching either store', async () => {
      const res = await post('/password', { currentPassword: 'nope-nope-nope', newPassword: 'Alice-Newpass0rd!' });
      expect(res.status).toBe(401);
      expect(state.linuxPasswords).toEqual([]);
      expect((await post('/password', { currentPassword: 'Alice-Passw0rd!', newPassword: 'short' })).status).toBe(422);
      expect((await post('/password', { currentPassword: 'Alice-Passw0rd!', newPassword: 'Alice-Newpass0rd!', extra: 1 })).status).toBe(422);
    });

    it('writes the Linux password first, then the hash, ends every other session and keeps this one', async () => {
      const other = await login('alice', 'Alice-Passw0rd!');
      expect((await other.http.get('/api/auth/me')).status).toBe(200);
      const res = await post('/password', { currentPassword: 'Alice-Passw0rd!', newPassword: 'Alice-Newpass0rd!' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ changed: true, csrfToken: expect.any(String) });
      expect(state.linuxPasswords).toEqual(['alice']);
      const row = db().prepare('SELECT u.password_hash, au.password_synced_at FROM users u JOIN account_users au ON au.user_id = u.id WHERE u.username = ?').get('alice');
      expect(await app.ctx.crypto.verifyPassword('Alice-Newpass0rd!', row.password_hash)).toBe(true);
      expect(row.password_synced_at).toBeTruthy();
      expect((await other.http.get('/api/auth/me')).status).toBe(401);
      aliceCsrf = res.body.data.csrfToken;
      expect((await get('/two-factor')).status).toBe(200);
      expect(lastAudit('panel.password.change')).toMatchObject({ principal: 'alice', target: 'alice' });
      expect((await login('alice', 'Alice-Newpass0rd!')).csrf).toBeTruthy();
    });

    it('is refused while an admin is acting as the account, and over an API token', async () => {
      await rootPost('/api/panel/admin/login-as/alice').expect(200);
      try {
        const res = await rootPost('/api/panel/security/password', { currentPassword: 'Alice-Newpass0rd!', newPassword: 'Alice-Other0rd!!' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('not_while_impersonating');
        expect((await rootPost('/api/panel/security/two-factor/enroll')).body.error.code).toBe('not_while_impersonating');
        expect((await rootPost('/api/panel/security/ssh-keys', { key: ED25519 })).status).toBe(403);
      } finally { await rootPost('/api/panel/admin/logout-as').expect(200); }
      const token = await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'cli', scopes: ['panel:read'] });
      expect(token.status).toBe(201);
      const minted = token.body.data.token;
      expect(minted).toEqual(expect.any(String));
      const bearer = request(app.ctx.app);
      expect((await bearer.get('/api/panel/security/two-factor').set('Authorization', `Bearer ${minted}`)).status).toBe(200);
      const viaToken = await bearer.post('/api/panel/security/password').set('Authorization', `Bearer ${minted}`).send({ currentPassword: 'Alice-Newpass0rd!', newPassword: 'Alice-Other0rd!!' });
      expect(viaToken.status).toBe(403);
      expect(viaToken.body.error.code).toBe('session_required');
      expect((await bearer.post('/api/panel/security/ssh-keys').set('Authorization', `Bearer ${minted}`).send({ key: ED25519 })).body.error.code).toBe('session_required');
      expect(state.linuxPasswords).toEqual([]);
    });
  });

  describe('two-factor', () => {
    it('proxies enrol, confirm and disable onto the auth service', async () => {
      expect((await get('/two-factor')).body.data).toEqual({ enabled: false, required: false, pendingEnrollment: false });
      const enroll = await post('/two-factor/enroll');
      expect(enroll.status).toBe(200);
      expect(enroll.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      expect((await post('/two-factor/confirm', { code: '000000' })).status).toBe(400);
      const ok = await post('/two-factor/confirm', { code: authenticator.generate(enroll.body.data.secret) });
      expect(ok.status).toBe(200);
      expect((await get('/two-factor')).body.data.enabled).toBe(true);
      expect(lastAudit('panel.2fa.enable')).toMatchObject({ target: 'alice' });
      expect((await post('/two-factor/disable', {})).status).toBe(403);
      expect((await post('/two-factor/disable', { password: 'Alice-Newpass0rd!' })).status).toBe(200);
      expect((await get('/two-factor')).body.data.enabled).toBe(false);
      expect(lastAudit('panel.2fa.disable')).toMatchObject({ target: 'alice' });
    });

    it('cannot be disabled while the panel policy requires it', async () => {
      app.ctx.settings.set('panel.require_2fa_for_users', true);
      try {
        expect((await get('/two-factor')).body.data.required).toBe(true);
        const res = await post('/two-factor/disable', { password: 'Alice-Newpass0rd!' });
        expect(res.status).toBe(403);
      } finally { app.ctx.settings.set('panel.require_2fa_for_users', false); }
    });
  });

  describe('ssh keys', () => {
    it('cannot be planted through the file manager while the account has no shell access', async () => {
      const files = (p, body) => alice.put(`/api/panel/files${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
      const res = await files('/write', { path: '.ssh/authorized_keys', content: `${ED25519}\n`, mode: '0600' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ssh_managed');
      const mk = await alice.post('/api/panel/files/mkdir').set('X-CSRF-Token', aliceCsrf).send({ path: '.ssh', mode: '0700' });
      expect(mk.body.error.code).toBe('ssh_managed');
      expect(app.agent.calls.filter((c) => c.name.startsWith('files.'))).toHaveLength(0);
      expect(state.files['/home/alice/.ssh/authorized_keys']).toBeUndefined();
    });

    it('is gated by the ssh feature and by shell access', async () => {
      let res = await get('/ssh-keys');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
      setPlan('alice', 'features.ssh', true);
      res = await get('/ssh-keys');
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('shell_disabled');
      expect(app.agent.callsTo('files.read')).toHaveLength(0);
      setPlan('alice', 'has_shell', true);
      res = await get('/ssh-keys');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(app.agent.callsTo('files.read')[0].args).toEqual({ username: 'alice', path: '/home/alice/.ssh/authorized_keys', maxBytes: 1024 * 1024 });
    });

    it('adds keys through mkdir 0700 + write 0600 as the account, refuses duplicates and bad lines', async () => {
      const res = await post('/ssh-keys', { key: ED25519 });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ type: 'ssh-ed25519', comment: 'alice@laptop', id: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(app.agent.callsTo('files.mkdir')[0].args).toEqual({ username: 'alice', path: '/home/alice/.ssh', mode: '0700' });
      expect(app.agent.callsTo('files.write')[0].args).toEqual({ username: 'alice', path: '/home/alice/.ssh/authorized_keys', content: `${ED25519}\n`, mode: '0600' });
      expect(JSON.parse(lastAudit('panel.ssh_key.add').args_redacted)).toMatchObject({ type: 'ssh-ed25519', comment: 'alice@laptop' });
      expect((await post('/ssh-keys', { key: ED25519 })).status).toBe(409);
      expect((await post('/ssh-keys', { key: `  ${RSA}  ` })).status).toBe(201);
      expect(state.files['/home/alice/.ssh/authorized_keys']).toBe(`${ED25519}\n${RSA}\n`);
      for (const key of ['ssh-dss AAAA x', `command="id" ${ED25519}`, 'ssh-ed25519 ****', '', `${ED25519}\n${RSA}`]) expect((await post('/ssh-keys', { key })).status, key).toBe(422);
      expect((await get('/ssh-keys')).body.data.map((k) => k.type)).toEqual(['ssh-ed25519', 'ssh-rsa']);
    });

    it('removes a key by fingerprint, keeping foreign lines, and 404s an unknown one', async () => {
      state.files['/home/alice/.ssh/authorized_keys'] = `# keep me\n${ED25519}\n${RSA}\n`;
      const { id } = fingerprintOf(ED25519.split(' ')[1]);
      const res = await del(`/ssh-keys/${id}`);
      expect(res.status).toBe(200);
      expect(state.files['/home/alice/.ssh/authorized_keys']).toBe(`# keep me\n${RSA}\n`);
      expect(lastAudit('panel.ssh_key.remove')).toMatchObject({ target: 'alice' });
      expect((await del(`/ssh-keys/${id}`)).status).toBe(404);
      expect((await del('/ssh-keys/not-hex')).status).toBe(422);
    });

    it('opens .ssh to the file manager under exactly the same gate: session login with shell access, never a token', async () => {
      const ok = await alice.put('/api/panel/files/write').set('X-CSRF-Token', aliceCsrf).send({ path: '.ssh/config', content: 'Host example\n' });
      expect(ok.status).toBe(200);
      expect(app.agent.callsTo('files.write').at(-1).args.path).toBe('/home/alice/.ssh/config');
      const minted = (await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'files', scopes: ['panel:files'] })).body.data.token;
      const viaToken = await request(app.ctx.app).put('/api/panel/files/write').set('Authorization', `Bearer ${minted}`).send({ path: '.ssh/authorized_keys', content: `${ECDSA}\n` });
      expect(viaToken.status).toBe(403);
      expect(viaToken.body.error.code).toBe('ssh_managed');
      setPlan('alice', 'has_shell', false);
      const noShell = await alice.put('/api/panel/files/write').set('X-CSRF-Token', aliceCsrf).send({ path: '.ssh/authorized_keys', content: `${ECDSA}\n` });
      expect(noShell.body.error.code).toBe('ssh_managed');
      setPlan('alice', 'has_shell', true);
      expect(state.files['/home/alice/.ssh/authorized_keys']).toBe(`# keep me\n${RSA}\n`);
    });
  });

  describe('sessions', () => {
    it('lists the login sessions and ends them all while keeping the caller signed in', async () => {
      const other = await login('alice', 'Alice-Newpass0rd!');
      const list = await get('/sessions');
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThanOrEqual(2);
      const res = await del('/sessions');
      expect(res.status).toBe(200);
      expect(res.body.data.csrfToken).toBeTruthy();
      aliceCsrf = res.body.data.csrfToken;
      expect((await other.http.get('/api/auth/me')).status).toBe(401);
      expect((await get('/sessions')).body.data).toHaveLength(1);
      expect(lastAudit('panel.sessions.end')).toMatchObject({ target: 'alice' });
    });
  });
});
