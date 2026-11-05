import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/hooks/useApi.js', () => ({
  useApi: () => ({ data: null, meta: null, error: null, loading: true, refetch: () => {}, setData: () => {} }),
  useMutation: () => ({ mutate: async () => {}, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));
vi.mock('../src/api/client.js', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, queryString: () => '' }));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { OutboundRelayCard, relayState, IPV6_OPTIONS } = await import('../src/pages/fn/service-configuration/exim-configuration-manager.jsx');
const { webmailState } = await import('../src/pages/fn/cpanel/customization.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, null, el))));

const settings = { smarthost: { host: 'smtp.relay.example', port: 587, requireTls: true, auth: { user: 'apikey', passwordSet: true } }, ipv6: 'auto' };
const live = { setting: settings.smarthost, configured: true, host: 'smtp.relay.example', port: 587, auth: true, hooked: true, precedes: true, hookable: true, routerFile: '/etc/exim4/conf.d/router/150_whm_smarthost', passwdFile: '/etc/exim4/passwd.client', hints: [], error: null };
const data = { settings, smarthost: live, ipv6: { setting: 'auto', hostGlobal: false, disabled: true } };

describe('Exim Configuration Manager › Outbound relay card', () => {
  it('shows a live relay with its router, credential and the stored-password hint', () => {
    const html = render(h(OutboundRelayCard, { data, draft: settings, set: () => () => {} }));
    expect(html).toContain('<h2>Outbound relay</h2>');
    expect(html).toContain('Relaying through smtp.relay.example:587');
    expect(html).toContain('value="smtp.relay.example"');
    expect(html).toContain('value="587"');
    expect(html).toContain('value="apikey"');
    expect(html).toContain('A password is stored; leave empty to keep it');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('S3cret');
    expect(html).toContain('150_whm_smarthost');
    expect(html).toContain('passwd.client');
    expect(html).toContain('<dt>Before dnslookup</dt><dd><span class="pill pill-ok">Yes</span></dd>');
  });

  it('shows the manual include line for an unsplit host and the off state without a relay', () => {
    const unsplit = { ...data, smarthost: { ...live, hooked: false, precedes: null, hookable: false, routerFile: '/etc/exim4/whm/router_whm_smarthost.conf', hints: ['Add ".include_if_exists /etc/exim4/whm/router_whm_smarthost.conf" directly after "begin routers" (before the dnslookup router) in /etc/exim4/exim4.conf.template once, then run update-exim4.conf (Debian) and reload Exim; the panel never edits that file.'] } };
    const html = render(h(OutboundRelayCard, { data: unsplit, draft: settings, set: () => () => {} }));
    expect(html).toContain('Written, not loaded');
    expect(html).toContain('router_whm_smarthost.conf&quot; directly after');
    const off = render(h(OutboundRelayCard, { data: { settings: { smarthost: null }, smarthost: { setting: null, configured: false, hints: [] } }, draft: { smarthost: null }, set: () => () => {} }));
    expect(off).toContain('Direct delivery');
    expect(off).not.toContain('Relay host');
    expect(relayState({ setting: settings.smarthost, configured: true, hooked: true, precedes: false })).toMatchObject({ status: 'warning', label: 'Loaded after dnslookup' });
    expect(relayState({ setting: null, configured: true, routerFile: '/x' })).toMatchObject({ label: 'Router left behind' });
    expect(relayState({ setting: settings.smarthost, configured: false })).toMatchObject({ status: 'pending' });
    expect(relayState({ error: 'agent down' })).toMatchObject({ status: 'unknown' });
    expect(IPV6_OPTIONS.map((o) => o.value)).toEqual(['auto', 'on', 'off']);
  });
});

describe('Panel › Customization › Webmail card: truthful publish state', () => {
  const base = { installed: true, apache: true, fqdn: true, hostname: 'nova.example', flavor: 'roundcube', version: '1.6.11', published: { managed: true, alias: '/webmail', file: '/x' }, site: { exists: true, enabled: true, ssl: true }, config: { exists: true, inSync: true } };
  it('reports "Published but answering 500" with the PHP fatal, and Published when the probe is fine or impossible', () => {
    expect(webmailState({ ...base, http: { status: 200, ok: true } })).toMatchObject({ status: 'active', label: 'Published' });
    expect(webmailState({ ...base, http: { status: null, ok: null, error: 'timeout' } })).toMatchObject({ status: 'active' });
    expect(webmailState({ ...base, http: { status: 500, ok: false, phpFatal: 'PHP Fatal error:  Cannot redeclare array_first()' }, warning: 'Published but answering 500: PHP Fatal error:  Cannot redeclare array_first()' })).toEqual({ status: 'failed', label: 'Published but answering 500', detail: 'Published but answering 500: PHP Fatal error:  Cannot redeclare array_first()' });
    expect(webmailState({ ...base, http: { status: 404, ok: false } }).label).toBe('Published but answering 404');
    expect(webmailState({ ...base, config: { exists: true, inSync: false }, http: { status: 500, ok: false } }).label).toBe('Mail hosts out of date');
  });
});
