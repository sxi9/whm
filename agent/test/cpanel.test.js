import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { parseListLists, detectMailman, findReleaseRoot, isReleaseDir, listName, listPassword } from '../src/ops/cpanel.js';

// exec() is spied with the real implementation behind it so tests can prove an
// op refused *before* running anything, and stub the one call (systemd-run)
// that must never happen on the test box.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();
const TMP_ROOT = '/tmp/whm';
let root;
let tmpRootExisted;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

function makeRelease(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'whm', version: '9.9.9' }));
  fs.writeFileSync(path.join(dir, 'scripts', 'install.sh'), '#!/usr/bin/env bash\necho upgrade\n');
}

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  root = `${TMP_ROOT}/cpanel-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(root, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('mailman helpers', () => {
  it('parses list_lists output in both verbose and bare forms', () => {
    const verbose = '2 matching mailing lists found:\n    Announce - Company announcements\n       Dev - [no description available]\n';
    expect(parseListLists(verbose)).toEqual([{ name: 'announce', description: 'Company announcements' }, { name: 'dev', description: '' }]);
    expect(parseListLists('announce\ndev\n')).toEqual([{ name: 'announce', description: '' }, { name: 'dev', description: '' }]);
    expect(parseListLists('No matching mailing lists found\n')).toEqual([]);
    expect(parseListLists('rm -rf / - evil\n')).toEqual([]);
  });

  it('validates list names and passwords the way change_pw needs them', () => {
    for (const bad of ['a;b', '../x', '-l', 'List With Space', 'x'.repeat(65), '']) expect(listName.safeParse(bad).success, bad).toBe(false);
    expect(listName.safeParse('announce-2026.dev_x').success).toBe(true);
    for (const bad of ['-rf', 'short', 'has\nnewline-ok', 'tab\tinside-pw', ' leading-space']) expect(listPassword.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(listPassword.safeParse('Str0ng-list-pass!').success).toBe(true);
  });

  it('refuses Mailman ops before any program runs when Mailman is absent', async () => {
    const detected = detectMailman();
    if (detected.installed) return; // a real Mailman on the test box: the remaining assertions would run its tools
    expect(await runOp('cpanel.mailman.detect', {}, ctx)).toMatchObject({ installed: false, flavor: null });
    exec.mockClear();
    const err = await opError(runOp('cpanel.mailman.lists', {}, ctx));
    expect(err.code).toBe('capability_missing');
    const err2 = await opError(runOp('cpanel.mailman.change_pw', { list: 'announce', password: 'Str0ng-list-pass' }, ctx));
    expect(err2.code).toBe('capability_missing');
    const err3 = await opError(runOp('cpanel.mailman.site_password', { password: 'Str0ng-list-pass' }, ctx));
    expect(err3.code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects injection-shaped arguments at the schema', async () => {
    exec.mockClear();
    for (const args of [{ list: 'a;b', password: 'Str0ng-list-pass' }, { list: 'announce', password: '-rf' }, { list: 'announce', password: 'Str0ng-list-pass', extra: 1 }, { list: '../etc', password: 'Str0ng-list-pass' }, {}]) {
      const err = await opError(runOp('cpanel.mailman.change_pw', args, ctx));
      expect(err.code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('cpanel.mailman.site_password', { password: '--creator' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('upgrade ops', () => {
  it('rejects unknown ops and bad paths before touching the filesystem', async () => {
    exec.mockClear();
    expect((await opError(runOp('cpanel.upgrade.nope', {}, ctx))).code).toBe('unknown_op');
    for (const args of [{ archive: '/tmp/whm/x.zip', destDir: `${root}/d` }, { archive: '/tmp/whm/../x.tar.gz', destDir: `${root}/d` }, { archive: 'relative.tar.gz', destDir: `${root}/d` }, { archive: `${root}/x.tar.gz` }]) {
      expect((await opError(runOp('cpanel.upgrade.extract', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: '/etc/whm-release.tar.gz', destDir: `${root}/d` }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: `${root}/missing.tar.gz`, destDir: '/usr/local/whm-dest' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: `${root}/missing.tar.gz`, destDir: `${root}/d` }, ctx))).code).toBe('not_found');
    for (const args of [{ sourceDir: `${root}/src`, logFile: `${root}/u.log`, unit: 'whm-upgrade-1; rm' }, { sourceDir: `${root}/src`, logFile: `${root}/u.log`, unit: 'evil' }, { sourceDir: `${root}/src`, logFile: `${root}/u.log`, unit: 'whm-upgrade-1', appDir: '../x' }]) {
      expect((await opError(runOp('cpanel.upgrade.run', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('cpanel.upgrade.run', { sourceDir: '/opt/elsewhere', logFile: `${root}/u.log`, unit: 'whm-upgrade-1' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('cpanel.upgrade.run', { sourceDir: root, logFile: '/var/log/other/u.log', unit: 'whm-upgrade-1' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('cpanel.upgrade.run', { sourceDir: root, logFile: `${root}/u.log`, unit: 'whm-upgrade-1' }, ctx))).code).toBe('invalid_package');
    expect(exec).not.toHaveBeenCalled();
  });

  it('unpacks a wrapped or flat release archive and refuses anything else', async () => {
    const src = path.join(root, 'whm-9.9.9');
    makeRelease(src);
    expect(isReleaseDir(src)).toBe(true);
    const wrapped = path.join(root, 'wrapped.tar.gz');
    execFileSync('tar', ['-czf', wrapped, '-C', root, 'whm-9.9.9']);
    const res = await runOp('cpanel.upgrade.extract', { archive: wrapped, destDir: path.join(root, 'out-wrapped') }, ctx);
    expect(res).toEqual({ sourceDir: path.join(root, 'out-wrapped', 'whm-9.9.9'), version: '9.9.9', name: 'whm' });
    expect(fs.existsSync(path.join(res.sourceDir, 'scripts', 'install.sh'))).toBe(true);
    const tarCall = exec.mock.calls.find((c) => c[0] === 'tar');
    expect(tarCall[1]).toEqual(['--no-same-owner', '-xzf', wrapped, '-C', path.join(root, 'out-wrapped')]);

    const flat = path.join(root, 'flat.tgz');
    execFileSync('tar', ['-czf', flat, '-C', src, '.']);
    const flatRes = await runOp('cpanel.upgrade.extract', { archive: flat, destDir: path.join(root, 'out-flat') }, ctx);
    expect(flatRes.sourceDir).toBe(path.join(root, 'out-flat'));
    expect(findReleaseRoot(path.join(root, 'out-flat'))).toBe(path.join(root, 'out-flat'));

    const junkDir = path.join(root, 'junk');
    fs.mkdirSync(junkDir, { recursive: true });
    fs.writeFileSync(path.join(junkDir, 'README'), 'not a release');
    const junk = path.join(root, 'junk.tar.gz');
    execFileSync('tar', ['-czf', junk, '-C', root, 'junk']);
    const err = await opError(runOp('cpanel.upgrade.extract', { archive: junk, destDir: path.join(root, 'out-junk') }, ctx));
    expect(err.code).toBe('invalid_package');
    expect(fs.existsSync(path.join(root, 'out-junk'))).toBe(false);
  });

  it('launches the installer through systemd-run with a fixed argv and never a shell', async () => {
    const src = path.join(root, 'whm-9.9.9');
    const logFile = path.join(root, 'upgrade.log');
    exec.mockClear();
    exec.mockImplementationOnce(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv }));
    const res = await runOp('cpanel.upgrade.run', { sourceDir: src, logFile, unit: 'whm-upgrade-20261026120000', appDir: `${root}/app`, skipNode: true }, ctx);
    expect(res).toMatchObject({ unit: 'whm-upgrade-20261026120000.service', logFile, detached: true, sourceDir: src });
    expect(exec).toHaveBeenCalledTimes(1);
    const [bin, argv] = exec.mock.calls[0];
    expect(bin).toBe('systemd-run');
    expect(argv.slice(0, 4)).toEqual(['--unit', 'whm-upgrade-20261026120000', '--collect', '--quiet']);
    expect(argv).toContain(`--property=StandardOutput=append:${logFile}`);
    expect(argv).toContain(`--setenv=WHM_APP_DIR=${root}/app`);
    expect(argv[argv.length - 3]).toBe(path.join(src, 'scripts', 'install.sh'));
    expect(argv.slice(-2)).toEqual(['--upgrade', '--skip-node']);
    expect(argv.every((a) => typeof a === 'string' && !/[;&|`$]/.test(a))).toBe(true);
    expect(fs.readFileSync(logFile, 'utf8')).toMatch(/^# whm upgrade started/);
  });
});
