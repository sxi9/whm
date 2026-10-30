import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';
import { pagination } from '../../server/src/lib/validate.js';

const auth = { user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// useApi fetches in an effect, which static rendering never runs; canned data
// per path prefix lets each page render one server state.
const apiData = {};
const lookup = (path) => { const k = Object.keys(apiData).find((p) => path.startsWith(p)); return k ? apiData[k] : null; };
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => { const d = lookup(path); return { data: d, meta: null, error: null, loading: !d, refetch: () => {}, setData: () => {} }; },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { default: UpdateServerSoftware, settingsBody } = await import('../src/pages/fn/software/update-server-software.jsx');
const { default: ManageDatabases, databaseColumns } = await import('../src/pages/fn/database-services/manage-databases.jsx');
const { default: UpgradeDatabaseVersion, resolveTarget } = await import('../src/pages/fn/database-services/upgrade-database-version.jsx');
const { default: ApacheModUserdirTweak } = await import('../src/pages/fn/security-center/apache-mod-userdir-tweak.jsx');
const { default: SmtpRestrictions } = await import('../src/pages/fn/security-center/smtp-restrictions.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

describe('Update Server Software settings', () => {
  const data = { currentVersion: '1.0.0', updateUrl: 'https://updates.example.com/whm/latest.json', updateUrlHasCredentials: true, tier: 'stable', autoUpdate: false, lastCheck: null, latest: null, updateAvailable: null, installMethod: 'git', repoRoot: '/opt/whm', selfUpdate: { supported: false, reason: 'r' }, instructions: ['step'] };

  it('leaves the URL out of the save body unless the admin changed it, so the redacted echo never replaces stored credentials', () => {
    expect(settingsBody({ url: data.updateUrl, tier: 'edge', autoUpdate: true }, data)).toEqual({ tier: 'edge', autoUpdate: true });
    expect(settingsBody({ url: 'https://other.example.com/feed.json', tier: 'stable', autoUpdate: false }, data)).toEqual({ url: 'https://other.example.com/feed.json', tier: 'stable', autoUpdate: false });
    expect(settingsBody({ url: '', tier: 'stable', autoUpdate: false }, data)).toEqual({ url: '', tier: 'stable', autoUpdate: false });
    expect(settingsBody({ url: '', tier: 'stable', autoUpdate: false }, { ...data, updateUrl: '' })).toEqual({ tier: 'stable', autoUpdate: false });
    expect(settingsBody({ url: 'https://x.example/f.json', tier: 'stable', autoUpdate: false }, null)).toHaveProperty('url');
  });

  it('tells the admin the stored URL carries hidden credentials', () => {
    apiData['/software/panel/update'] = data;
    const html = render(<UpdateServerSoftware fn={FUNCTION_BY_KEY['software/update-server-software']} />);
    expect(html).toContain('carries credentials');
    expect(html).toContain('Leave the field unchanged to keep them');
    apiData['/software/panel/update'] = { ...data, updateUrlHasCredentials: false };
    expect(render(<UpdateServerSoftware fn={FUNCTION_BY_KEY['software/update-server-software']} />)).not.toContain('carries credentials');
  });
});

describe('Manage Databases columns', () => {
  it('uses sort keys the list query validator accepts, with Size sortable through size_bytes', () => {
    const sortable = databaseColumns(true).filter((c) => c.sortable).map((c) => c.key);
    expect(sortable).toEqual(['name', 'account', 'size_bytes']);
    for (const key of sortable) expect(pagination.shape.sort.safeParse(key).success, key).toBe(true);
    expect(pagination.shape.sort.safeParse('sizeBytes').success).toBe(false);
    expect(renderToStaticMarkup(<MemoryRouter>{databaseColumns(true)[3].render({ sizeBytes: 4096 })}</MemoryRouter>)).toContain('4');
  });

  it('renders the Size header as sortable', () => {
    apiData['/databases/databases'] = [{ name: 'alice_shop', account: 'alice', users: ['alice_app'], sizeBytes: 4096, tables: 2, charset: 'utf8mb4', collation: null, system: false, onServer: true }];
    apiData['/databases/status'] = { profile: { engine: 'mariadb', profile_name: 'Local' }, capabilities: { mysql: true }, prefixing: true };
    const html = render(<ManageDatabases fn={FUNCTION_BY_KEY['database-services/manage-databases']} />);
    expect(html).toContain('alice_shop');
    expect(html).toContain('<th class="sortable align-right"><span>Size');
  });
});

describe('Upgrade Database Version target', () => {
  it('takes the typed package name when the package manager offers no candidate', () => {
    expect(resolveTarget({ target: '', customTarget: ' mariadb-server ', options: [] })).toEqual({ customMode: true, chosen: 'mariadb-server' });
    expect(resolveTarget({ target: '', customTarget: '', options: [] })).toEqual({ customMode: true, chosen: '' });
    const options = [{ value: 'mariadb-server', label: 'mariadb-server → 10.11' }];
    expect(resolveTarget({ target: '', customTarget: 'typed', options })).toEqual({ customMode: false, chosen: 'mariadb-server' });
    expect(resolveTarget({ target: '__custom', customTarget: 'mariadb-server-10.11', options })).toEqual({ customMode: true, chosen: 'mariadb-server-10.11' });
    expect(resolveTarget({ target: 'mysql-server', customTarget: 'typed', options })).toEqual({ customMode: false, chosen: 'mysql-server' });
  });

  it('shows the package-name field when there is no candidate', () => {
    apiData['/databases/upgrade'] = { profile: { profile_name: 'Local', engine: 'mariadb' }, local: true, version: { version: '10.11.6' }, installerAvailable: true, packageManager: 'dnf', packages: { installed: [{ name: 'mariadb-server', version: '10.11.6' }], available: [] }, backupDir: '/var/backups/whm/db', recentJobs: [] };
    const html = render(<UpgradeDatabaseVersion fn={FUNCTION_BY_KEY['database-services/upgrade-database-version']} />);
    expect(html).toContain('No candidate found; enter the package name');
    expect(html).toContain('placeholder="mariadb-server"');
    expect(html).toContain('Upgrade database server');
  });
});

describe('Security Center pages name the capability so root can install it', () => {
  it('mod_userdir offers Install Apache and a re-check while Apache is missing', () => {
    apiData['/security/userdir'] = { installed: false };
    const html = render(<ApacheModUserdirTweak fn={FUNCTION_BY_KEY['security-center/apache-mod-userdir-tweak']} />);
    expect(html).toContain('Service not installed');
    expect(html).toContain('Install Apache');
    expect(html).toContain('Re-check');
    expect(html).not.toContain('Save and reload Apache');
  });

  it('SMTP Restrictions offers the firewall install and a re-check while no firewall tooling exists', () => {
    apiData['/security/smtp-restrictions'] = { installed: false, enabled: false, desired: false, backend: null, groups: [] };
    const html = render(<SmtpRestrictions fn={FUNCTION_BY_KEY['security-center/smtp-restrictions']} />);
    expect(html).toContain('No supported firewall');
    expect(html).toContain('Install the firewall');
    expect(html).toContain('Re-check');
    expect(html).not.toContain('Enable SMTP restrictions');
    auth.user = { id: 2, username: 'resell1', role: 'reseller' };
    try {
      const reseller = render(<SmtpRestrictions fn={FUNCTION_BY_KEY['security-center/smtp-restrictions']} />);
      expect(reseller).not.toContain('Install the firewall');
      expect(reseller).toContain('Re-check');
    } finally { auth.user = { id: 1, username: 'root', role: 'root' }; }
  });
});
