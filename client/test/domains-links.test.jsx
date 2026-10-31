import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));

const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const r = path ? [...responses.entries()].find(([k]) => path.startsWith(k))?.[1] ?? null : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { default: ListSubdomains } = await import('../src/pages/fn/account-information/list-subdomains.jsx');
const { default: ListParkedDomains } = await import('../src/pages/fn/account-information/list-parked-domains.jsx');
const { default: ParkADomain } = await import('../src/pages/fn/dns-functions/park-a-domain.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const MODIFY = 'href="/account-functions/modify-an-account"';
const row = (extra) => ({ id: 1, domain: 'blog.alice.com', type: 'sub', parent: 'alice.com', username: 'alice', account_domain: 'alice.com', owner: 'root', docroot: '/home/alice/public_html/blog', created_at: '2026-10-30 10:00:00', suspended: 0, ...extra });

describe('domain list pages point at the Domains panel', () => {
  it('List Subdomains names Modify an Account › Domains and still lists the rows', () => {
    responses.clear();
    responses.set('/account-info/domains', { data: [row()], meta: { page: 1, pageSize: 25, total: 1 } });
    const html = render(<ListSubdomains fn={FUNCTION_BY_KEY['account-information/list-subdomains']} />);
    expect(html).toContain(MODIFY);
    expect(html).toContain('Modify an Account › Domains</a>');
    expect(html).toContain('blog.alice.com');
    expect(html).toContain('Root domain');
  });

  it('List Parked Domains names Modify an Account › Domains next to Park a Domain', () => {
    responses.clear();
    responses.set('/account-info/domains', { data: [row({ domain: 'parked.example', type: 'parked', parent: 'alice.com', docroot: '/home/alice/public_html' })], meta: { page: 1, pageSize: 25, total: 1 } });
    const html = render(<ListParkedDomains fn={FUNCTION_BY_KEY['account-information/list-parked-domains']} />);
    expect(html).toContain(MODIFY);
    expect(html).toContain('Modify an Account › Domains</a>');
    expect(html).toContain('href="/dns-functions/park-a-domain"');
    expect(html).toContain('parked.example');
    responses.set('/account-info/domains', { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    expect(render(<ListParkedDomains fn={FUNCTION_BY_KEY['account-information/list-parked-domains']} />)).toContain('or Modify an Account › Domains, to alias a domain');
  });

  it('Park a Domain says domains are also managed per account', () => {
    responses.clear();
    responses.set('/accounts', { data: [{ username: 'alice', domain: 'alice.com', owner: 'root', suspended: 0 }] });
    responses.set('/dns/parked', { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    const html = render(<ParkADomain fn={FUNCTION_BY_KEY['dns-functions/park-a-domain']} />);
    expect(html).toContain(MODIFY);
    expect(html).toContain('can also be added and removed per account');
    expect(html).toContain('Park onto account');
  });
});
