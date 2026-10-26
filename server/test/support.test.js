import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { catalog } from '@whm/agent';
import { createTestApp, createMockAgent } from './support/app.js';
import { generateSshKeyPair, parseOpenSshPrivateKey, sshFingerprint, indexSections, extractSection, utcStamp, sshExpiryTime, authorizedKeyLine } from '../src/services/support.js';

// Runs an op's real agent schema against the mock's arguments so a registration
// overflow or a malformed key line fails here instead of only on a live host.
const realSchema = (name, handler) => (args) => {
  const parsed = catalog.get(name).schema.safeParse(args);
  if (!parsed.success) throw Object.assign(new Error(`Invalid arguments for "${name}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`), { agentError: true, code: 'invalid_args', details: {} });
  return handler(parsed.data);
};

describe('support helpers', () => {
  it('generates an ed25519 pair OpenSSH can read: the authorized_keys line matches the private key', () => {
    const pair = generateSshKeyPair('whm-support-acme');
    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* whm-support-acme$/);
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
    expect(pair.privateKey.split('\n').every((l) => l.length <= 70)).toBe(true);
    const parsed = parseOpenSshPrivateKey(pair.privateKey);
    expect(parsed).toMatchObject({ cipher: 'none', kdf: 'none', count: 1, type: 'ssh-ed25519', comment: 'whm-support-acme' });
    expect(parsed.publicBlob.toString('base64')).toBe(pair.publicKey.split(' ')[1]);
    expect(sshFingerprint(parsed.publicBlob)).toBe(pair.fingerprint);
    expect(pair.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    // The seed in the private section must produce exactly the public key in the blob.
    const priv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: parsed.seed.toString('base64url'), x: parsed.publicKey.toString('base64url') }, format: 'jwk' });
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: parsed.publicKey.toString('base64url') }, format: 'jwk' });
    const sig = crypto.sign(null, Buffer.from('challenge'), priv);
    expect(crypto.verify(null, Buffer.from('challenge'), pub, sig)).toBe(true);
    expect(generateSshKeyPair().publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    expect(() => generateSshKeyPair('has space')).toThrow();
  });

  it('indexes and extracts markdown sections while ignoring fenced headings', () => {
    const text = '# Title\n\n## One\nbody one\n```\n## not a heading\n```\n### Sub\nsub body\n## Two\nbody two\n';
    expect(indexSections(text).map((s) => [s.level, s.slug])).toEqual([[2, 'one'], [3, 'sub'], [2, 'two']]);
    expect(extractSection(text, 'one')).toBe('## One\nbody one\n```\n## not a heading\n```\n### Sub\nsub body\n');
    expect(extractSection(text, 'two')).toBe('## Two\nbody two\n');
    expect(extractSection(text, 'missing')).toBeNull();
    expect(utcStamp('2026-10-26T10:00:00.123Z')).toBe('2026-10-26T10:00:00Z');
  });

  it('builds an authorized_keys line every sshd >= 7.7 expires by itself: host-local time, no UTC suffix', () => {
    // Pre-9.1 daemons parse expiry-time as local time and drop a line carrying a 'Z'.
    const tz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      expect(sshExpiryTime('2026-10-27T09:05:30.900Z')).toBe('20261027090530');
      const line = authorizedKeyLine('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq5 whm-support-case-1', '2026-10-27T09:05:30Z');
      expect(line).toBe('expiry-time="20261027090530" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq5 whm-support-case-1');
      expect(catalog.get('sec.ssh_keys.add').schema.safeParse({ publicKey: line }).success).toBe(true);
      expect(catalog.get('sec.ssh_keys.add').schema.safeParse({ publicKey: `${line}\ncommand="/bin/sh"` }).success).toBe(false);
      process.env.TZ = 'Asia/Kolkata';
      expect(sshExpiryTime('2026-10-27T09:05:30Z')).toBe('20261027143530');
      process.env.TZ = 'America/Los_Angeles';
      expect(sshExpiryTime('2026-01-01T03:00:00Z')).toBe('20251231190000');
      expect(sshExpiryTime('2026-07-01T03:00:00Z')).toBe('20260630200000');
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
    const d = new Date('2026-10-27T09:05:30Z');
    const p = (n) => String(n).padStart(2, '0');
    expect(sshExpiryTime(d)).toBe(`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
    expect(sshExpiryTime(d)).not.toMatch(/Z$/);
  });
});

describe('Support API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerCsrf;
  let sshdInstalled = false;
  let eximInstalled = false;
  let authorized = [];
  const sent = [];
  let sendmailFailure = null;

  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const put = (url, body) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
  const patch = (url, body) => app.http.patch(url).set('X-CSRF-Token', csrf).send(body);
  const del = (url) => app.http.delete(url).set('X-CSRF-Token', csrf);
  const get = (url) => app.http.get(url);
  const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const refresh = () => app.ctx.capabilities.refresh();
  const host = () => app.ctx.settings.get('basic.hostname') || 'test.example.com';
  // Mirrors the agent: an optional options token precedes the key type.
  const addKey = ({ publicKey }) => {
    const tokens = publicKey.split(' ');
    const i = tokens.findIndex((t) => t === 'ssh-ed25519');
    expect(i).toBeGreaterThanOrEqual(0);
    const fingerprint = sshFingerprint(Buffer.from(tokens[i + 1], 'base64'));
    if (authorized.includes(fingerprint)) throw Object.assign(new Error('exists'), { agentError: true, code: 'exists' });
    authorized.push(fingerprint);
    return { fingerprint, type: 'ssh-ed25519', comment: tokens[i + 2], options: i ? tokens.slice(0, i).join(' ') : null };
  };
  const removeKey = ({ fingerprint }) => { const n = authorized.length; authorized = authorized.filter((f) => f !== fingerprint); return { fingerprint, removed: n - authorized.length }; };
  const agentFail = (name, code, message) => app.agent.set(name, Object.assign(new Error(message), { agentError: true, code, details: {} }));

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': realSchema('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, (sshdInstalled && n === 'sshd') || (eximInstalled && n === 'exim4')]))),
      'sec.ssh_keys.add': realSchema('sec.ssh_keys.add', addKey),
      'sec.ssh_keys.remove': realSchema('sec.ssh_keys.remove', removeKey),
      'mail.sendmail': (args) => { if (sendmailFailure) throw sendmailFailure; sent.push(args); return { from: args.from, to: args.to, accepted: true, bytes: 10 }; },
    });
    app = await createTestApp({ agent });
    csrf = await app.login();
    const r = await app.createUser('resell1', 'reseller');
    reseller = request.agent(app.ctx.app);
    const res = await reseller.post('/api/auth/login').send({ username: r.username, password: r.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());

  describe('Support Center', () => {
    it('serves links, in-app references, docs and root-only state', async () => {
      const res = await get('/api/support/center');
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.links.some((l) => l.url === 'https://docs.cpanel.net/')).toBe(true);
      expect(d.inApp.find((l) => l.key === 'api').path).toBe('/development/openapi-documentation-for-whm');
      expect(d.docs.map((x) => x.slug)).toEqual(['readme', 'blueprint']);
      expect(d.docs.every((x) => x.available && x.sections.length > 0)).toBe(true);
      expect(d.tickets).toMatchObject({ total: 0, open: [] });
      expect(d.access).toMatchObject({ active: [], cleanupPending: [], sshd: false });
      expect(d.mail).toMatchObject({ transport: null, configured: false });
      expect(d.settings.email).toBe('');
    });

    it('lets a reseller see links and docs but not tickets or grants', async () => {
      const res = await reseller.get('/api/support/center');
      expect(res.status).toBe(200);
      expect(res.body.data.tickets).toBeUndefined();
      expect(res.body.data.access).toBeUndefined();
      expect(res.body.data.mail).toBeUndefined();
      expect(res.body.data.settings.email).toBeUndefined();
      expect((await reseller.get('/api/support/tickets')).status).toBe(403);
      expect((await reseller.get('/api/support/access')).status).toBe(403);
      expect((await reseller.get('/api/support/diagnostics')).status).toBe(403);
      expect((await reseller.post('/api/support/access').set('X-CSRF-Token', resellerCsrf).send({ label: 'x' })).status).toBe(403);
      expect((await reseller.put('/api/support/settings').set('X-CSRF-Token', resellerCsrf).send({ email: 'a@b.co' })).status).toBe(403);
    });

    it('renders repository documents whole or by section', async () => {
      const list = await get('/api/support/docs');
      expect(list.status).toBe(200);
      const whole = await get('/api/support/docs/readme');
      expect(whole.status).toBe(200);
      expect(whole.body.data.content.length).toBeGreaterThan(100);
      const section = list.body.data.find((d) => d.slug === 'blueprint').sections.find((s) => s.slug.startsWith('13-'));
      const part = await get(`/api/support/docs/blueprint?section=${section.slug}`);
      expect(part.status).toBe(200);
      expect(part.body.data.content.startsWith('## 13.')).toBe(true);
      expect(part.body.data.content.length).toBeLessThan(whole.body.data.content.length + 200_000);
      expect((await get('/api/support/docs/blueprint?section=nope')).status).toBe(404);
      expect((await get('/api/support/docs/nope')).status).toBe(404);
      expect((await get('/api/support/docs/..%2F..%2Fetc')).status).toBe(422);
    });

    it('downloads a diagnostics bundle without secrets', async () => {
      await app.ctx.settings.set('contacts.smtp.password_enc', 'v1:x:y:z');
      const res = await get('/api/support/diagnostics');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="whm-diagnostics-.*\.json"$/);
      const d = res.body.data;
      expect(d.snapshot.hostname).toBe(host());
      expect(d.snapshot.interfaces).toBeUndefined();
      expect(d.snapshot.server).toBeUndefined();
      expect(JSON.stringify(d.settings)).not.toContain('v1:x:y:z');
      expect(Object.keys(d.settings).some((k) => /password|secret|token/i.test(k))).toBe(false);
      expect(Array.isArray(d.schedules)).toBe(true);
      expect(d.schedules.some((s) => s.name === 'support-access-expiry')).toBe(true);
      expect(auditRows('support.diagnostics.download')).toHaveLength(1);
    });

    it('validates and saves support settings', async () => {
      expect((await put('/api/support/settings', {})).status).toBe(422);
      expect((await put('/api/support/settings', { email: '-r@example.com' })).status).toBe(422);
      expect((await put('/api/support/settings', { portalUrl: 'javascript:alert(1)' })).status).toBe(422);
      expect((await put('/api/support/settings', { bogus: 1 })).status).toBe(422);
      const before = (await get('/api/support/settings')).body.data;
      const tooLong = await put('/api/support/settings', { email: 'changed@example.net', access: { defaultHours: 500, maxHours: 100 } });
      expect(tooLong.status).toBe(422);
      expect(tooLong.body.error.fields['access.defaultHours']).toBeDefined();
      // A rejected update writes nothing, not even the keys that were valid on their own.
      expect((await get('/api/support/settings')).body.data).toEqual(before);
      expect(app.ctx.settings.get('support.email')).toBe('');
      expect(Number(app.ctx.settings.get('support.access.default_hours'))).toBe(24);
      expect(Number(app.ctx.settings.get('support.access.max_hours'))).toBe(168);
      expect((await put('/api/support/settings', { access: { defaultHours: 200 } })).status).toBe(422);
      expect((await put('/api/support/settings', { access: { maxHours: 12 } })).status).toBe(422);
      expect(auditRows('support.settings.update')).toHaveLength(0);
      const res = await put('/api/support/settings', { email: 'support@example.net', providerName: 'Acme Support', portalUrl: 'https://help.example.net/', access: { defaultHours: 12, maxHours: 48 } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ email: 'support@example.net', providerName: 'Acme Support', portalUrl: 'https://help.example.net/', access: { defaultHours: 12, maxHours: 48 } });
      expect((await get('/api/support/settings')).body.data.email).toBe('support@example.net');
      expect(auditRows('support.settings.update')).toHaveLength(1);
      const center = await get('/api/support/center');
      expect(center.body.data.links[0]).toMatchObject({ key: 'portal', label: 'Acme Support portal', url: 'https://help.example.net/' });
    });
  });

  describe('Create Support Ticket', () => {
    let ticketId;

    it('rejects bad input', async () => {
      expect((await post('/api/support/tickets', { subject: 'x', description: 'short' })).status).toBe(422);
      expect((await post('/api/support/tickets', { subject: 'line\nbreak', description: 'long enough description' })).status).toBe(422);
      expect((await post('/api/support/tickets', { subject: 'ok', description: 'long enough description', severity: 'urgent' })).status).toBe(422);
      expect((await post('/api/support/tickets', { subject: 'ok', description: 'long enough description', contactEmail: '-x@example.com' })).status).toBe(422);
      expect((await post('/api/support/tickets', { subject: 'ok', description: 'long enough description', extra: true })).status).toBe(422);
    });

    it('previews the redacted snapshot', async () => {
      const res = await get('/api/support/snapshot');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ hostname: host(), os: { name: 'Test Linux 1.0' }, cpu: { count: 2 } });
      expect(res.body.data.interfaces).toBeUndefined();
      expect(res.body.data.license).toBeUndefined();
      expect(res.body.data.capabilities.sshd).toBe(false);
    });

    it('stores a ticket with the snapshot and reports why no mail left', async () => {
      const res = await post('/api/support/tickets', { subject: 'Exim queue grows', description: 'The mail queue has 4000 frozen messages since the upgrade.', severity: 'high', category: 'email', contactEmail: 'admin@example.net' });
      expect(res.status).toBe(201);
      const t = res.body.data;
      ticketId = t.id;
      expect(t.reference).toMatch(/^WHM-\d{8}-[0-9A-F]{6}$/);
      expect(t).toMatchObject({ status: 'open', severity: 'high', category: 'email', createdBy: 'root', hasSnapshot: true, contactEmail: 'admin@example.net' });
      expect(t.delivery.status).toBe('not_sent');
      expect(t.delivery.detail).toMatch(/no mail transport/i);
      const full = await get(`/api/support/tickets/${ticketId}`);
      expect(full.body.data.snapshot.hostname).toBe(host());
      expect(full.body.data.snapshot.interfaces).toBeUndefined();
      expect(auditRows('support.ticket.create')).toHaveLength(1);
      expect(JSON.parse(auditRows('support.ticket.create')[0].args_redacted)).toMatchObject({ severity: 'high', delivery: 'not_sent' });
      const center = await get('/api/support/center');
      expect(center.body.data.tickets.open[0].reference).toBe(t.reference);
    });

    it('can skip the snapshot', async () => {
      const res = await post('/api/support/tickets', { subject: 'Question', description: 'How do I rotate the panel certificate?', includeSnapshot: false });
      expect(res.status).toBe(201);
      expect(res.body.data.hasSnapshot).toBe(false);
      expect((await get(`/api/support/tickets/${res.body.data.id}`)).body.data.snapshot).toBeNull();
    });

    it('emails the support address once a transport exists, with Reply-To and the snapshot', async () => {
      eximInstalled = true;
      await refresh();
      const res = await post(`/api/support/tickets/${ticketId}/resend`);
      expect(res.status).toBe(200);
      expect(res.body.data.delivery).toMatchObject({ status: 'sent', to: 'support@example.net' });
      expect(res.body.data.delivery.at).toMatch(/Z$/);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toEqual(['support@example.net']);
      expect(sent[0].subject).toMatch(/^\[WHM-\d{8}-[0-9A-F]{6}\] Exim queue grows \(high\)$/);
      expect(sent[0].headers).toEqual({ 'Reply-To': 'admin@example.net' });
      expect(sent[0].text).toContain('4000 frozen messages');
      expect(sent[0].text).toContain(`"hostname": "${host()}"`);
      expect(auditRows('support.ticket.resend')).toHaveLength(1);

      const fresh = await post('/api/support/tickets', { subject: 'Sent at creation', description: 'A ticket created while the transport is up.' });
      expect(fresh.body.data.delivery.status).toBe('sent');
      expect(sent).toHaveLength(2);

      sendmailFailure = Object.assign(new Error('exim: queue directory not writable'), { agentError: true, code: 'command_failed' });
      const failed = await post(`/api/support/tickets/${ticketId}/resend`);
      expect(failed.status).toBe(200);
      expect(failed.body.data.delivery).toMatchObject({ status: 'failed', detail: 'exim: queue directory not writable' });
      sendmailFailure = null;
    });

    it('lists, filters, closes, reopens and deletes tickets', async () => {
      const all = await get('/api/support/tickets');
      expect(all.status).toBe(200);
      expect(all.body.meta.total).toBe(3);
      expect(all.body.data[0].id).toBeGreaterThan(all.body.data[1].id);
      expect((await get('/api/support/tickets?q=frozen')).body.meta.total).toBe(1);
      expect((await get('/api/support/tickets?status=nope')).status).toBe(422);
      const closed = await patch(`/api/support/tickets/${ticketId}`, { status: 'closed' });
      expect(closed.status).toBe(200);
      expect(closed.body.data.status).toBe('closed');
      expect(closed.body.data.closedAt).toBeTruthy();
      expect((await get('/api/support/tickets?status=open')).body.meta.total).toBe(2);
      expect((await patch(`/api/support/tickets/${ticketId}`, { status: 'reopened' })).status).toBe(422);
      const reopened = await patch(`/api/support/tickets/${ticketId}`, { status: 'open' });
      expect(reopened.body.data).toMatchObject({ status: 'open', closedAt: null });
      expect(auditRows('support.ticket.close')).toHaveLength(1);
      expect(auditRows('support.ticket.reopen')).toHaveLength(1);
      expect((await del('/api/support/tickets/999')).status).toBe(404);
      expect((await del(`/api/support/tickets/${ticketId}`)).status).toBe(200);
      expect((await get(`/api/support/tickets/${ticketId}`)).status).toBe(404);
      expect(auditRows('support.ticket.delete')).toHaveLength(1);
    });
  });

  describe('Grant cPanel Support Access', () => {
    let grant;
    let tokenSecret;

    it('rejects bad input', async () => {
      expect((await post('/api/support/access', { label: '-r' })).status).toBe(422);
      expect((await post('/api/support/access', { label: 'a;b' })).status).toBe(422);
      expect((await post('/api/support/access', { label: 'ok', hours: 0 })).status).toBe(422);
      expect((await post('/api/support/access', { label: 'ok', tokenScopes: ['accounts:write'] })).status).toBe(422);
      expect((await post('/api/support/access', { label: 'ok', ssh: false, apiToken: false })).status).toBe(422);
      const tooLong = await post('/api/support/access', { label: 'ok', hours: 49, ssh: false });
      expect(tooLong.status).toBe(422);
      expect(tooLong.body.error.fields.hours[0]).toMatch(/at most 48 hours/);
    });

    it('needs sshd for SSH access and says so', async () => {
      const res = await post('/api/support/access', { label: 'case-1001', hours: 2 });
      expect(res.status).toBe(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'sshd' });
      expect(app.agent.callsTo('sec.ssh_keys.add')).toHaveLength(0);
      expect((await get('/api/support/access/status')).body.data).toMatchObject({ sshd: false, tokens: true, active: [] });
      expect((await get('/api/support/access')).body.meta.total).toBe(0);
    });

    it('issues a token only when SSH is not requested', async () => {
      const res = await post('/api/support/access', { label: 'token-only', hours: 1, ssh: false, tokenScopes: ['development:read'] });
      expect(res.status).toBe(201);
      expect(res.body.data.ssh).toBeNull();
      expect(res.body.data.apiToken.token).toMatch(/^whm_/);
      expect(res.body.data.apiToken.scopes).toEqual(['development:read']);
      expect(res.body.data.grant).toMatchObject({ status: 'active', ssh: null });
      expect(res.body.data.grant.apiToken.prefix).toBe(res.body.data.apiToken.token.slice(0, 12));
      const revoked = await del(`/api/support/access/${res.body.data.grant.id}`);
      expect(revoked.status).toBe(200);
      expect(revoked.body.data).toMatchObject({ status: 'revoked', endedBy: 'root', cleanup: { api: { expired: true }, ok: true } });
      expect(revoked.body.data.cleanup.ssh).toBeUndefined();
    });

    it('authorizes a fresh key for root and issues a token, both shown once', async () => {
      sshdInstalled = true;
      await refresh();
      const res = await post('/api/support/access', { label: 'case-1001', hours: 2, note: 'Ticket WHM-1 with cPanel' });
      expect(res.status).toBe(201);
      const d = res.body.data;
      grant = d.grant;
      tokenSecret = d.apiToken.token;
      expect(d.ssh.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
      expect(d.ssh.publicKey).toMatch(/^ssh-ed25519 \S+ whm-support-case-1001$/);
      expect(d.ssh.command).toBe(`ssh -i support-case-1001.key root@${host()}`);
      expect(d.apiToken.example).toContain(`https://${host()}:2087/api/system/status`);
      expect(grant).toMatchObject({ status: 'active', label: 'case-1001', note: 'Ticket WHM-1 with cPanel', grantedBy: 'root', ssh: { fingerprint: d.ssh.fingerprint, type: 'ssh-ed25519', comment: 'whm-support-case-1001' } });
      expect(grant.remainingSeconds).toBeGreaterThan(7000);
      expect(grant.remainingSeconds).toBeLessThanOrEqual(7200);
      expect(authorized).toEqual([d.ssh.fingerprint]);
      // The line on the host carries sshd's own deadline, so the key dies with the grant even if the panel does not.
      expect(d.ssh.authorizedLine).toBe(`expiry-time="${sshExpiryTime(grant.expiresAt)}" ${d.ssh.publicKey}`);
      // Host-local stamp without a UTC suffix: the form every OpenSSH >= 7.7 accepts; stored exactly as written.
      expect(grant.ssh.expiry).toMatch(/^\d{14}$/);
      expect(grant.ssh.expiry).toBe(sshExpiryTime(grant.expiresAt));
      expect(d.ssh.expiry).toBe(grant.ssh.expiry);
      expect(d.ssh.sshdMinVersion).toBe('7.7');
      expect(d.ssh.expiryTimeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(app.ctx.db.prepare('SELECT ssh_expiry FROM support_access_grants WHERE id = ?').get(grant.id).ssh_expiry).toBe(grant.ssh.expiry);
      expect((await get('/api/support/access/status')).body.data).toMatchObject({ sshdMinVersion: '7.7', expiryTimeZone: d.ssh.expiryTimeZone });
      expect(app.agent.callsTo('sec.ssh_keys.add').at(-1).args.publicKey).toBe(d.ssh.authorizedLine);
      expect(catalog.get('sec.ssh_keys.add').schema.safeParse(app.agent.callsTo('sec.ssh_keys.add').at(-1).args).success).toBe(true);

      // The stored grant never carries the secrets, and the audit entry has the fingerprint but not the key.
      const stored = await get(`/api/support/access/${grant.id}`);
      expect(JSON.stringify(stored.body)).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(stored.body)).not.toContain(tokenSecret);
      const audit = auditRows('support.access.grant');
      expect(audit).toHaveLength(2);
      expect(audit[1].target).toBe(`${grant.id}:case-1001`);
      expect(audit[1].args_redacted).not.toContain(tokenSecret);
      expect(JSON.parse(audit[1].args_redacted)).toMatchObject({ hours: 2, ssh: true, api: true, apiCredentialId: grant.apiToken.id, fingerprint: d.ssh.fingerprint, sshExpiry: grant.ssh.expiry });

      // The token works as root and expires with the grant.
      const tokenRow = app.ctx.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(grant.apiToken.id);
      expect(tokenRow.expires_at).toBe(grant.expiresAt);
      expect(tokenRow.name).toBe('support-case-1001');
      const viaToken = await request(app.ctx.app).get('/api/system/status').set('Authorization', `Bearer ${tokenSecret}`);
      expect(viaToken.status).toBe(200);
      expect((await get('/api/support/access/status')).body.data.active).toHaveLength(1);
      expect((await get('/api/support/center')).body.data.access).toMatchObject({ active: [expect.objectContaining({ id: grant.id })], sshd: true });
    });

    it('does not keep a key on the host when the grant cannot be recorded', async () => {
      agentFail('sec.ssh_keys.add', 'exists', 'already authorized');
      const dup = await post('/api/support/access', { label: 'dup', hours: 1 });
      expect(dup.status).toBe(409);
      app.agent.set('sec.ssh_keys.add', addKey);
      const before = authorized.length;
      const tokenMax = app.ctx.settings.get('development.tokens.max_per_user');
      app.ctx.settings.set('development.tokens.max_per_user', 0);
      const res = await post('/api/support/access', { label: 'rollback', hours: 1 });
      app.ctx.settings.set('development.tokens.max_per_user', tokenMax ?? 50);
      expect(res.status).toBe(409);
      expect(authorized.length).toBe(before);
      expect(app.agent.callsTo('sec.ssh_keys.remove').at(-1).args.fingerprint).toBeDefined();
      expect((await get('/api/support/access')).body.meta.total).toBe(2);
    });

    it('revokes early: key removed, token expired, audited', async () => {
      const res = await del(`/api/support/access/${grant.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'revoked', endedBy: 'root', cleanup: { ssh: { removed: 1 }, api: { expired: true }, ok: true } });
      expect(authorized).toEqual([]);
      const viaToken = await request(app.ctx.app).get('/api/system/status').set('Authorization', `Bearer ${tokenSecret}`);
      expect(viaToken.status).toBe(401);
      expect(auditRows('support.access.revoke')).toHaveLength(2);
      expect((await del(`/api/support/access/${grant.id}`)).status).toBe(409);
      expect((await del('/api/support/access/999')).status).toBe(404);
    });

    it('expires due grants from the scheduled job, tolerating a key already gone', async () => {
      const a = await post('/api/support/access', { label: 'due-1', hours: 1 });
      const b = await post('/api/support/access', { label: 'due-2', hours: 1, ssh: false });
      const c = await post('/api/support/access', { label: 'later', hours: 5 });
      expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
      const past = utcStamp(Date.now() - 60_000);
      app.ctx.db.prepare('UPDATE support_access_grants SET expires_at = ? WHERE id IN (?, ?)').run(past, a.body.data.grant.id, b.body.data.grant.id);
      authorized = authorized.filter((f) => f !== a.body.data.ssh.fingerprint);
      expect((await get(`/api/support/access/${a.body.data.grant.id}`)).body.data.overdue).toBe(true);

      const job = app.ctx.jobs.enqueue('support.expire_access');
      expect(job.type).toBe('support.expire_access');
      const run = await post('/api/support/access/expire-due');
      expect(run.status).toBe(200);
      expect(run.body.data.expired).toBe(2);
      expect(run.body.data.grants.map((g) => g.label).sort()).toEqual(['due-1', 'due-2']);
      const expiredA = run.body.data.grants.find((g) => g.label === 'due-1');
      expect(expiredA).toMatchObject({ status: 'expired', endedBy: 'root', cleanup: { ssh: { removed: 0 }, api: { expired: true }, ok: true } });
      expect((await get(`/api/support/access/${c.body.data.grant.id}`)).body.data.status).toBe('active');
      expect(authorized).toEqual([c.body.data.ssh.fingerprint]);
      expect(auditRows('support.access.expire')).toHaveLength(2);

      const list = await get('/api/support/access?status=expired');
      expect(list.body.meta.total).toBe(2);
      expect((await get('/api/support/access?status=active')).body.meta.total).toBe(1);
      expect((await get('/api/support/access?q=due')).body.meta.total).toBe(2);

      // The job handler itself, as the scheduler would run it, audits as the scheduler.
      app.ctx.db.prepare('UPDATE support_access_grants SET expires_at = ? WHERE id = ?').run(past, c.body.data.grant.id);
      const result = await app.ctx.support.access.expireDue({ log: () => {} });
      expect(result.expired).toBe(1);
      expect(authorized).toEqual([]);
      const row = auditRows('support.access.expire').at(-1);
      expect(row.principal).toBe('scheduler');
      expect(app.ctx.scheduler.list().find((s) => s.name === 'support-access-expiry')).toMatchObject({ job_type: 'support.expire_access', cron: '*/5 * * * *' });
    });

    it('keeps a grant live while the root key cannot be removed, retries it and ends it once the host is clean', async () => {
      const g = await post('/api/support/access', { label: 'lost-sshd', hours: 1 });
      expect(g.status).toBe(201);
      const id = g.body.data.grant.id;
      const fingerprint = g.body.data.ssh.fingerprint;
      agentFail('sec.ssh_keys.remove', 'agent_unavailable', 'agent socket timed out');
      const res = await del(`/api/support/access/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'cleanup_pending', cleanupPending: true, pendingStatus: 'revoked', endedBy: 'root', cleanup: { ssh: { removed: 0, error: 'agent socket timed out', code: 'agent_unavailable' }, api: { expired: true }, ok: false, pending: 'revoked', attempts: 1 } });
      expect(res.body.data.endedAt).toBeTruthy();
      expect(authorized).toEqual([fingerprint]);
      expect(auditRows('support.access.revoke').at(-1).result).toBe('partial');
      // Surfaced everywhere an admin looks, and still counted as live for other categories.
      expect((await get('/api/support/access/status')).body.data.cleanupPending.map((x) => x.id)).toEqual([id]);
      expect((await get('/api/support/center')).body.data.access).toMatchObject({ cleanupPending: [expect.objectContaining({ id })], active: [] });
      expect((await get('/api/support/access?status=cleanup_pending')).body.meta.total).toBe(1);
      expect(app.ctx.support.activeGrants().map((x) => x.id)).toEqual([id]);

      // The scheduled run retries while the agent is still down and leaves the row pending; the token is not re-expired.
      const tokenRow = () => app.ctx.db.prepare('SELECT expires_at FROM api_tokens WHERE id = ?').get(g.body.data.apiToken.id);
      const tokenExpiry = tokenRow().expires_at;
      agentFail('sec.ssh_keys.remove', 'capability_missing', 'sshd gone');
      const retry = await app.ctx.support.access.expireDue({ log: () => {} });
      expect(retry).toMatchObject({ expired: 0, pending: 1 });
      expect(retry.grants[0]).toMatchObject({ id, status: 'cleanup_pending', cleanup: { ssh: { code: 'capability_missing' }, pending: 'revoked', attempts: 2 } });
      expect(tokenRow().expires_at).toBe(tokenExpiry);
      expect(authorized).toEqual([fingerprint]);
      expect(auditRows('support.access.revoke').at(-1)).toMatchObject({ principal: 'scheduler', result: 'partial' });

      // Once the agent answers again the key goes and the grant ends with the status that was asked for.
      app.agent.set('sec.ssh_keys.remove', realSchema('sec.ssh_keys.remove', removeKey));
      const run = await post('/api/support/access/expire-due');
      expect(run.status).toBe(200);
      expect(run.body.data).toMatchObject({ expired: 1, pending: 0 });
      expect(run.body.data.grants[0]).toMatchObject({ id, status: 'revoked', cleanupPending: false, pendingStatus: null, endedBy: 'root', cleanup: { ssh: { removed: 1 }, api: { expired: true }, ok: true, attempts: 3 } });
      expect(authorized).toEqual([]);
      expect((await get('/api/support/access/status')).body.data.cleanupPending).toEqual([]);
      expect(auditRows('support.access.revoke').at(-1).result).toBe('ok');
      expect((await del(`/api/support/access/${id}`)).status).toBe(409);
    });

    it('ends a grant whose key was removed by hand even when the token service is the part that fails', async () => {
      const g = await post('/api/support/access', { label: 'by-hand', hours: 1, apiToken: false });
      expect(g.status).toBe(201);
      authorized = [];
      const res = await del(`/api/support/access/${g.body.data.grant.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'revoked', cleanup: { ssh: { removed: 0 }, ok: true } });
      expect(res.body.data.cleanup.api).toBeUndefined();
    });
  });
});
