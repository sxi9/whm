import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { rcloneObscure, renderRcloneConf, rcloneTarget, readTokenUpdate, parseLsjson, scrubSecrets, needsRclone, destinationConfig, parseRcloneVersion, resetRcloneVersion } from '../src/ops/backup.js';

// exec is spied with the real implementation behind it; every rclone call is
// answered by a fake that records argv and reads the rendered config file at
// the moment rclone would, so the tests can prove what reached the binary and
// that nothing of it survives the call.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary, ExecError } = await import('../src/exec.js');

const ctx = createContext();
const GDRIVE = { kind: 'gdrive', clientId: '123.apps.googleusercontent.com', clientSecret: 'GOCSPX-clientsecretvalue', refreshToken: '1//refresh-token-value-abc', folder: 'whm-backups', crypt: true, cryptPassword: 'cryptpassword-plain-value', cryptPassword2: 'cryptsalt-plain-value' };
const S3 = { kind: 's3', bucket: 'whm-backups', region: 'eu-west-1', accessKey: 'AKIA', secretKey: 'topsecretkey', prefix: 'panel/' };
const SFTP = { kind: 'sftp', host: 'sftp.example.com', port: 22, username: 'u', password: 'sftp-password', path: '/srv/backups', insecure: true, crypt: true, cryptPassword: 'pw', cryptPassword2: 'salt' };
const AZURE_SAS = { kind: 'azureblob', account: 'acct', container: 'backups', sasToken: 'sv=2024&sig=supersecretsignature' };
const NAME = 'backup-10.26.2026_02-00-00_alice.tar.gz';

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

fs.mkdirSync('/tmp/whm', { recursive: true, mode: 0o700 });
const dir = fs.mkdtempSync('/tmp/whm/test-rclone-');
const ARCHIVE = path.join(dir, 'backup-10.26.2026_02-00-00_alice.tar.gz');
fs.writeFileSync(ARCHIVE, 'archive-bytes');
const rcloneDirs = () => fs.readdirSync('/tmp/whm').filter((n) => n.startsWith('backup-rclone-'));

// Answers every rclone invocation: captures argv, the config file contents and
// the env, and lets a test shape stdout/stderr/exit code per subcommand.
function fakeRclone(answer = () => ({ code: 0, stdout: '' })) {
  const calls = [];
  hasBinary.mockImplementation((name) => name === 'rclone');
  exec.mockImplementation(async (bin, argv, opts = {}) => {
    if (bin !== 'rclone') throw new Error(`unexpected program ${bin} ${argv.join(' ')}`);
    const confIndex = argv.indexOf('--config');
    const conf = confIndex >= 0 ? fs.readFileSync(argv[confIndex + 1], 'utf8') : null;
    const sub = argv.find((a, i) => i > 0 && !a.startsWith('-') && argv[i - 1] !== '--config' && argv[i - 1] !== '--cache-dir' && !/^(--contimeout|--timeout|--retries|--retries-sleep|--low-level-retries|--stats|--log-level)$/.test(argv[i - 1]));
    const call = { argv, conf, confPath: confIndex >= 0 ? argv[confIndex + 1] : null, env: opts.env, sub, timeoutMs: opts.timeoutMs };
    calls.push(call);
    const r = await answer(call);
    return { code: 0, stdout: '', stderr: '', bin, argv, ...r };
  });
  return calls;
}

describe('rclone op catalog', () => {
  it('registers the family and flags the destructive op', () => {
    for (const name of ['backup.rclone.test', 'backup.rclone.upload', 'backup.rclone.download', 'backup.rclone.list', 'backup.rclone.delete']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('backup.rclone.delete').destructive).toBe(true);
    for (const name of ['backup.rclone.test', 'backup.rclone.upload', 'backup.rclone.download', 'backup.rclone.list']) expect(catalog.get(name).destructive, name).toBe(false);
  });

  it('knows which configurations are served by rclone', () => {
    expect(needsRclone({ kind: 'gdrive' })).toBe(true);
    expect(needsRclone({ kind: 'b2' })).toBe(true);
    expect(needsRclone({ kind: 's3' })).toBe(false);
    expect(needsRclone({ kind: 's3', crypt: true })).toBe(true);
    expect(needsRclone({ kind: 'local', crypt: false })).toBe(false);
  });
});

describe('rclone obscure and config rendering', () => {
  it('obscures passwords exactly like rclone (its own test vectors)', () => {
    expect(rcloneObscure('', Buffer.from('aaaaaaaaaaaaaaaa'))).toBe('YWFhYWFhYWFhYWFhYWFhYQ');
    expect(rcloneObscure('potato', Buffer.from('aaaaaaaaaaaaaaaa'))).toBe('YWFhYWFhYWFhYWFhYWFhYXMaGgIlEQ');
    expect(rcloneObscure('potato', Buffer.from('bbbbbbbbbbbbbbbb'))).toBe('YmJiYmJiYmJiYmJiYmJiYp3gcEWbAw');
    expect(rcloneObscure('potato')).not.toBe(rcloneObscure('potato'));
  });

  it('wraps the backend in a crypt remote with obscured password and salt, never the plaintext', () => {
    const conf = renderRcloneConf(GDRIVE, { section: { type: 'drive', token: '{"refresh_token":"x"}' }, root: 'whm-backups', flags: [] });
    expect(conf.root).toBe('');
    expect(conf.text).toMatch(/^\[whmbase\]\ntype = drive\ntoken = \{"refresh_token":"x"\}\n\n\[whm\]\ntype = crypt\nremote = whmbase:whm-backups\nfilename_encryption = standard\ndirectory_name_encryption = true\npassword = [A-Za-z0-9_-]+\npassword2 = [A-Za-z0-9_-]+\n$/);
    expect(conf.text).not.toContain(GDRIVE.cryptPassword);
    expect(conf.text).not.toContain(GDRIVE.cryptPassword2);
    const plain = renderRcloneConf(S3, { section: { type: 's3', access_key_id: 'AKIA' }, root: 'whm-backups/panel', flags: [] });
    expect(plain.root).toBe('whm-backups/panel');
    expect(plain.text).toBe('[whm]\ntype = s3\naccess_key_id = AKIA\n');
  });

  it('refuses values the INI reader would mangle and builds remote targets without a leading dash', () => {
    expect(() => renderRcloneConf(S3, { section: { type: 's3', endpoint: '"https://x"' }, root: '', flags: [] })).toThrow(/cannot carry/);
    expect(() => renderRcloneConf(S3, { section: { type: 's3', endpoint: 'https://x\nuser = evil' }, root: '', flags: [] })).toThrow(/cannot carry/);
    expect(rcloneTarget('', '')).toBe('whm:');
    expect(rcloneTarget('', 'a.tar.gz')).toBe('whm:a.tar.gz');
    expect(rcloneTarget('bucket/prefix/', 'a.tar.gz')).toBe('whm:bucket/prefix/a.tar.gz');
    expect(rcloneTarget('/srv/backups', 'a.tar.gz')).toBe('whm:/srv/backups/a.tar.gz');
    expect(rcloneTarget('-flag', 'x')).toBe('whm:-flag/x');
  });

  it('reads back a rotated refresh token from the right section only', () => {
    const text = '[whmbase]\ntype = onedrive\ntoken = {"access_token":"at","refresh_token":"new-rt","expiry":"2026-10-30T00:00:00Z"}\n\n[whm]\ntype = crypt\n';
    expect(readTokenUpdate(text, { kind: 'onedrive', crypt: true, refreshToken: 'old-rt' })).toEqual({ refreshToken: 'new-rt' });
    expect(readTokenUpdate(text, { kind: 'onedrive', crypt: true, refreshToken: 'new-rt' })).toBeNull();
    expect(readTokenUpdate(text, { kind: 'onedrive', crypt: false, refreshToken: 'old-rt' })).toBeNull();
    expect(readTokenUpdate(text, { kind: 's3', refreshToken: 'old-rt' })).toBeNull();
    expect(readTokenUpdate('[whm]\ntoken = not json\n', { kind: 'dropbox', refreshToken: 'x' })).toBeNull();
  });

  it('parses lsjson output, drops directories and scrubs secrets from messages', () => {
    const out = parseLsjson(JSON.stringify([{ Path: 'a', Name: 'backup-10.26.2026_02-00-00_alice.tar.gz', Size: 12, ModTime: '2026-10-26T02:00:00Z', IsDir: false }, { Path: 'd', Name: 'd', Size: -1, IsDir: true }, { Name: 'notes.txt', Size: 1, IsDir: false }]));
    expect(out).toEqual([{ name: 'backup-10.26.2026_02-00-00_alice.tar.gz', sizeBytes: 12, mtime: '2026-10-26T02:00:00Z' }, { name: 'notes.txt', sizeBytes: 1, mtime: null }]);
    expect(() => parseLsjson('{')).toThrow(/unreadable/);
    expect(scrubSecrets('token 1//refresh-token-value-abc rejected by GOCSPX-clientsecretvalue', GDRIVE)).toBe('token [redacted] rejected by [redacted]');
  });
});

describe('rclone schemas reject injection and traversal before anything runs', () => {
  beforeEach(() => { exec.mockClear(); });

  it('refuses traversal in folders, prefixes, remote names and destinations', async () => {
    for (const folder of ['../x', 'a/../b', 'a;b', 'a b', 'a\nb']) expect((await opError(runOp('backup.rclone.list', { config: { ...GDRIVE, folder } }, ctx))).code, folder).toBe('invalid_args');
    for (const prefix of ['../x', 'x/..', '$(id)']) expect((await opError(runOp('backup.rclone.list', { config: { ...S3, crypt: true, cryptPassword: 'a', cryptPassword2: 'b', prefix } }, ctx))).code, prefix).toBe('invalid_args');
    for (const remoteName of ['../etc/passwd', 'notes.txt', 'Backup.tar.gz', 'backup-10.26.2026_02-00-00_alice.tar.gz; rm -rf /', '-r']) expect((await opError(runOp('backup.rclone.delete', { config: GDRIVE, remoteName }, ctx))).code, remoteName).toBe('invalid_args');
    for (const dest of ['backup', '/backup/../root']) expect((await opError(runOp('backup.rclone.download', { config: GDRIVE, remoteName: 'backup-10.26.2026_02-00-00_alice.tar.gz', dest }, ctx))).code, dest).toBe('invalid_args');
    expect((await opError(runOp('backup.rclone.upload', { config: GDRIVE, file: '/backup/notes.txt' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.rclone.upload', { config: GDRIVE, file: ARCHIVE, shell: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses incomplete or unsafe provider configurations', async () => {
    const bad = [
      { ...GDRIVE, crypt: true, cryptPassword: undefined, cryptPassword2: undefined },
      { ...GDRIVE, refreshToken: '"quoted"' },
      { ...GDRIVE, refreshToken: '#comment' },
      { ...GDRIVE, refreshToken: 'ends with space ' },
      { ...GDRIVE, clientSecret: 'a\nb' },
      { ...GDRIVE, extra: 1 },
      { kind: 'onedrive', clientId: 'c', clientSecret: 's', refreshToken: 'r', folder: '' },
      { kind: 'onedrive', clientId: 'c', clientSecret: 's', refreshToken: 'r', driveId: 'b!x', driveType: 'shared' },
      { kind: 'azureblob', account: 'acct', container: 'backups' },
      { kind: 'azureblob', account: 'Acct', container: 'backups', accountKey: 'k' },
      { kind: 'azureblob', account: 'acct', container: 'x', accountKey: 'k' },
      { kind: 'b2', keyId: 'id', applicationKey: 'k', bucket: 'ab' },
      { kind: 'b2', keyId: 'id;x', applicationKey: 'k', bucket: 'whm-backups' },
      { kind: 'nextcloud', url: 'https://x' },
    ];
    for (const config of bad) expect((await opError(runOp('backup.rclone.list', { config }, ctx))).code, JSON.stringify(config)).toBe('invalid_args');
    expect(destinationConfig.safeParse({ kind: 'azureblob', account: 'acct', container: 'backups', sasToken: 'sv=2024&sig=abc%2F' }).success).toBe(true);
    expect(destinationConfig.safeParse({ kind: 'b2', keyId: '0012abc', applicationKey: 'K00abc', bucket: 'whm-backups', crypt: true, cryptPassword: 'p', cryptPassword2: 's' }).success).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('the curl/S3 ops refuse configurations that belong to rclone, and rclone refuses to run without the binary', async () => {
    for (const [op, args] of [['backup.destination.list', { config: GDRIVE }], ['backup.destination.upload', { config: { ...S3, crypt: true, cryptPassword: 'a', cryptPassword2: 'b' }, file: ARCHIVE }], ['backup.destination.remove', { config: { kind: 'b2', keyId: 'id', applicationKey: 'k', bucket: 'whm-backups' }, remoteName: 'backup-10.26.2026_02-00-00_alice.tar.gz' }]]) {
      expect((await opError(runOp(op, args, ctx))).code, op).toBe('unsupported');
    }
    hasBinary.mockImplementation(() => false);
    try {
      const err = await opError(runOp('backup.rclone.list', { config: GDRIVE }, ctx));
      expect(err.code).toBe('capability_missing');
      expect(err.details).toMatchObject({ bin: 'rclone', capability: 'rclone' });
    } finally { hasBinary.mockRestore(); }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('rclone calls with a mocked binary', () => {
  afterEach(() => { exec.mockRestore(); hasBinary.mockRestore(); });

  it('uploads through a temporary root-only config that holds the secrets and is removed afterwards', async () => {
    const calls = fakeRclone(({ sub, argv }) => {
      if (sub === 'lsjson') return { stdout: JSON.stringify([{ Name: argv.at(-1).replace(/^whm:/, '').split('/').pop(), Size: 13, IsDir: false, ModTime: '2026-10-26T02:00:00Z' }]) };
      return { stdout: '' };
    });
    const out = await runOp('backup.rclone.upload', { config: GDRIVE, file: ARCHIVE }, ctx);
    expect(out).toMatchObject({ kind: 'gdrive', name: 'backup-10.26.2026_02-00-00_alice.tar.gz', remotePath: 'gdrive://whm-backups/backup-10.26.2026_02-00-00_alice.tar.gz (encrypted)', sizeBytes: 13, encrypted: true, tokenUpdate: null });
    expect(calls).toHaveLength(2);
    const [copy, ls] = calls;
    expect(copy.argv.slice(0, 4)).toEqual(['--config', copy.confPath, '--cache-dir', expect.stringMatching(/^\/tmp\/whm\/backup-rclone-.*\/cache$/)]);
    expect(copy.argv).toEqual(expect.arrayContaining(['--contimeout', '30s', '--timeout', '5m', '--retries', '3', '--low-level-retries', '10', '--log-level', 'ERROR']));
    expect(copy.argv.slice(-3)).toEqual(['copyto', ARCHIVE, 'whm:backup-10.26.2026_02-00-00_alice.tar.gz']);
    expect(ls.argv.slice(-2)).toEqual(['lsjson', 'whm:backup-10.26.2026_02-00-00_alice.tar.gz']);
    expect(copy.confPath).toMatch(/^\/tmp\/whm\/backup-rclone-/);
    expect(copy.env.HOME).toMatch(/^\/tmp\/whm\/backup-rclone-/);
    expect(copy.timeoutMs).toBe(7_205_000);
    // The config carried the credentials (and only there) and the crypt layer on top.
    expect(copy.conf).toContain('[whmbase]\ntype = drive\nscope = drive.file\nclient_id = 123.apps.googleusercontent.com\nclient_secret = GOCSPX-clientsecretvalue\ntoken = {"access_token":"","token_type":"Bearer","refresh_token":"1//refresh-token-value-abc","expiry":"2000-01-01T00:00:00Z"}');
    expect(copy.conf).toContain('[whm]\ntype = crypt\nremote = whmbase:whm-backups\n');
    expect(copy.conf).not.toContain(GDRIVE.cryptPassword);
    expect(JSON.stringify(copy.argv)).not.toContain('refresh-token');
    expect(JSON.stringify(copy.argv)).not.toContain('clientsecret');
    // Nothing of it survives the call, and the op result never echoes it.
    expect(fs.existsSync(copy.confPath)).toBe(false);
    expect(rcloneDirs()).toEqual([]);
    const echoed = JSON.stringify(out);
    for (const secret of [GDRIVE.refreshToken, GDRIVE.clientSecret, GDRIVE.cryptPassword, GDRIVE.cryptPassword2, '[whmbase]']) expect(echoed).not.toContain(secret);
  });

  it('removes the config on failure, maps rclone exit codes and scrubs secrets from the error', async () => {
    const calls = fakeRclone(() => ({ code: 7, stderr: `2026/10/30 10:00:00 ERROR : Failed to refresh token ${GDRIVE.refreshToken} with ${GDRIVE.clientSecret}: oauth2: invalid_grant\n` }));
    const err = await opError(runOp('backup.rclone.upload', { config: GDRIVE, file: ARCHIVE }, ctx));
    expect(err.code).toBe('destination_failed');
    expect(err.details.exitCode).toBe(7);
    expect(err.message).toBe('upload to gdrive: fatal error (authentication or configuration) (Failed to refresh token [redacted] with [redacted]: oauth2: invalid_grant)');
    expect(fs.existsSync(calls[0].confPath)).toBe(false);
    expect(rcloneDirs()).toEqual([]);
    const probe = await runOp('backup.rclone.test', { config: GDRIVE }, ctx);
    expect(probe).toMatchObject({ ok: false, code: 'destination_failed' });
    expect(probe.message).toMatch(/^test upload: fatal error/);
    expect(JSON.stringify(probe)).not.toContain(GDRIVE.refreshToken);
    expect(rcloneDirs()).toEqual([]);
  });

  it('reports a refresh token rclone rotated, so the panel can store it', async () => {
    const config = { ...GDRIVE, kind: 'dropbox', crypt: false };
    fakeRclone(({ sub, confPath, conf }) => {
      if (sub === 'lsjson') {
        fs.writeFileSync(confPath, conf.replace(config.refreshToken, 'rotated-refresh-token'));
        return { stdout: JSON.stringify([{ Name: 'backup-10.26.2026_02-00-00_alice.tar.gz', Size: 13, IsDir: false }, { Name: 'unrelated.txt', Size: 1, IsDir: false }]) };
      }
      return {};
    });
    const out = await runOp('backup.rclone.list', { config }, ctx);
    expect(out).toEqual({ kind: 'dropbox', encrypted: false, archives: [{ name: 'backup-10.26.2026_02-00-00_alice.tar.gz', sizeBytes: 13, mtime: null, username: 'alice' }], tokenUpdate: { refreshToken: 'rotated-refresh-token' } });
    expect(rcloneDirs()).toEqual([]);
  });

  it('renders every backend (S3 path style, SFTP root, Azure SAS, B2, OneDrive) and the insecure flag', async () => {
    const seen = [];
    fakeRclone(({ conf, argv, sub }) => { seen.push({ conf, argv }); return sub === 'lsjson' ? { stdout: '[]' } : {}; });
    const run = (config) => runOp('backup.rclone.list', { config }, ctx);
    await run({ ...S3, endpoint: 'https://s3.example.com', pathStyle: true, insecure: true });
    expect(seen.at(-1).conf).toBe('[whm]\ntype = s3\nprovider = Other\naccess_key_id = AKIA\nsecret_access_key = topsecretkey\nregion = eu-west-1\nendpoint = https://s3.example.com\nforce_path_style = true\n');
    expect(seen.at(-1).argv).toContain('--no-check-certificate');
    expect(seen.at(-1).argv.slice(-3)).toEqual(['lsjson', '--files-only', 'whm:whm-backups/panel']);
    await run(SFTP);
    expect(seen.at(-1).conf).toMatch(/^\[whmbase\]\ntype = sftp\nhost = sftp\.example\.com\nport = 22\nuser = u\npass = [A-Za-z0-9_-]+\n\n\[whm\]\ntype = crypt\nremote = whmbase:\/srv\/backups\n/);
    expect(seen.at(-1).conf).not.toContain('sftp-password');
    expect(seen.at(-1).argv.at(-1)).toBe('whm:');
    await run({ kind: 'azureblob', account: 'acct', container: 'backups', prefix: 'whm', sasToken: '?sv=2024&sig=abc' });
    expect(seen.at(-1).conf).toBe('[whm]\ntype = azureblob\naccount = acct\nsas_url = https://acct.blob.core.windows.net/backups?sv=2024&sig=abc\n');
    expect(seen.at(-1).argv.at(-1)).toBe('whm:backups/whm');
    await run({ kind: 'b2', keyId: '0012abc', applicationKey: 'K00abc', bucket: 'whm-backups' });
    expect(seen.at(-1).conf).toBe('[whm]\ntype = b2\naccount = 0012abc\nkey = K00abc\nhard_delete = true\n');
    // Pruning must delete on Drive and B2, not trash or hide the (billed) object.
    await run(GDRIVE);
    expect(seen.at(-1).conf).toContain('"expiry":"2000-01-01T00:00:00Z"}\nuse_trash = false\n\n[whm]\ntype = crypt\n');
    await run({ ...GDRIVE, crypt: false, cryptPassword: undefined, cryptPassword2: undefined, rootFolderId: 'folder_1' });
    expect(seen.at(-1).conf).toMatch(/\nroot_folder_id = folder_1\nuse_trash = false\n$/);
    await run({ kind: 'onedrive', clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt', driveId: 'b!abc', driveType: 'business', folder: 'Backups/whm' });
    expect(seen.at(-1).conf).toContain('type = onedrive\nclient_id = cid\nclient_secret = csec\ntoken = {"access_token":"","token_type":"Bearer","refresh_token":"rt","expiry":"2000-01-01T00:00:00Z"}\ndrive_id = b!abc\ndrive_type = business\n');
    expect(seen.at(-1).argv.at(-1)).toBe('whm:Backups/whm');
    await run({ kind: 'local', dir: '/backup/offsite', crypt: true, cryptPassword: 'p', cryptPassword2: 's' });
    expect(seen.at(-1).conf).toMatch(/^\[whmbase\]\ntype = local\n\n\[whm\]\ntype = crypt\nremote = whmbase:\/backup\/offsite\n/);
    expect(rcloneDirs()).toEqual([]);
  });

  it('a killed or unstartable rclone reports a scrubbed message and drops the raw stderr and argv', async () => {
    const calls = fakeRclone(({ argv }) => { throw new ExecError('timeout', '"rclone" did not finish within 7205000ms', { bin: '/usr/bin/rclone', argv, stderr: `2026/10/30 10:00:00 ERROR : PUT https://acct.blob.core.windows.net/backups?${AZURE_SAS.sasToken} : 403\n` }); });
    const err = await opError(runOp('backup.rclone.upload', { config: AZURE_SAS, file: ARCHIVE }, ctx));
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('upload to azureblob: "rclone" did not finish within 7205000ms');
    expect(err.details).toEqual({ exitCode: null });
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain('supersecretsignature');
    expect(fs.existsSync(calls[0].confPath)).toBe(false);
    expect(rcloneDirs()).toEqual([]);
    fakeRclone(({ argv }) => { throw new ExecError('spawn_failed', `Could not run "rclone": spawn EAGAIN ${GDRIVE.refreshToken}`, { bin: '/usr/bin/rclone', argv }); });
    const spawn = await opError(runOp('backup.rclone.list', { config: GDRIVE }, ctx));
    expect(spawn.code).toBe('destination_failed');
    expect(spawn.message).toBe('list gdrive: Could not run "rclone": spawn EAGAIN [redacted]');
    expect(spawn.details).toEqual({ exitCode: null });
    const probe = await runOp('backup.rclone.test', { config: GDRIVE }, ctx);
    expect(probe).toMatchObject({ ok: false, code: 'destination_failed', message: 'test upload: Could not run "rclone": spawn EAGAIN [redacted]' });
    expect(rcloneDirs()).toEqual([]);
  });

  it('delete tolerates rclone 1.60 reporting a missing file as a plain error, but not other failures', async () => {
    fakeRclone(() => ({ code: 1, stderr: `2026/10/30 10:00:00 Failed to deletefile: whm:${NAME} is a directory or doesn't exist\n` }));
    expect(await runOp('backup.rclone.delete', { config: GDRIVE, remoteName: NAME }, ctx)).toEqual({ kind: 'gdrive', name: NAME, removed: false, tokenUpdate: null });
    fakeRclone(() => ({ code: 2, stderr: 'ERROR : object not found\n' }));
    expect(await runOp('backup.rclone.delete', { config: GDRIVE, remoteName: NAME }, ctx)).toMatchObject({ removed: false });
    fakeRclone(() => ({ code: 1, stderr: `Failed to deletefile: didn't find section in config file for ${GDRIVE.clientSecret}\n` }));
    const err = await opError(runOp('backup.rclone.delete', { config: GDRIVE, remoteName: NAME }, ctx));
    expect(err.code).toBe('destination_failed');
    expect(err.details).toEqual({ exitCode: 1, detail: "Failed to deletefile: didn't find section in config file for [redacted]" });
    fakeRclone(() => ({ code: 2, stderr: '2026/10/30 10:00:00 ERROR : connection refused\n' }));
    expect((await opError(runOp('backup.rclone.delete', { config: GDRIVE, remoteName: NAME }, ctx))).message).toBe('delete on gdrive: the operation failed (connection refused)');
    expect(rcloneDirs()).toEqual([]);
  });

  it('writes the Azure endpoint of the account-key form the way the installed rclone reads it', async () => {
    expect(parseRcloneVersion('rclone v1.60.1\n- os/version: ubuntu 24.04 (64 bit)\n')).toEqual({ major: 1, minor: 60 });
    expect(parseRcloneVersion('rclone v1.68.2\n')).toEqual({ major: 1, minor: 68 });
    expect(parseRcloneVersion('')).toBeNull();
    const seen = [];
    let version = 'rclone v1.60.1\n- os/version: ubuntu 24.04 (64 bit)\n';
    const calls = fakeRclone(({ argv, conf, sub }) => { if (argv[0] === 'version') return { stdout: version }; seen.push({ conf, argv }); return sub === 'lsjson' ? { stdout: '[]' } : {}; });
    const probes = () => calls.filter((c) => c.argv[0] === 'version').length;
    const run = (config) => runOp('backup.rclone.list', { config }, ctx);
    const china = { kind: 'azureblob', account: 'acct', container: 'backups', accountKey: 'K3yvalue', endpoint: 'https://acct.blob.core.chinacloudapi.cn' };
    resetRcloneVersion();
    await run(china);
    expect(seen.at(-1).conf).toBe('[whm]\ntype = azureblob\naccount = acct\nkey = K3yvalue\nendpoint = blob.core.chinacloudapi.cn\n');
    await run(china);
    expect(probes()).toBe(1);
    // An endpoint 1.60 cannot compose from the account name is refused, not mangled.
    for (const endpoint of ['http://127.0.0.1:10000/devstoreaccount1', 'https://other.blob.core.chinacloudapi.cn', 'https://acct.blob.core.chinacloudapi.cn/path']) {
      const err = await opError(run({ ...china, endpoint }));
      expect(err.code, endpoint).toBe('unsupported');
      expect(err.message).toMatch(/rclone 1\.60 .*SAS token .*1\.61/);
    }
    // The SAS form carries the URL itself and never needs the probe; the public cloud neither.
    await run({ ...AZURE_SAS, endpoint: 'https://acct.blob.core.chinacloudapi.cn' });
    expect(seen.at(-1).conf).toBe('[whm]\ntype = azureblob\naccount = acct\nsas_url = https://acct.blob.core.chinacloudapi.cn/backups?sv=2024&sig=supersecretsignature\nendpoint = https://acct.blob.core.chinacloudapi.cn\n');
    await run({ ...china, endpoint: undefined });
    expect(seen.at(-1).conf).toBe('[whm]\ntype = azureblob\naccount = acct\nkey = K3yvalue\n');
    expect(probes()).toBe(1);
    resetRcloneVersion();
    version = 'rclone v1.68.2\n';
    await run(china);
    expect(seen.at(-1).conf).toBe('[whm]\ntype = azureblob\naccount = acct\nkey = K3yvalue\nendpoint = https://acct.blob.core.chinacloudapi.cn\n');
    resetRcloneVersion();
    version = '';
    await run(china);
    expect(seen.at(-1).conf).toContain('endpoint = https://acct.blob.core.chinacloudapi.cn\n');
    expect(probes()).toBe(3);
    expect(rcloneDirs()).toEqual([]);
    resetRcloneVersion();
  });

  it('a local directory outside the allowed roots is refused before rclone runs', async () => {
    const calls = fakeRclone();
    const err = await opError(runOp('backup.rclone.list', { config: { kind: 'local', dir: '/root/offsite', crypt: true, cryptPassword: 'p', cryptPassword2: 's' } }, ctx));
    expect(err.code).toBe('path_not_allowed');
    expect(calls).toHaveLength(0);
    expect(rcloneDirs()).toEqual([]);
  });

  it('download writes the decrypted archive, delete tolerates a missing file, list tolerates a missing folder', async () => {
    const dest = fs.mkdtempSync('/tmp/whm/test-rclone-dl-');
    fakeRclone(({ sub, argv }) => {
      if (sub === 'copyto') { fs.writeFileSync(argv.at(-1), 'archive-bytes'); return {}; }
      if (sub === 'deletefile') return { code: 4, stderr: 'ERROR : file not found' };
      if (sub === 'lsjson') return { code: 3, stderr: 'ERROR : directory not found' };
      return {};
    });
    const dl = await runOp('backup.rclone.download', { config: GDRIVE, remoteName: 'backup-10.26.2026_02-00-00_alice.tar.gz', dest }, ctx);
    expect(dl).toMatchObject({ path: `${dest}/backup-10.26.2026_02-00-00_alice.tar.gz`, sizeBytes: 13, encrypted: true });
    expect(dl.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((fs.statSync(dl.path).mode & 0o777)).toBe(0o600);
    expect(await runOp('backup.rclone.delete', { config: GDRIVE, remoteName: 'backup-10.26.2026_02-00-00_alice.tar.gz' }, ctx)).toEqual({ kind: 'gdrive', name: 'backup-10.26.2026_02-00-00_alice.tar.gz', removed: false, tokenUpdate: null });
    expect(await runOp('backup.rclone.list', { config: GDRIVE }, ctx)).toEqual({ kind: 'gdrive', encrypted: true, archives: [], tokenUpdate: null });
    expect(rcloneDirs()).toEqual([]);
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('a failed download leaves no partial file behind', async () => {
    const dest = fs.mkdtempSync('/tmp/whm/test-rclone-dl-');
    fakeRclone(({ argv }) => { fs.writeFileSync(argv.at(-1), 'partial'); return { code: 5, stderr: 'ERROR : temporary' }; });
    const err = await opError(runOp('backup.rclone.download', { config: GDRIVE, remoteName: 'backup-10.26.2026_02-00-00_alice.tar.gz', dest }, ctx));
    expect(err.message).toMatch(/temporary error, retries exhausted/);
    expect(fs.readdirSync(dest)).toEqual([]);
    fs.rmSync(dest, { recursive: true, force: true });
  });
});
