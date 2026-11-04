import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// GET fixtures keyed by the path useApi asks for (query string ignored).
const fixtures = new Map();
const EMPTY = { data: null, meta: null, error: null, loading: false, refetch: () => {}, setData: () => {} };
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    if (!path) return { ...EMPTY };
    const fx = fixtures.get(path.split('?')[0]);
    if (!fx) return { ...EMPTY, loading: true };
    return { ...EMPTY, ...fx };
  },
  useMutation: () => ({ mutate: async () => {}, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const post = vi.fn();
vi.mock('../src/api/client.js', () => ({ api: { get: vi.fn(), post: (...args) => post(...args), put: vi.fn() }, queryString: () => '' }));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { FUNCTION_BY_KEY } = await import('../src/nav.js');
const Page = await import('../src/pages/fn/service-configuration/exim-configuration-manager.jsx');

React.useLayoutEffect = React.useEffect;

const fn = FUNCTION_BY_KEY['service-configuration/exim-configuration-manager'];
const render = (el) => renderToStaticMarkup(h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, null, el))));
const withFixtures = (entries, run) => { fixtures.clear(); for (const [k, v] of Object.entries(entries)) fixtures.set(k, v); try { return run(); } finally { fixtures.clear(); } };

const slot = (path, hooked, extra = {}) => ({ path, exists: true, hooked, precedes: null, hookable: hooked, ...extra });
const eximData = {
  installed: true, lastApply: null, warnings: [], preview: { main: '', acl_rcpt: '', acl_data: '' },
  layout: { installed: true, flavor: 'debian', splitConfig: true, unit: { present: true, active: true, unit: 'exim4', state: 'active', enabled: true }, version: '4.97', slots: {}, hints: [] },
  support: { spf: true, dkim: true }, settings: { submissionPorts: false },
};
const vmLive = {
  enabled: true, installed: true, live: true, submissionPorts: { enabled: true, port465: true, port587: true, tls: true }, lastApply: { ok: true, at: '2026-11-04T10:00:00Z', error: null },
  exim: { installed: true, flavor: 'debian', splitConfig: true, mainConf: '/etc/exim4/exim4.conf.template', slots: { router: slot('/etc/exim4/conf.d/router/150_whm_virtual', true), transport: slot('/etc/exim4/conf.d/transport/30_whm_dovecot_lmtp', true), auth: slot('/etc/exim4/conf.d/auth/30_whm_dovecot', true) }, hints: [], manualIncludes: [] },
  dovecot: { installed: true, version: '2.3.21', include: { exists: true }, passwdDirExists: true },
  check: { routerHooked: true, authHooked: true, transportHooked: true },
  warnings: [],
};
const vmNotLive = {
  ...vmLive, live: false, enabled: true, submissionPorts: { enabled: false, port465: false, port587: false, tls: false }, lastApply: { ok: false, at: '2026-11-04T10:00:00Z', error: 'written, but Exim does not load the router' },
  exim: { ...vmLive.exim, splitConfig: false, slots: { ...vmLive.exim.slots, router: slot('/etc/exim4/whm/router.conf', false, { hookable: false }), auth: slot('/etc/exim4/whm/auth.conf', false, { hookable: false }) }, manualIncludes: [
    { slot: 'router', section: 'routers', file: '/etc/exim4/exim4.conf.template', line: '.include_if_exists /etc/exim4/whm/router.conf', where: 'directly after "begin routers" (before the local-delivery routers)' },
    { slot: 'auth', section: 'authenticators', file: '/etc/exim4/exim4.conf.template', line: '.include_if_exists /etc/exim4/whm/auth.conf', where: 'after "begin authenticators"' },
  ] },
  check: { routerHooked: false, authHooked: false, transportHooked: true },
  warnings: ['Exim does not load router, auth from /etc/exim4/exim4.conf.template'],
};

describe('Exim Configuration Manager › Virtual mailboxes card', () => {
  it('shows a live wiring with every slot hooked and the rendered check', () => {
    const html = withFixtures({ '/service-config/exim': { data: eximData }, '/service-config/virtual-mail': { data: vmLive } }, () => render(h(Page.default, { fn })));
    expect(fn).toBeTruthy();
    expect(html).toContain('<h2>Virtual mailboxes</h2>');
    expect(html).toContain('<dt>Live</dt><dd><span class="pill pill-ok">Yes</span></dd>');
    expect(html).toContain('version 2.3.21');
    expect(html).toContain('150_whm_virtual');
    expect(html).toContain('Hooked');
    expect(html).not.toContain('Not hooked');
    expect(html).toContain('Rendered check');
    expect(html).not.toContain('Manual include lines required');
    expect(html).toContain('>Apply</button>');
    expect(html).toContain('>Disable</button>');
    expect(html).toContain('465 + 587');
  });

  it('reports the effective submission ports: 587 only without the Exim TLS preset, off when disabled', () => {
    const only587 = { ...vmLive, submissionPorts: { enabled: true, port465: false, port587: true, tls: false } };
    const html = withFixtures({ '/service-config/exim': { data: eximData }, '/service-config/virtual-mail': { data: only587 } }, () => render(h(Page.default, { fn })));
    expect(html).toContain('587 only');
    expect(html).toContain('(no Exim TLS preset)');
    expect(html).not.toContain('465 + 587');
    const off = withFixtures({ '/service-config/exim': { data: eximData }, '/service-config/virtual-mail': { data: vmNotLive } }, () => render(h(Page.default, { fn })));
    expect(off).toContain('<dt>Submission ports</dt><dd><span class="pill pill-warn">Off</span></dd>');
    expect(off).not.toContain('587 only');
    expect(off).not.toContain('465 + 587');
  });

  it('shows not live, the warnings and the manual include lines for an unsplit layout', () => {
    const html = withFixtures({ '/service-config/exim': { data: eximData }, '/service-config/virtual-mail': { data: vmNotLive } }, () => render(h(Page.default, { fn })));
    expect(html).toContain('<dt>Live</dt><dd><span class="pill pill-warn">No</span></dd>');
    expect(html).toContain('Not hooked');
    expect(html).toContain('Exim does not load router, auth');
    expect(html).toContain('Manual include lines required');
    expect(html).toContain('exim4.conf.template');
    expect(html).toContain('.include_if_exists /etc/exim4/whm/router.conf    # directly after &quot;begin routers&quot;');
    expect(html).toContain('.include_if_exists /etc/exim4/whm/auth.conf    # after &quot;begin authenticators&quot;');
    expect(html).toContain('update-exim4.conf');
  });

  it('renders while the status is still loading', () => {
    const html = withFixtures({ '/service-config/exim': { data: eximData } }, () => render(h(Page.default, { fn })));
    expect(html).toContain('<h2>Virtual mailboxes</h2>');
    expect(html).toContain('Loading');
  });
});

describe('applyVirtualMail', () => {
  const toast = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
  beforeEach(() => { post.mockReset(); for (const f of Object.values(toast)) f.mockReset(); });

  it('posts {enabled:true} after confirmation and toasts the warnings', async () => {
    post.mockResolvedValue({ data: { enabled: true, applied: true, live: true, warnings: ['Dovecot lmtp is disabled'], lastApply: { ok: true } } });
    const refetch = vi.fn();
    const d = await Page.applyVirtualMail({ enabled: true, confirm: async () => true, toast, refetch });
    expect(post).toHaveBeenCalledWith('/service-config/virtual-mail/apply', { enabled: true });
    expect(d.live).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('Virtual mailboxes are live');
    expect(toast.warning).toHaveBeenCalledWith('Dovecot lmtp is disabled');
    expect(refetch).toHaveBeenCalled();
  });

  it('posts {enabled:false} and reports a written-but-not-live apply as a warning', async () => {
    post.mockResolvedValue({ data: { enabled: false, applied: true, live: false, warnings: [] } });
    await Page.applyVirtualMail({ enabled: false, confirm: async () => true, toast });
    expect(post).toHaveBeenCalledWith('/service-config/virtual-mail/apply', { enabled: false });
    expect(toast.success).toHaveBeenCalledWith('Virtual mailboxes disabled');

    post.mockResolvedValue({ data: { enabled: true, applied: true, live: false, warnings: [], lastApply: { ok: false, error: 'written, but Exim does not load the router' } } });
    await Page.applyVirtualMail({ enabled: true, confirm: async () => true, toast });
    expect(toast.warning).toHaveBeenCalledWith('Virtual mail written but not live: written, but Exim does not load the router');
  });

  it('does nothing when the confirmation is declined and warns on a missing daemon', async () => {
    expect(await Page.applyVirtualMail({ enabled: true, confirm: async () => false, toast })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    post.mockRejectedValue({ status: 501, code: 'capability_missing', message: 'Dovecot is not installed on this server.' });
    expect(await Page.applyVirtualMail({ enabled: true, confirm: async () => true, toast })).toBeNull();
    expect(toast.warning).toHaveBeenCalledWith('Dovecot is not installed on this server.');
    expect(toast.error).not.toHaveBeenCalled();
  });
});
