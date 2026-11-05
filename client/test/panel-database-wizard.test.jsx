import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (p) => ({ data: null, meta: null, error: null, loading: Boolean(p), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(p) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_FUNCTION_BY_PATH, featureEnabled } = await import('../src/panel/nav.js');
const { default: Wizard, STEPS, stepState, initialMatrix, summarizePrivileges } = await import('../src/pages/panel/databases/wizard.jsx');
const { toPayload } = await import('../src/pages/panel/databases/parts/GrantsEditor.jsx');
const { untranslated } = await import('../src/i18n/fill.js');

React.useLayoutEffect = React.useEffect;

const ROOT = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/en.json'), 'utf8'));

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: { max_sql: 10 }, features: { mysql: true, dbwizard: true }, limits: {}, domains: [] },
  usage: {}, counts: { databases: 2, ftp: 0 }, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:databases/wizard'];
const render = (el, p = '/panel/databases/wizard') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [p] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (p, value) => fixtures.responses.set(`/panel${p}`, { loading: false, ...value });
const reset = () => fixtures.responses.clear();
const dbMeta = { total: 2, engine: 'mysql', engineError: null, quota: { max: 10, used: 2, remaining: 8 }, prefix: 'demo_' };
const capability = { status: 501, code: 'capability_missing', message: 'MySQL/MariaDB is not installed on this server (no mysql, mysqld or mariadbd binary)', capability: 'mysql' };
const disabled = { status: 403, code: 'feature_disabled', message: 'The "mysql" feature is not enabled for this account\'s package' };

describe('Database wizard page', () => {
  it('is a nav function under Databases gated by the dbwizard feature with its catalogue keys', () => {
    expect(fn).toBeTruthy();
    expect(fn.path).toBe('/panel/databases/wizard');
    expect(PANEL_FUNCTION_BY_PATH['/panel/databases/wizard']).toBe(fn);
    expect(fn.feature).toBe('dbwizard');
    expect(featureEnabled({ dbwizard: false }, 'dbwizard')).toBe(false);
    expect(featureEnabled({ mysql: true }, 'dbwizard')).toBe(true);
    expect(catalog['panel.databases/wizard.label']).toBe('Database wizard');
    expect(catalog['panel.databases/wizard.description']).toBe(fn.description);
  });

  it('every panel.databases key the page uses exists in en.json', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/pages/panel/databases/wizard.jsx'), 'utf8');
    const keys = [...src.matchAll(/t\('(panel\.databases[^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(catalog[key], `missing catalogue key ${key}`).toBeDefined();
    const pluralKeys = [...src.matchAll(/plural\(t, '(panel\.databases[^']+)'/g)].map((m) => m[1]);
    for (const key of pluralKeys) { expect(catalog[`${key}_one`]).toBeDefined(); expect(catalog[`${key}_other`]).toBeDefined(); }
  });

  it('renders step 1 with the fixed prefix, the step list and the character set (MySQL)', () => {
    reset();
    set('/databases', { data: [], meta: dbMeta });
    const html = render(h(Wizard, { fn }));
    expect(html).toContain('<h1>Database wizard</h1>');
    expect(html).toContain('aria-label="Steps"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('1 Database');
    expect(html).toContain('2 User');
    expect(html).toContain('3 Privileges');
    expect(html).toContain('Step 1: Create a database');
    expect(html).toContain('value="demo_"');
    expect(html).toContain('id="wiz-db-name"');
    expect(html).toContain('id="wiz-db-charset"');
    expect(html).toContain('>Next step<');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).not.toContain('Start over');
    expect(html).not.toContain('Step 2');
  });

  it('hides the character set on PostgreSQL and blocks step 1 at the plan limit', () => {
    reset();
    set('/databases', { data: [], meta: { ...dbMeta, engine: 'postgres' } });
    expect(render(h(Wizard, { fn }))).not.toContain('id="wiz-db-charset"');
    set('/databases', { data: [], meta: { ...dbMeta, quota: { max: 2, used: 2, remaining: 0 } } });
    const full = render(h(Wizard, { fn }));
    expect(full).toContain('Your plan allows 2 databases and all of them are in use');
    expect(full).toMatch(/id="wiz-db-name"[^>]*disabled=""/);
    set('/databases', { data: [], meta: { ...dbMeta, quota: { max: 0, used: 0, remaining: 0 } } });
    expect(render(h(Wizard, { fn }))).toContain('Your plan does not include databases');
  });

  it('renders the capability state on 501 and the plan state on 403', () => {
    reset();
    set('/databases', { error: capability });
    const html = render(h(Wizard, { fn }));
    expect(html).toContain('Not available on this server');
    expect(html).toContain('Step 1: Create a database');
    set('/databases', { error: disabled });
    const off = render(h(Wizard, { fn }));
    expect(off).toContain('Not included in your plan');
    expect(off).not.toContain('Step 1');
  });

  it('pure helpers: step states, the default all-privileges matrix and the grants summary', () => {
    expect(STEPS).toEqual(['database', 'user', 'grants']);
    expect([0, 1, 2].map((i) => stepState(1, i))).toEqual(['done', 'current', 'pending']);
    expect([0, 1, 2].map((i) => stepState(STEPS.length, i))).toEqual(['done', 'done', 'done']);
    const matrix = initialMatrix('demo_shop');
    expect(toPayload(matrix)).toEqual([{ database: 'demo_shop', privileges: ['ALL PRIVILEGES'] }]);
    expect(toPayload(new Map([['demo_shop', new Set()]]))).toEqual([]);
    expect(summarizePrivileges(new Set(['ALL PRIVILEGES']), untranslated)).toBe('all privileges');
    expect(summarizePrivileges(new Set(['SELECT', 'INSERT']), untranslated)).toBe('select, insert');
    expect(summarizePrivileges(new Set(), untranslated)).toBe('no access');
  });
});
