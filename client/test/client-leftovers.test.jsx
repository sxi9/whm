import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

const auth = { user: { id: 1, username: 'root', role: 'root', profile: {} }, hostname: 'host.example.com', logout: async () => {} };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// Static rendering never runs effects: useApi answers from a path-keyed table
// (a key also matches the same path with a query string).
const apiData = {};
const lookup = (path) => Object.entries(apiData).find(([k]) => path === k || path.startsWith(`${k}?`))?.[1];
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => { const data = lookup(path); return { data: data ?? null, meta: data ? { total: Array.isArray(data) ? data.length : 0 } : null, error: null, loading: data === undefined, refetch: () => {}, setData: () => {} }; },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { DaemonNotice, RequestError } = await import('../src/pages/service-config/Shared.jsx');
const { ContactManager } = await import('../src/pages/contacts/ContactManager.jsx');
const { MailPreferences } = await import('../src/pages/contacts/MailPreferences.jsx');
const { default: WebTemplateEditor } = await import('../src/pages/fn/account-functions/web-template-editor.jsx');
const { ChangeHostname, StepList } = await import('../src/pages/networking/ChangeHostname.jsx');
const { AccountsTable } = await import('../src/pages/accounts/AccountsTable.jsx');
const { TopBar, unreadBadge } = await import('../src/components/TopBar.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el, entries = ['/']) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter initialEntries={entries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);
const checkedBoxes = (html) => (html.match(/type="checkbox" checked=""/g) || []).length;
const disabledBoxes = (html) => (html.match(/type="checkbox"[^>]*disabled=""/g) || []).length;

describe('DaemonNotice / RequestError forward the capability', () => {
  it('shows the Install button for root when a capability is named', () => {
    const html = render(<DaemonNotice capability="exim" installed={false} message="Exim is missing" onRetry={() => {}} />);
    expect(html).toContain('Service not installed');
    expect(html).toContain('Install Exim');
    expect(html).toContain('Re-check');
    expect(render(<DaemonNotice capability="dovecot" installed={false} message="Dovecot is missing" />)).toContain('Install Dovecot');
  });

  it('renders nothing when installed and no button without a capability', () => {
    expect(render(<DaemonNotice capability="exim" installed message="x" />)).not.toContain('Service not installed');
    const html = render(<DaemonNotice installed={false} message="logrotate is missing" />);
    expect(html).toContain('Service not installed');
    expect(html).not.toContain('btn-primary');
  });

  it('RequestError passes an explicit capability through, and keeps the error\'s own one', () => {
    expect(render(<RequestError error={{ status: 501, code: 'capability_missing', message: 'no bind' }} capability="bind" />)).toContain('Install BIND');
    expect(render(<RequestError error={{ status: 501, code: 'capability_missing', message: 'no ftp', capability: 'ftp' }} />)).toContain('Install Pure-FTPd');
    expect(render(<RequestError error={{ status: 500, code: 'error', message: 'boom' }} capability="bind" />)).not.toContain('Install BIND');
  });
});

describe('contacts pages name the Exim capability', () => {
  it('Mail Preferences offers Install Exim when no mail transport exists', () => {
    apiData['/server-contacts/mail-preferences'] = {
      capability: { mailTransport: null }, forwardTo: [], users: { nobody: [] }, rootMailEvents: [], events: [], rootAddress: 'root@host.example.com',
      aliases: { path: '/etc/aliases', exists: true, rebuildTool: 'newaliases', entries: [] }, aliasError: null, rootDelivery: null, managedUsers: ['root'],
    };
    const html = render(<MailPreferences />);
    expect(html).toContain('Service not installed');
    expect(html).toContain('no SMTP relay is configured in Contact Manager');
    expect(html).toContain('Install Exim');
    expect(html).not.toContain('No mail transport');
  });

  it('Contact Manager offers Install Exim when no mail transport exists', () => {
    apiData['/server-contacts'] = {
      capability: { mailTransport: null }, contacts: [], events: [], channels: [], severities: ['info', 'warning', 'error', 'critical'], smtpSecurity: ['none', 'starttls', 'tls'],
      settings: { enabled: true, fromAddress: '', retentionDays: 30, effectiveFrom: 'whm@host.example.com', webhook: { allowPrivate: false }, smtp: { host: '', port: 587, username: '', security: 'starttls', prefer: 'auto', allowPlaintextAuth: false, allowSelfSigned: false, password: { set: false } }, check: { enabled: true, diskThresholdPercent: 90, cooldownMinutes: 60, sslDays: 14 } },
      schedule: null, openAlerts: [],
    };
    const html = render(<ContactManager />);
    expect(html).toContain('Install Exim');
    expect(html).toContain('email and SMS contacts cannot be reached yet');
  });
});

describe('Web Template Editor lists the hostname landing page', () => {
  it('labels the landing template and says both served pages', () => {
    apiData['/account-functions/templates'] = { dir: '/etc/whm/templates', variables: ['domain'], templates: [
      { name: 'index', path: '/etc/whm/templates/index.html', served: true, served_by: 'account creation', customised: false },
      { name: 'landing', path: '/etc/whm/templates/landing.html', served: true, served_by: 'Service Configuration', customised: false },
      { name: 'moved', path: '/etc/whm/templates/moved.html', served: false, served_by: 'not yet served', customised: false },
    ] };
    apiData['/account-functions/templates/index'] = { name: 'index', body: '<html></html>' };
    const html = render(<WebTemplateEditor fn={FUNCTION_BY_KEY['account-functions/web-template-editor']} />);
    expect(html).toContain('Server hostname landing page');
    expect(html).toContain('server hostname landing page is rendered into the hostname');
    expect(html).not.toContain('Today only the default site page is served');
  });
});

describe('Change Hostname', () => {
  it('labels the landing and certificate steps and shows a pending certificate', () => {
    const html = render(<StepList steps={[
      { step: 'hostname', ok: true }, { step: 'dns', ok: true, detail: 'host.example.com IN A 203.0.113.10' },
      { step: 'landing', ok: true, detail: '/var/www/whm-default' },
      { step: 'certificate', ok: false, error: 'not served yet', pending: [{ service: 'panel', error: 'listener uses another pair' }], failed: [] },
    ]} />);
    expect(html).toContain('Hostname landing page');
    expect(html).toContain('Hostname certificate');
    expect(html).toContain('DNS records');
    expect(html).toContain('>pending<');
    expect(html).toContain('listener uses another pair');
    expect(html).not.toContain('>failed<');
  });

  it('defaults the DNS records and hostname certificate toggles to on', () => {
    apiData['/networking/hostname'] = { current: 'host.example.com', configured: 'host.example.com', inSync: true, ip: '203.0.113.10', validation: { ok: true }, hosts: { ok: true, entry: { ip: '203.0.113.10', names: ['host.example.com', 'host'] } }, capability: { hostnamectl: true, dns: true, ssl: true, web: true }, defaults: { updateHosts: true, addDnsRecord: true } };
    const html = render(<ChangeHostname />);
    expect(html).toContain('Publish DNS records for the hostname');
    expect(html).toContain('Issue the hostname certificate');
    expect(checkedBoxes(html)).toBe(4);
    expect(disabledBoxes(html)).toBe(0);
  });

  it('disables the certificate toggle when SSL/TLS is unavailable', () => {
    apiData['/networking/hostname'] = { current: 'host.example.com', inSync: true, capability: { hostnamectl: true, dns: false, ssl: false }, defaults: {} };
    const html = render(<ChangeHostname />);
    expect(html).toContain('SSL/TLS is not available on this panel.');
    expect(html).toContain('DNS Functions are not available on this panel.');
    expect(disabledBoxes(html)).toBe(2);
  });
});

describe('List Accounts', () => {
  it('has a sortable Manager column right after Owner', () => {
    apiData['/accounts'] = [{ username: 'alice', domain: 'alice.example', owner: 'root', manager: 'resell1', manager_role: 'reseller', package_name: 'default', ip: '203.0.113.10', disk_used_mb: 1, disk_quota_mb: 100, contact_email: 'a@example.com', created_at: '2026-10-29 10:00:00', suspended: 0 }];
    const html = render(<AccountsTable />);
    const owner = html.indexOf('Owner'); const manager = html.indexOf('Manager'); const pkg = html.indexOf('Package');
    expect(owner).toBeGreaterThan(-1);
    expect(manager).toBeGreaterThan(owner);
    expect(pkg).toBeGreaterThan(manager);
    expect(html).toContain('resell1');
    expect(html).toContain('manager or email');
  });

  it('seeds the search from a ?q= deep link (Manage Databases, Service Manager) so the linked account is shown', () => {
    apiData['/accounts'] = [{ username: 'alice', domain: 'alice.example', owner: 'root', manager: 'root', manager_role: 'root', package_name: 'default', ip: '203.0.113.10', disk_used_mb: 1, disk_quota_mb: 100, contact_email: 'a@example.com', created_at: '2026-10-29 10:00:00', suspended: 0 }];
    const html = render(<AccountsTable />, ['/account-information/list-accounts?q=alice']);
    expect(html).toContain('value="alice"');
    expect(render(<AccountsTable />, ['/account-information/list-accounts'])).toContain('value=""');
  });
});

describe('TopBar unread badge', () => {
  it('turns the bell into a link to Account Conversations with no badge before the first poll', () => {
    const html = render(<TopBar onMenu={() => {}} />);
    expect(html).toContain('href="/support/account-conversations"');
    expect(html).toContain('aria-label="Notifications"');
    expect(html).not.toContain('topbar-badge');
  });

  it('caps the badge at 99+', () => {
    expect(unreadBadge(1)).toBe('1');
    expect(unreadBadge(99)).toBe('99');
    expect(unreadBadge(100)).toBe('99+');
  });
});
