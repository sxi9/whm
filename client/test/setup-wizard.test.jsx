import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

const auth = { user: { id: 1, username: 'root', role: 'root', setupPending: true }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// useApi fetches in an effect, which static rendering never runs; feeding it
// canned data lets each step render with content.
const apiData = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: apiData[path] ?? null, meta: null, error: null, loading: !apiData[path], refetch: () => {}, setData: () => {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { default: SetupPage, SETUP_STEPS, PRODUCT, WelcomeStep, BasicsStep, ServicesStep, InstallStep, DoneStep, StepBar } = await import('../src/pages/Setup.jsx');
const { CapabilityNotice, CAPABILITY_LABELS } = await import('../src/components/Common.jsx');
const { StackCard } = await import('../src/pages/server/ServiceManager.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter initialEntries={['/setup']}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const stack = {
  packageManager: 'apt', family: 'debian', pkgAvailable: true,
  profiles: [
    { key: 'full', label: 'Full hosting stack (recommended)', description: 'Everything', components: ['apache', 'php', 'mysql', 'exim'] },
    { key: 'web', label: 'Web + database only', description: 'Apache, PHP, MariaDB', components: ['apache', 'php', 'mysql'] },
    { key: 'manual', label: 'Choose services', description: 'Pick yourself', components: [] },
  ],
  components: [
    { key: 'apache', label: 'Apache HTTP Server', description: 'web', capability: 'apache', service: 'httpd', recommended: true, packages: ['apache2'], units: ['apache2'], unit: 'apache2', installed: true, active: true, state: 'active', requires: null },
    { key: 'php', label: 'PHP (PHP-FPM + common extensions)', description: 'php', capability: 'php', service: 'php-fpm', recommended: true, packages: ['php-fpm'], units: ['php-fpm'], unit: null, installed: false, active: null, requires: null },
    { key: 'mysql', label: 'MariaDB (MySQL) server', description: 'db', capability: 'mysql', service: 'mysql', recommended: true, packages: ['mariadb-server'], units: ['mariadb'], unit: null, installed: false, active: null, requires: null },
    { key: 'exim', label: 'Exim mail transfer agent', description: 'mail', capability: 'exim', service: 'exim', recommended: true, packages: ['exim4-daemon-heavy'], units: ['exim4'], unit: null, installed: false, active: null, requires: 'Needs the EPEL repository' },
  ],
  lastJob: null,
};

describe('Setup wizard', () => {
  it('names the product and lists the five steps in order', () => {
    expect(PRODUCT).toEqual({ name: 'HST Panel', vendor: 'Hostingsignal' });
    expect(SETUP_STEPS.map((s) => s.key)).toEqual(['welcome', 'basics', 'services', 'install', 'done']);
    const html = render(<SetupPage />);
    expect(html).toContain('HST Panel setup');
    expect(html).toContain('Welcome to HST Panel');
    expect(html).toContain('by Hostingsignal');
    expect(html).toContain('Skip for now');
    expect(html).toContain('Get started');
    expect(html).toContain('aria-current="step"');
    for (const s of SETUP_STEPS) expect(html).toContain(s.label);
  });

  it('renders the server basics form from the basic.* settings', () => {
    apiData['/system/settings?prefix=basic.'] = { 'basic.hostname': 'srv1.example.com', 'basic.contact_email': 'ops@example.com', 'basic.main_ip': '203.0.113.10', 'basic.nameservers': ['ns1.example.com', 'ns2.example.com'] };
    const html = render(<BasicsStep onNext={() => {}} onBack={() => {}} />);
    expect(html).toContain('Server basics');
    expect(html).toContain('Hostname');
    expect(html).toContain('Server contact email');
    expect(html).toContain('Main server IP address');
    expect(html).toContain('Primary nameserver');
    expect(html).toContain('Save and continue');
    expect(html).toContain('Back');
  });

  it('shows the profile cards, the manual checklist and the no-package-manager notice', () => {
    apiData['/system/stack'] = stack;
    const full = render(<ServicesStep selection={{ profile: 'full', components: [] }} onChange={() => {}} onNext={() => {}} onBack={() => {}} />);
    expect(full).toContain('Full hosting stack (recommended)');
    expect(full).toContain('Web + database only');
    expect(full).toContain('Choose services');
    expect(full).toContain('aria-pressed="true"');
    expect(full).toContain('3 component(s) to install');
    expect(full).toContain('Will install: PHP (PHP-FPM + common extensions), MariaDB (MySQL) server, Exim mail transfer agent.');
    expect(full).toContain('1 of 4 components are already installed');
    const manual = render(<ServicesStep selection={{ profile: 'manual', components: ['php'] }} onChange={() => {}} onNext={() => {}} onBack={() => {}} />);
    expect(manual).toContain('id="setup-php"');
    expect(manual).toContain('checked=""');
    expect(manual).not.toContain('id="setup-apache"');
    expect(manual).toContain('Needs the EPEL repository');
    apiData['/system/stack'] = { ...stack, packageManager: null, pkgAvailable: false };
    const bare = render(<ServicesStep selection={{ profile: 'full', components: [] }} onChange={() => {}} onNext={() => {}} onBack={() => {}} />);
    expect(bare).toContain('cannot install software on this server');
    expect(bare).toContain('Continue');
    apiData['/system/stack'] = stack;
  });

  it('renders the install step before, during and after the job, and the done step', () => {
    const before = render(<InstallStep selection={{ profile: 'full', components: [] }} jobId={null} onStarted={() => {}} result={null} onResult={() => {}} onNext={() => {}} onBack={() => {}} />);
    expect(before).toContain('Start installation');
    expect(before).toContain('the &quot;full&quot; profile');
    const nothing = render(<InstallStep selection={{ profile: 'manual', components: [] }} jobId={null} onStarted={() => {}} result={null} onResult={() => {}} onNext={() => {}} onBack={() => {}} />);
    expect(nothing).toContain('No components were selected.');
    expect(nothing).toContain('Continue');
    expect(nothing).not.toContain('Start installation');
    const after = render(<InstallStep selection={{ profile: 'web', components: [] }} jobId={7} onStarted={() => {}} result={{ status: 'done', result: { failed: [] } }} onResult={() => {}} onNext={() => {}} onBack={() => {}} />);
    expect(after).toContain('All selected components installed.');
    expect(after).toContain('progress-log');
    const partial = render(<InstallStep selection={{ profile: 'web', components: [] }} jobId={8} onStarted={() => {}} result={{ status: 'done', result: { failed: ['exim'] } }} onResult={() => {}} onNext={() => {}} onBack={() => {}} />);
    expect(partial).toContain('Failed: exim');
    const done = render(<DoneStep result={{ status: 'done' }} onFinish={() => {}} busy={false} />);
    expect(done).toContain('HST Panel is ready.');
    expect(done).toContain('Go to the dashboard');
    expect(render(<StepBar steps={SETUP_STEPS} current={4} />)).toContain('setup-step-done');
    expect(render(<WelcomeStep onNext={() => {}} />)).toContain('Linux users and disk quotas');
  });
});

describe('CapabilityNotice install button', () => {
  it('offers Install <label> to root when a capability is known and keeps the manual link', () => {
    const html = render(<CapabilityNotice capability="exim" error={{ code: 'capability_missing', message: 'Exim is not installed' }} onRetry={() => {}} />);
    expect(html).toContain('Install Exim');
    expect(html).toContain('Install Distro Packages');
    expect(html).toContain('Re-check');
    expect(CAPABILITY_LABELS.modsecurity).toBe('ModSecurity');
    const fromError = render(<CapabilityNotice error={{ status: 501, code: 'capability_missing', capability: 'modsecurity', message: 'ModSecurity is not installed' }} />);
    expect(fromError).toContain('Install ModSecurity');
    const unknownCap = render(<CapabilityNotice error={{ code: 'capability_missing', capability: 'frobnicator', message: 'x' }} />);
    expect(unknownCap).toContain('Install frobnicator');
  });

  it('shows no install button without a capability or for a non-root user', () => {
    const plain = render(<CapabilityNotice error={{ code: 'capability_missing', message: 'Something is missing' }} />);
    expect(plain).not.toContain('btn-primary');
    expect(plain).toContain('Install Distro Packages');
    auth.user = { id: 2, username: 'resell1', role: 'reseller' };
    const reseller = render(<CapabilityNotice capability="exim" error={{ code: 'capability_missing', message: 'Exim is not installed' }} />);
    expect(reseller).not.toContain('Install Exim');
    auth.user = { id: 1, username: 'root', role: 'root', setupPending: true };
    expect(render(<CapabilityNotice error={{ code: 'validation_failed', message: 'nope' }} />)).not.toContain('banner-warning');
  });
});

describe('Service Manager stack card', () => {
  it('groups installed and missing components with profile buttons and a selection', () => {
    const html = render(<StackCard stack={{ data: stack, loading: false, error: null, refetch: () => {} }} busy={null} onInstall={() => {}} />);
    expect(html).toContain('Server stack');
    expect(html).toContain('1 of 4 components installed');
    expect(html).toContain('Install full hosting stack (recommended)');
    expect(html).toContain('Web + database only');
    expect(html).toContain('Install selected (0)');
    expect(html).toContain('id="stack-php"');
    expect(html).not.toContain('id="stack-apache"');
    expect(html).toContain('Apache HTTP Server');
    expect(html).toContain('running');
    const bare = render(<StackCard stack={{ data: { ...stack, packageManager: null, pkgAvailable: false }, loading: false, error: null, refetch: () => {} }} busy={null} onInstall={() => {}} />);
    expect(bare).toContain('cannot install software here');
  });
});
