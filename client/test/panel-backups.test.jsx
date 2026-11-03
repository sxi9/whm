import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: Backups } = await import('../src/pages/panel/backups/backups.jsx');
const { default: Restore, restorableBackups, relativeToHome, restoreSummary, backupOptionLabel, sshRestoreAllowed, touchesSsh, restorablePaths, SSH_NOTE } = await import('../src/pages/panel/backups/restore.jsx');
const { filterBackups, prefixCrumbs, joinPrefix, kindLabel, toBase64 } = await import('../src/pages/panel/backups/parts/shared.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user', totpEnabled: false },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: { backup: true }, limits: {}, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fnBackups = PANEL_FUNCTION_BY_KEY['panel:backups/backups'];
const fnRestore = PANEL_FUNCTION_BY_KEY['panel:backups/restore'];
const render = (el, path, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });

const LIST = '/panel/backups?page=1&pageSize=25';
const rows = [
  { id: 3, account: 'demo', type: 'account', name: 'backup-11.01.2026_10-00-00_demo.tar.gz', size: 1048576 * 12, sha256: 'abc', status: 'done', error: null, created_at: '2026-11-01 10:00:00', retention_class: 'panel', pinned: false, local_present: true, kind: 'home', components: { include: { dbs: false } }, panelOwned: true, downloadable: true },
  { id: 4, account: 'demo', type: 'import', name: 'backup-11.02.2026_09-00-00_demo.tar.gz', size: 2048, sha256: 'def', status: 'done', error: null, created_at: '2026-11-02 09:00:00', retention_class: 'panel', pinned: false, local_present: true, kind: 'upload', components: { uploaded: true }, panelOwned: true, downloadable: true },
  { id: 5, account: 'demo', type: 'account', name: null, size: null, sha256: null, status: 'failed', error: 'tar failed', created_at: '2026-11-03 01:00:00', retention_class: 'panel', pinned: false, local_present: false, kind: 'full', components: {}, panelOwned: true, downloadable: false },
];
const meta = { page: 1, pageSize: 25, total: 3, running: null, kinds: ['home', 'full'] };

describe('Backups page', () => {
  it('renders the generate form, the explanation and the archive table with download, restore and delete', () => {
    fixtures.responses.clear();
    set(LIST, { data: rows, meta });
    const html = render(h(Backups, { fn: fnBackups }), fnBackups.path);
    expect(html).toContain('<h1>Backups</h1>');
    expect(html).toContain('Generate a backup');
    expect(html).toContain('Home directory and mail');
    expect(html).toContain('Full account');
    expect(html).toContain('name="backup-kind"');
    expect(html).toContain('>Generate backup<');
    expect(html).toContain('backup-11.01.2026_10-00-00_demo.tar.gz');
    expect(html).toContain('12.0 MB');
    expect(html).toContain('Uploaded archive');
    expect(html).toContain('>Ready<');
    expect(html).toContain('>Failed<');
    expect(html).toContain('>Download<');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('3 archives');
    expect(html).toContain('href="/panel/backups/restore"');
    expect(html).not.toContain('Read-only while logged in');
  });

  it('shows a running job and disables generation', () => {
    fixtures.responses.clear();
    set(LIST, { data: [], meta: { ...meta, total: 0, running: { id: 42, status: 'running', kind: 'full' } } });
    const html = render(h(Backups, { fn: fnBackups }), fnBackups.path);
    expect(html).toContain('A full account backup is running');
    expect(html).toMatch(/<button[^>]*class="btn btn-primary[^"]*"[^>]*disabled=""/);
    expect(html).toContain('progress-log');
    expect(html).toContain('No backups yet');
  });

  it('renders the capability state on 501 with the form still present', () => {
    fixtures.responses.clear();
    set(LIST, { error: { status: 501, code: 'capability_missing', message: 'Backups are not available on this server', capability: 'backup' } });
    const html = render(h(Backups, { fn: fnBackups }), fnBackups.path);
    expect(html).toContain('Not available on this server');
    expect(html).toContain('Backups are not available on this server');
    expect(html).toContain('Generate a backup');
    expect(html).toContain('once the backup service is available');
  });

  it('renders the plan state on 403 feature_disabled', () => {
    fixtures.responses.clear();
    set(LIST, { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    const html = render(h(Backups, { fn: fnBackups }), fnBackups.path);
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('Backups is not part of the hosting plan');
    expect(html).not.toContain('Generate a backup');
  });

  it('explains the read-only state while logged in as the account', () => {
    fixtures.responses.clear();
    set(LIST, { data: rows, meta });
    const html = render(h(Backups, { fn: fnBackups }), fnBackups.path, ctxFor({ actingAs: { account: 'demo', by: 'root', expiresAt: new Date(Date.now() + 600000).toISOString() } }));
    expect(html).toContain('Read-only while logged in as demo');
    expect(html).toContain('>Download<');
  });

  it('helpers: filterBackups, prefixCrumbs, joinPrefix, kindLabel, toBase64', () => {
    expect(filterBackups(rows, 'upload').map((r) => r.id)).toEqual([4]);
    expect(filterBackups(rows, '').length).toBe(3);
    expect(prefixCrumbs('homedir/public_html/css')).toEqual([{ name: 'homedir', prefix: 'homedir' }, { name: 'public_html', prefix: 'homedir/public_html' }, { name: 'css', prefix: 'homedir/public_html/css' }]);
    expect(joinPrefix('', 'a')).toBe('a');
    expect(joinPrefix('a', 'b')).toBe('a/b');
    expect(kindLabel('full')).toBe('Full account');
    expect(toBase64(new Uint8Array([104, 105]).buffer)).toBe('aGk=');
  });
});

describe('Restore page', () => {
  const browse = { path: '/backup/x.tar.gz', top: 'backup-x', prefix: 'homedir', total: 2, truncated: false, entries: [
    { name: 'public_html', path: 'homedir/public_html', type: 'dir', size: 4096, files: 12, mtime: '2026-10-30T10:00:00Z', mode: '0755', owner: 'demo:demo', target: null },
    { name: '.bashrc', path: 'homedir/.bashrc', type: 'file', size: 220, files: 1, mtime: '2026-10-30T10:00:00Z', mode: '0644', owner: 'demo:demo', target: null },
  ] };
  const restores = [{ id: 9, backup_id: 3, kind: 'files', status: 'done', error: null, options: { paths: ['public_html'], overwrite: false }, summary: { restored: 12, missing: [] }, created_at: '2026-11-02 11:00:00', finished_at: '2026-11-02 11:01:00', job_id: 77 }];

  it('renders the source picker, the upload card, the archive browser and the history', () => {
    fixtures.responses.clear();
    set('/panel/backups?page=1&pageSize=200', { data: rows, meta });
    set('/panel/backups/restores', { data: restores });
    set('/panel/backups/3/browse?prefix=homedir', { data: browse });
    const html = render(h(Restore, { fn: fnRestore }), `${fnRestore.path}?backup=3`);
    expect(html).toContain('<h1>Restore</h1>');
    expect(html).toContain('Restore from a backup');
    expect(html).toContain('id="restore-source"');
    expect(html).toContain('2 archives can be restored from');
    expect(html).toContain('Replace existing files');
    expect(html).toContain('Upload an archive');
    expect(html).toContain('id="restore-upload"');
    expect(html).toContain('Inside backup-11.01.2026_10-00-00_demo.tar.gz');
    expect(html).toContain('public_html');
    expect(html).toContain('<code>.bashrc</code>');
    expect(html).toContain('aria-label="Select homedir/public_html"');
    expect(html).toContain('Restore history');
    expect(html).toContain('12 restored');
    expect(html).toContain('Selected files');
    expect(html).toContain('>Done<');
  });

  it('shows the empty picker state when no archive is chosen', () => {
    fixtures.responses.clear();
    set('/panel/backups?page=1&pageSize=200', { data: [], meta: { ...meta, total: 0 } });
    set('/panel/backups/restores', { data: [] });
    const html = render(h(Restore, { fn: fnRestore }), fnRestore.path);
    expect(html).toContain('Choose an archive to browse');
    expect(html).toContain('No archives yet');
    expect(html).toContain('generate a backup');
    expect(html).toContain('No restores yet');
    expect(html).toContain('href="/panel/backups/backups"');
  });

  it('renders the capability state on 501 and the plan state on 403', () => {
    fixtures.responses.clear();
    set('/panel/backups?page=1&pageSize=200', { error: { status: 501, code: 'capability_missing', message: 'Backups are not available on this server' } });
    set('/panel/backups/restores', { error: { status: 501, code: 'capability_missing', message: 'Backups are not available on this server' } });
    let html = render(h(Restore, { fn: fnRestore }), fnRestore.path);
    expect(html).toContain('Not available on this server');
    expect(html).toContain('Upload an archive');
    fixtures.responses.clear();
    set('/panel/backups?page=1&pageSize=200', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    html = render(h(Restore, { fn: fnRestore }), fnRestore.path);
    expect(html).toContain('Not included in your plan');
    expect(html).not.toContain('Upload an archive');
  });

  const withSsh = { ...browse, total: 3, entries: [...browse.entries, { name: '.ssh', path: 'homedir/.ssh', type: 'dir', size: 4096, files: 2, mtime: '2026-10-30T10:00:00Z', mode: '0700', owner: 'demo:demo', target: null }] };
  const shellMe = { account: { ...me.account, plan: { has_shell: true }, features: { backup: true } } };
  const renderWithSsh = (over) => {
    fixtures.responses.clear();
    set('/panel/backups?page=1&pageSize=200', { data: rows, meta });
    set('/panel/backups/restores', { data: restores });
    set('/panel/backups/3/browse?prefix=homedir', { data: withSsh });
    return render(h(Restore, { fn: fnRestore }), `${fnRestore.path}?backup=3`, ctxFor(over));
  };

  it('keeps .ssh out of the selection and says why when the account could not restore it (no shell, ssh feature off, or acting as)', () => {
    for (const over of [{}, { account: { ...me.account, plan: { has_shell: true }, features: { ssh: false } } }, { ...shellMe, actingAs: { account: 'demo', by: 'root', expiresAt: null } }]) {
      const html = renderWithSsh(over);
      expect(html).toContain(SSH_NOTE);
      expect(html).toContain('disabled="" aria-label="Select homedir/.ssh"');
      expect(html).toContain('<input type="checkbox" aria-label="Select homedir/public_html"/>');
      expect(html).toContain('managed under Security › SSH keys');
    }
  });

  it('offers .ssh to a session login with shell access and the ssh feature', () => {
    const html = renderWithSsh(shellMe);
    expect(html).not.toContain(SSH_NOTE);
    expect(html).not.toContain('managed under Security › SSH keys');
    expect(html).toContain('<input type="checkbox" aria-label="Select homedir/.ssh"/>');
  });

  it('helpers: sshRestoreAllowed, touchesSsh, restorablePaths mirror the server gate', () => {
    expect(sshRestoreAllowed(me)).toBe(false);
    expect(sshRestoreAllowed({ ...me, ...shellMe })).toBe(true);
    expect(sshRestoreAllowed({ ...me, account: { ...shellMe.account, features: { ssh: false } } })).toBe(false);
    expect(sshRestoreAllowed({ ...me, ...shellMe, actingAs: { account: 'demo', by: 'root' } })).toBe(false);
    expect(sshRestoreAllowed(null)).toBe(false);
    for (const p of ['homedir/.ssh', 'homedir/.ssh/', 'homedir/.ssh/authorized_keys', 'homedir', 'homedir/', '', '.']) expect(touchesSsh(p), p).toBe(true);
    for (const p of ['homedir/public_html', 'homedir/.sshx', 'homedir/a/.ssh/k', 'homedir/.bashrc']) expect(touchesSsh(p), p).toBe(false);
    expect(restorablePaths(['homedir/.ssh', 'homedir/public_html', 'homedir'], false)).toEqual(['homedir/public_html']);
    expect(restorablePaths(['homedir/.ssh', 'homedir/public_html'], true)).toEqual(['homedir/.ssh', 'homedir/public_html']);
  });

  it('helpers: restorableBackups, relativeToHome, restoreSummary, backupOptionLabel', () => {
    expect(restorableBackups(rows).map((r) => r.id)).toEqual([3, 4]);
    expect(relativeToHome('homedir/public_html/index.php')).toBe('public_html/index.php');
    expect(relativeToHome('public_html')).toBe('public_html');
    expect(restoreSummary({ restored: 3, skipped: 1 })).toBe('3 restored, 1 skipped');
    expect(restoreSummary(null)).toBe('—');
    expect(backupOptionLabel(rows[0])).toContain('Home directory and mail');
  });
});
