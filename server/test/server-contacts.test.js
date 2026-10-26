import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { normalizeNotification, validateAddress, maskAddress, isPrivateAddress, createServerContactsService, EVENTS } from '../src/services/server-contacts.js';
import { buildMessage, dotStuff, sendSmtp, isLoopbackHost } from '../src/services/server-contacts-smtp.js';

// A tiny SMTP server that records the session so the relay path is exercised
// for real (greeting, EHLO, AUTH PLAIN, envelope, DATA).
function fakeSmtp() {
  const sessions = [];
  let reject = null;
  const server = net.createServer((socket) => {
    const session = { commands: [], data: '', auth: null };
    sessions.push(session);
    let inData = false;
    let buf = '';
    socket.write('220 relay.test ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write(reject === 'data' ? '554 5.7.1 content rejected\r\n' : '250 2.0.0 queued as ABC123\r\n'); } else session.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        session.commands.push(line.replace(/^(AUTH PLAIN) .*/, '$1 [redacted]'));
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write('250-relay.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') { session.auth = Buffer.from(line.split(' ')[2], 'base64').toString('utf8').split('\0'); socket.write(session.auth[2] === 'secret-pass' ? '235 2.7.0 ok\r\n' : '535 5.7.8 bad credentials\r\n'); }
        else if (verb === 'MAIL') socket.write('250 2.1.0 ok\r\n');
        else if (verb === 'RCPT') socket.write(reject === 'rcpt' ? '550 5.1.1 no such user\r\n' : '250 2.1.5 ok\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); } else socket.write('500 what\r\n');
      }
    });
  });
  return {
    sessions,
    setReject: (r) => { reject = r; },
    listen: () => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port))),
    close: () => new Promise((res) => server.close(res)),
  };
}

function fakeWebhook() {
  const received = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null, raw: body }); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  return {
    received,
    setStatus: (s) => { status = s; },
    listen: () => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port))),
    close: () => new Promise((res) => server.close(res)),
  };
}

describe('server contacts helpers', () => {
  it('normalizes the object and shorthand notify() forms', () => {
    expect(normalizeNotification({ event: 'backup.failed', subject: 'Run 7 failed', body: 'x' })).toMatchObject({ event: 'backup.failed', severity: 'error', subject: 'Run 7 failed', body: 'x' });
    expect(normalizeNotification({ event: 'service.down', severity: 'critical', subject: 'a\r\nb' })).toMatchObject({ severity: 'critical', subject: 'a b' });
    const short = normalizeNotification('updates.available', { packages: 3, security: 1 });
    expect(short).toMatchObject({ event: 'updates.available', severity: 'info', subject: 'Software updates available' });
    expect(JSON.parse(short.body)).toEqual({ packages: 3, security: 1 });
    expect(normalizeNotification('custom.thing', 'plain text')).toMatchObject({ event: 'custom.thing', severity: 'info', subject: 'custom.thing', body: 'plain text' });
    expect(normalizeNotification({ event: 'login.new_ip', severity: 'nonsense' }).severity).toBe('warning');
  });

  it('masks credential-bearing addresses and leaves the rest alone', () => {
    expect(maskAddress('slack', 'https://hooks.slack.com/services/T000/B000/XXXXXXXX')).toEqual({ display: 'hooks.slack.com/services/T000…/…XXXX', secret: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX' });
    expect(maskAddress('webhook', 'https://example.com/hook?key=abc')).toEqual({ display: 'https://example.com/hook?…', secret: 'https://example.com/hook?key=abc' });
    expect(maskAddress('webhook', 'https://example.com/hook')).toEqual({ display: 'https://example.com/hook', secret: null });
    expect(maskAddress('email', 'ops@example.com')).toEqual({ display: 'ops@example.com', secret: null });
    expect(maskAddress('pushover', 'u'.repeat(30))).toEqual({ display: 'u'.repeat(30), secret: null });
  });

  it('validates addresses per channel', () => {
    expect(validateAddress('email', 'ops@example.com')).toBeNull();
    expect(validateAddress('email', '-r@example.com')).not.toBeNull();
    expect(validateAddress('slack', 'https://hooks.slack.com/services/T000/B000/XXXXXXXX')).toBeNull();
    expect(validateAddress('slack', 'https://evil.example.com/services/T000/B000/XXXXXXXX')).not.toBeNull();
    expect(validateAddress('pushover', 'u'.repeat(30))).toBeNull();
    expect(validateAddress('pushover', 'short')).not.toBeNull();
    expect(validateAddress('webhook', 'https://example.com/hook?x=1')).toBeNull();
    expect(validateAddress('webhook', 'ftp://example.com/hook')).not.toBeNull();
    expect(validateAddress('webhook', 'https://user:pw@example.com/hook')).not.toBeNull();
    expect(validateAddress('sms', '5551234567@txt.example.net')).toBeNull();
  });

  it('builds RFC 5322 messages with CRLF, dot-stuffing and encoded subjects', () => {
    const msg = buildMessage({ from: 'whm@host.example.com', to: ['a@example.com'], subject: 'Disk 95% – full', text: 'line1\n.hidden\nline3', headers: { 'X-Priority': '1', Subject: 'ignored', 'Bad Header': 'x' } });
    expect(msg).toMatch(/^From: whm@host\.example\.com\r\nTo: a@example\.com\r\nSubject: =\?UTF-8\?B\?/);
    expect(msg).toContain('X-Priority: 1\r\n');
    expect(msg).not.toContain('ignored');
    expect(msg).not.toContain('Bad Header');
    expect(msg.endsWith('\r\nline1\r\n.hidden\r\nline3\r\n')).toBe(true);
    expect(dotStuff('a\n.b\n..c\n')).toBe('a\r\n..b\r\n...c\r\n');
  });

  it('rejects unusable addresses before opening a connection', async () => {
    await expect(sendSmtp({ host: '127.0.0.1', port: 1, from: '-r@example.com', to: ['a@example.com'], message: 'x' })).rejects.toMatchObject({ code: 'invalid_address' });
    await expect(sendSmtp({ host: '127.0.0.1', port: 1, from: 'a@example.com', to: ['b@example.com'], message: 'x', security: 'weird' })).rejects.toMatchObject({ code: 'invalid_args' });
  });

  it('refuses to authenticate over a plain connection unless the relay is loopback or the admin allowed it', async () => {
    const base = { port: 25, security: 'none', username: 'relay', password: 'pw', from: 'a@example.com', to: ['b@example.com'], message: 'x' };
    await expect(sendSmtp({ ...base, host: 'relay.example.net' })).rejects.toMatchObject({ code: 'plaintext_auth_refused' });
    await expect(sendSmtp({ ...base, host: '192.0.2.10' })).rejects.toMatchObject({ code: 'plaintext_auth_refused' });
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('relay.example.net')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });

  it('classifies loopback, link-local, private and mapped addresses as private webhook targets', () => {
    for (const a of ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[::1]']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111', 'example.com', '']) expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('Server Contacts API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerCsrf;
  let smtp;
  let smtpPort;
  let hook;
  let hookPort;
  let eximInstalled = false;
  let units = [];
  let unitState = {};
  let disks = [];
  let sentViaExim = [];
  let aliases = { root: [], entries: [], exists: true };
  let aliasWrites = [];

  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const put = (url, body) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
  const patch = (url, body) => app.http.patch(url).set('X-CSRF-Token', csrf).send(body);
  const del = (url) => app.http.delete(url).set('X-CSRF-Token', csrf);
  const get = (url) => app.http.get(url);
  const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const clearContacts = () => { app.ctx.db.prepare('DELETE FROM contacts').run(); app.ctx.db.prepare('DELETE FROM contact_deliveries').run(); app.ctx.db.prepare('DELETE FROM contact_alert_state').run(); };

  beforeAll(async () => {
    smtp = fakeSmtp();
    smtpPort = await smtp.listen();
    hook = fakeWebhook();
    hookPort = await hook.listen();
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, eximInstalled && ['exim4', 'exim'].includes(n)])),
      'svc.list_units': () => units,
      'svc.status': ({ unit }) => ({ unit, installed: true, active: unitState[unit] !== 'inactive', state: unitState[unit] || 'active', subState: unitState[unit] === 'inactive' ? 'dead' : 'running', enabled: true, pid: 100, memoryBytes: 1024, restarts: 0 }),
      'sys.disk.usage': () => disks,
      'mail.sendmail': (args) => { sentViaExim.push(args); return { from: args.from, to: args.to, accepted: true, bytes: 100 }; },
      'contacts.aliases.read': () => ({ path: '/etc/aliases', exists: aliases.exists, root: aliases.root, users: { root: aliases.root, nobody: aliases.users?.nobody || [] }, managed: false, entries: aliases.entries, raw: '', rebuildTool: 'exim' }),
      'contacts.aliases.set_root': ({ targets }) => { aliasWrites.push(targets); aliases.root = targets; return { path: '/etc/aliases', user: 'root', targets, root: targets, rebuild: { tool: 'newaliases', ran: true, ok: true, output: '' } }; },
      'contacts.aliases.set': ({ user, targets }) => { aliasWrites.push([user, targets]); aliases.users = { ...(aliases.users || {}), [user]: targets }; if (user === 'root') aliases.root = targets; return { path: '/etc/aliases', user, targets, root: aliases.root, rebuild: { tool: 'newaliases', ran: true, ok: true, output: '' } }; },
      'contacts.exim.primary_hostname': () => ({ installed: eximInstalled, hostname: eximInstalled ? 'mx.example.org' : null }),
    });
    app = await createTestApp({ agent });
    app.ctx.jobs.start();
    csrf = await app.login();
    const r = await app.createUser('resell1', 'reseller');
    reseller = request.agent(app.ctx.app);
    resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
  }, 30_000);

  afterAll(async () => { await app?.close(); await smtp?.close(); await hook?.close(); });

  beforeEach(async () => {
    eximInstalled = false;
    units = [];
    unitState = {};
    disks = [{ filesystem: '/dev/sda1', sizeBytes: 100e9, usedBytes: 20e9, availableBytes: 80e9, usedPercent: 20, mountpoint: '/' }];
    sentViaExim = [];
    aliasWrites = [];
    aliases = { root: ['ops@example.com'], entries: [{ name: 'postmaster', targets: ['root'] }, { name: 'root', targets: ['ops@example.com'] }], exists: true };
    smtp.setReject(null);
    smtp.sessions.length = 0;
    hook.received.length = 0;
    hook.setStatus(200);
    await app.ctx.capabilities.refresh();
    clearContacts();
    app.ctx.settings.setMany({ 'contacts.enabled': true, 'contacts.smtp.host': '', 'contacts.smtp.prefer': false, 'contacts.smtp.username': '', 'contacts.smtp.password_enc': '', 'contacts.smtp.allow_plaintext_auth': false, 'contacts.from_address': '', 'contacts.check.enabled': true, 'contacts.root_mail_events': ['service.down', 'disk.space.low', 'backup.failed'], 'contacts.root_forward': [], 'contacts.nobody_forward': [], 'contacts.webhook.allow_private': true });
  });

  // "Run checks now" is a job: 202 { job }, then the result once it finishes.
  const runCheck = async () => {
    const res = await post('/api/server-contacts/check').expect(202);
    expect(res.body.data.job).toMatchObject({ type: 'server-contacts.check', params: { manual: true } });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    if (job.status !== 'done') throw new Error(`check job ${job.status}: ${job.error}`);
    return { body: { data: job.result } };
  };

  it('registers the module: ctx.contacts, job type, schedule and the integration surface', () => {
    expect(typeof app.ctx.contacts.notify).toBe('function');
    expect(typeof app.ctx.contacts.mail).toBe('function');
    expect(app.ctx.contacts.sendMail).toBeUndefined();
    expect(app.ctx.jobs.types()).toContain('server-contacts.check');
    expect(app.ctx.scheduler.list().find((s) => s.name === 'server-contacts-check')).toMatchObject({ cron: '*/10 * * * *', job_type: 'server-contacts.check', enabled: 1 });
  });

  it('GET / returns the catalog, settings, capability and an empty contact list', async () => {
    const { data } = (await get('/api/server-contacts').expect(200)).body;
    expect(data.contacts).toEqual([]);
    expect(data.events.map((e) => e.key)).toEqual(EVENTS.map((e) => e.key));
    expect(data.events.map((e) => e.key)).toEqual(expect.arrayContaining(['account.created', 'account.suspended', 'backup.failed', 'service.down', 'disk.space.low', 'login.failed.blocked', 'ssl.expiring', 'license.expiring', 'license.invalid']));
    expect(data.channels).toEqual(['email', 'sms', 'slack', 'pushover', 'webhook']);
    expect(data.capability).toMatchObject({ exim: false, smtp: false, mailTransport: null, hostname: 'panel.example.com' });
    expect(data.settings).toMatchObject({ enabled: true, effectiveFrom: 'whm@panel.example.com', smtp: { host: '', port: 587, security: 'starttls', password: { set: false } }, check: { enabled: true, diskThresholdPercent: 90, cooldownMinutes: 360 } });
    expect(data.schedule).toMatchObject({ name: 'server-contacts-check', enabled: true });
    expect(data.stats).toEqual({ total: 0, last24h: 0, failed: 0 });
  });

  it('creates, reads, updates and removes contacts with per-channel validation', async () => {
    const created = await post('/api/server-contacts/contacts', { name: 'Ops', channel: 'email', address: 'ops@example.com', events: ['service.down', 'disk.space.low'], minSeverity: 'warning' }).expect(201);
    expect(created.body.data).toMatchObject({ name: 'Ops', channel: 'email', address: 'ops@example.com', events: ['service.down', 'disk.space.low'], allEvents: false, minSeverity: 'warning', enabled: true, lastSentAt: null });
    const id = created.body.data.id;
    expect((await get(`/api/server-contacts/contacts/${id}`).expect(200)).body.data.id).toBe(id);
    const all = await post('/api/server-contacts/contacts', { channel: 'webhook', address: `http://127.0.0.1:${hookPort}/hook`, config: { secret: 'shh' } }).expect(201);
    expect(all.body.data).toMatchObject({ name: `http://127.0.0.1:${hookPort}/hook`, events: ['*'], allEvents: true, minSeverity: 'info', config: { secret: { set: true } } });
    expect(app.ctx.db.prepare('SELECT config_json FROM contacts WHERE id = ?').get(all.body.data.id).config_json).toMatch(/"secret_enc":"v1:/);
    // A stored signing secret is kept when the field is absent, replaced when set, and removed by null or a blank (whitespace-only) value.
    expect((await patch(`/api/server-contacts/contacts/${all.body.data.id}`, { name: 'Hook' }).expect(200)).body.data.config).toEqual({ secret: { set: true } });
    expect((await patch(`/api/server-contacts/contacts/${all.body.data.id}`, { config: { secret: '   ' } }).expect(200)).body.data.config).toEqual({});
    expect(app.ctx.db.prepare('SELECT config_json FROM contacts WHERE id = ?').get(all.body.data.id).config_json).not.toContain('secret_enc');
    expect((await patch(`/api/server-contacts/contacts/${all.body.data.id}`, { config: { secret: 'again' } }).expect(200)).body.data.config).toEqual({ secret: { set: true } });
    expect((await patch(`/api/server-contacts/contacts/${all.body.data.id}`, { config: { secret: null } }).expect(200)).body.data.config).toEqual({});
    const listed = (await get('/api/server-contacts/contacts').expect(200)).body.data;
    expect(listed.map((c) => c.id).sort()).toEqual([id, all.body.data.id].sort());
    const catalog = (await get('/api/server-contacts/events').expect(200)).body.data;
    expect(catalog.map((e) => e.key)).toEqual(EVENTS.map((e) => e.key));
    expect(catalog.find((e) => e.key === 'backup.failed').wired).toBe(true);
    expect(catalog.find((e) => e.key === 'account.rearrange').wired).toBe(true);
    expect(catalog.filter((e) => !e.wired).map((e) => e.key)).toEqual(expect.arrayContaining(['account.created', 'backup.completed', 'license.expiring']));

    await post('/api/server-contacts/contacts', { channel: 'slack', address: 'https://example.com/not-slack' }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'pushover', address: 'u'.repeat(30) }).expect(422);
    const po = await post('/api/server-contacts/contacts', { name: 'Phone', channel: 'pushover', address: 'u'.repeat(30), config: { token: 'a'.repeat(30) } }).expect(201);
    expect(po.body.data.config).toEqual({ token: { set: true } });
    await post('/api/server-contacts/contacts', { channel: 'webhook', address: 'https://user:pw@example.com/x' }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'email', address: '-r@example.com' }).expect(422);

    const updated = await patch(`/api/server-contacts/contacts/${id}`, { events: [], minSeverity: 'info', enabled: false, name: 'Ops team' }).expect(200);
    expect(updated.body.data).toMatchObject({ name: 'Ops team', events: ['*'], allEvents: true, minSeverity: 'info', enabled: false });
    // Narrowing an all-events contact must drop the "*" marker; a mixed list is refused rather than silently matching everything.
    const narrowed = await patch(`/api/server-contacts/contacts/${id}`, { events: ['service.down'] }).expect(200);
    expect(narrowed.body.data).toMatchObject({ events: ['service.down'], allEvents: false });
    expect(JSON.parse(app.ctx.db.prepare('SELECT events_json FROM contacts WHERE id = ?').get(id).events_json)).toEqual(['service.down']);
    const mixed = await patch(`/api/server-contacts/contacts/${id}`, { events: ['*', 'service.down'] }).expect(422);
    expect(mixed.body.error.fields.events[0]).toMatch(/not both/);
    expect(JSON.parse(app.ctx.db.prepare('SELECT events_json FROM contacts WHERE id = ?').get(id).events_json)).toEqual(['service.down']);
    expect((await post('/api/server-contacts/contacts', { channel: 'email', address: 'mixed@example.com', events: ['*', 'backup.failed'] }).expect(422)).body.error.fields.events).toBeDefined();
    expect((await patch(`/api/server-contacts/contacts/${id}`, { events: ['*', '*'] }).expect(200)).body.data).toMatchObject({ events: ['*'], allEvents: true });
    await patch(`/api/server-contacts/contacts/${id}`, { address: 'nope' }).expect(422);
    await patch(`/api/server-contacts/contacts/${po.body.data.id}`, { config: { token: null } }).expect(422);
    expect((await patch(`/api/server-contacts/contacts/${po.body.data.id}`, { config: { token: 'b'.repeat(30) } }).expect(200)).body.data.config.token.set).toBe(true);
    expect((await del(`/api/server-contacts/contacts/${id}`).expect(200)).body.data).toMatchObject({ removed: true, id });
    await del(`/api/server-contacts/contacts/${id}`).expect(404);
    await get(`/api/server-contacts/contacts/${id}`).expect(404);
    expect(auditRows('contacts.create')).toHaveLength(3);
    expect(auditRows('contacts.remove')).toHaveLength(1);
  });

  it('treats Slack and token-bearing webhook URLs as secrets: encrypted at rest, masked in responses, deliveries and audit, still delivered to the real URL', async () => {
    const slackUrl = 'https://hooks.slack.com/services/T0ABCDEF/B0GHIJKL/SeCrEtToKeN12345678';
    const slack = await post('/api/server-contacts/contacts', { name: 'Slack', channel: 'slack', address: slackUrl, config: { channelName: '#alerts' } }).expect(201);
    expect(slack.body.data).toMatchObject({ address: 'hooks.slack.com/services/T0AB…/…5678', config: { channelName: '#alerts', url: { set: true } } });
    expect(JSON.stringify(slack.body.data)).not.toContain('SeCrEtToKeN');
    const stored = app.ctx.db.prepare('SELECT address, config_json FROM contacts WHERE id = ?').get(slack.body.data.id);
    expect(stored.address).toBe('hooks.slack.com/services/T0AB…/…5678');
    expect(stored.config_json).toMatch(/"url_enc":"v1:/);
    expect(stored.config_json).not.toContain('SeCrEtToKeN');
    expect(app.ctx.crypto.decrypt(JSON.parse(stored.config_json).url_enc)).toBe(slackUrl);
    expect(auditRows('contacts.create').at(-1).target).toBe('hooks.slack.com/services/T0AB…/…5678');
    expect(JSON.stringify(auditRows('contacts.create').at(-1))).not.toContain('SeCrEtToKeN');
    const genericCreate = auditRows('POST /api/server-contacts/contacts').at(-1);
    expect(JSON.parse(genericCreate.args_redacted).address).toBe('hooks.slack.com/services/T0AB…/…5678');
    expect(JSON.stringify(genericCreate)).not.toContain('SeCrEtToKeN');

    const hookUrl = `http://127.0.0.1:${hookPort}/notify?token=QueryToken987`;
    const wh = await post('/api/server-contacts/contacts', { name: 'Tokened hook', channel: 'webhook', address: hookUrl }).expect(201);
    expect(wh.body.data).toMatchObject({ address: `http://127.0.0.1:${hookPort}/notify?…`, config: { url: { set: true } } });
    const plain = await post('/api/server-contacts/contacts', { name: 'Plain hook', channel: 'webhook', address: `http://127.0.0.1:${hookPort}/plain` }).expect(201);
    expect(plain.body.data).toMatchObject({ address: `http://127.0.0.1:${hookPort}/plain`, config: {} });

    const r = await app.ctx.contacts.notify({ event: 'backup.failed', subject: 'Run 3 failed', body: 'x' });
    expect(r).toMatchObject({ matched: 3, sent: 2, failed: 1 });
    expect(hook.received.map((h) => h.url).sort()).toEqual(['/notify?token=QueryToken987', '/plain']);
    const slackDelivery = r.deliveries.find((d) => d.channel === 'slack');
    expect(slackDelivery).toMatchObject({ address: 'hooks.slack.com/services/T0AB…/…5678', status: 'failed' });
    expect(slackDelivery.error).not.toContain('SeCrEtToKeN');
    const logged = app.ctx.db.prepare('SELECT address, error FROM contact_deliveries ORDER BY id').all();
    expect(logged.map((d) => d.address).sort()).toEqual(['hooks.slack.com/services/T0AB…/…5678', `http://127.0.0.1:${hookPort}/notify?…`, `http://127.0.0.1:${hookPort}/plain`]);
    expect(JSON.stringify(logged)).not.toMatch(/SeCrEtToKeN|QueryToken/);
    const tested = await post(`/api/server-contacts/contacts/${wh.body.data.id}/test`).expect(200);
    expect(tested.body.data.address).toBe(`http://127.0.0.1:${hookPort}/notify?…`);
    expect(auditRows('contacts.test').at(-1).target).toBe(`http://127.0.0.1:${hookPort}/notify?…`);

    // Editing: the masked form the edit form echoes back keeps the stored URL; a new URL replaces it; a non-URL is refused.
    const kept = await patch(`/api/server-contacts/contacts/${slack.body.data.id}`, { address: 'hooks.slack.com/services/T0AB…/…5678', name: 'Slack ops' }).expect(200);
    expect(kept.body.data).toMatchObject({ name: 'Slack ops', address: 'hooks.slack.com/services/T0AB…/…5678', config: { channelName: '#alerts', url: { set: true } } });
    expect(app.ctx.crypto.decrypt(JSON.parse(app.ctx.db.prepare('SELECT config_json FROM contacts WHERE id = ?').get(slack.body.data.id).config_json).url_enc)).toBe(slackUrl);
    const replaced = await patch(`/api/server-contacts/contacts/${slack.body.data.id}`, { address: 'https://hooks.slack.com/services/T0ABCDEF/B0GHIJKL/NewToken000099' }).expect(200);
    expect(replaced.body.data.address).toBe('hooks.slack.com/services/T0AB…/…0099');
    expect(app.ctx.crypto.decrypt(JSON.parse(app.ctx.db.prepare('SELECT config_json FROM contacts WHERE id = ?').get(slack.body.data.id).config_json).url_enc)).toBe('https://hooks.slack.com/services/T0ABCDEF/B0GHIJKL/NewToken000099');
    expect(JSON.stringify(auditRows('contacts.update').at(-1))).not.toContain('NewToken');
    const genericPatch = auditRows('PATCH /api/server-contacts/contacts/:id').at(-1);
    expect(JSON.parse(genericPatch.args_redacted).address).toBe('hooks.slack.com/services/T0AB…/…0099');
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%NewToken%' OR args_redacted LIKE '%SeCrEtToKeN%' OR target LIKE '%NewToken%' OR target LIKE '%SeCrEtToKeN%'").get().n).toBe(0);
    // A query-string token is masked the same way, and a rejected URL with embedded credentials never reaches the log either.
    await post('/api/server-contacts/contacts', { channel: 'webhook', address: `http://127.0.0.1:${hookPort}/q?token=AuditQueryToken` }).expect(201);
    expect(JSON.parse(auditRows('POST /api/server-contacts/contacts').at(-1).args_redacted).address).toBe(`http://127.0.0.1:${hookPort}/q?…`);
    await post('/api/server-contacts/contacts', { channel: 'webhook', address: 'https://user:BasicPw123@example.com/x' }).expect(422);
    expect(JSON.parse(auditRows('POST /api/server-contacts/contacts').at(-1).args_redacted).address).toBe('[redacted]');
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%AuditQueryToken%' OR args_redacted LIKE '%BasicPw123%'").get().n).toBe(0);
    await patch(`/api/server-contacts/contacts/${slack.body.data.id}`, { channel: 'email' }).expect(422);
    await patch(`/api/server-contacts/contacts/${plain.body.data.id}`, { channel: 'slack' }).expect(422);
    const dropped = await patch(`/api/server-contacts/contacts/${wh.body.data.id}`, { address: `http://127.0.0.1:${hookPort}/no-token` }).expect(200);
    expect(dropped.body.data).toMatchObject({ address: `http://127.0.0.1:${hookPort}/no-token`, config: {} });
    expect((await del(`/api/server-contacts/contacts/${slack.body.data.id}`).expect(200)).body.data.address).toBe('hooks.slack.com/services/T0AB…/…0099');
    expect(auditRows('contacts.remove').at(-1).target).toBe('hooks.slack.com/services/T0AB…/…0099');
  });

  it('converts plaintext webhook URLs stored by earlier versions into the encrypted form at boot', async () => {
    const legacy = 'https://hooks.slack.com/services/T0LEGACY/B0LEGACY/LegacyToken4321';
    const { lastInsertRowid } = app.ctx.db.prepare("INSERT INTO contacts (channel, address, events_json, enabled, config_json) VALUES ('slack', ?, '[\"*\"]', 1, '{\"channelName\":\"#old\"}')").run(legacy);
    app.ctx.db.prepare("INSERT INTO contact_deliveries (contact_id, contact_name, channel, address, event, severity, subject, status) VALUES (?, 'old', 'slack', ?, 'test', 'info', 's', 'sent')").run(lastInsertRowid, legacy);
    createServerContactsService(app.ctx);
    const row = app.ctx.db.prepare('SELECT address, config_json FROM contacts WHERE id = ?').get(lastInsertRowid);
    expect(row.address).toBe('hooks.slack.com/services/T0LE…/…4321');
    expect(JSON.parse(row.config_json).channelName).toBe('#old');
    expect(app.ctx.crypto.decrypt(JSON.parse(row.config_json).url_enc)).toBe(legacy);
    expect(app.ctx.db.prepare('SELECT address FROM contact_deliveries WHERE contact_id = ?').get(lastInsertRowid).address).toBe('hooks.slack.com/services/T0LE…/…4321');
    expect((await get(`/api/server-contacts/contacts/${lastInsertRowid}`).expect(200)).body.data.address).toBe('hooks.slack.com/services/T0LE…/…4321');
  });

  it('delivers notifications to matching contacts (webhook signed, email failing without a transport) and logs every attempt', async () => {
    await post('/api/server-contacts/contacts', { name: 'Hook', channel: 'webhook', address: `http://127.0.0.1:${hookPort}/whm`, config: { secret: 'topsecret' } }).expect(201);
    await post('/api/server-contacts/contacts', { name: 'Ops', channel: 'email', address: 'ops@example.com', events: ['backup.failed'] }).expect(201);
    await post('/api/server-contacts/contacts', { name: 'Only errors', channel: 'webhook', address: `http://127.0.0.1:${hookPort}/errors`, minSeverity: 'error' }).expect(201);
    await post('/api/server-contacts/contacts', { name: 'Off', channel: 'webhook', address: `http://127.0.0.1:${hookPort}/off`, enabled: false }).expect(201);

    const res = await post('/api/server-contacts/notify', { event: 'account.created', subject: 'Account alice created', body: 'alice.com' }).expect(200);
    expect(res.body.data).toMatchObject({ event: 'account.created', severity: 'info', matched: 1, sent: 1, failed: 0 });
    expect(hook.received).toHaveLength(1);
    expect(hook.received[0].url).toBe('/whm');
    expect(hook.received[0].body).toMatchObject({ event: 'account.created', severity: 'info', subject: 'Account alice created', body: 'alice.com', hostname: 'panel.example.com', test: false });
    expect(hook.received[0].headers['x-whm-event']).toBe('account.created');
    expect(hook.received[0].headers['x-whm-signature']).toBe(`sha256=${crypto.createHmac('sha256', 'topsecret').update(hook.received[0].raw).digest('hex')}`);

    const r2 = await app.ctx.contacts.notify({ event: 'backup.failed', subject: 'Backup run 9 failed', body: 'disk full', severity: 'error' });
    expect(r2).toMatchObject({ matched: 3, sent: 2, failed: 1 });
    expect(hook.received.map((h) => h.url).sort()).toEqual(['/errors', '/whm', '/whm']);
    const email = r2.deliveries.find((d) => d.channel === 'email' && d.contactId);
    expect(email).toMatchObject({ status: 'failed', code: 'capability_missing' });
    expect(email.error).toMatch(/Exim is not installed/);
    const root = r2.deliveries.find((d) => d.contactId === null);
    expect(root).toBeUndefined();

    const log = await get('/api/server-contacts/deliveries').expect(200);
    expect(log.body.meta.total).toBe(4);
    expect(log.body.data[0]).toMatchObject({ event: 'backup.failed' });
    expect((await get('/api/server-contacts/deliveries?status=failed').expect(200)).body.data.map((d) => d.channel)).toEqual(['email']);
    expect((await get('/api/server-contacts/deliveries?event=account.created&q=alice').expect(200)).body.meta.total).toBe(1);
    const overview = (await get('/api/server-contacts').expect(200)).body.data;
    expect(overview.stats).toEqual({ total: 4, last24h: 4, failed: 1 });
    expect(overview.contacts.find((c) => c.name === 'Ops').lastError).toMatch(/Exim/);
    expect(overview.contacts.find((c) => c.name === 'Hook').lastSentAt).toBeTruthy();

    hook.setStatus(500);
    const r3 = await app.ctx.contacts.notify('updates.available', { packages: 4 });
    expect(r3).toMatchObject({ event: 'updates.available', matched: 1, sent: 0, failed: 1 });
    expect(r3.deliveries[0].error).toMatch(/answered 500/);
    expect(r3.deliveries[0].error).not.toContain('{"ok":true}');

    app.ctx.settings.set('contacts.enabled', false);
    expect(await app.ctx.contacts.notify({ event: 'account.created', subject: 'x' })).toMatchObject({ skipped: 'disabled', sent: 0 });
  });

  it('sends mail through the SMTP relay when Exim is absent, and mails root for selected events', async () => {
    await put('/api/server-contacts/settings', { smtp: { host: '127.0.0.1', port: smtpPort, security: 'none', username: 'relay-user', password: 'secret-pass' }, fromAddress: 'alerts@panel.example.com' }).expect(200);
    const settings = (await get('/api/server-contacts/settings').expect(200)).body.data;
    expect(settings.smtp).toMatchObject({ host: '127.0.0.1', port: smtpPort, security: 'none', username: 'relay-user', password: { set: true } });
    expect(app.ctx.settings.get('contacts.smtp.password_enc')).toMatch(/^v1:/);
    expect((await get('/api/server-contacts').expect(200)).body.data.capability).toMatchObject({ exim: false, smtp: true, mailTransport: 'smtp' });
    expect(typeof app.ctx.contacts.sendMail).toBe('function');

    const c = await post('/api/server-contacts/contacts', { name: 'Ops', channel: 'email', address: 'ops@example.com' }).expect(201);
    const test = await post(`/api/server-contacts/contacts/${c.body.data.id}/test`).expect(200);
    expect(test.body.data).toMatchObject({ status: 'sent', transport: 'smtp', channel: 'email' });
    expect(smtp.sessions).toHaveLength(1);
    const session = smtp.sessions[0];
    expect(session.commands.slice(0, 2)).toEqual(['EHLO panel.example.com', 'AUTH PLAIN [redacted]']);
    expect(session.auth).toEqual(['', 'relay-user', 'secret-pass']);
    expect(session.commands).toContain('MAIL FROM:<alerts@panel.example.com>');
    expect(session.commands).toContain('RCPT TO:<ops@example.com>');
    expect(session.data).toMatch(/^From: alerts@panel\.example\.com\n/);
    expect(session.data).toContain('Subject: [panel.example.com] Test notification from WHM on panel.example.com');
    expect(session.data).toContain('This is a test message for the email contact "Ops"');
    expect(auditRows('contacts.test').at(-1).target).toBe('ops@example.com');

    const direct = await post('/api/server-contacts/settings/test-mail', { to: 'someone@example.org' }).expect(200);
    expect(direct.body.data).toMatchObject({ transport: 'smtp', to: ['someone@example.org'], accepted: true });
    expect(smtp.sessions[1].commands).toContain('RCPT TO:<someone@example.org>');

    // Root mail over the relay goes to the saved forwarding addresses: /etc/aliases means nothing to an external relay.
    app.ctx.settings.set('contacts.root_forward', ['admin@example.net', 'oncall', 'second@example.org']);
    let prefs = (await get('/api/server-contacts/mail-preferences').expect(200)).body.data;
    expect(prefs.rootDelivery).toEqual({ transport: 'smtp', rootAddress: 'root@panel.example.com', to: ['admin@example.net', 'second@example.org'], skipped: ['oncall'], error: null });
    const r = await app.ctx.contacts.notify({ event: 'service.down', subject: 'Exim is down', body: 'dead', severity: 'error' });
    expect(r).toMatchObject({ matched: 1, sent: 2, failed: 0 });
    expect(r.deliveries.find((d) => d.contactId === null)).toMatchObject({ address: 'admin@example.net, second@example.org', to: ['admin@example.net', 'second@example.org'], status: 'sent', transport: 'smtp' });
    expect(smtp.sessions.at(-1).commands).toEqual(expect.arrayContaining(['RCPT TO:<admin@example.net>', 'RCPT TO:<second@example.org>']));
    expect(smtp.sessions.at(-1).commands.join('\n')).not.toMatch(/root@|oncall/);
    const rootTest = await post('/api/server-contacts/mail-preferences/test').expect(200);
    expect(rootTest.body.data).toMatchObject({ status: 'sent', transport: 'smtp', to: ['admin@example.net', 'second@example.org'] });
    expect(smtp.sessions.at(-1).data).toContain('Subject: [panel.example.com] Test message for root');

    // A relay with nothing to forward to is a configuration state the Mail Preferences page reports; it is not a failed delivery per event.
    app.ctx.settings.set('contacts.root_forward', ['oncall']);
    const sessionsBefore = smtp.sessions.length;
    const failedBefore = (await get('/api/server-contacts/deliveries?status=failed').expect(200)).body.meta.total;
    const r2 = await app.ctx.contacts.notify({ event: 'service.down', subject: 'still down', body: 'dead', severity: 'error' });
    expect(r2).toMatchObject({ matched: 1, sent: 1, failed: 0, rootMail: { skipped: true, reason: expect.stringMatching(/local account oncall/) } });
    expect(r2.deliveries.find((d) => d.contactId === null)).toBeUndefined();
    expect(smtp.sessions).toHaveLength(sessionsBefore + 1);
    expect((await get('/api/server-contacts/deliveries?status=failed').expect(200)).body.meta.total).toBe(failedBefore);
    app.ctx.settings.set('contacts.root_forward', []);
    prefs = (await get('/api/server-contacts/mail-preferences').expect(200)).body.data;
    expect(prefs.rootDelivery).toMatchObject({ transport: 'smtp', to: [], skipped: [], error: expect.stringMatching(/none are set/) });
    const noRecipients = await post('/api/server-contacts/mail-preferences/test').expect(422);
    expect(noRecipients.body.error).toMatchObject({ code: 'no_root_recipients', message: expect.stringMatching(/forwarding addresses/) });
    expect(smtp.sessions).toHaveLength(sessionsBefore + 1);
    app.ctx.settings.set('contacts.root_forward', ['admin@example.net']);

    smtp.setReject('rcpt');
    const failed = await post('/api/server-contacts/settings/test-mail', { to: 'nobody@example.org' }).expect(502);
    expect(failed.body.error.code).toBe('smtp_failed');
    expect(failed.body.error.message).toMatch(/RCPT failed: 550/);
    smtp.setReject(null);
    await put('/api/server-contacts/settings', { smtp: { password: 'wrong' } }).expect(200);
    expect((await post(`/api/server-contacts/contacts/${c.body.data.id}/test`).expect(502)).body.error.message).toMatch(/AUTH failed: 535/);
    await put('/api/server-contacts/settings', { smtp: { host: '127.0.0.1', port: 1, security: 'none' } }).expect(200);
    expect((await post('/api/server-contacts/settings/test-mail', { to: 'x@example.org' }).expect(502)).body.error.message).toMatch(/SMTP relay 127\.0\.0\.1:1/);
  });

  it('hands mail to Exim when it is installed, and prefers the relay only when asked', async () => {
    eximInstalled = true;
    await app.ctx.capabilities.refresh();
    expect(typeof app.ctx.contacts.sendMail).toBe('function');
    app.ctx.settings.set('basic.hostname', 'bare-host');
    await expect(app.ctx.contacts.sendMail({ to: 'a@example.com', subject: 'Hi', body: 'x' })).resolves.toMatchObject({ from: 'whm@bare-host.localdomain' });
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
    sentViaExim = [];
    const r = await app.ctx.contacts.sendMail({ to: 'a@example.com', subject: 'Hello', body: 'line1\nline2' });
    expect(r).toMatchObject({ transport: 'exim', from: 'whm@panel.example.com', to: ['a@example.com'], accepted: true });
    expect(sentViaExim).toEqual([{ from: 'whm@panel.example.com', to: ['a@example.com'], subject: 'Hello', text: 'line1\nline2' }]);
    expect(auditRows('contacts.mail.send').at(-1)).toMatchObject({ target: 'a@example.com' });
    // With Exim the host's /etc/aliases does the forwarding, so root mail stays addressed to root@<fqdn> whatever the saved list says.
    app.ctx.settings.set('contacts.root_forward', ['admin@example.net']);
    expect((await get('/api/server-contacts/mail-preferences').expect(200)).body.data.rootDelivery).toEqual({ transport: 'exim', rootAddress: 'root@panel.example.com', to: ['root@panel.example.com'], skipped: [], error: null });
    // A bare panel hostname falls back to Exim's primary_hostname (a local domain) rather than a .localdomain name Exim would route to DNS.
    app.ctx.settings.set('basic.hostname', 'bare-host');
    expect((await get('/api/server-contacts/mail-preferences').expect(200)).body.data.rootAddress).toBe('root@mx.example.org');
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
    const rootViaExim = await app.ctx.contacts.notify({ event: 'backup.failed', subject: 'Nightly backup failed', body: 'disk full', severity: 'error' });
    expect(rootViaExim.deliveries.find((d) => d.contactId === null)).toMatchObject({ address: 'root@panel.example.com', status: 'sent', transport: 'exim' });
    expect(sentViaExim.at(-1)).toMatchObject({ to: ['root@panel.example.com'], subject: '[panel.example.com] Nightly backup failed' });
    expect((await post('/api/server-contacts/mail-preferences/test').expect(200)).body.data).toMatchObject({ status: 'sent', transport: 'exim', address: 'root@panel.example.com' });
    expect(auditRows('contacts.mail.send').at(-1)).toMatchObject({ target: 'root@panel.example.com' });
    await expect(app.ctx.contacts.sendMail({ to: '-bounce@example.com', subject: 'x', body: 'y' })).rejects.toMatchObject({ status: 422 });
    await expect(app.ctx.contacts.sendMail({ to: 'a@example.com', subject: 'x', body: 'y', from: '-f@example.com' })).resolves.toMatchObject({ from: 'whm@panel.example.com' });

    await put('/api/server-contacts/settings', { smtp: { host: '127.0.0.1', port: smtpPort, security: 'none', prefer: true } }).expect(200);
    expect((await get('/api/server-contacts').expect(200)).body.data.capability.mailTransport).toBe('smtp');
    const r2 = await app.ctx.contacts.sendMail({ to: 'b@example.com', subject: 'Relay', body: 'z' });
    expect(r2.transport).toBe('smtp');
    expect(sentViaExim).toHaveLength(4);
    await put('/api/server-contacts/settings', { smtp: { prefer: false } }).expect(200);
    expect((await get('/api/server-contacts').expect(200)).body.data.capability.mailTransport).toBe('exim');
  });

  it('degrades to 501 capability_missing without Exim or a relay', async () => {
    const c = await post('/api/server-contacts/contacts', { name: 'Ops', channel: 'email', address: 'ops@example.com' }).expect(201);
    const res = await post(`/api/server-contacts/contacts/${c.body.data.id}/test`).expect(501);
    expect(res.body.error.code).toBe('capability_missing');
    expect(res.body.error.message).toMatch(/Exim is not installed and no SMTP relay/);
    expect((await post('/api/server-contacts/settings/test-mail', { to: 'a@example.com' }).expect(501)).body.error.code).toBe('capability_missing');
    expect((await post('/api/server-contacts/mail-preferences/test').expect(501)).body.error.code).toBe('capability_missing');
    expect((await get('/api/server-contacts/mail-preferences').expect(200)).body.data.rootDelivery).toMatchObject({ transport: null, to: [], error: expect.stringMatching(/no SMTP relay/) });
    expect(app.ctx.contacts.sendMail).toBeUndefined();
    await expect(app.ctx.contacts.mail({ to: 'a@example.com', subject: 'x', body: 'y' })).rejects.toMatchObject({ status: 501, code: 'capability_missing' });
    expect((await get('/api/server-contacts/deliveries?status=failed').expect(200)).body.data[0]).toMatchObject({ channel: 'email', test: 1 });
    const sms = await post('/api/server-contacts/contacts', { name: 'Pager', channel: 'sms', address: '5551234567@txt.example.net' }).expect(201);
    expect((await post(`/api/server-contacts/contacts/${sms.body.data.id}/test`)).status).toBe(501);
  });

  it('runs the scheduled checks: service down once, restored once, disk low with cooldown', async () => {
    units = ['exim4', 'apache2', 'ssh'];
    unitState = { exim4: 'inactive' };
    await app.ctx.capabilities.refresh();
    await post('/api/server-contacts/contacts', { name: 'Hook', channel: 'webhook', address: `http://127.0.0.1:${hookPort}/check` }).expect(201);

    let res = await runCheck();
    expect(res.body.data.services).toMatchObject({ down: ['exim'], restored: [] });
    expect(res.body.data.services.checked).toBeGreaterThanOrEqual(3);
    expect(res.body.data.disks).toMatchObject({ checked: 1, low: [] });
    expect(res.body.data.notifications).toEqual([{ event: 'service.down', subject: 'Mail Server (Exim) is down on panel.example.com', sent: 1, failed: 0 }]);
    expect(res.body.data.ssl).toEqual({ expiring: [] });
    expect(hook.received[0].body).toMatchObject({ event: 'service.down', severity: 'error' });
    expect(hook.received[0].body.body).toMatch(/unit exim4.*inactive\/dead/);
    expect(app.ctx.db.prepare('SELECT * FROM contact_alert_state').all()).toEqual([expect.objectContaining({ key: 'service:exim', state: 'down' })]);

    res = await runCheck();
    expect(res.body.data.services.down).toEqual(['exim']);
    expect(res.body.data.notifications).toEqual([]);
    expect(hook.received).toHaveLength(1);

    unitState = {};
    disks = [{ filesystem: '/dev/sda1', sizeBytes: 100e9, usedBytes: 95e9, availableBytes: 5e9, usedPercent: 95, mountpoint: '/' }, { filesystem: '/dev/sdb1', sizeBytes: 100e9, usedBytes: 10e9, availableBytes: 90e9, usedPercent: 10, mountpoint: '/home' }];
    res = await runCheck();
    expect(res.body.data.services).toMatchObject({ down: [], restored: ['exim'] });
    expect(res.body.data.disks.low).toEqual([{ mountpoint: '/', usedPercent: 95 }]);
    expect(res.body.data.notifications.map((n) => n.event)).toEqual(['service.restored', 'disk.space.low']);
    expect(hook.received.at(-1).body).toMatchObject({ event: 'disk.space.low', severity: 'warning', subject: '/ is 95% full on panel.example.com' });
    expect(app.ctx.db.prepare('SELECT key FROM contact_alert_state').all()).toEqual([{ key: 'disk:/' }]);

    res = await runCheck();
    expect(res.body.data.notifications).toEqual([]);
    app.ctx.db.prepare("UPDATE contact_alert_state SET last_notified_at = datetime('now', '-7 hours')").run();
    res = await runCheck();
    expect(res.body.data.notifications.map((n) => n.event)).toEqual(['disk.space.low']);
    disks[0].usedPercent = 50;
    await runCheck();
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM contact_alert_state').get().n).toBe(0);
    const cfg = (await get('/api/server-contacts/settings').expect(200)).body.data.check;
    expect(cfg.lastRunAt).toBeTruthy();
    expect(cfg.lastResult).toMatchObject({ disks: { low: [] } });
  });

  it('notifies about installed vhost and service certificates that are about to expire (ISO not_after, cutoff day included)', async () => {
    await post('/api/server-contacts/contacts', { name: 'Hook', channel: 'webhook', address: `http://127.0.0.1:${hookPort}/ssl` }).expect(201);
    const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
    // not_after is stored the way ssl-tls writes it (ISO 8601 with "T"), including one on the cutoff day itself.
    app.ctx.db.prepare('INSERT INTO ssl_certs (domain, installed, not_after) VALUES (?, 1, ?), (?, 1, ?), (?, 1, ?), (?, 0, ?)').run('soon.example.com', iso(5), 'edge.example.com', iso(13.9), 'later.example.com', iso(60), 'old.example.com', iso(1));
    app.ctx.db.prepare("INSERT INTO ssl_service_certs (service, cert_pem, not_after) VALUES ('exim', '-----BEGIN CERTIFICATE-----', ?), ('dovecot', '-----BEGIN CERTIFICATE-----', ?), ('ftp', NULL, ?)").run(iso(2), iso(45), iso(1));
    try {
      const res = await runCheck();
      expect(res.body.data.ssl.expiring.map((c) => [c.domain, c.kind]).sort()).toEqual([['edge.example.com', 'vhost'], ['exim', 'service'], ['soon.example.com', 'vhost']]);
      expect(res.body.data.ssl.expiring.find((c) => c.domain === 'soon.example.com').daysRemaining).toBeGreaterThanOrEqual(4);
      expect(res.body.data.notifications.map((n) => n.event)).toEqual(['ssl.expiring', 'ssl.expiring', 'ssl.expiring']);
      const subjects = hook.received.map((h) => h.body.subject);
      expect(subjects).toEqual(expect.arrayContaining([expect.stringMatching(/soon\.example\.com expires in [45] day/), expect.stringMatching(/exim service certificate expires in [12] day/)]));
      expect(hook.received.find((h) => /exim service/.test(h.body.subject)).body).toMatchObject({ severity: 'error' });
      expect(hook.received.find((h) => /exim service/.test(h.body.subject)).body.body).toMatch(/Manage Service SSL Certificates/);
      expect(app.ctx.db.prepare('SELECT key FROM contact_alert_state ORDER BY key').all().map((r) => r.key)).toEqual(['ssl:edge.example.com', 'ssl:service:exim', 'ssl:soon.example.com']);
      expect((await runCheck()).body.data.notifications).toEqual([]);
      app.ctx.db.prepare("DELETE FROM ssl_service_certs WHERE service = 'exim'").run();
      await runCheck();
      expect(app.ctx.db.prepare('SELECT key FROM contact_alert_state ORDER BY key').all().map((r) => r.key)).toEqual(['ssl:edge.example.com', 'ssl:soon.example.com']);
    } finally {
      app.ctx.db.prepare("DELETE FROM ssl_certs WHERE domain LIKE '%.example.com'").run();
      app.ctx.db.prepare("DELETE FROM ssl_service_certs WHERE service IN ('exim', 'dovecot', 'ftp')").run();
    }
  });

  it('refuses webhooks to loopback, link-local and private addresses unless allowed, at creation and before every post', async () => {
    const c = await post('/api/server-contacts/contacts', { name: 'Local', channel: 'webhook', address: `http://127.0.0.1:${hookPort}/private` }).expect(201);
    await put('/api/server-contacts/settings', { webhook: { allowPrivate: false } }).expect(200);
    expect((await get('/api/server-contacts/settings').expect(200)).body.data.webhook).toEqual({ allowPrivate: false });
    for (const address of [`http://127.0.0.1:${hookPort}/x`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/hook', 'http://[::1]:8080/hook', 'http://localhost/hook', 'http://192.168.1.1/']) {
      const res = await post('/api/server-contacts/contacts', { channel: 'webhook', address }).expect(422);
      expect(res.body.error, address).toMatchObject({ code: 'private_target', fields: { address: [expect.stringMatching(/private address/)] } });
    }
    expect((await patch(`/api/server-contacts/contacts/${c.body.data.id}`, { address: 'http://172.16.0.1/hook' }).expect(422)).body.error.code).toBe('private_target');
    const tested = await post(`/api/server-contacts/contacts/${c.body.data.id}/test`).expect(422);
    expect(tested.body.error.code).toBe('private_target');
    expect(hook.received).toHaveLength(0);
    const r = await app.ctx.contacts.notify({ event: 'backup.failed', subject: 'x', body: 'y' });
    expect(r).toMatchObject({ matched: 1, sent: 0, failed: 1 });
    expect(r.deliveries[0].error).toMatch(/private address/);
    expect(hook.received).toHaveLength(0);
    await put('/api/server-contacts/settings', { webhook: { allowPrivate: true } }).expect(200);
    expect((await post(`/api/server-contacts/contacts/${c.body.data.id}/test`).expect(200)).body.data.status).toBe('sent');
    expect(hook.received).toHaveLength(1);
  });

  it('keeps relay credentials off plain connections unless the admin opts in, and accepts localhost as the relay host', async () => {
    await put('/api/server-contacts/settings', { smtp: { host: 'relay.example.net', port: 25, security: 'none', username: 'relay', password: 'pw' } }).expect(200);
    const refused = await post('/api/server-contacts/settings/test-mail', { to: 'a@example.org' }).expect(422);
    expect(refused.body.error).toMatchObject({ code: 'plaintext_auth_refused', message: expect.stringMatching(/unencrypted/) });
    expect(smtp.sessions).toEqual([]);
    expect((await get('/api/server-contacts/settings').expect(200)).body.data.smtp).toMatchObject({ host: 'relay.example.net', security: 'none', allowPlaintextAuth: false });
    await put('/api/server-contacts/settings', { smtp: { host: 'localhost' } }).expect(200);
    expect((await get('/api/server-contacts/settings').expect(200)).body.data.smtp.host).toBe('localhost');
    await put('/api/server-contacts/settings', { smtp: { host: '127.0.0.1', port: smtpPort, allowPlaintextAuth: true, password: 'secret-pass' } }).expect(200);
    expect((await post('/api/server-contacts/settings/test-mail', { to: 'a@example.org' }).expect(200)).body.data.transport).toBe('smtp');
    expect(smtp.sessions).toHaveLength(1);
  });

  it('runs the scheduled check through the job queue, skips it while disabled, and still runs a manual check', async () => {
    let job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('server-contacts.check').id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ disks: { checked: 1 }, notifications: [] });
    await put('/api/server-contacts/settings', { check: { enabled: false } }).expect(200);
    expect(app.ctx.scheduler.list().find((s) => s.name === 'server-contacts-check').enabled).toBe(0);
    job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('server-contacts.check').id);
    expect(job.result).toEqual({ skipped: 'disabled' });
    expect((await runCheck()).body.data).toMatchObject({ disks: { checked: 1 }, notifications: [] });
    await put('/api/server-contacts/settings', { check: { enabled: true, diskThresholdPercent: 80 } }).expect(200);
    expect(app.ctx.scheduler.list().find((s) => s.name === 'server-contacts-check').enabled).toBe(1);
    expect((await get('/api/server-contacts/settings').expect(200)).body.data.check.diskThresholdPercent).toBe(80);
    await put('/api/server-contacts/settings', { check: { diskThresholdPercent: 90 } }).expect(200);
  });

  it('reads and writes the system mail preferences through /etc/aliases', async () => {
    let res = await get('/api/server-contacts/mail-preferences').expect(200);
    expect(res.body.data).toMatchObject({ hostname: 'panel.example.com', rootAddress: 'root@panel.example.com', forwardTo: ['ops@example.com'], users: { root: ['ops@example.com'], nobody: [] }, managedUsers: ['root', 'nobody'], aliases: { path: '/etc/aliases', exists: true, rebuildTool: 'exim' }, aliasError: null, rootMailEvents: ['service.down', 'disk.space.low', 'backup.failed'] });
    expect(res.body.data.events.map((e) => e.key)).not.toContain('test');

    // Mail for nobody (web server cron and PHP mail) is managed next to root's.
    res = await put('/api/server-contacts/mail-preferences', { users: { nobody: ['root', 'web@example.com'] } }).expect(200);
    expect(aliasWrites).toEqual([['nobody', ['root', 'web@example.com']]]);
    expect(res.body.data.users).toEqual({ root: ['ops@example.com'], nobody: ['root', 'web@example.com'] });
    expect(res.body.data.forwardTo).toEqual(['ops@example.com']);
    expect(app.ctx.settings.get('contacts.nobody_forward')).toEqual(['root', 'web@example.com']);
    expect(auditRows('contacts.mail_preferences').at(-1).target).toBe('nobody');
    aliasWrites = [];

    res = await put('/api/server-contacts/mail-preferences', { forwardTo: ['admin@example.net', 'oncall', 'admin@example.net'], rootMailEvents: ['backup.failed', 'login.failed.blocked'] }).expect(200);
    expect(aliasWrites).toEqual([['admin@example.net', 'oncall']]);
    expect(res.body.data).toMatchObject({ forwardTo: ['admin@example.net', 'oncall'], rootMailEvents: ['backup.failed', 'login.failed.blocked'], rebuild: { tool: 'newaliases', ok: true } });
    expect(app.ctx.settings.get('contacts.root_forward')).toEqual(['admin@example.net', 'oncall']);
    expect(auditRows('contacts.mail_preferences').at(-1).target).toBe('root');

    res = await put('/api/server-contacts/mail-preferences', { forwardTo: [] }).expect(200);
    expect(aliasWrites.at(-1)).toEqual([]);
    expect(res.body.data.forwardTo).toEqual([]);
    expect(res.body.data.rootMailEvents).toEqual(['backup.failed', 'login.failed.blocked']);

    app.ctx.settings.set('contacts.root_forward', ['mirror@example.com']);
    app.agent.fail('contacts.aliases.read', 'path_not_allowed', 'Path "/etc/aliases" is outside the locations the agent may read');
    res = await get('/api/server-contacts/mail-preferences').expect(200);
    expect(res.body.data).toMatchObject({ forwardTo: ['mirror@example.com'], aliases: null, aliasError: { code: 'path_not_allowed' } });
    app.agent.fail('contacts.aliases.set_root', 'command_failed', 'newaliases rejected the alias file');
    expect((await put('/api/server-contacts/mail-preferences', { forwardTo: ['x@example.com'] })).status).toBe(500);
    expect(app.ctx.settings.get('contacts.root_forward')).toEqual(['mirror@example.com']);
    app.agent.reset('contacts.aliases.read');
    app.agent.reset('contacts.aliases.set_root');
  });

  it('rejects invalid input with 422', async () => {
    await post('/api/server-contacts/contacts', {}).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'pager', address: 'x' }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'email', address: 'a b@example.com' }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'email', address: 'a@example.com', events: ['Service.Down'] }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'email', address: 'a@example.com', events: ['a;b'] }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'email', address: 'a@example.com', minSeverity: 'loud' }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'email', address: 'a@example.com', extra: 1 }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'pushover', address: 'u'.repeat(30), config: { token: 'has spaces' } }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'slack', address: 'https://hooks.slack.com/services/T0/B0/XXXXXXXX', config: { channelName: '#ops;rm' } }).expect(422);
    await patch('/api/server-contacts/contacts/1', {}).expect(422);
    await patch('/api/server-contacts/contacts/abc', { enabled: true }).expect(422);
    await post('/api/server-contacts/contacts/0/test').expect(422);
    await put('/api/server-contacts/settings', {}).expect(422);
    await put('/api/server-contacts/settings', { fromAddress: '-bounce@example.com' }).expect(422);
    await put('/api/server-contacts/settings', { smtp: { host: 'relay;rm -rf' } }).expect(422);
    await put('/api/server-contacts/settings', { smtp: { host: '../relay' } }).expect(422);
    await put('/api/server-contacts/settings', { smtp: { port: 70000 } }).expect(422);
    await put('/api/server-contacts/settings', { smtp: { security: 'ssl3' } }).expect(422);
    await put('/api/server-contacts/settings', { check: { diskThresholdPercent: 10 } }).expect(422);
    await put('/api/server-contacts/settings', { check: { cooldownMinutes: 1 } }).expect(422);
    await put('/api/server-contacts/settings', { retentionDays: 0 }).expect(422);
    await post('/api/server-contacts/settings/test-mail', { to: 'not-an-address' }).expect(422);
    await post('/api/server-contacts/settings/test-mail', { to: '-r@example.com' }).expect(422);
    await post('/api/server-contacts/notify', { event: 'nope', subject: 'x' }).expect(422);
    await post('/api/server-contacts/notify', { event: 'account.created' }).expect(422);
    await put('/api/server-contacts/mail-preferences', {}).expect(422);
    await put('/api/server-contacts/mail-preferences', { forwardTo: ['-r'] }).expect(422);
    await put('/api/server-contacts/mail-preferences', { forwardTo: ['a;b@example.com'] }).expect(422);
    await put('/api/server-contacts/mail-preferences', { forwardTo: ['../x'] }).expect(422);
    await put('/api/server-contacts/mail-preferences', { forwardTo: ['"|/bin/sh"'] }).expect(422);
    await put('/api/server-contacts/mail-preferences', { rootMailEvents: ['BAD'] }).expect(422);
    await put('/api/server-contacts/mail-preferences', { users: { 'www-data': ['root'] } }).expect(422);
    await put('/api/server-contacts/mail-preferences', { users: { nobody: ['-r'] } }).expect(422);
    await put('/api/server-contacts/settings', { smtp: { host: 'localhost;id' } }).expect(422);
    await put('/api/server-contacts/settings', { webhook: { allowPrivate: 'yes' } }).expect(422);
    await post('/api/server-contacts/contacts', { channel: 'webhook', address: `http://127.0.0.1:${hookPort}/x`, config: { secret: 'a\nb' } }).expect(422);
    await get('/api/server-contacts/deliveries?status=maybe').expect(422);
    await get('/api/server-contacts/deliveries?event=x;y').expect(422);
    expect(aliasWrites).toEqual([]);
    expect(smtp.sessions).toEqual([]);
  });

  it('is root-only: resellers get 403 everywhere', async () => {
    const rget = (url) => reseller.get(url);
    const rpost = (url, body = {}) => reseller.post(url).set('X-CSRF-Token', resellerCsrf).send(body);
    for (const url of ['/api/server-contacts', '/api/server-contacts/events', '/api/server-contacts/contacts', '/api/server-contacts/contacts/1', '/api/server-contacts/settings', '/api/server-contacts/deliveries', '/api/server-contacts/mail-preferences']) {
      expect((await rget(url)).status, url).toBe(403);
    }
    expect((await rpost('/api/server-contacts/contacts', { channel: 'email', address: 'a@example.com' })).status).toBe(403);
    expect((await rpost('/api/server-contacts/contacts/1/test')).status).toBe(403);
    expect((await rpost('/api/server-contacts/notify', { event: 'account.created', subject: 'x' })).status).toBe(403);
    expect((await rpost('/api/server-contacts/check')).status).toBe(403);
    expect((await rpost('/api/server-contacts/settings/test-mail', { to: 'a@example.com' })).status).toBe(403);
    expect((await rpost('/api/server-contacts/mail-preferences/test')).status).toBe(403);
    expect((await reseller.put('/api/server-contacts/settings').set('X-CSRF-Token', resellerCsrf).send({ enabled: false })).status).toBe(403);
    expect((await reseller.put('/api/server-contacts/mail-preferences').set('X-CSRF-Token', resellerCsrf).send({ forwardTo: [] })).status).toBe(403);
    expect((await reseller.patch('/api/server-contacts/contacts/1').set('X-CSRF-Token', resellerCsrf).send({ enabled: false })).status).toBe(403);
    expect((await reseller.delete('/api/server-contacts/contacts/1').set('X-CSRF-Token', resellerCsrf)).status).toBe(403);
    expect(aliasWrites).toEqual([]);
  });
});
