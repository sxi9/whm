import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));

const apiData = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: apiData[path] ?? null, meta: null, error: null, loading: !apiData[path], refetch() {}, setData() {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { ConfigPage, ConfigField, missingRequired, REQUIRED_MESSAGE } = await import('../src/components/ConfigPage.jsx');
const { NumberInput, fieldErrors, isBlank } = await import('../src/components/Form.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

describe('NumberInput clearing', () => {
  // NumberInput uses no hooks, so calling it returns the <input> element whose
  // onChange is the handler under test.
  it('reports null for a cleared field by default and 0 only when nullable is off', () => {
    let got;
    const change = (props, value) => NumberInput({ onChange: (v) => { got = v; }, ...props }).props.onChange({ target: { value } });
    change({ value: 5 }, '');
    expect(got).toBeNull();
    change({ value: 5, nullable: false }, '');
    expect(got).toBe(0);
    change({ value: null }, '42');
    expect(got).toBe(42);
    expect(NumberInput({ value: null, onChange() {} }).props.value).toBe('');
  });

  it('Form helpers: isBlank and fieldErrors', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank(0)).toBe(false);
    expect(fieldErrors({ fields: { a: ['x', 'y'] } }, 'a')).toEqual(['x', 'y']);
    expect(fieldErrors({ fields: { a: 'single' } }, 'a')).toEqual(['single']);
    expect(fieldErrors({ fields: { a: 'x' } }, 'b')).toEqual([]);
    expect(fieldErrors(null, 'a')).toEqual([]);
  });
});

describe('ConfigField required numbers', () => {
  const field = { key: 'security.cphulk.max_failures_per_ip', label: 'Failed logins per IP before blocking', type: 'number', min: 1, required: true };

  it('shows an inline error (and the required marker) when a required number is cleared', () => {
    const html = renderToStaticMarkup(<ConfigField field={field} value={null} onChange={() => {}} />);
    expect(html).toContain('field-error');
    expect(html).toContain(REQUIRED_MESSAGE);
    expect(html).toContain('class="required">*');
    expect(html).toContain('required=""');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('value=""');
  });

  it('stays quiet with a value, and for an optional field that is empty', () => {
    const filled = renderToStaticMarkup(<ConfigField field={field} value={5} onChange={() => {}} />);
    expect(filled).not.toContain('field-error');
    expect(filled).not.toContain(REQUIRED_MESSAGE);
    expect(filled).toContain('value="5"');
    const optional = renderToStaticMarkup(<ConfigField field={{ key: 'security.password.strength.ssh', label: 'SSH', type: 'number', min: 0, max: 100, placeholder: 'default' }} value={null} onChange={() => {}} />);
    expect(optional).not.toContain('field-error');
    expect(optional).toContain('placeholder="default"');
  });

  it('renders the messages the API attached to the field under it', () => {
    const html = renderToStaticMarkup(<ConfigField field={{ ...field, required: false }} value={null} onChange={() => {}} error={['Expected number, received null']} />);
    expect(html).toContain('field-error');
    expect(html).toContain('Expected number, received null');
    expect(html).not.toContain(REQUIRED_MESSAGE);
  });

  it('missingRequired lists only the required keys left blank', () => {
    const groups = [{ title: 'A', fields: [field, { key: 'tweak.max_emails_per_hour', label: 'x', type: 'number' }, { key: 'dns.default_ttl', label: 'ttl', type: 'number', required: true }] }];
    expect(missingRequired(groups, { 'security.cphulk.max_failures_per_ip': 5, 'dns.default_ttl': 86400, 'tweak.max_emails_per_hour': null })).toEqual([]);
    expect(missingRequired(groups, { 'security.cphulk.max_failures_per_ip': null, 'dns.default_ttl': '' })).toEqual(['security.cphulk.max_failures_per_ip', 'dns.default_ttl']);
    expect(missingRequired(groups, {})).toEqual(['security.cphulk.max_failures_per_ip', 'dns.default_ttl']);
    expect(missingRequired(undefined, {})).toEqual([]);
  });
});

describe('ConfigPage', () => {
  const fn = { key: 'tweak-settings', label: 'Tweak Settings' };
  const groups = [{ title: 'Brute force', fields: [
    { key: 'security.cphulk.max_failures_per_ip', label: 'Failed logins per IP before blocking', type: 'number', min: 1, required: true },
    { key: 'security.cphulk.enabled', label: 'cPHulk enabled', type: 'toggle' },
  ] }];

  it('renders the server values straight away (no empty form before the seeding effect) and disables Save while a required value is missing', () => {
    apiData['/system/settings?prefix=security.'] = { 'security.cphulk.max_failures_per_ip': 10, 'security.cphulk.enabled': true };
    const html = render(<ConfigPage fn={fn} prefix="security." groups={groups} />);
    expect(html).toContain('value="10"');
    expect(html).toContain('type="checkbox" checked=""');
    expect(html).not.toContain(REQUIRED_MESSAGE);
    apiData['/system/settings?prefix=security.'] = { 'security.cphulk.max_failures_per_ip': null, 'security.cphulk.enabled': true };
    const blank = render(<ConfigPage fn={fn} prefix="security." groups={groups} />);
    expect(blank).toContain(REQUIRED_MESSAGE);
    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*title="Fill in the required settings first"[^>]*>Save</);
  });
});
