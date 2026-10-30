import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

const auth = { user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => path.startsWith(k));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: !r, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { SecurityAlertsCard, AlertsPanel, deliveryLabel, SEVERITY_OPTIONS } = await import('../src/pages/contacts/SecurityAlerts.jsx');
const { default: SecurityAdvisor } = await import('../src/pages/fn/security-center/security-advisor.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const sentAlert = { id: 3, kind: 'updates.security_applied', kindLabel: 'Emergency security update applied', audience: 'all', severity: 'critical', title: 'Emergency security update applied: 2 packages on panel.example.com', source: 'software.system.update#41', state: 'sent', createdAt: '2026-10-30 10:00:00', notifiedAdminsAt: '2026-10-30 10:00:05', notifiedAccountsAt: '2026-10-30 10:00:09', admin: { matched: 2, sent: 2, failed: 0 }, accounts: { recipients: 14, addresses: 12, sent: 12, failed: 1 } };
const heldAlert = { id: 4, kind: 'advisor.critical', kindLabel: 'Security Advisor critical finding', audience: 'admins', severity: 'critical', title: 'The root panel user has no two-factor authentication', source: 'security-advisor:scheduled', state: 'held', createdAt: '2026-10-30 11:00:00', admin: null, accounts: null };
const skippedAlert = { id: 5, kind: 'updates.security_available', kindLabel: 'Security updates available', audience: 'admins', severity: 'warning', title: '3 security updates available on panel.example.com', state: 'skipped', createdAt: '2026-10-30 12:00:00', admin: null, accounts: null };
const overview = {
  settings: { enabled: true, notifyAccounts: false, minSeverity: 'critical', digestMinutes: 60, lastDeliveryAt: '2026-10-30T10:00:05.000Z' },
  event: 'security.alert',
  kinds: [],
  capability: { mailTransport: 'exim', contactsSubscribed: 0, rootMail: false, accountRecipients: 14 },
  stats: { total: 3, last24h: 3, pending: 1 },
  digest: { due: false, windowRemainingMs: 20 * 60_000 },
  panelUrl: 'https://panel.example.com:2087',
  alerts: [skippedAlert, heldAlert, sentAlert],
};

describe('deliveryLabel', () => {
  it('describes every delivery state', () => {
    expect(deliveryLabel(sentAlert)).toBe('administrators: 2 of 2 contacts sent · accounts: 12 mails sent, 1 failed');
    expect(deliveryLabel(heldAlert)).toBe('held for the next digest');
    expect(deliveryLabel(skippedAlert)).toBe('not sent: below the minimum severity');
    expect(deliveryLabel({ state: 'pending' })).toBe('queued for delivery');
    expect(deliveryLabel({ state: 'failed', admin: { error: 'relay down' } })).toBe('administrators: failed (relay down)');
    expect(deliveryLabel({ state: 'sent', admin: { matched: 1, sent: 1, failed: 0 }, accounts: { skipped: 'notify_accounts_off' } })).toBe('administrators: 1 of 1 contact sent · accounts: off');
    expect(deliveryLabel({ state: 'sent', admin: { matched: 0, sent: 0, failed: 0 }, accounts: { skipped: 'admins_only' } })).toBe('administrators: 0 of 0 contacts sent · accounts: administrators only');
    expect(deliveryLabel({ state: 'sent', admin: { skipped: 'disabled' }, accounts: { skippedReason: 'no_mail_transport', sent: 0 } })).toBe('administrators: skipped (disabled) · accounts: no mail transport');
  });
});

describe('SecurityAlertsCard', () => {
  it('shows the toggles, the minimum severity, the digest window, the test and notice buttons and the last alerts with their delivery state', () => {
    responses.clear();
    responses.set('/server-contacts/security-alerts', { data: overview });
    const html = render(<SecurityAlertsCard />);
    expect(html).toContain('Security notifications');
    expect(html).toContain('Raise security alerts');
    expect(html).toContain('Mail hosting accounts about emergency updates');
    expect(html).toContain('Minimum severity');
    for (const o of SEVERITY_OPTIONS) expect(html).toContain(o.label.replace(/'/g, '&#x27;'));
    expect(html).toContain('Digest window (minutes)');
    expect(html).toContain('value="60"');
    expect(html).toContain('Send a test alert');
    expect(html).toContain('Test with accounts too');
    expect(html).toContain('Send a notice');
    expect(html).toContain('Deliver 1 waiting now');
    expect(html).toContain('No administrator receives security alerts yet');
    expect(html).toContain('14 active accounts with a contact address via Exim on this server');
    expect(html).toContain('0 contacts subscribed');
    expect(html).toContain('digest window open for 20 min');
    expect(html).toContain('HST Panel');
    expect(html).toContain('Emergency security update applied: 2 packages on panel.example.com');
    expect(html).toContain('administrators: 2 of 2 contacts sent · accounts: 12 mails sent, 1 failed');
    expect(html).toContain('held for the next digest');
    expect(html).toContain('not sent: below the minimum severity');
    expect(html).toContain('software.system.update#41');
  });

  it('warns when accounts are to be mailed without a transport and marks the feature disabled', () => {
    responses.clear();
    responses.set('/server-contacts/security-alerts', { data: { ...overview, settings: { ...overview.settings, enabled: false, notifyAccounts: true }, capability: { ...overview.capability, mailTransport: null, contactsSubscribed: 2 }, stats: { total: 0, last24h: 0, pending: 0 }, alerts: [] } });
    const html = render(<SecurityAlertsCard />);
    expect(html).toContain('Disabled');
    expect(html).toContain('Hosting accounts cannot be mailed yet');
    expect(html).not.toContain('No administrator receives security alerts yet');
    expect(html).toContain('2 contacts subscribed');
    expect(html).toContain('(no mail transport)');
    expect(html).toContain('No security alert has been raised yet.');
    expect(html).not.toContain('waiting now');
  });

  it('renders the error state without the form', () => {
    responses.clear();
    responses.set('/server-contacts/security-alerts', { error: { status: 500, code: 'internal', message: 'boom' } });
    const html = render(<SecurityAlertsCard />);
    expect(html).toContain('boom');
    expect(html).not.toContain('Raise security alerts');
  });
});

describe('AlertsPanel on the Security Advisor page', () => {
  it('lists the last alerts with their delivery state and links to the settings', () => {
    responses.clear();
    responses.set('/server-contacts/security-alerts/alerts', { data: [heldAlert, sentAlert] });
    const html = render(<AlertsPanel limit={5} />);
    expect(html).toContain('Alerts');
    expect(html).toContain('href="/server-contacts/contact-manager"');
    expect(html).toContain('The root panel user has no two-factor authentication');
    expect(html).toContain('security-advisor:scheduled');
    expect(html).toContain('held for the next digest');
    expect(html).toContain('accounts: 12 mails sent, 1 failed');
  });

  it('shows the empty state and sits under the findings on the advisor page', () => {
    responses.clear();
    responses.set('/server-contacts/security-alerts/alerts', { data: [] });
    responses.set('/security/advisor', { data: { id: 1, trigger: 'manual', finishedAt: '2026-10-30T09:00:00Z', summary: { critical: 1, warning: 0, info: 0, ok: 0 }, findings: [{ id: '2fa.root', grade: 'critical', title: 'The root panel user has no two-factor authentication' }] } });
    responses.set('/system/settings?prefix=security.advisories', { data: { 'security.advisories': [] } });
    const html = render(<SecurityAdvisor fn={{ key: 'security-advisor', label: 'Security Advisor', description: '' }} />);
    expect(html).toContain('No security alerts yet');
    expect(html.indexOf('The root panel user has no two-factor authentication')).toBeLessThan(html.indexOf('No security alerts yet'));
    expect(html.indexOf('No security alerts yet')).toBeLessThan(html.indexOf('PHP advisory list'));
  });
});
