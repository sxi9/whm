import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const fixtures = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const f = path ? fixtures[path] || null : null;
    return { data: f?.data ?? null, meta: f?.meta ?? null, error: f?.error ?? null, loading: Boolean(path) && !f, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: ZoneEditor, RecordForm, RecordName, PublishState, presentRecord, formFrom, bodyFrom, filterRecords, RECORD_TYPES } = await import('../src/pages/panel/dns/zone-editor.jsx');

React.useLayoutEffect = React.useEffect;

const me = { user: { id: 7, username: 'demo', role: 'user' }, account: { username: 'demo', domain: 'demo.example.com', features: {}, limits: {} }, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:dns/zone-editor'];
const render = (el, path = fn.path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

const records = [
  { id: 13, name: '@', type: 'A', ttl: null, priority: null, value: '127.0.0.1', line_index: 4 },
  { id: 14, name: 'www', type: 'CNAME', ttl: 3600, priority: null, value: 'demo.example.com.', line_index: 5 },
  { id: 17, name: '@', type: 'MX', ttl: null, priority: 10, value: 'mail.demo.example.com.', line_index: 8 },
  { id: 18, name: '@', type: 'TXT', ttl: null, priority: null, value: 'v=spf1 +mx ~all', line_index: 9 },
  { id: 19, name: '_sip._tcp', type: 'SRV', ttl: null, priority: 5, value: '10 5060 sip.demo.example.com.', line_index: 10 },
  { id: 20, name: '@', type: 'CAA', ttl: null, priority: null, value: '0 issue letsencrypt.org', line_index: 11 },
];
const zonesFixture = { data: { zones: [
  { id: 2, domain: 'demo.example.com', serial: 2026110301, ttl: 14400, type: 'master', dnssecEnabled: false, updatedAt: '2026-11-03 21:18:42', records: 6, sync: [] },
  { id: 3, domain: 'second.example.org', serial: 2026110302, ttl: 3600, type: 'master', dnssecEnabled: true, updatedAt: '2026-11-03 21:20:00', records: 2, sync: [{ cluster: 'ns-cluster', status: 'synced', serial: 2026110302, synced_at: '2026-11-03 21:20:01' }] },
], types: RECORD_TYPES } };
const zoneFixture = { data: { id: 2, domain: 'demo.example.com', serial: 2026110301, ttl: 14400, published: false, records, types: RECORD_TYPES } };

describe('record helpers', () => {
  it('presentRecord strips trailing dots and splits SRV and CAA', () => {
    expect(presentRecord(records[1]).display).toBe('demo.example.com');
    expect(presentRecord(records[2]).display).toBe('mail.demo.example.com');
    expect(presentRecord(records[4])).toMatchObject({ srv: { weight: 10, port: 5060, target: 'sip.demo.example.com' }, display: '10 5060 sip.demo.example.com' });
    expect(presentRecord(records[5]).caa).toEqual({ flags: '0', tag: 'issue', value: 'letsencrypt.org' });
    expect(presentRecord({ type: 'CAA', value: '128 iodef "mailto:a@b.c"' }).caa).toEqual({ flags: '128', tag: 'iodef', value: 'mailto:a@b.c' });
  });

  it('formFrom and bodyFrom round-trip every type the panel exposes', () => {
    expect(bodyFrom(formFrom(records[0]))).toEqual({ name: '@', type: 'A', ttl: null, value: '127.0.0.1' });
    expect(bodyFrom(formFrom(records[1]))).toEqual({ name: 'www', type: 'CNAME', ttl: '3600', value: 'demo.example.com' });
    expect(bodyFrom(formFrom(records[2]))).toEqual({ name: '@', type: 'MX', ttl: null, priority: 10, value: 'mail.demo.example.com' });
    expect(bodyFrom(formFrom(records[3]))).toEqual({ name: '@', type: 'TXT', ttl: null, value: 'v=spf1 +mx ~all' });
    expect(bodyFrom(formFrom(records[4]))).toEqual({ name: '_sip._tcp', type: 'SRV', ttl: null, priority: 5, value: '10 5060 sip.demo.example.com' });
    expect(bodyFrom(formFrom(records[5]))).toEqual({ name: '@', type: 'CAA', ttl: null, value: '0 issue letsencrypt.org' });
    expect(bodyFrom({ name: '  ', type: 'A', ttl: '1h', value: ' 203.0.113.5 ' })).toEqual({ name: '@', type: 'A', ttl: '1h', value: '203.0.113.5' });
    expect(bodyFrom({ name: '@', type: 'MX', ttl: '', priority: '', value: 'mx' })).toMatchObject({ priority: null });
  });

  it('filterRecords narrows by type and by name/value text', () => {
    expect(filterRecords(records, 'all', '').length).toBe(6);
    expect(filterRecords(records, 'A', '').map((r) => r.id)).toEqual([13]);
    expect(filterRecords(records, 'all', 'mail.').map((r) => r.id)).toEqual([17]);
    expect(filterRecords(records, 'TXT', 'spf').map((r) => r.id)).toEqual([18]);
    expect(filterRecords(records, 'CNAME', 'spf')).toEqual([]);
  });
});

describe('Zone editor page', () => {
  it('shows the zone summary, the type filter with counts and every editable record', () => {
    fixtures['/panel/dns/zones'] = zonesFixture;
    fixtures['/panel/dns/zones/demo.example.com'] = zoneFixture;
    const html = render(h(ZoneEditor, { fn }));
    expect(html).toContain('<h1>Zone editor</h1>');
    expect(html).toContain('Add record');
    expect(html).toContain('<option value="demo.example.com" selected="">');
    expect(html).toContain('<option value="second.example.org">');
    expect(html).toContain('14400 s');
    expect(html).toContain('2026110301');
    expect(html).toContain('Not yet publishing');
    expect(html).toContain('Changes are saved, not yet served');
    expect(html).toContain('All 6');
    expect(html).toContain('CNAME 1');
    expect(html).toContain('AAAA 0');
    expect(html).toContain('<strong>www</strong>');
    expect(html).toContain('.demo.example.com');
    expect(html).toContain('mail.demo.example.com');
    expect(html).not.toContain('mail.demo.example.com.<');
    expect(html).toContain('10 5060 sip.demo.example.com');
    expect(html).toContain('0 issue letsencrypt.org');
    expect(html).toContain('>default<');
    expect(html).toContain('>3600<');
    expect(html).toContain('Edit');
    expect(html).toContain('Delete');
    expect(html).not.toContain('>SOA<');
  });

  it('selects the zone named in the URL and shows its DNSSEC and cluster state', () => {
    fixtures['/panel/dns/zones'] = zonesFixture;
    fixtures['/panel/dns/zones/second.example.org'] = { data: { ...zoneFixture.data, id: 3, domain: 'second.example.org', ttl: 3600, published: true, records: [] } };
    const html = render(h(ZoneEditor, { fn }), `${fn.path}?zone=second.example.org`);
    expect(html).toContain('<option value="second.example.org" selected="">');
    expect(html).toContain('Serving this zone');
    expect(html).toContain('DNSSEC');
    expect(html).toContain('ns-cluster: synced');
    expect(html).not.toContain('Changes are saved, not yet served');
    expect(html).toContain('No editable records in this zone yet');
  });

  it('renders the empty state without zones, the 501 capability state and other errors', () => {
    fixtures['/panel/dns/zones'] = { data: { zones: [], types: RECORD_TYPES } };
    expect(render(h(ZoneEditor, { fn }))).toContain('No DNS zones on this account');
    fixtures['/panel/dns/zones'] = zonesFixture;
    fixtures['/panel/dns/zones/demo.example.com'] = { error: { status: 501, code: 'capability_missing', message: 'BIND (named) is not installed' } };
    const cap = render(h(ZoneEditor, { fn }));
    expect(cap).toContain('Not available on this server');
    expect(cap).toContain('BIND (named) is not installed');
    expect(cap).toContain('<h1>Zone editor</h1>');
    fixtures['/panel/dns/zones'] = { error: { status: 503, code: 'service_unavailable', message: 'The DNS category is not loaded' } };
    expect(render(h(ZoneEditor, { fn }))).toContain('The DNS category is not loaded');
  });

  it('the record form shows the fields of its type', () => {
    const zone = zoneFixture.data;
    const a = render(h(RecordForm, { zone, initial: null, types: RECORD_TYPES, onClose: () => {}, onSaved: () => {} }));
    expect(a).toContain('Add a record');
    expect(a).toContain('IPv4 address');
    expect(a).toContain('zone default of 14400 s');
    expect(a).toContain('form="record-form"');
    const mx = render(h(RecordForm, { zone, initial: records[2], types: RECORD_TYPES, onClose: () => {}, onSaved: () => {} }));
    expect(mx).toContain('Edit MX record');
    expect(mx).toContain('Mail server');
    expect(mx).toContain('value="10"');
    expect(mx).toContain('value="mail.demo.example.com"');
    const srv = render(h(RecordForm, { zone, initial: records[4], types: RECORD_TYPES, onClose: () => {}, onSaved: () => {} }));
    expect(srv).toContain('Weight');
    expect(srv).toContain('Port');
    expect(srv).toContain('value="5060"');
    expect(srv).toContain('value="sip.demo.example.com"');
    const caa = render(h(RecordForm, { zone, initial: records[5], types: RECORD_TYPES, onClose: () => {}, onSaved: () => {} }));
    expect(caa).toContain('Certificate authority');
    expect(caa).toContain('value="letsencrypt.org"');
    expect(caa).toContain('<option value="issue" selected="">');
  });

  it('names and publish state read naturally', () => {
    expect(renderToStaticMarkup(h(RecordName, { name: '@', domain: 'demo.example.com' }))).toBe('<strong>demo.example.com</strong>');
    expect(renderToStaticMarkup(h(RecordName, { name: 'www', domain: 'demo.example.com' }))).toContain('<span class="muted">.demo.example.com</span>');
    expect(renderToStaticMarkup(h(PublishState, { result: { applied: false, reason: 'capability_missing', serial: 5 } }))).toContain('Pending');
    expect(renderToStaticMarkup(h(PublishState, { result: { applied: true, serial: 5 } }))).toContain('Published');
    expect(renderToStaticMarkup(h(PublishState, { result: null }))).toBe('');
  });
});
