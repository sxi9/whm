import os from 'node:os';
import crypto from 'node:crypto';
import { json } from '../db/index.js';
import { unprocessable, CapabilityError } from '../lib/errors.js';
import { SEVERITIES } from './server-contacts.js';

// Security alerts: "an emergency update was pushed" notices. Attached as
// ctx.securityAlerts by the Server Contacts module; other categories call
//   securityAlerts.raise({ kind, severity?, title, body, dedupeKey, source?, data? })
//        -> { raised, deduped, alert, delivery } (synchronous; idempotent per
//           dedupeKey for 24 h; nothing is recorded while the feature is off)
//   securityAlerts.onAdvisorScan(run, { previousCritical }) (Security Advisor)
// Admins hear about every alert through ctx.contacts.notify('security.alert')
// (root mail carries the event by default, migration 037b); an alert nobody
// could be told about stays pending and is retried on the next flush. Hosting
// accounts are mailed only when security.alerts.notify_accounts is on (a test
// or notice: only when the admin asked for it, recorded on the row) and only
// for kinds whose audience is "all", with the account template below, never
// with the admin body (finding details must not reach a tenant).

export const ALERT_EVENT = 'security.alert';
export const JOB = 'security.alerts.deliver';
export const DEDUPE_WINDOW_MS = 24 * 60 * 60_000;
export const PRODUCT_NAME = 'HST Panel';
const ACCOUNT_CHUNK = 25;
const CHUNK_PAUSE_MS = 500;
const EMAIL_RE = /^[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

// audience "all" kinds reach hosting accounts; the rest are for administrators.
export const KINDS = {
  'advisor.critical': { label: 'Security Advisor critical finding', severity: 'critical', audience: 'admins', page: '/security-center/security-advisor' },
  'php.advisory': { label: 'PHP security advisory affects an installed version', severity: 'critical', audience: 'admins', page: '/software/multiphp-manager' },
  'updates.security_available': { label: 'Security updates available', severity: 'warning', audience: 'admins', page: '/software/system-update' },
  'updates.security_applied': { label: 'Emergency security update applied', severity: 'critical', audience: 'all', page: '/software/system-update' },
  'panel.security_release': { label: 'Panel security release available', severity: 'critical', audience: 'admins', page: '/cpanel/upgrade-to-latest-version' },
  manual: { label: 'Notice sent by an administrator', severity: 'critical', audience: 'all', page: '/server-contacts/contact-manager' },
  test: { label: 'Test alert', severity: 'info', audience: 'all', page: '/server-contacts/contact-manager' },
};
const GENERIC_KIND = { label: 'Security alert', severity: 'critical', audience: 'admins', page: '/security-center/security-advisor' };
export const kindOf = (kind) => KINDS[kind] || GENERIC_KIND;
const severityRank = (s) => Math.max(0, SEVERITIES.indexOf(s));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sqlTime = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');
const parseSqlTime = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'}`) : null);

// What the panel did / what to do, per kind. Admin lines may name the finding
// and the fix page; account lines never carry details.
function adminAction(alert, panelUrl) {
  const d = alert.data || {};
  const link = (p) => `${panelUrl}${p}`;
  switch (alert.kind) {
    case 'advisor.critical': return `The panel only reported this; nothing was changed. ${d.fix?.label ? `Fix it from ${d.fix.label}: ${link(d.fix.path)}` : `Open Security Advisor: ${link(kindOf(alert.kind).page)}`}`;
    case 'php.advisory': return `Nothing was changed. Update the affected PHP version from MultiPHP Manager: ${link('/software/multiphp-manager')}${d.url ? `\nAdvisory: ${d.url}` : ''}`;
    case 'updates.security_available': return `Nothing was installed yet. Apply the updates from System Update: ${link('/software/system-update')} (or turn on automatic OS updates there).`;
    case 'updates.security_applied': return `The panel applied the updates${d.jobId ? ` (job #${d.jobId})` : ''}. ${d.rebootRequired ? `A reboot is required to finish: ${link('/system-reboot/graceful-server-reboot')}` : 'No reboot is required.'}${d.stillPending ? `\n${plural(d.stillPending, 'update')} still pending afterwards.` : ''}`;
    case 'panel.security_release': return `Nothing was changed. Upgrade from Upgrade to Latest Version: ${link('/cpanel/upgrade-to-latest-version')}${d.url ? `\nRelease: ${d.url}` : ''}`;
    case 'test': return 'Nothing happened: this is a test of the security notifications.';
    case 'manual': return `Sent by ${d.sentBy || 'an administrator'} from Contact Manager.`;
    default: return `Open the panel: ${link(kindOf(alert.kind).page)}`;
  }
}

// The whole account-facing text per kind; alerts of other kinds never reach
// accounts, so there is no generic fallback here on purpose.
export function accountText(alert, { host, product = PRODUCT_NAME, accounts = [] } = {}) {
  const d = alert.data || {};
  const who = accounts.length ? ` that hosts ${accounts.map((a) => `${a.username}${a.domain ? ` (${a.domain})` : ''}`).join(', ')}` : '';
  switch (alert.kind) {
    case 'updates.security_applied': {
      const names = Array.isArray(d.packages) ? d.packages.slice(0, 20) : [];
      return [
        `An emergency security update was applied to the server ${host}${who}.`,
        `${plural(d.count ?? names.length, 'package')} ${names.length ? `(${names.join(', ')}${(d.count ?? names.length) > names.length ? ', …' : ''}) ` : ''}received security fixes${d.rebootRequired ? '; the server will be restarted shortly to finish applying them' : ''}.`,
        'Your website, email and databases keep working. Nothing is required from you; if your site shows an error after this change, contact your hosting provider.',
      ].join('\n\n');
    }
    case 'manual': return alert.body;
    case 'test': return `This is a test of the security notifications sent by ${product} on ${host}${who}. Nothing happened and nothing is required from you.`;
    default: return null;
  }
}

function section(label, text) {
  return `${label}\n${String(text).split('\n').map((l) => `  ${l}`).join('\n')}`;
}

// Plain text + HTML for one alert or a digest. audience "admins" sees titles
// and bodies; "accounts" sees accountText() only.
export function renderMail(alerts, { audience = 'admins', host, panelUrl, product = PRODUCT_NAME, accounts = [], now = new Date() } = {}) {
  const list = Array.isArray(alerts) ? alerts : [alerts];
  const top = list.reduce((m, a) => (severityRank(a.severity) > severityRank(m) ? a.severity : m), 'info');
  const forAccounts = audience === 'accounts';
  const items = list.map((a) => {
    const when = parseSqlTime(a.createdAt || a.created_at) || now;
    return {
      kind: a.kind, label: kindOf(a.kind).label, severity: a.severity, title: a.title, when: `${when.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      what: forAccounts ? accountText(a, { host, product, accounts }) : a.body || a.title,
      action: forAccounts ? null : adminAction(a, panelUrl),
    };
  }).filter((i) => i.what != null);
  const digest = items.length > 1;
  const subject = forAccounts
    ? (digest ? `[${product}] ${plural(items.length, 'security notice')} for your hosting on ${host}` : `[${product}] ${items[0]?.title ?? 'Security notice'}`)
    : (digest ? `[${product}] ${plural(items.length, 'security alert')} on ${host} (${top})` : `[${product}] Security alert: ${items[0]?.title ?? 'alert'}`);
  const intro = forAccounts
    ? `${product} on ${host} sends this notice to the contact address of every hosting account on the server.`
    : `${product} on ${host} raised ${digest ? `${items.length} security alerts` : 'a security alert'}.`;
  const textBlocks = items.map((i) => [
    digest ? `${i.severity.toUpperCase()} · ${i.label}` : null,
    section('What happened', forAccounts ? i.what : `${i.title}${i.what && i.what !== i.title ? `\n${i.what}` : ''}`),
    i.action ? section('What the panel did', i.action) : null,
    section('When', i.when),
  ].filter(Boolean).join('\n\n'));
  const text = [
    `${product} security ${forAccounts ? 'notice' : 'alert'} — ${host}`, '', intro, '',
    textBlocks.join('\n\n----\n\n'), '',
    forAccounts ? `Hosting control panel: ${panelUrl}` : `Open the panel: ${panelUrl}${digest ? kindOf('advisor.critical').page : kindOf(items[0]?.kind).page}`,
    '', '-- ', `${product} on ${host} · ${forAccounts ? 'security notice' : `event ${ALERT_EVENT}`} · severity ${top}`,
  ].join('\n');
  const htmlItems = items.map((i) => `<div style="border:1px solid #e3e6ea;border-radius:8px;padding:14px 16px;margin:0 0 14px">
${digest ? `<p style="margin:0 0 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280">${escapeHtml(i.severity)} · ${escapeHtml(i.label)}</p>` : ''}
<h2 style="margin:0 0 8px;font-size:16px">${escapeHtml(i.title)}</h2>
<p style="margin:0 0 10px;white-space:pre-line">${escapeHtml(forAccounts ? i.what : (i.what !== i.title ? i.what : ''))}</p>
${i.action ? `<p style="margin:0 0 10px;white-space:pre-line"><strong>What the panel did:</strong> ${escapeHtml(i.action)}</p>` : ''}
<p style="margin:0;color:#6b7280;font-size:13px">When: ${escapeHtml(i.when)}</p>
</div>`).join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280">${escapeHtml(product)} · ${escapeHtml(host)}</p>
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(subject.replace(/^\[[^\]]*\]\s*/, ''))}</h1>
<p style="margin:0 0 16px">${escapeHtml(intro)}</p>
${htmlItems}
<p style="margin:16px 0 0"><a href="${escapeHtml(panelUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">Open ${escapeHtml(product)}</a></p>
<p style="margin:24px 0 0;color:#9ca3af;font-size:12px">${escapeHtml(product)} on ${escapeHtml(host)} · severity ${escapeHtml(top)}</p>
</div></body></html>`;
  return { subject, text, html, severity: top, count: items.length };
}

export function createSecurityAlertsService(ctx) {
  const { db, settings, logger } = ctx;
  const stmts = {
    byKey: db.prepare('SELECT * FROM security_alerts WHERE dedupe_key = ?'),
    byId: db.prepare('SELECT * FROM security_alerts WHERE id = ?'),
    byIds: (ids) => db.prepare(`SELECT * FROM security_alerts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids),
    retireKey: db.prepare("UPDATE security_alerts SET dedupe_key = dedupe_key || '#' || id WHERE id = ?"),
    insert: db.prepare('INSERT INTO security_alerts (kind, severity, title, body, source, data_json, dedupe_key, state) VALUES (@kind, @severity, @title, @body, @source, @data, @dedupe_key, @state)'),
    pending: db.prepare("SELECT * FROM security_alerts WHERE state IN ('pending', 'held') ORDER BY id"),
    pendingCount: db.prepare("SELECT COUNT(*) AS n FROM security_alerts WHERE state IN ('pending', 'held')"),
    holdPending: db.prepare("UPDATE security_alerts SET state = 'held' WHERE state = 'pending'"),
    setState: db.prepare('UPDATE security_alerts SET state = ? WHERE id = ?'),
    markAdmins: db.prepare("UPDATE security_alerts SET notified_admins_at = datetime('now'), admin_result_json = ?, state = ? WHERE id = ?"),
    markAdminsWaiting: db.prepare("UPDATE security_alerts SET admin_result_json = ?, state = 'pending' WHERE id = ?"),
    markAccounts: db.prepare("UPDATE security_alerts SET notified_accounts_at = CASE WHEN @sent THEN datetime('now') ELSE notified_accounts_at END, accounts_result_json = @result WHERE id = @id"),
    recent: db.prepare('SELECT * FROM security_alerts ORDER BY id DESC LIMIT ?'),
    stats: db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last24h, SUM(CASE WHEN state IN ('pending', 'held') THEN 1 ELSE 0 END) AS pending FROM security_alerts"),
    prune: db.prepare("DELETE FROM security_alerts WHERE created_at < datetime('now', '-180 days') AND state NOT IN ('pending', 'held')"),
    recipients: db.prepare("SELECT id, username, domain, contact_email FROM accounts WHERE suspended = 0 AND contact_email IS NOT NULL AND contact_email != '' ORDER BY username"),
    recipientCount: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE suspended = 0 AND contact_email IS NOT NULL AND contact_email != ''"),
    claim: db.prepare("INSERT INTO security_alert_deliveries (alert_id, account_id, username, address, status) VALUES (@alert_id, @account_id, @username, @address, 'queued') ON CONFLICT (alert_id, account_id) DO UPDATE SET status = 'queued', ts = datetime('now') WHERE security_alert_deliveries.status = 'failed'"),
    finishDelivery: db.prepare("UPDATE security_alert_deliveries SET status = @status, error = @error, ts = datetime('now') WHERE alert_id = @alert_id AND account_id = @account_id"),
    deliveriesFor: db.prepare('SELECT status, COUNT(*) AS n FROM security_alert_deliveries WHERE alert_id = ? GROUP BY status'),
  };

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const setting = (key, fallback) => { const v = settings.get(key); return v == null || v === '' ? fallback : v; };
  const hostname = () => setting('basic.hostname', '') || os.hostname() || 'localhost';
  const panelUrl = () => { const c = ctx.config || {}; const host = hostname(); return c.tls ? `https://${host}:${c.tlsPort ?? 2087}` : `http://${host}:${c.port ?? 2086}`; };
  // The company name set under HST Panel › Customization names the product in
  // mails; the admin-side default ("WHM") is not a customer-facing name.
  const productName = () => { const n = String(setting('branding.company_name', '')).trim(); return n && n !== 'WHM' ? n : PRODUCT_NAME; };

  function config() {
    const minSeverity = SEVERITIES.includes(settings.get('security.alerts.min_severity')) ? settings.get('security.alerts.min_severity') : 'critical';
    return {
      enabled: Boolean(settings.get('security.alerts.enabled', true)),
      notifyAccounts: Boolean(settings.get('security.alerts.notify_accounts', false)),
      minSeverity,
      digestMinutes: Math.max(0, Number(setting('security.alerts.digest_minutes', 60)) || 0),
      lastDeliveryAt: settings.get('security.alerts.last_delivery_at', null),
    };
  }

  function shape(row) {
    if (!row) return null;
    const def = kindOf(row.kind);
    return {
      id: row.id, kind: row.kind, kindLabel: def.label, audience: def.audience, severity: row.severity, title: row.title, body: row.body, source: row.source,
      data: json.parse(row.data_json, {}), dedupeKey: row.dedupe_key, state: row.state, createdAt: row.created_at,
      notifiedAdminsAt: row.notified_admins_at, notifiedAccountsAt: row.notified_accounts_at,
      admin: json.parse(row.admin_result_json, null), accounts: json.parse(row.accounts_result_json, null),
    };
  }

  // ------------------------------------------------------------- scheduling ---

  function digestDue(cfg = config()) {
    if (cfg.digestMinutes <= 0 || !cfg.lastDeliveryAt) return true;
    return Date.now() - new Date(cfg.lastDeliveryAt).getTime() >= cfg.digestMinutes * 60_000;
  }
  function windowRemainingMs(cfg = config()) {
    if (digestDue(cfg)) return 0;
    return Math.max(1000, cfg.digestMinutes * 60_000 - (Date.now() - new Date(cfg.lastDeliveryAt).getTime()));
  }
  const queued = () => ctx.jobs.list({ type: JOB, status: 'queued' }).some((j) => !j.params?.alertIds);
  function enqueue(params = {}, userId = null) {
    return ctx.jobs.enqueue(JOB, params, { userId });
  }

  // A digest window follows every delivery: alerts raised inside it wait for a
  // timer (unref'd; a restart re-arms it from the pending rows at boot).
  let timer = null;
  function armTimer(ms) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { if (stmts.pendingCount.get().n > 0) scheduleDelivery(); } catch (err) { logger.warn({ err }, 'security alert digest timer failed'); }
    }, ms);
    timer.unref?.();
  }
  function scheduleDelivery({ now = false } = {}) {
    const cfg = config();
    if (!cfg.enabled) return 'disabled';
    if (queued()) return 'queued';
    if (now || digestDue(cfg)) { enqueue({}); return 'queued'; }
    stmts.holdPending.run();
    armTimer(windowRemainingMs(cfg));
    return 'held';
  }

  // ------------------------------------------------------------------ raise ---

  function raise({ kind, severity, title, body = '', dedupeKey, source = null, data = {}, force = false, defer = false }, req = null) {
    const cfg = config();
    if (!cfg.enabled) return { raised: false, skipped: 'disabled', alert: null };
    if (!kind || !title || !dedupeKey) throw unprocessable('A security alert needs a kind, a title and a dedupe key');
    const def = kindOf(kind);
    const sev = SEVERITIES.includes(severity) ? severity : def.severity;
    const existing = stmts.byKey.get(String(dedupeKey));
    if (existing) {
      const age = Date.now() - (parseSqlTime(existing.created_at)?.getTime() ?? 0);
      if (age < DEDUPE_WINDOW_MS) return { raised: false, deduped: true, alert: shape(existing) };
      stmts.retireKey.run(existing.id);
    }
    const belowMin = !force && severityRank(sev) < severityRank(cfg.minSeverity);
    const state = belowMin ? 'skipped' : 'pending';
    const { lastInsertRowid } = stmts.insert.run({ kind: String(kind), severity: sev, title: String(title).replace(/[\r\n]+/g, ' ').slice(0, 200), body: String(body).slice(0, 20_000), source, data: JSON.stringify(data ?? {}), dedupe_key: String(dedupeKey).slice(0, 300), state });
    const alert = shape(stmts.byId.get(lastInsertRowid));
    audit(req, { action: 'security.alerts.raise', target: kind, args: { severity: sev, title: alert.title, dedupe: alert.dedupeKey, state, source } });
    stmts.prune.run();
    let delivery = state;
    if (!belowMin && !defer) delivery = scheduleDelivery();
    return { raised: true, deduped: false, alert, delivery };
  }

  // Critical findings that were not critical in the previous run; PHP advisory
  // findings keep their own kind so the mail names the MultiPHP page.
  function onAdvisorScan(run, { previousCritical = [] } = {}) {
    if (!config().enabled || !run?.findings) return { raised: 0, alerts: [] };
    const was = new Set(previousCritical);
    const alerts = [];
    for (const f of run.findings) {
      if (f.grade !== 'critical' || !f.id || was.has(f.id)) continue;
      const kind = String(f.id).startsWith('php.advisory.') ? 'php.advisory' : 'advisor.critical';
      const r = raise({
        kind, title: f.title, body: [f.detail, f.fix ? `Fix: ${f.fix.label} (${f.fix.path})` : null].filter(Boolean).join('\n'),
        dedupeKey: `advisor:${f.id}`, source: `security-advisor:${run.trigger || 'manual'}`, defer: true,
        data: { findingId: f.id, fix: f.fix ?? null, url: f.url ?? null, advisory: f.advisory ?? null },
      });
      if (r.raised) alerts.push(r.alert);
    }
    if (alerts.some((a) => a.state === 'pending')) scheduleDelivery();
    return { raised: alerts.length, alerts };
  }

  // --------------------------------------------------------------- delivery ---

  async function notifyAdmins(rows, job) {
    const host = hostname();
    const mail = renderMail(rows.map(shape), { audience: 'admins', host, panelUrl: panelUrl(), product: productName() });
    let result;
    try {
      const r = await ctx.contacts?.notify?.(ALERT_EVENT, { subject: mail.subject, body: mail.text, html: mail.html, severity: mail.severity, data: { alerts: rows.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, title: a.title, createdAt: a.created_at })), hostname: host } });
      result = r ? { matched: r.matched ?? 0, sent: r.sent ?? 0, failed: r.failed ?? 0, skipped: r.skipped ?? null, rootMail: r.rootMail ?? null } : { matched: 0, sent: 0, failed: 0, skipped: 'no_contacts_service' };
    } catch (err) {
      result = { matched: 0, sent: 0, failed: 0, error: String(err.message || err).slice(0, 300) };
    }
    // Nobody matched and root mail was not sent: the alert is not delivered.
    // It stays pending so a contact added later (or a transport installed
    // later) still receives it on the next flush.
    const addressed = result.matched > 0 || result.sent + result.failed > 0;
    if (!result.error && !addressed) result.skipped = result.skipped || 'no_recipients';
    job?.log(`administrators: ${result.skipped ? `skipped (${result.skipped})${addressed ? '' : '; the alert stays waiting until a contact subscribes to security.alert or root mail is routed'}` : `${result.sent} sent, ${result.failed} failed of ${result.matched} contact(s)`}${result.error ? ` — ${result.error}` : ''}`, result.error || !addressed ? 'warn' : 'info');
    if (result.error) for (const a of rows) stmts.markAdmins.run(JSON.stringify(result), 'failed', a.id);
    else if (!addressed) for (const a of rows) stmts.markAdminsWaiting.run(JSON.stringify(result), a.id);
    else for (const a of rows) stmts.markAdmins.run(JSON.stringify(result), 'sent', a.id);
    return { ...result, addressed };
  }

  async function notifyAccounts(rows, job) {
    const host = hostname();
    const product = productName();
    const summary = { recipients: 0, addresses: 0, sent: 0, failed: 0, skipped: 0, skippedReason: null };
    const mark = (sent) => { for (const a of rows) stmts.markAccounts.run({ id: a.id, sent: sent ? 1 : 0, result: JSON.stringify(summary) }); };
    if (!ctx.contacts?.mailTransport?.()) {
      summary.skippedReason = 'no_mail_transport';
      job?.log('accounts: skipped, Exim is not installed and no SMTP relay is configured', 'warn');
      mark(false);
      return summary;
    }
    const byAddress = new Map();
    for (const acc of stmts.recipients.all()) {
      const address = String(acc.contact_email).trim();
      if (!EMAIL_RE.test(address)) { summary.skipped++; continue; }
      summary.recipients++;
      if (!byAddress.has(address)) byAddress.set(address, []);
      byAddress.get(address).push(acc);
    }
    summary.addresses = byAddress.size;
    const entries = [...byAddress.entries()];
    job?.log(`accounts: ${summary.recipients} account(s) with a contact address (${entries.length} distinct)${summary.skipped ? `, ${summary.skipped} unusable address(es) skipped` : ''}`);
    for (let i = 0; i < entries.length; i += ACCOUNT_CHUNK) {
      if (i > 0) await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
      for (const [address, accounts] of entries.slice(i, i + ACCOUNT_CHUNK)) {
        // One mail per account per alert: an alert already sent to every
        // account behind this address is left out of its mail.
        const claimed = db.transaction(() => {
          const out = [];
          for (const a of rows) {
            const accountIds = accounts.filter((acc) => stmts.claim.run({ alert_id: a.id, account_id: acc.id, username: acc.username, address }).changes > 0).map((acc) => acc.id);
            if (accountIds.length) out.push({ alert: a, accountIds });
          }
          return out;
        })();
        if (!claimed.length) continue;
        const mail = renderMail(claimed.map((c) => shape(c.alert)), { audience: 'accounts', host, panelUrl: panelUrl(), product, accounts });
        if (!mail.count) continue;
        let status = 'sent';
        let error = null;
        try {
          await ctx.contacts.mail({ to: address, subject: mail.subject, body: mail.text, html: mail.html });
          summary.sent++;
        } catch (err) {
          status = 'failed';
          error = String(err.message || err).slice(0, 300);
          summary.failed++;
          job?.log(`accounts: ${accounts.map((a) => a.username).join(', ')} <${address}>: ${error}`, 'warn');
        }
        for (const c of claimed) for (const accountId of c.accountIds) stmts.finishDelivery.run({ status, error, alert_id: c.alert.id, account_id: accountId });
      }
      job?.progress(40 + Math.round(((Math.min(i + ACCOUNT_CHUNK, entries.length)) / Math.max(1, entries.length)) * 55), `accounts: ${summary.sent} sent, ${summary.failed} failed`);
    }
    job?.log(`accounts: ${summary.sent} mail(s) sent, ${summary.failed} failed`);
    mark(summary.sent > 0);
    return summary;
  }

  // A test or a notice carries the admin's own audience choice on the row, so a
  // generic flush (boot, digest timer, "deliver now") never mails accounts a
  // test or an admin-only notice because the global setting is on.
  function wantsAccounts(row, params, cfg) {
    if (kindOf(row.kind).audience !== 'all') return false;
    if (row.kind === 'test' || row.kind === 'manual') return Boolean(params.includeAccounts ?? json.parse(row.data_json, {}).notifyAccounts);
    return Boolean(params.includeAccounts ?? cfg.notifyAccounts);
  }

  // The job worker runs two jobs at once; deliveries are serialised so a second
  // flush only sees rows the first one has already marked.
  let delivering = Promise.resolve();
  function deliverJob(job) {
    const run = delivering.then(() => runDelivery(job));
    delivering = run.catch(() => {});
    return run;
  }

  async function runDelivery(job) {
    const cfg = config();
    const params = job.params || {};
    if (!cfg.enabled && !params.manual) { job.log('security notifications are disabled; nothing delivered'); return { skipped: 'disabled', delivered: 0 }; }
    const ids = Array.isArray(params.alertIds) ? params.alertIds.map(Number).filter(Number.isInteger) : null;
    const rows = ids ? stmts.byIds(ids).filter((a) => a.state !== 'skipped') : stmts.pending.all();
    if (!rows.length) { job.log('no pending security alerts'); return { delivered: 0 }; }
    job.log(`${rows.length} alert(s): ${rows.map((a) => `#${a.id} ${a.kind} (${a.severity})`).join(', ')}`);
    job.progress(10, 'notifying administrators');
    const admins = await notifyAdmins(rows, job);
    const toAccounts = Boolean(params.includeAccounts ?? cfg.notifyAccounts);
    const accountRows = rows.filter((a) => wantsAccounts(a, params, cfg));
    let accounts = null;
    job.progress(40, 'notifying accounts');
    if (accountRows.length) accounts = await notifyAccounts(accountRows, job);
    const skippedRows = rows.filter((a) => !accountRows.includes(a));
    if (skippedRows.length) {
      const reasons = new Set();
      for (const a of skippedRows) {
        const reason = toAccounts && kindOf(a.kind).audience !== 'all' ? 'admins_only' : 'notify_accounts_off';
        reasons.add(reason);
        stmts.markAccounts.run({ id: a.id, sent: 0, result: JSON.stringify({ skipped: reason }) });
      }
      job.log(`accounts: ${accountRows.length ? `${skippedRows.length} alert(s) ` : ''}skipped (${[...reasons].map((r) => (r === 'notify_accounts_off' ? 'account notifications are off for them' : 'these alert kinds are for administrators only')).join('; ')})`);
    }
    if (admins.addressed) settings.set('security.alerts.last_delivery_at', new Date().toISOString());
    job.progress(100, 'done');
    const result = { delivered: rows.length, alertIds: rows.map((a) => a.id), admins, accounts };
    ctx.auditRecord?.(null, { action: 'security.alerts.deliver', target: rows.map((a) => a.id).join(','), args: { alerts: rows.length, admins: { sent: admins.sent, failed: admins.failed }, accounts: accounts ? { sent: accounts.sent, failed: accounts.failed } : null, manual: Boolean(params.manual) } });
    return result;
  }

  // --------------------------------------------------------------- read API ---

  function list({ limit = 20 } = {}) {
    return stmts.recent.all(Math.min(200, Math.max(1, Number(limit) || 20))).map((row) => {
      const a = shape(row);
      const deliveries = Object.fromEntries(stmts.deliveriesFor.all(row.id).map((r) => [r.status, r.n]));
      return { ...a, accountDeliveries: deliveries };
    });
  }

  function subscribedContacts() {
    try {
      return (ctx.contacts?.list?.() || []).filter((c) => c.enabled && (c.allEvents || c.events.includes(ALERT_EVENT)) && severityRank('critical') >= severityRank(c.minSeverity)).length;
    } catch { return 0; }
  }
  const rootMailRouted = () => (settings.get('contacts.root_mail_events', []) || []).includes(ALERT_EVENT);

  // Alerts that found nobody to tell wait as pending; the contacts service
  // calls this after a contact or the root-mail routing changes so they go out
  // as soon as somebody can receive them.
  function recipientsChanged() {
    if (!config().enabled || stmts.pendingCount.get().n === 0) return 'none';
    if (subscribedContacts() === 0 && !rootMailRouted()) return 'no_recipients';
    return scheduleDelivery();
  }

  function overview() {
    const stats = stmts.stats.get();
    const cfg = config();
    return {
      settings: cfg,
      event: ALERT_EVENT,
      kinds: Object.entries(KINDS).map(([key, k]) => ({ key, ...k })),
      capability: { mailTransport: ctx.contacts?.mailTransport?.() ?? null, contactsSubscribed: subscribedContacts(), rootMail: rootMailRouted(), accountRecipients: stmts.recipientCount.get().n },
      stats: { total: stats.total || 0, last24h: stats.last24h || 0, pending: stats.pending || 0 },
      digest: { due: digestDue(cfg), windowRemainingMs: windowRemainingMs(cfg) },
      panelUrl: panelUrl(),
      alerts: list({ limit: 20 }),
    };
  }

  function updateSettings(patch, req) {
    const values = {};
    if (patch.enabled !== undefined) values['security.alerts.enabled'] = Boolean(patch.enabled);
    if (patch.notifyAccounts !== undefined) values['security.alerts.notify_accounts'] = Boolean(patch.notifyAccounts);
    if (patch.minSeverity !== undefined) values['security.alerts.min_severity'] = patch.minSeverity;
    if (patch.digestMinutes !== undefined) values['security.alerts.digest_minutes'] = patch.digestMinutes;
    settings.setMany(values);
    audit(req, { action: 'security.alerts.settings', args: patch });
    const cfg = config();
    if (cfg.enabled && stmts.pendingCount.get().n > 0) scheduleDelivery();
    return cfg;
  }

  function requireEnabled() {
    if (!config().enabled) throw unprocessable('Security notifications are turned off; enable them in Contact Manager first', { enabled: ['Turn on security notifications first'] });
  }

  // A test is delivered on its own, right away, bypassing the digest window
  // and the minimum severity; accounts only when the admin asks for it.
  function test({ includeAccounts = false } = {}, req) {
    requireEnabled();
    const host = hostname();
    const r = raise({ kind: 'test', title: `Test security alert from ${productName()} on ${host}`, body: `Sent by ${req?.user?.username || 'the panel'} at ${new Date().toISOString()} to check how security alerts reach ${includeAccounts ? 'administrators and hosting accounts' : 'administrators'}. Nothing happened.`, dedupeKey: `test:${crypto.randomUUID()}`, source: 'contact-manager', data: { sentBy: req?.user?.username || null, notifyAccounts: Boolean(includeAccounts) }, force: true, defer: true }, req);
    const job = enqueue({ alertIds: [r.alert.id], includeAccounts: Boolean(includeAccounts), manual: true, requestedBy: req?.user?.username ?? null }, req?.user?.id ?? null);
    audit(req, { action: 'security.alerts.test', target: String(r.alert.id), args: { includeAccounts: Boolean(includeAccounts), jobId: job.id } });
    return { job, alert: r.alert };
  }

  // An administrator's own notice ("an emergency update was pushed"), mailed to
  // administrators and, when asked, to every hosting account.
  function broadcast({ title, body, severity, notifyAccounts }, req) {
    requireEnabled();
    const toAccounts = notifyAccounts ?? config().notifyAccounts;
    if (toAccounts && !ctx.contacts?.mailTransport?.()) throw new CapabilityError('exim', 'Exim is not installed and no SMTP relay is configured, so hosting accounts cannot be mailed. Install Exim or configure an SMTP relay in Contact Manager.');
    const r = raise({ kind: 'manual', severity, title, body, dedupeKey: `manual:${crypto.randomUUID()}`, source: 'contact-manager', data: { sentBy: req?.user?.username || null, notifyAccounts: Boolean(toAccounts) }, force: true, defer: true }, req);
    const job = enqueue({ alertIds: [r.alert.id], includeAccounts: Boolean(toAccounts), manual: true, requestedBy: req?.user?.username ?? null }, req?.user?.id ?? null);
    audit(req, { action: 'security.alerts.broadcast', target: String(r.alert.id), args: { title: r.alert.title, severity: r.alert.severity, notifyAccounts: Boolean(toAccounts), jobId: job.id } });
    return { job, alert: r.alert };
  }

  function deliverNow(req) {
    requireEnabled();
    const pending = stmts.pendingCount.get().n;
    if (!pending) throw unprocessable('No security alert is waiting to be delivered');
    const job = enqueue({ manual: true, requestedBy: req?.user?.username ?? null }, req?.user?.id ?? null);
    audit(req, { action: 'security.alerts.deliver_now', args: { pending, jobId: job.id } });
    return { job, pending };
  }

  return {
    JOB, ALERT_EVENT, KINDS, DEDUPE_WINDOW_MS,
    config, raise, onAdvisorScan, scheduleDelivery, recipientsChanged, deliverJob, list, overview, updateSettings, test, broadcast, deliverNow,
    renderMail: (alerts, opts = {}) => renderMail(alerts, { host: hostname(), panelUrl: panelUrl(), product: productName(), ...opts }),
    pendingCount: () => stmts.pendingCount.get().n,
    get: (id) => shape(stmts.byId.get(id)),
    stop() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}
