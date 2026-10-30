import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

const auth = { user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// useApi fetches in an effect, which static rendering never runs; feeding it
// canned data per path lets each page render with content.
const apiData = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: apiData[path] ?? null, meta: null, error: null, loading: !apiData[path], refetch: () => {}, setData: () => {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { default: RestartService, RESTART_SERVICE_CAPABILITY } = await import('../src/pages/server/RestartService.jsx');
const { AccountDiskTable } = await import('../src/pages/server/AccountDiskTable.jsx');
const { CATEGORIES, RESTART_SERVICE_MAP } = await import('../src/nav.js');
const { CAPABILITY_LABELS } = await import('../src/components/Common.jsx');
const { componentForService } = await import('../../server/src/lib/stack-catalog.js');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);
const restartFn = (slug) => CATEGORIES.find((c) => c.slug === 'restart-services').functions.find((f) => f.slug === slug);
const SERVICE_MANAGER = 'href="/service-configuration/service-manager"';

describe('Restart Services page', () => {
  it('offers root the install and a Service Manager link instead of a Restart button that would 404 while the service is not installed', () => {
    apiData['/system/services/named'] = { name: 'named', displayName: 'DNS Server (BIND)', installed: false };
    const fn = restartFn('dns-server');
    const html = render(<RestartService fn={fn} />);
    expect(html).toContain('Not installed');
    expect(html).toContain('Service not installed');
    expect(html).toContain(`${fn.label} is not installed on this server`);
    expect(html).toContain('Install BIND');
    expect(html).toContain(SERVICE_MANAGER);
    expect(html).not.toContain(`Restart ${fn.label}`);
  });

  it('keeps the Restart button once a unit exists', () => {
    apiData['/system/services/httpd'] = { name: 'httpd', displayName: 'Apache', installed: true, active: true, unit: 'apache2', pid: 4242 };
    const fn = restartFn('http-server-apache');
    const html = render(<RestartService fn={fn} />);
    expect(html).toContain(`Restart ${fn.label}`);
    expect(html).toContain('apache2');
    expect(html).toContain('>Up<');
    expect(html).not.toContain('Service not installed');
    expect(html).not.toContain(SERVICE_MANAGER);
  });

  it('shows no install button for a service the catalog cannot install (sshd) or for a non-root session, but keeps the Service Manager link', () => {
    apiData['/system/services/sshd'] = { name: 'sshd', displayName: 'OpenSSH', installed: false };
    const ssh = render(<RestartService fn={restartFn('ssh-server-openssh')} />);
    expect(ssh).toContain('Service not installed');
    expect(ssh).not.toContain('btn-primary');
    expect(ssh).toContain(SERVICE_MANAGER);
    apiData['/system/services/named'] = { name: 'named', displayName: 'DNS Server (BIND)', installed: false };
    auth.user = { id: 2, username: 'resell1', role: 'reseller' };
    try {
      const reseller = render(<RestartService fn={restartFn('dns-server')} />);
      expect(reseller).not.toContain('Install BIND');
      expect(reseller).not.toContain('btn-primary');
      expect(reseller).toContain(SERVICE_MANAGER);
    } finally { auth.user = { id: 1, username: 'root', role: 'root' }; }
  });

  it('maps every restartable service to the capability the server catalog installs it under', () => {
    const services = Object.values(RESTART_SERVICE_MAP);
    expect(Object.keys(RESTART_SERVICE_CAPABILITY).every((s) => services.includes(s))).toBe(true);
    for (const service of services) {
      const component = componentForService(service);
      expect(RESTART_SERVICE_CAPABILITY[service], service).toBe(component?.capability);
      if (component) expect(Object.hasOwn(CAPABILITY_LABELS, component.capability), service).toBe(true);
    }
    expect(RESTART_SERVICE_CAPABILITY.sshd).toBeUndefined();
  });
});

describe('Disk usage account table', () => {
  it('links each account to a page that honours the username in the URL', () => {
    const html = render(<AccountDiskTable accounts={[{ username: 'alice', domain: 'alice.test', owner: 'root', homeDir: '/home/alice', diskUsedMb: 10, diskQuotaMb: 100, usedPercent: 10 }]} loading={false} error={null} />);
    expect(html).toContain('href="/account-functions/modify-an-account?username=alice"');
    expect(html).not.toContain('list-accounts');
  });
});
