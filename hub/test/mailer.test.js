import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { bootHub } from './support.js';
import { buildMessage, envelopeAddress, createMailer, sendmailTransport, sendmailUnavailableReason, smtpTransport } from '../shared/mailer.js';
import { loadConfig } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-mailer-'));
const ORIGINAL_PATH = process.env.PATH;
after(() => { process.env.PATH = ORIGINAL_PATH; fs.rmSync(tmp, { recursive: true, force: true }); });

// A self-signed cert for the STARTTLS cases; skipped when openssl is absent.
let certPem = null;
let keyPem = null;
before(() => {
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', path.join(tmp, 'smtp.key'), '-out', path.join(tmp, 'smtp.crt')], { stdio: 'ignore' });
    certPem = fs.readFileSync(path.join(tmp, 'smtp.crt'));
    keyPem = fs.readFileSync(path.join(tmp, 'smtp.key'));
  } catch { certPem = null; }
});

// Minimal ESMTP server: EHLO capabilities, optional STARTTLS (wraps the same
// socket) and AUTH PLAIN/LOGIN, one message per DATA. Every accepted message is
// recorded with its envelope and whether it arrived over TLS / authenticated.
function fakeSmtp({ auth = null, starttls = false, implicit = false, bitmime = true, greetingCode = 220 } = {}) {
  const messages = [];
  const commands = [];
  function session(sock, { secure, greet = !secure }) {
    let buf = '';
    let data = null;
    let loginStep = null;
    const env = { from: null, to: [], secure, authed: false };
    const write = (s) => sock.write(`${s}\r\n`);
    const onLine = (line) => {
      if (data !== null) {
        if (line === '.') { messages.push({ ...env, data: data.join('\r\n') }); data = null; env.from = null; env.to = []; return write('250 queued'); }
        return data.push(line.startsWith('..') ? line.slice(1) : line);
      }
      commands.push(line.split(' ')[0]);
      if (loginStep === 'user') { loginStep = 'pass'; env.user = Buffer.from(line, 'base64').toString(); return write('334 UGFzc3dvcmQ6'); }
      if (loginStep === 'pass') { loginStep = null; const ok = auth && env.user === auth.user && Buffer.from(line, 'base64').toString() === auth.pass; env.authed = ok; return write(ok ? '235 ok' : '535 bad credentials'); }
      const [verb, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': {
          const caps = ['250-fake.test'];
          if (bitmime) caps.push('250-8BITMIME');
          if (auth) caps.push(`250-AUTH ${auth.mechanisms || 'PLAIN LOGIN'}`);
          if (starttls && !secure) caps.push('250-STARTTLS');
          caps.push('250 OK');
          return write(caps.join('\r\n'));
        }
        case 'STARTTLS': {
          if (!starttls || secure) return write('454 TLS not available');
          write('220 go ahead');
          sock.removeAllListeners('data');
          const t = new tls.TLSSocket(sock, { isServer: true, key: keyPem, cert: certPem });
          return session(t, { secure: true });
        }
        case 'AUTH': {
          if (!auth) return write('503 no auth');
          if (arg.toUpperCase().startsWith('PLAIN ')) {
            const [, user, pass] = Buffer.from(arg.slice(6), 'base64').toString().split('\0');
            env.authed = user === auth.user && pass === auth.pass;
            return write(env.authed ? '235 ok' : '535 bad credentials');
          }
          if (arg.toUpperCase() === 'LOGIN') { loginStep = 'user'; return write('334 VXNlcm5hbWU6'); }
          return write('504 unknown mechanism');
        }
        case 'MAIL': { if (auth && !env.authed) return write('530 authentication required'); env.from = arg; return write('250 sender ok'); }
        case 'RCPT': { env.to.push(arg); return write(arg.includes('reject@') ? '550 no such user' : '250 recipient ok'); }
        case 'DATA': { data = []; return write('354 go'); }
        case 'QUIT': { write('221 bye'); return sock.end(); }
        default: return write('500 unknown command');
      }
    };
    const decoder = new StringDecoder('utf8');
    sock.on('data', (chunk) => { buf += decoder.write(chunk); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); onLine(line); } });
    sock.on('error', () => {});
    if (greet) write(`${greetingCode} fake.test ESMTP`);
  }
  const server = implicit
    ? tls.createServer({ key: keyPem, cert: certPem }, (sock) => session(sock, { secure: true, greet: true }))
    : net.createServer((sock) => session(sock, { secure: false }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, messages, commands, close: () => new Promise((r) => server.close(r)) })));
}

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) { if (Date.now() > until) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}

const sample = () => buildMessage({ from: 'WHM Hub <whm-hub@hub.test>', to: 'c@example.test', subject: 'Clé de licence', text: 'line one\n.starts with a dot\n…unicode\n' });

test('buildMessage: RFC 5322 headers, encoded subject, header injection stripped', () => {
  const msg = buildMessage({ from: 'a@hub.test', to: 'b@example.test\r\nBcc: evil@example.test', subject: 'Hi\r\nX-Injected: 1', text: 'body\n' });
  const head = msg.split('\r\n\r\n')[0].split('\r\n');
  assert.ok(head.includes('To: b@example.test Bcc: evil@example.test'), 'CRLF in a header value is folded away');
  assert.ok(head.includes('Subject: Hi X-Injected: 1'));
  assert.ok(head.some((h) => /^Date: .* GMT$/.test(h)));
  assert.ok(head.some((h) => /^Message-ID: <[0-9a-f-]{36}@hub\.test>$/.test(h)));
  assert.ok(head.includes('Content-Transfer-Encoding: 8bit'));
  assert.match(sample(), /^Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
});

test('envelopeAddress: addr-spec extraction and rejection of command-breaking input', () => {
  assert.equal(envelopeAddress('WHM Hub <whm-hub@hub.test>'), 'whm-hub@hub.test');
  assert.equal(envelopeAddress(' c@example.test '), 'c@example.test');
  for (const bad of ['', null, 'nobody', 'a b@x.test', 'a@x.test>\r\nRCPT TO:<z@y', '<a@x.test> <b@y.test>', 'a@x.test,b@y.test']) assert.equal(envelopeAddress(bad), null, JSON.stringify(bad));
});

test('smtp transport: EHLO, 8BITMIME envelope, dot-stuffing, CRLF, QUIT', async () => {
  const srv = await fakeSmtp();
  try {
    const mailer = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port: srv.port, timeoutMs: 5000 }), from: 'WHM Hub <whm-hub@hub.test>' });
    const r = await mailer.send({ to: 'c@example.test', template: 'portal.password_reset', data: { link: 'https://hub.test/reset?t=1' } });
    assert.deepEqual(r, { ok: true });
    assert.equal(srv.messages.length, 1);
    const m = srv.messages[0];
    assert.equal(m.from, 'FROM:<whm-hub@hub.test> BODY=8BITMIME');
    assert.deepEqual(m.to, ['TO:<c@example.test>']);
    assert.match(m.data, /^From: WHM Hub <whm-hub@hub.test>\r\nTo: c@example.test\r\n/);
    assert.match(m.data, /\r\n\r\nUse this link within 15 minutes to reset your password: https:\/\/hub\.test\/reset\?t=1$/);
    assert.deepEqual(srv.commands, ['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    const s = mailer.status();
    assert.equal(s.ok, true); assert.equal(s.sent, 1); assert.equal(s.failed, 0); assert.equal(s.transport, 'smtp'); assert.equal(s.target, `127.0.0.1:${srv.port}`);

    // Direct transport.send (the marketplace path) takes the envelope from the headers and dot-stuffs the body.
    await mailer.transport.send(sample(), { to: 'c@example.test' });
    const m2 = srv.messages[1];
    assert.equal(m2.from, 'FROM:<whm-hub@hub.test> BODY=8BITMIME');
    assert.ok(m2.data.includes('\r\n.starts with a dot\r\n'), 'the server unstuffed the leading dot');
    assert.ok(m2.data.includes('…unicode'), '8-bit body passes through');
  } finally { await srv.close(); }
});

test('smtp transport: AUTH PLAIN and LOGIN on loopback, bad credentials surface', async () => {
  const plain = await fakeSmtp({ auth: { user: 'hub', pass: 's3cret' } });
  const login = await fakeSmtp({ auth: { user: 'hub', pass: 's3cret', mechanisms: 'LOGIN' } });
  try {
    const ok = createMailer({ transport: smtpTransport({ host: 'localhost', port: plain.port, user: 'hub', pass: 's3cret', timeoutMs: 5000 }), from: 'a@hub.test' });
    assert.deepEqual(await ok.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'login' } }), { ok: true });
    assert.equal(plain.messages[0].authed, true);
    const viaLogin = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port: login.port, user: 'hub', pass: 's3cret', timeoutMs: 5000 }), from: 'a@hub.test' });
    assert.deepEqual(await viaLogin.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'login' } }), { ok: true });
    assert.equal(login.messages[0].authed, true);
    assert.ok(login.commands.includes('AUTH'));
    const bad = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port: plain.port, user: 'hub', pass: 'wrong', timeoutMs: 5000 }), from: 'a@hub.test' });
    const r = await bad.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'login' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /AUTH rejected .*535/);
    assert.ok(!r.error.includes('wrong'), 'the password never appears in the error');
    assert.equal(bad.status().ok, false);
    assert.match(bad.status().error, /535/);
    await assert.rejects(bad.verify(), /535/);
  } finally { await plain.close(); await login.close(); }
});

test('smtp transport: STARTTLS auto/require/off and implicit TLS', { skip: !certPem && 'openssl is not available' }, async () => {
  const srv = await fakeSmtp({ starttls: true });
  const bare = await fakeSmtp({ starttls: false });
  try {
    const opts = { host: '127.0.0.1', port: srv.port, ca: certPem, timeoutMs: 5000 };
    const auto = createMailer({ transport: smtpTransport(opts), from: 'a@hub.test' });
    assert.deepEqual(await auto.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } }), { ok: true });
    assert.equal(srv.messages[0].secure, true, 'auto upgrades when STARTTLS is offered');
    const off = createMailer({ transport: smtpTransport({ ...opts, starttls: 'off' }), from: 'a@hub.test' });
    assert.deepEqual(await off.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } }), { ok: true });
    assert.equal(srv.messages[1].secure, false);
    const required = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port: bare.port, starttls: 'require', timeoutMs: 5000 }), from: 'a@hub.test' });
    const r = await required.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /does not offer STARTTLS/);
    assert.equal(bare.messages.length, 0);
    // A loopback MTA's self-signed certificate is accepted by default (the hop never
    // leaves the host); verification stays a hard failure when the operator asks for it.
    const loopbackDefault = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port: srv.port, timeoutMs: 5000 }), from: 'a@hub.test' });
    assert.deepEqual(await loopbackDefault.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } }), { ok: true });
    assert.equal(srv.messages[srv.messages.length - 1].secure, true, 'still upgraded with STARTTLS, just not verified');
    const untrusted = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port: srv.port, reject_unauthorized: true, timeoutMs: 5000 }), from: 'a@hub.test' });
    const u = await untrusted.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } });
    assert.equal(u.ok, false);
    assert.match(u.error, /STARTTLS with 127\.0\.0\.1:\d+ failed/, 'an untrusted certificate is a delivery failure, not a silent downgrade');
    const smtps = await fakeSmtp({ implicit: true, auth: { user: 'hub', pass: 'pw' } });
    try {
      const viaTls = createMailer({ transport: smtpTransport({ host: 'localhost', port: smtps.port, secure: true, user: 'hub', pass: 'pw', ca: certPem, timeoutMs: 5000 }), from: 'a@hub.test' });
      assert.deepEqual(await viaTls.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } }), { ok: true });
      assert.equal(smtps.messages[0].secure, true);
      assert.equal(smtps.messages[0].authed, true);
      assert.ok(!smtps.commands.includes('STARTTLS'), 'implicit TLS never issues STARTTLS');
    } finally { await smtps.close(); }
  } finally { await srv.close(); await bare.close(); }
});

const hasSetpriv = (() => { try { execFileSync('setpriv', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('sendmailUnavailableReason reads the real /proc/self/status under no_new_privs', { skip: !hasSetpriv && 'setpriv (util-linux) is not available' }, () => {
  const script = 'import("../shared/mailer.js").then((m) => process.stdout.write(String(m.sendmailUnavailableReason())))';
  const run = (args) => execFileSync('setpriv', [...args, process.execPath, '--input-type=module', '-e', script], { cwd: HERE, encoding: 'utf8' });
  assert.equal(run([]), 'null');
  assert.match(run(['--no-new-privs']), /no_new_privs .*license\.mail\.transport to "smtp"/);
});

test('smtp transport: a dead MTA fails fast with the reason and nothing hangs', async () => {
  const probe = await fakeSmtp();
  const { port } = probe;
  await probe.close();
  const mailer = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port, timeoutMs: 3000 }), from: 'a@hub.test' });
  const r = await mailer.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot connect to 127\.0\.0\.1:\d+|connecting to 127\.0\.0\.1:\d+ failed: ECONNREFUSED/);
  const rejected = await fakeSmtp();
  try {
    const m2 = createMailer({ transport: smtpTransport({ host: '127.0.0.1', port: rejected.port, timeoutMs: 3000 }), from: 'a@hub.test' });
    const r2 = await m2.send({ to: 'reject@example.test', template: 'portal.security_event', data: { event: 'x' } });
    assert.match(r2.error, /RCPT TO rejected .*550/);
    assert.equal(rejected.messages.length, 0);
  } finally { await rejected.close(); }
});

function fakeSendmail(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sendmail'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

test('sendmail transport is unavailable under NoNewPrivs and never executes the binary', async () => {
  const status = path.join(tmp, 'status-nnp');
  fs.writeFileSync(status, 'Name:\tnode\nNoNewPrivs:\t1\nSeccomp:\t0\n');
  assert.match(sendmailUnavailableReason({ procStatusFile: status }), /NoNewPrivileges=yes.*license\.mail\.transport to "smtp"/);
  fs.writeFileSync(path.join(tmp, 'status-ok'), 'Name:\tnode\nNoNewPrivs:\t0\n');
  assert.equal(sendmailUnavailableReason({ procStatusFile: path.join(tmp, 'status-ok') }), null);
  assert.equal(sendmailUnavailableReason({ procStatusFile: path.join(tmp, 'missing') }), null);

  const marker = path.join(tmp, 'ran-under-nnp');
  const bin = path.join(fakeSendmail(path.join(tmp, 'nnp-bin'), `cat >/dev/null; touch ${marker}; exit 0`), 'sendmail');
  const errors = [];
  const mailer = createMailer({ transport: sendmailTransport({ bin, procStatusFile: status }), from: 'a@hub.test', logger: { error: (_o, msg) => errors.push(msg) } });
  assert.equal(mailer.status().ok, false);
  assert.match(mailer.status().error, /no_new_privs/);
  assert.equal(errors.length, 1, 'the boot-time log line names the broken transport');
  const r = await mailer.send({ to: 'c@example.test', template: 'portal.security_event', data: { event: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no_new_privs/);
  assert.ok(!fs.existsSync(marker), 'sendmail was not executed');
  await assert.rejects(mailer.verify(), /no_new_privs/);
});

test('hub boots with transport "sendmail" and surfaces a failing binary in /healthz', async () => {
  const binDir = fakeSendmail(path.join(tmp, 'tempfail-bin'), 'cat >/dev/null; echo "postdrop: warning: mail_queue_enter: create file maildrop/1.2: Permission denied" >&2; exit 75');
  process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH}`;
  const h = await bootHub({ config: { license: { mail: { transport: 'sendmail', from: 'whm-hub@hub.test' } } } });
  try {
    assert.equal(h.ctx.mailer.transport.name, 'sendmail');
    let health = await h.http.get('/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.data.mail, { transport: 'sendmail', target: 'sendmail', enabled: true, ok: true, error: null, failed_at: null, sent: 0, failed: 0 });

    const r = await h.ctx.mailer.send({ to: 'c@example.test', template: 'portal.password_reset', data: { link: 'https://hub.test/r' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /sendmail exited with code 75: postdrop: warning: mail_queue_enter/);
    health = await h.http.get('/healthz');
    assert.equal(health.status, 200, 'a dead mail transport is reported, it does not fail liveness');
    assert.equal(health.body.data.ok, true);
    assert.equal(health.body.data.mail.ok, false);
    assert.match(health.body.data.mail.error, /code 75/);
    assert.ok(health.body.data.mail.failed_at);
    assert.equal(health.body.data.mail.failed, 1);

    // The marketplace's direct transport.send() is recorded the same way.
    const mk = await h.ctx.marketplace.mail('dev@example.test', 'dev.verified', { display_name: 'Dev' });
    assert.equal(mk.ok, false);
    assert.equal((await h.http.get('/healthz')).body.data.mail.failed, 2);

    // A working binary clears the failure.
    fakeSendmail(binDir, 'cat >/dev/null; exit 0');
    assert.deepEqual(await h.ctx.mailer.send({ to: 'c@example.test', template: 'portal.password_reset', data: { link: 'https://hub.test/r' } }), { ok: true });
    const mail = (await h.http.get('/healthz')).body.data.mail;
    assert.equal(mail.ok, true); assert.equal(mail.error, null); assert.equal(mail.sent, 1); assert.equal(mail.failed, 2);

    // A missing binary is named rather than reported as a generic spawn error.
    process.env.PATH = path.join(tmp, 'empty-bin');
    const missing = await h.ctx.mailer.send({ to: 'c@example.test', template: 'portal.password_reset', data: { link: 'https://hub.test/r' } });
    assert.match(missing.error, /sendmail not found on PATH/);
    await assert.rejects(h.ctx.mailer.verify(), /not found on PATH/);
  } finally { process.env.PATH = ORIGINAL_PATH; await h.close(); }
});

test('hub boots with transport "smtp" against a local MTA and /healthz tracks it', async () => {
  const srv = await fakeSmtp();
  const h = await bootHub({ config: { license: { mail: { transport: 'smtp', from: 'whm-hub@hub.test', smtp: { host: '127.0.0.1', port: srv.port, timeout_ms: 5000 } } } } });
  try {
    assert.equal(h.ctx.mailer.transport.name, 'smtp');
    assert.deepEqual(await h.ctx.mailer.verify(), { ok: true });
    const { license } = h.issue();
    await waitFor(() => srv.messages.length === 1);
    assert.equal(srv.messages.at(-1).to[0], `TO:<${h.db.prepare('SELECT email FROM customers WHERE id = ?').get(license.customer_id).email}>`);
    assert.ok(!srv.messages.at(-1).data.includes(license.key_prefix + '-' + 'X'), 'only the prefix is mailed');
    const mail = (await h.http.get('/healthz')).body.data.mail;
    assert.equal(mail.ok, true); assert.equal(mail.target, `127.0.0.1:${srv.port}`); assert.equal(mail.sent, 1);
  } finally { await h.close(); await srv.close(); }
});

test('config: smtp is the default transport, WHM_HUB_SMTP_* override it, hub.conf.example is valid', () => {
  const none = loadConfig({ file: '/nonexistent/hub.conf', env: {} });
  assert.equal(none.license.mail.transport, 'smtp');
  assert.deepEqual(none.license.mail.smtp, { host: '127.0.0.1', port: 25, secure: false, starttls: 'auto', timeout_ms: 20_000 }, 'reject_unauthorized is unset by default: the transport decides per host');
  const env = loadConfig({ file: '/nonexistent/hub.conf', env: { WHM_HUB_MAIL_TRANSPORT: 'smtp', WHM_HUB_SMTP_HOST: 'smtp.example.test', WHM_HUB_SMTP_PORT: '587', WHM_HUB_SMTP_USER: 'hub', WHM_HUB_SMTP_PASS: 'pw' } });
  assert.deepEqual({ host: env.license.mail.smtp.host, port: env.license.mail.smtp.port, user: env.license.mail.smtp.user, pass: env.license.mail.smtp.pass }, { host: 'smtp.example.test', port: 587, user: 'hub', pass: 'pw' });
  assert.throws(() => loadConfig({ file: '/nonexistent/hub.conf', env: {}, overrides: { license: { mail: { transport: 'exim' } } } }), /license\.mail\.transport/);
  const example = loadConfig({ file: path.join(HERE, '../../deploy/hub.conf.example'), env: {} });
  assert.equal(example.license.mail.transport, 'smtp');
  assert.equal(example.license.mail.smtp.host, '127.0.0.1');
  assert.equal(loadConfig({ file: '/nonexistent/hub.conf', env: {}, overrides: { license: { mail: { transport: 'sendmail' } } } }).license.mail.transport, 'sendmail', 'sendmail stays available for unhardened deployments');
});

test('smtp transport verifies certificates except for a loopback MTA unless told otherwise', () => {
  assert.equal(smtpTransport({ host: '127.0.0.1', port: 25 }).policy.rejectUnauthorized, false);
  assert.equal(smtpTransport({ host: 'localhost', port: 25 }).policy.rejectUnauthorized, false);
  assert.equal(smtpTransport({ host: 'smtp.example.com', port: 587 }).policy.rejectUnauthorized, true);
  assert.equal(smtpTransport({ host: '127.0.0.1', port: 25, reject_unauthorized: true }).policy.rejectUnauthorized, true);
  assert.equal(smtpTransport({ host: 'smtp.example.com', port: 587, reject_unauthorized: false }).policy.rejectUnauthorized, false);
});
