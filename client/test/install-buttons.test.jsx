import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

const auth = { user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// Static rendering never runs effects: useApi answers from a path-prefix table.
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => path.startsWith(k));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: !r, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

// Records what each page hands to the job runner, so the refresh-on-finish
// wiring is checked without clicking anything.
const runnerCalls = [];
vi.mock('../src/pages/software/Shared.jsx', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useJobRunner: (opts) => { runnerCalls.push(opts); return mod.useJobRunner(opts); } };
});

const { CAPABILITY_LABELS, CapabilityNotice } = await import('../src/components/Common.jsx');
const { default: InstallAPerlModule, cpanPackagesFor } = await import('../src/pages/fn/software/install-a-perl-module.jsx');
const { default: ModuleInstallers } = await import('../src/pages/fn/software/module-installers.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const NO_CPAN = { present: { perl: true, php: true }, versions: { perl: '5.38.2', php: '8.3.6' }, perl: null };
const perlPage = () => {
  responses.set('/software/perl/modules', { data: { modules: [{ name: 'JSON::XS', version: '4.03' }] } });
  responses.set('/system/jobs', { data: [] });
  return render(<InstallAPerlModule fn={FUNCTION_BY_KEY['software/install-a-perl-module']} />);
};
const installButtons = (html) => html.match(/<button[^>]*>Install (cpanminus|perl-App-cpanminus)<\/button>/g) || [];

describe('rclone capability label', () => {
  it('lets the backup pages offer an Install button for rclone', () => {
    expect(CAPABILITY_LABELS.rclone).toBe('rclone');
    const html = render(<CapabilityNotice error={{ status: 501, code: 'capability_missing', message: 'rclone is not installed' }} capability="rclone" />);
    expect(html).toContain('Service not installed');
    expect(html).toContain('Install rclone');
    expect(render(<CapabilityNotice error={{ status: 501, code: 'capability_missing', message: 'x is missing' }} capability="nothing-known" />)).not.toContain('btn-primary');
  });
});

describe('Install a Perl Module without a CPAN client', () => {
  it('offers the family\'s cpanminus package to root and refreshes the installer status when the job ends', () => {
    expect(cpanPackagesFor('debian')).toEqual(['cpanminus']);
    expect(cpanPackagesFor('rhel')).toEqual(['perl-App-cpanminus']);
    expect(cpanPackagesFor(null)).toEqual(['cpanminus']);
    responses.clear();
    responses.set('/software/modules/installers', { data: NO_CPAN });
    responses.set('/software/pkg/detect', { data: { manager: 'apt', family: 'debian', capability: true } });
    runnerCalls.length = 0;
    const html = perlPage();
    expect(html).toContain('No CPAN client');
    expect(html).toContain('no CPAN client');
    expect(installButtons(html)).toEqual(['<button type="button" class="btn btn-primary btn-sm ">Install cpanminus</button>']);
    expect(html).toContain('href="/software/install-distro-packages"');
    expect(html).toContain('Module installs are enabled as soon as it is there');
    expect(runnerCalls).toHaveLength(1);
    expect(typeof runnerCalls[0].onFinished).toBe('function');
    responses.set('/software/pkg/detect', { data: { manager: 'dnf', family: 'rhel', capability: true } });
    const rhel = perlPage();
    expect(installButtons(rhel)).toHaveLength(1);
    expect(rhel).toContain('Install perl-App-cpanminus');
  });

  it('shows no button for a reseller, without a package manager, or once cpanm is installed', () => {
    responses.clear();
    responses.set('/software/modules/installers', { data: NO_CPAN });
    responses.set('/software/pkg/detect', { data: { manager: 'apt', family: 'debian', capability: true } });
    auth.user = { id: 2, username: 'resell1', role: 'reseller' };
    try {
      const reseller = perlPage();
      expect(reseller).toContain('No CPAN client');
      expect(reseller).toContain('from <a href="/software/install-distro-packages">Install Distro Packages</a> first');
      expect(installButtons(reseller)).toHaveLength(0);
    } finally { auth.user = { id: 1, username: 'root', role: 'root' }; }
    responses.set('/software/pkg/detect', { data: { manager: null, family: null, capability: false } });
    const noManager = perlPage();
    expect(noManager).toContain('No supported package manager');
    expect(installButtons(noManager)).toHaveLength(0);
    responses.set('/software/pkg/detect', { data: { manager: 'apt', family: 'debian', capability: true } });
    responses.set('/software/modules/installers', { data: { ...NO_CPAN, present: { ...NO_CPAN.present, cpanm: true }, perl: 'cpanm' } });
    const installed = perlPage();
    expect(installed).not.toContain('No CPAN client');
    expect(installed).toContain('installer: cpanm · perl 5.38.2');
    expect(installButtons(installed)).toHaveLength(0);
  });
});

describe('Module Installers', () => {
  it('refreshes the installer table when a tool install finishes instead of asking for a reload', () => {
    responses.clear();
    responses.set('/software/modules/installers', { data: { present: { php: true, perl: true }, versions: { php: '8.3.6', perl: '5.38.2' } } });
    responses.set('/software/pkg/detect', { data: { manager: 'apt', family: 'debian', capability: true } });
    runnerCalls.length = 0;
    const html = render(<ModuleInstallers fn={FUNCTION_BY_KEY['software/module-installers']} />);
    expect(html).toContain('Available installers');
    expect(html).toContain('Install php-pear + php-dev');
    expect(runnerCalls).toHaveLength(1);
    expect(typeof runnerCalls[0]?.onFinished).toBe('function');
  });
});
