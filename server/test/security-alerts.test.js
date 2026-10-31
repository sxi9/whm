import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { renderMail, accountText, KINDS, ALERT_EVENT, JOB } from '../src/services/security-alerts.js';
import { EVENTS } from '../src/services/server-contacts.js';

const applied = { id: 7, kind: 'updates.security_applied', severity: 'critical', title: 'Emergency security update applied: 2 packages on panel.example.com', body: 'libssl3 3.0.1 -> 3.0.2\nopenssh-server 9.6 -> 9.7', createdAt: '2026-10-30 10:00:00', data: { count: 2, packages: ['libssl3', 'openssh-server'], rebootRequired: true, jobId: 41 } };
const finding = { id: 3, kind: 'advisor.critical', severity: 'critical', title: '/etc/shadow is too permissive (0644)', body: 'Expected at most 0640.\nFix: Security Advisor (/security-center/security-advisor)', createdAt: '2026-10-30 09:00:00', data: { findingId: 'fs./etc/shadow', fix: { label: 'Security Advisor', path: '/security-center/security-advisor' } } };
const opts = { host: 'panel.example.com', panelUrl: 'https://panel.example.com:2087', product: 'HST Panel' };

describe('security alert mail templates', () => {
  it('writes the admin mail with what happened, what the panel did, when and a panel link, as text and HTML', () => {
    const mail = renderMail(applied, opts);
    expect(mail.subject).toBe('[HST Panel] Security alert: Emergency security update applied: 2 packages on panel.example.com');
    expect(mail.text).toContain('What happened');
    expect(mail.text).toContain('libssl3 3.0.1 -> 3.0.2');
    expect(mail.text).toContain('What the panel did');
    expect(mail.text).toContain('The panel applied the updates (job #41). A reboot is required to finish: https://panel.example.com:2087/system-reboot/graceful-server-reboot');
    expect(mail.text).toContain('When\n  2026-10-30 10:00:00 UTC');
    expect(mail.text).toContain('Open the panel: https://panel.example.com:2087/software/system-update');
    expect(mail.html).toContain('<h1 style="margin:0 0 16px;font-size:20px">Security alert: Emergency security update applied');
    expect(mail.html).toContain('href="https://panel.example.com:2087"');
    expect(mail.severity).toBe('critical');
  });

  it('groups several alerts into one digest and escapes HTML', () => {
    const mail = renderMail([finding, { ...applied, title: 'Update <script>alert(1)</script>' }], opts);
    expect(mail.subject).toBe('[HST Panel] 2 security alerts on panel.example.com (critical)');
    expect(mail.text).toContain('CRITICAL · Security Advisor critical finding');
    expect(mail.text).toContain('Fix it from Security Advisor: https://panel.example.com:2087/security-center/security-advisor');
    expect(mail.html).toContain('Update &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.count).toBe(2);
  });

  it('never sends finding details to accounts: only account-facing kinds render, without the admin body', () => {
    expect(accountText(finding, opts)).toBeNull();
    const mail = renderMail([finding, applied], { ...opts, audience: 'accounts', accounts: [{ username: 'alice', domain: 'alice.example' }] });
    expect(mail.count).toBe(1);
    expect(mail.subject).toBe('[HST Panel] Emergency security update applied: 2 packages on panel.example.com');
    expect(mail.text).toContain('An emergency security update was applied to the server panel.example.com that hosts alice (alice.example).');
    expect(mail.text).toContain('2 packages (libssl3, openssh-server) received security fixes; the server will be restarted shortly');
    expect(mail.text).toContain('Hosting control panel: https://panel.example.com:2087');
    expect(mail.text).not.toContain('3.0.1 -> 3.0.2');
    expect(mail.text).not.toContain('/etc/shadow');
    expect(mail.html).not.toContain('/etc/shadow');
    expect(renderMail([finding], { ...opts, audience: 'accounts' }).count).toBe(0);
  });

  it('declares the kinds with their audience and the contacts event', () => {
    expect(Object.entries(KINDS).filter(([, k]) => k.audience === 'all').map(([key]) => key).sort()).toEqual(['manual', 'test', 'updates.security_applied']);
    expect(EVENTS.find((e) => e.key === ALERT_EVENT)).toMatchObject({ severity: 'critical', group: 'Security', wired: true });
  });
});

describe('security alerts service and routes', () => {
  let app;
  let csrf;
  let reseller;
  let resellerCsrf;
  let bins = {};
  let sent = [];
  let upgradable = { manager: 'apt', count: 0, security: 0, packages: [], rebootRequired: false };
  let feed = null;
  let feedUrl = '';
  let defaultRootMailEvents = null;
  const migration037b = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations/037b_security-alerts-root-mail.sql');
  const until = async (fn, timeoutMs = 5000) => { const started = Date.now(); while (!fn()) { if (Date.now() - started > timeoutMs) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 25)); } };
  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const put = (url, body = {}) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
  const get = (url) => app.http.get(url);
  const alerts = () => app.ctx.securityAlerts.list({ limit: 50 });
  const lastDeliverJob = () => app.ctx.jobs.list({ type: JOB, limit: 1 })[0];
  const waitDelivery = async () => { const j = lastDeliverJob(); expect(j).toBeTruthy(); return waitForJob(app.ctx, j.id); };
  const rootId = () => app.ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get().id;
  const addAccount = (username, email, suspended = 0) => app.ctx.db.prepare('INSERT INTO accounts (username, domain, owner_id, contact_email, suspended) VALUES (?, ?, ?, ?, ?)').run(username, `${username}.example`, rootId(), email, suspended);

  // Replaces contacts.notify for one test so the exact security.alert payload
  // can be asserted; other events (updates.available from Server Configuration)
  // keep their real path.
  async function withNotifySpy(fn) {
    const calls = [];
    const original = app.ctx.contacts.notify;
    app.ctx.contacts.notify = async (event, payload, req) => {
      if (event !== ALERT_EVENT) return original(event, payload, req);
      calls.push({ event, payload });
      return { event, matched: 1, sent: 1, failed: 0, deliveries: [] };
    };
    try { return await fn(calls); } finally { app.ctx.contacts.notify = original; }
  }

  beforeAll(async () => {
    feed = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: '99.0.0', url: 'https://example.com/whm-99.tar.gz', notes: 'Fixes CVE-2026-1 in the session layer', security: true })); });
    await new Promise((r) => feed.listen(0, '127.0.0.1', r));
    feedUrl = `http://127.0.0.1:${feed.address().port}/latest.json`;
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(bins[n])])),
      'mail.sendmail': (args) => { sent.push(args); return { from: args.from, to: args.to, accepted: true, bytes: 100 }; },
      'pkg.upgradable': () => upgradable,
      'pkg.update_index': () => ({ manager: 'apt', output: [] }),
      'pkg.upgrade': () => ({ manager: 'apt', output: ['done'], autoremoveOutput: [], rebootRequired: false }),
      'pkg.reboot_required': () => ({ rebootRequired: false }),
    });
    app = await createTestApp({ agent });
    defaultRootMailEvents = app.ctx.settings.get('contacts.root_mail_events');
    app.ctx.jobs.start();
    csrf = await app.login();
    const r = await app.createUser('resell1', 'reseller');
    reseller = request.agent(app.ctx.app);
    resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
  }, 30_000);

  afterAll(async () => { app?.ctx.securityAlerts.stop(); await app?.close(); await new Promise((r) => feed?.close(r)); });

  beforeEach(async () => {
    bins = { exim4: true, 'apt-get': true, 'dpkg-query': true };
    sent = [];
    upgradable = { manager: 'apt', count: 0, security: 0, packages: [], rebootRequired: false };
    await app.ctx.capabilities.refresh();
    app.ctx.securityAlerts.stop();
    for (const t of ['security_alert_deliveries', 'security_alerts', 'contacts', 'contact_deliveries', 'accounts', 'job_logs', 'jobs']) app.ctx.db.prepare(`DELETE FROM ${t}`).run();
    app.ctx.settings.setMany({ 'security.alerts.enabled': true, 'security.alerts.notify_accounts': false, 'security.alerts.min_severity': 'critical', 'security.alerts.digest_minutes': 0, 'security.alerts.last_delivery_at': null, 'contacts.enabled': true, 'contacts.root_mail_events': [], 'contacts.smtp.host': '', 'software.update_url': '' });
  });

  it('registers ctx.securityAlerts, the delivery job and the default settings', () => {
    expect(typeof app.ctx.securityAlerts.raise).toBe('function');
    expect(app.ctx.jobs.types()).toContain(JOB);
    expect(app.ctx.securityAlerts.config()).toEqual({ enabled: true, notifyAccounts: false, minSeverity: 'critical', digestMinutes: 0, lastDeliveryAt: null });
  });

  it('raise() records an alert once per dedupe key for 24 h, then retires the key', async () => {
    const first = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'Root has no 2FA', body: 'detail', dedupeKey: 'advisor:2fa.root', source: 'test', defer: true });
    expect(first).toMatchObject({ raised: true, deduped: false, delivery: 'pending' });
    expect(first.alert).toMatchObject({ kind: 'advisor.critical', severity: 'critical', state: 'pending', dedupeKey: 'advisor:2fa.root', audience: 'admins' });
    const again = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'Root has no 2FA', dedupeKey: 'advisor:2fa.root', defer: true });
    expect(again).toMatchObject({ raised: false, deduped: true });
    expect(again.alert.id).toBe(first.alert.id);
    expect(alerts()).toHaveLength(1);
    app.ctx.db.prepare("UPDATE security_alerts SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(first.alert.id);
    const later = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'Root has no 2FA', dedupeKey: 'advisor:2fa.root', defer: true });
    expect(later.raised).toBe(true);
    expect(later.alert.id).not.toBe(first.alert.id);
    expect(app.ctx.db.prepare('SELECT dedupe_key FROM security_alerts WHERE id = ?').get(first.alert.id).dedupe_key).toBe(`advisor:2fa.root#${first.alert.id}`);
    expect(later.alert.dedupeKey).toBe('advisor:2fa.root');
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'security.alerts.raise' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(audit.args_redacted)).toMatchObject({ severity: 'critical', dedupe: 'advisor:2fa.root', state: 'pending' });
    expect(() => app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'x' })).toThrow(/dedupe key/);
  });

  it('settings gate everything: disabled records nothing, the minimum severity skips delivery, the test needs the feature on', async () => {
    app.ctx.settings.set('security.alerts.enabled', false);
    expect(app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'x', dedupeKey: 'k1' })).toEqual({ raised: false, skipped: 'disabled', alert: null });
    expect(alerts()).toHaveLength(0);
    expect((await post('/api/server-contacts/security-alerts/test', {})).status).toBe(422);
    expect((await post('/api/server-contacts/security-alerts/deliver', {})).status).toBe(422);
    app.ctx.settings.set('security.alerts.enabled', true);
    await withNotifySpy(async (calls) => {
      const r = app.ctx.securityAlerts.raise({ kind: 'updates.security_available', title: '3 security updates', dedupeKey: 'k2' });
      expect(r).toMatchObject({ raised: true, delivery: 'skipped' });
      expect(r.alert.state).toBe('skipped');
      expect(lastDeliverJob()).toBeUndefined();
      expect(calls).toHaveLength(0);
      app.ctx.settings.set('security.alerts.min_severity', 'warning');
      const r2 = app.ctx.securityAlerts.raise({ kind: 'updates.security_available', title: '3 security updates', dedupeKey: 'k3' });
      expect(r2.delivery).toBe('queued');
      await waitDelivery();
      expect(calls).toHaveLength(1);
      expect(calls[0].payload.severity).toBe('warning');
    });
  });

  it('delivers to administrators through contacts.notify with the security.alert payload', async () => {
    await withNotifySpy(async (calls) => {
      const r = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: '/etc/shadow is too permissive (0644)', body: 'Expected at most 0640.', dedupeKey: 'advisor:fs./etc/shadow', source: 'security-advisor:manual', data: { findingId: 'fs./etc/shadow', fix: { label: 'Security Advisor', path: '/security-center/security-advisor' } } });
      expect(r.delivery).toBe('queued');
      const job = await waitDelivery();
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ delivered: 1, admins: { matched: 1, sent: 1, failed: 0 }, accounts: null });
      expect(calls).toHaveLength(1);
      expect(calls[0].event).toBe(ALERT_EVENT);
      expect(calls[0].payload.subject).toBe('[HST Panel] Security alert: /etc/shadow is too permissive (0644)');
      expect(calls[0].payload.severity).toBe('critical');
      expect(calls[0].payload.body).toContain('Expected at most 0640.');
      expect(calls[0].payload.body).toContain('Fix it from Security Advisor: http://panel.example.com:2086/security-center/security-advisor');
      expect(calls[0].payload.data.alerts).toEqual([expect.objectContaining({ id: r.alert.id, kind: 'advisor.critical', severity: 'critical' })]);
      const [a] = alerts();
      expect(a).toMatchObject({ state: 'sent', admin: { matched: 1, sent: 1, failed: 0 }, accounts: { skipped: 'notify_accounts_off' } });
      expect(a.notifiedAdminsAt).toBeTruthy();
      expect(a.notifiedAccountsAt).toBeNull();
      expect(app.ctx.securityAlerts.config().lastDeliveryAt).toBeTruthy();
    });
  });

  it('reaches a real email contact subscribed to security.alert through Exim', async () => {
    expect((await post('/api/server-contacts/contacts', { name: 'Ops', channel: 'email', address: 'ops@example.com', events: ['security.alert'] })).status).toBe(201);
    app.ctx.securityAlerts.raise({ kind: 'panel.security_release', title: 'Panel security release 9.9.9 is available', body: 'notes', dedupeKey: 'panel.security_release:9.9.9' });
    const job = await waitDelivery();
    expect(job.result.admins).toMatchObject({ matched: 1, sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ops@example.com']);
    expect(sent[0].subject).toBe('[panel.example.com] [HST Panel] Security alert: Panel security release 9.9.9 is available');
    expect(sent[0].text).toContain('Upgrade from Upgrade to Latest Version');
    expect(app.ctx.db.prepare("SELECT event, status FROM contact_deliveries WHERE event = 'security.alert'").all()).toEqual([{ event: 'security.alert', status: 'sent' }]);
  });

  it('mails every hosting account once per alert when notify_accounts is on, never for admin-only kinds', async () => {
    addAccount('alice', 'alice@example.org');
    addAccount('bob', 'bob@example.org');
    addAccount('carol', 'alice@example.org');
    addAccount('dave', null);
    addAccount('erin', 'erin@example.org', 1);
    app.ctx.settings.set('security.alerts.notify_accounts', true);
    const r = app.ctx.securityAlerts.raise({ kind: 'updates.security_applied', title: 'Emergency security update applied: 1 package on panel.example.com', body: 'libssl3 3.0.1 -> 3.0.2', dedupeKey: 'updates.security_applied:1', data: { count: 1, packages: ['libssl3'], rebootRequired: false, jobId: 1 } });
    const job = await waitDelivery();
    expect(job.status).toBe('done');
    expect(job.result.accounts).toMatchObject({ recipients: 3, addresses: 2, sent: 2, failed: 0, skipped: 0 });
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['alice@example.org', 'bob@example.org']);
    const toAlice = sent.find((m) => m.to[0] === 'alice@example.org');
    expect(toAlice.subject).toBe('[HST Panel] Emergency security update applied: 1 package on panel.example.com');
    expect(toAlice.text).toContain('that hosts alice (alice.example), carol (carol.example)');
    expect(toAlice.text).toContain('1 package (libssl3) received security fixes.');
    expect(toAlice.text).not.toContain('3.0.1 -> 3.0.2');
    const rows = app.ctx.db.prepare('SELECT username, address, status FROM security_alert_deliveries WHERE alert_id = ? ORDER BY username').all(r.alert.id);
    expect(rows).toEqual([{ username: 'alice', address: 'alice@example.org', status: 'sent' }, { username: 'bob', address: 'bob@example.org', status: 'sent' }, { username: 'carol', address: 'alice@example.org', status: 'sent' }]);
    const [a] = alerts();
    expect(a.notifiedAccountsAt).toBeTruthy();
    expect(a.accountDeliveries).toEqual({ sent: 3 });
    // A second delivery of the same alert sends nothing more.
    sent = [];
    const again = app.ctx.jobs.enqueue(JOB, { alertIds: [r.alert.id], manual: true });
    expect((await waitForJob(app.ctx, again.id)).result.accounts).toMatchObject({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
    // Admin-only kinds are never mailed to accounts, whatever the setting.
    const critical = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'Root has no 2FA', body: 'secret detail', dedupeKey: 'advisor:2fa.root' });
    await waitDelivery();
    expect(sent).toHaveLength(0);
    expect(app.ctx.securityAlerts.get(critical.alert.id).accounts).toEqual({ skipped: 'admins_only' });
    // Without a mail transport the account step is skipped and recorded.
    bins = {};
    await app.ctx.capabilities.refresh();
    app.ctx.securityAlerts.raise({ kind: 'updates.security_applied', title: 'Applied', body: '', dedupeKey: 'updates.security_applied:2', data: { count: 1, packages: ['bash'] } });
    const skipped = await waitDelivery();
    expect(skipped.result.accounts).toMatchObject({ skippedReason: 'no_mail_transport', sent: 0 });
  });

  it('a Security Advisor scan raises one alert per critical finding new since the previous run', async () => {
    await withNotifySpy(async (calls) => {
      const res = await post('/api/security/advisor/scan');
      expect(res.status).toBe(200);
      const criticalIds = res.body.data.findings.filter((f) => f.grade === 'critical').map((f) => f.id);
      expect(criticalIds).toContain('2fa.root');
      expect(res.body.data.alerts.raised).toBe(criticalIds.length);
      const raised = alerts();
      expect(raised.map((a) => a.dedupeKey).sort()).toEqual(criticalIds.map((id) => `advisor:${id}`).sort());
      const twofa = raised.find((a) => a.dedupeKey === 'advisor:2fa.root');
      expect(twofa).toMatchObject({ kind: 'advisor.critical', severity: 'critical', source: 'security-advisor:manual', data: { findingId: '2fa.root', fix: { path: '/security-center/two-factor-authentication' } } });
      expect(twofa.body).toContain('Fix: Two-Factor Authentication (/security-center/two-factor-authentication)');
      await waitDelivery();
      expect(calls).toHaveLength(1);
      expect(calls[0].payload.subject).toMatch(criticalIds.length > 1 ? /security alerts on panel.example.com/ : /Security alert:/);
      // The same findings in the next run are not new.
      const again = await post('/api/security/advisor/scan');
      expect(again.body.data.alerts.raised).toBe(0);
      expect(alerts()).toHaveLength(criticalIds.length);
    });
  });

  it('the OS update check raises updates.security_available and an applied run raises updates.security_applied', async () => {
    upgradable = { manager: 'apt', count: 2, security: 1, packages: [{ name: 'libssl3', current: '3.0.1', candidate: '3.0.2', security: true }, { name: 'vim', current: '9.0', candidate: '9.1', security: false }], rebootRequired: false };
    await withNotifySpy(async (calls) => {
      app.ctx.settings.set('security.alerts.min_severity', 'warning');
      const check = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.update.check', {}).id);
      expect(check.status).toBe('done');
      let list = alerts();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ kind: 'updates.security_available', severity: 'warning', title: '1 security update available on panel.example.com', body: 'libssl3', data: { count: 2, security: 1, packages: ['libssl3'], autoApply: false } });
      expect(list[0].dedupeKey).toMatch(/^updates\.security_available:[0-9a-f]{16}$/);
      await waitDelivery();
      expect(calls).toHaveLength(1);
      // The same pending set the next day is one alert, not two.
      await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.update.check', {}).id);
      expect(alerts()).toHaveLength(1);
      const run = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.system.update', { dist: true, autoremove: false, refreshIndex: false }).id);
      expect(run.status).toBe('done');
      expect(run.result).toMatchObject({ upgraded: 2, securityApplied: 1 });
      list = alerts();
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ kind: 'updates.security_applied', severity: 'critical', audience: 'all', dedupeKey: `updates.security_applied:${run.id}`, data: { count: 1, packages: ['libssl3'], rebootRequired: false, jobId: run.id } });
      expect(list[0].body).toBe('libssl3 3.0.1 -> 3.0.2');
      await waitDelivery();
      expect(calls).toHaveLength(2);
      expect(calls[1].payload.subject).toContain('Emergency security update applied');
    });
  });

  it('a panel release flagged as a security release raises panel.security_release once per version', async () => {
    app.ctx.settings.set('software.update_url', feedUrl);
    await withNotifySpy(async (calls) => {
      const res = await post('/api/software/panel/update/check');
      expect(res.status).toBe(200);
      expect(res.body.data.latest).toMatchObject({ version: '99.0.0', security: true });
      expect(res.body.data.updateAvailable).toBe(true);
      const list = alerts();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ kind: 'panel.security_release', title: `Panel security release 99.0.0 is available (running ${app.ctx.version})`, body: 'Fixes CVE-2026-1 in the session layer', dedupeKey: 'panel.security_release:99.0.0', data: { version: '99.0.0', url: 'https://example.com/whm-99.tar.gz' } });
      await post('/api/software/panel/update/check');
      expect(alerts()).toHaveLength(1);
      await waitDelivery();
      expect(calls).toHaveLength(1);
    });
  });

  it('holds alerts raised inside the digest window and flushes them on demand', async () => {
    app.ctx.settings.setMany({ 'security.alerts.digest_minutes': 60, 'security.alerts.last_delivery_at': new Date().toISOString() });
    await withNotifySpy(async (calls) => {
      const r = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'A', dedupeKey: 'd1' });
      expect(r.delivery).toBe('held');
      app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'B', dedupeKey: 'd2' });
      expect(alerts().map((a) => a.state)).toEqual(['held', 'held']);
      expect(lastDeliverJob()).toBeUndefined();
      const overview = (await get('/api/server-contacts/security-alerts')).body.data;
      expect(overview.stats.pending).toBe(2);
      expect(overview.digest.due).toBe(false);
      const flush = await post('/api/server-contacts/security-alerts/deliver');
      expect(flush.status).toBe(202);
      expect(flush.body.data.pending).toBe(2);
      const job = await waitForJob(app.ctx, flush.body.data.job.id);
      expect(job.result.delivered).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0].payload.subject).toBe('[HST Panel] 2 security alerts on panel.example.com (critical)');
      expect(alerts().map((a) => a.state)).toEqual(['sent', 'sent']);
      // Once the window has passed, a new alert goes out right away.
      app.ctx.settings.set('security.alerts.last_delivery_at', new Date(Date.now() - 61 * 60_000).toISOString());
      expect(app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'C', dedupeKey: 'd3' }).delivery).toBe('queued');
      await waitDelivery();
      expect(calls).toHaveLength(2);
    });
  });

  it('test alerts and administrator notices go out right away; the notice reaches accounts verbatim', async () => {
    addAccount('alice', 'alice@example.org');
    await withNotifySpy(async (calls) => {
      const test = await post('/api/server-contacts/security-alerts/test', {});
      expect(test.status).toBe(202);
      expect(test.body.data.alert).toMatchObject({ kind: 'test', severity: 'info', state: 'pending' });
      const job = await waitForJob(app.ctx, test.body.data.job.id);
      expect(job.result).toMatchObject({ delivered: 1, admins: { sent: 1 } });
      expect(calls[0].payload.subject).toBe('[HST Panel] Security alert: Test security alert from HST Panel on panel.example.com');
      expect(sent).toHaveLength(0);
      const withAccounts = await post('/api/server-contacts/security-alerts/test', { includeAccounts: true });
      await waitForJob(app.ctx, withAccounts.body.data.job.id);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain('This is a test of the security notifications sent by HST Panel on panel.example.com that hosts alice (alice.example). Nothing happened');
      sent = [];
      const notice = await post('/api/server-contacts/security-alerts/raise', { title: 'Emergency update pushed', body: 'We patched the mail server tonight.\nPlease reset weak passwords.', notifyAccounts: true });
      expect(notice.status).toBe(202);
      expect(notice.body.data.alert).toMatchObject({ kind: 'manual', severity: 'critical', data: { sentBy: 'root', notifyAccounts: true } });
      const sentJob = await waitForJob(app.ctx, notice.body.data.job.id);
      expect(sentJob.result.accounts).toMatchObject({ sent: 1 });
      expect(sent[0].subject).toBe('[HST Panel] Emergency update pushed');
      expect(sent[0].text).toContain('We patched the mail server tonight.\n  Please reset weak passwords.');
      expect(calls).toHaveLength(3);
      expect(calls[2].payload.body).toContain('Sent by root from Contact Manager.');
      const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'security.alerts.broadcast'").get();
      expect(JSON.parse(audit.args_redacted)).toMatchObject({ title: 'Emergency update pushed', notifyAccounts: true });
      expect(audit.args_redacted).not.toContain('mail server tonight');
      // Accounts cannot be mailed without a transport.
      bins = {};
      await app.ctx.capabilities.refresh();
      expect((await post('/api/server-contacts/security-alerts/raise', { title: 'x', body: 'y', notifyAccounts: true })).status).toBe(501);
    });
  });

  it('overview and settings round-trip; validation and reseller access are refused', async () => {
    addAccount('alice', 'alice@example.org');
    const overview = (await get('/api/server-contacts/security-alerts')).body.data;
    expect(overview.settings).toEqual({ enabled: true, notifyAccounts: false, minSeverity: 'critical', digestMinutes: 0, lastDeliveryAt: null });
    expect(overview.event).toBe('security.alert');
    expect(overview.kinds.map((k) => k.key)).toEqual(Object.keys(KINDS));
    expect(overview.capability).toMatchObject({ mailTransport: 'exim', contactsSubscribed: 0, rootMail: false, accountRecipients: 1 });
    app.ctx.settings.set('contacts.root_mail_events', defaultRootMailEvents);
    expect((await get('/api/server-contacts/security-alerts')).body.data.capability.rootMail).toBe(true);
    app.ctx.settings.set('contacts.root_mail_events', []);
    expect(overview.panelUrl).toBe('http://panel.example.com:2086');
    expect(overview.alerts).toEqual([]);
    const saved = await put('/api/server-contacts/security-alerts/settings', { notifyAccounts: true, minSeverity: 'warning', digestMinutes: 15 });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ enabled: true, notifyAccounts: true, minSeverity: 'warning', digestMinutes: 15 });
    expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'security.alerts.settings' ORDER BY id DESC LIMIT 1").get().args_redacted)).toEqual({ notifyAccounts: true, minSeverity: 'warning', digestMinutes: 15 });
    expect((await put('/api/server-contacts/security-alerts/settings', { minSeverity: 'urgent' })).status).toBe(422);
    expect((await put('/api/server-contacts/security-alerts/settings', { digestMinutes: 100_000 })).status).toBe(422);
    expect((await put('/api/server-contacts/security-alerts/settings', {})).status).toBe(422);
    expect((await post('/api/server-contacts/security-alerts/raise', { title: 'x' })).status).toBe(422);
    expect((await get('/api/server-contacts/security-alerts/alerts?limit=0')).status).toBe(422);
    expect((await get('/api/server-contacts/security-alerts/alerts?limit=5')).body.data).toEqual([]);
    for (const [method, url, body] of [['get', '/api/server-contacts/security-alerts'], ['get', '/api/server-contacts/security-alerts/alerts'], ['put', '/api/server-contacts/security-alerts/settings', { enabled: false }], ['post', '/api/server-contacts/security-alerts/test', {}], ['post', '/api/server-contacts/security-alerts/raise', { title: 'x', body: 'y' }], ['post', '/api/server-contacts/security-alerts/deliver', {}]]) {
      const res = await reseller[method](url).set('X-CSRF-Token', resellerCsrf).send(body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(app.ctx.securityAlerts.config().enabled).toBe(true);
  });

  it('routes security.alert to root mail out of the box; migration 037b is idempotent and keeps an operator list', () => {
    expect(defaultRootMailEvents).toContain('security.alert');
    expect(defaultRootMailEvents).toContain('service.down');
    const sql = fs.readFileSync(migration037b, 'utf8');
    app.ctx.settings.set('contacts.root_mail_events', ['backup.failed']);
    app.ctx.db.exec(sql);
    app.ctx.db.exec(sql);
    expect(app.ctx.settings.get('contacts.root_mail_events')).toEqual(['backup.failed', 'security.alert']);
    app.ctx.db.prepare("DELETE FROM settings WHERE key = 'contacts.root_mail_events'").run();
    app.ctx.db.exec(sql);
    expect(app.ctx.settings.get('contacts.root_mail_events')).toEqual(defaultRootMailEvents);
  });

  it('an alert nobody can receive stays pending and goes out once a contact subscribes', async () => {
    expect(app.ctx.securityAlerts.recipientsChanged()).toBe('none');
    const r = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'Root has no 2FA', body: 'detail', dedupeKey: 'advisor:2fa.root' });
    expect(r.delivery).toBe('queued');
    const job = await waitDelivery();
    expect(job.status).toBe('done');
    expect(job.result.admins).toMatchObject({ matched: 0, sent: 0, failed: 0, skipped: 'no_recipients', addressed: false });
    expect(app.ctx.securityAlerts.get(r.alert.id)).toMatchObject({ state: 'pending', admin: { skipped: 'no_recipients' }, notifiedAdminsAt: null });
    expect(app.ctx.securityAlerts.config().lastDeliveryAt).toBeNull();
    expect((await get('/api/server-contacts/security-alerts')).body.data.stats.pending).toBe(1);
    expect(app.ctx.jobs.get(job.id).logs.some((l) => l.level === 'warn' && /stays waiting/.test(l.line))).toBe(true);
    expect(sent).toHaveLength(0);
    expect(app.ctx.securityAlerts.recipientsChanged()).toBe('no_recipients');
    // A contact subscribed to the event triggers the retry.
    expect((await post('/api/server-contacts/contacts', { name: 'Ops', channel: 'email', address: 'ops@example.com', events: ['security.alert'] })).status).toBe(201);
    const retry = await waitDelivery();
    expect(retry.id).not.toBe(job.id);
    expect(retry.result.admins).toMatchObject({ matched: 1, sent: 1, addressed: true });
    expect(sent.map((m) => m.to[0])).toEqual(['ops@example.com']);
    const a = app.ctx.securityAlerts.get(r.alert.id);
    expect(a.state).toBe('sent');
    expect(a.notifiedAdminsAt).toBeTruthy();
    expect(app.ctx.securityAlerts.config().lastDeliveryAt).toBeTruthy();
    // Routing the event to root mail schedules the waiting alerts as well.
    app.ctx.db.prepare('DELETE FROM contacts').run();
    sent = [];
    const b = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'B', dedupeKey: 'advisor:b' });
    const waiting = await waitDelivery();
    expect(app.ctx.securityAlerts.get(b.alert.id).state).toBe('pending');
    expect(app.ctx.securityAlerts.recipientsChanged()).toBe('no_recipients');
    expect((await put('/api/server-contacts/mail-preferences', { rootMailEvents: ['security.alert'] })).status).toBe(200);
    const viaRoot = await waitDelivery();
    expect(viaRoot.id).not.toBe(waiting.id);
    expect(viaRoot.result.admins).toMatchObject({ addressed: true, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('Security alert: B');
    expect(app.ctx.securityAlerts.get(b.alert.id).state).toBe('sent');
    expect(app.ctx.securityAlerts.recipientsChanged()).toBe('none');
  });

  it('a generic flush honours each test or notice audience choice instead of the global setting', async () => {
    addAccount('alice', 'alice@example.org');
    app.ctx.settings.set('security.alerts.notify_accounts', true);
    await withNotifySpy(async (calls) => {
      const test = await post('/api/server-contacts/security-alerts/test', { includeAccounts: false });
      expect(test.status).toBe(202);
      expect(test.body.data.alert.data).toMatchObject({ notifyAccounts: false });
      await waitForJob(app.ctx, test.body.data.job.id);
      const notice = await post('/api/server-contacts/security-alerts/raise', { title: 'Admins only', body: 'internal', notifyAccounts: false });
      expect(notice.body.data.alert.data).toMatchObject({ notifyAccounts: false });
      await waitForJob(app.ctx, notice.body.data.job.id);
      expect(sent).toHaveLength(0);
      // The panel restarted while the one-off jobs ran: the rows are pending
      // again and the boot-time generic flush picks them up.
      app.ctx.db.prepare("UPDATE security_alerts SET state = 'pending', notified_admins_at = NULL, accounts_result_json = NULL").run();
      const flush = await post('/api/server-contacts/security-alerts/deliver');
      expect(flush.status).toBe(202);
      const job = await waitForJob(app.ctx, flush.body.data.job.id);
      expect(job.result).toMatchObject({ delivered: 2, accounts: null });
      expect(sent).toHaveLength(0);
      for (const a of alerts()) expect(a).toMatchObject({ state: 'sent', accounts: { skipped: 'notify_accounts_off' } });
      // A notice the admin did send to accounts is mailed to them by a generic flush, once.
      const toAll = app.ctx.securityAlerts.raise({ kind: 'manual', title: 'Emergency update pushed', body: 'We patched tonight.', dedupeKey: 'manual:flush', force: true, defer: true, data: { sentBy: 'root', notifyAccounts: true } });
      app.ctx.settings.set('security.alerts.notify_accounts', false);
      const flush2 = await post('/api/server-contacts/security-alerts/deliver');
      const job2 = await waitForJob(app.ctx, flush2.body.data.job.id);
      expect(job2.result.accounts).toMatchObject({ sent: 1, failed: 0 });
      expect(sent.map((m) => m.to[0])).toEqual(['alice@example.org']);
      expect(sent[0].subject).toBe('[HST Panel] Emergency update pushed');
      expect(app.ctx.securityAlerts.get(toAll.alert.id).accounts).toMatchObject({ sent: 1 });
      expect(calls).toHaveLength(4);
    });
  });

  it('deliveries run one at a time: a flush started while another runs never repeats an alert to administrators', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const original = app.ctx.contacts.notify;
    app.ctx.contacts.notify = async (event, payload, req) => {
      if (event !== ALERT_EVENT) return original(event, payload, req);
      calls.push(payload.data.alerts.map((a) => a.id));
      if (calls.length === 1) await gate;
      return { event, matched: 1, sent: 1, failed: 0, deliveries: [] };
    };
    try {
      const first = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'A', dedupeKey: 'c1' });
      const jobA = lastDeliverJob();
      await until(() => calls.length === 1);
      const second = app.ctx.securityAlerts.raise({ kind: 'advisor.critical', title: 'B', dedupeKey: 'c2' });
      expect(second.delivery).toBe('queued');
      const jobB = lastDeliverJob();
      expect(jobB.id).not.toBe(jobA.id);
      await until(() => app.ctx.jobs.get(jobB.id).status === 'running');
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(1);
      release();
      await waitForJob(app.ctx, jobA.id);
      const b = await waitForJob(app.ctx, jobB.id);
      expect(calls).toEqual([[first.alert.id], [second.alert.id]]);
      expect(b.result.alertIds).toEqual([second.alert.id]);
      expect(alerts().map((a) => a.state)).toEqual(['sent', 'sent']);
    } finally { app.ctx.contacts.notify = original; }
  });

  it('an unapplied security-update set alerts once, not on every nightly check; a new package or version alerts again', async () => {
    const libssl = { name: 'libssl3', current: '3.0.1', candidate: '3.0.2', security: true };
    upgradable = { manager: 'apt', count: 1, security: 1, packages: [libssl], rebootRequired: false };
    app.ctx.settings.setMany({ 'security.alerts.min_severity': 'warning', 'software.updates.security_alerted': null });
    const check = () => waitForJob(app.ctx, app.ctx.jobs.enqueue('software.update.check', {}).id);
    await withNotifySpy(async (calls) => {
      await check();
      expect(alerts()).toHaveLength(1);
      expect(app.ctx.settings.get('software.updates.security_alerted')).toMatchObject({ entries: ['libssl3 3.0.2'] });
      await waitDelivery();
      expect(calls).toHaveLength(1);
      // Day 2 with a slower index refresh: the 24 h key window has passed but
      // the set is the same; a page load re-recording last_check changes nothing.
      app.ctx.db.prepare("UPDATE security_alerts SET created_at = datetime('now', '-25 hours')").run();
      await app.ctx.software.update.status({ cached: false });
      const day2 = await check();
      expect(day2.status).toBe('done');
      expect(alerts()).toHaveLength(1);
      expect(app.ctx.jobs.get(day2.id).logs.some((l) => /alerted before/.test(l.line))).toBe(true);
      // A new security package joins the set.
      upgradable = { manager: 'apt', count: 2, security: 2, packages: [libssl, { name: 'openssh-server', current: '9.6', candidate: '9.7', security: true }], rebootRequired: false };
      await check();
      expect(alerts()).toHaveLength(2);
      expect(alerts()[0]).toMatchObject({ kind: 'updates.security_available', title: '2 security updates available on panel.example.com', data: { packages: ['libssl3', 'openssh-server'] } });
      // Everything applied: the record clears, so the same package with a newer candidate alerts again.
      upgradable = { manager: 'apt', count: 0, security: 0, packages: [], rebootRequired: false };
      await check();
      expect(app.ctx.settings.get('software.updates.security_alerted')).toBeNull();
      upgradable = { manager: 'apt', count: 1, security: 1, packages: [{ ...libssl, current: '3.0.2', candidate: '3.0.3' }], rebootRequired: false };
      app.ctx.db.prepare("UPDATE security_alerts SET created_at = datetime('now', '-25 hours')").run();
      await check();
      expect(alerts()).toHaveLength(3);
      expect(alerts()[0]).toMatchObject({ kind: 'updates.security_available', title: '1 security update available on panel.example.com', dedupeKey: expect.stringMatching(/^updates\.security_available:[0-9a-f]{16}$/) });
    });
  });

  it('checks the panel release feed on a schedule that runs only while an update URL is set', async () => {
    expect(app.ctx.jobs.types()).toContain('software.panel.check');
    const schedule = () => app.ctx.scheduler.list().find((s) => s.name === 'panel-update-check');
    expect(schedule()).toMatchObject({ job_type: 'software.panel.check', cron: '23 6 * * *' });
    expect(Boolean(schedule().enabled)).toBe(false);
    const skipped = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.panel.check', {}).id);
    expect(skipped.result).toEqual({ skipped: true });
    await withNotifySpy(async (calls) => {
      expect((await put('/api/software/panel/update/settings', { url: feedUrl })).status).toBe(200);
      expect(Boolean(schedule().enabled)).toBe(true);
      const job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.panel.check', {}).id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ ok: true, latest: '99.0.0', updateAvailable: true, security: true, error: null });
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]).toMatchObject({ kind: 'panel.security_release', dedupeKey: 'panel.security_release:99.0.0', source: 'software.panel.check' });
      await waitDelivery();
      expect(calls).toHaveLength(1);
      expect((await put('/api/software/panel/update/settings', { url: '' })).status).toBe(200);
      expect(Boolean(schedule().enabled)).toBe(false);
    });
  });
});
