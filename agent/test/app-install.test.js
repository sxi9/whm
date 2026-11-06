import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { catalog } from '../src/ops/registry.js';
import { getent } from '../src/ops/as-user.js';
import {
  APP_RELEASES, APP_IDS, checkAppMembers, renderDrupalSettings, parseJoomlaVersion, parseJoomlaConfig, parseDrupalVersion, parseDrupalSettings,
  joomlaInstallArgv, joomlaInstallVerdict, inspectAppTree, magicMatches, parsePhpVersion, randomToken,
} from '../src/ops/app-install.js';

// The Joomla/Drupal installers of the account panel. Nothing here reaches a
// release server or spawns a program: the schemas and the guards refuse first,
// and the runs that get past them record the argv of a mocked exec.

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const ctx = createContext();
const SITE = { username: 'alice', path: '/home/alice/public_html/cms' };
const realFetch = globalThis.fetch;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

beforeEach(() => { exec.mockClear(); hasBinary.mockReset(); hasBinary.mockImplementation(() => true); globalThis.fetch = realFetch; });

describe('the release pins', () => {
  it('name an https archive with a 64-hex SHA-256, a size and a PHP floor for every app', () => {
    expect(APP_IDS).toEqual(['joomla', 'drupal']);
    for (const id of APP_IDS) {
      const r = APP_RELEASES[id];
      expect(r.url.startsWith('https://'), id).toBe(true);
      expect(r.sha256, id).toMatch(/^[a-f0-9]{64}$/);
      expect(r.bytes, id).toBeGreaterThan(10 * 1024 * 1024);
      expect(['zip', 'tar']).toContain(r.format);
      expect(r.requires.php).toMatch(/^\d+\.\d+$/);
      expect(r.signature.length).toBeGreaterThan(1);
      expect(r.topLevel).toContain('index.php');
    }
    expect(APP_RELEASES.joomla.version).toMatch(/^[5-9]\.\d+\.\d+$/);
    expect(APP_RELEASES.joomla.url).toContain(`Joomla_${APP_RELEASES.joomla.version}-Stable-Full_Package.zip`);
    expect(APP_RELEASES.drupal.version).toMatch(/^1[1-9]\.\d+\.\d+$/);
    expect(APP_RELEASES.drupal.url).toBe(`https://ftp.drupal.org/files/projects/drupal-${APP_RELEASES.drupal.version}.tar.gz`);
    expect(APP_RELEASES.drupal.root).toBe(`drupal-${APP_RELEASES.drupal.version}`);
    expect(APP_RELEASES.joomla.root).toBe(null);
    // Joomla ships htaccess.txt/robots.txt.dist; a site's own .htaccess and robots.txt are never the installer's to remove.
    for (const n of ['.htaccess', 'robots.txt']) expect(APP_RELEASES.joomla.topLevel, n).not.toContain(n);
    for (const n of ['htaccess.txt', 'robots.txt.dist', 'configuration.php']) expect(APP_RELEASES.joomla.topLevel, n).toContain(n);
    expect(Object.isFrozen(APP_RELEASES)).toBe(true);
  });

  it('web.app.catalog reports the pins without the internals', async () => {
    const r = await runOp('web.app.catalog', {}, ctx);
    expect(r.apps.joomla).toEqual({ name: 'Joomla', version: APP_RELEASES.joomla.version, url: APP_RELEASES.joomla.url, sha256: APP_RELEASES.joomla.sha256, bytes: APP_RELEASES.joomla.bytes, format: 'zip', requires: { php: '8.3' } });
    expect(r.apps.drupal.signature).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it('marks every op that writes or removes as destructive and keeps the probes plain', () => {
    for (const op of ['web.app.fetch', 'web.app.joomla.install', 'web.app.drupal.configure', 'web.app.remove']) expect(catalog.get(op).destructive, op).toBe(true);
    expect(catalog.get('web.app.requirements').destructive).toBe(false);
    expect(catalog.get('web.app.discover').destructive).toBe(false);
    expect(catalog.get('web.app.catalog').destructive).toBe(false);
  });
});

describe('schemas reject injection before anything runs', () => {
  it('unknown ops, apps, extra keys, usernames and paths', async () => {
    expect((await opError(runOp('web.app.download', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('web.app.fetch', { ...SITE, app: 'wordpress' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.app.fetch', { ...SITE, app: 'joomla', url: 'https://evil.example/x.zip' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.app.fetch', { ...SITE, app: 'joomla', sha256: 'a'.repeat(64) }, ctx))).code).toBe('invalid_args');
    for (const username of ['-u', 'a;b', 'Alice', '../x', '', 'root ']) expect((await opError(runOp('web.app.fetch', { username, path: SITE.path, app: 'drupal' }, ctx))).code, username).toBe('invalid_args');
    for (const p of ['public_html', '/home/alice/../root', '/home/alice/x\0y', '']) expect((await opError(runOp('web.app.remove', { username: 'alice', path: p, app: 'joomla', mode: 'tree' }, ctx))).code, p).toBe('invalid_args');
    expect((await opError(runOp('web.app.remove', { ...SITE, app: 'joomla', mode: 'everything' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.app.fetch', { ...SITE, app: 'drupal', timeoutMs: 999_999 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.app.fetch', { ...SITE, app: 'drupal', maxBytes: 10 ** 12 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.app.discover', { usernames: ['alice; id'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('joomla.install and drupal.configure arguments', async () => {
    const j = { ...SITE, url: 'https://alice.com/cms', title: 'Alice', adminUser: 'editor', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!', dbName: 'alice_joomla', dbUser: 'alice_joomla', dbPassword: 'Str0ng-Passw0rd!', dbPrefix: 'j5x2a_' };
    for (const bad of [{ url: 'javascript:alert(1)' }, { url: 'https://alice.com/$(id)' }, { title: 'line\nbreak' }, { title: '' }, { adminUser: 'ad min' }, { adminUser: '--admin' }, { adminUser: 'a' }, { adminEmail: 'nope' }, { adminPassword: 'short-pass' }, { adminPassword: 'line\nbreak-password' }, { dbName: 'alice-joomla' }, { dbName: "x'; drop" }, { dbUser: 'a b' }, { dbPassword: 'short' }, { dbHost: 'local host' }, { dbPrefix: 'jos' }, { dbPrefix: '1ab_' }, { dbPrefix: 'JOS_' }, { dbPrefix: 'averyveryverylongprefix_' }, { extra: 1 }]) {
      expect((await opError(runOp('web.app.joomla.install', { ...j, ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    const d = { ...SITE, dbName: 'alice_drupal', dbUser: 'alice_drupal', dbPassword: 'Str0ng-Passw0rd!', trustedHosts: ['alice.com'] };
    for (const bad of [{ trustedHosts: [] }, { trustedHosts: ['alice.com$'] }, { trustedHosts: ['a b'] }, { trustedHosts: ['^.*$'] }, { dbPrefix: 'bad' }, { dbPassword: 'short' }, { hashSalt: 'x' }, { extra: 1 }]) {
      expect((await opError(runOp('web.app.drupal.configure', { ...d, ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('an unknown or system account never reaches a download, a write or a program', async () => {
    globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
    expect((await opError(runOp('web.app.fetch', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', app: 'joomla' }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('web.app.fetch', { username: 'root', path: '/root/public_html', app: 'drupal' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('web.app.joomla.install', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', url: 'http://x.example', title: 'T', adminUser: 'ab', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!', dbName: 'x_j', dbUser: 'x_j', dbPassword: 'Str0ng-Passw0rd!' }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('web.app.drupal.configure', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', dbName: 'x_d', dbUser: 'x_d', dbPassword: 'Str0ng-Passw0rd!', trustedHosts: ['x.example'] }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('web.app.remove', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', app: 'joomla', mode: 'tree' }, ctx))).code).toBe('not_found');
    expect((await runOp('web.app.discover', { usernames: ['nosuchuser', 'root'] }, ctx))).toEqual({ installs: [], missing: ['nosuchuser', 'root'] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('web.app.requirements reads php -m / php -v and the binaries without touching an account', async () => {
    hasBinary.mockImplementation((n) => ['php', 'unzip', 'tar', 'setpriv'].includes(n));
    exec.mockImplementation(async (bin, argv) => { expect(bin).toBe('php'); return argv[0] === '-m' ? { code: 0, stdout: '[PHP Modules]\ncurl\nmysqli\npdo_mysql\n', stderr: '', bin, argv } : { code: 0, stdout: 'PHP 8.5.0 (cli) (built: Nov  1 2026)\n', stderr: '', bin, argv }; });
    expect(await runOp('web.app.requirements', {}, ctx)).toEqual({ php: true, phpVersion: '8.5.0', phpMysql: true, unzip: true, tar: true, asUser: true });
    hasBinary.mockImplementation(() => false);
    expect(await runOp('web.app.requirements', {}, ctx)).toEqual({ php: false, phpVersion: null, phpMysql: null, unzip: false, tar: false, asUser: false });
    expect(parsePhpVersion('PHP 8.3.12 (cli)')).toBe('8.3.12');
    expect(parsePhpVersion('')).toBe(null);
  });
});

describe('the archive guard', () => {
  const home = '/home/alice';
  const dest = '/home/alice/public_html/cms/.keel-unpack-abcd';
  const joomla = [
    { type: 'file', name: 'index.php', target: null }, { type: 'dir', name: 'installation/', target: null }, { type: 'file', name: 'installation/joomla.php', target: null },
    { type: 'dir', name: 'libraries/src/', target: null }, { type: 'file', name: 'libraries/src/Version.php', target: null }, { type: 'dir', name: 'administrator/', target: null }, { type: 'file', name: 'administrator/index.php', target: null },
  ];
  const root = APP_RELEASES.drupal.root;
  const drupal = [
    { type: 'dir', name: `${root}/`, target: null }, { type: 'file', name: `${root}/index.php`, target: null }, { type: 'dir', name: `${root}/core/lib/`, target: null }, { type: 'file', name: `${root}/core/lib/Drupal.php`, target: null },
    { type: 'dir', name: `${root}/sites/default/`, target: null }, { type: 'file', name: `${root}/sites/default/default.settings.php`, target: null }, { type: 'file', name: `${root}/.htaccess`, target: null },
  ];

  it('accepts a flat Joomla package and a rooted Drupal tarball, reporting the top-level entries', () => {
    expect(checkAppMembers('joomla', joomla, { dest, home })).toEqual(['administrator', 'index.php', 'installation', 'libraries']);
    expect(checkAppMembers('drupal', drupal, { dest, home })).toEqual(['.htaccess', 'core', 'index.php', 'sites']);
  });

  it('refuses traversal, absolute names, links, members outside the root, the wrong app and non-releases', () => {
    const refused = (app, members) => { try { checkAppMembers(app, members, { dest, home }); } catch (err) { expect(err).toBeInstanceOf(OpError); return err.code; } return null; };
    expect(refused('joomla', [...joomla, { type: 'file', name: '../../.ssh/authorized_keys', target: null }])).toBe('refused');
    expect(refused('joomla', [...joomla, { type: 'file', name: '/etc/passwd', target: null }])).toBe('refused');
    expect(refused('joomla', [...joomla, { type: 'file', name: 'a//x', target: null }])).toBe('refused');
    expect(refused('joomla', [...joomla, { type: 'symlink', name: 'media/x', target: null }])).toBe('refused');
    expect(refused('drupal', [...drupal, { type: 'symlink', name: `${root}/x`, target: '../../../.ssh' }])).toBe('refused');
    expect(refused('drupal', [...drupal, { type: 'hardlink', name: `${root}/x`, target: `${root}/index.php` }])).toBe('refused');
    expect(refused('drupal', [...drupal, { type: 'file', name: 'evil.php', target: null }])).toBe('refused');
    expect(refused('drupal', [...drupal, { type: 'file', name: 'drupal-9.9.9/index.php', target: null }])).toBe('refused');
    expect(refused('joomla', drupal)).toBe('refused');
    expect(refused('drupal', joomla)).toBe('refused');
    expect(refused('joomla', [{ type: 'file', name: 'index.php', target: null }])).toBe('refused');
    expect(refused('joomla', [])).toBe('refused');
    expect(refused('wordpress', joomla)).toBe('invalid_args');
  });

  it('recognises the archive formats by their magic bytes', () => {
    expect(magicMatches('zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(magicMatches('tar', Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(true);
    expect(magicMatches('zip', Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(false);
    expect(magicMatches('tar', Buffer.from('<htm'))).toBe(false);
    expect(magicMatches('zip', null)).toBe(false);
  });
});

describe('configuration rendering, parsing and the Joomla CLI', () => {
  it('renders settings.php with escaped values, anchored trusted hosts and a private sync directory', () => {
    const text = renderDrupalSettings({ dbName: 'alice_drupal', dbUser: 'alice_drupal', dbPassword: "p'a\\ss#!", dbHost: 'localhost', dbPrefix: '', hashSalt: 'salt-value', syncDir: 'sites/default/files/config_abc/sync', trustedHosts: ['alice.com', 'www.alice.com'] });
    expect(text.startsWith('<?php\n')).toBe(true);
    expect(text).toContain("'database' => 'alice_drupal',");
    expect(text).toContain("'password' => 'p\\'a\\\\ss#!',");
    expect(text).toContain("'driver' => 'mysql',");
    expect(text).toContain("'namespace' => 'Drupal\\\\mysql\\\\Driver\\\\Database\\\\mysql',");
    expect(text).toContain("$settings['hash_salt'] = 'salt-value';");
    expect(text).toContain("$settings['config_sync_directory'] = 'sites/default/files/config_abc/sync';");
    // phpString escapes the backslash of the regex dot, so PHP reads '^alice\.com$' back.
    expect(text).toContain("$settings['trusted_host_patterns'] = ['^alice\\\\.com$', '^www\\\\.alice\\\\.com$'];");
    expect(text).toContain("$settings['update_free_access'] = FALSE;");
    expect(parseDrupalSettings(text)).toEqual({ dbName: 'alice_drupal', dbUser: 'alice_drupal', dbHost: 'localhost', dbPrefix: '' });
    expect(parseDrupalSettings('<?php\n$databases = [];\n')).toEqual({ dbName: null, dbUser: null, dbHost: null, dbPrefix: null });
    expect(randomToken(64)).toHaveLength(64);
    expect(randomToken(64)).not.toBe(randomToken(64));
    expect(randomToken(200)).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('parses Joomla and Drupal version and configuration files', () => {
    expect(parseJoomlaVersion("class Version {\n    public const MAJOR_VERSION = 6;\n    public const MINOR_VERSION = 2;\n    public const PATCH_VERSION = 0;\n    public const EXTRA_VERSION = '';\n}")).toBe('6.2.0');
    expect(parseJoomlaVersion("public const MAJOR_VERSION = 5;\npublic const MINOR_VERSION = 4;\npublic const PATCH_VERSION = 1;\npublic const EXTRA_VERSION = 'rc1';")).toBe('5.4.1-rc1');
    expect(parseJoomlaVersion('nothing')).toBe(null);
    expect(parseJoomlaConfig("<?php\nclass JConfig {\n\tpublic $sitename = 'Alice\\'s site';\n\tpublic $host = 'localhost';\n\tpublic $user = 'alice_joomla';\n\tpublic $password = 'secret';\n\tpublic $db = 'alice_joomla';\n\tpublic $dbprefix = 'j5x2a_';\n}")).toEqual({ dbName: 'alice_joomla', dbUser: 'alice_joomla', dbHost: 'localhost', dbPrefix: 'j5x2a_', sitename: "Alice's site" });
    expect(parseDrupalVersion("final class Drupal {\n  const VERSION = '11.4.11';\n}")).toBe('11.4.11');
    expect(parseDrupalVersion(null)).toBe(null);
  });

  it('builds the Joomla CLI argv without either password and reads the outcome', () => {
    const argv = joomlaInstallArgv({ title: 'Alice writes', adminUser: 'editor', adminEmail: 'a@b.co', dbHost: 'localhost', dbUser: 'alice_joomla', dbName: 'alice_joomla', dbPrefix: 'j5x2a_' });
    expect(argv.slice(0, 2)).toEqual(['installation/joomla.php', 'install']);
    expect(argv).toContain('--site-name=Alice writes');
    expect(argv).toContain('--admin-username=editor');
    expect(argv).toContain('--db-type=mysqli');
    expect(argv).toContain('--db-prefix=j5x2a_');
    expect(argv).toContain('--public-folder=');
    expect(argv.join(' ')).not.toMatch(/password|db-pass/);
    expect(argv.some((a) => a.startsWith('--no-interaction'))).toBe(false);
    expect(joomlaInstallVerdict({ code: 0, stdout: 'Collecting configuration...OK\n [OK] Joomla has been installed\n', stderr: '' })).toEqual({ ok: true, message: null });
    expect(joomlaInstallVerdict({ code: 1, stdout: 'Validating DB connection...', stderr: '[ERROR] Could not connect to MySQL: Access denied for user' })).toMatchObject({ ok: false, message: expect.stringContaining('Access denied') });
    expect(joomlaInstallVerdict({ code: 0, stdout: 'nothing', stderr: '' }).ok).toBe(false);
  });

  it('inspectAppTree tells the apps apart on a planted tree', () => {
    const base = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'keel-app-'));
    try {
      const j = path.join(base, 'j');
      fs.mkdirSync(path.join(j, 'libraries', 'src'), { recursive: true });
      fs.mkdirSync(path.join(j, 'administrator'), { recursive: true });
      fs.mkdirSync(path.join(j, 'installation'), { recursive: true });
      fs.writeFileSync(path.join(j, 'libraries', 'src', 'Version.php'), "<?php\npublic const MAJOR_VERSION = 6;\npublic const MINOR_VERSION = 2;\npublic const PATCH_VERSION = 0;\npublic const EXTRA_VERSION = '';\n");
      expect(inspectAppTree(j)).toMatchObject({ app: 'joomla', version: '6.2.0', dbName: null, configured: false, pendingInstaller: true });
      fs.writeFileSync(path.join(j, 'configuration.php'), "<?php\nclass JConfig {\n\tpublic $db = 'alice_joomla';\n\tpublic $user = 'alice_joomla';\n\tpublic $host = 'localhost';\n\tpublic $dbprefix = 'j5x2a_';\n}\n");
      expect(inspectAppTree(j)).toMatchObject({ app: 'joomla', dbName: 'alice_joomla', dbUser: 'alice_joomla', dbPrefix: 'j5x2a_', configured: true });
      const d = path.join(base, 'd');
      fs.mkdirSync(path.join(d, 'core', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(d, 'sites', 'default'), { recursive: true });
      fs.writeFileSync(path.join(d, 'core', 'lib', 'Drupal.php'), "<?php\nfinal class Drupal {\n  const VERSION = '11.4.11';\n}\n");
      fs.writeFileSync(path.join(d, 'core', 'install.php'), '<?php\n');
      expect(inspectAppTree(d)).toMatchObject({ app: 'drupal', version: '11.4.11', dbName: null, configured: false, pendingInstaller: true });
      fs.writeFileSync(path.join(d, 'sites', 'default', 'settings.php'), renderDrupalSettings({ dbName: 'alice_drupal', dbUser: 'alice_drupal', dbPassword: 'x'.repeat(10), dbHost: 'localhost', dbPrefix: '', hashSalt: 's', syncDir: 'sites/default/files/config_x/sync', trustedHosts: ['alice.com'] }));
      expect(inspectAppTree(d)).toMatchObject({ app: 'drupal', dbName: 'alice_drupal', dbUser: 'alice_drupal', dbHost: 'localhost', configured: true });
      expect(inspectAppTree(base)).toBe(null);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
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
  const probe = info ? path.join(info.home, 'public_html', 'probe-app-install-test') : null;

  function plantJoomla(dir) {
    fs.mkdirSync(path.join(dir, 'libraries', 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'administrator'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'installation'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'installation', 'joomla.php'), '<?php\n');
    fs.writeFileSync(path.join(dir, 'libraries', 'src', 'Version.php'), "<?php\npublic const MAJOR_VERSION = 6;\npublic const MINOR_VERSION = 2;\npublic const PATCH_VERSION = 0;\npublic const EXTRA_VERSION = '';\n");
    fs.writeFileSync(path.join(dir, 'index.php'), '<?php\n');
  }

  run('fetch refuses an occupied tree, joomla.install feeds the passwords on stdin, remove pins the path', async () => {
    fs.rmSync(probe, { recursive: true, force: true });
    plantJoomla(probe);
    try {
      const calls = [];
      exec.mockImplementation(async (bin, argv, opts) => { calls.push([bin, argv, opts]); return { code: 0, stdout: ' [OK] Joomla has been installed\n', stderr: '', bin, argv }; });
      globalThis.fetch = vi.fn(() => { throw new Error('fetch must not be called'); });
      expect((await opError(runOp('web.app.fetch', { username: account, path: probe, app: 'joomla' }, ctx))).code).toBe('exists');
      expect((await opError(runOp('web.app.fetch', { username: account, path: probe, app: 'drupal' }, ctx))).code).toBe('exists');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // The mocked php writes no configuration.php, so the op reports that; the
      // argv it recorded carries no password and stdin does.
      const err = await opError(runOp('web.app.joomla.install', { username: account, path: probe, url: 'http://x.example/cms', title: 'T', adminUser: 'editor', adminEmail: 'a@b.co', adminPassword: 'Adm1n-Passw0rd!!', dbName: `${account}_joomla`, dbUser: `${account}_joomla`, dbPassword: 'Str0ng-Passw0rd!', dbPrefix: 'j5x2a_' }, ctx));
      expect(err.code).toBe('command_failed');
      expect(err.message).toContain('configuration.php');
      const php = calls.find(([, argv]) => argv.some((a) => a === 'php' || a.endsWith('/php')));
      expect(php).toBeTruthy();
      expect(php[1].join(' ')).not.toContain('Adm1n-Passw0rd!!');
      expect(php[1].join(' ')).not.toContain('Str0ng-Passw0rd!');
      expect(php[2].input).toBe('Adm1n-Passw0rd!!\nStr0ng-Passw0rd!\n');
      expect(php[2].env.SHELL_INTERACTIVE).toBe('1');
      expect(new Set(calls.map(([bin]) => bin)).size).toBeGreaterThan(0);
      expect(calls.every(([bin]) => ['setpriv', 'runuser', 'nice'].includes(bin))).toBe(true);
      calls.length = 0;
      const entries = await runOp('web.app.remove', { username: account, path: probe, app: 'joomla', mode: 'entries' }, ctx);
      expect(entries.removed.sort()).toEqual(['administrator', 'index.php', 'installation', 'libraries'].map((n) => path.relative(info.home, path.join(probe, n))).sort());
      const rm = calls.find(([, argv]) => argv.some((a) => a === 'rm' || a.endsWith('/rm')));
      const at = rm[1].findIndex((a) => a === 'rm' || a.endsWith('/rm'));
      expect(rm[1].slice(at + 1, at + 4)).toEqual(['-rf', '--one-file-system', '--']);
      expect((await opError(runOp('web.app.remove', { username: account, path: probe, app: 'drupal', mode: 'tree' }, ctx))).code).toBe('not_found');
      expect((await opError(runOp('web.app.remove', { username: account, path: info.home, app: 'joomla', mode: 'tree' }, ctx))).code).toBe('refused');
      expect((await opError(runOp('web.app.remove', { username: account, path: `${info.home}/../${path.basename(info.home)}2`, app: 'joomla', mode: 'tree' }, ctx))).code).toMatch(/invalid_args|path_not_allowed/);
      const found = await runOp('web.app.discover', { usernames: [account] }, ctx);
      expect(found.installs.some((i) => i.path === probe && i.app === 'joomla')).toBe(true);
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });
});
