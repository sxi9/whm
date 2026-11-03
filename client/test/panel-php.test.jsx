import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

let responses = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const r = (path && responses[path.split('?')[0]]) || {};
    return { data: r.data ?? null, meta: r.meta ?? null, error: r.error ?? null, loading: Boolean(path) && !r.data && !r.error, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: PhpVersions, versionOptions, versionLabel, INHERIT } = await import('../src/pages/panel/php/versions.jsx');
const { default: PhpSettings, otherDirectives } = await import('../src/pages/panel/php/ini.jsx');
const { changedDirectives, webResult, DIRECTIVES, INI_KEY_RE } = await import('../src/pages/panel/php/parts/Shared.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: {}, limits: {}, suspended: 0, forcePasswordChange: 0, demoMode: 0, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fns = { versions: PANEL_FUNCTION_BY_KEY['panel:php/versions'], ini: PANEL_FUNCTION_BY_KEY['panel:php/ini'] };
const render = (el, path = '/panel/php/versions') => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={[path]}><ShellContext.Provider value={PANEL_SHELL}><PanelContext.Provider value={ctx}>{el}</PanelContext.Provider></ShellContext.Provider></MemoryRouter></ConfirmProvider></ToastProvider>,
);

const versionsData = {
  versions: [
    { id: '8.3', label: 'PHP 8.3', version: '8.3.6', isDefault: true, advisories: [{ id: 'CVE-2026-1', severity: 'critical', title: 'Remote code execution', fixedIn: '8.3.36' }] },
    { id: '8.2', label: 'PHP 8.2', version: '8.2.20', isDefault: false, advisories: [] },
  ],
  defaultId: '8.3', planDefault: null, restricted: false,
};
const domainsData = {
  systemDefault: '8.3',
  domains: [
    { domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html', phpVersion: null, effective: '8.3', inherited: true },
    { domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop', phpVersion: '8.2', effective: '8.2', inherited: false },
  ],
};
const iniData = {
  domain: 'demo.example.com', path: '/home/demo/public_html/.user.ini', exists: true,
  directives: { memory_limit: '256M', display_errors: 'Off', 'opcache.enable': '1' },
  basic: { memory_limit: '256M', display_errors: 'Off', upload_max_filesize: null, max_execution_time: null },
  content: 'memory_limit = 256M\ndisplay_errors = Off\nopcache.enable = 1\n',
};
const FEATURE_OFF = { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include "phpversion"' };
const NO_PHP = { status: 501, code: 'capability_missing', message: 'PHP is not installed on this server', capability: 'php' };

describe('PHP versions', () => {
  it('lists the installed versions with the default and advisories, and each domain with a version picker', () => {
    responses = { '/panel/php/versions': { data: versionsData }, '/panel/php/domains': { data: domainsData } };
    const html = render(<PhpVersions fn={fns.versions} />);
    expect(html).toContain('<h1>PHP versions</h1>');
    expect(html).toContain('Available versions');
    expect(html).toContain('<strong>PHP 8.3</strong>');
    expect(html).toContain('8.3.6');
    expect(html).toContain('>Server default<');
    expect(html).toContain('>Security advisory<');
    expect(html).toContain('fixed in 8.3.36');
    expect(html).toContain('demo.example.com');
    expect(html).toContain('shop.demo.example.com');
    expect(html).toContain('<code class="small">/home/demo/public_html/shop</code>');
    expect(html).toContain('PHP 8.3 (8.3.6)<span class="muted small"> · server default</span>');
    expect(html).toContain('aria-label="PHP version for demo.example.com"');
    expect(html).toContain('<option value="__inherit">Server default (PHP 8.3 (8.3.6))</option>');
    expect(html).toContain('<option value="8.2" selected="">PHP 8.2 (8.2.20)</option>');
    expect(html).toContain('href="/panel/php/ini"');
    expect(html).toContain('Search domains');
    expect(html).not.toContain('>Save</button>');
  });

  it('shows the empty state without web domains', () => {
    responses = { '/panel/php/versions': { data: versionsData }, '/panel/php/domains': { data: { systemDefault: '8.3', domains: [] } } };
    expect(render(<PhpVersions fn={fns.versions} />)).toContain('No web domains yet');
  });

  it('renders the 403 and 501 states', () => {
    responses = { '/panel/php/versions': { error: FEATURE_OFF }, '/panel/php/domains': { error: FEATURE_OFF } };
    const off = render(<PhpVersions fn={fns.versions} />);
    expect(off).toContain('Not included in your plan');
    expect(off).toContain('PHP versions is not part of the hosting plan');
    responses = { '/panel/php/versions': { error: NO_PHP }, '/panel/php/domains': { data: domainsData } };
    const missing = render(<PhpVersions fn={fns.versions} />);
    expect(missing).toContain('Not available on this server');
    expect(missing).toContain('PHP is not installed');
  });

  it('versionOptions, versionLabel and webResult', () => {
    expect(versionOptions(versionsData, '8.3').map((o) => o.value)).toEqual([INHERIT, '8.3', '8.2']);
    expect(versionOptions(versionsData, '8.3')[1].label).toBe('PHP 8.3 (8.3.6)');
    expect(versionOptions(null, null)[0].label).toBe('Server default');
    expect(versionLabel(versionsData.versions, '8.2')).toBe('PHP 8.2 (8.2.20)');
    expect(versionLabel([], '7.4')).toBe('PHP 7.4');
    expect(webResult('applied')).toEqual({ applied: true });
    expect(webResult('failed: Apache is not installed')).toEqual({ applied: false, reason: 'Apache is not installed' });
    expect(webResult('recorded')).toEqual({ applied: false, reason: 'recorded' });
  });
});

describe('PHP settings (.user.ini)', () => {
  it('shows the file, the common directives with their saved values and the current content', () => {
    responses = { '/panel/php/domains': { data: domainsData }, '/panel/php/domains/demo.example.com/ini': { data: iniData } };
    const html = render(<PhpSettings fn={fns.ini} />, '/panel/php/ini?domain=demo.example.com');
    expect(html).toContain('<h1>PHP settings</h1>');
    expect(html).toContain('<option value="demo.example.com" selected="">demo.example.com · PHP 8.3</option>');
    expect(html).toContain('shop.demo.example.com (subdomain) · PHP 8.2');
    expect(html).toContain('/home/demo/public_html/.user.ini');
    expect(html).toContain('>Exists<');
    expect(html).toContain('Common directives');
    expect(html).toContain('<code>memory_limit</code>');
    expect(html).toContain('value="256M"');
    expect(html).toContain('<option value="Off" selected="">Off</option>');
    expect(html).toContain('<code>upload_max_filesize</code>');
    expect(html).toContain('Not set (server default)');
    expect(html).toContain('0 directives changed');
    expect(html).toContain('<pre class="log">memory_limit = 256M');
    expect(html).toContain('href="/panel/php/versions"');
    expect(html).toContain('role="tablist"');
  });

  it('tells the customer the file does not exist yet and shows the empty state without domains', () => {
    responses = { '/panel/php/domains': { data: domainsData }, '/panel/php/domains/demo.example.com/ini': { data: { ...iniData, exists: false, directives: {}, basic: {}, content: '' } } };
    const html = render(<PhpSettings fn={fns.ini} />, '/panel/php/ini?domain=demo.example.com');
    expect(html).toContain('Not created yet');
    expect(html).not.toContain('<pre class="log">');
    responses = { '/panel/php/domains': { data: { systemDefault: '8.3', domains: [] } } };
    expect(render(<PhpSettings fn={fns.ini} />, '/panel/php/ini')).toContain('No web domains yet');
  });

  it('renders the 403 and 501 states', () => {
    responses = { '/panel/php/domains': { error: FEATURE_OFF } };
    expect(render(<PhpSettings fn={fns.ini} />, '/panel/php/ini')).toContain('Not included in your plan');
    responses = { '/panel/php/domains': { data: domainsData }, '/panel/php/domains/demo.example.com/ini': { error: NO_PHP } };
    const missing = render(<PhpSettings fn={fns.ini} />, '/panel/php/ini?domain=demo.example.com');
    expect(missing).toContain('Not available on this server');
    expect(missing).toContain('PHP is not installed');
  });

  it('otherDirectives, changedDirectives and the directive table', () => {
    expect(otherDirectives(iniData.directives)).toEqual([{ key: 'opcache.enable', value: '1' }]);
    expect(otherDirectives(null)).toEqual([]);
    expect(changedDirectives({ memory_limit: '256M', display_errors: 'Off' }, { memory_limit: '512M', display_errors: 'Off', max_input_vars: '3000', upload_max_filesize: '' })).toEqual({ memory_limit: '512M', max_input_vars: '3000' });
    expect(changedDirectives({ memory_limit: '256M' }, { memory_limit: '' })).toEqual({ memory_limit: null });
    expect(changedDirectives({ a: null }, { a: '' })).toEqual({});
    expect(DIRECTIVES.map((d) => d.key)).toContain('upload_max_filesize');
    expect(new Set(DIRECTIVES.map((d) => d.key)).size).toBe(DIRECTIVES.length);
    expect(INI_KEY_RE.test('opcache.enable')).toBe(true);
    expect(INI_KEY_RE.test('bad key')).toBe(false);
    expect(INI_KEY_RE.test('1abc')).toBe(false);
  });
});
