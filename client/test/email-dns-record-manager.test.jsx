import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: () => ({ data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { parseDmarc, DmarcCard, currentStatus } = await import('../src/pages/fn/dns-functions/email-dns-record-manager.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);
const status = (domain, dmarc = null) => ({ domain, account: null, spf: null, dkim: null, dkimKey: null, dmarc, mx: [], suggestions: { spf: 'v=spf1 +mx +a ~all', dmarc: `v=DMARC1; p=none; rua=mailto:postmaster@${domain}` } });
const inputValue = (html, value) => new RegExp(`<input[^>]*value="${value.replace(/[.@]/g, '\\$&')}"`).test(html);

describe('Email DNS Record Manager DMARC form', () => {
  it('starts from the suggested postmaster of the selected zone when no record exists', () => {
    expect(parseDmarc(null, 'beta.example')).toEqual({ p: 'none', sp: '', rua: 'postmaster@beta.example', ruf: '', pct: 100, adkim: '', aspf: '' });
    expect(parseDmarc('v=spf1 -all', 'beta.example').rua).toBe('postmaster@beta.example');
  });

  it('mirrors an existing record exactly, without inventing a rua', () => {
    expect(parseDmarc('v=DMARC1; p=quarantine; sp=reject; rua=mailto:dmarc@alpha.example,mailto:agg@reports.test; ruf=mailto:f@alpha.example; pct=50; adkim=s; aspf=r', 'alpha.example'))
      .toEqual({ p: 'quarantine', sp: 'reject', rua: 'dmarc@alpha.example, agg@reports.test', ruf: 'f@alpha.example', pct: 50, adkim: 's', aspf: 'r' });
    expect(parseDmarc('v=DMARC1; p=none', 'alpha.example')).toEqual({ p: 'none', sp: '', rua: '', ruf: '', pct: 100, adkim: '', aspf: '' });
    expect(parseDmarc('v=DMARC1; p=bogus; pct=500; adkim=x', 'alpha.example')).toEqual({ p: 'none', sp: '', rua: '', ruf: '', pct: 100, adkim: '', aspf: '' });
  });

  it('renders the card for the zone it is given, not the previously selected one', () => {
    const alpha = render(<DmarcCard domain="alpha.example" status={status('alpha.example', { name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=reject; rua=mailto:dmarc@alpha.example' })} onChange={() => {}} />);
    expect(inputValue(alpha, 'dmarc@alpha.example')).toBe(true);
    expect(alpha).toMatch(/<option[^>]*value="reject"[^>]*selected=""|<option[^>]*selected=""[^>]*value="reject"/);
    const beta = render(<DmarcCard domain="beta.example" status={status('beta.example')} onChange={() => {}} />);
    expect(inputValue(beta, 'postmaster@beta.example')).toBe(true);
    expect(beta).not.toContain('alpha.example');
  });

  it('withholds a stale zone payload from the cards while the next zone loads', () => {
    const alpha = status('alpha.example');
    expect(currentStatus('alpha.example', alpha)).toBe(alpha);
    expect(currentStatus('beta.example', alpha)).toBeNull();
    expect(currentStatus('', alpha)).toBeNull();
    expect(currentStatus('beta.example', null)).toBeNull();
  });
});
