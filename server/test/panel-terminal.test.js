import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import request from 'supertest';
import WebSocket from 'ws';
import { createTestApp, createMockAgent } from './support/app.js';
import { encodeFrames, resizeFrame, unsignSessionCookie, parseCookies, sameOrigin, clampSize, FRAME_DATA, FRAME_RESIZE, WS_PATH, CLOSE_CODES, CAPS } from '../src/services/panel-terminal.js';
import { PANEL_API_ALLOW, panelApiAllowed } from '../src/middleware/shell.js';
import { DEFAULT_FEATURES } from '../src/db/seed.js';

// The bridge is replaced by a local socket server that speaks its framing and
// echoes what it gets, so the whole path (POST → token → upgrade → relay) runs
// through a real listener with a real WebSocket client.
const socketPathFor = (id) => (process.platform === 'win32' ? `\\\\.\\pipe\\whm-term-test-${id}` : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whm-term-')), `${id.slice(0, 8)}.sock`));

function bridgeAgent() {
  const state = { bridges: new Map(), next: 1 };
  const ops = {
    'term.open': ({ username, cols, rows }) => new Promise((resolve) => {
      const id = crypto.randomBytes(16).toString('hex');
      state.next += 1;
      const socket = socketPathFor(id);
      const server = net.createServer((conn) => {
        let buf = Buffer.alloc(0);
        conn.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 3) {
            const type = buf[0];
            const len = buf.readUInt16BE(1);
            if (buf.length < 3 + len) break;
            const payload = buf.subarray(3, 3 + len);
            buf = buf.subarray(3 + len);
            if (type === FRAME_DATA) conn.write(Buffer.concat([Buffer.from('echo:'), payload]));
            else if (type === FRAME_RESIZE) conn.write(`resize:${payload.readUInt16BE(0)}x${payload.readUInt16BE(2)}`);
          }
        });
      });
      server.listen(socket, () => {
        state.bridges.set(id, { id, username, socket, server, cols, rows });
        resolve({ id, socket, pid: 5000 + state.next, startedAt: new Date().toISOString(), cols, rows });
      });
    }),
    'term.list': ({ username }) => [...state.bridges.values()].filter((b) => b.username === username).map((b) => ({ id: b.id, username, socket: b.socket, pid: 1, cols: b.cols, rows: b.rows })),
    'term.close': ({ id }) => { const b = state.bridges.get(id); if (!b) return { id, existed: false }; b.server.close(); state.bridges.delete(id); return { id, existed: true, pid: 1 }; },
    'term.resize': ({ id, cols, rows }) => ({ id, cols, rows }),
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  agent.ops = ops;
  return agent;
}

describe('panel-terminal helpers', () => {
  it('frames input at 8 KiB, encodes a resize and clamps sizes', () => {
    const one = encodeFrames(FRAME_DATA, 'id\r');
    expect(one).toHaveLength(1);
    expect([...one[0].subarray(0, 3)]).toEqual([0, 0, 3]);
    expect(one[0].subarray(3).toString()).toBe('id\r');
    const big = encodeFrames(FRAME_DATA, Buffer.alloc(8192 * 2 + 10, 1));
    expect(big.map((f) => f.readUInt16BE(1))).toEqual([8192, 8192, 10]);
    expect(encodeFrames(FRAME_DATA, '')).toEqual([]);
    const rs = resizeFrame(120, 32);
    expect([...rs]).toEqual([1, 0, 4, 0, 120, 0, 32]);
    expect(clampSize('80', [20, 500], 120)).toBe(80);
    expect(clampSize(1, [20, 500], 120)).toBe(20);
    expect(clampSize(9999, [5, 200], 32)).toBe(200);
    expect(clampSize('x', [5, 200], 32)).toBe(32);
    expect(clampSize(1.5, [5, 200], 32)).toBe(32);
  });

  it('unsigns only a cookie signed with one of the secrets', () => {
    const sign = (sid, secret) => `s:${sid}.${crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')}`;
    expect(unsignSessionCookie(sign('abc', 'k1'), 'k1')).toBe('abc');
    expect(unsignSessionCookie(sign('abc', 'k2'), ['k1', 'k2'])).toBe('abc');
    expect(unsignSessionCookie(sign('abc', 'k3'), ['k1', 'k2'])).toBeNull();
    expect(unsignSessionCookie('abc', 'k1')).toBeNull();
    expect(unsignSessionCookie('s:abc', 'k1')).toBeNull();
    expect(unsignSessionCookie(undefined, 'k1')).toBeNull();
    expect(parseCookies('a=1; whm.sid=s%3Ax.y; b="q"')).toEqual({ a: '1', 'whm.sid': 's:x.y', b: 'q' });
    expect(sameOrigin('https://panel.example:2083', 'panel.example:2083')).toBe(true);
    expect(sameOrigin('https://PANEL.example:2083', 'panel.example:2083')).toBe(true);
    expect(sameOrigin('https://evil.example', 'panel.example:2083')).toBe(false);
    expect(sameOrigin(undefined, 'panel.example')).toBe(false);
    expect(sameOrigin('nonsense', 'panel.example')).toBe(false);
    expect(WS_PATH).toBe('/api/panel/terminal/ws');
    expect(PANEL_API_ALLOW).toContain('/api/panel/terminal');
    expect(panelApiAllowed(WS_PATH)).toBe(true);
    expect(DEFAULT_FEATURES.terminal).toBe(true);
  });
});

describe('/api/panel/terminal', () => {
  let app;
  let server;
  let origin;
  let alice;
  let aliceCsrf;
  let aliceCookie;
  let bobCookie;
  let bob;
  let bobCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const audits = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);
  const post = (body = {}) => alice.post('/api/panel/terminal/sessions').set('X-CSRF-Token', aliceCsrf).send(body);
  const setPlan = (username, key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.${key}', json(?)) WHERE username = ?`).run(JSON.stringify(value), username);
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);

  async function loginAs(username, password) {
    await rootPost(`/api/panel/admin/accounts/${username}/password`, { password }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username, password });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    return { http, csrf: res.body.data.csrfToken, cookie };
  }

  const connect = (token, { cookie = aliceCookie, headers = {} } = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}${WS_PATH}${token != null ? `?token=${token}` : ''}`, { headers: { Cookie: cookie, Origin: origin, ...headers } });
    const messages = [];
    ws.on('message', (d, isBinary) => messages.push(isBinary ? d.toString() : JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, messages, status: 101 }));
    ws.on('unexpected-response', (_req, res) => { resolve({ ws: null, status: res.statusCode }); });
    ws.on('error', () => {});
  });
  const waitFor = (messages, pred, ms = 3000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const m = messages.find(pred); if (m) return resolve(m); if (Date.now() - t0 > ms) return reject(new Error(`no message matching after ${ms}ms: ${JSON.stringify(messages)}`)); setTimeout(tick, 20); };
    tick();
  });
  const closed = (ws) => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) return resolve(ws.closeCode); ws.on('close', (code) => resolve(code)); });

  beforeAll(async () => {
    app = await createTestApp({ agent: bridgeAgent() });
    rootCsrf = await app.login();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    ({ http: alice, csrf: aliceCsrf, cookie: aliceCookie } = await loginAs('alice', 'Alice-Passw0rd!'));
    ({ http: bob, csrf: bobCsrf, cookie: bobCookie } = await loginAs('bob', 'Bob-Passw0rd!!'));
    setPlan('bob', 'has_shell', true);
    server = http.createServer(app.ctx.app);
    app.ctx.panelTerminal.attachUpgrade(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await app.close();
  });
  beforeEach(() => { app.agent.calls.length = 0; });

  it('answers 501 shell_disabled while the plan has no shell, and never calls the agent', async () => {
    const res = await post();
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('shell_disabled');
    expect((await alice.get('/api/panel/terminal/sessions')).status).toBe(501);
    expect(calls('term.open')).toHaveLength(0);
  });

  it('answers 403 feature_disabled when the plan feature is off', async () => {
    setPlan('alice', 'has_shell', true);
    setPlan('alice', 'features.terminal', false);
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('feature_disabled');
    setPlan('alice', 'features.terminal', true);
  });

  it('refuses an API token and a bad body', async () => {
    const tok = await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'script', scopes: ['panel:read'] });
    expect(tok.status).toBe(201);
    const viaToken = await request(app.ctx.app).post('/api/panel/terminal/sessions').set('Authorization', `Bearer ${tok.body.data.token}`).send({});
    expect(viaToken.status).toBe(403);
    expect(['session_required', 'forbidden']).toContain(viaToken.body.error.code);
    expect((await request(app.ctx.app).get('/api/panel/terminal/sessions').set('Authorization', `Bearer ${tok.body.data.token}`)).status).toBe(403);
    for (const body of [{ cols: 1 }, { rows: 'x' }, { shell: '/bin/sh' }]) expect((await post(body)).status, JSON.stringify(body)).toBe(422);
    expect(calls('term.open')).toHaveLength(0);
  });

  it('opens a terminal as the account, relays bytes over the WebSocket, resizes and audits open/close', async () => {
    const res = await post({ cols: 100, rows: 30 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ cols: 100, rows: 30, expiresInSeconds: 30 });
    expect(res.body.data.id).toMatch(/^[a-f0-9]{32}$/);
    expect(res.body.data.wsToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(calls('term.open')[0].args).toEqual({ username: 'alice', cols: 100, rows: 30 });
    const open = audits('panel.terminal.open');
    expect(open[0]).toMatchObject({ principal: 'alice', target: 'alice' });
    expect(JSON.parse(open[0].args_redacted)).toEqual({ id: res.body.data.id, cols: 100, rows: 30 });
    expect(JSON.stringify(open[0])).not.toContain(res.body.data.wsToken);

    const list = await alice.get('/api/panel/terminal/sessions').expect(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: res.body.data.id, connected: false, cols: 100, rows: 30 })]);
    expect((await bob.get('/api/panel/terminal/sessions')).body.data).toEqual([]);

    const { ws, messages, status } = await connect(res.body.data.wsToken);
    expect(status).toBe(101);
    await waitFor(messages, (m) => m?.type === 'ready');
    ws.send(Buffer.from('id\r'));
    await waitFor(messages, (m) => m === 'echo:id\r');
    ws.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
    await waitFor(messages, (m) => m === 'echo:pwd\r');
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await waitFor(messages, (m) => m === 'resize:80x24');
    ws.send(JSON.stringify({ type: 'resize', cols: 99999, rows: 1 }));
    await waitFor(messages, (m) => m === 'resize:500x5');
    expect((await alice.get('/api/panel/terminal/sessions')).body.data[0]).toMatchObject({ connected: true, cols: 500, rows: 5 });

    // One socket per terminal session, and the token was burnt on the first upgrade.
    expect((await connect(res.body.data.wsToken)).status).toBe(403);

    const del = await alice.delete(`/api/panel/terminal/sessions/${res.body.data.id}`).set('X-CSRF-Token', aliceCsrf);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ id: res.body.data.id, closed: true });
    expect(await closed(ws)).toBe(CLOSE_CODES.ended);
    expect(calls('term.close')[0].args).toEqual({ id: res.body.data.id });
    const close = audits('panel.terminal.close');
    expect(close[0]).toMatchObject({ principal: 'alice', target: 'alice' });
    expect(JSON.parse(close[0].args_redacted)).toEqual({ id: res.body.data.id, reason: 'closed' });
    expect((await alice.get('/api/panel/terminal/sessions')).body.data).toEqual([]);
    expect((await alice.delete(`/api/panel/terminal/sessions/${res.body.data.id}`).set('X-CSRF-Token', aliceCsrf)).status).toBe(404);
  });

  it('refuses the upgrade without the cookie, from another origin, with another user\'s cookie, a stale token or a wrong path', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const { id, wsToken } = res.body.data;
    expect((await connect(wsToken, { cookie: '' })).status).toBe(401);
    expect((await connect(wsToken, { cookie: 'whm.sid=s:forged.AAAA' })).status).toBe(401);
    expect((await connect(wsToken, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await connect('nope')).status).toBe(403);
    expect((await connect(null)).status).toBe(403);
    // None of those reached the token, which still opens the terminal once.
    expect((await connect(wsToken)).status).toBe(101);
    // Another user's cookie burns the token it presents: neither Bob nor Alice can use it afterwards.
    const second = await post();
    expect(second.status).toBe(201);
    expect((await connect(second.body.data.wsToken, { cookie: bobCookie })).status).toBe(403);
    expect((await connect(second.body.data.wsToken)).status).toBe(403);
    await alice.delete(`/api/panel/terminal/sessions/${second.body.data.id}`).set('X-CSRF-Token', aliceCsrf).expect(200);
    // Bob cannot close Alice's terminal; the id simply does not exist for him.
    expect((await bob.delete(`/api/panel/terminal/sessions/${id}`).set('X-CSRF-Token', bobCsrf)).status).toBe(404);
    await alice.delete(`/api/panel/terminal/sessions/${id}`).set('X-CSRF-Token', aliceCsrf).expect(200);
    const wrongPath = await new Promise((resolve) => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/panel/terminal/other?token=${wsToken}`, { headers: { Cookie: aliceCookie, Origin: origin } });
      ws.on('unexpected-response', (_req, r) => resolve(r.statusCode));
      ws.on('error', () => {});
    });
    expect(wrongPath).toBe(404);
  });

  it('a token expires after 30 seconds and the terminal closes when the panel session is gone', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const t = [...app.ctx.panelTerminal.tokens.values()].pop();
    t.expiresAt = Date.now() - 1;
    expect((await connect(res.body.data.wsToken)).status).toBe(403);
    await alice.delete(`/api/panel/terminal/sessions/${res.body.data.id}`).set('X-CSRF-Token', aliceCsrf).expect(200);

    const fresh = await loginAs('alice', 'Alice-Passw0rd!');
    const opened = await fresh.http.post('/api/panel/terminal/sessions').set('X-CSRF-Token', fresh.csrf).send({});
    expect(opened.status).toBe(201);
    const { ws, status } = await connect(opened.body.data.wsToken, { cookie: fresh.cookie });
    expect(status).toBe(101);
    const s = app.ctx.panelTerminal.sessions.get(opened.body.data.id);
    expect(s.sid).toBeTruthy();
    await fresh.http.post('/api/auth/logout').set('X-CSRF-Token', fresh.csrf).expect(200);
    const valid = await new Promise((resolve) => app.ctx.sessionStore.get(s.sid, (_e, sess) => resolve(Boolean(sess))));
    expect(valid).toBe(false);
    const ended = closed(ws);
    const before = audits('panel.terminal.close').length;
    // The periodic session check, run once as the timer would.
    expect(await app.ctx.panelTerminal.checkSessions()).toContain(true);
    expect(await ended).toBe(CLOSE_CODES.loggedOut);
    expect(audits('panel.terminal.close').length).toBe(before + 1);
    expect(JSON.parse(audits('panel.terminal.close')[0].args_redacted)).toEqual({ id: opened.body.data.id, reason: 'logged_out' });
    expect(calls('term.close').map((c) => c.args.id)).toContain(opened.body.data.id);
    expect(app.ctx.panelTerminal.sessions.has(opened.body.data.id)).toBe(false);
  });

  it('maps an agent that cannot start the bridge', async () => {
    const before = audits('panel.terminal.open').length;
    app.agent.fail('term.open', 'capability_missing', 'python3 is required for the in-browser terminal');
    const res = await post();
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('capability_missing');
    app.agent.fail('term.open', 'shell_disabled', 'alice has no shell access (/usr/sbin/nologin)');
    const nologin = await post();
    expect(nologin.status).toBe(501);
    expect(nologin.body.error.code).toBe('shell_disabled');
    expect(audits('panel.terminal.open').length).toBe(before);
    app.agent.set('term.open', app.agent.ops['term.open']);
  });

  const closedWith = (ws) => new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));

  it('enforces the idle cap itself: a quiet relay is closed with reason idle and the agent told', async () => {
    const was = { ...CAPS };
    CAPS.idleMs = 150;
    try {
      const res = await post();
      expect(res.status).toBe(201);
      const { ws, messages } = await connect(res.body.data.wsToken);
      await waitFor(messages, (m) => m?.type === 'ready');
      const done = closedWith(ws);
      // Traffic in either direction re-arms the timer.
      for (let i = 0; i < 3; i += 1) { await new Promise((r) => setTimeout(r, 80)); ws.send(Buffer.from('x')); }
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(await done).toEqual({ code: CLOSE_CODES.ended, reason: 'idle' });
      expect(calls('term.close').map((c) => c.args.id)).toContain(res.body.data.id);
      expect(JSON.parse(audits('panel.terminal.close')[0].args_redacted)).toEqual({ id: res.body.data.id, reason: 'idle' });
      expect(app.ctx.panelTerminal.sessions.has(res.body.data.id)).toBe(false);
    } finally { Object.assign(CAPS, was); }
  });

  it('enforces the hard cap itself from the agent\'s startedAt, whatever the bridge does', async () => {
    const was = { ...CAPS };
    CAPS.maxMs = 200;
    try {
      const res = await post();
      expect(res.status).toBe(201);
      const { ws, messages } = await connect(res.body.data.wsToken);
      await waitFor(messages, (m) => m?.type === 'ready');
      const keepAlive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from('x')); }, 30);
      const end = await closedWith(ws);
      clearInterval(keepAlive);
      expect(end).toEqual({ code: CLOSE_CODES.ended, reason: 'max' });
      expect(calls('term.close').map((c) => c.args.id)).toContain(res.body.data.id);
      expect(JSON.parse(audits('panel.terminal.close')[0].args_redacted)).toEqual({ id: res.body.data.id, reason: 'max' });
    } finally { Object.assign(CAPS, was); }
  });

  it.skipIf(process.platform === 'win32')('never connects to a path that is not a unix socket', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const s = app.ctx.panelTerminal.sessions.get(res.body.data.id);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whm-term-')), 'pty.sock');
    fs.writeFileSync(file, '');
    s.socket = file;
    const { ws, status } = await connect(res.body.data.wsToken);
    expect(status).toBe(101);
    expect(await closed(ws)).toBe(CLOSE_CODES.ended);
    expect(calls('term.close').map((c) => c.args.id)).toContain(res.body.data.id);
    expect(app.ctx.panelTerminal.sessions.has(res.body.data.id)).toBe(false);
  });

  it('terminating the account ends its terminals before the Linux user goes', async () => {
    const opened = await bob.post('/api/panel/terminal/sessions').set('X-CSRF-Token', bobCsrf).send({});
    expect(opened.status).toBe(201);
    const { ws, messages } = await connect(opened.body.data.wsToken, { cookie: bobCookie });
    await waitFor(messages, (m) => m?.type === 'ready');
    const done = closedWith(ws);
    app.agent.calls.length = 0;
    await app.http.delete('/api/accounts/bob').set('X-CSRF-Token', rootCsrf).expect(200);
    expect(await done).toEqual({ code: CLOSE_CODES.ended, reason: 'account_removed' });
    expect(calls('term.close').map((c) => c.args.id)).toEqual([opened.body.data.id]);
    expect(app.ctx.panelTerminal.sessions.has(opened.body.data.id)).toBe(false);
    expect(JSON.parse(audits('panel.terminal.close')[0].args_redacted)).toEqual({ id: opened.body.data.id, reason: 'account_removed' });
    const terminate = db().prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.terminate' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(terminate.args_redacted).cleanup.terminal).toEqual({ ended: 1 });
  });
});
