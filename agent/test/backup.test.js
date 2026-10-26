import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { parseTarListing, foldChildren, archiveTop, archiveUser, buildArchiveName, signS3, s3Target, parseS3Listing, remoteUrl, destinationConfig } from '../src/ops/backup.js';

// exec is spied with the real implementation behind it so tests can prove an op
// refused before any program ran. No test here archives, extracts, imports or
// uploads anything: every op either fails its schema or stops at a path/
// capability check.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();
const ARCHIVE = '/backup/backup-10.26.2026_02-00-00_alice.tar.gz';

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

describe('backup op catalog', () => {
  it('registers the family and flags the destructive ops', () => {
    for (const name of ['backup.account.archive', 'backup.archive.list', 'backup.archive.verify', 'backup.archive.info', 'backup.archive.inspect', 'backup.archive.extract', 'backup.files.restore', 'backup.db.import', 'backup.db.restore_users', 'backup.archive.remove', 'backup.staging.remove', 'backup.destination.test', 'backup.destination.upload', 'backup.destination.download', 'backup.destination.list', 'backup.destination.remove']) expect(catalog.has(name), name).toBe(true);
    for (const name of ['backup.files.restore', 'backup.db.import', 'backup.archive.remove', 'backup.staging.remove', 'backup.destination.remove']) expect(catalog.get(name).destructive, name).toBe(true);
    for (const name of ['backup.account.archive', 'backup.archive.inspect', 'backup.destination.upload', 'backup.destination.test']) expect(catalog.get(name).destructive, name).toBe(false);
  });

  it('rejects unknown ops in the family', async () => {
    expect((await opError(runOp('backup.exec', { cmd: 'tar' }, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('backup.archive.shell', {}, ctx))).code).toBe('unknown_op');
  });
});

describe('backup schemas reject injection and traversal before anything runs', () => {
  it('backup.account.archive refuses bad usernames, paths, names, databases and zones', async () => {
    exec.mockClear();
    const base = { username: 'alice', homeDir: '/home/alice', dest: '/backup' };
    for (const username of ['-r', 'a;b', '../x', 'Alice', '', 'root user']) expect((await opError(runOp('backup.account.archive', { ...base, username }, ctx))).code, username).toBe('invalid_args');
    for (const homeDir of ['home/alice', '/home/../etc', '/home/alice/..', 'C:\\x', '']) expect((await opError(runOp('backup.account.archive', { ...base, homeDir }, ctx))).code, homeDir).toBe('invalid_args');
    for (const dest of ['backup', '/backup/../root']) expect((await opError(runOp('backup.account.archive', { ...base, dest }, ctx))).code, dest).toBe('invalid_args');
    for (const name of ['alice.tar.gz', 'cpmove-alice.tar.gz', '../x.tar.gz', 'backup-10.26.2026_02-00-00_alice.tar', 'backup-10.26.2026_02-00-00_alice.tar.gz; rm -rf /']) expect((await opError(runOp('backup.account.archive', { ...base, name }, ctx))).code, name).toBe('invalid_args');
    for (const databases of [['alice_shop; DROP DATABASE x'], ['Alice'], ['a'.repeat(65)], ['-x']]) expect((await opError(runOp('backup.account.archive', { ...base, databases }, ctx))).code, JSON.stringify(databases)).toBe('invalid_args');
    for (const excludes of [['../etc'], ['/etc'], ['-rf'], ['a\nb']]) expect((await opError(runOp('backup.account.archive', { ...base, excludes }, ctx))).code, JSON.stringify(excludes)).toBe('invalid_args');
    expect((await opError(runOp('backup.account.archive', { ...base, dnsZones: [{ domain: 'not a domain', body: '' }] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.account.archive', { ...base, compressionLevel: 11 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.account.archive', { ...base, credentials: { user: 'root', extra: true } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.account.archive', { ...base, shell: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a name that does not belong to the user, or a destination outside the allowed roots, is refused before tar runs', async () => {
    exec.mockClear();
    expect((await opError(runOp('backup.account.archive', { username: 'alice', homeDir: '/home/alice', dest: '/backup', name: 'backup-10.26.2026_02-00-00_bob.tar.gz' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.account.archive', { username: 'alice', homeDir: '/home/alice', dest: '/root/backups' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('backup.account.archive', { username: 'alice', homeDir: '/etc', dest: '/backup' }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });

  it('archive readers only accept account archive names inside allowed roots', async () => {
    exec.mockClear();
    for (const archive of ['/backup/notes.txt', '/backup/x.tar.gz;id', '/etc/passwd', 'backup-10.26.2026_02-00-00_alice.tar.gz', '/backup/../root/backup-10.26.2026_02-00-00_alice.tar.gz']) {
      for (const op of ['backup.archive.verify', 'backup.archive.info', 'backup.archive.inspect', 'backup.archive.remove']) {
        expect((await opError(runOp(op, { archive }, ctx))).code, `${op} ${archive}`).toBe('invalid_args');
      }
    }
    for (const op of ['backup.archive.verify', 'backup.archive.info', 'backup.archive.inspect', 'backup.archive.remove']) {
      expect((await opError(runOp(op, { archive: '/root/backup-10.26.2026_02-00-00_alice.tar.gz' }, ctx))).code, op).toBe('path_not_allowed');
    }
    expect((await opError(runOp('backup.archive.inspect', { archive: ARCHIVE, prefix: '../meta' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.archive.inspect', { archive: ARCHIVE, prefix: '-T' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.archive.verify', { archive: ARCHIVE, sha256: 'not-hex' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.archive.list', { dir: '/backup', username: 'a;b' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.archive.list', { dir: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });

  it('backup.files.restore refuses traversal, option-like members and foreign homes', async () => {
    exec.mockClear();
    const base = { archive: ARCHIVE, username: 'alice', homeDir: '/home/alice' };
    for (const paths of [['../etc/passwd'], ['/etc/passwd'], ['-C/'], ['public_html/../../x'], ['a\nb'], ['']]) {
      const err = await opError(runOp('backup.files.restore', { ...base, paths }, ctx));
      expect(err.code, JSON.stringify(paths)).toBe('invalid_args');
      expect(err.details.fields['paths.0']).toBeDefined();
    }
    expect((await opError(runOp('backup.files.restore', { ...base, username: 'root;x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.files.restore', { ...base, homeDir: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('backup.files.restore', { ...base, archive: '/root/backup-10.26.2026_02-00-00_alice.tar.gz' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('backup.archive.extract', { archive: ARCHIVE, dest: '/root/x' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('backup.staging.remove', { dir: '/backup' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('backup.staging.remove', { dir: '/etc/.restore-1' }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });

  it('database ops validate identifiers and never run without the client', async () => {
    exec.mockClear();
    for (const file of ['/backup/x.sql; rm', 'relative.sql', '/backup/../etc/x.sql']) expect((await opError(runOp('backup.db.import', { file }, ctx))).code, file).toBe('invalid_args');
    expect((await opError(runOp('backup.db.import', { file: '/backup/x.sql', database: 'Shop;DROP' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.db.restore_users', { users: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.db.restore_users', { users: [{ user: 'a b', host: 'localhost' }] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.db.restore_users', { users: [{ user: 'app', host: 'localhost', hashHex: 'zz' }] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.db.restore_users', { users: [{ user: 'app', host: 'localhost', grants: ['DROP TABLE x'] }] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.db.import', { file: '/etc/x.sql' }, ctx))).code).toMatch(/capability_missing|path_not_allowed/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('destination configs are validated per kind, including hostnames, paths, URLs and bucket names', async () => {
    exec.mockClear();
    const bad = [
      { kind: 'ftp', host: 'h;rm -rf', username: 'u' },
      { kind: 'ftp', host: 'ftp.example.com', username: 'u', path: '../x' },
      { kind: 'ftp', host: 'ftp.example.com', username: 'u', port: 70000 },
      { kind: 'ftp', host: 'ftp.example.com', username: '', password: 'p' },
      { kind: 'sftp', host: 'sftp.example.com', username: 'u', hostKeySha256: 'short' },
      { kind: 'sftp', host: 'sftp.example.com', username: 'u', path: 'a b' },
      { kind: 'webdav', url: 'file:///etc/passwd' },
      { kind: 'webdav', url: 'not a url' },
      { kind: 's3', bucket: 'Bad_Bucket', accessKey: 'a', secretKey: 'b' },
      { kind: 's3', bucket: 'ok-bucket', accessKey: 'a', secretKey: 'b', region: 'EU West' },
      { kind: 's3', bucket: 'ok-bucket', accessKey: 'a', secretKey: 'b', endpoint: 'gopher://x' },
      { kind: 'local', dir: 'relative' },
      { kind: 'gdrive', folder: 'x' },
      { kind: 'local', dir: '/backup', extra: 1 },
    ];
    for (const config of bad) {
      for (const [op, extra] of [['backup.destination.test', {}], ['backup.destination.upload', { file: ARCHIVE }], ['backup.destination.remove', { remoteName: 'cpmove-alice.tar.gz' }], ['backup.destination.list', {}]]) {
        expect((await opError(runOp(op, { config, ...extra }, ctx))).code, `${op} ${JSON.stringify(config)}`).toBe('invalid_args');
      }
    }
    const good = { kind: 'ftp', host: 'ftp.example.com', username: 'u', password: 'p' };
    expect((await opError(runOp('backup.destination.upload', { config: good, file: '/backup/notes.txt' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.destination.upload', { config: good, file: ARCHIVE, remoteName: '../x.tar.gz' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.destination.remove', { config: good, remoteName: 'x; rm' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('backup.destination.download', { config: good, remoteName: 'cpmove-alice.tar.gz', dest: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('backup.destination.upload', { config: good, file: '/root/backup-10.26.2026_02-00-00_alice.tar.gz' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('backup.destination.test', { config: { kind: 'local', dir: '/etc/backups' } }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
    expect(destinationConfig.safeParse({ kind: 'sftp', host: '10.0.0.5', username: 'u', path: '~/backups' }).success).toBe(true);
  });
});

describe('pure helpers', () => {
  it('derives names, top directories and users of archives', () => {
    expect(buildArchiveName('alice', new Date(2026, 9, 26, 2, 5, 9))).toBe('backup-10.26.2026_02-05-09_alice.tar.gz');
    expect(archiveTop('/backup/backup-10.26.2026_02-05-09_alice.tar.gz')).toBe('backup-10.26.2026_02-05-09_alice');
    expect(archiveTop('/x/cpmove-alice.tar')).toBe('cpmove-alice');
    expect(archiveUser('backup-10.26.2026_02-05-09_alice.tar.gz')).toBe('alice');
    expect(archiveUser('cpmove-bob.tar.gz')).toBe('bob');
    expect(archiveUser('carol.tar')).toBe('carol');
    expect(archiveUser('notes.txt')).toBeNull();
  });

  it('parses tar -tv output and folds it into direct children', () => {
    const listing = [
      'drwxr-xr-x alice/alice       0 2026-10-26 02:00 top/homedir/',
      'drwxr-xr-x alice/alice       0 2026-10-26 02:00 top/homedir/public_html/',
      '-rw-r--r-- alice/alice     120 2026-10-26 01:59 top/homedir/public_html/index.html',
      '-rw-r--r-- alice/alice      30 2026-10-26 01:58 top/homedir/public_html/with space.txt',
      'lrwxrwxrwx alice/alice       0 2026-10-26 01:50 top/homedir/www -> public_html',
      '-rw------- alice/alice     220 2026-10-26 01:40 top/homedir/.bashrc',
      'garbage line',
    ].join('\n');
    const entries = parseTarListing(listing).map((e) => ({ ...e, name: e.name.slice(4) }));
    expect(entries).toHaveLength(6);
    expect(entries.find((e) => e.name === 'homedir/www')).toMatchObject({ type: 'link', target: 'public_html' });
    expect(entries.find((e) => e.name === 'homedir/public_html/with space.txt')).toMatchObject({ type: 'file', size: 30 });
    const children = foldChildren(entries, 'homedir');
    expect(children.map((c) => c.name)).toEqual(['public_html', '.bashrc', 'www']);
    expect(children[0]).toMatchObject({ type: 'dir', size: 150, files: 2, owner: 'alice:alice' });
    expect(children[1]).toMatchObject({ type: 'file', size: 220, files: 1 });
  });

  it('signs S3 requests deterministically (SigV4) and resolves virtual-hosted / path-style targets', () => {
    const headers = signS3({ method: 'PUT', host: 'bkt.s3.eu-west-1.amazonaws.com', path: '/panel/backup.tar.gz', headers: { 'Content-Type': 'application/gzip', 'content-length': '10' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'eu-west-1', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2026-10-26T02:00:00Z') });
    expect(headers['x-amz-date']).toBe('20261026T020000Z');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261026\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
    const again = signS3({ method: 'PUT', host: 'bkt.s3.eu-west-1.amazonaws.com', path: '/panel/backup.tar.gz', headers: { 'content-type': 'application/gzip', 'content-length': '10' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'eu-west-1', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2026-10-26T02:00:00Z') });
    expect(again.authorization).toBe(headers.authorization);
    expect(s3Target({ bucket: 'bkt', region: 'eu-west-1', pathStyle: false }, 'panel/a b.tar.gz')).toMatchObject({ host: 'bkt.s3.eu-west-1.amazonaws.com', path: '/panel/a%20b.tar.gz', protocol: 'https:' });
    expect(s3Target({ bucket: 'bkt', region: 'us-east-1', endpoint: 'http://minio.local:9000', pathStyle: true }, 'x.tar.gz')).toMatchObject({ host: 'minio.local:9000', hostname: 'minio.local', port: 9000, path: '/bkt/x.tar.gz', protocol: 'http:' });
    expect(s3Target({ bucket: 'bkt', region: 'us-west-004', endpoint: 'https://s3.us-west-004.backblazeb2.com', pathStyle: false }, '')).toMatchObject({ host: 'bkt.s3.us-west-004.backblazeb2.com', path: '/' });
    expect(parseS3Listing('<ListBucketResult><Contents><Key>panel/backup-10.26.2026_02-00-00_alice.tar.gz</Key><LastModified>2026-10-26T02:01:00.000Z</LastModified><Size>4096</Size></Contents><Contents><Key>panel/</Key><Size>0</Size></Contents></ListBucketResult>')).toEqual([
      { key: 'panel/backup-10.26.2026_02-00-00_alice.tar.gz', sizeBytes: 4096, mtime: '2026-10-26T02:01:00.000Z' }, { key: 'panel/', sizeBytes: 0, mtime: null },
    ]);
  });

  it('builds curl URLs with encoded path segments and the FTP/SFTP absolute-path conventions', () => {
    expect(remoteUrl({ kind: 'ftp', host: 'ftp.example.com', port: 21, path: 'backups/whm' }, 'a.tar.gz')).toBe('ftp://ftp.example.com:21/backups/whm/a.tar.gz');
    expect(remoteUrl({ kind: 'ftp', host: 'ftp.example.com', port: 2121, path: '/srv/abs' }, 'a.tar.gz')).toBe('ftp://ftp.example.com:2121//srv/abs/a.tar.gz');
    expect(remoteUrl({ kind: 'sftp', host: '10.0.0.5', port: 22, path: '/srv/backups' }, 'a.tar.gz')).toBe('sftp://10.0.0.5:22/srv/backups/a.tar.gz');
    expect(remoteUrl({ kind: 'sftp', host: 'h.example.com', port: 22, path: '~/backups' }, '')).toBe('sftp://h.example.com:22/~/backups/');
    expect(remoteUrl({ kind: 'webdav', url: 'https://dav.example.com/remote.php/dav/files/u/' }, 'a.tar.gz')).toBe('https://dav.example.com/remote.php/dav/files/u/a.tar.gz');
  });
});
