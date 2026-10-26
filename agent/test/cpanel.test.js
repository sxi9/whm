import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { parseListLists, detectMailman, findReleaseRoot, isReleaseDir, listName, listPassword, execRedacted, verifyStagedRelease, AGENT_APP_DIR } from '../src/ops/cpanel.js';

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
let staging;
let keys;
let tmpRootExisted;
const PASSWORD = 'Str0ng-list-pass';

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

function makeRelease(dir, version = '9.9.9') {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'whm', version }));
  fs.writeFileSync(path.join(dir, 'scripts', 'install.sh'), '#!/usr/bin/env bash\necho upgrade\n', { mode: 0o777 });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest();

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  root = `${TMP_ROOT}/cpanel-${crypto.randomBytes(6).toString('hex')}`;
  staging = path.join(root, 'staging');
  keys = path.join(root, 'keys');
  fs.mkdirSync(root, { recursive: true });
  process.env.WHM_UPGRADE_STAGING_ROOT = staging;
  process.env.WHM_RELEASE_KEY_DIR = keys;
  delete process.env.WHM_RELEASE_KEYS_READONLY;
});

afterAll(() => {
  delete process.env.WHM_UPGRADE_STAGING_ROOT;
  delete process.env.WHM_RELEASE_KEY_DIR;
  delete process.env.WHM_RELEASE_KEYS_READONLY;
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('mailman helpers', () => {
  it('parses list_lists output in verbose, bare and Mailman 3 fully-qualified forms', () => {
    const verbose = '2 matching mailing lists found:\n    Announce - Company announcements\n       Dev - [no description available]\n';
    expect(parseListLists(verbose)).toEqual([{ name: 'announce', description: 'Company announcements' }, { name: 'dev', description: '' }]);
    expect(parseListLists('announce\ndev\n')).toEqual([{ name: 'announce', description: '' }, { name: 'dev', description: '' }]);
    expect(parseListLists('announce@example.com\nDev@Lists.Example.org\n')).toEqual([{ name: 'announce@example.com', description: '' }, { name: 'dev@lists.example.org', description: '' }]);
    expect(parseListLists('2 matching mailing lists found:\nannounce@example.com\n')).toEqual([{ name: 'announce@example.com', description: '' }]);
    expect(parseListLists('No matching mailing lists found\n')).toEqual([]);
    expect(parseListLists('rm -rf / - evil\n')).toEqual([]);
    expect(parseListLists('a@b@c\n$(id)@x.org\n')).toEqual([]);
  });

  it('lists every list, not only advertised ones, and checks existence with -b', () => {
    const src = fs.readFileSync(new URL('../src/ops/cpanel.js', import.meta.url), 'utf8');
    expect(src).toMatch(/exec\(mm\.bins\.list_lists, \[\]\)/);
    expect(src).not.toMatch(/list_lists, \['-a'\]/);
    expect(src).toMatch(/exec\(mm\.bins\.list_lists, \['-b'\]\)/);
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
    const err2 = await opError(runOp('cpanel.mailman.change_pw', { list: 'announce', password: PASSWORD }, ctx));
    expect(err2.code).toBe('capability_missing');
    const err3 = await opError(runOp('cpanel.mailman.site_password', { password: PASSWORD }, ctx));
    expect(err3.code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects injection-shaped arguments at the schema', async () => {
    exec.mockClear();
    for (const args of [{ list: 'a;b', password: PASSWORD }, { list: 'announce', password: '-rf' }, { list: 'announce', password: PASSWORD, extra: 1 }, { list: '../etc', password: PASSWORD }, {}]) {
      const err = await opError(runOp('cpanel.mailman.change_pw', args, ctx));
      expect(err.code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('cpanel.mailman.site_password', { password: '--creator' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('never leaks the password argv or stderr when a password tool fails', async () => {
    // `sh -c` is only used here to fabricate a failing program that echoes its argv.
    const err = await opError(execRedacted('sh', ['-c', 'echo "bad password: $1" >&2; exit 3', 'sh', PASSWORD]));
    expect(err.code).toBe('command_failed');
    expect(err.message).toBe('"sh" exited with status 3');
    expect(err.details).toEqual({ bin: 'sh', code: 3 });
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(PASSWORD);
    const missing = await opError(execRedacted('/nonexistent/change_pw', ['--password', PASSWORD]));
    expect(missing.code).toBe('binary_not_found');
    expect(JSON.stringify({ message: missing.message, details: missing.details })).not.toContain(PASSWORD);
  });
});

describe('release keys', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });

  it('installs, lists and removes Ed25519 keys in the agent-owned directory only', async () => {
    expect(await runOp('cpanel.upgrade.keys', {}, ctx)).toEqual({ dir: keys, readOnly: false, keys: [] });
    const added = await runOp('cpanel.upgrade.key_add', { kid: 'release-2026', pem }, ctx);
    expect(added).toMatchObject({ kid: 'release-2026', type: 'ed25519', valid: true });
    expect(added.pem).toContain('BEGIN PUBLIC KEY');
    expect(fs.statSync(path.join(keys, 'release-2026.pub')).mode & 0o777).toBe(0o644);
    expect((await opError(runOp('cpanel.upgrade.key_add', { kid: 'release-2026', pem }, ctx))).code).toBe('exists');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect((await opError(runOp('cpanel.upgrade.key_add', { kid: 'rsa', pem: rsa }, ctx))).code).toBe('invalid_key');
    expect((await opError(runOp('cpanel.upgrade.key_add', { kid: 'bad', pem: '-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----' }, ctx))).code).toBe('invalid_key');
    for (const args of [{ kid: '../etc', pem }, { kid: 'a b', pem }, { kid: 'x', pem: 'not a pem' }, { kid: 'x', pem, extra: 1 }]) {
      expect((await opError(runOp('cpanel.upgrade.key_add', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await runOp('cpanel.upgrade.keys', {}, ctx)).keys.map((k) => k.kid)).toEqual(['release-2026']);
    expect((await opError(runOp('cpanel.upgrade.key_remove', { kid: 'nope' }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('cpanel.upgrade.key_remove', { kid: '../release-2026' }, ctx))).code).toBe('invalid_args');
    expect(await runOp('cpanel.upgrade.key_remove', { kid: 'release-2026' }, ctx)).toEqual({ kid: 'release-2026', removed: true });
    expect(catalog.get('cpanel.upgrade.key_remove').destructive).toBe(true);
  });

  it('refuses changes when keys are managed on the host', async () => {
    process.env.WHM_RELEASE_KEYS_READONLY = '1';
    try {
      expect((await runOp('cpanel.upgrade.keys', {}, ctx)).readOnly).toBe(true);
      expect((await opError(runOp('cpanel.upgrade.key_add', { kid: 'k', pem }, ctx))).code).toBe('refused');
      expect((await opError(runOp('cpanel.upgrade.key_remove', { kid: 'k' }, ctx))).code).toBe('refused');
    } finally { delete process.env.WHM_RELEASE_KEYS_READONLY; }
  });
});

describe('upgrade ops', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  let wrapped;
  let flat;
  let digest;

  beforeAll(() => {
    const src = path.join(root, 'whm-9.9.9');
    makeRelease(src);
    wrapped = path.join(root, 'wrapped.tar.gz');
    execFileSync('tar', ['-czf', wrapped, '-C', root, 'whm-9.9.9']);
    flat = path.join(root, 'flat.tgz');
    execFileSync('tar', ['-czf', flat, '-C', src, '.']);
    digest = sha256(wrapped);
  });

  it('takes no directory, log or key material from the caller', async () => {
    exec.mockClear();
    expect((await opError(runOp('cpanel.upgrade.nope', {}, ctx))).code).toBe('unknown_op');
    for (const args of [
      { archive: '/tmp/whm/x.zip', version: '9.9.9' }, { archive: '/tmp/whm/../x.tar.gz', version: '9.9.9' }, { archive: 'relative.tar.gz', version: '9.9.9' },
      { archive: `${root}/x.tar.gz` }, { archive: `${root}/x.tar.gz`, version: '../9' }, { archive: `${root}/x.tar.gz`, version: '9.9.9; rm -rf /' }, { archive: `${root}/x.tar.gz`, version: '9.9.9', destDir: '/home' },
      { archive: `${root}/x.tar.gz`, version: '9.9.9', sha256: 'nothex' }, { archive: `${root}/x.tar.gz`, version: '9.9.9', signature: 'short' }, { archive: `${root}/x.tar.gz`, version: '9.9.9', keyId: '../k' },
    ]) {
      expect((await opError(runOp('cpanel.upgrade.extract', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: '/etc/whm-release.tar.gz', version: '9.9.9' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: `${root}/missing.tar.gz`, version: '9.9.9' }, ctx))).code).toBe('not_found');
    for (const args of [
      { version: '9.9.9', unit: 'whm-upgrade-1; rm' }, { version: '9.9.9', unit: 'evil' }, { version: '9.9.9', unit: 'whm-upgrade-1', appDir: `${root}/app` },
      { version: '9.9.9', unit: 'whm-upgrade-1', sourceDir: root }, { version: '9.9.9', unit: 'whm-upgrade-1', logFile: '/etc/ssh/sshd_config.d/x.log' }, { unit: 'whm-upgrade-1' },
    ]) {
      expect((await opError(runOp('cpanel.upgrade.run', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(['not_found', 'invalid_package']).toContain((await opError(runOp('cpanel.upgrade.run', { version: '1.0.0', unit: 'whm-upgrade-1' }, ctx))).code);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses an archive whose checksum does not match, before unpacking anything', async () => {
    exec.mockClear();
    const err = await opError(runOp('cpanel.upgrade.extract', { archive: wrapped, version: '9.9.9', sha256: 'b'.repeat(64) }, ctx));
    expect(err.code).toBe('checksum_mismatch');
    expect(err.details.sha256).toBe(digest.toString('hex'));
    expect(exec).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(staging, 'src-9.9.9'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'whm-9.9.9.tar.gz'))).toBe(false);
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: wrapped, version: '9.9.9' }, ctx))).code).toBe('unverified');
    expect(exec).not.toHaveBeenCalled();
  });

  it('always refuses a signature that does not verify, even when unverified upgrades are allowed', async () => {
    await runOp('cpanel.upgrade.key_add', { kid: 'release-2026', pem }, ctx);
    exec.mockClear();
    const forged = crypto.sign(null, digest, crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
    for (const allowUnverified of [false, true]) {
      const err = await opError(runOp('cpanel.upgrade.extract', { archive: wrapped, version: '9.9.9', sha256: digest.toString('hex'), signature: forged, keyId: 'release-2026', allowUnverified }, ctx));
      expect(err.code, String(allowUnverified)).toBe('invalid_signature');
    }
    const unknownKid = crypto.sign(null, digest, privateKey).toString('base64');
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: wrapped, version: '9.9.9', sha256: digest.toString('hex'), signature: unknownKid, keyId: 'other-key', allowUnverified: true }, ctx))).code).toBe('invalid_signature');
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: wrapped, version: '9.9.9', sha256: digest.toString('hex') }, ctx))).code).toBe('unsigned');
    expect(exec).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(staging, 'src-9.9.9'))).toBe(false);
  });

  it('copies, verifies and unpacks a release into the agent-owned staging area', async () => {
    const signature = crypto.sign(null, digest, privateKey).toString('base64');
    exec.mockClear();
    const res = await runOp('cpanel.upgrade.extract', { archive: wrapped, version: '9.9.9', sha256: digest.toString('hex'), signature, keyId: 'release-2026' }, ctx);
    const stageDir = path.join(staging, 'src-9.9.9');
    expect(res).toMatchObject({ version: '9.9.9', stageDir, sourceDir: path.join(stageDir, 'whm-9.9.9'), sha256: digest.toString('hex'), signer: 'release-2026', signatureState: 'verified', name: 'whm', packageVersion: '9.9.9', warnings: [] });
    expect(isReleaseDir(res.sourceDir)).toBe(true);
    const tarCall = exec.mock.calls.find((c) => c[0] === 'tar');
    expect(tarCall[1]).toEqual(['--no-same-owner', '--no-same-permissions', '-xzf', path.join(staging, 'whm-9.9.9.tar.gz'), '-C', stageDir]);
    expect(exec.mock.calls.find((c) => c[0] === 'chmod')[1]).toEqual(['-R', 'go-w', stageDir]);
    expect(fs.statSync(path.join(res.sourceDir, 'scripts', 'install.sh')).mode & 0o022).toBe(0);
    expect(fs.existsSync(path.join(staging, 'whm-9.9.9.tar.gz'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(staging, 'src-9.9.9.json'), 'utf8'))).toMatchObject({ stageDir, sourceDir: res.sourceDir, signer: 'release-2026' });
    expect(fs.statSync(staging).mode & 0o777).toBe(0o755);
    expect(catalog.get('cpanel.upgrade.extract').destructive).toBe(true);

    // Re-running replaces the directory it created itself.
    const again = await runOp('cpanel.upgrade.extract', { archive: wrapped, version: '9.9.9', sha256: digest.toString('hex'), signature, keyId: 'release-2026' }, ctx);
    expect(again.sourceDir).toBe(res.sourceDir);

    // Signed release, no key installed: only with allowUnverified, and recorded as such.
    await runOp('cpanel.upgrade.key_remove', { kid: 'release-2026' }, ctx);
    const flatDigest = sha256(flat);
    expect((await opError(runOp('cpanel.upgrade.extract', { archive: flat, version: '9.9.8', sha256: flatDigest.toString('hex'), signature }, ctx))).code).toBe('unverified');
    const flatRes = await runOp('cpanel.upgrade.extract', { archive: flat, version: '9.9.8', sha256: flatDigest.toString('hex'), signature, allowUnverified: true }, ctx);
    expect(flatRes).toMatchObject({ sourceDir: path.join(staging, 'src-9.9.8'), signer: null, signatureState: 'no_trusted_key' });
    expect(flatRes.warnings).toHaveLength(1);
    expect(findReleaseRoot(path.join(staging, 'src-9.9.8'))).toBe(path.join(staging, 'src-9.9.8'));
    await runOp('cpanel.upgrade.key_add', { kid: 'release-2026', pem }, ctx);
  });

  it('refuses to wipe a directory it did not create and rejects non-release archives', async () => {
    const foreign = path.join(staging, 'src-1.2.3');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'precious'), 'keep me');
    const err = await opError(runOp('cpanel.upgrade.extract', { archive: wrapped, version: '1.2.3', sha256: digest.toString('hex'), allowUnverified: true }, ctx));
    expect(err.code).toBe('exists');
    expect(fs.readFileSync(path.join(foreign, 'precious'), 'utf8')).toBe('keep me');
    fs.rmSync(foreign, { recursive: true, force: true });

    const junkDir = path.join(root, 'junk');
    fs.mkdirSync(junkDir, { recursive: true });
    fs.writeFileSync(path.join(junkDir, 'README'), 'not a release');
    const junk = path.join(root, 'junk.tar.gz');
    execFileSync('tar', ['-czf', junk, '-C', root, 'junk']);
    const bad = await opError(runOp('cpanel.upgrade.extract', { archive: junk, version: '1.2.4', sha256: sha256(junk).toString('hex'), allowUnverified: true }, ctx));
    expect(bad.code).toBe('invalid_package');
    expect(fs.existsSync(path.join(staging, 'src-1.2.4'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'src-1.2.4.json'))).toBe(false);
  });

  it('launches the installer only from a verified staging directory, through systemd-run, without --collect', async () => {
    exec.mockClear();
    exec.mockImplementationOnce(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv }));
    const res = await runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-20261026120000', skipNode: true }, ctx);
    const logFile = path.join(staging, 'whm-upgrade-20261026120000.log');
    const sourceDir = path.join(staging, 'src-9.9.9', 'whm-9.9.9');
    expect(res).toMatchObject({ unit: 'whm-upgrade-20261026120000.service', logFile, detached: true, sourceDir, appDir: AGENT_APP_DIR });
    expect(exec).toHaveBeenCalledTimes(1);
    const [bin, argv] = exec.mock.calls[0];
    expect(bin).toBe('systemd-run');
    expect(argv.slice(0, 3)).toEqual(['--unit', 'whm-upgrade-20261026120000', '--quiet']);
    expect(argv).not.toContain('--collect');
    expect(argv).toContain(`--property=StandardOutput=append:${logFile}`);
    expect(argv).toContain(`--property=StandardError=append:${logFile}`);
    expect(argv.some((a) => a.startsWith('--setenv=WHM_APP_DIR=') && !a.endsWith(`=${AGENT_APP_DIR}`))).toBe(false);
    expect(argv[argv.length - 3]).toBe(path.join(sourceDir, 'scripts', 'install.sh'));
    expect(argv.slice(-2)).toEqual(['--upgrade', '--skip-node']);
    expect(argv.every((a) => typeof a === 'string' && !/[;&|`$]/.test(a))).toBe(true);
    expect(fs.readFileSync(logFile, 'utf8')).toMatch(/^# whm upgrade started .* \(sha256 [0-9a-f]{64}, signer release-2026\)/);
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o644);
    // The same unit cannot be started twice (its log would be reused).
    exec.mockClear();
    expect((await opError(runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-20261026120000' }, ctx))).code).toBe('exists');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a staging directory that was tampered with or loosened', async () => {
    exec.mockClear();
    const stageDir = path.join(staging, 'src-9.9.9');
    const marker = path.join(staging, 'src-9.9.9.json');
    expect(verifyStagedRelease('9.9.9').sourceDir).toBe(path.join(stageDir, 'whm-9.9.9'));
    fs.chmodSync(stageDir, 0o775);
    expect((await opError(runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-a' }, ctx))).code).toBe('refused');
    fs.chmodSync(stageDir, 0o755);
    fs.chmodSync(path.join(stageDir, 'whm-9.9.9', 'scripts', 'install.sh'), 0o666);
    expect((await opError(runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-b' }, ctx))).code).toBe('refused');
    fs.chmodSync(path.join(stageDir, 'whm-9.9.9', 'scripts', 'install.sh'), 0o755);
    const saved = fs.readFileSync(marker, 'utf8');
    fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(saved), sourceDir: root }));
    expect((await opError(runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-c' }, ctx))).code).toBe('invalid_package');
    fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(saved), stageDir: '/home' }));
    expect((await opError(runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-d' }, ctx))).code).toBe('invalid_package');
    fs.unlinkSync(marker);
    expect((await opError(runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-e' }, ctx))).code).toBe('not_found');
    fs.writeFileSync(marker, saved);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.symlinkSync(root, stageDir);
    expect((await opError(runOp('cpanel.upgrade.run', { version: '9.9.9', unit: 'whm-upgrade-f' }, ctx))).code).toBe('refused');
    fs.unlinkSync(stageDir);
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports a unit status with its exit code and only resets failed units', async () => {
    expect((await opError(runOp('cpanel.upgrade.unit_status', { unit: 'evil' }, ctx))).code).toBe('invalid_args');
    exec.mockClear();
    exec.mockImplementationOnce(async () => ({ code: 0, stdout: 'LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainStatus=1\nExecMainCode=exited\n', stderr: '' }));
    exec.mockImplementationOnce(async () => ({ code: 0, stdout: '', stderr: '' }));
    const failed = await runOp('cpanel.upgrade.unit_status', { unit: 'whm-upgrade-x', resetFailed: true }, ctx);
    expect(failed).toEqual({ unit: 'whm-upgrade-x', installed: true, state: 'failed', subState: 'failed', result: 'exit-code', exitStatus: 1, exitCode: 'exited', reset: true });
    expect(exec.mock.calls[1][1]).toEqual(['reset-failed', 'whm-upgrade-x.service']);
    exec.mockClear();
    exec.mockImplementationOnce(async () => ({ code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\n', stderr: '' }));
    const gone = await runOp('cpanel.upgrade.unit_status', { unit: 'whm-upgrade-x', resetFailed: true }, ctx);
    expect(gone).toMatchObject({ installed: false, state: 'gone', result: null, exitStatus: null });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
