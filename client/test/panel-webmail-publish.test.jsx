import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));

const responses = new Map();
const requested = [];
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    requested.push(path);
    const r = responses.get(path) ?? null;
    return { data: r?.data ?? null, meta: null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { WebmailPublishCard, webmailState, AccountPanelTab } = await import('../src/pages/fn/cpanel/customization.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const base = {
  installed: true, flavor: 'roundcube', version: '1.6.11', path: '/var/lib/roundcube', root: '/var/lib/roundcube/public_html', hostname: 'nova.example.com', fqdn: true, apache: true,
  site: { exists: true, enabled: true, ssl: true, inSync: true, url: 'https://nova.example.com/' },
  published: null, url: null, globalAlias: null,
  config: { path: '/etc/roundcube/config.inc.php', exists: true, ok: true, managed: null, expected: { imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: 'Keel' }, inSync: false },
  lastApply: null, error: null,
};
const published = { ...base, published: { alias: '/webmail', file: '/etc/apache2/keel-host.d/webmail.conf', managed: true, source: 'keel-host', url: 'https://nova.example.com/webmail/' }, url: 'https://nova.example.com/webmail/', config: { ...base.config, managed: base.config.expected, inSync: true }, lastApply: { at: '2026-11-05T10:00:00Z', ok: true, summary: {}, error: null } };

describe('Panel › Customization › Webmail card', () => {
  it('reads GET /service-config/webmail and offers Publish for an installed, unpublished Roundcube', () => {
    responses.set('/service-config/webmail', { data: base });
    const html = render(<WebmailPublishCard />);
    expect(requested).toContain('/service-config/webmail');
    expect(html).toContain('roundcube 1.6.11 (/var/lib/roundcube/public_html)');
    expect(html).toContain('>Not published<');
    expect(html).toContain('>Publish webmail<');
    expect(html).not.toContain('>Unpublish<');
    expect(html).toContain('https://nova.example.com/webmail/ answer with the hostname certificate');
    expect(html).toContain('Distribution defaults (localhost:143, no TLS)');
  });

  it('shows the published URL, the managed mail hosts, Publish again and Unpublish once published', () => {
    responses.set('/service-config/webmail', { data: published });
    const html = render(<WebmailPublishCard />);
    expect(html).toContain('>Published<');
    expect(html).toContain('href="https://nova.example.com/webmail/"');
    expect(html).toContain('/etc/apache2/keel-host.d/webmail.conf');
    expect(html).toContain('ssl://nova.example.com:993 · tls://nova.example.com:587 · &quot;Keel&quot;');
    expect(html).toContain('>Publish again<');
    expect(html).toContain('>Unpublish<');
    expect(html).toContain('Last publish');
  });

  it('explains every blocked state and the distribution global alias; the button is disabled without an install, Apache or an FQDN', () => {
    expect(webmailState({ ...base, installed: false })).toMatchObject({ status: 'not-installed' });
    expect(webmailState({ ...base, apache: false })).toMatchObject({ status: 'warning', label: 'Apache missing' });
    expect(webmailState({ ...base, fqdn: false, hostname: 'nova' })).toMatchObject({ label: 'Hostname not qualified' });
    expect(webmailState({ ...base, published: { alias: '/roundcube', file: '/etc/apache2/conf-enabled/roundcube.conf', managed: false, source: 'distro', url: 'https://nova.example.com/roundcube/' } })).toMatchObject({ label: 'Published by the distribution' });
    expect(webmailState({ ...published, site: { ...published.site, exists: false } })).toMatchObject({ label: 'Hostname site missing' });
    expect(webmailState({ ...published, site: { ...published.site, ssl: false } })).toMatchObject({ label: 'Published without HTTPS' });
    expect(webmailState({ ...published, config: { ...published.config, inSync: false } })).toMatchObject({ label: 'Mail hosts out of date' });
    expect(webmailState(published)).toMatchObject({ status: 'active', label: 'Published', detail: null });
    responses.set('/service-config/webmail', { data: { ...base, installed: false, flavor: null, version: null, config: null, globalAlias: { alias: '/roundcube', file: '/etc/apache2/conf-enabled/roundcube.conf' } } });
    const html = render(<WebmailPublishCard />);
    expect(html).toContain('>Not installed<');
    expect(html).toContain('roundcube roundcube-core roundcube-mysql');
    expect(html).toContain('a2disconf');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Publish webmail/);
  });

  it('sits in the Account panel tab between the settings and the log-in-as history', () => {
    responses.set('/service-config/webmail', { data: base });
    responses.set('/panel/admin/settings', { data: { enabled: true, require2faForUsers: false, loginAsTtlMinutes: 60, loginAsAcl: 'login-as', webmailUrl: '' } });
    const html = render(<AccountPanelTab />);
    const i = (s) => html.indexOf(s);
    expect(i('Webmail URL')).toBeGreaterThan(-1);
    expect(i('Webmail URL')).toBeLessThan(i('Publish webmail'));
    expect(i('Publish webmail')).toBeLessThan(i('Log in as history'));
  });
});
