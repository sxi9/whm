import { execFile } from 'node:child_process';

// Templated notification mail. No SMTP client: the only transport is the local
// `sendmail -t -i` binary (argv only, message on stdin) or a recording
// transport for tests. Templates never receive secrets (keys, tokens).
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

function buildMessage({ from, to, subject, text }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, ' ');
  return `From: ${safe(from)}\r\nTo: ${safe(to)}\r\nSubject: ${safe(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
}

export function sendmailTransport({ bin = 'sendmail' } = {}) {
  return {
    name: 'sendmail',
    send(message) {
      return new Promise((resolve, reject) => {
        const child = execFile(bin, ['-t', '-i'], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve({ ok: true })));
        child.stdin.on('error', reject);
        child.stdin.end(message);
      });
    },
  };
}

export function recordingTransport() {
  const sent = [];
  return { name: 'recording', sent, send: async (message, meta) => { sent.push({ message, ...meta }); return { ok: true }; } };
}

export function createMailer({ transport, from = 'whm-hub@localhost', logger, enabled = true } = {}) {
  const t = transport || sendmailTransport();
  return {
    transport: t,
    sent: t.sent || [],
    async send({ to, template, data }) {
      const { subject, text } = renderTemplate(template, data);
      if (!enabled || !to) return { ok: false, skipped: true };
      try {
        await t.send(buildMessage({ from, to, subject, text }), { to, template, subject, data });
        return { ok: true };
      } catch (err) {
        logger?.error({ err, template, to }, 'mail delivery failed');
        return { ok: false, error: String(err.message || err) };
      }
    },
  };
}
