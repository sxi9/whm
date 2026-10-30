import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

// Templated notification mail over one of three transports: SMTP submission
// to a local or remote MTA (the default: it is the only transport that works
// under the shipped whm-hub.service hardening, where NoNewPrivileges strips
// the setuid/setgid bit `sendmail` needs to reach the MTA spool), the local
// `sendmail -t -i` binary (argv only, message on stdin) for unhardened
// deployments, or a recording transport for tests. Templates never receive
// secrets (keys, tokens).
export const TEMPLATES = {
  'license.issued': (d) => ({ subject: `Your ${d.edition} license is ready`, text: `Hello ${d.name || ''},\n\nA ${d.edition} license (${d.key_prefix}-…) was issued to this address.${d.expires_at ? ` It is valid until ${d.expires_at}.` : ''}\n\nManage it in the portal: ${d.portal_url || ''}\n` }),
  'license.expiring': (d) => ({ subject: `License ${d.key_prefix} expires in ${d.days_left} day(s)`, text: `Your ${d.edition} license ${d.key_prefix}-… expires on ${d.expires_at}. Renew it in the portal: ${d.portal_url || ''}\n` }),
  'license.expired': (d) => ({ subject: `License ${d.key_prefix} has expired`, text: `Your ${d.edition} license ${d.key_prefix}-… expired on ${d.expires_at}. The panel stays read-only until it is renewed.\n` }),
  'license.recover': (d) => ({ subject: 'Your WHM license keys', text: `These license key prefixes are registered to this address:\n\n${(d.prefixes || []).map((p) => `  ${p.key_prefix}-…  (${p.edition}, ${p.status})`).join('\n') || '  (none)'}\n\nFull keys are never sent by e-mail. Sign in to the portal to manage them: ${d.portal_url || ''}\n` }),
  'trial.started': (d) => ({ subject: 'Your WHM trial has started', text: `Your 14-day trial (${d.key_prefix}-…) runs until ${d.expires_at}. Convert it any time in the portal: ${d.portal_url || ''}\n` }),
  'portal.password_reset': (d) => ({ subject: 'Portal password reset', text: `Use this link within 15 minutes to reset your password: ${d.link}\n` }),
  'portal.security_event': (d) => ({ subject: `Portal security notice: ${d.event}`, text: `${d.detail || d.event}\n` }),
};

export function renderTemplate(name, data = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`unknown mail template "${name}"`);
  return tpl(data);
}

// The bare addr-spec of a header value ("Name <a@b>" or "a@b"), or null when it
// could break an SMTP command (whitespace, brackets, quotes, control characters).
const ADDRESS_RE = /^[^\s<>",;:\\@()[\]]+@[A-Za-z0-9.-]+$/;
export function envelopeAddress(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^[^<>]*<([^<>]*)>\s*$/);
  const addr = (m ? m[1] : s).trim();
  return ADDRESS_RE.test(addr) ? addr : null;
}

function headerValue(message, name) {
  const head = String(message).split(/\r?\n\r?\n/)[0];
  return head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'))?.[1]?.trim() ?? null;
}

// eslint-disable-next-line no-control-regex
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function buildMessage({ from, to, subject, text, now = Date.now }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, ' ');
  const domain = envelopeAddress(from)?.split('@')[1] || os.hostname() || 'localhost';
  const headers = [
    `From: ${safe(from)}`,
    `To: ${safe(to)}`,
    `Subject: ${encodeHeader(safe(subject))}`,
    `Date: ${new Date(now()).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${text}`;
}

// systemd's NoNewPrivileges= (set by deploy/whm-hub.service) makes execve ignore
// setuid/setgid bits, so Exim's setuid binary and Postfix's setgid postdrop can
// no longer write the MTA spool: every submission fails with EACCES and the
// message is lost. Detected once at boot from /proc/self/status.
export function sendmailUnavailableReason({ procStatusFile = '/proc/self/status' } = {}) {
  let status = '';
  try { status = fs.readFileSync(procStatusFile, 'utf8'); } catch { return null; }
  if (!/^NoNewPrivs:\s*1\b/m.test(status)) return null;
  return 'sendmail transport cannot deliver: this process runs with no_new_privs (systemd NoNewPrivileges=yes), so the setuid/setgid MTA submission binary cannot reach its spool; set license.mail.transport to "smtp" (local MTA on 127.0.0.1:25) or "none"';
}

function onPath(bin) {
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH || '').split(path.delimiter).some((dir) => { try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; } });
}

export function sendmailTransport({ bin = 'sendmail', procStatusFile } = {}) {
  return {
    name: 'sendmail',
    target: bin,
    unavailable: sendmailUnavailableReason({ procStatusFile }),
    async verify() {
      if (!onPath(bin)) throw new Error(`${bin} not found on PATH`);
    },
    send(message) {
      return new Promise((resolve, reject) => {
        const child = execFile(bin, ['-t', '-i'], { timeout: 15_000 }, (err, _stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          if (err.code === 'ENOENT') return reject(new Error(`${bin} not found on PATH`));
          const detail = String(stderr || '').trim().split('\n')[0];
          reject(new Error(`${bin} exited with ${err.signal ? `signal ${err.signal}` : `code ${err.code}`}${detail ? `: ${detail}` : ''}`));
        });
        child.stdin.on('error', reject);
        child.stdin.end(message);
      });
    },
  };
}

const isLoopbackHost = (host) => /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i.test(String(host));

// Minimal SMTP submission client (RFC 5321 + STARTTLS + AUTH PLAIN/LOGIN).
// One connection per message; credentials are only ever sent over TLS or to
// the loopback interface, and no SMTP line is logged.
export function smtpTransport(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || 25);
  const secure = !!options.secure;
  const starttls = options.starttls || 'auto';
  const user = options.user || null;
  const pass = options.pass || null;
  const timeoutMs = options.timeoutMs ?? options.timeout_ms ?? 20_000;
  const loopback = isLoopbackHost(host);
  // A loopback MTA presents the self-signed certificate the distribution
  // generated; that hop never leaves the host, so it is accepted unless the
  // operator says otherwise. Any other host is verified.
  const rejectUnauthorized = options.rejectUnauthorized ?? options.reject_unauthorized ?? !loopback;
  const caFile = options.ca_file || null;
  const ca = options.ca || (caFile ? fs.readFileSync(caFile) : undefined);
  const servername = options.servername || (net.isIP(host) ? undefined : host);
  const ehloName = options.ehlo || os.hostname() || 'localhost';
  const tlsOptions = { servername, rejectUnauthorized, ca, minVersion: 'TLSv1.2' };

  function connection() {
    const conn = { socket: null, listeners: {}, buf: '', waiter: null, dead: null, tls: false, caps: new Set(), auth: new Set() };
    const fail = (err) => {
      conn.dead ||= err;
      const w = conn.waiter;
      conn.waiter = null;
      if (w) w.reject(err);
    };
    const pump = () => {
      const w = conn.waiter;
      if (!w) return;
      const lines = conn.buf.split('\r\n');
      const text = [];
      for (let i = 0; i < lines.length - 1; i++) {
        const m = lines[i].match(/^(\d{3})([ -])(.*)$/);
        if (!m) return fail(new Error(`smtp: malformed reply from ${host}:${port}`));
        text.push(m[3]);
        if (m[2] === ' ') {
          conn.buf = lines.slice(i + 1).join('\r\n');
          conn.waiter = null;
          return w.resolve({ code: Number(m[1]), text });
        }
      }
    };
    // detach() removes only this connection's listeners, so a STARTTLS upgrade
    // hands the raw socket to tls.connect() clean and the TLS socket's own
    // internals are untouched.
    conn.detach = () => {
      const s = conn.socket;
      if (!s) return;
      for (const [ev, fn] of Object.entries(conn.listeners)) s.removeListener(ev, fn);
      s.setTimeout(0);
      conn.socket = null;
    };
    conn.attach = (sock) => {
      conn.detach();
      conn.socket = sock;
      conn.listeners = {
        timeout: () => { fail(new Error(`smtp: ${host}:${port} timed out after ${timeoutMs} ms`)); sock.destroy(); },
        data: (chunk) => { conn.buf += chunk.toString('latin1'); pump(); },
        error: (err) => fail(new Error(`smtp: ${host}:${port}: ${err.code || err.message}`)),
        close: () => fail(new Error(`smtp: ${host}:${port} closed the connection`)),
      };
      sock.setTimeout(timeoutMs);
      for (const [ev, fn] of Object.entries(conn.listeners)) sock.on(ev, fn);
    };
    conn.read = () => new Promise((resolve, reject) => {
      if (conn.dead) return reject(conn.dead);
      conn.waiter = { resolve, reject };
      pump();
    });
    conn.expect = async (codes, what) => {
      const reply = await conn.read();
      if (!codes.includes(reply.code)) throw new Error(`smtp: ${what} rejected by ${host}:${port}: ${reply.code} ${reply.text.join(' ').slice(0, 200)}`);
      return reply;
    };
    conn.cmd = (line, codes, what = line.split(' ')[0]) => {
      if (conn.dead) return Promise.reject(conn.dead);
      conn.socket.write(`${line}\r\n`);
      return conn.expect(codes, what);
    };
    conn.ehlo = async () => {
      const reply = await conn.cmd(`EHLO ${ehloName}`, [250]);
      conn.caps = new Set();
      conn.auth = new Set();
      for (const line of reply.text.slice(1)) {
        const [kw, ...rest] = line.trim().split(/[\s=]+/);
        conn.caps.add(kw.toUpperCase());
        if (kw.toUpperCase() === 'AUTH') for (const m of rest) conn.auth.add(m.toUpperCase());
      }
    };
    conn.destroy = () => { conn.dead ||= new Error('smtp: connection finished'); conn.socket?.destroy(); };
    return conn;
  }

  async function open() {
    const conn = connection();
    const handshake = (sock, event, what) => new Promise((resolve, reject) => {
      const onError = (err) => { sock.destroy(); reject(new Error(`smtp: ${what} ${host}:${port} failed: ${err.code || err.message}`)); };
      const onTimeout = () => onError(new Error(`timed out after ${timeoutMs} ms`));
      sock.once('error', onError);
      sock.once('timeout', onTimeout);
      sock.setTimeout(timeoutMs);
      sock.once(event, () => { sock.removeListener('error', onError); sock.removeListener('timeout', onTimeout); resolve(sock); });
    });
    const sock = await handshake(secure ? tls.connect({ host, port, ...tlsOptions }) : net.connect({ host, port }), secure ? 'secureConnect' : 'connect', 'connecting to');
    conn.tls = secure;
    conn.attach(sock);
    try {
      await conn.expect([220], 'greeting');
      await conn.ehlo();
      if (!secure && starttls !== 'off') {
        if (!conn.caps.has('STARTTLS')) {
          if (starttls === 'require') throw new Error(`smtp: ${host}:${port} does not offer STARTTLS (license.mail.smtp.starttls is "require")`);
        } else {
          await conn.cmd('STARTTLS', [220]);
          const raw = conn.socket;
          conn.detach();
          conn.attach(await handshake(tls.connect({ socket: raw, ...tlsOptions }), 'secureConnect', 'STARTTLS with'));
          conn.tls = true;
          await conn.ehlo();
        }
      }
      if (user) {
        if (!conn.tls && !loopback) throw new Error(`smtp: refusing to send credentials to ${host}:${port} over a plaintext connection`);
        if (!conn.auth.size || conn.auth.has('PLAIN')) {
          await conn.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass || ''}`, 'utf8').toString('base64')}`, [235], 'AUTH');
        } else if (conn.auth.has('LOGIN')) {
          await conn.cmd('AUTH LOGIN', [334]);
          await conn.cmd(Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH');
          await conn.cmd(Buffer.from(pass || '', 'utf8').toString('base64'), [235], 'AUTH');
        } else {
          throw new Error(`smtp: ${host}:${port} offers no supported AUTH mechanism (${[...conn.auth].join(', ')})`);
        }
      }
      return conn;
    } catch (err) {
      conn.destroy();
      throw err;
    }
  }

  const quit = (conn) => conn.cmd('QUIT', [221]).catch(() => {}).finally(() => conn.destroy());

  return {
    name: 'smtp',
    // For diagnostics and tests: the effective connection policy.
    policy: { host, port, secure, starttls, loopback, rejectUnauthorized },
    target: `${host}:${port}`,
    unavailable: null,
    async verify() {
      await quit(await open());
    },
    async send(message, meta = {}) {
      const from = envelopeAddress(meta.from) || envelopeAddress(headerValue(message, 'From'));
      const to = envelopeAddress(meta.to) || envelopeAddress(headerValue(message, 'To'));
      if (!from) throw new Error('smtp: invalid sender address');
      if (!to) throw new Error('smtp: invalid recipient address');
      const conn = await open();
      try {
        await conn.cmd(`MAIL FROM:<${from}>${conn.caps.has('8BITMIME') ? ' BODY=8BITMIME' : ''}`, [250], 'MAIL FROM');
        await conn.cmd(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
        await conn.cmd('DATA', [354]);
        let body = String(message).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        if (!body.endsWith('\r\n')) body += '\r\n';
        conn.socket.write(`${body}.\r\n`);
        await conn.expect([250], 'message');
        await quit(conn);
        return { ok: true };
      } catch (err) {
        conn.destroy();
        throw err;
      }
    },
  };
}

export function recordingTransport() {
  const sent = [];
  return { name: 'recording', sent, send: async (message, meta) => { sent.push({ message, ...meta }); return { ok: true }; } };
}

// mailer.transport is the inner transport wrapped so that every send — the
// templated ones here and the marketplace's direct transport.send() — records
// its outcome; status() feeds /healthz so a dead transport is visible.
export function createMailer({ transport, from = 'whm-hub@localhost', logger, enabled = true, now = Date.now } = {}) {
  const inner = transport || sendmailTransport();
  const state = { sent: 0, failed: 0, last: null };
  const record = (err, meta) => {
    state.failed++;
    state.last = { at: new Date(now()).toISOString(), error: String(err?.message || err), template: meta?.template || null };
  };
  if (enabled && inner.unavailable) logger?.error({ transport: inner.name }, inner.unavailable);
  const wrapped = {
    name: inner.name,
    target: inner.target || null,
    sent: inner.sent,
    unavailable: inner.unavailable || null,
    async send(message, meta = {}) {
      if (inner.unavailable) { const err = new Error(inner.unavailable); record(err, meta); throw err; }
      try {
        const result = await inner.send(message, { from, ...meta });
        state.sent++;
        state.last = null;
        return result;
      } catch (err) {
        record(err, meta);
        throw err;
      }
    },
  };
  return {
    transport: wrapped,
    sent: inner.sent || [],
    status() {
      return {
        transport: inner.name, target: inner.target || null, enabled,
        ok: !enabled || (!inner.unavailable && !state.last),
        error: enabled ? (state.last?.error || inner.unavailable || null) : null,
        failed_at: state.last?.at || null, sent: state.sent, failed: state.failed,
      };
    },
    // Boot-time probe (connect/EHLO/QUIT for SMTP, binary lookup for sendmail);
    // a failure is recorded like a lost message so /healthz reports it at once.
    async verify() {
      if (!enabled) return { ok: true, skipped: true };
      try {
        if (inner.unavailable) throw new Error(inner.unavailable);
        if (inner.verify) await inner.verify();
        return { ok: true };
      } catch (err) {
        record(err, { template: 'verify' });
        throw err;
      }
    },
    async send({ to, template, data }) {
      const { subject, text } = renderTemplate(template, data);
      if (!enabled || !to) return { ok: false, skipped: true };
      try {
        await wrapped.send(buildMessage({ from, to, subject, text, now }), { to, template, subject, data });
        return { ok: true };
      } catch (err) {
        logger?.error({ err, template, to }, 'mail delivery failed');
        return { ok: false, error: String(err.message || err) };
      }
    },
  };
}
