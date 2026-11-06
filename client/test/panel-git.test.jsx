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
const { PANEL_FUNCTION_BY_KEY, visibleCategories } = await import('../src/panel/nav.js');
const { default: Git, nameProblem, urlProblem, dirProblem, jobStreamPath, KEEL_EXAMPLE } = await import('../src/pages/panel/files/git.jsx');
const { PANEL_PAGE_REGISTRY } = await import('../src/panel/registry.js');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: {}, limits: {}, contactEmail: 'owner@demo.example.com', domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:files/git'];
const render = (el, p) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [p] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (p, value) => fixtures.responses.set(p, { loading: false, ...value });
const rows = [
  { id: 3, name: 'hello', dir: 'repositories/hello', url: 'https://github.com/git/hello-world.git', createdAt: '2026-11-06T10:00:00.000Z', lastPullAt: '2026-11-06T11:00:05.000Z', lastDeployAt: null, present: true },
  { id: 4, name: 'notes', dir: 'apps/notes', url: null, createdAt: '2026-11-06T10:00:00.000Z', lastPullAt: null, lastDeployAt: null, present: null },
];
const meta = { total: 2, max: 50, defaultRoot: 'repositories', unregistered: [{ dir: 'repositories/handmade', name: 'handmade' }] };

describe('nav entry of the Files group', () => {
  it('is registered with its plan feature, page and i18n keys', () => {
    expect(fn).toMatchObject({ feature: 'gitversioncontrol', path: '/panel/files/git', categorySlug: 'files', key: 'panel:files/git' });
    expect(PANEL_PAGE_REGISTRY['panel:files/git']).toBeTruthy();
    expect(visibleCategories({ gitversioncontrol: false }).find((c) => c.slug === 'files').functions.some((f) => f.slug === 'git')).toBe(false);
    expect(visibleCategories({}).find((c) => c.slug === 'files').functions.some((f) => f.slug === 'git')).toBe(true);
    expect(jobStreamPath(12)).toBe('/panel/git/jobs/12/stream');
    const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/i18n/en.json'), 'utf8'));
    expect(en['panel.files/git.label']).toBe('Git version control');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/pages/panel/files/git.jsx'), 'utf8');
    for (const key of src.matchAll(/t\('(panel\.git\.[a-z0-9_]+)'/g)) expect(en[key[1]], key[1]).toBeDefined();
  });
});

describe('client-side checks', () => {
  it('refuse the URLs the server would refuse and accept the rest', () => {
    expect(urlProblem('')).toBeNull();
    expect(urlProblem('https://github.com/git/hello-world.git')).toBeNull();
    expect(urlProblem('ssh://git@github.com/org/repo.git')).toBeNull();
    expect(urlProblem('git@github.com:org/repo.git')).toBeNull();
    expect(urlProblem('file:///etc/passwd')).toMatch(/Only https/);
    expect(urlProblem('ext::sh -c id')).toMatch(/Only https/);
    expect(urlProblem('https://user:pw@github.com/org/repo')).toMatch(/user name and password/);
    expect(urlProblem('ssh://root@host/repo')).toMatch(/user name and password/);
    expect(urlProblem('alice@host:repo')).toMatch(/user name and password/);
    expect(urlProblem('http://github.com/org/repo')).toMatch(/https:\/\/ URL/);
    expect(nameProblem('probe-repo')).toBeNull();
    expect(nameProblem('bad name')).toMatch(/Letters/);
    expect(nameProblem('x.git')).toMatch(/Letters/);
    expect(dirProblem('repositories/x')).toBeNull();
    expect(dirProblem('/etc')).toMatch(/relative/);
    expect(dirProblem('a/../b')).toMatch(/\.\./);
    expect(KEEL_EXAMPLE).toMatch(/^deployment:\n {2}tasks:/);
  });
});

describe('Git page', () => {
  it('renders the repositories, the unregistered hint and the deployment guide', () => {
    fixtures.responses.clear();
    set('/panel/git', { data: rows, meta });
    const html = render(h(Git, { fn }), fn.path);
    expect(html).toContain('<h1>Git version control</h1>');
    expect(html).toContain('hello</button>');
    expect(html).toContain('<code>~/repositories/hello</code>');
    expect(html).toContain('https://github.com/git/hello-world.git');
    expect(html).toContain('none (local only)');
    expect(html).toContain('>Ready<');
    expect(html).toContain('>Open<');
    expect(html).toContain('<code>handmade</code>');
    expect(html).toContain('Deployment guide');
    expect(html).toContain('deployment:');
    expect(html).toContain('rsync -a --delete dist/ ~/public_html/site/');
    expect(html).toContain('New repository');
    expect(html).toContain('2 of 50');
  });

  it('shows the detail card for ?repo= with branch, commit, remotes and the deployment file state', () => {
    fixtures.responses.clear();
    set('/panel/git', { data: rows, meta });
    set('/panel/git/3', { data: { ...rows[0], missing: false, info: { branch: 'main', head: { sha: 'a'.repeat(40), short: 'aaaaaaaaaaaa', subject: 'Initial import', date: '2026-11-06T10:00:00+00:00' }, remotes: [{ name: 'origin', url: 'https://github.com/git/hello-world.git', push: null }], dirty: 2, lastPullAt: null, hasKeelYml: true } } });
    const html = render(h(Git, { fn }), `${fn.path}?repo=3`);
    expect(html).toContain('<code>main</code>');
    expect(html).toContain('<code>aaaaaaaaaaaa</code> Initial import');
    expect(html).toContain('<code>origin</code>');
    expect(html).toContain('2 file(s)');
    expect(html).toContain('.keel.yml found');
    expect(html).toContain('Check tasks');
    expect(html).toContain('Pull</button>');
    expect(html).toContain('Deploy</button>');
    expect(html).toContain('Remove</button>');
    expect(html).toContain('href="/panel/files/file-manager?path=repositories%2Fhello"');
  });

  it('marks a missing folder and renders the empty state, the feature-disabled and the capability states', () => {
    fixtures.responses.clear();
    set('/panel/git', { data: [{ ...rows[1], present: false }], meta: { ...meta, unregistered: [] } });
    let html = render(h(Git, { fn }), fn.path);
    expect(html).toContain('>Folder missing<');
    expect(html).not.toContain('are not listed yet');
    set('/panel/git', { data: [], meta: { ...meta, total: 0, unregistered: [] } });
    html = render(h(Git, { fn }), fn.path);
    expect(html).toContain('Nothing deployed yet');
    set('/panel/git', { data: null, meta: null, error: { status: 403, code: 'feature_disabled', message: 'no' } });
    html = render(h(Git, { fn }), fn.path);
    expect(html).not.toContain('Deployment guide');
    set('/panel/git', { data: null, meta: null, error: { status: 501, code: 'capability_missing', message: 'git is not installed on this server' } });
    html = render(h(Git, { fn }), fn.path);
    expect(html).toContain('git is not installed');
    expect(html).toContain('once git is installed');
  });
});
