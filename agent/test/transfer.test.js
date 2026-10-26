import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { shellQuote, remoteCommand, parsePasswd, parseUserDomains, parseRsyncStats, summarizeArchive, parseCpUserFile } from '../src/ops/transfer.js';

// exec is spied with the real implementation behind it so the tests prove an
// op refused before any program ran. Remote ops are never executed against a
// server (the schema or a missing ssh stops them); the archive ops run for real
// on a small cpmove archive built under /tmp/whm, which is an allowed root.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const TMP_ROOT = '/tmp/whm';
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n';
const conn = { host: 'source.example.com', port: 22, user: 'root', privateKey: KEY };
let root;
let tmpRootExisted;
let archive;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

function buildArchive(dir) {
  const top = path.join(dir, 'cpmove-alice');
  const put = (rel, content) => { fs.mkdirSync(path.dirname(path.join(top, rel)), { recursive: true }); fs.writeFileSync(path.join(top, rel), content); };
  put('cp/alice', 'DNS=alice.com\nPLAN=gold\nCONTACTEMAIL=alice@alice.com\nIP=198.51.100.7\nUSER=alice\nMAXSQL=5\n');
  put('homedir/public_html/index.html', '<h1>alice</h1>');
  put('homedir/public_html/shop/index.html', '<h1>shop</h1>');
  put('homedir/.bashrc', '# rc');
  put('mysql/alice_shop.sql', 'CREATE TABLE t (id INT);\n');
  put('mysql.sql', "CREATE USER 'alice_app'@'localhost' IDENTIFIED BY PASSWORD '*ABC';\nGRANT ALL PRIVILEGES ON `alice\\_shop`.* TO 'alice_app'@'localhost';\n");
  put('dnszones/alice.com.db', '$TTL 14400\nalice.com. IN SOA ns1.example.com. hostmaster.alice.com. 2024010101 3600 1800 1209600 86400\n');
  put('dnszones/shop.example.net.db', '$TTL 14400\n');
  put('userdata/main', 'main_domain: alice.com\n');
  put('userdata/shop.example.net', 'documentroot: /home/alice/public_html/shop\nservername: shop.example.net\n');
  put('userdata/shop.example.net_SSL', 'documentroot: /home/alice/public_html/shop\n');
  put('addons', 'shop.example.net=shop.alice.com\n');
  put('pds', 'alias.example.org\n');
  put('sds2', 'shop_alice.com=/home/alice/public_html/shop\n');
  put('version', '5\n');
  const file = path.join(dir, 'cpmove-alice.tar.gz');
  execFileSync('tar', ['-czf', file, '-C', dir, 'cpmove-alice']);
  fs.rmSync(top, { recursive: true, force: true });
  return file;
}

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  root = `${TMP_ROOT}/transfer-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(root, { recursive: true });
  archive = buildArchive(root);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('transfer op catalog', () => {
  it('registers the family and rejects unknown ops', async () => {
    for (const name of ['transfer.remote.exec', 'transfer.remote.probe', 'transfer.remote.list_accounts', 'transfer.remote.read_file', 'transfer.remote.databases', 'transfer.remote.db_grants', 'transfer.remote.dump_database', 'transfer.remote.remove_file', 'transfer.remote.rsync', 'transfer.cpmove.inspect', 'transfer.cpmove.read_member', 'transfer.cpmove.extract', 'transfer.mysql.import', 'transfer.upload.append', 'transfer.archive.list']) {
      expect(catalog.has(name), name).toBe(true);
    }
    expect(catalog.get('transfer.remote.remove_file').destructive).toBe(true);
    expect((await opError(runOp('transfer.remote.shell', { connection: conn, command: 'ls' }, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('transfer.cpmove.delete', { path: archive }, ctx))).code).toBe('unknown_op');
  });
});

describe('remote command construction', () => {
  it('single-quotes every token so remote shells see literal words', () => {
    expect(shellQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(remoteCommand(['cat', '--', '/etc/passwd; id'])).toBe("'cat' '--' '/etc/passwd; id'");
    expect(remoteCommand(['mysql', '-N', '-e', "SHOW DATABASES LIKE 'bob\\_%'"])).toBe("'mysql' '-N' '-e' 'SHOW DATABASES LIKE '\\''bob\\_%'\\'''");
  });

  it('refuses programs outside the allowlist', () => {
    for (const prog of ['sh', 'bash', 'perl', 'curl', 'wget', 'python3', 'eval', '/bin/sh', 'cat;id']) {
      expect(() => remoteCommand([prog, 'x']), prog).toThrow(OpError);
    }
    expect(() => remoteCommand([])).toThrow(OpError);
  });
});

describe('remote ops refuse bad connections and arguments before anything runs', () => {
  it('rejects injection-shaped hosts, users, ports and credentials', async () => {
    exec.mockClear();
    const bad = [
      { ...conn, host: '-oProxyCommand=id' }, { ...conn, host: 'a;b.example.com' }, { ...conn, host: 'Host With Space' }, { ...conn, host: '' },
      { ...conn, user: '-l' }, { ...conn, user: 'root;id' }, { ...conn, user: '../x' }, { ...conn, user: 'Root' },
      { ...conn, port: 0 }, { ...conn, port: 70000 }, { ...conn, port: '22' },
      { ...conn, privateKey: 'not a key' }, { host: 'h.example.com', port: 22, user: 'root' },
      { host: 'h.example.com', port: 22, user: 'root', password: 'p\nq' }, { ...conn, password: 'both' }, { ...conn, extra: 1 },
    ];
    for (const c of bad) {
      const err = await opError(runOp('transfer.remote.exec', { connection: c, argv: ['hostname'] }, ctx));
      expect(err.code, JSON.stringify(c)).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.remote.exec', { connection: conn, argv: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('transfer.remote.exec', { connection: conn, argv: ['cat', 'a\nb'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('transfer.remote.exec', { connection: conn, argv: ['cat', 'a\0b'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects unsafe remote paths, prefixes and database names', async () => {
    exec.mockClear();
    for (const p of ['etc/passwd', '/etc/../root', '/tmp/x; id', '/tmp/$(id)', '/tmp/a b', '', '-r']) {
      expect((await opError(runOp('transfer.remote.read_file', { connection: conn, path: p }, ctx))).code, p).toBe('invalid_args');
    }
    for (const p of ['/etc/passwd', '/tmp/other.sql', '/tmp/whm-transfer-../x', '/home/bob/x']) {
      expect((await opError(runOp('transfer.remote.remove_file', { connection: conn, path: p }, ctx))).code, p).toBe('invalid_args');
    }
    for (const prefix of ['-r', 'a;b', 'Bob', '1abc', '', 'a.b']) {
      expect((await opError(runOp('transfer.remote.databases', { connection: conn, prefix }, ctx))).code, prefix).toBe('invalid_args');
      expect((await opError(runOp('transfer.remote.db_grants', { connection: conn, prefix }, ctx))).code, prefix).toBe('invalid_args');
    }
    for (const database of ['bob;drop', 'Bob_x', '--all-databases', 'a b', '']) {
      expect((await opError(runOp('transfer.remote.dump_database', { connection: conn, database }, ctx))).code, database).toBe('invalid_args');
    }
    for (const args of [{ remotePath: '/home/bob', localPath: 'home/bob' }, { remotePath: 'home/bob', localPath: '/home/bob' }, { remotePath: '/home/bob;x', localPath: '/home/bob' }, { remotePath: '/home/bob', localPath: '/home/../etc' }, { remotePath: '/home/bob', localPath: '/home/bob', excludes: ['--delete'] }, { remotePath: '/home/bob', localPath: '/home/bob', bwlimitKbps: -1 }]) {
      expect((await opError(runOp('transfer.remote.rsync', { connection: conn, ...args }, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses local destinations outside the allowed roots before connecting', async () => {
    exec.mockClear();
    if (!hasBinary('rsync')) {
      expect((await opError(runOp('transfer.remote.rsync', { connection: conn, remotePath: '/home/bob', localPath: '/etc/bob' }, ctx))).code).toBe('capability_missing');
    } else {
      expect((await opError(runOp('transfer.remote.rsync', { connection: conn, remotePath: '/home/bob', localPath: '/etc/bob' }, ctx))).code).toBe('path_not_allowed');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it.skipIf(hasBinary('ssh'))('reports a missing ssh client as a capability error without running anything', async () => {
    exec.mockClear();
    for (const name of ['transfer.remote.exec', 'transfer.remote.probe', 'transfer.remote.list_accounts']) {
      const err = await opError(runOp(name, { connection: conn, ...(name === 'transfer.remote.exec' ? { argv: ['hostname'] } : {}) }, ctx));
      expect(err.code, name).toBe('capability_missing');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it.skipIf(hasBinary('sshpass') || !hasBinary('ssh'))('requires sshpass for password logins', async () => {
    exec.mockClear();
    const err = await opError(runOp('transfer.remote.probe', { connection: { host: 'source.example.com', port: 22, user: 'root', password: 'secret' } }, ctx));
    expect(err.code).toBe('capability_missing');
    expect(err.message).toMatch(/sshpass/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('parsers', () => {
  it('parses passwd, cPanel domain maps, rsync stats and cp user files', () => {
    const users = parsePasswd('root:x:0:0:root:/root:/bin/bash\nalice:x:1001:1001::/home/alice:/bin/bash\nnobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\nbad user:x:1002:1002::/home/x:/bin/sh\n');
    expect(users).toEqual([{ username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', shell: '/bin/bash' }]);
    expect(parseUserDomains('alice.com: alice\nshop.example.net: alice\n*: nobody\n')).toEqual([{ domain: 'alice.com', username: 'alice' }, { domain: 'shop.example.net', username: 'alice' }]);
    expect(parseRsyncStats('Number of files: 1,234 (reg: 1,000, dir: 234)\nNumber of regular files transferred: 999\nTotal file size: 5,000 bytes\nTotal transferred file size: 4,000 bytes\n')).toEqual({ files: 1234, filesTransferred: 999, totalBytes: 5000, transferredBytes: 4000 });
    const cp = parseCpUserFile('DNS=Alice.com\nPLAN=gold\nCONTACTEMAIL=a@b.c\nIP=1.2.3.4\nHASSHELL=1\n');
    expect(cp).toMatchObject({ domain: 'alice.com', plan: 'gold', contactEmail: 'a@b.c', ip: '1.2.3.4', hasShell: true });
  });

  it('summarises a cpmove listing', () => {
    const s = summarizeArchive(['cpmove-bob', 'cpmove-bob/cp/bob', 'cpmove-bob/homedir', 'cpmove-bob/homedir/public_html', 'cpmove-bob/mysql/bob_x.sql', 'cpmove-bob/mysql.sql', 'cpmove-bob/dnszones/bob.com.db', 'cpmove-bob/userdata/main', 'cpmove-bob/userdata/x.bob.com', 'cpmove-bob/userdata/x.bob.com_SSL', 'cpmove-bob/addons']);
    expect(s).toMatchObject({ top: 'cpmove-bob', username: 'bob', databases: ['bob_x'], zones: ['bob.com'], userdata: ['x.bob.com'], hasHomedir: true, hasGrants: true, hasAddons: true, hasParked: false, hasCpConfig: true });
    expect(summarizeArchive(['a/x', 'b/y']).top).toBe(null);
  });
});

describe('cpmove archive ops', () => {
  it('rejects traversal, non-archives and paths outside allowed roots', async () => {
    for (const p of ['relative.tar.gz', '/tmp/whm/../etc/x.tar.gz', '']) {
      expect((await opError(runOp('transfer.cpmove.inspect', { path: p }, ctx))).code, p).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.cpmove.inspect', { path: '/etc/passwd.tar.gz' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('transfer.cpmove.inspect', { path: `${root}/notes.txt` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('transfer.cpmove.inspect', { path: `${root}/missing.tar.gz` }, ctx))).code).toBe('not_found');
    fs.writeFileSync(`${root}/junk.tar.gz`, 'this is not an archive');
    expect((await opError(runOp('transfer.cpmove.inspect', { path: `${root}/junk.tar.gz` }, ctx))).code).toBe('invalid_archive');
    for (const member of ['-x', '../etc', 'a/../b', 'a;b', '']) {
      expect((await opError(runOp('transfer.cpmove.read_member', { path: archive, member }, ctx))).code, member).toBe('invalid_args');
      expect((await opError(runOp('transfer.cpmove.extract', { path: archive, destination: root, members: [member] }, ctx))).code, member).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.cpmove.extract', { path: archive, destination: '/etc/x', members: ['cpmove-alice/homedir/*'] }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('transfer.cpmove.extract', { path: archive, destination: root, members: ['cpmove-alice/homedir/*'], owner: '-R' }, ctx))).code).toBe('invalid_args');
  });

  it('inspects a cpmove archive', async () => {
    const info = await runOp('transfer.cpmove.inspect', { path: archive }, ctx);
    expect(info).toMatchObject({ top: 'cpmove-alice', username: 'alice', databases: ['alice_shop'], hasHomedir: true, hasGrants: true, hasAddons: true, hasParked: true, hasSubdomains: true, hasCpConfig: true, userdata: ['shop.example.net'] });
    expect(info.zones.sort()).toEqual(['alice.com', 'shop.example.net']);
    expect(info.config).toMatchObject({ domain: 'alice.com', plan: 'gold', contactEmail: 'alice@alice.com', ip: '198.51.100.7' });
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  it('reads members and reports missing ones', async () => {
    const cp = await runOp('transfer.cpmove.read_member', { path: archive, member: 'cpmove-alice/cp/alice' }, ctx);
    expect(cp.exists).toBe(true);
    expect(cp.content).toContain('DNS=alice.com');
    const addons = await runOp('transfer.cpmove.read_member', { path: archive, member: 'cpmove-alice/addons' }, ctx);
    expect(addons.content.trim()).toBe('shop.example.net=shop.alice.com');
    expect(await runOp('transfer.cpmove.read_member', { path: archive, member: 'cpmove-alice/nope' }, ctx)).toMatchObject({ exists: false });
  });

  it('extracts the homedir with stripped components and a dump into staging', async () => {
    const home = `${root}/home-alice`;
    const r = await runOp('transfer.cpmove.extract', { path: archive, destination: home, members: ['cpmove-alice/homedir/*'], stripComponents: 2 }, ctx);
    expect(r.extracted).toBe(true);
    expect(fs.readFileSync(`${home}/public_html/index.html`, 'utf8')).toBe('<h1>alice</h1>');
    expect(fs.existsSync(`${home}/public_html/shop/index.html`)).toBe(true);
    expect(fs.existsSync(`${home}/.bashrc`)).toBe(true);
    expect(fs.existsSync(`${home}/cp`)).toBe(false);
    const staging = `${root}/staging`;
    await runOp('transfer.cpmove.extract', { path: archive, destination: staging, members: ['cpmove-alice/mysql/alice_shop.sql'], stripComponents: 2 }, ctx);
    expect(fs.readFileSync(`${staging}/alice_shop.sql`, 'utf8')).toContain('CREATE TABLE');
    expect(await runOp('transfer.cpmove.extract', { path: archive, destination: staging, members: ['cpmove-alice/missing/*'], stripComponents: 2 }, ctx)).toMatchObject({ extracted: false });
  });
});

describe('uploads and archive listing', () => {
  it('appends base64 chunks only to archive names inside allowed roots', async () => {
    const file = `${root}/uploads/backup-alice.tar.gz`;
    for (const p of ['/etc/x.tar.gz', '/tmp/whm/../x.tar.gz']) {
      const err = await opError(runOp('transfer.upload.append', { path: p, data: 'YQ==' }, ctx));
      expect(['invalid_args', 'path_not_allowed']).toContain(err.code);
    }
    expect((await opError(runOp('transfer.upload.append', { path: `${root}/uploads/notes.txt`, data: 'YQ==' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('transfer.upload.append', { path: file, data: 'not base64!' }, ctx))).code).toBe('invalid_args');
    const first = await runOp('transfer.upload.append', { path: file, data: Buffer.from('hello ').toString('base64'), truncate: true }, ctx);
    expect(first).toMatchObject({ bytes: 6, size: 6 });
    const second = await runOp('transfer.upload.append', { path: file, data: Buffer.from('world').toString('base64') }, ctx);
    expect(second.size).toBe(11);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello world');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const again = await runOp('transfer.upload.append', { path: file, data: Buffer.from('x').toString('base64'), truncate: true }, ctx);
    expect(again.size).toBe(1);
  });

  it('lists archives in a directory', async () => {
    const listing = await runOp('transfer.archive.list', { path: root }, ctx);
    expect(listing.exists).toBe(true);
    expect(listing.archives.map((a) => a.name)).toContain('cpmove-alice.tar.gz');
    expect(listing.archives.map((a) => a.name)).not.toContain('notes.txt');
    expect(await runOp('transfer.archive.list', { path: `${root}/nope` }, ctx)).toMatchObject({ exists: false, archives: [] });
    expect((await opError(runOp('transfer.archive.list', { path: '/etc' }, ctx))).code).toBe('path_not_allowed');
  });
});

describe('transfer.mysql.import', () => {
  it('validates its arguments and never runs with a file outside the allowed roots', async () => {
    exec.mockClear();
    for (const database of ['a;b', 'Bob', '--x', 'a b']) {
      expect((await opError(runOp('transfer.mysql.import', { path: `${root}/staging/alice_shop.sql`, database }, ctx))).code, database).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.mysql.import', { path: `${root}/x.sql`, credentials: { user: 'root;x' } }, ctx))).code).toBe('invalid_args');
    if (!hasBinary('mysql') && !hasBinary('mariadb')) {
      expect((await opError(runOp('transfer.mysql.import', { path: `${root}/staging/alice_shop.sql`, database: 'alice_shop' }, ctx))).code).toBe('capability_missing');
    } else {
      expect((await opError(runOp('transfer.mysql.import', { path: '/etc/passwd.sql', database: 'alice_shop' }, ctx))).code).toBe('path_not_allowed');
      expect((await opError(runOp('transfer.mysql.import', { path: `${root}/missing.sql`, database: 'alice_shop' }, ctx))).code).toBe('not_found');
    }
    expect(exec).not.toHaveBeenCalled();
  });
});
