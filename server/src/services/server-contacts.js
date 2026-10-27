import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { json, paginate } from '../db/index.js';
import { notFound, unprocessable, CapabilityError, HttpError } from '../lib/errors.js';
import { sendSmtp, buildMessage, SmtpError } from './server-contacts-smtp.js';

// Server Contacts: who gets told about what. Attached as ctx.contacts; other
// categories call ctx.contacts.notify({ event, subject, body, severity }) and
// ctx.contacts.sendMail({ to, subject, body }). Email leaves through Exim when
// it is installed, otherwise through the SMTP relay configured here.

export const SEVERITIES = ['info', 'warning', 'error', 'critical'];
export const CHANNELS = ['email', 'sms', 'slack', 'pushover', 'webhook'];
export const SMTP_SECURITY = ['none', 'starttls', 'tls'];

// wired: false marks catalog entries no module raises yet (accounts and
// backup.completed are core follow-ups, licensing is Phase 5); the UI says so
// instead of letting admins subscribe to silence.
export const EVENTS = [
  { key: 'account.created', label: 'Account created', severity: 'info', group: 'Accounts', wired: false },
  { key: 'account.suspended', label: 'Account suspended', severity: 'warning', group: 'Accounts', wired: false },
  { key: 'account.terminated', label: 'Account terminated', severity: 'warning', group: 'Accounts', wired: false },
  { key: 'account.rearrange', label: 'Account move (Rearrange an Account) needs attention', severity: 'warning', group: 'Accounts' },
  { key: 'backup.failed', label: 'Backup failed', severity: 'error', group: 'Backups' },
  { key: 'backup.completed', label: 'Backup completed', severity: 'info', group: 'Backups', wired: false },
  { key: 'service.down', label: 'Monitored service down', severity: 'error', group: 'Monitoring' },
  { key: 'service.restored', label: 'Monitored service back up', severity: 'info', group: 'Monitoring' },
  { key: 'disk.space.low', label: 'Disk space low', severity: 'warning', group: 'Monitoring' },
  { key: 'bpk.killed', label: 'Background Process Killer terminated processes', severity: 'warning', group: 'Security' },
  { key: 'login.failed.blocked', label: 'Address blocked after failed logins', severity: 'warning', group: 'Security', wired: false },
  { key: 'login.new_ip', label: 'Login from a new address', severity: 'warning', group: 'Security' },
  { key: 'ssl.expiring', label: 'SSL certificate expiring', severity: 'warning', group: 'SSL' },
  { key: 'updates.available', label: 'Software updates available', severity: 'info', group: 'Software' },
  { key: 'license.expiring', label: 'License expiring', severity: 'warning', group: 'Licensing', wired: false },
  { key: 'license.invalid', label: 'License invalid or revoked', severity: 'error', group: 'Licensing', wired: false },
  { key: 'license.activated', label: 'License activated or renewed', severity: 'info', group: 'Licensing', wired: false },
  { key: 'license.plugin_key_conflict', label: 'Plugin signing key conflicts with an operator-installed key', severity: 'error', group: 'Licensing' },
  { key: 'plugin.revoked', label: 'Marketplace plugin revoked and disabled', severity: 'error', group: 'Plugins' },
  { key: 'plugin.update_available', label: 'Marketplace plugin updates available', severity: 'info', group: 'Plugins' },
  { key: 'test', label: 'Test notification', severity: 'info', group: 'Panel' },
].map((e) => ({ wired: true, ...e }));
export const MANAGED_MAIL_USERS = ['root', 'nobody'];
const EVENT_BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));
export const EVENT_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

// Per-channel address shapes; a mail address may not start with "-" because
// it becomes an argv element of exim.
const EMAIL_RE = /^[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;
const SLACK_RE = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]{8,200}$/;
const PUSHOVER_KEY_RE = /^[A-Za-z0-9]{30}$/;
const FQDN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function validateAddress(channel, address) {
  const a = String(address || '').trim();
  switch (channel) {
    case 'email': return EMAIL_RE.test(a) ? null : 'Must be a full email address';
    case 'sms': return EMAIL_RE.test(a) ? null : 'Must be the email-to-SMS gateway address for the phone (for example 5551234567@txt.example.net)';
    case 'slack': return SLACK_RE.test(a) ? null : 'Must be a Slack incoming webhook URL (https://hooks.slack.com/services/...)';
    case 'pushover': return PUSHOVER_KEY_RE.test(a) ? null : 'Must be the 30-character Pushover user or group key';
    case 'webhook': {
      let url;
      try { url = new URL(a); } catch { return 'Must be an http(s) URL'; }
      if (!['http:', 'https:'].includes(url.protocol)) return 'Must be an http(s) URL';
      if (url.username || url.password) return 'Credentials in the URL are not allowed; use the signing secret instead';
      return null;
    }
    default: return 'Unknown channel';
  }
}

// A Slack incoming-webhook URL is a bearer credential, as is any webhook URL
// that carries a token in its query string: only a masked display form is
// stored in contacts.address, logged or audited; the real URL lives encrypted
// in config.url_enc.
export function maskAddress(channel, address) {
  const a = String(address || '').trim();
  if (channel === 'slack') {
    const url = new URL(a);
    const segs = url.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    return { display: `${url.host}/${segs[0] || ''}/${(segs[1] || '').slice(0, 4)}…/…${last.slice(-4)}`, secret: a };
  }
  if (channel === 'webhook') {
    const url = new URL(a);
    if (url.search || url.hash) return { display: `${url.origin}${url.pathname}?…`, secret: a };
  }
  return { display: a, secret: null };
}

const severityRank = (s) => Math.max(0, SEVERITIES.indexOf(s));

// Addresses a webhook may not post to unless contacts.webhook.allow_private
// is on: the panel runs as root next to metadata services and internal
// admin ports, so a contact must not become an SSRF primitive.
const PRIVATE_RANGES = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE_RANGES.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE_RANGES.addSubnet(addr, bits, 'ipv6');
export function isPrivateAddress(address) {
  const a = String(address || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = net.isIP(a);
  if (!family) return false;
  return PRIVATE_RANGES.check(a, family === 6 ? 'ipv6' : 'ipv4');
}

// Accepts notify({ event, subject, body, severity, data }) and the shorthand
// notify('updates.available', payload) other categories use.
export function normalizeNotification(eventOrMessage, payload) {
  let msg;
  if (typeof eventOrMessage === 'string') {
    const isMessage = payload && typeof payload === 'object' && !Array.isArray(payload) && ['subject', 'body', 'text', 'message', 'severity', 'data'].some((k) => k in payload);
    msg = { event: eventOrMessage, ...(isMessage ? payload : payload && typeof payload === 'object' ? { data: payload } : { body: payload }) };
  } else {
    msg = { ...(eventOrMessage || {}) };
  }
  const event = String(msg.event || 'test');
  const catalog = EVENT_BY_KEY.get(event);
  const severity = SEVERITIES.includes(msg.severity) ? msg.severity : catalog?.severity || 'info';
  const subject = String(msg.subject || catalog?.label || event).replace(/[\r\n]+/g, ' ').slice(0, 200);
  let body = msg.body ?? msg.text ?? msg.message;
  if (body != null && typeof body !== 'string') body = JSON.stringify(body, null, 2);
  if (body == null) body = msg.data != null ? JSON.stringify(msg.data, null, 2) : subject;
  return { event, severity, subject, body: String(body).slice(0, 20_000), data: msg.data ?? null };
}

export function createServerContactsService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;
  const stmts = {
    all: db.prepare('SELECT * FROM contacts ORDER BY enabled DESC, name COLLATE NOCASE, id'),
    enabled: db.prepare('SELECT * FROM contacts WHERE enabled = 1 ORDER BY id'),
    byId: db.prepare('SELECT * FROM contacts WHERE id = ?'),
    insert: db.prepare(`INSERT INTO contacts (name, channel, address, events_json, enabled, config_json, min_severity, updated_at) VALUES (@name, @channel, @address, @events, @enabled, @config, @min_severity, datetime('now'))`),
    update: db.prepare(`UPDATE contacts SET name = @name, channel = @channel, address = @address, events_json = @events, enabled = @enabled, config_json = @config, min_severity = @min_severity, updated_at = datetime('now') WHERE id = @id`),
    remove: db.prepare('DELETE FROM contacts WHERE id = ?'),
    markSent: db.prepare("UPDATE contacts SET last_sent_at = datetime('now'), last_error = NULL WHERE id = ?"),
    markFailed: db.prepare('UPDATE contacts SET last_error = ? WHERE id = ?'),
    insertDelivery: db.prepare('INSERT INTO contact_deliveries (contact_id, contact_name, channel, address, event, severity, subject, status, transport, error, test) VALUES (@contact_id, @contact_name, @channel, @address, @event, @severity, @subject, @status, @transport, @error, @test)'),
    recentDeliveries: db.prepare('SELECT * FROM contact_deliveries ORDER BY id DESC LIMIT ?'),
    pruneDeliveries: db.prepare("DELETE FROM contact_deliveries WHERE ts < datetime('now', ?)"),
    deliveryStats: db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN ts >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last24h, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM contact_deliveries"),
    alertState: db.prepare('SELECT * FROM contact_alert_state WHERE key = ?'),
    alertStates: db.prepare('SELECT * FROM contact_alert_state ORDER BY key'),
    upsertAlert: db.prepare(`INSERT INTO contact_alert_state (key, state, detail, last_notified_at) VALUES (@key, @state, @detail, @last_notified_at)
      ON CONFLICT (key) DO UPDATE SET state = excluded.state, detail = excluded.detail, last_notified_at = COALESCE(excluded.last_notified_at, last_notified_at)`),
    clearAlert: db.prepare('DELETE FROM contact_alert_state WHERE key = ?'),
    // not_after is stored as an ISO string by ssl-tls; datetime() normalises
    // it so the text comparison does not depend on the "T" separator.
    expiringCerts: db.prepare(`SELECT domain, not_after, 'vhost' AS kind FROM ssl_certs WHERE installed = 1 AND not_after IS NOT NULL AND datetime(not_after) <= datetime('now', @until)
      UNION ALL SELECT service AS domain, not_after, 'service' AS kind FROM ssl_service_certs WHERE cert_pem IS NOT NULL AND not_after IS NOT NULL AND datetime(not_after) <= datetime('now', @until)
      ORDER BY not_after`),
  };

  const SCHEDULE = 'server-contacts-check';
  const JOB = 'server-contacts.check';
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const setting = (key, fallback) => { const v = settings.get(key); return v == null || v === '' ? fallback : v; };
  const hostname = () => setting('basic.hostname', '') || os.hostname() || 'localhost';
  const hasSecret = (key) => Boolean(key && String(key).length);

  function decryptConfig(row) {
    const raw = json.parse(row.config_json, {});
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.endsWith('_enc')) { try { out[k.slice(0, -4)] = ctx.crypto.decrypt(v); } catch { out[k.slice(0, -4)] = null; } } else out[k] = v;
    }
    return out;
  }

  function shape(row) {
    if (!row) return null;
    const raw = json.parse(row.config_json, {});
    const events = json.parse(row.events_json, []);
    return {
      id: row.id, name: row.name || row.address, channel: row.channel, address: row.address,
      events, allEvents: events.includes('*'), minSeverity: row.min_severity || 'info', enabled: Boolean(row.enabled),
      config: Object.fromEntries(Object.entries(raw).map(([k, v]) => (k.endsWith('_enc') ? [k.slice(0, -4), { set: hasSecret(v) }] : [k, v]))),
      lastSentAt: row.last_sent_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  function load(id) {
    const row = stmts.byId.get(id);
    if (!row) throw notFound('Contact');
    return row;
  }

  // Secrets (pushover app token, webhook signing secret) are stored encrypted;
  // a missing key on update keeps the stored value, null removes it.
  function mergeConfig(channel, input = {}, previous = {}) {
    const next = { ...previous };
    const secrets = { pushover: ['token'], webhook: ['secret', 'url'], slack: ['url'] }[channel] || [];
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (key === 'url') continue;
      if (secrets.includes(key)) {
        if (value === null || value === '') delete next[`${key}_enc`];
        else if (value !== undefined) next[`${key}_enc`] = ctx.crypto.encrypt(String(value));
      } else if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    for (const k of Object.keys(next)) if (!secrets.includes(k.replace(/_enc$/, '')) && !['priority', 'channelName', 'format'].includes(k)) delete next[k];
    return next;
  }

  function validateContact(channel, address, config, fields = {}) {
    const addrError = validateAddress(channel, address);
    if (addrError) fields.address = [addrError];
    if (channel === 'pushover' && !hasSecret(config.token_enc)) fields.config = ['A Pushover application token is required'];
    if (Object.keys(fields).length) throw unprocessable('Contact validation failed', fields);
  }

  // Loopback, link-local and RFC1918 targets are refused unless the admin
  // allowed them; the name is resolved here and again before every post so a
  // record that later points inside the network is caught too.
  async function assertWebhookTarget(urlString) {
    if (settings.get('contacts.webhook.allow_private', false)) return;
    const host = new URL(urlString).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const refuse = (addr) => { const m = `Webhook target ${host}${addr && addr !== host ? ` (${addr})` : ''} is a loopback, link-local or private address; turn on "Allow webhooks to private addresses" in Contact Manager to use it`; throw new HttpError(422, 'private_target', m, { address: [m] }); };
    if (host === 'localhost' || host.endsWith('.localhost')) refuse();
    if (net.isIP(host)) { if (isPrivateAddress(host)) refuse(host); return; }
    let records = [];
    try { records = await dns.lookup(host, { all: true }); } catch { return; }
    for (const r of records) if (isPrivateAddress(r.address)) refuse(r.address);
  }

  // Validates the real address, then splits it into what is stored in the
  // address column (display form) and, for credential-bearing URLs, the
  // encrypted secret in config. Submitting the stored display form back
  // (the edit form does that) keeps the secret already on file.
  async function resolveAddress(channel, address, config, row = null) {
    const real = String(address).trim();
    const storedUrl = row && row.channel === channel && hasSecret(json.parse(row.config_json, {}).url_enc) && real === row.address ? decryptConfig(row).url : null;
    const effective = storedUrl || real;
    validateContact(channel, effective, config);
    if (channel === 'webhook') await assertWebhookTarget(effective);
    const { display, secret } = maskAddress(channel, effective);
    const next = { ...config };
    if (secret) next.url_enc = ctx.crypto.encrypt(secret); else delete next.url_enc;
    return { display, config: next };
  }

  // The generic mutation audit stores req.body when the response finishes,
  // so a credential-bearing URL submitted as "address" is swapped for its
  // display form before that happens (also when validation then fails).
  function redactRequestAddress(req, channel, address) {
    if (!req?.body || req.body.address === undefined) return;
    let safe = address;
    try {
      const { display, secret } = maskAddress(channel, address);
      if (secret) safe = display;
      else if (channel === 'webhook') { const url = new URL(address); if (url.username || url.password) safe = '[redacted]'; }
    } catch {
      if (['slack', 'webhook'].includes(channel)) safe = '[redacted]';
    }
    req.body.address = safe;
  }

  // An empty list means every event; "*" may not be mixed with specific keys
  // because matches() would then deliver everything regardless of the keys.
  function normalizeEvents(list) {
    const events = [...new Set(list || [])];
    if (!events.length) return ['*'];
    if (events.includes('*')) {
      if (events.length > 1) throw unprocessable('Contact validation failed', { events: ['Choose either every event ("*") or a list of specific events, not both'] });
      return ['*'];
    }
    return events;
  }

  // The real URL a credential-bearing contact posts to.
  function targetUrl(row, config) {
    return config.url || row.address;
  }

  // Rows written before URLs were treated as secrets hold the full URL in
  // the address column; they are converted the first time the service boots.
  function migrateSecretAddresses() {
    const rows = db.prepare("SELECT * FROM contacts WHERE channel IN ('slack', 'webhook')").all();
    const tx = db.transaction(() => {
      for (const row of rows) {
        const raw = json.parse(row.config_json, {});
        if (hasSecret(raw.url_enc)) continue;
        let masked;
        try { masked = maskAddress(row.channel, row.address); } catch { continue; }
        if (!masked.secret) continue;
        db.prepare('UPDATE contacts SET address = ?, config_json = ? WHERE id = ?').run(masked.display, JSON.stringify({ ...raw, url_enc: ctx.crypto.encrypt(masked.secret) }), row.id);
        db.prepare('UPDATE contact_deliveries SET address = ? WHERE contact_id = ? AND address = ?').run(masked.display, row.id, row.address);
      }
    });
    tx();
  }
  try { migrateSecretAddresses(); } catch (err) { logger.warn({ err }, 'could not convert stored webhook URLs to encrypted form'); }

  function matches(row, { event, severity }) {
    if (!row.enabled) return false;
    const events = json.parse(row.events_json, []);
    if (!events.includes('*') && !events.includes(event)) return false;
    return severityRank(severity) >= severityRank(row.min_severity || 'info');
  }

  function recordDelivery(entry) {
    stmts.insertDelivery.run({ contact_id: null, contact_name: null, transport: null, error: null, test: 0, ...entry });
    if (entry.contact_id) { if (entry.status === 'sent') stmts.markSent.run(entry.contact_id); else stmts.markFailed.run(entry.error, entry.contact_id); }
  }

  // ------------------------------------------------------------- transports ---

  function smtpConfig() {
    const host = setting('contacts.smtp.host', '');
    let password = '';
    const enc = setting('contacts.smtp.password_enc', '');
    if (enc) { try { password = ctx.crypto.decrypt(enc); } catch { password = ''; } }
    return {
      host, port: Number(setting('contacts.smtp.port', 587)) || 587, security: setting('contacts.smtp.security', 'starttls'),
      username: setting('contacts.smtp.username', ''), password, allowSelfSigned: Boolean(settings.get('contacts.smtp.allow_self_signed')), prefer: Boolean(settings.get('contacts.smtp.prefer')),
      allowPlaintextAuth: Boolean(settings.get('contacts.smtp.allow_plaintext_auth')),
    };
  }

  // A bare (undotted) hostname cannot carry mail, so the fallback sender gets a
  // .localdomain suffix rather than failing every notification.
  function fromAddress() {
    const host = hostname();
    const from = setting('contacts.from_address', '') || setting('mail.notification_from', '') || `whm@${FQDN_RE.test(host) ? host : `${host}.localdomain`}`;
    if (!EMAIL_RE.test(from)) throw unprocessable(`"${from}" is not a usable sender address: set a From address in Contact Manager or a fully-qualified hostname in Basic WebHost Manager Setup`, { from: ['Must be a full email address with a dotted domain'] });
    return from;
  }

  function mailTransport() {
    const smtp = smtpConfig();
    const exim = capabilities.has('exim');
    if (smtp.host && (smtp.prefer || !exim)) return 'smtp';
    if (exim) return 'exim';
    return null;
  }

  async function sendMail({ to, subject, body, text, from, headers }, req) {
    const recipients = (Array.isArray(to) ? to : [to]).map((r) => String(r).trim());
    const bad = recipients.find((r) => !EMAIL_RE.test(r));
    if (bad) throw unprocessable(`"${bad}" is not a usable recipient address`, { to: ['Must be a full email address'] });
    const sender = from && EMAIL_RE.test(from) ? from : fromAddress();
    const cleanSubject = String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 998) || '(no subject)';
    const content = String(body ?? text ?? '');
    const transport = mailTransport();
    if (!transport) throw new CapabilityError('exim', 'Exim is not installed and no SMTP relay is configured, so the panel cannot send email. Install exim4 (Debian/Ubuntu) or exim (RHEL), or configure an SMTP relay in Contact Manager.');
    let result;
    if (transport === 'exim') {
      result = await agent.op('mail.sendmail', { from: sender, to: recipients, subject: cleanSubject, text: content, ...(headers ? { headers } : {}) }, { req });
    } else {
      const smtp = smtpConfig();
      try {
        result = await sendSmtp({ ...smtp, rejectUnauthorized: !smtp.allowSelfSigned, allowPlaintextAuth: smtp.allowPlaintextAuth, from: sender, to: recipients, message: buildMessage({ from: sender, to: recipients, subject: cleanSubject, text: content, headers }), clientName: hostname() });
      } catch (err) {
        if (err instanceof SmtpError) throw new HttpError(err.code === 'plaintext_auth_refused' ? 422 : 502, err.code === 'plaintext_auth_refused' ? 'plaintext_auth_refused' : 'smtp_failed', `SMTP relay ${smtp.host}:${smtp.port}: ${err.message}`);
        throw err;
      }
    }
    audit(req, { action: 'contacts.mail.send', target: recipients.join(','), args: { subject: cleanSubject, transport } });
    return { transport, from: sender, to: recipients, accepted: true, ...(transport === 'smtp' ? { response: result.response, tls: result.tls } : {}) };
  }

  async function postJson(url, payload, { headers = {}, timeoutMs = 10_000 } = {}) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'WHM-panel-notifier/1.0', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    } catch (err) {
      throw new HttpError(502, 'delivery_failed', `${new URL(url).host}: ${err.cause?.message || err.message}`);
    }
    // The response body is not kept: it is foreign content and would land in
    // the delivery log verbatim.
    await res.text().catch(() => '');
    if (!res.ok) throw new HttpError(502, 'delivery_failed', `${new URL(url).host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    return { status: res.status };
  }

  async function deliver(row, msg, { req = null, test = false } = {}) {
    const config = decryptConfig(row);
    const base = { contact_id: row.id, contact_name: row.name || row.address, channel: row.channel, address: row.address, event: msg.event, severity: msg.severity, subject: msg.subject, test: test ? 1 : 0 };
    const host = hostname();
    const footer = `\n\n-- \nWHM on ${host} · event ${msg.event} · severity ${msg.severity}`;
    try {
      let transport = row.channel;
      if (row.channel === 'email') {
        const r = await sendMail({ to: row.address, subject: `[${host}] ${msg.subject}`, body: `${msg.body}${footer}` }, req);
        transport = r.transport;
      } else if (row.channel === 'sms') {
        const r = await sendMail({ to: row.address, subject: msg.subject.slice(0, 60), body: `${msg.severity.toUpperCase()} ${host}: ${msg.subject} — ${msg.body}`.slice(0, 300) }, req);
        transport = `sms-gateway/${r.transport}`;
      } else if (row.channel === 'webhook') {
        const payload = { event: msg.event, severity: msg.severity, subject: msg.subject, body: msg.body, data: msg.data, hostname: host, test, sentAt: new Date().toISOString() };
        const headers = { 'X-WHM-Event': msg.event };
        if (config.secret) headers['X-WHM-Signature'] = `sha256=${crypto.createHmac('sha256', config.secret).update(JSON.stringify(payload)).digest('hex')}`;
        const url = targetUrl(row, config);
        await assertWebhookTarget(url);
        await postJson(url, payload, { headers });
      } else if (row.channel === 'slack') {
        const icon = { info: ':information_source:', warning: ':warning:', error: ':x:', critical: ':rotating_light:' }[msg.severity];
        const text = `${icon} *${msg.subject}*${test ? ' _(test)_' : ''}\n${msg.body.slice(0, 2900)}\n_${host} · ${msg.event}_`;
        await postJson(targetUrl(row, config), { text, ...(config.channelName ? { channel: config.channelName } : {}) });
      } else if (row.channel === 'pushover') {
        if (!config.token) throw new HttpError(422, 'validation_failed', 'The Pushover application token is missing');
        const priority = { info: -1, warning: 0, error: 1, critical: 1 }[msg.severity] ?? 0;
        await postJson('https://api.pushover.net/1/messages.json', { token: config.token, user: row.address, title: `[${host}] ${msg.subject}`.slice(0, 250), message: msg.body.slice(0, 1024), priority, timestamp: Math.floor(Date.now() / 1000) });
      } else {
        throw new HttpError(422, 'validation_failed', `Unknown channel "${row.channel}"`);
      }
      recordDelivery({ ...base, status: 'sent', transport });
      return { contactId: row.id, name: base.contact_name, channel: row.channel, address: row.address, status: 'sent', transport };
    } catch (err) {
      const error = String(err.message || err).slice(0, 500);
      recordDelivery({ ...base, status: 'failed', error });
      logger.warn({ contact: row.id, channel: row.channel, event: msg.event, err: error }, 'contact notification failed');
      return { contactId: row.id, name: base.contact_name, channel: row.channel, address: row.address, status: 'failed', error, code: err.code || 'delivery_failed', httpStatus: err.status || 502 };
    }
  }

  // The domain Exim treats as its own ("@" in local_domains) so a message to
  // root@<it> is expanded by /etc/aliases instead of being routed to DNS.
  // Cached briefly; the panel hostname is the first candidate because the
  // Basic Setup page tells admins to make it the FQDN.
  let primaryHostCache = { at: 0, value: null };
  async function eximPrimaryHostname() {
    if (!capabilities.has('exim')) return null;
    if (Date.now() - primaryHostCache.at < 10 * 60_000) return primaryHostCache.value;
    let value = null;
    try { const r = await agent.op('contacts.exim.primary_hostname'); value = r?.hostname && FQDN_RE.test(r.hostname) ? r.hostname : null; } catch { value = null; }
    primaryHostCache = { at: Date.now(), value };
    return value;
  }

  async function localRootAddress() {
    const host = hostname();
    if (FQDN_RE.test(host)) return `root@${host}`;
    const exim = await eximPrimaryHostname();
    if (exim) return `root@${exim}`;
    const node = String(os.hostname() || '').toLowerCase();
    if (FQDN_RE.test(node)) return `root@${node}`;
    return `root@${host}.localdomain`;
  }

  // With Exim on this host, root@<fqdn> is expanded by /etc/aliases. An SMTP
  // relay knows nothing about that file, so the forwarding targets saved from
  // Edit System Mail Preferences are addressed directly; a local account name
  // has no mailbox the relay could reach and is skipped.
  async function rootRecipients() {
    const transport = mailTransport();
    const rootAddress = await localRootAddress();
    if (transport !== 'smtp') {
      return { transport, rootAddress, to: transport ? [rootAddress] : [], skipped: [], error: transport ? null : 'Exim is not installed and no SMTP relay is configured, so mail for root cannot be sent.' };
    }
    const targets = (settings.get('contacts.root_forward', []) || []).map((t) => String(t).trim()).filter(Boolean);
    const to = targets.filter((t) => EMAIL_RE.test(t));
    const skipped = targets.filter((t) => !EMAIL_RE.test(t));
    let error = null;
    if (!to.length) {
      error = skipped.length
        ? `Mail for root leaves through the SMTP relay, which cannot deliver to the local account${skipped.length > 1 ? 's' : ''} ${skipped.join(', ')}. Add a full email address under Edit System Mail Preferences.`
        : 'Mail for root leaves through the SMTP relay and is sent to the forwarding addresses saved under Edit System Mail Preferences, but none are set.';
    }
    return { transport, rootAddress, to, skipped, error };
  }

  // Root's mailbox for the events the system mail preferences select. Logged
  // as a delivery with no contact.
  async function mailRoot(msg, req, { test = false } = {}) {
    const host = hostname();
    const r = await rootRecipients();
    const address = r.to.length ? r.to.join(', ') : r.rootAddress;
    const base = { contact_name: 'root (system mail)', channel: 'email', address, event: msg.event, severity: msg.severity, subject: msg.subject, test: test ? 1 : 0 };
    try {
      if (r.error) throw new HttpError(422, 'no_root_recipients', r.error);
      const sent = await sendMail({ to: r.to, subject: `[${host}] ${msg.subject}`, body: `${msg.body}\n\n-- \nWHM on ${host} · event ${msg.event} · severity ${msg.severity}` }, req);
      recordDelivery({ ...base, status: 'sent', transport: sent.transport });
      return { contactId: null, name: base.contact_name, channel: 'email', address, status: 'sent', transport: sent.transport, to: r.to };
    } catch (err) {
      const error = String(err.message || err).slice(0, 500);
      recordDelivery({ ...base, status: 'failed', error });
      logger.warn({ event: msg.event, transport: r.transport, err: error }, 'root mail notification failed');
      return { contactId: null, name: base.contact_name, channel: 'email', address, status: 'failed', error, code: err.code || 'delivery_failed', httpStatus: err.status || 502, to: r.to };
    }
  }

  async function notify(eventOrMessage, payload, req = null) {
    const msg = normalizeNotification(eventOrMessage, payload);
    if (!settings.get('contacts.enabled', true)) return { ...msg, body: undefined, data: undefined, matched: 0, sent: 0, failed: 0, skipped: 'disabled', deliveries: [] };
    const rows = stmts.enabled.all().filter((row) => matches(row, msg));
    const deliveries = [];
    for (const row of rows) deliveries.push(await deliver(row, msg, { req }));
    // Root mail with no transport, or over a relay with no forwarding address
    // saved, is a configuration state the Mail Preferences page reports once;
    // it is not logged as a failed delivery on every event.
    let rootMail = null;
    const rootEvents = settings.get('contacts.root_mail_events', []) || [];
    if (rootEvents.includes(msg.event)) {
      const r = mailTransport() ? await rootRecipients() : { error: 'no mail transport' };
      if (r.error) rootMail = { skipped: true, reason: r.error };
      else deliveries.push(await mailRoot(msg, req));
    }
    stmts.pruneDeliveries.run(`-${Number(setting('contacts.retention_days', 90)) || 90} days`);
    const sent = deliveries.filter((d) => d.status === 'sent').length;
    return { event: msg.event, severity: msg.severity, subject: msg.subject, matched: rows.length, sent, failed: deliveries.length - sent, deliveries, ...(rootMail ? { rootMail } : {}) };
  }

  // -------------------------------------------------------- scheduled check ---

  function cooldownOver(row, minutes) {
    if (!row?.last_notified_at) return true;
    return Date.now() - new Date(`${row.last_notified_at.replace(' ', 'T')}Z`).getTime() >= minutes * 60_000;
  }

  // Service down / disk space / certificate expiry: each condition notifies
  // when it appears, again after the cooldown while it persists, and once more
  // (service only) when it clears.
  async function runChecks({ log = () => {}, req = null } = {}) {
    const cfg = checkConfig();
    const result = { services: { checked: 0, down: [], restored: [] }, disks: { checked: 0, low: [] }, ssl: { expiring: [] }, notifications: [] };
    const fire = async (event, subject, body, severity) => { const r = await notify({ event, subject, body, severity }, undefined, req); result.notifications.push({ event, subject, sent: r.sent, failed: r.failed }); log(`${event}: ${subject} → ${r.sent} sent${r.failed ? `, ${r.failed} failed` : ''}`); return r; };
    const host = hostname();

    if (ctx.serviceManager?.list) {
      try {
        const services = await ctx.serviceManager.list();
        const seen = new Set();
        for (const s of services) {
          if (!s.monitored || !s.installed || !s.unit) continue;
          result.services.checked++;
          const key = `service:${s.name}`;
          seen.add(key);
          const state = stmts.alertState.get(key);
          if (!s.active) {
            result.services.down.push(s.name);
            if (!state || cooldownOver(state, cfg.cooldownMinutes)) {
              await fire('service.down', `${s.displayName} is down on ${host}`, `${s.displayName} (unit ${s.unit}) is ${s.state}${s.subState ? `/${s.subState}` : ''}${s.restarts ? ` after ${s.restarts} restart(s)` : ''}.${s.error ? `\n${s.error}` : ''}\nOpen Service Manager to start it or enable automatic restart.`, 'error');
              stmts.upsertAlert.run({ key, state: 'down', detail: s.state, last_notified_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
            }
          } else if (state) {
            result.services.restored.push(s.name);
            stmts.clearAlert.run(key);
            await fire('service.restored', `${s.displayName} is running again on ${host}`, `${s.displayName} (unit ${s.unit}) was down since ${state.since} UTC and is active again.`, 'info');
          }
        }
        for (const row of stmts.alertStates.all()) if (row.key.startsWith('service:') && !seen.has(row.key)) stmts.clearAlert.run(row.key);
      } catch (err) { log(`service check skipped: ${err.message}`, 'warn'); result.services.error = err.message; }
    }

    try {
      const disks = await agent.op('sys.disk.usage');
      const seen = new Set();
      for (const d of disks) {
        if (!d.mountpoint || !Number.isFinite(d.usedPercent)) continue;
        result.disks.checked++;
        const key = `disk:${d.mountpoint}`;
        if (d.usedPercent >= cfg.diskThresholdPercent) {
          seen.add(key);
          result.disks.low.push({ mountpoint: d.mountpoint, usedPercent: d.usedPercent });
          const state = stmts.alertState.get(key);
          if (!state || cooldownOver(state, cfg.cooldownMinutes)) {
            const gb = (n) => (n / 1024 ** 3).toFixed(1);
            await fire('disk.space.low', `${d.mountpoint} is ${d.usedPercent}% full on ${host}`, `${d.filesystem} mounted on ${d.mountpoint}: ${gb(d.usedBytes)} GB of ${gb(d.sizeBytes)} GB used, ${gb(d.availableBytes)} GB free (threshold ${cfg.diskThresholdPercent}%).`, d.usedPercent >= 97 ? 'error' : 'warning');
            stmts.upsertAlert.run({ key, state: 'low', detail: String(d.usedPercent), last_notified_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
          }
        }
      }
      for (const row of stmts.alertStates.all()) if (row.key.startsWith('disk:') && !seen.has(row.key)) stmts.clearAlert.run(row.key);
    } catch (err) { log(`disk check skipped: ${err.message}`, 'warn'); result.disks.error = err.message; }

    try {
      const certs = stmts.expiringCerts.all({ until: `+${cfg.sslDays} days` });
      const keyOf = (c) => (c.kind === 'service' ? `ssl:service:${c.domain}` : `ssl:${c.domain}`);
      for (const c of certs) {
        const key = keyOf(c);
        const days = Math.floor((new Date(`${c.not_after.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(c.not_after) ? '' : 'Z'}`).getTime() - Date.now()) / 86_400_000);
        const what = c.kind === 'service' ? `the ${c.domain} service certificate` : `the certificate for ${c.domain}`;
        result.ssl.expiring.push({ domain: c.domain, kind: c.kind, notAfter: c.not_after, daysRemaining: days });
        const state = stmts.alertState.get(key);
        if (!state || cooldownOver(state, Math.max(cfg.cooldownMinutes, 1440))) {
          const where = c.kind === 'service' ? 'Manage Service SSL Certificates' : 'SSL/TLS (AutoSSL or Install an SSL Certificate)';
          await fire('ssl.expiring', `${what[0].toUpperCase()}${what.slice(1)} ${days < 0 ? 'has expired' : `expires in ${days} day(s)`}`, `${what[0].toUpperCase()}${what.slice(1)} on ${host} is valid until ${c.not_after}. Renew it from ${where}.`, days <= 3 ? 'error' : 'warning');
          stmts.upsertAlert.run({ key, state: 'expiring', detail: c.not_after, last_notified_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
        }
      }
      const current = new Set(certs.map(keyOf));
      for (const row of stmts.alertStates.all()) if (row.key.startsWith('ssl:') && !current.has(row.key)) stmts.clearAlert.run(row.key);
    } catch (err) { log(`certificate check skipped: ${err.message}`, 'warn'); result.ssl.error = err.message; }

    settings.set('contacts.check.last_run_at', new Date().toISOString());
    settings.set('contacts.check.last_result', { services: result.services, disks: result.disks, ssl: result.ssl, notifications: result.notifications.length });
    return result;
  }

  function checkConfig() {
    return {
      enabled: Boolean(settings.get('contacts.check.enabled', true)),
      diskThresholdPercent: Number(setting('contacts.check.disk_threshold_percent', 90)) || 90,
      cooldownMinutes: Number(setting('contacts.check.cooldown_minutes', 360)) || 360,
      sslDays: Number(setting('contacts.check.ssl_days', 14)) || 14,
      lastRunAt: settings.get('contacts.check.last_run_at', null),
      lastResult: settings.get('contacts.check.last_result', null),
    };
  }

  function notificationSettings() {
    const smtp = smtpConfig();
    return {
      enabled: Boolean(settings.get('contacts.enabled', true)),
      fromAddress: setting('contacts.from_address', ''),
      effectiveFrom: (() => { try { return fromAddress(); } catch { return null; } })(),
      retentionDays: Number(setting('contacts.retention_days', 90)) || 90,
      smtp: { host: smtp.host, port: smtp.port, security: smtp.security, username: smtp.username, password: { set: Boolean(smtp.password) }, allowSelfSigned: smtp.allowSelfSigned, prefer: smtp.prefer, allowPlaintextAuth: smtp.allowPlaintextAuth },
      webhook: { allowPrivate: Boolean(settings.get('contacts.webhook.allow_private', false)) },
      check: checkConfig(),
    };
  }

  function syncSchedule(enabled) {
    try { ctx.scheduler.update(SCHEDULE, { enabled }); } catch (err) { logger.warn({ err }, 'could not toggle the server contacts check schedule'); }
  }

  async function mailPreferences() {
    await capabilities.ensureFresh();
    let aliases = null;
    let aliasError = null;
    try { aliases = await agent.op('contacts.aliases.read'); } catch (err) { aliasError = { code: err.code, message: err.message }; }
    const host = hostname();
    const savedFor = (user) => settings.get(`contacts.${user}_forward`, []) || [];
    const fromAliases = (user) => (aliases ? (aliases.users?.[user] ?? (user === 'root' ? aliases.root : savedFor(user))) : savedFor(user));
    return {
      hostname: host,
      rootAddress: await localRootAddress(),
      forwardTo: fromAliases('root'),
      users: Object.fromEntries(MANAGED_MAIL_USERS.map((u) => [u, fromAliases(u)])),
      managedUsers: MANAGED_MAIL_USERS,
      aliases: aliases && { path: aliases.path, exists: aliases.exists, managed: aliases.managed, rebuildTool: aliases.rebuildTool, entries: aliases.entries },
      aliasError,
      rootMailEvents: settings.get('contacts.root_mail_events', []) || [],
      rootDelivery: await rootRecipients(),
      events: EVENTS.filter((e) => e.key !== 'test'),
      capability: { exim: capabilities.has('exim'), mailTransport: mailTransport() },
    };
  }

  return {
    SCHEDULE, JOB, EVENTS, SEVERITIES, CHANNELS,
    normalize: normalizeNotification,

    async overview() {
      await capabilities.ensureFresh();
      const stats = stmts.deliveryStats.get();
      const schedule = ctx.scheduler.list().find((s) => s.name === SCHEDULE) || null;
      return {
        contacts: stmts.all.all().map(shape),
        events: EVENTS, severities: SEVERITIES, channels: CHANNELS, smtpSecurity: SMTP_SECURITY,
        settings: notificationSettings(),
        capability: { exim: capabilities.has('exim'), smtp: Boolean(smtpConfig().host), mailTransport: mailTransport(), hostname: hostname() },
        schedule: schedule && { name: schedule.name, cron: schedule.cron, enabled: Boolean(schedule.enabled), lastRunAt: schedule.last_run_at, nextRunAt: schedule.next_run_at },
        stats: { total: stats.total || 0, last24h: stats.last24h || 0, failed: stats.failed || 0 },
        openAlerts: stmts.alertStates.all(),
        recentDeliveries: stmts.recentDeliveries.all(20),
      };
    },

    events: () => EVENTS,
    list: () => stmts.all.all().map(shape),
    get: (id) => shape(load(id)),

    async create(input, req) {
      const address = input.address;
      redactRequestAddress(req, input.channel, address);
      const events = normalizeEvents(input.events);
      const { display, config } = await resolveAddress(input.channel, address, mergeConfig(input.channel, input.config || {}));
      const { lastInsertRowid } = stmts.insert.run({ name: input.name?.trim() || '', channel: input.channel, address: display, events: JSON.stringify(events), enabled: input.enabled === false ? 0 : 1, config: JSON.stringify(config), min_severity: input.minSeverity || 'info' });
      audit(req, { action: 'contacts.create', target: display, args: { channel: input.channel, name: input.name, events, minSeverity: input.minSeverity || 'info' } });
      return shape(stmts.byId.get(lastInsertRowid));
    },

    async update(id, patch, req) {
      const row = load(id);
      const channel = patch.channel ?? row.channel;
      const address = patch.address ?? row.address;
      if (patch.address !== undefined) redactRequestAddress(req, channel, address);
      const events = patch.events !== undefined ? normalizeEvents(patch.events) : json.parse(row.events_json, ['*']);
      const { display, config } = await resolveAddress(channel, address, mergeConfig(channel, patch.config || {}, channel === row.channel ? json.parse(row.config_json, {}) : {}), row);
      stmts.update.run({ id: row.id, name: patch.name !== undefined ? patch.name.trim() : row.name, channel, address: display, events: JSON.stringify(events), enabled: (patch.enabled ?? Boolean(row.enabled)) ? 1 : 0, config: JSON.stringify(config), min_severity: patch.minSeverity ?? row.min_severity ?? 'info' });
      audit(req, { action: 'contacts.update', target: display, args: { ...patch, address: patch.address !== undefined ? display : undefined, config: patch.config ? Object.keys(patch.config) : undefined } });
      return shape(stmts.byId.get(id));
    },

    remove(id, req) {
      const row = load(id);
      stmts.remove.run(id);
      audit(req, { action: 'contacts.remove', target: row.address, args: { channel: row.channel, name: row.name } });
      return { removed: true, id: row.id, address: row.address };
    },

    // A test message to one contact; failure surfaces with the transport's status
    // (501 when no mail transport exists) so the page can explain it.
    async test(id, req) {
      const row = load(id);
      const msg = normalizeNotification({ event: 'test', subject: `Test notification from WHM on ${hostname()}`, body: `This is a test message for the ${row.channel} contact "${row.name || row.address}" sent by ${req?.user?.username || 'the panel'} at ${new Date().toISOString()}. If you can read this, the channel works.`, severity: 'info' });
      const result = await deliver(row, msg, { req, test: true });
      audit(req, { action: 'contacts.test', target: row.address, args: { channel: row.channel, status: result.status, error: result.error } });
      if (result.status === 'failed') {
        if (result.code === 'capability_missing') throw new CapabilityError('exim', result.error);
        throw new HttpError(result.httpStatus === 422 ? 422 : 502, ['smtp_failed', 'private_target', 'plaintext_auth_refused'].includes(result.code) ? result.code : 'delivery_failed', result.error);
      }
      return result;
    },

    notify,
    // Other categories probe ctx.contacts.sendMail to decide whether the panel
    // can send mail at all, so it is only present while a transport exists;
    // mail() is the same function, always there, and raises CapabilityError.
    get sendMail() { return mailTransport() ? sendMail : undefined; },
    mail: sendMail,
    mailTransport,

    deliveries(query) {
      const where = [];
      const params = {};
      if (query.q) { where.push('(subject LIKE @q OR address LIKE @q OR contact_name LIKE @q OR event LIKE @q OR error LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.event) { where.push('event = @event'); params.event = query.event; }
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.contactId) { where.push('contact_id = @contactId'); params.contactId = query.contactId; }
      return paginate(db, {
        select: '*', from: 'contact_deliveries', where, params,
        sortable: { ts: 'ts', event: 'event', channel: 'channel', status: 'status', severity: 'severity', address: 'address' },
        defaultSort: 'ts', query: { ...query, dir: query.dir || (query.sort ? 'asc' : 'desc') },
      });
    },

    settings: notificationSettings,

    updateSettings(patch, req) {
      const values = {};
      if (patch.enabled !== undefined) values['contacts.enabled'] = Boolean(patch.enabled);
      if (patch.fromAddress !== undefined) values['contacts.from_address'] = patch.fromAddress || '';
      if (patch.retentionDays !== undefined) values['contacts.retention_days'] = patch.retentionDays;
      if (patch.smtp) {
        const s = patch.smtp;
        if (s.host !== undefined) values['contacts.smtp.host'] = s.host || '';
        if (s.port !== undefined) values['contacts.smtp.port'] = s.port;
        if (s.security !== undefined) values['contacts.smtp.security'] = s.security;
        if (s.username !== undefined) values['contacts.smtp.username'] = s.username || '';
        if (s.password !== undefined) values['contacts.smtp.password_enc'] = s.password ? ctx.crypto.encrypt(s.password) : '';
        if (s.allowSelfSigned !== undefined) values['contacts.smtp.allow_self_signed'] = Boolean(s.allowSelfSigned);
        if (s.prefer !== undefined) values['contacts.smtp.prefer'] = Boolean(s.prefer);
        if (s.allowPlaintextAuth !== undefined) values['contacts.smtp.allow_plaintext_auth'] = Boolean(s.allowPlaintextAuth);
      }
      if (patch.webhook?.allowPrivate !== undefined) values['contacts.webhook.allow_private'] = Boolean(patch.webhook.allowPrivate);
      if (patch.check) {
        const c = patch.check;
        if (c.enabled !== undefined) values['contacts.check.enabled'] = Boolean(c.enabled);
        if (c.diskThresholdPercent !== undefined) values['contacts.check.disk_threshold_percent'] = c.diskThresholdPercent;
        if (c.cooldownMinutes !== undefined) values['contacts.check.cooldown_minutes'] = c.cooldownMinutes;
        if (c.sslDays !== undefined) values['contacts.check.ssl_days'] = c.sslDays;
      }
      const before = checkConfig().enabled;
      settings.setMany(values);
      if (patch.check?.enabled !== undefined && before !== Boolean(patch.check.enabled)) syncSchedule(Boolean(patch.check.enabled));
      audit(req, { action: 'contacts.settings', args: { ...patch, smtp: patch.smtp ? { ...patch.smtp, password: patch.smtp.password ? '[set]' : undefined } : undefined } });
      return notificationSettings();
    },

    // Relay check without a contact: a message to the given address.
    async sendTest(to, req) {
      const r = await sendMail({ to, subject: `Test message from WHM on ${hostname()}`, body: `This test message was sent by ${req?.user?.username || 'the panel'} at ${new Date().toISOString()} through the ${mailTransport() || 'configured'} transport.` }, req);
      audit(req, { action: 'contacts.mail.test', target: to, args: { transport: r.transport } });
      return r;
    },

    checkConfig,
    runChecks,

    // ------------------------------------------ Edit System Mail Preferences ---

    mailPreferences,

    // forwardTo is root's list; users.<name> covers every managed system user
    // (root again, or nobody). Host first, then the saved copy.
    async setMailPreferences({ forwardTo, users, rootMailEvents }, req) {
      let aliases = null;
      const lists = { ...(users || {}) };
      if (forwardTo !== undefined) lists.root = forwardTo;
      for (const user of MANAGED_MAIL_USERS) {
        if (lists[user] === undefined) continue;
        const targets = [...new Set(lists[user].map((t) => t.trim()).filter(Boolean))];
        aliases = user === 'root' ? await agent.op('contacts.aliases.set_root', { targets }, { req }) : await agent.op('contacts.aliases.set', { user, targets }, { req });
        settings.set(`contacts.${user}_forward`, targets);
      }
      if (rootMailEvents !== undefined) settings.set('contacts.root_mail_events', [...new Set(rootMailEvents)]);
      audit(req, { action: 'contacts.mail_preferences', target: Object.keys(lists).join(',') || 'root', args: { forwardTo, users, rootMailEvents, rebuild: aliases?.rebuild ?? null } });
      return { ...(await mailPreferences()), rebuild: aliases?.rebuild ?? null };
    },

    // The exact path the "events that also mail root" use, so the page shows
    // where root mail really ends up with the current transport.
    async testRootMail(req) {
      if (!mailTransport()) throw new CapabilityError('exim', 'Exim is not installed and no SMTP relay is configured, so the panel cannot send email. Install exim4 (Debian/Ubuntu) or exim (RHEL), or configure an SMTP relay in Contact Manager.');
      const msg = normalizeNotification({ event: 'test', subject: `Test message for root from WHM on ${hostname()}`, body: `This test message was sent by ${req?.user?.username || 'the panel'} at ${new Date().toISOString()} the way events selected under Edit System Mail Preferences are mailed to root.`, severity: 'info' });
      const result = await mailRoot(msg, req, { test: true });
      audit(req, { action: 'contacts.mail.test', target: result.address, args: { transport: result.transport ?? mailTransport(), status: result.status, error: result.error } });
      if (result.status === 'failed') {
        if (result.code === 'capability_missing') throw new CapabilityError('exim', result.error);
        throw new HttpError(result.httpStatus === 422 ? 422 : 502, ['smtp_failed', 'no_root_recipients', 'plaintext_auth_refused'].includes(result.code) ? result.code : 'delivery_failed', result.error);
      }
      return result;
    },
  };
}
