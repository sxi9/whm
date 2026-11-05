import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const posted = [];
vi.mock('../src/api/client.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { ...mod.api, post: async (path, body) => { posted.push({ path, body }); return { data: { url: 'https://srv1.example/webmail/?_keel=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', mailbox: body.mailbox } }; }, put: async () => ({ data: {} }) } };
});
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const r = path ? responses.get(path.split('?')[0]) : null;
    return { data: r?.data ?? null, meta: null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const Webmail = await import('../src/pages/panel/email/webmail.jsx');
const Accounts = await import('../src/pages/panel/email/accounts.jsx');
const { WebmailPublishCard, webmailSsoState, WebmailSsoSettings } = await import('../src/pages/fn/cpanel/customization.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, null, el))));

const info = { installed: true, flavor: 'roundcube', version: '1.6.11', url: 'https://srv1.example/webmail/', configuredUrl: null, alias: '/webmail', published: true, prefillUser: 'info@demo.example.com', hostname: 'srv1.example', sso: true };
const mailboxes = [{ id: 1, address: 'info@demo.example.com', suspended: false }, { id: 2, address: 'old@demo.example.com', suspended: true }];

describe('Webmail single sign-on (account panel)', () => {
  it('renders a sign-on button instead of the ?_user= link when GET /email/webmail says sso:true; suspended mailboxes keep the plain link', () => {
    const html = render(h(Webmail.WebmailCard, { info }));
    expect(html).toMatch(/<button[^>]*data-sso="1"[^>]*>.*Open webmail/);
    expect(html).not.toContain('_user=');
    expect(html).toContain('Opens as');
    expect(html).toContain('Single sign-on');
    const list = render(h(Webmail.MailboxLinks, { info, mailboxes }));
    expect(list.match(/data-sso="1"/g)).toHaveLength(1);
    expect(list).toContain('href="https://srv1.example/webmail/?_user=old%40demo.example.com"');
  });

  it('keeps the plain prefilled link when sso is off', () => {
    const html = render(h(Webmail.WebmailCard, { info: { ...info, sso: false } }));
    expect(html).toContain('href="https://srv1.example/webmail/?_user=info%40demo.example.com"');
    expect(html).not.toContain('data-sso');
    expect(html).toContain('Signs in as');
  });

  it('POSTs the mailbox and opens the answered URL in the window opened on the click (closed again on failure)', async () => {
    posted.length = 0;
    const opened = [];
    const w = { location: null, closed: false, close() { this.closed = true; } };
    const r = await Webmail.openWebmailSso('info@demo.example.com', { win: () => w, open: (url, win) => { opened.push([url, win]); win.location = url; } });
    expect(posted).toEqual([{ path: '/panel/email/webmail/sso', body: { mailbox: 'info@demo.example.com' } }]);
    expect(r.url).toContain('?_keel=');
    expect(opened[0][1]).toBe(w);
    expect(w.location).toBe(r.url);
    const { api } = await import('../src/api/client.js');
    const original = api.post;
    api.post = async () => { throw new Error('refused'); };
    const w2 = { location: null, closed: false, close() { this.closed = true; } };
    try { await expect(Webmail.openWebmailSso('info@demo.example.com', { win: () => w2 })).rejects.toThrow('refused'); } finally { api.post = original; }
    expect(w2.closed).toBe(true);
  });

  it('the mailbox connection sheet uses sign-on for its Open webmail button when the server reports webmailSso', () => {
    const base = { address: 'info@demo.example.com', username: 'info@demo.example.com', hostname: 'srv1.example', imap: { host: 'srv1.example', port: 993, ssl: true }, pop3: null, smtp: { host: 'srv1.example', port: 465, ssl: true, auth: 'password', submissionPorts: true, ports: { enabled: true, port465: true, port587: true } }, certificate: null, webmail: 'https://srv1.example/webmail/' };
    expect(render(h(Accounts.ClientSettings, { settings: { ...base, webmailSso: true } }))).toMatch(/<button[^>]*data-sso="1"[^>]*>.*Open webmail/);
    expect(render(h(Accounts.ClientSettings, { settings: { ...base, webmailSso: false } }))).toContain('href="https://srv1.example/webmail/" target="_blank"');
  });
});

describe('Panel › Customization › Webmail card: single sign-on', () => {
  const sso = { enabled: true, loginAs: false, masterUser: 'keel-master', masterFile: '/etc/dovecot/whm/master-users', masterConfigured: true, plugin: { name: 'keel_sso', installed: true, loaded: true }, dovecot: { rendered: true, path: '/etc/dovecot/conf.d/98-whm-virtual-auth.conf' }, lastApply: null };
  const data = {
    installed: true, flavor: 'roundcube', version: '1.6.11', path: '/var/lib/roundcube', root: '/var/lib/roundcube/public_html', hostname: 'nova.example.com', fqdn: true, apache: true,
    site: { exists: true, enabled: true, ssl: true, inSync: true, url: 'https://nova.example.com/' },
    published: { alias: '/webmail', file: '/etc/apache2/keel-host.d/webmail.conf', managed: true, source: 'keel-host', url: 'https://nova.example.com/webmail/' }, url: 'https://nova.example.com/webmail/', globalAlias: null,
    config: { path: '/etc/roundcube/config.inc.php', exists: true, ok: true, managed: { imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: 'Keel', plugins: ['keel_sso'] }, expected: { imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: 'Keel', plugins: ['keel_sso'] }, inSync: true },
    sso, lastApply: null, error: null,
  };

  it('shows the toggle with the master user and plugin state, and the log-in-as allowance only while on', () => {
    responses.set('/service-config/webmail', { data });
    const html = render(h(WebmailPublishCard));
    expect(html).toContain('Single sign-on');
    expect(html).toContain('keel-master');
    expect(html).toContain('keel_sso installed and enabled');
    expect(html).toContain('Allow while logged in as an account');
    expect(html).toContain('>On<');
    responses.set('/service-config/webmail', { data: { ...data, sso: { ...sso, enabled: false, masterConfigured: false } } });
    const off = render(h(WebmailPublishCard));
    expect(off).toContain('>Off<');
    expect(off).not.toContain('Allow while logged in as an account');
  });

  it('explains every blocked state', () => {
    expect(webmailSsoState({ ...sso, enabled: false }, true)).toMatchObject({ status: 'disabled', label: 'Off' });
    expect(webmailSsoState({ ...sso, masterConfigured: false }, true)).toMatchObject({ label: 'No master credential' });
    expect(webmailSsoState({ ...sso, dovecot: { rendered: false } }, true)).toMatchObject({ label: 'Dovecot not updated' });
    expect(webmailSsoState(sso, false)).toMatchObject({ label: 'Waiting for publish' });
    expect(webmailSsoState({ ...sso, plugin: { name: 'keel_sso', installed: true, loaded: false } }, true)).toMatchObject({ label: 'Plugin not loaded' });
    expect(webmailSsoState(sso, true)).toMatchObject({ status: 'active', label: 'On' });
    expect(render(h(WebmailSsoSettings, { sso, published: true, busy: false, run: () => {} }))).toContain('one-minute single-use link');
  });
});
