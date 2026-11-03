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
const { default: FileManager, entryIcon, typeText } = await import('../src/pages/panel/files/file-manager.jsx');
const { default: DiskUsage, shapeRows } = await import('../src/pages/panel/files/disk-usage.jsx');
const paths = await import('../src/pages/panel/files/parts/paths.js');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: { disk_mb: 10240 }, features: { filemanager: true }, limits: {}, domains: [] },
  usage: { diskUsedMb: 2048, diskQuotaMb: 10240, bandwidthUsedMb: 0, bandwidthLimitMb: null }, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fmFn = PANEL_FUNCTION_BY_KEY['panel:files/file-manager'];
const duFn = PANEL_FUNCTION_BY_KEY['panel:files/disk-usage'];
const render = (el, entry) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [entry] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

const entries = [
  { name: 'public_html', type: 'dir', size: 4096, mtime: '2026-11-01T10:00:00.000Z', mode: '0750', owner: 'demo' },
  { name: '.bashrc', type: 'file', size: 231, mtime: '2026-10-30T08:00:00.000Z', mode: '0644', owner: 'demo' },
  { name: 'site-backup.tar.gz', type: 'file', size: 5 * 1024 * 1024, mtime: '2026-11-02T12:30:00.000Z', mode: '0600', owner: 'demo' },
  { name: 'notes.txt', type: 'file', size: 120, mtime: '2026-11-03T09:15:00.000Z', mode: '0644', owner: 'demo' },
  { name: 'www', type: 'symlink', size: 11, mtime: '2026-10-01T00:00:00.000Z', mode: '0777', owner: 'demo' },
];

describe('File manager page', () => {
  it('renders the folder trail, the toolbar and the directory table with row actions', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/list?path=&limit=10000', { loading: false, data: { path: '.', entries, total: 5, truncated: false } });
    const html = render(h(FileManager, { fn: fmFn }), fmFn.path);
    expect(html).toContain('<h1>File manager</h1>');
    expect(html).toContain('New file');
    expect(html).toContain('New folder');
    expect(html).toContain('Upload');
    expect(html).toContain('aria-label="Folder path"');
    expect(html).toContain('title="/home/demo"');
    expect(html).toContain('aria-label="Go to folder"');
    expect(html).toContain('aria-label="Select all"');
    expect(html).toContain('Hide hidden');
    expect(html).toContain('public_html');
    expect(html).toContain('.bashrc');
    expect(html).toContain('site-backup.tar.gz');
    expect(html).toContain('5.00 MB');
    expect(html).toContain('<code>0750</code>');
    expect(html).toContain('<code>0644</code>');
    expect(html).toContain('>Open<');
    expect(html).toContain('>Edit<');
    expect(html).toContain('>Download<');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('5 items');
    expect(html).toContain('href="/panel/files/disk-usage"');
    expect(html).toMatch(/aria-label="Up one level"[^>]*disabled=""|disabled=""[^>]*aria-label="Up one level"/);
    expect(html).not.toContain('#');
  });

  it('reads the folder from ?path= and shows its segments', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/list?path=public_html%2Fassets&limit=10000', { loading: false, data: { path: 'public_html/assets', entries: [], total: 0, truncated: false } });
    const html = render(h(FileManager, { fn: fmFn }), '/panel/files/file-manager?path=public_html/assets');
    expect(html).toContain('>public_html</button>');
    expect(html).toContain('aria-current="location">assets</button>');
    expect(html).toContain('value="public_html/assets"');
    expect(html).toContain('This folder is empty');
    expect(html).toContain('href="/panel/files/disk-usage?path=public_html%2Fassets"');
    expect(html).not.toMatch(/aria-label="Up one level"[^>]*disabled=""/);
  });

  it('warns when the listing is truncated', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/list?path=&limit=10000', { loading: false, data: { path: '.', entries, total: 12000, truncated: true } });
    const html = render(h(FileManager, { fn: fmFn }), fmFn.path);
    expect(html).toContain('Only the first 5 of 12,000 entries are shown');
  });

  it('renders the capability state on 501 and keeps the toolbar', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/list?path=&limit=10000', { loading: false, error: { status: 501, code: 'capability_missing', message: 'setpriv is not installed on this server' } });
    const html = render(h(FileManager, { fn: fmFn }), fmFn.path);
    expect(html).toContain('Not available on this server');
    expect(html).toContain('setpriv is not installed on this server');
    expect(html).toContain('once the file manager is available');
    expect(html).toContain('New folder');
  });

  it('renders the plan state on 403 feature_disabled', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/list?path=&limit=10000', { loading: false, error: { status: 403, code: 'feature_disabled', message: 'off' } });
    const html = render(h(FileManager, { fn: fmFn }), fmFn.path);
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('File manager is not part of the hosting plan');
    expect(html).not.toContain('New folder');
  });

  it('shows other errors as a banner with retry', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/list?path=&limit=10000', { loading: false, error: { status: 500, code: 'bad_argument', message: 'Command arguments must be NUL-free strings' } });
    const html = render(h(FileManager, { fn: fmFn }), fmFn.path);
    expect(html).toContain('Command arguments must be NUL-free strings');
    expect(html).toContain('>Retry<');
    expect(html).toContain('The folder could not be read.');
  });

  it('helpers: icons, type text and the path utilities', () => {
    expect(typeText(entries[0])).toBe('Folder');
    expect(typeText(entries[2])).toBe('Archive');
    expect(typeText(entries[4])).toBe('Link');
    expect(entryIcon(entries[0])).not.toBe(entryIcon(entries[3]));
    expect(paths.normalizeRel('/public_html//x/')).toBe('public_html/x');
    expect(paths.normalizeRel('a/../b')).toBeNull();
    expect(paths.normalizeRel('')).toBe('');
    expect(paths.joinRel('', 'a')).toBe('a');
    expect(paths.joinRel('a/b', 'c')).toBe('a/b/c');
    expect(paths.parentOf('a/b/c')).toBe('a/b');
    expect(paths.parentOf('a')).toBe('');
    expect(paths.baseName('a/b/c.txt')).toBe('c.txt');
    expect(paths.segmentsOf('a/b')).toEqual([{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }]);
    expect(paths.listPath('public_html/x y')).toBe('/files/list?path=public_html%2Fx%20y&limit=10000');
    expect(paths.downloadHref('a b.txt')).toBe('/api/panel/files/download?path=a%20b.txt');
    expect(paths.isArchiveName('x.tgz')).toBe(true);
    expect(paths.isArchiveName('x.gz')).toBe(false);
    expect(paths.isEditable({ type: 'file', size: 4 * 1024 * 1024 })).toBe(true);
    expect(paths.isEditable({ type: 'file', size: 4 * 1024 * 1024 + 1 })).toBe(false);
    expect(paths.isEditable({ type: 'dir', size: 0 })).toBe(false);
    expect(paths.filterEntries(entries, '', false).map((e) => e.name)).not.toContain('.bashrc');
    expect(paths.filterEntries(entries, 'NOTES', true).map((e) => e.name)).toEqual(['notes.txt']);
    expect(paths.sortEntries(entries, 'size', 'desc').map((e) => e.name)).toEqual(['public_html', 'site-backup.tar.gz', '.bashrc', 'notes.txt', 'www']);
    expect(paths.sortEntries(entries, 'name', 'asc')[0].name).toBe('public_html');
    expect(paths.modeToBits('0644')).toEqual({ owner: { r: true, w: true, x: false }, group: { r: true, w: false, x: false }, others: { r: true, w: false, x: false } });
    expect(paths.bitsToMode(paths.modeToBits('755'))).toBe('0755');
    expect(paths.modeText('0750')).toBe('rwxr-x---');
    expect(paths.isValidMode('0644')).toBe(true);
    expect(paths.isValidMode('4755')).toBe(false);
    expect(paths.isValidMode('abc')).toBe(false);
    expect(paths.archiveNameFor(['public_html/site'], 'zip')).toBe('site.zip');
    expect(paths.archiveNameFor(['a', 'b'], 'tar.gz')).toBe('files.tar.gz');
    expect(paths.bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});

const du = { path: '.', depth: 1, totalKb: 1000, entries: [{ path: 'public_html', kb: 600 }, { path: 'mail', kb: 250 }, { path: 'tmp', kb: 50 }], partial: false, measuredAt: '2026-11-03T10:00:00.000Z', cached: true };

describe('Disk usage page', () => {
  it('shows the stat tiles and the sorted folder table with meters', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/du?path=&depth=1', { loading: false, data: du });
    const html = render(h(DiskUsage, { fn: duFn }), duFn.path);
    expect(html).toContain('<h1>Disk usage</h1>');
    expect(html).toContain('Your home directory uses');
    expect(html).toContain('1000 KB');
    expect(html).toContain('2.00 GB');
    expect(html).toContain('of 10.0 GB');
    expect(html).toContain('width:20%');
    expect(html).toContain('keeps these figures for five minutes');
    expect(html).toContain('One level');
    expect(html).toContain('Two levels');
    const first = html.indexOf(' public_html</a>'), second = html.indexOf(' mail</a>'), third = html.indexOf(' tmp</a>');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(html).toContain('width:60%');
    expect(html).toContain('60%');
    expect(html).toContain('>Look inside<');
    expect(html).toContain('href="/panel/files/disk-usage?path=public_html"');
    expect(html).toContain('href="/panel/files/file-manager"');
    expect(html).not.toContain('could not be measured');
  });

  it('drills into a folder from ?path= and flags partial results', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/du?path=public_html&depth=2', { loading: false, data: { ...du, path: 'public_html', depth: 2, partial: true, cached: false, entries: [{ path: 'public_html/wp-content', kb: 500 }, { path: 'public_html/wp-content/uploads', kb: 400 }] } });
    const html = render(h(DiskUsage, { fn: duFn }), '/panel/files/disk-usage?path=public_html&depth=2');
    expect(html).toContain('aria-current="location" href="/panel/files/disk-usage?path=public_html"');
    expect(html).toContain(' wp-content</a>');
    expect(html).toContain(' wp-content/uploads</a>');
    expect(html).toContain('padding-left:18px');
    expect(html).toContain('Some folders could not be measured');
    expect(html).toContain('Fresh figures from the server.');
  });

  it('renders 501 and 403 states', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/du?path=&depth=1', { loading: false, error: { status: 501, code: 'capability_missing', message: 'setpriv missing' } });
    let html = render(h(DiskUsage, { fn: duFn }), duFn.path);
    expect(html).toContain('Not available on this server');
    expect(html).toContain('once the file manager is available');
    fixtures.responses.set('/panel/files/du?path=&depth=1', { loading: false, error: { status: 403, code: 'feature_disabled', message: 'off' } });
    html = render(h(DiskUsage, { fn: duFn }), duFn.path);
    expect(html).toContain('Not included in your plan');
  });

  it('shapeRows makes entries relative, computes shares and sorts', () => {
    const rows = shapeRows([{ path: 'a/b', kb: 10 }, { path: 'a/c', kb: 30 }, { path: 'a/c/d', kb: 5 }, { path: 'z', kb: 99 }], 'a', 40);
    expect(rows.map((r) => r.name)).toEqual(['c', 'b', 'c/d']);
    expect(rows[0].percent).toBe(75);
    expect(rows[2].depth).toBe(2);
    expect(shapeRows([{ path: '.', kb: 1 }], '', 0)).toEqual([]);
  });
});
