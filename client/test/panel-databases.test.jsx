import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

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
const { default: Databases, quotaOf, filterRows } = await import('../src/pages/panel/databases/databases.jsx');
const { default: Users, summarizeGrants, filterUsers } = await import('../src/pages/panel/databases/users.jsx');
const { default: RemoteHosts, describeHost } = await import('../src/pages/panel/databases/remote-hosts.jsx');
const { default: PhpMyAdmin } = await import('../src/pages/panel/databases/phpmyadmin.jsx');
const { PrivilegeGrid, buildMatrix, togglePrivilege, toPayload } = await import('../src/pages/panel/databases/parts/GrantsEditor.jsx');
const { PRIVILEGES, jobStreamPath } = await import('../src/pages/panel/databases/parts/shared.jsx');
const { systemJobStreamPath } = await import('../src/components/ProgressLog.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: { max_sql: 10 }, features: { mysql: true, phpmyadmin: true }, limits: {}, domains: [] },
  usage: {}, counts: { databases: 2, ftp: 0 }, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = (key) => PANEL_FUNCTION_BY_KEY[key];
const render = (el, path = '/panel') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(`/panel${path}`, { loading: false, ...value });
const reset = () => fixtures.responses.clear();
const capability = { status: 501, code: 'capability_missing', message: 'MySQL/MariaDB is not installed on this server (no mysql, mysqld or mariadbd binary)', capability: 'mysql' };
const disabled = { status: 403, code: 'feature_disabled', message: 'The "mysql" feature is not enabled for this account\'s package' };

const dbRows = [
  { name: 'demo_shop', sizeBytes: 1572864, tables: 12, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', onServer: true, users: ['demo_app'], created_at: '2026-11-01 10:00:00' },
  { name: 'demo_blog', sizeBytes: null, tables: null, charset: null, collation: null, onServer: null, users: [], created_at: null },
];
const dbMeta = { total: 2, engine: 'mysql', engineError: null, quota: { max: 10, used: 2, remaining: 8 }, prefix: 'demo_' };

describe('Databases page', () => {
  it('lists databases with the fixed prefix in the create form, sizes, users and the plan quota', () => {
    reset();
    set('/databases', { data: dbRows, meta: dbMeta });
    const html = render(h(Databases, { fn: fn('panel:databases/databases') }), '/panel/databases/databases');
    expect(html).toContain('<h1>Databases</h1>');
    expect(html).toContain('Create a database');
    expect(html).toContain('value="demo_"');
    expect(html).toContain('aria-label="Fixed prefix"');
    expect(html).toContain('<code>demo_shop</code>');
    expect(html).toContain('<code>demo_blog</code>');
    expect(html).toContain('1.50 MB');
    expect(html).toContain('<code>demo_app</code>');
    expect(html).toContain('href="/panel/databases/users"');
    expect(html).toContain('of 10');
    expect(html).toContain('8 more allowed by the plan');
    expect(html).toContain('>Check<');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('Search databases or users');
    expect(html).not.toContain('Not available on this server');
  });

  it('renders the capability state on 501 and keeps the form and the empty table', () => {
    reset();
    set('/databases', { error: capability });
    const html = render(h(Databases, { fn: fn('panel:databases/databases') }), '/panel/databases/databases');
    expect(html).toContain('Not available on this server');
    expect(html).toContain('MySQL/MariaDB is not installed');
    expect(html).toContain('Create a database');
    expect(html).toContain('once the database server is available');
    expect(html).toContain('Not installed on this server');
  });

  it('renders the plan state on 403 feature_disabled', () => {
    reset();
    set('/databases', { error: disabled });
    const html = render(h(Databases, { fn: fn('panel:databases/databases') }), '/panel/databases/databases');
    expect(html).toContain('Not included in your plan');
    expect(html).not.toContain('Create a database');
  });

  it('explains a reached plan limit and disables the create button', () => {
    reset();
    set('/databases', { data: dbRows, meta: { ...dbMeta, quota: { max: 2, used: 2, remaining: 0 } } });
    const html = render(h(Databases, { fn: fn('panel:databases/databases') }), '/panel/databases/databases');
    expect(html).toContain('Plan limit reached');
    expect(html).toContain('Your plan allows 2 databases and all of them are in use');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('treats a plan limit of 0 as "not included" (the server refuses creation at 0), null as unlimited', () => {
    reset();
    set('/databases', { data: [], meta: { ...dbMeta, quota: { max: 0, used: 0, remaining: 0 } } });
    const html = render(h(Databases, { fn: fn('panel:databases/databases') }), '/panel/databases/databases');
    expect(html).toContain('No databases in your plan');
    expect(html).toContain('Your plan does not include databases');
    expect(html).not.toContain('No limit on databases in this plan');
    expect(html).not.toContain('Your plan allows 0 databases');
    expect(html).not.toContain('of 0');
    expect(html).toMatch(/id="db-name"[^>]*disabled=""/);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    set('/databases', { data: [], meta: { ...dbMeta, quota: { max: null, used: 4, remaining: null } } });
    const unlimited = render(h(Databases, { fn: fn('panel:databases/databases') }), '/panel/databases/databases');
    expect(unlimited).toContain('No limit on databases in this plan');
    expect(unlimited).not.toContain('not include');
    expect(unlimited).not.toMatch(/id="db-name"[^>]*disabled=""/);
  });

  it('shows the engine warning and the empty state wording', () => {
    reset();
    set('/databases', { data: [], meta: { ...dbMeta, quota: { max: null, used: 0, remaining: null }, engineError: { code: 'timeout', message: 'Connection refused.' } } });
    const html = render(h(Databases, { fn: fn('panel:databases/databases') }), '/panel/databases/databases');
    expect(html).toContain('Database server unreachable');
    expect(html).toContain('No databases yet. Create one above');
    expect(html).toContain('No limit on databases in this plan');
  });

  it('follows check and dump jobs on the panel job stream, never the reseller-only /system/jobs', () => {
    expect(jobStreamPath('abc')).toBe('/panel/databases/jobs/abc/stream');
    expect(systemJobStreamPath('abc')).toBe('/system/jobs/abc/stream');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/pages/panel/databases/parts/shared.jsx'), 'utf8');
    expect(src).not.toMatch(/system\/jobs\/\$\{/);
    expect(src).toContain('streamPath={jobStreamPath}');
  });

  it('quotaOf falls back to the session and filterRows matches names and users', () => {
    expect(quotaOf(null, me)).toEqual({ max: 10, used: 2, remaining: 8 });
    expect(quotaOf({ quota: { max: 1, used: 1, remaining: 0 } }, me).remaining).toBe(0);
    expect(filterRows(dbRows, 'app').map((r) => r.name)).toEqual(['demo_shop']);
    expect(filterRows(dbRows, '').length).toBe(2);
  });
});

describe('Database users page', () => {
  const users = [
    { name: 'demo_app', hosts: ['localhost', '203.0.113.5'], grants: [{ database: 'demo_shop', privileges: ['ALL PRIVILEGES'] }, { database: 'demo_blog', privileges: ['SELECT', 'INSERT'] }] },
    { name: 'demo_ro', hosts: ['localhost'], grants: [] },
  ];

  it('lists users with hosts and access, the prefixed create form and the database checkboxes', () => {
    reset();
    set('/databases/users', { data: users, meta: { total: 2, engine: 'mysql', prefix: 'demo_' } });
    set('/databases', { data: dbRows, meta: dbMeta });
    const html = render(h(Users, { fn: fn('panel:databases/users') }), '/panel/databases/users');
    expect(html).toContain('<h1>Database users</h1>');
    expect(html).toContain('Create a database user');
    expect(html).toContain('value="demo_"');
    expect(html).toContain('<code>demo_app</code>');
    expect(html).toContain('<code>203.0.113.5</code>');
    expect(html).toContain('all privileges');
    expect(html).toContain('select, insert');
    expect(html).toContain('No database yet');
    expect(html).toContain('>Privileges<');
    expect(html).toContain('Give access to');
    expect((html.match(/type="checkbox"/g) || []).length).toBe(2);
    expect(html).toContain('href="/panel/databases/remote-hosts"');
  });

  it('renders the capability state on 501 and the plan state on 403', () => {
    reset();
    set('/databases/users', { error: capability });
    set('/databases', { error: capability });
    let html = render(h(Users, { fn: fn('panel:databases/users') }), '/panel/databases/users');
    expect(html).toContain('Not available on this server');
    expect(html).toContain('list of databases is unavailable');
    expect(html).toContain('Create a database user');
    reset();
    set('/databases/users', { error: disabled });
    html = render(h(Users, { fn: fn('panel:databases/users') }), '/panel/databases/users');
    expect(html).toContain('Not included in your plan');
  });

  it('summarizeGrants and filterUsers', () => {
    expect(summarizeGrants(users[0].grants)).toEqual([{ database: 'demo_shop', text: 'all privileges' }, { database: 'demo_blog', text: 'select, insert' }]);
    expect(summarizeGrants([])).toBe(null);
    expect(filterUsers(users, 'blog').map((u) => u.name)).toEqual(['demo_app']);
  });
});

describe('Privilege grid', () => {
  it('builds a matrix of every owned database, toggles with the all-privileges rule and serialises non-empty rows', () => {
    const m = buildMatrix([{ database: 'demo_shop', privileges: ['SELECT'] }, { database: 'demo_old', privileges: ['ALL PRIVILEGES'] }], ['demo_shop', 'demo_blog']);
    expect([...m.keys()]).toEqual(['demo_shop', 'demo_blog', 'demo_old']);
    expect([...m.get('demo_blog')]).toEqual([]);
    expect([...togglePrivilege(m.get('demo_shop'), 'INSERT', PRIVILEGES)]).toEqual(['SELECT', 'INSERT']);
    expect([...togglePrivilege(m.get('demo_shop'), 'SELECT', PRIVILEGES)]).toEqual([]);
    expect([...togglePrivilege(m.get('demo_old'), 'ALL PRIVILEGES', PRIVILEGES)]).toEqual([]);
    expect([...togglePrivilege(new Set(), 'ALL PRIVILEGES', PRIVILEGES)]).toEqual(['ALL PRIVILEGES']);
    const almost = new Set(PRIVILEGES.filter((p) => p !== 'ALL PRIVILEGES' && p !== 'UPDATE'));
    expect([...togglePrivilege(almost, 'UPDATE', PRIVILEGES)]).toEqual(['ALL PRIVILEGES']);
    expect([...togglePrivilege(new Set(['ALL PRIVILEGES']), 'SELECT', PRIVILEGES)]).toEqual(['SELECT']);
    expect(toPayload(m)).toEqual([{ database: 'demo_shop', privileges: ['SELECT'] }, { database: 'demo_old', privileges: ['ALL PRIVILEGES'] }]);
  });

  it('renders one column per database and one row per privilege, greying out rows under all privileges', () => {
    const m = buildMatrix([{ database: 'demo_old', privileges: ['ALL PRIVILEGES'] }], ['demo_shop']);
    const html = renderToStaticMarkup(h(PrivilegeGrid, { matrix: m, privileges: PRIVILEGES, onChange: () => {} }));
    expect(html).toContain('table-wrap');
    expect(html).toContain('<code>demo_shop</code>');
    expect(html).toContain('<code>demo_old</code>');
    expect((html.match(/type="checkbox"/g) || []).length).toBe(PRIVILEGES.length * 2);
    expect(html).toContain('aria-label="SELECT on demo_old" disabled="" checked=""');
    expect(html).toContain('aria-label="ALL PRIVILEGES on demo_old" checked=""');
    expect(renderToStaticMarkup(h(PrivilegeGrid, { matrix: new Map(), privileges: PRIVILEGES, onChange: () => {} }))).toContain('no databases yet');
  });
});

describe('Remote hosts page', () => {
  it('lists own and server-wide hosts, with the connection facts and the add form', () => {
    reset();
    set('/databases/access-hosts', { data: [{ id: 1, host: '203.0.113.5', scope: 'account', editable: true, created_at: '2026-11-01 10:00:00' }, { id: 2, host: '10.0.0.%', scope: 'global', editable: false, created_at: null }], meta: { total: 2, engine: 'mysql', supported: true } });
    const html = render(h(RemoteHosts, { fn: fn('panel:databases/remote-hosts') }), '/panel/databases/remote-hosts');
    expect(html).toContain('<h1>Remote hosts</h1>');
    expect(html).toContain('Allow a remote host');
    expect(html).toContain('<code>203.0.113.5</code>');
    expect(html).toContain('<code>10.0.0.%</code>');
    expect(html).toContain('Server-wide');
    expect(html).toContain('>Remove<');
    expect((html.match(/>Remove</g) || []).length).toBe(1);
    expect(html).toContain('<code>srv1.example</code>');
    expect(html).toContain('<code>3306</code>');
    expect(html).toContain('cannot be removed here');
  });

  it('renders 501, 403 and the PostgreSQL unsupported state', () => {
    reset();
    set('/databases/access-hosts', { error: capability });
    expect(render(h(RemoteHosts, { fn: fn('panel:databases/remote-hosts') }), '/panel/databases/remote-hosts')).toContain('Not available on this server');
    reset();
    set('/databases/access-hosts', { error: disabled });
    expect(render(h(RemoteHosts, { fn: fn('panel:databases/remote-hosts') }), '/panel/databases/remote-hosts')).toContain('Not included in your plan');
    reset();
    // A PostgreSQL server on another machine: its pg_hba.conf is out of reach.
    set('/databases/access-hosts', { data: [], meta: { total: 0, engine: 'postgres', supported: false } });
    const html = render(h(RemoteHosts, { fn: fn('panel:databases/remote-hosts') }), '/panel/databases/remote-hosts');
    expect(html).toContain('Not available for this PostgreSQL server');
    expect(html).not.toContain('Allow host');
  });

  it('on a local PostgreSQL server offers networks, names the pg_hba.conf rule and shows port 5432', () => {
    reset();
    set('/databases/access-hosts', { data: [{ id: 3, host: '203.0.113.0/24', scope: 'account', editable: true, created_at: '2026-11-06 10:00:00' }], meta: { total: 1, engine: 'postgres', supported: true } });
    const html = render(h(RemoteHosts, { fn: fn('panel:databases/remote-hosts') }), '/panel/databases/remote-hosts');
    expect(html).toContain('Allow host');
    expect(html).toContain('pg_hba.conf');
    expect(html).toContain('<code>5432</code>');
    expect(html).toContain('<code>203.0.113.0/24</code>');
    expect(html).toContain('network');
    expect(html).not.toContain('Not available for this PostgreSQL server');
    expect(describeHost('203.0.113.0/24')).toBe('network');
  });

  it('describeHost', () => {
    expect(describeHost('%')).toBe('any host');
    expect(describeHost('203.0.113.%')).toBe('pattern');
    expect(describeHost('203.0.113.5')).toBe('IP address');
    expect(describeHost('2001:db8::1')).toBe('IP address');
    expect(describeHost('office.example.com')).toBe('host name');
  });
});

describe('phpMyAdmin page', () => {
  it('links to the published address and lists the user names to type (no prefill: phpMyAdmin only reads pma_username from POST)', () => {
    reset();
    set('/databases/phpmyadmin', { data: { installed: true, url: 'https://srv1.example/phpmyadmin/', featureEnabled: true, version: '5.2.1', users: ['demo_app', 'demo_ro'] } });
    const html = render(h(PhpMyAdmin, { fn: fn('panel:databases/phpmyadmin') }), '/panel/databases/phpmyadmin');
    expect(html).toContain('<h1>phpMyAdmin</h1>');
    expect(html).toContain('Open phpMyAdmin');
    expect(html).toContain('href="https://srv1.example/phpmyadmin/"');
    expect(html).not.toContain('pma_username');
    expect(html).not.toContain('fills in');
    expect(html).toContain('demo_app');
    expect(html).toContain('demo_ro');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('5.2.1');
    expect(html).toContain('Available');
    expect(html).toContain('href="/panel/databases/users"');
  });

  it('explains a missing installation and lists no users, and renders 501 and 403', () => {
    reset();
    set('/databases/phpmyadmin', { data: { installed: false, url: null, featureEnabled: true, version: null, users: [] } });
    let html = render(h(PhpMyAdmin, { fn: fn('panel:databases/phpmyadmin') }), '/panel/databases/phpmyadmin');
    expect(html).toContain('phpMyAdmin is not installed on this server');
    expect(html).toContain('No database users yet');
    expect(html).not.toContain('Open phpMyAdmin');
    reset();
    set('/databases/phpmyadmin', { error: capability });
    expect(render(h(PhpMyAdmin, { fn: fn('panel:databases/phpmyadmin') }), '/panel/databases/phpmyadmin')).toContain('Not available on this server');
    reset();
    set('/databases/phpmyadmin', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    html = render(h(PhpMyAdmin, { fn: fn('panel:databases/phpmyadmin') }), '/panel/databases/phpmyadmin');
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('phpMyAdmin is not part of the hosting plan');
  });

});
