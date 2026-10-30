import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { sideOf, MESSAGE_MAX_CHARS } from '../src/services/support-chat.js';

const PASSWORD = 'Test-Passw0rd!1';

async function session(app, username) {
  const agent = request.agent(app.ctx.app);
  const res = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return { http: agent, csrf: res.body.data.csrfToken };
}

// Reads SSE frames from a raw socket until `count` data events arrived.
function readEvents(server, cookie, path, count) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`stream ${res.statusCode}`)); }
      let buffer = '';
      const events = [];
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
        if (events.length >= count) { req.destroy(); resolve(events); }
      });
      res.on('error', reject);
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

describe('support chat helpers', () => {
  it('maps roles to sides', () => {
    expect(sideOf({ role: 'root' })).toBe('manager');
    expect(sideOf({ role: 'reseller' })).toBe('manager');
    expect(sideOf({ role: 'user' })).toBe('account');
    expect(MESSAGE_MAX_CHARS).toBe(4000);
  });
});

describe('Account Conversations API', () => {
  let app;
  let root;
  let resell1;
  let resell2;
  let alice;

  beforeAll(async () => {
    app = await createTestApp();
    const csrf = await app.login();
    root = { http: app.http, csrf };
    await app.createUser('resell1', 'reseller');
    await app.createUser('resell2', 'reseller');
    // The hosted-account login is a `user` row named like the account.
    await app.createUser('alice', 'user');
    await app.createUser('mallory', 'user');
    await root.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.example', owner: 'resell1', manager: 'resell1', contactEmail: 'alice@alice.example' }).expect(201);
    await root.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.example', manager: 'resell2' }).expect(201);
    await root.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.example' }).expect(201);
    resell1 = await session(app, 'resell1');
    resell2 = await session(app, 'resell2');
    alice = await session(app, 'alice');
  });
  afterAll(() => app.close());

  it('root lists every account with or without a thread', async () => {
    const res = await root.http.get('/api/support/chat').expect(200);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.meta.viewerSide).toBe('manager');
    const row = res.body.data.find((r) => r.account.username === 'alice');
    expect(row.account).toMatchObject({ domain: 'alice.example', owner: 'resell1', manager: { username: 'resell1', role: 'reseller' } });
    expect(row.conversation).toBeNull();
  });

  it('posting creates the thread, audits without the text and shows up for the account', async () => {
    const res = await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ body: 'Welcome aboard, Alice.\r\nTell us if anything is off.' }).expect(201);
    expect(res.body.data).toMatchObject({ created: true, reopened: false, message: { author: 'root', authorRole: 'root', side: 'manager', body: 'Welcome aboard, Alice.\nTell us if anything is off.' }, conversation: { status: 'open', subject: 'Support for alice.example', messageCount: 1, unread: 0 } });
    const rows = app.ctx.db.prepare("SELECT action, args_redacted FROM audit_log WHERE target = 'alice' AND (action = 'support.chat.post' OR action LIKE 'POST /api/support/chat/%') ORDER BY id").all();
    expect(rows.map((r) => r.action)).toEqual(['support.chat.post', 'POST /api/support/chat/:username/messages']);
    for (const r of rows) expect(r.args_redacted).not.toContain('Welcome aboard');
    const chars = 'Welcome aboard, Alice.\nTell us if anything is off.'.length;
    expect(JSON.parse(rows[0].args_redacted)).toMatchObject({ side: 'manager', chars, created: true });
    expect(JSON.parse(rows[1].args_redacted)).toEqual({ chars });

    const mine = await alice.http.get('/api/support/chat').expect(200);
    expect(mine.body.meta.total).toBe(1);
    expect(mine.body.data[0].account.username).toBe('alice');
    expect(mine.body.data[0].conversation).toMatchObject({ unread: 1, messageCount: 1, lastAuthor: 'root', lastPreview: expect.stringContaining('Welcome aboard') });
    const unread = await alice.http.get('/api/support/chat/unread').expect(200);
    expect(unread.body.data).toEqual({ total: 1, conversations: [{ account: 'alice', domain: 'alice.example', unread: 1 }] });
  });

  it('the account side reads, replies and is confined to its own thread', async () => {
    const thread = await alice.http.get('/api/support/chat/alice').expect(200);
    expect(thread.body.data).toMatchObject({ viewerSide: 'account', canModerate: false, account: { manager: { username: 'resell1' } } });
    expect(thread.body.data.messages).toHaveLength(1);
    const read = await alice.http.post('/api/support/chat/alice/read').set('X-CSRF-Token', alice.csrf).expect(200);
    expect(read.body.data.updated).toBe(1);
    expect((await alice.http.get('/api/support/chat/unread')).body.data.total).toBe(0);
    const reply = await alice.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', alice.csrf).send({ body: 'Thanks! My mail is not arriving.' }).expect(201);
    expect(reply.body.data.message).toMatchObject({ side: 'account', author: 'alice', authorRole: 'user' });
    await alice.http.get('/api/support/chat/bob').expect(404);
    await alice.http.post('/api/support/chat/bob/messages').set('X-CSRF-Token', alice.csrf).send({ body: 'hi' }).expect(404);
    await alice.http.patch('/api/support/chat/alice').set('X-CSRF-Token', alice.csrf).send({ status: 'closed' }).expect(403);
    // A user login without a hosting account sees nothing at all.
    const mallory = await session(app, 'mallory');
    expect((await mallory.http.get('/api/support/chat').expect(200)).body.meta.total).toBe(0);
    await mallory.http.get('/api/support/chat/alice').expect(404);
  });

  it('resellers see owned or managed accounts only, with their own unread figures', async () => {
    const owned = await resell1.http.get('/api/support/chat').expect(200);
    expect(owned.body.data.map((r) => r.account.username)).toEqual(['alice']);
    expect(owned.body.data[0].conversation.unread).toBe(1);
    const managed = await resell2.http.get('/api/support/chat').expect(200);
    expect(managed.body.data.map((r) => r.account.username)).toEqual(['bob']);
    await resell2.http.get('/api/support/chat/alice').expect(404);
    await resell1.http.get('/api/support/chat/bob').expect(404);
    await resell2.http.post('/api/support/chat/bob/messages').set('X-CSRF-Token', resell2.csrf).send({ body: 'Checking in on bob.example.' }).expect(201);
    // Not in scope for the account's owner either when it is not the manager.
    await resell1.http.post('/api/support/chat/bob/messages').set('X-CSRF-Token', resell1.csrf).send({ body: 'nope' }).expect(404);

    const unread = await resell1.http.get('/api/support/chat/unread').expect(200);
    expect(unread.body.data).toEqual({ total: 1, conversations: [{ account: 'alice', domain: 'alice.example', unread: 1 }] });
    expect((await resell1.http.post('/api/support/chat/alice/read').set('X-CSRF-Token', resell1.csrf).expect(200)).body.data.updated).toBe(1);
    // The manager side is one party: once the owner read it, root has nothing unread either.
    expect((await root.http.get('/api/support/chat/unread')).body.data.total).toBe(0);
    const filtered = await root.http.get('/api/support/chat?q=bob').expect(200);
    expect(filtered.body.data.map((r) => r.account.username)).toEqual(['bob']);
  });

  it('closing and reopening is the manager side\'s call; a new message reopens', async () => {
    const closed = await root.http.patch('/api/support/chat/alice').set('X-CSRF-Token', root.csrf).send({ status: 'closed', subject: 'Mail delivery' }).expect(200);
    expect(closed.body.data).toMatchObject({ status: 'closed', subject: 'Mail delivery' });
    const list = await root.http.get('/api/support/chat?status=closed').expect(200);
    expect(list.body.data.map((r) => r.account.username)).toEqual(['alice']);
    const reply = await alice.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', alice.csrf).send({ body: 'Still broken.' }).expect(201);
    expect(reply.body.data).toMatchObject({ reopened: true, conversation: { status: 'open', subject: 'Mail delivery' } });
    await root.http.patch('/api/support/chat/alice').set('X-CSRF-Token', root.csrf).send({}).expect(422);
    await root.http.patch('/api/support/chat/alice').set('X-CSRF-Token', root.csrf).send({ status: 'archived' }).expect(422);
    // Patching an account without a thread creates it closed/open as asked.
    const fresh = await root.http.patch('/api/support/chat/carol').set('X-CSRF-Token', root.csrf).send({ subject: 'Onboarding' }).expect(200);
    expect(fresh.body.data).toMatchObject({ status: 'open', subject: 'Onboarding', messageCount: 0 });
  });

  it('validates the message body', async () => {
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ body: '   ' }).expect(422);
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ body: 'x'.repeat(MESSAGE_MAX_CHARS + 1) }).expect(422);
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ body: 'a\0b' }).expect(422);
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ text: 'hi' }).expect(422);
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ body: 'y'.repeat(MESSAGE_MAX_CHARS) }).expect(201);
    await root.http.get('/api/support/chat/not%20a%20user').expect(422);
  });

  it('failed posts leave no message text in the audit log', async () => {
    const probe = (n) => `SECRET-PROBE-${n} ${'z'.repeat(n)}`;
    const before = app.ctx.db.prepare('SELECT MAX(id) AS id FROM audit_log').get().id;
    await resell1.http.post('/api/support/chat/bob/messages').set('X-CSRF-Token', resell1.csrf).send({ body: probe(10) }).expect(404);
    await alice.http.post('/api/support/chat/bob/messages').set('X-CSRF-Token', alice.csrf).send({ body: probe(20) }).expect(404);
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ body: probe(MESSAGE_MAX_CHARS) }).expect(422);
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ body: `SECRET-PROBE-nul\0x` }).expect(422);
    await root.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', root.csrf).send({ text: 'SECRET-PROBE-shape' }).expect(422);
    await root.http.post('/api/support/chat/not%20a%20user/messages').set('X-CSRF-Token', root.csrf).send({ body: 'SECRET-PROBE-param' }).expect(422);
    const rows = app.ctx.db.prepare('SELECT action, args_redacted, result FROM audit_log WHERE id > ? ORDER BY id').all(before);
    expect(rows.map((r) => r.action)).toEqual(Array(6).fill('POST /api/support/chat/:username/messages'));
    expect(rows.map((r) => r.result)).toEqual(['error:404', 'error:404', 'error:422', 'error:422', 'error:422', 'error:422']);
    for (const r of rows) {
      expect(r.args_redacted).not.toMatch(/SECRET|zzz/);
      expect(Object.keys(JSON.parse(r.args_redacted))).toEqual(['chars']);
    }
    expect(rows.map((r) => JSON.parse(r.args_redacted).chars)).toEqual([probe(10).length, probe(20).length, probe(MESSAGE_MAX_CHARS).length, 18, 0, 18]);
  });

  it('pages a thread backwards with before/limit', async () => {
    const latest = await root.http.get('/api/support/chat/alice?limit=2').expect(200);
    expect(latest.body.data.messages).toHaveLength(2);
    expect(latest.body.data.hasMore).toBe(true);
    const older = await root.http.get(`/api/support/chat/alice?limit=2&before=${latest.body.data.messages[0].id}`).expect(200);
    expect(older.body.data.messages.every((m) => m.id < latest.body.data.messages[0].id)).toBe(true);
    const all = await root.http.get('/api/support/chat/alice').expect(200);
    expect(all.body.data.hasMore).toBe(false);
    expect(all.body.data.messages.map((m) => m.id)).toEqual([...all.body.data.messages.map((m) => m.id)].sort((a, b) => a - b));
  });

  it('streams a snapshot and then new messages over SSE', async () => {
    const server = app.ctx.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const { port } = server.address();
      const login = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
        req.on('error', reject);
        req.end(JSON.stringify({ username: 'root', password: PASSWORD }));
      });
      const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      expect(cookie).toContain('whm.sid=');
      const pending = readEvents(server, cookie, '/api/support/chat/alice/stream', 2);
      // Give the stream a moment to subscribe before the message is posted.
      await new Promise((r) => setTimeout(r, 100));
      await alice.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', alice.csrf).send({ body: 'Live message' }).expect(201);
      const events = await pending;
      expect(events[0]).toMatchObject({ type: 'snapshot', account: { username: 'alice' }, viewerSide: 'manager' });
      expect(events[0].messages.length).toBeGreaterThan(0);
      expect(events[1]).toMatchObject({ type: 'message', message: { body: 'Live message', side: 'account', author: 'alice' }, conversation: { status: 'open' } });
      // Out of scope: the stream is refused before any header is flushed.
      await expect(readEvents(server, cookie, '/api/support/chat/nobody/stream', 1)).rejects.toThrow('stream 404');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('emits a panel event without the message text and drops the thread with the account', async () => {
    const seen = [];
    const off = app.ctx.events.on('support.chat.message', (e) => { seen.push(e); });
    await root.http.post('/api/support/chat/carol/messages').set('X-CSRF-Token', root.csrf).send({ body: 'Secret body text' }).expect(201);
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({ account: 'carol', side: 'manager', author: 'root', chars: 16 });
    expect(JSON.stringify(seen[0])).not.toContain('Secret body');
    const convId = app.ctx.db.prepare("SELECT c.id FROM support_conversations c JOIN accounts a ON a.id = c.account_id WHERE a.username = 'carol'").get().id;
    await root.http.delete('/api/accounts/carol').set('X-CSRF-Token', root.csrf).expect(200);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ?').get(convId).n).toBe(0);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM support_conversations WHERE id = ?').get(convId).n).toBe(0);
  });
});
