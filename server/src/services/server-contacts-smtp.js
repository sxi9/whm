import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

// A minimal SMTP submission client for hosts without Exim: EHLO, optional
// STARTTLS or implicit TLS, AUTH PLAIN/LOGIN, one message. Addresses are
// validated by the caller; this layer only speaks the protocol.

export class SmtpError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ADDRESS = /^[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

function encodeHeader(value) {
  const s = String(value).replace(/[\r\n]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// RFC 5322 text/plain message with CRLF line endings; the same shape the
// agent's mail.sendmail op hands to Exim so both transports look alike.
export function buildMessage({ from, to, subject, text, headers = {} }) {
  const recipients = Array.isArray(to) ? to : [to];
  const lines = [
    `From: ${from}`, `To: ${recipients.join(', ')}`, `Subject: ${encodeHeader(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', 'X-Mailer: WHM panel',
  ];
  for (const [k, v] of Object.entries(headers)) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k) || /^(from|to|subject|date|content-type|mime-version|message-id)$/i.test(k)) continue;
    lines.push(`${k}: ${encodeHeader(v)}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n${String(text).replace(/\r?\n/g, '\r\n')}\r\n`;
}

// Lines starting with "." are doubled inside DATA (RFC 5321 4.5.2).
export function dotStuff(message) {
  return message.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

export function sendSmtp({ host, port = 587, security = 'starttls', username, password, from, to, message, timeoutMs = 20_000, rejectUnauthorized = true, clientName }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!ADDRESS.test(from)) return Promise.reject(new SmtpError('invalid_address', `"${from}" is not a usable sender address`));
  for (const r of recipients) if (!ADDRESS.test(r)) return Promise.reject(new SmtpError('invalid_address', `"${r}" is not a usable recipient address`));
  if (!['none', 'starttls', 'tls'].includes(security)) return Promise.reject(new SmtpError('invalid_args', `Unknown SMTP security mode "${security}"`));
  const ehloName = clientName || os.hostname() || 'localhost';

  return new Promise((resolve, reject) => {
    let socket = null;
    let buffer = '';
    let partial = [];
    const queue = [];
    let waiter = null;
    let done = false;
    let secure = security === 'tls';

    const fail = (err) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      if (waiter) { const w = waiter; waiter = null; w({ code: 0, lines: [err.message] }); }
      reject(err);
    };
    const pushReply = (reply) => { if (waiter) { const w = waiter; waiter = null; w(reply); } else queue.push(reply); };
    const expectReply = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((res) => { waiter = res; }));
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        partial.push(line);
        if (/^\d{3}-/.test(line)) continue;
        pushReply({ code: Number(line.slice(0, 3)), lines: partial.map((l) => l.slice(4)) });
        partial = [];
      }
    };
    const attach = (s) => {
      socket = s;
      s.setTimeout(timeoutMs, () => fail(new SmtpError('timeout', `The SMTP server ${host}:${port} did not answer within ${timeoutMs}ms`)));
      s.on('error', (e) => fail(new SmtpError('connect_failed', `SMTP ${host}:${port}: ${e.message}`)));
      s.on('data', onData);
      s.on('close', () => fail(new SmtpError('connection_closed', `The SMTP server ${host}:${port} closed the connection`)));
    };
    const detach = (s) => { s.removeAllListeners('data'); s.removeAllListeners('error'); s.removeAllListeners('close'); s.removeAllListeners('timeout'); s.setTimeout(0); };
    const send = async (command, okCodes, { redact = false } = {}) => {
      if (done) throw new SmtpError('aborted', 'connection lost');
      socket.write(`${command}\r\n`);
      const reply = await expectReply();
      if (!okCodes.includes(reply.code)) {
        const verb = redact ? 'AUTH' : command.split(' ')[0];
        throw new SmtpError(reply.code >= 500 ? 'rejected' : 'deferred', `${verb} failed: ${reply.code} ${reply.lines.join(' ')}`.trim(), { stage: verb, code: reply.code });
      }
      return reply;
    };
    const ehlo = async () => (await send(`EHLO ${ehloName}`, [250])).lines.slice(1).map((l) => l.toUpperCase());

    (async () => {
      attach(security === 'tls' ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port }));
      const greeting = await expectReply();
      if (greeting.code !== 220) throw new SmtpError('rejected', `SMTP greeting was ${greeting.code} ${greeting.lines.join(' ')}`.trim());
      let caps = await ehlo();
      if (security === 'starttls') {
        if (!caps.some((c) => c.startsWith('STARTTLS'))) throw new SmtpError('unsupported', `${host}:${port} does not offer STARTTLS; choose implicit TLS or "none"`);
        await send('STARTTLS', [220]);
        const plain = socket;
        detach(plain);
        const upgraded = tls.connect({ socket: plain, servername: host, rejectUnauthorized });
        attach(upgraded);
        await new Promise((res, rej) => { upgraded.once('secureConnect', res); upgraded.once('error', rej); });
        secure = true;
        caps = await ehlo();
      }
      if (username) {
        const mechanisms = (caps.find((c) => /^AUTH[ =]/.test(c)) || '').slice(5).split(/\s+/).filter(Boolean);
        if (mechanisms.includes('PLAIN') || !mechanisms.length) {
          await send(`AUTH PLAIN ${Buffer.from(`\0${username}\0${password ?? ''}`, 'utf8').toString('base64')}`, [235], { redact: true });
        } else if (mechanisms.includes('LOGIN')) {
          await send('AUTH LOGIN', [334], { redact: true });
          await send(Buffer.from(username, 'utf8').toString('base64'), [334], { redact: true });
          await send(Buffer.from(password ?? '', 'utf8').toString('base64'), [235], { redact: true });
        } else {
          throw new SmtpError('unsupported', `The relay offers only ${mechanisms.join(', ')} authentication; PLAIN or LOGIN is required`);
        }
      }
      await send(`MAIL FROM:<${from}>`, [250]);
      for (const r of recipients) await send(`RCPT TO:<${r}>`, [250, 251]);
      await send('DATA', [354]);
      socket.write(`${dotStuff(message).replace(/\r\n$/, '')}\r\n.\r\n`);
      const accepted = await expectReply();
      if (accepted.code !== 250) throw new SmtpError(accepted.code >= 500 ? 'rejected' : 'deferred', `Message rejected: ${accepted.code} ${accepted.lines.join(' ')}`.trim(), { stage: 'DATA', code: accepted.code });
      try { await send('QUIT', [221]); } catch { /* the message is already accepted */ }
      done = true;
      socket.end();
      resolve({ accepted: true, response: accepted.lines.join(' '), tls: secure, authenticated: Boolean(username), host, port });
    })().catch((err) => fail(err instanceof SmtpError ? err : new SmtpError('smtp_failed', err.message)));
  });
}
