import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map(), posts: [], role: 'root' }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: fixtures.role }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));
vi.mock('../src/api/client.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { ...mod.api, post: async (path, body) => { fixtures.posts.push([path, body]); return { data: { job: { id: 7 } } }; } } };
});

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { UpdatesBanner, UpdateRow, updateRequest, updateSummary } = await import('../src/pages/home/UpdatesBanner.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(h(MemoryRouter, null, h(ToastProvider, null, h(ConfirmProvider, null, el))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });
// The providers render their own (empty) toast stack, so an absent banner is this markup.
const EMPTY = render(null);

const ITEMS = [
  { kind: 'php', id: '8.3', label: 'PHP 8.3', current: '8.3.35', candidate: '8.3.36-1', severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell (fixed in 8.3.36)', '2 package updates pending (security)'], layout: 'debian', packages: ['php8.3-fpm', 'php8.3-cli'], unit: 'php8.3-fpm', action: { method: 'POST', path: '/software/php/update', body: { version: '8.3' } } },
  { kind: 'php', id: '8.1', label: 'PHP 8.1', current: '8.1.31', candidate: null, severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell'], layout: 'debian', packages: [], unit: 'php8.1-fpm', action: null },
  { kind: 'package', id: 'openssl', label: 'OpenSSL', current: '3.0.13-3.4', candidate: '3.0.13-3.5', severity: 'security', reasons: ['openssl 3.0.13-3.4 → 3.0.13-3.5 (security)'], packages: ['openssl'], action: { method: 'POST', path: '/software/update/run', body: { packages: ['openssl'], dist: false, refreshIndex: false } } },
  { kind: 'tool', id: 'git', label: 'Git', current: '2.43.0-1', candidate: '2.43.0-2', severity: 'update', reasons: ['git 2.43.0-1 → 2.43.0-2'], packages: ['git'], action: { method: 'POST', path: '/software/runtimes/update', body: { tool: 'git' } } },
  { kind: 'runtime', id: 'nodejs:22', label: 'Node.js 22', current: 'v22.11.0', candidate: 'v22.14.0', severity: 'update', reasons: ['nodejs.org released v22.14.0'], packages: [], action: { method: 'POST', path: '/software/runtimes/update', body: { runtime: 'nodejs', version: '22' } } },
];

describe('Home updates banner', () => {
  it('renders one row per item with its severity, versions, reasons and an Update button naming the candidate', () => {
    fixtures.responses.clear();
    set('/software/updates/critical', { data: { checkedAt: '2026-11-06T06:00:00.000Z', packagesCheckedAt: '2026-11-06T05:41:00.000Z', items: ITEMS } });
    const html = render(h(UpdatesBanner));
    expect(html).toContain('Updates that need attention');
    expect(html).toContain('<strong>PHP 8.3</strong>');
    expect(html).toContain('8.3.35');
    expect(html).toContain('→ 8.3.36-1');
    expect(html).toContain('CVE-2026-109619: PHP2Shell (fixed in 8.3.36)');
    expect(html).toMatch(/<button type="button" class="btn btn-danger btn-sm[^"]*">Update to 8\.3\.36-1<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-sm[^"]*">Update to 2\.43\.0-2<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-sm[^"]*">Update to v22\.14\.0<\/button>/);
    expect(html).toContain('>Critical<');
    expect(html).toContain('>Security<');
    expect(html).toContain('>Update<');
    expect((html.match(/>Critical</g) || []).length).toBe(2);
    expect(html).toContain('no fix available yet');
    expect((html.match(/Update to /g) || []).length).toBe(4);
    expect(html).toContain('Check again');
    expect(html).toContain('System Update');
  });

  it('is hidden while the list is empty, still loading, or for a non-root user', () => {
    fixtures.responses.clear();
    set('/software/updates/critical', { data: { checkedAt: '2026-11-06T06:00:00.000Z', packagesCheckedAt: null, items: [] } });
    expect(render(h(UpdatesBanner))).toBe(EMPTY);
    fixtures.responses.clear();
    expect(render(h(UpdatesBanner))).toBe(EMPTY);
    set('/software/updates/critical', { data: { items: ITEMS } });
    fixtures.role = 'reseller';
    try { expect(render(h(UpdatesBanner))).toBe(EMPTY); } finally { fixtures.role = 'root'; }
  });

  it('narrows to the given kinds for a category page', () => {
    fixtures.responses.clear();
    set('/software/updates/critical', { data: { items: ITEMS } });
    const tools = render(h(UpdatesBanner, { kinds: ['tool'], title: 'Installed tools with updates' }));
    expect(tools).toContain('Installed tools with updates');
    expect(tools).toContain('<strong>Git</strong>');
    expect(tools).not.toContain('PHP 8.3');
    expect(tools).not.toContain('Node.js 22');
    const runtimes = render(h(UpdatesBanner, { kinds: ['php', 'runtime'] }));
    expect(runtimes).toContain('PHP 8.3');
    expect(runtimes).toContain('Node.js 22');
    expect(runtimes).not.toContain('<strong>Git</strong>');
    expect(render(h(UpdatesBanner, { kinds: ['nothing'] }))).toBe(EMPTY);
  });

  it('the Update button posts exactly the action the server named, and nothing without one', async () => {
    fixtures.posts.length = 0;
    const { api } = await import('../src/api/client.js');
    for (const item of ITEMS) {
      const request = updateRequest(item);
      if (!request) { expect(item.action).toBeNull(); continue; }
      await api.post(request[0], request[1]);
    }
    expect(fixtures.posts).toEqual([
      ['/software/php/update', { version: '8.3' }],
      ['/software/update/run', { packages: ['openssl'], dist: false, refreshIndex: false }],
      ['/software/runtimes/update', { tool: 'git' }],
      ['/software/runtimes/update', { runtime: 'nodejs', version: '22' }],
    ]);
    expect(updateRequest({ action: { method: 'GET', path: '/x' } })).toBeNull();
    expect(updateRequest({ action: { method: 'POST' } })).toBeNull();
    expect(updateRequest({ action: { method: 'POST', path: '/software/php/update' } })).toEqual(['/software/php/update', {}]);
    expect(updateSummary(ITEMS[0])).toContain('php8.3-fpm, php8.3-cli to 8.3.36-1 and reloads php8.3-fpm');
    expect(updateSummary({ ...ITEMS[0], layout: 'keel', packages: [] })).toContain('php.net 8.3.36-1 source over /opt/keel/php/8.3');
    expect(updateSummary(ITEMS[4])).toContain('/opt/keel/node/22');
    expect(updateSummary(ITEMS[3])).toContain('no dist-upgrade');
    const row = render(h('table', null, h('tbody', null, h(UpdateRow, { item: ITEMS[1], onUpdate: () => {} }))));
    expect(row).toContain('no fix available yet');
    expect(row).not.toContain('<button');
  });
});
