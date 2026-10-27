import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { catalog } from '../src/ops/registry.js';
import { execFileSync } from 'node:child_process';
import { parseWpVersion, parseWpConfig, assertUnderHome, passwdHome, findWordPress, readSiteFile, regularFileStat, WP_READ_MAX_BYTES, WP_HARDENING_FIXES, WP_FALLBACK_THEME } from '../src/ops/web.js';

// WP-CLI ops added for the bundled WP Toolkit plugin. WP-CLI is absent on the
// test host, so every op either fails the schema or reports capability_missing
// before runuser could ever be spawned.

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const ctx = createContext();
const SITE = { username: 'alice', path: '/home/alice/public_html' };

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('web.wp.* schemas reject injection before anything runs', () => {
  it('unknown ops and extra keys', async () => {
    expect((await opError(runOp('web.wp.shell', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('web.wp.inspect', { ...SITE, extra: 1 }, ctx))).code).toBe('invalid_args');
  });

  it('usernames, paths, slugs, URLs and names', async () => {
    exec.mockClear();
    for (const username of ['-u', 'a;b', 'Alice', '../x', '']) expect((await opError(runOp('web.wp.inspect', { username, path: SITE.path }, ctx))).code, username).toBe('invalid_args');
    for (const p of ['public_html', '/home/alice/../root', '/home/alice/x\0y', '']) expect((await opError(runOp('web.wp.inspect', { username: 'alice', path: p }, ctx))).code, p).toBe('invalid_args');
    for (const name of ['../x', 'Plugin', 'a b', '--all', 'x'.repeat(101)]) expect((await opError(runOp('web.wp.update', { ...SITE, kind: 'plugin', name }, ctx))).code, name).toBe('invalid_args');
    expect((await opError(runOp('web.wp.update', { ...SITE, kind: 'plugin' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.update', { ...SITE, kind: 'everything', all: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.hardenfix', { ...SITE, fixes: ['rm-rf'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.hardenfix', { ...SITE, fixes: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.discover', { usernames: ['alice', '-x'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.discover', { usernames: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.maintenance', { ...SITE, enabled: 'yes' }, ctx))).code).toBe('invalid_args');
    const install = { ...SITE, url: 'https://alice.com', title: 'Blog', adminUser: 'admin', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!', dbName: 'alice_wp', dbUser: 'alice_wp', dbPassword: 'Str0ng-Passw0rd!' };
    for (const bad of [
      { url: 'javascript:alert(1)' }, { url: 'https://alice.com/$(id)' }, { title: 'line\nbreak' }, { adminUser: 'ad min' }, { adminUser: '--admin' }, { adminEmail: 'nope' }, { adminPassword: 'short' },
      { dbName: 'alice-wp' }, { dbName: 'x'.repeat(65) }, { dbUser: 'a b' }, { dbHost: 'local host' }, { tablePrefix: 'wp' }, { tablePrefix: 'WP_' }, { locale: 'en_US; id' },
    ]) expect((await opError(runOp('web.wp.install', { ...install, ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a host without WP-CLI reports capability_missing and never spawns runuser', async () => {
    exec.mockClear();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
    try {
      expect((await runOp('web.wp.detect', {}, ctx)).installed).toBe(false);
      // Unknown users never reach the WP-CLI step either.
      expect((await opError(runOp('web.wp.inspect', { username: 'nosuchuser', path: '/home/nosuchuser/public_html' }, ctx))).code).toBe('not_found');
      expect((await opError(runOp('web.wp.update', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', kind: 'core' }, ctx))).code).toBe('not_found');
      expect((await runOp('web.wp.discover', { usernames: ['nosuchuser'] }, ctx))).toEqual({ installs: [], missing: ['nosuchuser'] });
      expect(exec).not.toHaveBeenCalled();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('catalog metadata', () => {
  it('marks every op that rewrites a site as destructive and keeps the reads plain', () => {
    for (const op of ['web.wp.install', 'web.wp.update', 'web.wp.maintenance', 'web.wp.hardenfix']) expect(catalog.get(op).destructive, op).toBe(true);
    for (const op of ['web.wp.detect', 'web.wp.discover', 'web.wp.inspect', 'web.wp.harden']) expect(catalog.get(op).destructive, op).toBe(false);
  });

  it('web.wp.detect probes WP-CLI with --allow-root, since the agent runs as root and WP-CLI refuses root by default', async () => {
    hasBinary.mockImplementation((n) => n === 'wp' || n === 'runuser' || n === 'php');
    exec.mockImplementation(async (bin, argv) => { expect(bin).toBe('wp'); return { code: 0, stdout: 'WP-CLI 2.10.0\n', stderr: '', bin, argv }; });
    try {
      expect(await runOp('web.wp.detect', {}, ctx)).toEqual({ installed: true, version: '2.10.0', php: true, runuser: true });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][1]).toEqual(['cli', 'version', '--no-color', '--allow-root']);
    } finally { exec.mockReset(); exec.mockImplementation(async () => { throw new Error('exec should not run'); }); hasBinary.mockReset(); }
  });
});

describe('WordPress helpers', () => {
  it('parses the core version and wp-config constants', () => {
    expect(parseWpVersion("<?php\n$wp_version = '6.5.2';\n")).toBe('6.5.2');
    expect(parseWpVersion('nothing')).toBe(null);
    expect(parseWpConfig("define( 'DB_NAME', 'alice_wp' );\ndefine('DB_USER', \"alice_u\");\ndefine( 'DB_HOST', 'localhost' );\n$table_prefix = 'wp_';")).toEqual({ dbName: 'alice_wp', dbUser: 'alice_u', dbHost: 'localhost', tablePrefix: 'wp_' });
    expect(WP_HARDENING_FIXES).toContain('config-perms');
  });

  it('a site directory must sit under the home directory, symlinks included', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
    try {
      const home = path.join(tmp, 'alice');
      fs.mkdirSync(path.join(home, 'public_html'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'elsewhere'));
      fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(home, 'public_html', 'link'));
      expect(assertUnderHome(home, path.join(home, 'public_html'))).toBe(path.join(home, 'public_html'));
      expect(assertUnderHome(home, path.join(home, 'public_html', 'new', 'site'))).toBe(path.join(home, 'public_html', 'new', 'site'));
      expect(() => assertUnderHome(home, path.join(tmp, 'elsewhere'))).toThrow(/not inside/);
      expect(() => assertUnderHome(home, `${home}2/public_html`)).toThrow(/not inside/);
      expect(() => assertUnderHome(home, path.join(home, 'public_html', 'link'))).toThrow(/symbolic link/);
      expect(() => assertUnderHome(home, path.join(home, 'public_html', 'link', 'deeper'))).toThrow(/symbolic link/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// Files under an account's web root are account-controlled: a FIFO would park
// the root agent forever, a symlink would read another tree, a sparse file
// would fill root's memory. Each is planted and must be skipped, never opened.
describe('site files are read only when they are small regular files', () => {
  const me = os.userInfo().username;
  const home = passwdHome(me);
  const userCtx = createContext({ allowedRoots: [home] });
  const config = "<?php\ndefine('DB_NAME', 'alice_wp');\n$table_prefix = 'wp_';\n";
  const version = "<?php\n$wp_version = '6.5.2';\n";

  function plant(root, name, kind, target) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'wp-includes', 'version.php'), version);
    const cfg = path.join(dir, 'wp-config.php');
    if (kind === 'file') fs.writeFileSync(cfg, config);
    else if (kind === 'fifo') execFileSync('mkfifo', [cfg]);
    else if (kind === 'symlink') fs.symlinkSync(target, cfg);
    else if (kind === 'sparse') { fs.writeFileSync(cfg, config); fs.truncateSync(cfg, WP_READ_MAX_BYTES + 1); }
    return dir;
  }

  it('readSiteFile and findWordPress skip FIFOs, symlinks and oversized files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-files-'));
    try {
      const good = plant(tmp, 'good', 'file');
      const fifo = plant(tmp, 'fifo', 'fifo');
      const link = plant(tmp, 'link', 'symlink', path.join(good, 'wp-config.php'));
      const sparse = plant(tmp, 'sparse', 'sparse');
      fs.symlinkSync(path.join(good, 'wp-includes', 'version.php'), path.join(fifo, 'wp-includes', 'version-link.php'));
      expect(readSiteFile(path.join(good, 'wp-config.php'))).toBe(config);
      expect(readSiteFile(path.join(fifo, 'wp-config.php'))).toBe(null);
      expect(readSiteFile(path.join(link, 'wp-config.php'))).toBe(null);
      expect(readSiteFile(path.join(sparse, 'wp-config.php'))).toBe(null);
      expect(readSiteFile(path.join(fifo, 'wp-includes', 'version-link.php'))).toBe(null);
      expect(readSiteFile(path.join(tmp, 'missing'))).toBe(null);
      expect(regularFileStat(path.join(fifo, 'wp-config.php'))).toBe(null);
      expect(regularFileStat(good)).toBe(null);
      const found = [];
      const started = Date.now();
      findWordPress(tmp, 3, { dirs: 500 }, found);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(found).toEqual([{ path: good, version: '6.5.2', dbName: 'alice_wp', dbUser: null, dbHost: null, tablePrefix: 'wp_' }]);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('web.wp.discover skips a planted FIFO and web.wp.harden / inspect refuse it without spawning anything', async () => {
    // discover walks <home>/{public_html,www,domains}; one that does not exist
    // yet is created for the test and removed afterwards.
    const sub = ['public_html', 'www', 'domains'].find((d) => !fs.existsSync(path.join(home, d)));
    if (!sub) return;
    const root = path.join(home, sub);
    fs.mkdirSync(root);
    exec.mockClear();
    try {
      const good = plant(root, 'good-site', 'file');
      const fifo = plant(root, 'fifo-site', 'fifo');
      plant(root, 'link-site', 'symlink', path.join(good, 'wp-config.php'));
      plant(root, 'link-away', 'symlink', '/etc/passwd');
      const r = await runOp('web.wp.discover', { usernames: [me] }, userCtx);
      expect(r.missing).toEqual([]);
      expect(r.installs.map((i) => i.relative)).toEqual([`${sub}/good-site`]);
      expect(r.installs[0]).toMatchObject({ username: me, version: '6.5.2', dbName: 'alice_wp' });
      expect((await opError(runOp('web.wp.harden', { username: me, path: fifo }, userCtx))).code).toBe('not_found');
      expect((await opError(runOp('web.wp.inspect', { username: me, path: path.join(root, 'link-site') }, userCtx))).code).toBe('not_found');
      expect((await opError(runOp('web.wp.hardenfix', { username: me, path: path.join(root, 'link-away'), fixes: ['config-perms'] }, userCtx))).code).toBe('not_found');
      expect(exec).not.toHaveBeenCalled();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// The ops that run WP-CLI are exercised with a fake `wp`/`runuser` (exec and
// hasBinary are mocked) against a site directory inside the test user's real
// /etc/passwd home, so the path checks are the production ones.
describe('WordPress install and hardening never touch the account tree as root', () => {
  const me = os.userInfo().username;
  const home = passwdHome(me);
  const userCtx = createContext({ allowedRoots: [home] });
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', bin: 'runuser', argv: [] });
  const argvOf = (call) => call[1];
  const wpArgs = (argv) => argv.slice(argv.indexOf('wp') + 1).filter((a) => !a.startsWith('--path=') && a !== '--no-color' && a !== '--skip-plugins' && a !== '--skip-themes');

  function fakeWpCli(handler) {
    hasBinary.mockImplementation((n) => n === 'wp' || n === 'runuser');
    exec.mockImplementation(async (bin, argv, opts) => {
      expect(bin).toBe('runuser');
      expect(argv.slice(0, 3)).toEqual(['-u', me, '--']);
      return handler(argv.slice(3), opts) ?? ok();
    });
  }
  const restore = () => { exec.mockReset(); exec.mockImplementation(async () => { throw new Error('exec should not run'); }); hasBinary.mockReset(); };

  it('hardenfix chmods wp-config.php as the account user through runuser, never fs.chmodSync as root', async () => {
    const site = fs.mkdtempSync(path.join(home, '.whm-wp-test-'));
    const chmod = vi.spyOn(fs, 'chmodSync');
    try {
      fs.writeFileSync(path.join(site, 'wp-config.php'), "<?php $table_prefix = 'wp_';");
      const seen = [];
      fakeWpCli((argv) => { seen.push(argv); return ok(); });
      const r = await runOp('web.wp.hardenfix', { username: me, path: site, fixes: ['config-perms', 'debug-off'] }, userCtx);
      expect(r).toEqual({ applied: ['config-perms', 'debug-off'], failed: {} });
      expect(seen[0]).toEqual(['chmod', '600', '--', path.join(site, 'wp-config.php')]);
      expect(wpArgs(seen[1])).toEqual(['config', 'set', 'WP_DEBUG', 'false', '--raw', '--type=constant']);
      expect(chmod).not.toHaveBeenCalled();
      // a chmod the user cannot perform is reported, not escalated
      fakeWpCli((argv) => (argv[0] === 'chmod' ? { code: 1, stdout: '', stderr: 'chmod: changing permissions: Operation not permitted', bin: 'runuser', argv } : ok()));
      const failed = await runOp('web.wp.hardenfix', { username: me, path: site, fixes: ['config-perms'] }, userCtx);
      expect(failed.applied).toEqual([]);
      expect(failed.failed['config-perms']).toMatch(/Operation not permitted/);
      expect(chmod).not.toHaveBeenCalled();
    } finally { chmod.mockRestore(); restore(); fs.rmSync(site, { recursive: true, force: true }); }
  });

  it('install downloads WordPress with its themes, verifies an active theme and chmods as the user', async () => {
    const site = path.join(fs.mkdtempSync(path.join(home, '.whm-wp-test-')), 'blog');
    const chmod = vi.spyOn(fs, 'chmodSync');
    const install = { username: me, path: site, url: 'https://alice.com/blog', title: 'Blog', adminUser: 'editor', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!', dbName: 'alice_wp', dbUser: 'alice_wp', dbPassword: 'Db-Passw0rd!xyz' };
    try {
      const seen = [];
      let themeLists = 0;
      fakeWpCli((argv, opts) => {
        seen.push({ argv, input: opts?.input });
        const a = argv[0] === 'wp' ? wpArgs(argv) : argv;
        if (a[0] === 'theme' && a[1] === 'list') return ok(++themeLists === 1 ? '[]' : '[{"name":"twentytwentyfive","version":"1.0"}]');
        if (a[0] === 'core' && a[1] === 'version') return ok('6.6\n');
        return ok();
      });
      const r = await runOp('web.wp.install', install, userCtx);
      expect(r).toMatchObject({ path: site, version: '6.6', theme: { name: 'twentytwentyfive' }, steps: ['download', 'config', 'install', 'theme'], warning: null });
      const cmds = seen.map((s) => (s.argv[0] === 'wp' ? wpArgs(s.argv) : s.argv));
      expect(cmds[0]).toEqual(['mkdir', '-p', '--', site]);
      expect(cmds[1]).toEqual(['core', 'download', '--locale=en_US']);
      expect(cmds[1]).not.toContain('--skip-content');
      expect(cmds[4]).toEqual(['theme', 'list', '--status=active', '--format=json', '--fields=name,version']);
      expect(cmds[5]).toEqual(['theme', 'install', WP_FALLBACK_THEME, '--activate']);
      expect(cmds[7]).toEqual(['chmod', '600', '--', path.join(site, 'wp-config.php')]);
      // passwords go over stdin, never argv
      expect(seen.flatMap((s) => s.argv).join(' ')).not.toMatch(/Passw0rd/);
      expect(seen[2].input).toBe('Db-Passw0rd!xyz\n');
      expect(seen[3].input).toBe('Str0ng-Passw0rd!\n');
      expect(chmod).not.toHaveBeenCalled();
      // no theme at all is a failed install, not a site that renders an error page
      fakeWpCli((argv) => { const a = argv[0] === 'wp' ? wpArgs(argv) : argv; return a[0] === 'theme' && a[1] === 'list' ? ok('[]') : ok(); });
      fs.rmSync(path.join(site, 'wp-config.php'), { force: true });
      const err = await opError(runOp('web.wp.install', install, userCtx));
      expect(err.code).toBe('command_failed');
      expect(err.details.step).toBe('theme');
    } finally { chmod.mockRestore(); restore(); fs.rmSync(path.dirname(site), { recursive: true, force: true }); }
  });

  // A failure after the download would otherwise leave a tree whose
  // wp-config.php makes the retry fail with "exists"; the op removes what it
  // created, as the account user, and reports it in the error details.
  it('a failed install removes the tree it created as the account user so the retry is not refused', async () => {
    const parent = fs.mkdtempSync(path.join(home, '.whm-wp-test-'));
    let rmSync = null;
    const install = { username: me, path: path.join(parent, 'blog'), url: 'https://alice.com/blog', title: 'Blog', adminUser: 'editor', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!', dbName: 'alice_wp', dbUser: 'alice_wp', dbPassword: 'Db-Passw0rd!xyz' };
    const failInstall = (argv) => { const a = argv[0] === 'wp' ? wpArgs(argv) : argv; return a[0] === 'core' && a[1] === 'install' ? { code: 1, stdout: '', stderr: 'Error: Database connection error', bin: 'runuser', argv } : ok(); };
    try {
      // the site directory did not exist: the whole directory goes
      let seen = [];
      fakeWpCli((argv) => { seen.push(argv); return failInstall(argv); });
      let err = await opError(runOp('web.wp.install', install, userCtx));
      expect(err.code).toBe('command_failed');
      expect(err.details).toMatchObject({ step: 'install', steps: ['download', 'config'], cleanup: `removed ${install.path}` });
      expect(seen.at(-1)).toEqual(['rm', '-rf', '--', install.path]);
      // an existing directory keeps what it had; only the new entries are removed
      const site = path.join(parent, 'existing');
      fs.mkdirSync(site);
      fs.writeFileSync(path.join(site, 'keep.html'), 'mine');
      seen = [];
      fakeWpCli((argv) => {
        seen.push(argv);
        const a = argv[0] === 'wp' ? wpArgs(argv) : argv;
        if (a[0] === 'core' && a[1] === 'download') { fs.mkdirSync(path.join(site, 'wp-includes')); fs.writeFileSync(path.join(site, 'index.php'), '<?php'); }
        return failInstall(argv);
      });
      err = await opError(runOp('web.wp.install', { ...install, path: site }, userCtx));
      expect(err.details.cleanup).toBe(`removed the 2 new entries from ${site}`);
      expect(seen.at(-1).slice(0, 3)).toEqual(['rm', '-rf', '--']);
      expect(seen.at(-1).slice(3).sort()).toEqual([path.join(site, 'index.php'), path.join(site, 'wp-includes')]);
      expect(seen.at(-1)).not.toContain(path.join(site, 'keep.html'));
      expect(seen.at(-1)).not.toContain(site);
      // a removal the user cannot perform is reported, never retried as root
      fs.rmSync(path.join(site, 'wp-includes'), { recursive: true, force: true });
      fs.rmSync(path.join(site, 'index.php'), { force: true });
      rmSync = vi.spyOn(fs, 'rmSync');
      fakeWpCli((argv) => {
        const a = argv[0] === 'wp' ? wpArgs(argv) : argv;
        if (a[0] === 'core' && a[1] === 'download') fs.writeFileSync(path.join(site, 'index.php'), '<?php');
        if (a[0] === 'rm') return { code: 1, stdout: '', stderr: 'rm: cannot remove: Permission denied', bin: 'runuser', argv };
        return failInstall(argv);
      });
      err = await opError(runOp('web.wp.install', { ...install, path: site }, userCtx));
      expect(err.details.cleanup).toMatch(/was left in place .*Permission denied.*remove it before retrying/);
      expect(rmSync).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(site, 'keep.html'))).toBe(true);
    } finally { rmSync?.mockRestore(); restore(); fs.rmSync(parent, { recursive: true, force: true }); }
  });
});
