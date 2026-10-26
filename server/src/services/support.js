import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { json, paginate } from '../db/index.js';
import { notFound, unprocessable, conflict, CapabilityError, HttpError } from '../lib/errors.js';
import { redact } from '../middleware/audit.js';
import { REPO_ROOT } from '../lib/plugin-sdk.js';

// Support category: tickets with a redacted system snapshot, time-boxed support
// access (an SSH key authorized for root plus an API token, both removed when the
// grant ends) and the Support Center hub. Attached as ctx.support.

export const TICKET_CATEGORIES = ['general', 'accounts', 'email', 'dns', 'databases', 'web', 'ssl', 'security', 'backups', 'performance', 'licensing', 'other'];
export const TICKET_SEVERITIES = ['low', 'normal', 'high', 'critical'];
export const TICKET_STATUSES = ['open', 'closed'];
// 'cleanup_pending': the time box ended but the root key is still on the host;
// the expiry job keeps retrying until sec.ssh_keys.remove succeeds.
export const GRANT_STATUSES = ['active', 'cleanup_pending', 'expired', 'revoked'];
export const JOB_EXPIRE = 'support.expire_access';
export const SCHEDULE_EXPIRE = 'support-access-expiry';

export const SUPPORT_LINKS = [
  { key: 'docs', label: 'cPanel & WHM documentation', url: 'https://docs.cpanel.net/', description: 'Reference documentation for every WHM and cPanel interface.' },
  { key: 'forums', label: 'cPanel community forums', url: 'https://forums.cpanel.net/', description: 'Community help from other administrators.' },
  { key: 'support', label: 'Open a ticket with cPanel Support', url: 'https://support.cpanel.net/', description: 'Direct support for licensed servers.' },
  { key: 'status', label: 'cPanel service status', url: 'https://status.cpanel.net/', description: 'Outages affecting licensing, mirrors and updates.' },
  { key: 'security', label: 'Security advisories', url: 'https://news.cpanel.com/category/security/', description: 'Announcements about vulnerabilities and patches.' },
  { key: 'api', label: 'API documentation', url: 'https://api.docs.cpanel.net/', description: 'WHM API 1, UAPI and cPanel API 2 references.' },
];

const DOCS = [
  { slug: 'readme', title: 'README', file: 'README.md', summary: 'Installing, running and operating this panel.' },
  { slug: 'blueprint', title: 'Blueprint (design of record)', file: 'BLUEPRINT.md', summary: 'Architecture, data model, security model and the specification of every function.' },
];
const DOC_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const EMAIL_RE = /^[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

export function indexSections(text) {
  const sections = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = line.match(/^(##|###)\s+(.+?)\s*$/);
    if (!m) return;
    const title = m[2].replace(/[*`]/g, '');
    sections.push({ level: m[1].length, title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), line: i + 1 });
  });
  return sections;
}

export function extractSection(text, slug) {
  const sections = indexSections(text);
  const idx = sections.findIndex((s) => s.slug === slug);
  if (idx < 0) return null;
  const next = sections.slice(idx + 1).find((s) => s.level <= sections[idx].level);
  const lines = text.split('\n');
  return `${lines.slice(sections[idx].line - 1, next ? next.line - 1 : lines.length).join('\n').trim()}\n`;
}

// ------------------------------------------------------------- SSH key pair ---

const sshString = (buf) => { const len = Buffer.alloc(4); len.writeUInt32BE(buf.length); return Buffer.concat([len, buf]); };
const sshUint32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

export function sshFingerprint(blob) {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

// ed25519 key pair in the formats OpenSSH reads: an authorized_keys line and an
// unencrypted "openssh-key-v1" private key. Generated in-process so the private
// half is handed to the admin exactly once and never written to the host.
export function generateSshKeyPair(comment = '') {
  if (!/^[^\s\0]{0,128}$/.test(comment)) throw unprocessable('Key comment may not contain whitespace');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([sshString(type), sshString(pub)]);
  const check = crypto.randomBytes(4);
  let section = Buffer.concat([check, check, sshString(type), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(Buffer.from(comment))]);
  for (let i = 1; section.length % 8; i++) section = Buffer.concat([section, Buffer.from([i])]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), sshString(Buffer.from('none')), sshString(Buffer.from('none')), sshString(Buffer.alloc(0)), sshUint32(1), sshString(blob), sshString(section)]);
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return { type: 'ssh-ed25519', publicKey: `ssh-ed25519 ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`, privateKey: pem, fingerprint: sshFingerprint(blob) };
}

export function parseOpenSshPrivateKey(pem) {
  const b64 = String(pem).replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  let off = 15;
  const readString = () => { const len = buf.readUInt32BE(off); off += 4; const s = buf.subarray(off, off + len); off += len; return s; };
  const cipher = readString().toString();
  const kdf = readString().toString();
  readString();
  const count = buf.readUInt32BE(off); off += 4;
  const publicBlob = readString();
  const section = readString();
  let p = 8;
  const readInner = () => { const len = section.readUInt32BE(p); p += 4; const s = section.subarray(p, p + len); p += len; return s; };
  const type = readInner().toString();
  const pub = readInner();
  const priv = readInner();
  const comment = readInner().toString();
  return { cipher, kdf, count, type, publicBlob, publicKey: pub, seed: priv.subarray(0, 32), comment };
}

export const utcStamp = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
// sshd's expiry-time="YYYYMMDDHHMMSS": the daemon itself refuses the key after
// the grant ends, whether or not the panel is alive to remove it. The stamp is
// in the host's local time zone with no 'Z' suffix because that is the only form
// every OpenSSH >= 7.7 parses; the UTC 'Z' form arrived in 9.1 and an older sshd
// drops the whole line as "bad key options". The panel and sshd share the host
// clock and /etc/localtime, so local time is unambiguous except for the hour a
// DST fall-back repeats, which the panel's own removal job covers.
export const SSHD_MIN_VERSION = '7.7';
export const sshExpiryTime = (value) => {
  const d = new Date(value);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
export const authorizedKeyLine = (publicKey, expiresAt) => `expiry-time="${sshExpiryTime(expiresAt)}" ${publicKey}`;
export const hostTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
const SNAPSHOT_MAX = 200_000;
const LIVE = "status IN ('active', 'cleanup_pending')";

export function createSupportService(ctx) {
  const { db, settings, agent, capabilities, logger } = ctx;
  const stmts = {
    ticketById: db.prepare('SELECT * FROM support_tickets WHERE id = ?'),
    insertTicket: db.prepare(`INSERT INTO support_tickets (reference, subject, category, severity, description, contact_email, snapshot_json, delivery_status, delivery_detail, sent_to, sent_at, created_by)
      VALUES (@reference, @subject, @category, @severity, @description, @contact_email, @snapshot_json, @delivery_status, @delivery_detail, @sent_to, @sent_at, @created_by)`),
    setDelivery: db.prepare("UPDATE support_tickets SET delivery_status = @status, delivery_detail = @detail, sent_to = @to, sent_at = @at, updated_at = datetime('now') WHERE id = @id"),
    setStatus: db.prepare("UPDATE support_tickets SET status = @status, closed_at = CASE WHEN @status = 'closed' THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = @id"),
    deleteTicket: db.prepare('DELETE FROM support_tickets WHERE id = ?'),
    openTickets: db.prepare("SELECT id, reference, subject, severity, category, created_at FROM support_tickets WHERE status = 'open' ORDER BY created_at DESC LIMIT 20"),
    ticketCounts: db.prepare("SELECT SUM(status = 'open') AS open, SUM(status = 'closed') AS closed, COUNT(*) AS total FROM support_tickets"),
    grantById: db.prepare('SELECT * FROM support_access_grants WHERE id = ?'),
    insertGrant: db.prepare(`INSERT INTO support_access_grants (label, ssh_fingerprint, ssh_key_type, ssh_comment, ssh_expiry, api_token_id, api_token_prefix, granted_by, granted_ip, note, expires_at)
      VALUES (@label, @ssh_fingerprint, @ssh_key_type, @ssh_comment, @ssh_expiry, @api_token_id, @api_token_prefix, @granted_by, @granted_ip, @note, @expires_at)`),
    finishGrant: db.prepare(`UPDATE support_access_grants SET status = @status, ended_at = COALESCE(ended_at, datetime('now')), ended_by = COALESCE(ended_by, @ended_by), cleanup_json = @cleanup WHERE id = @id AND ${LIVE}`),
    pendGrant: db.prepare(`UPDATE support_access_grants SET status = 'cleanup_pending', ended_at = COALESCE(ended_at, datetime('now')), ended_by = COALESCE(ended_by, @ended_by), cleanup_json = @cleanup WHERE id = @id AND ${LIVE}`),
    activeGrants: db.prepare("SELECT * FROM support_access_grants WHERE status = 'active' ORDER BY expires_at"),
    liveGrants: db.prepare(`SELECT * FROM support_access_grants WHERE ${LIVE} ORDER BY expires_at`),
    pendingGrants: db.prepare("SELECT * FROM support_access_grants WHERE status = 'cleanup_pending' ORDER BY expires_at"),
    dueGrants: db.prepare("SELECT * FROM support_access_grants WHERE (status = 'active' AND expires_at <= ?) OR status = 'cleanup_pending' ORDER BY expires_at"),
    grantCounts: db.prepare("SELECT SUM(status = 'active') AS active, SUM(status = 'cleanup_pending') AS cleanupPending, COUNT(*) AS total FROM support_access_grants"),
    failedJobs: db.prepare("SELECT id, type, status, error, error_code, created_at, finished_at FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 50"),
    recentAudit: db.prepare('SELECT ts, principal, role, action, target, result FROM audit_log ORDER BY id DESC LIMIT 200'),
    settingKeys: db.prepare('SELECT key, value FROM settings ORDER BY key'),
  };
  const SYSTEM_PRINCIPAL = { user: { id: null, username: 'scheduler', role: 'root' }, ip: null };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req || SYSTEM_PRINCIPAL, entry));

  // ---------------------------------------------------------------- settings ---

  function supportSettings() {
    return {
      email: settings.get('support.email') || '',
      providerName: settings.get('support.provider_name') || 'cPanel Support',
      portalUrl: settings.get('support.portal_url') || '',
      access: { defaultHours: Number(settings.get('support.access.default_hours')) || 24, maxHours: Number(settings.get('support.access.max_hours')) || 168 },
    };
  }

  // Validated as a whole before anything is written, then stored in one
  // transaction, so a rejected request never leaves a half-applied pair behind.
  function updateSettings(input, req) {
    const current = supportSettings();
    const next = { ...current, ...input, access: { ...current.access, ...(input.access || {}) } };
    if (next.access.defaultHours > next.access.maxHours) throw unprocessable('Request validation failed', { 'access.defaultHours': ['Must not exceed the maximum grant length'] });
    settings.setMany({
      'support.email': next.email, 'support.provider_name': next.providerName, 'support.portal_url': next.portalUrl,
      'support.access.default_hours': next.access.defaultHours, 'support.access.max_hours': next.access.maxHours,
    });
    audit(req, { action: 'support.settings.update', args: input });
    return supportSettings();
  }

  // ---------------------------------------------------------------- snapshot ---

  // What a ticket carries: enough to reason about the host (versions, load,
  // capacity, which daemons run) and nothing that identifies users, addresses
  // or credentials. Interface addresses and per-account data stay out.
  async function snapshot() {
    const status = await ctx.system.status();
    const s = status.server || {};
    const out = {
      takenAt: new Date().toISOString(),
      panel: status.panel,
      hostname: status.hostname,
      profile: status.profile?.name ?? null,
      os: s.os, kernel: s.os?.kernel, arch: s.os?.arch,
      uptimeSeconds: s.uptimeSeconds, loadAverage: s.loadAverage, cpu: s.cpu,
      memory: s.memory,
      disks: (s.disks || []).map((d) => ({ mountpoint: d.mountpoint, filesystem: d.filesystem, sizeBytes: d.sizeBytes, usedBytes: d.usedBytes, usedPercent: d.usedPercent })),
      counts: status.counts,
      capabilities: status.capabilities,
      services: (status.services || []).map((x) => ({ name: x.name, unit: x.unit ?? null, installed: x.installed, active: x.active, state: x.state })),
      jobs: { failedRecently: stmts.failedJobs.all().slice(0, 10).map((j) => ({ id: j.id, type: j.type, errorCode: j.error_code, finishedAt: j.finished_at })) },
    };
    return redact(out);
  }

  // ----------------------------------------------------------------- tickets ---

  function shapeTicket(row, { withSnapshot = false } = {}) {
    if (!row) return null;
    return {
      id: row.id, reference: row.reference, subject: row.subject, category: row.category, severity: row.severity, description: row.description,
      contactEmail: row.contact_email, status: row.status, delivery: { status: row.delivery_status, detail: row.delivery_detail, to: row.sent_to, at: row.sent_at },
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at,
      hasSnapshot: Boolean(row.snapshot_json),
      ...(withSnapshot ? { snapshot: json.parse(row.snapshot_json, null) } : {}),
    };
  }

  function loadTicket(id) {
    const row = stmts.ticketById.get(id);
    if (!row) throw notFound(`Support ticket ${id}`);
    return row;
  }

  function ticketReference() {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `WHM-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }

  function renderTicketMail(t, snap) {
    const lines = [
      `Support ticket ${t.reference}`, '',
      `Subject:   ${t.subject}`, `Severity:  ${t.severity}`, `Category:  ${t.category}`, `Opened by: ${t.created_by || 'root'}`, `Reply to:  ${t.contact_email || '(none given)'}`,
      `Host:      ${snap?.hostname || ctx.settings.get('basic.hostname') || '-'}`, '', 'Description', '-----------', t.description, '',
      'System snapshot (redacted)', '--------------------------', JSON.stringify(snap, null, 2), '',
    ];
    return lines.join('\n');
  }

  // Email is best effort: the ticket is stored whatever happens and its delivery
  // state says whether, and why not, it reached the support address.
  async function deliverTicket(row, req) {
    const to = supportSettings().email;
    if (!to) return { status: 'not_sent', detail: 'No support email address is configured (Support Center → Settings).', to: null };
    const send = ctx.contacts?.sendMail;
    if (typeof send !== 'function') return { status: 'not_sent', detail: 'The panel has no mail transport: install Exim or configure an SMTP relay in Contact Manager.', to };
    const snap = json.parse(row.snapshot_json, null);
    try {
      const r = await send({ to, subject: `[${row.reference}] ${row.subject} (${row.severity})`, body: renderTicketMail(row, snap), ...(row.contact_email ? { headers: { 'Reply-To': row.contact_email } } : {}) }, req);
      return { status: 'sent', detail: `Sent via ${r.transport}`, to };
    } catch (err) {
      logger?.warn({ err, ticket: row.reference }, 'support ticket email failed');
      return { status: 'failed', detail: err.message, to };
    }
  }

  const tickets = {
    list(query) {
      const where = [];
      const params = {};
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.q) { where.push('(subject LIKE @q OR reference LIKE @q OR description LIKE @q)'); params.q = `%${query.q}%`; }
      const page = paginate(db, { select: '*', from: 'support_tickets', where, params, query: { ...query, dir: query.sort ? query.dir : 'desc' }, sortable: { created_at: 'id', severity: 'severity', status: 'status', subject: 'subject' }, defaultSort: 'created_at' });
      return { data: page.data.map((r) => shapeTicket(r)), meta: page.meta };
    },
    get(id) { return shapeTicket(loadTicket(id), { withSnapshot: true }); },
    async create(input, user, req) {
      const snap = input.includeSnapshot === false ? null : await snapshot();
      const snapshotJson = snap ? JSON.stringify(snap).slice(0, SNAPSHOT_MAX) : null;
      let reference = ticketReference();
      let id;
      for (let attempt = 0; ; attempt++) {
        try {
          id = Number(stmts.insertTicket.run({ reference, subject: input.subject, category: input.category, severity: input.severity, description: input.description, contact_email: input.contactEmail || null, snapshot_json: snapshotJson, delivery_status: 'not_sent', delivery_detail: null, sent_to: null, sent_at: null, created_by: user?.username || null }).lastInsertRowid);
          break;
        } catch (err) {
          if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE' || attempt > 3) throw err;
          reference = ticketReference();
        }
      }
      const row = stmts.ticketById.get(id);
      const delivery = await deliverTicket(row, req);
      stmts.setDelivery.run({ id, status: delivery.status, detail: delivery.detail, to: delivery.to, at: delivery.status === 'sent' ? utcStamp(Date.now()) : null });
      audit(req, { action: 'support.ticket.create', target: reference, args: { subject: input.subject, severity: input.severity, category: input.category, snapshot: Boolean(snap), delivery: delivery.status } });
      return shapeTicket(stmts.ticketById.get(id));
    },
    async resend(id, req) {
      const row = loadTicket(id);
      const delivery = await deliverTicket(row, req);
      stmts.setDelivery.run({ id, status: delivery.status, detail: delivery.detail, to: delivery.to, at: delivery.status === 'sent' ? utcStamp(Date.now()) : row.sent_at });
      audit(req, { action: 'support.ticket.resend', target: row.reference, args: { delivery: delivery.status, to: delivery.to } });
      return shapeTicket(stmts.ticketById.get(id));
    },
    setStatus(id, status, req) {
      const row = loadTicket(id);
      stmts.setStatus.run({ id, status });
      audit(req, { action: `support.ticket.${status === 'closed' ? 'close' : 'reopen'}`, target: row.reference });
      return shapeTicket(stmts.ticketById.get(id));
    },
    remove(id, req) {
      const row = loadTicket(id);
      stmts.deleteTicket.run(id);
      audit(req, { action: 'support.ticket.delete', target: row.reference });
      return { id, reference: row.reference, deleted: true };
    },
  };

  // ------------------------------------------------------------ access grants ---

  function shapeGrant(row) {
    if (!row) return null;
    const expiresAt = row.expires_at;
    const active = row.status === 'active';
    const cleanup = json.parse(row.cleanup_json, null);
    return {
      id: row.id, label: row.label, status: row.status, note: row.note,
      ssh: row.ssh_fingerprint ? { fingerprint: row.ssh_fingerprint, type: row.ssh_key_type, comment: row.ssh_comment, expiry: row.ssh_expiry } : null,
      apiToken: row.api_token_id ? { id: row.api_token_id, prefix: row.api_token_prefix } : null,
      grantedBy: row.granted_by, grantedIp: row.granted_ip, expiresAt, createdAt: row.created_at,
      remainingSeconds: active ? Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)) : 0,
      overdue: active && new Date(expiresAt).getTime() <= Date.now(),
      cleanupPending: row.status === 'cleanup_pending',
      pendingStatus: row.status === 'cleanup_pending' ? cleanup?.pending ?? null : null,
      endedAt: row.ended_at, endedBy: row.ended_by, cleanup,
    };
  }

  function loadGrant(id) {
    const row = stmts.grantById.get(id);
    if (!row) throw notFound(`Support access grant ${id}`);
    return row;
  }

  // Removes what a grant created. Each step records its own outcome so a key
  // the admin already deleted by hand never stops the token from being expired,
  // and a step that already succeeded on an earlier attempt is not repeated.
  async function cleanupGrant(row, req) {
    const previous = json.parse(row.cleanup_json, null) || {};
    const cleanup = {};
    if (row.ssh_fingerprint) {
      try {
        const r = await agent.op('sec.ssh_keys.remove', { fingerprint: row.ssh_fingerprint }, { req });
        cleanup.ssh = { removed: r.removed };
      } catch (err) {
        cleanup.ssh = { removed: 0, error: err.message, code: err.code || null };
      }
    }
    if (row.api_token_id) {
      if (previous.api?.expired) cleanup.api = previous.api;
      else {
        try {
          if (!ctx.development?.tokens) throw new Error('Development service unavailable');
          ctx.development.tokens.expireNow(row.api_token_id, SYSTEM_PRINCIPAL.user, req);
          cleanup.api = { expired: true };
        } catch (err) {
          cleanup.api = { expired: err.status === 404, error: err.status === 404 ? null : err.message };
        }
      }
    }
    cleanup.ok = (!cleanup.ssh || !cleanup.ssh.error) && (!cleanup.api || cleanup.api.expired);
    return cleanup;
  }

  // The grant only leaves the live states once the root key is off the host.
  // While sec.ssh_keys.remove fails (agent down, socket timeout, sshd gone) the
  // row becomes 'cleanup_pending' and every expiry run retries it; sshd's own
  // expiry-time option on the key bounds the exposure meanwhile.
  async function endGrant(row, status, req, by) {
    const previous = json.parse(row.cleanup_json, null) || {};
    const cleanup = await cleanupGrant(row, req);
    const attempts = (previous.attempts || 0) + 1;
    const hostClean = !cleanup.ssh || !cleanup.ssh.error;
    const kind = status === 'expired' ? 'expire' : 'revoke';
    if (hostClean) {
      stmts.finishGrant.run({ id: row.id, status, ended_by: by, cleanup: JSON.stringify({ ...cleanup, attempts }) });
      audit(req, { action: `support.access.${kind}`, target: `${row.id}:${row.label}`, args: { fingerprint: row.ssh_fingerprint, apiCredentialId: row.api_token_id, cleanup, attempts }, result: cleanup.ok ? 'ok' : 'partial' });
      if (!cleanup.ok) logger?.warn({ grant: row.id, cleanup }, 'support access ended; API token cleanup incomplete');
    } else {
      stmts.pendGrant.run({ id: row.id, ended_by: by, cleanup: JSON.stringify({ ...cleanup, pending: status, attempts, lastAttemptAt: utcStamp(Date.now()) }) });
      audit(req, { action: `support.access.${kind}`, target: `${row.id}:${row.label}`, args: { fingerprint: row.ssh_fingerprint, apiCredentialId: row.api_token_id, cleanup, attempts, pending: status }, result: 'partial' });
      logger?.warn({ grant: row.id, cleanup, attempts }, 'support access cleanup pending: root SSH key still authorized, will retry');
    }
    return shapeGrant(stmts.grantById.get(row.id));
  }

  // What a live row should become once its host cleanup succeeds.
  const finalStatus = (row, fallback) => (row.status === 'cleanup_pending' ? json.parse(row.cleanup_json, null)?.pending || fallback : fallback);

  const access = {
    list(query) {
      const where = [];
      const params = {};
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.q) { where.push('(label LIKE @q OR ssh_fingerprint LIKE @q OR granted_by LIKE @q)'); params.q = `%${query.q}%`; }
      const page = paginate(db, { select: '*', from: 'support_access_grants', where, params, query: { ...query, dir: query.sort ? query.dir : 'desc' }, sortable: { created_at: 'id', expires_at: 'expires_at', status: 'status', label: 'label' }, defaultSort: 'created_at' });
      return { data: page.data.map(shapeGrant), meta: page.meta };
    },
    get(id) { return shapeGrant(loadGrant(id)); },
    status() {
      const sshd = capabilities.has('sshd');
      return {
        sshd, tokens: Boolean(ctx.development?.tokens), active: stmts.activeGrants.all().map(shapeGrant), cleanupPending: stmts.pendingGrants.all().map(shapeGrant),
        settings: supportSettings().access, sshdDetail: sshd ? null : 'OpenSSH server (sshd) is not installed on this server; SSH access cannot be granted but an API token can.',
        sshdMinVersion: SSHD_MIN_VERSION, expiryTimeZone: hostTimeZone(),
      };
    },
    // Host first, database second: the key is authorized and the token issued,
    // then the grant row is written. If that last step fails both are undone.
    async grant(input, user, req) {
      const { maxHours, defaultHours } = supportSettings().access;
      const hours = input.hours ?? defaultHours;
      if (hours > maxHours) throw unprocessable('Request validation failed', { hours: [`Support access may last at most ${maxHours} hours (Support Center → Settings)`] });
      if (!input.ssh && !input.apiToken) throw unprocessable('Request validation failed', { _: ['Grant at least one of SSH access or an API token'] });
      if (input.ssh) {
        await capabilities.ensureFresh();
        capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server, so there is nothing for a support engineer to log in to. Install openssh-server or grant an API token only.');
      }
      if (input.apiToken && !ctx.development?.tokens) throw new HttpError(503, 'service_unavailable', 'API tokens are unavailable because the Development module is not loaded');
      const expiresAt = utcStamp(Date.now() + hours * 3_600_000);
      const label = input.label;
      let key = null;
      let token = null;
      const sshExpiry = sshExpiryTime(expiresAt);
      if (input.ssh) {
        key = generateSshKeyPair(`whm-support-${label}`);
        try {
          await agent.op('sec.ssh_keys.add', { publicKey: authorizedKeyLine(key.publicKey, expiresAt) }, { req });
        } catch (err) {
          if (err.code === 'exists') throw conflict(`A key with fingerprint ${key.fingerprint} is already authorized for root`);
          throw err;
        }
      }
      try {
        if (input.apiToken) {
          token = await ctx.development.tokens.create({ name: `support-${label}`, description: `Support access grant for ${label}; expires ${expiresAt}`, scopes: input.tokenScopes || [], expiresAt }, user, req);
        }
        const id = Number(stmts.insertGrant.run({ label, ssh_fingerprint: key?.fingerprint ?? null, ssh_key_type: key?.type ?? null, ssh_comment: key ? `whm-support-${label}` : null, ssh_expiry: key ? sshExpiry : null, api_token_id: token?.id ?? null, api_token_prefix: token?.prefix ?? null, granted_by: user?.username || null, granted_ip: req?.ip || null, note: input.note || null, expires_at: expiresAt }).lastInsertRowid);
        audit(req, { action: 'support.access.grant', target: `${id}:${label}`, args: { hours, expiresAt, ssh: Boolean(key), fingerprint: key?.fingerprint, sshExpiry: key ? sshExpiry : null, api: Boolean(token), apiCredentialId: token?.id, apiScopes: input.tokenScopes || [] } });
        const hostname = settings.get('basic.hostname') || null;
        return {
          grant: shapeGrant(stmts.grantById.get(id)),
          // Shown once: the private key is never stored and the token is kept only as a hash.
          ssh: key ? { privateKey: key.privateKey, publicKey: key.publicKey, authorizedLine: authorizedKeyLine(key.publicKey, expiresAt), expiry: sshExpiry, expiryTimeZone: hostTimeZone(), sshdMinVersion: SSHD_MIN_VERSION, fingerprint: key.fingerprint, command: `ssh -i support-${label}.key root@${hostname || '<server>'}` } : null,
          apiToken: token ? { token: token.token, prefix: token.prefix, id: token.id, scopes: token.scopes, expiresAt: token.expiresAt, example: `curl -H "Authorization: Bearer <token>" https://${hostname || '<server>'}:2087/api/system/status` } : null,
        };
      } catch (err) {
        if (key) await agent.op('sec.ssh_keys.remove', { fingerprint: key.fingerprint }, { req }).catch((e) => logger?.error({ err: e }, 'could not roll back support SSH key'));
        if (token) { try { ctx.development.tokens.revoke(token.id, user, req); } catch (e) { logger?.error({ err: e }, 'could not roll back support API token'); } }
        throw err;
      }
    },
    // On a 'cleanup_pending' grant this retries the host cleanup by hand.
    async revoke(id, user, req) {
      const row = loadGrant(id);
      if (row.status !== 'active' && row.status !== 'cleanup_pending') throw conflict(`This grant already ended (${row.status})`);
      return endGrant(row, finalStatus(row, 'revoked'), req, user?.username || null);
    },
    // Runs from the scheduler every few minutes and from "Expire now": ends the
    // grants that are overdue and retries every one whose cleanup is pending.
    async expireDue({ log = () => {}, req = null } = {}) {
      const due = stmts.dueGrants.all(utcStamp(Date.now()));
      const results = [];
      for (const row of due) {
        const r = await endGrant(row, finalStatus(row, 'expired'), req, req?.user?.username || 'scheduler');
        log(`grant ${row.id} (${row.label}) ${r.cleanupPending ? `cleanup still pending (attempt ${r.cleanup?.attempts})` : r.status}; ssh ${r.cleanup?.ssh ? (r.cleanup.ssh.error ? `error: ${r.cleanup.ssh.error}` : `removed ${r.cleanup.ssh.removed}`) : 'n/a'}, token ${r.cleanup?.api ? (r.cleanup.api.expired ? 'expired' : `error: ${r.cleanup.api.error}`) : 'n/a'}`);
        results.push(r);
      }
      if (!due.length) log('no support access grants were due');
      return { expired: results.filter((r) => !r.cleanupPending).length, pending: results.filter((r) => r.cleanupPending).length, grants: results };
    },
  };

  // ------------------------------------------------------------------- center ---

  const docs = {
    list() {
      return DOCS.map((d) => {
        const file = path.join(REPO_ROOT, d.file);
        let stat = null;
        try { stat = fs.statSync(file); } catch { /* not shipped with this install */ }
        const sections = stat ? indexSections(fs.readFileSync(file, 'utf8')).filter((s) => s.level === 2) : [];
        return { slug: d.slug, title: d.title, file: d.file, summary: d.summary, available: Boolean(stat), size: stat?.size ?? null, updatedAt: stat?.mtime?.toISOString() ?? null, sections };
      });
    },
    get(slug, section) {
      if (!DOC_SLUG_RE.test(slug) || (section && !DOC_SLUG_RE.test(section))) throw unprocessable('Invalid document reference');
      const d = DOCS.find((x) => x.slug === slug);
      if (!d) throw notFound(`Document "${slug}"`);
      const file = path.join(REPO_ROOT, d.file);
      if (!fs.existsSync(file)) throw notFound(`Document "${slug}" is not shipped with this install (${d.file})`);
      const text = fs.readFileSync(file, 'utf8');
      const sections = indexSections(text);
      if (section) {
        const content = extractSection(text, section);
        if (content == null) throw notFound(`Section "${section}" in ${d.file}`);
        return { slug, title: d.title, file: d.file, section, content, sections };
      }
      return { slug, title: d.title, file: d.file, content: text, sections };
    },
  };

  function center(user) {
    const root = user?.role === 'root';
    const cfg = supportSettings();
    const transport = ctx.contacts?.mailTransport?.() ?? null;
    return {
      links: [...(cfg.portalUrl ? [{ key: 'portal', label: `${cfg.providerName} portal`, url: cfg.portalUrl, description: 'Where tickets from this server are handled.' }] : []), ...SUPPORT_LINKS],
      inApp: [
        { key: 'api', label: 'OpenAPI reference (WHM)', path: '/development/openapi-documentation-for-whm', description: 'Every endpoint of this panel with roles and parameters.' },
        { key: 'api-cpanel', label: 'OpenAPI reference (cPanel subset)', path: '/development/openapi-documentation-for-cpanel', description: 'The account-scoped subset resellers may call.' },
        { key: 'dev-docs', label: 'Developer documentation', path: '/development/developer-documentation', description: 'Design documents and the plugin manifest contract.' },
        { key: 'audit', label: 'Audit log', path: '/audit-log', description: 'Every privileged action taken through the panel.' },
        { key: 'status', label: 'Server status', path: '/server-status/server-information', description: 'Live hardware, load and capacity.' },
        { key: 'contacts', label: 'Contact Manager', path: '/server-contacts/contact-manager', description: 'Where ticket email leaves from (Exim or SMTP relay).' },
      ],
      docs: docs.list(),
      settings: root ? cfg : { providerName: cfg.providerName, portalUrl: cfg.portalUrl },
      mail: root ? { transport, configured: Boolean(cfg.email), address: cfg.email } : undefined,
      tickets: root ? { ...stmts.ticketCounts.get(), open: stmts.openTickets.all().map((r) => ({ id: r.id, reference: r.reference, subject: r.subject, severity: r.severity, category: r.category, createdAt: r.created_at })) } : undefined,
      access: root ? { ...stmts.grantCounts.get(), sshd: capabilities.has('sshd'), active: stmts.activeGrants.all().map(shapeGrant), cleanupPending: stmts.pendingGrants.all().map(shapeGrant) } : undefined,
      panel: { version: ctx.version ?? null, mode: ctx.config?.mode ?? null, node: process.version },
    };
  }

  // A JSON bundle to attach to a ticket by hand: the snapshot plus the panel
  // state that explains it. Settings are included by key with secret-looking
  // ones and encrypted values dropped.
  async function diagnostics(req) {
    const snap = await snapshot();
    const caps = await capabilities.ensureFresh();
    const SECRET = /pass|secret|token|key|_enc$|totp|cert|private/i;
    const settingsOut = {};
    for (const row of stmts.settingKeys.all()) {
      if (SECRET.test(row.key)) continue;
      settingsOut[row.key] = json.parse(row.value, null);
    }
    audit(req, { action: 'support.diagnostics.download' });
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: req?.user?.username ?? null,
      snapshot: snap,
      capabilities: caps.capabilities,
      units: caps.units,
      services: await ctx.serviceManager?.list?.().catch(() => null) ?? null,
      jobs: { failed: stmts.failedJobs.all(), types: ctx.jobs.types?.() ?? [] },
      schedules: ctx.scheduler.list(),
      tickets: { open: stmts.openTickets.all() },
      accessGrants: stmts.liveGrants.all().map(shapeGrant),
      settings: redact(settingsOut),
      audit: { recent: stmts.recentAudit.all() },
      process: { pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), memory: process.memoryUsage(), node: process.version, platform: process.platform },
    };
  }

  return {
    JOB_EXPIRE, SCHEDULE_EXPIRE,
    settings: supportSettings, updateSettings,
    snapshot, tickets, access, docs, center, diagnostics,
    // Other categories may check for a live grant before, say, disabling SSH
    // passwords. Includes grants whose key is still on the host pending cleanup.
    activeGrants: () => stmts.liveGrants.all().map(shapeGrant),
  };
}
