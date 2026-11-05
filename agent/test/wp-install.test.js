import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { catalog } from '../src/ops/registry.js';
import { getent } from '../src/ops/as-user.js';
import { checkWordPressMembers, renderWpConfig, parseInstallResponse, randomSalt, WP_SALT_KEYS, WP_TOP_LEVEL, WP_DOWNLOAD_URL, WP_CHECKSUM_URL } from '../src/ops/wp-install.js';

// The panel's WordPress install without WP-CLI. Nothing here reaches
// wordpress.org or spawns a program: the schemas and the guards refuse first,
// and the one run that gets past them records the argv of a mocked exec.

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const ctx = createContext();
const SITE = { username: 'alice', path: '/home/alice/public_html/blog' };
const realFetch = globalThis.fetch;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

beforeEach(() => { exec.mockClear(); hasBinary.mockReset(); hasBinary.mockImplementation(() => true); globalThis.fetch = realFetch; });

describe('web.wp.fetch / configure / webinstall / remove schemas reject injection before anything runs', () => {
  it('unknown ops, extra keys, usernames and paths', async () => {
    expect((await opError(runOp('web.wp.download', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('web.wp.fetch', { ...SITE, url: 'https://evil.example/x.zip' }, ctx))).code).toBe('invalid_args');
    for (const username of ['-u', 'a;b', 'Alice', '../x', '', 'root ']) expect((await opError(runOp('web.wp.fetch', { username, path: SITE.path }, ctx))).code, username).toBe('invalid_args');
    for (const p of ['public_html', '/home/alice/../root', '/home/alice/x\0y', '']) expect((await opError(runOp('web.wp.remove', { username: 'alice', path: p, mode: 'tree' }, ctx))).code, p).toBe('invalid_args');
    expect((await opError(runOp('web.wp.remove', { ...SITE, mode: 'everything' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.fetch', { ...SITE, timeoutMs: 999_999 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.fetch', { ...SITE, maxBytes: 10 ** 12 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('configure and webinstall arguments', async () => {
    const cfg = { ...SITE, dbName: 'alice_wp', dbUser: 'alice_wp', dbPassword: 'Str0ng-Passw0rd!' };
    for (const bad of [{ dbName: 'alice-wp' }, { dbName: "x'; drop" }, { dbUser: 'a b' }, { dbPassword: 'short' }, { dbPassword: 'line\nbreak-password' }, { dbHost: 'local host' }, { tablePrefix: 'wp' }, { tablePrefix: 'WP_' }, { extra: 1 }]) {
      expect((await opError(runOp('web.wp.configure', { ...cfg, ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    const web = { ...SITE, url: 'https://alice.com/blog', title: 'Blog', adminUser: 'editor', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!' };
    for (const bad of [{ url: 'javascript:alert(1)' }, { url: 'https://alice.com/$(id)' }, { url: 'ftp://alice.com' }, { title: 'line\nbreak' }, { title: '' }, { adminUser: 'ad min' }, { adminUser: '--admin' }, { adminEmail: 'nope' }, { adminPassword: 'short' }, { locale: 'en_US; id' }, { ip: '127.0.0.1; ls' }, { timeoutMs: 1 }]) {
      expect((await opError(runOp('web.wp.webinstall', { ...web, ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('an unknown or system account never reaches a download, a write or a program', async () => {
    globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
    expect((await opError(runOp('web.wp.fetch', { username: 'nosuchuser', path: '/home/nosuchuser/public_html' }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('web.wp.fetch', { username: 'root', path: '/root/public_html' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('web.wp.configure', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', dbName: 'x_wp', dbUser: 'x_wp', dbPassword: 'Str0ng-Passw0rd!' }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('web.wp.webinstall', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', url: 'http://x.example', title: 'T', adminUser: 'a', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!' }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('web.wp.remove', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', mode: 'tree' }, ctx))).code).toBe('not_found');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('a path outside the allowed roots is refused for a real account too', async () => {
    const narrow = createContext({ allowedRoots: ['/var/lib/whm'] });
    const user = getent('nobody') ? 'nobody' : null;
    if (!user) return;
    // nobody is a system account: refused before the roots are consulted; the
    // roots check is covered by accountPath's own tests in as-user.test.js.
    expect((await opError(runOp('web.wp.remove', { username: user, path: '/home/nobody/x', mode: 'tree' }, narrow))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('catalog metadata', () => {
  it('marks every op that writes or removes as destructive and keeps the probe plain', () => {
    for (const op of ['web.wp.fetch', 'web.wp.configure', 'web.wp.webinstall', 'web.wp.remove']) expect(catalog.get(op).destructive, op).toBe(true);
    expect(catalog.get('web.wp.requirements').destructive).toBe(false);
    expect(WP_DOWNLOAD_URL).toBe('https://wordpress.org/latest.zip');
    expect(WP_CHECKSUM_URL.startsWith('https://')).toBe(true);
  });

  it('web.wp.requirements reads php -m and the binaries without touching an account', async () => {
    hasBinary.mockImplementation((n) => ['php', 'unzip', 'setpriv'].includes(n));
    exec.mockImplementation(async (bin, argv) => { expect(bin).toBe('php'); expect(argv).toEqual(['-m']); return { code: 0, stdout: '[PHP Modules]\ncurl\nmysqli\nmysqlnd\npdo_mysql\n', stderr: '', bin, argv }; });
    expect(await runOp('web.wp.requirements', {}, ctx)).toEqual({ wpcli: false, php: true, phpMysql: true, unzip: true, asUser: true });
    exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '[PHP Modules]\ncurl\n', stderr: '', bin, argv }));
    expect((await runOp('web.wp.requirements', {}, ctx)).phpMysql).toBe(false);
    hasBinary.mockImplementation(() => false);
    expect(await runOp('web.wp.requirements', {}, ctx)).toEqual({ wpcli: false, php: false, phpMysql: null, unzip: false, asUser: false });
  });
});

describe('the archive guard', () => {
  const home = '/home/alice';
  const dest = '/home/alice/public_html/blog';
  const release = [
    { type: 'dir', name: 'wordpress/', target: null }, { type: 'file', name: 'wordpress/wp-settings.php', target: null }, { type: 'dir', name: 'wordpress/wp-includes/', target: null },
    { type: 'file', name: 'wordpress/wp-includes/version.php', target: null }, { type: 'file', name: 'wordpress/index.php', target: null }, { type: 'dir', name: 'wordpress/wp-content/themes/', target: null },
  ];

  it('accepts a release and reports its top-level entries', () => {
    expect(checkWordPressMembers(release, { dest, home })).toEqual(['index.php', 'wp-content', 'wp-includes', 'wp-settings.php']);
  });

  it('refuses members outside wordpress/, traversal, absolute names, links and non-releases', () => {
    const refused = (members) => { try { checkWordPressMembers(members, { dest, home }); } catch (err) { expect(err).toBeInstanceOf(OpError); return err.code; } return null; };
    expect(refused([...release, { type: 'file', name: 'evil.php', target: null }])).toBe('refused');
    expect(refused([...release, { type: 'file', name: 'wordpress/../../.ssh/authorized_keys', target: null }])).toBe('refused');
    expect(refused([...release, { type: 'file', name: '/etc/passwd', target: null }])).toBe('refused');
    expect(refused([...release, { type: 'file', name: 'wordpress//x', target: null }])).toBe('refused');
    expect(refused([...release, { type: 'symlink', name: 'wordpress/wp-content/uploads', target: null }])).toBe('refused');
    expect(refused([...release, { type: 'hardlink', name: 'wordpress/x', target: 'wordpress/index.php' }])).toBe('refused');
    expect(refused([{ type: 'dir', name: 'wordpress/', target: null }, { type: 'file', name: 'wordpress/index.php', target: null }])).toBe('refused');
    expect(refused([])).toBe('refused');
  });
});

describe('wp-config.php rendering and the installer answer', () => {
  it('escapes PHP string values, generates eight salts and keeps the file single-quoted', () => {
    const text = renderWpConfig({ dbName: 'alice_wp', dbUser: 'alice_wp', dbPassword: "p'a\\ss#!", dbHost: 'localhost', tablePrefix: 'wp_' });
    expect(text.startsWith('<?php\n')).toBe(true);
    expect(text).toContain("define( 'DB_NAME', 'alice_wp' );");
    expect(text).toContain("define( 'DB_PASSWORD', 'p\\'a\\\\ss#!' );");
    expect(text).toContain("$table_prefix = 'wp_';");
    expect(text).toContain("define( 'WP_DEBUG', false );");
    expect(text).toContain("require_once ABSPATH . 'wp-settings.php';");
    for (const key of WP_SALT_KEYS) expect(text).toMatch(new RegExp(`define\\( '${key}', '[^'\\\\]{64}' \\);`));
    const salts = new Set(WP_SALT_KEYS.map((k) => new RegExp(`'${k}', '([^']+)'`).exec(text)[1]));
    expect(salts.size).toBe(8);
    expect(randomSalt(64)).toHaveLength(64);
    expect(randomSalt(64)).not.toBe(randomSalt(64));
    expect(randomSalt(200)).not.toMatch(/['\\]/);
    const fixed = renderWpConfig({ dbName: 'a', dbUser: 'b', dbPassword: 'c'.repeat(8), dbHost: 'localhost', tablePrefix: 'wp_', salts: { AUTH_KEY: 'fixed-key' } });
    expect(fixed).toContain("define( 'AUTH_KEY', 'fixed-key' );");
    expect(WP_TOP_LEVEL).toContain('wp-config.php');
    expect(WP_TOP_LEVEL).not.toContain('.htaccess');
  });

  it('parseInstallResponse tells success, "already installed" and wp_die() errors apart', () => {
    expect(parseInstallResponse(200, '<html><body class="wp-core-ui"><h1>Success!</h1><p>WordPress has been installed.</p><a href="../wp-login.php">Log In</a></body></html>')).toEqual({ ok: true, code: null, message: null });
    expect(parseInstallResponse(200, '<h1>Already Installed</h1><p>You appear to have already installed WordPress.</p>')).toMatchObject({ ok: false, code: 'exists' });
    expect(parseInstallResponse(500, '<h1>Error establishing a database connection</h1>')).toMatchObject({ ok: false, code: 'command_failed', message: expect.stringContaining('Error establishing a database connection') });
    expect(parseInstallResponse(200, '<p><strong>Error:</strong> Please provide a valid username.</p>')).toMatchObject({ ok: false, message: expect.stringContaining('valid username') });
    expect(parseInstallResponse(null, '')).toMatchObject({ ok: false, code: 'command_failed' });
    expect(parseInstallResponse(200, '<script>var x = "Success!";</script><p>Nothing</p>')).toMatchObject({ ok: false });
  });
});

// On a provisioned host the operator can point these runs at a real hosting
// account (WHM_TEST_ACCOUNT=<user>, run as root): the ops look at the planted
// metadata as root and record what they would run as the account, nothing is
// executed. The probe directory is removed afterwards.
describe('as-user runs against a real account', () => {
  const account = process.env.WHM_TEST_ACCOUNT;
  const info = account ? getent(account) : null;
  const canRun = Boolean(info && info.uid >= 1000 && typeof process.getuid === 'function' && process.getuid() === 0 && fs.existsSync(info.home));
  const run = canRun ? it : it.skip;
  const probe = info ? path.join(info.home, 'public_html', 'probe-wp-install-test') : null;

  function plant(dir) {
    fs.mkdirSync(path.join(dir, 'wp-includes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'wp-admin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'wp-settings.php'), '<?php\n');
    fs.writeFileSync(path.join(dir, 'wp-includes', 'version.php'), "<?php\n$wp_version = '6.9';\n");
    fs.writeFileSync(path.join(dir, 'wp-admin', 'install.php'), '<?php\n');
  }

  run('remove, configure and fetch pin the path, run as the account and refuse what is already there', async () => {
    fs.rmSync(probe, { recursive: true, force: true });
    plant(probe);
    try {
      const calls = [];
      exec.mockImplementation(async (bin, argv) => { calls.push([bin, argv]); return { code: 0, stdout: 'No syntax errors detected', stderr: '', bin, argv }; });
      globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
      // fetch: a WordPress tree is already there → exists, before any download.
      expect((await opError(runOp('web.wp.fetch', { username: account, path: probe }, ctx))).code).toBe('exists');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // configure: the write and the lint run as the account.
      const cfg = await runOp('web.wp.configure', { username: account, path: probe, dbName: `${account}_wp`, dbUser: `${account}_wp`, dbPassword: 'Str0ng-Passw0rd!', tablePrefix: 'wp_' }, ctx);
      expect(cfg).toMatchObject({ path: path.join(probe, 'wp-config.php'), mode: '0600' });
      const wrappers = new Set(calls.map(([bin]) => bin));
      expect([...wrappers].every((b) => ['setpriv', 'runuser', 'nice'].includes(b))).toBe(true);
      const runs = (argv, prog) => argv.some((a) => a === prog || a.endsWith(`/${prog}`));
      const dd = calls.find(([, argv]) => runs(argv, 'dd'));
      expect(dd).toBeTruthy();
      expect(dd[1].join(' ')).toContain(`of=${path.join(probe, 'wp-config.php')}.whm-`);
      expect(calls.some(([, argv]) => runs(argv, 'chmod') && argv.includes('0600'))).toBe(true);
      // The mocked dd wrote nothing, so a second configure still sees no file;
      // plant one and the op refuses to overwrite it.
      fs.writeFileSync(path.join(probe, 'wp-config.php'), '<?php\n');
      expect((await opError(runOp('web.wp.configure', { username: account, path: probe, dbName: 'x_wp', dbUser: 'x_wp', dbPassword: 'Str0ng-Passw0rd!' }, ctx))).code).toBe('exists');
      // remove: entries mode names only the release's own files, tree mode the directory.
      calls.length = 0;
      const entries = await runOp('web.wp.remove', { username: account, path: probe, mode: 'entries' }, ctx);
      expect(entries.removed.sort()).toEqual(['wp-admin', 'wp-config.php', 'wp-includes', 'wp-settings.php'].map((n) => path.relative(info.home, path.join(probe, n))).sort());
      const rm = calls.find(([, argv]) => runs(argv, 'rm'));
      const at = rm[1].findIndex((a) => a === 'rm' || a.endsWith('/rm'));
      expect(rm[1].slice(at + 1)).toEqual(['-rf', '--one-file-system', '--', ...['wp-admin', 'wp-includes', 'wp-config.php', 'wp-settings.php'].map((n) => path.join(probe, n))]);
      const tree = await runOp('web.wp.remove', { username: account, path: probe, mode: 'tree' }, ctx);
      expect(tree.removed).toEqual([path.relative(info.home, probe)]);
      expect((await opError(runOp('web.wp.remove', { username: account, path: path.join(info.home, 'public_html', 'probe-wp-missing'), mode: 'tree' }, ctx))).code).toBe('not_found');
      expect((await opError(runOp('web.wp.remove', { username: account, path: info.home, mode: 'tree' }, ctx))).code).toBe('refused');
      expect((await opError(runOp('web.wp.remove', { username: account, path: `${info.home}/../${path.basename(info.home)}2`, mode: 'tree' }, ctx))).code).toMatch(/invalid_args|path_not_allowed/);
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });
});
