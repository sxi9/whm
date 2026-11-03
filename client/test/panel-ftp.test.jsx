import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: FtpAccounts, loginSuffix, relativeDir, encryptionText, filterAccounts, homePrefix } = await import('../src/pages/panel/ftp/accounts.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: { max_ftp: 10 }, features: { ftpaccts: true }, limits: {}, domains: [] },
  usage: {}, counts: { databases: 0, ftp: 1 }, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:ftp/accounts'];
const render = (el) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (value) => fixtures.responses.set('/panel/ftp/accounts', { loading: false, ...value });
const meta = { total: 1, quota: { max: 10, used: 1, remaining: 9 }, daemon: 'pure-ftpd', supported: true, supportedDaemon: true, virtualUsersEnabled: true, canEnable: false, hint: null, mainLogin: 'demo', host: 'srv1.example', port: 21, protocol: 'ftp', encryption: 'optional' };
const rows = [{ id: 3, name: 'designer', login: 'designer@demo.example.com', daemon: 'pure-ftpd', dir: '/home/demo/public_html/assets', quotaMb: 512, created_at: '2026-11-01 10:00:00', updated_at: null }, { id: 4, name: 'backup', login: 'backup@demo.example.com', daemon: 'pure-ftpd', dir: '/home/demo', quotaMb: null, created_at: null, updated_at: null }];

describe('FTP accounts page', () => {
  it('shows connection settings, the create form with the fixed suffix and home prefix, and the accounts table', () => {
    fixtures.responses.clear();
    set({ data: rows, meta });
    const html = render(h(FtpAccounts, { fn }));
    expect(html).toContain('<h1>FTP accounts</h1>');
    expect(html).toContain('Connection settings');
    expect(html).toContain('<code>srv1.example</code>');
    expect(html).toContain('<code>21</code>');
    expect(html).toContain('TLS when the client asks for it');
    expect(html).toContain('<code>demo</code>');
    expect(html).toContain('Your account password');
    expect(html).toContain('1 of 10');
    expect(html).toContain('width:10%');
    expect(html).toContain('Create an FTP account');
    expect(html).toContain('value="@demo.example.com"');
    expect(html).toContain('aria-label="Fixed suffix"');
    expect(html).toContain('value="/home/demo/"');
    expect(html).toContain('value="public_html"');
    expect(html).toContain('Space limit (MB)');
    expect(html).toContain('<code>designer@demo.example.com</code>');
    expect(html).toContain('<code>public_html/assets</code>');
    expect(html).toContain('<code>.</code>');
    expect(html).toContain('512 MB');
    expect(html).toContain('Unlimited');
    expect(html).toContain('>Connection settings<');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('href="/panel/files/file-manager"');
    expect(html).not.toContain('not enabled on this server');
  });

  it('warns when the daemon serves the main login only, keeping the form', () => {
    fixtures.responses.clear();
    set({ data: [], meta: { ...meta, supported: false, virtualUsersEnabled: false, canEnable: true, hint: 'Enable PureDB under FTP Server Configuration' } });
    const html = render(h(FtpAccounts, { fn }));
    expect(html).toContain('Extra FTP logins are not enabled on this server');
    expect(html).toContain('Enable PureDB under FTP Server Configuration');
    expect(html).toContain('Create an FTP account');
    expect(html).toContain('No extra FTP accounts yet');
  });

  it('uses the proftpd suffix and disables the space limit there', () => {
    fixtures.responses.clear();
    set({ data: [], meta: { ...meta, daemon: 'proftpd' } });
    const html = render(h(FtpAccounts, { fn }));
    expect(html).toContain('value="_demo"');
    expect(html).toContain('proftpd does not support per-login limits');
    expect(html).toMatch(/id="ftp-quota"[^>]*disabled=""/);
  });

  it('renders the capability state on 501 with the form still present', () => {
    fixtures.responses.clear();
    set({ error: { status: 501, code: 'capability_missing', message: 'No FTP daemon is installed on this server.', capability: 'ftp' } });
    const html = render(h(FtpAccounts, { fn }));
    expect(html).toContain('Not available on this server');
    expect(html).toContain('No FTP daemon is installed on this server.');
    expect(html).toContain('Create an FTP account');
    expect(html).toContain('once the FTP server is available');
  });

  it('renders the plan state on 403 feature_disabled', () => {
    fixtures.responses.clear();
    set({ error: { status: 403, code: 'feature_disabled', message: 'off' } });
    const html = render(h(FtpAccounts, { fn }));
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('FTP accounts is not part of the hosting plan');
    expect(html).not.toContain('Create an FTP account');
  });

  it('explains a reached plan limit and disables the create form', () => {
    fixtures.responses.clear();
    set({ data: rows, meta: { ...meta, quota: { max: 2, used: 2, remaining: 0 } } });
    const html = render(h(FtpAccounts, { fn }));
    expect(html).toContain('Your plan allows 2 FTP accounts and all of them exist');
    expect(html).toMatch(/id="ftp-login"[^>]*disabled=""/);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('helpers: loginSuffix, homePrefix, relativeDir, encryptionText, filterAccounts', () => {
    expect(loginSuffix('pure-ftpd', me.account)).toBe('@demo.example.com');
    expect(loginSuffix('proftpd', me.account)).toBe('_demo');
    expect(loginSuffix('pure-ftpd', null)).toBe('');
    expect(homePrefix({ username: 'x' })).toBe('/home/x/');
    expect(relativeDir('/home/demo/public_html', me.account)).toBe('public_html');
    expect(relativeDir('/home/demo', me.account)).toBe('.');
    expect(relativeDir('/srv/other', me.account)).toBe('/srv/other');
    expect(encryptionText('required')).toBe('TLS required (FTPS)');
    expect(encryptionText('off')).toBe('None');
    expect(filterAccounts(rows, 'assets').map((r) => r.id)).toEqual([3]);
    expect(filterAccounts(rows, '').length).toBe(2);
  });
});
