import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { shellQuote, remoteCommand, parsePasswd, parseUserDomains, parseRsyncStats, summarizeArchive, parseCpUserFile, parseShadowHash, rsyncArgv, scanSql, createSqlCodeFilter, clientCommand, parseTarListing, unsafeMember, parseFingerprints } from '../src/ops/transfer.js';

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
  put('shadow', '$6$saltsalt$abcdefghijklmnopqrstuvwxyz0123456789\n');
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

// A hand-built ustar archive: tar cannot create device nodes without root, so
// the headers are written directly (type '3' = char device, '4' = block device).
function rawTar(dir, file, entries) {
  const header = (name, { type = '0', mode = 0o644, size = 0, major = 0, minor = 0 } = {}) => {
    const b = Buffer.alloc(512);
    b.write(name, 0, 100);
    b.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
    b.write('0000000\0', 108, 8); b.write('0000000\0', 116, 8);
    b.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
    b.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
    b.write('        ', 148, 8);
    b.write(type, 156, 1);
    b.write('ustar\0', 257, 6); b.write('00', 263, 2);
    b.write(`${major.toString(8).padStart(7, '0')}\0`, 329, 8);
    b.write(`${minor.toString(8).padStart(7, '0')}\0`, 337, 8);
    let sum = 0; for (const x of b) sum += x;
    b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return b;
  };
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.content || '');
    parts.push(header(e.name, { ...e, size: data.length }));
    if (data.length) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const out = path.join(dir, file);
  fs.writeFileSync(out, Buffer.concat(parts));
  return out;
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
    for (const name of ['transfer.remote.password_hash', 'transfer.remote.probe', 'transfer.remote.list_accounts', 'transfer.remote.read_file', 'transfer.remote.databases', 'transfer.remote.db_grants', 'transfer.remote.dump_database', 'transfer.remote.remove_file', 'transfer.remote.rsync', 'transfer.cpmove.inspect', 'transfer.cpmove.read_member', 'transfer.cpmove.extract', 'transfer.mysql.import', 'transfer.mysql.create_user', 'transfer.user.set_password_hash', 'transfer.upload.append', 'transfer.archive.list']) {
      expect(catalog.has(name), name).toBe(true);
    }
    expect(catalog.get('transfer.remote.remove_file').destructive).toBe(true);
    // No generic "run argv remotely" op exists: every remote command is built by a purpose-specific op.
    expect(catalog.has('transfer.remote.exec')).toBe(false);
    expect((await opError(runOp('transfer.remote.exec', { connection: conn, argv: ['rm', '-rf', '/'] }, ctx))).code).toBe('unknown_op');
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
    for (const prog of ['sh', 'bash', 'perl', 'curl', 'wget', 'python3', 'eval', '/bin/sh', 'cat;id', 'mkdir', 'chmod', 'useradd']) {
      expect(() => remoteCommand([prog, 'x']), prog).toThrow(OpError);
    }
    expect(() => remoteCommand([])).toThrow(OpError);
  });

  it('builds rsync argv that preserves permissions while ownership is reassigned later', () => {
    const argv = rsyncArgv({ transport: 'ssh -p 22', destination: 'root@src.example.com', src: '/home/bob/', dest: '/home/robert', excludes: ['tmp/', '.cpanel/caches/'], bwlimitKbps: 500 });
    expect(argv[0]).toBe('-rlpt');
    expect(argv).toEqual(expect.arrayContaining(['--partial', '--exclude=tmp/', '--bwlimit=500', '-e', 'ssh -p 22', 'root@src.example.com:/home/bob/', '/home/robert/']));
    expect(argv).not.toContain('--delete');
    // The copy runs as root: device and special files from the source are never recreated.
    for (const flag of ['-D', '--devices', '--specials', '-a', '--archive']) expect(argv, flag).not.toContain(flag);
    expect(argv.filter((a) => /^-[a-zA-Z]+$/.test(a)).some((a) => a.includes('D'))).toBe(false);
    // rsync rejects "--human-readable=0" (the option takes no argument).
    expect(argv).toContain('--no-human-readable');
    expect(argv.some((a) => a.startsWith('--human-readable'))).toBe(false);
    expect(rsyncArgv({ transport: 'ssh', destination: 'root@h', src: '/tmp/whm-transfer-x.sql', dest: '/var/lib/whm/transfers/x.sql', directory: false, deleteExtraneous: true }).slice(-3)).toEqual(['--delete', 'root@h:/tmp/whm-transfer-x.sql', '/var/lib/whm/transfers/x.sql']);
  });

  it('brackets IPv6 hosts so rsync does not split the address at its first colon', () => {
    expect(rsyncArgv({ transport: 'ssh', destination: 'root@2001:db8::1', src: '/home/bob', dest: '/home/bob' }).slice(-2)).toEqual(['root@[2001:db8::1]:/home/bob/', '/home/bob/']);
    expect(rsyncArgv({ transport: 'ssh', destination: 'root@2001:db8::1', src: '/tmp/whm-transfer-x.sql', dest: '/var/lib/whm/transfers/x.sql', directory: false }).slice(-2)).toEqual(['root@[2001:db8::1]:/tmp/whm-transfer-x.sql', '/var/lib/whm/transfers/x.sql']);
    expect(rsyncArgv({ transport: 'ssh', destination: 'root@198.51.100.7', src: '/home/bob', dest: '/home/bob' }).at(-2)).toBe('root@198.51.100.7:/home/bob/');
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
      const err = await opError(runOp('transfer.remote.probe', { connection: c }, ctx));
      expect(err.code, JSON.stringify(c)).toBe('invalid_args');
      expect((await opError(runOp('transfer.remote.password_hash', { connection: c, username: 'bob' }, ctx))).code, JSON.stringify(c)).toBe('invalid_args');
    }
    for (const username of ['-r', 'a;b', 'Root', '../x', 'bob\nroot', '', 'a'.repeat(40)]) {
      expect((await opError(runOp('transfer.remote.password_hash', { connection: conn, username }, ctx))).code, username).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.remote.probe', { connection: conn, argv: ['hostname'] }, ctx))).code).toBe('invalid_args');
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
    for (const name of ['transfer.remote.password_hash', 'transfer.remote.probe', 'transfer.remote.list_accounts']) {
      const err = await opError(runOp(name, { connection: conn, ...(name === 'transfer.remote.password_hash' ? { username: 'bob' } : {}) }, ctx));
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

  it('parses shadow hash fields', () => {
    expect(parseShadowHash('a', '$6$saltsalt$abcdefghijklmnopqrstuvwxyz')).toMatchObject({ hash: '$6$saltsalt$abcdefghijklmnopqrstuvwxyz', locked: false, available: true });
    expect(parseShadowHash('a', '!$y$j9T$abcdefghijklmnop$qrstuvwxyz0123456789')).toMatchObject({ hash: '$y$j9T$abcdefghijklmnop$qrstuvwxyz0123456789', locked: true, available: true });
    expect(parseShadowHash('a', '*')).toMatchObject({ hash: null, available: false });
    expect(parseShadowHash('a', '!!')).toMatchObject({ hash: null, locked: true, available: false });
    expect(parseShadowHash('a', 'plaintext:evil')).toMatchObject({ hash: null, available: false });
    expect(parseShadowHash('a', '')).toMatchObject({ hash: null, available: false });
  });

  it('summarises a cpmove listing', () => {
    const s = summarizeArchive(['cpmove-bob', 'cpmove-bob/cp/bob', 'cpmove-bob/homedir', 'cpmove-bob/homedir/public_html', 'cpmove-bob/mysql/bob_x.sql', 'cpmove-bob/mysql.sql', 'cpmove-bob/dnszones/bob.com.db', 'cpmove-bob/userdata/main', 'cpmove-bob/userdata/x.bob.com', 'cpmove-bob/userdata/x.bob.com_SSL', 'cpmove-bob/addons']);
    expect(s).toMatchObject({ top: 'cpmove-bob', username: 'bob', databases: ['bob_x'], zones: ['bob.com'], userdata: ['x.bob.com'], hasHomedir: true, hasGrants: true, hasAddons: true, hasParked: false, hasCpConfig: true });
    expect(summarizeArchive(['a/x', 'b/y']).top).toBe(null);
    // The top directory is passed to tar as an argument, so option-shaped names are not accepted.
    for (const top of ['-f', '--files-from=/etc/passwd', 'a b', '.hidden']) expect(summarizeArchive([`${top}/cp/bob`, `${top}/homedir`]).top, top).toBe(null);
    expect(summarizeArchive(['cpmove-bob.1/cp/bob']).top).toBe('cpmove-bob.1');
  });

  it('parses tar listings and host key fingerprints', () => {
    const listing = parseTarListing([
      '-rw-r--r-- 0/0              12 2026-10-26 19:08 cpmove-eve/cp/eve',
      'drwxr-xr-x 0/0               0 2026-10-26 19:08 cpmove-eve/homedir/',
      'brw-rw---- 0/0             8,0 2026-10-26 19:08 cpmove-eve/homedir/sda',
      'crw-rw-rw- 0/0             5,0 2026-10-26 19:08 cpmove-eve/homedir/tty',
      'lrwxrwxrwx 0/0               0 2026-10-26 19:08 cpmove-eve/homedir/link -> /etc/shadow',
      'hrw-r--r-- 0/0               0 2026-10-26 19:08 cpmove-eve/homedir/hard link to cpmove-eve/homedir/index.html',
      '-rw-r--r-- 0/0               1 2026-10-26 19:08 /etc/cron.d/evil',
      '-rw-r--r-- 0/0               1 2026-10-26 19:08 cpmove-eve/homedir/../../../tmp/evil',
      "tar: Removing leading `/' from member names",
    ].join('\n'));
    expect(listing.map((e) => [e.type, e.name])).toEqual([['-', 'cpmove-eve/cp/eve'], ['d', 'cpmove-eve/homedir/'], ['b', 'cpmove-eve/homedir/sda'], ['c', 'cpmove-eve/homedir/tty'], ['l', 'cpmove-eve/homedir/link'], ['h', 'cpmove-eve/homedir/hard'], ['-', '/etc/cron.d/evil'], ['-', 'cpmove-eve/homedir/../../../tmp/evil']]);
    expect(listing[4].link).toBe('/etc/shadow');
    expect(listing.map(unsafeMember)).toEqual([null, null, expect.stringMatching(/block device/), expect.stringMatching(/character device/), null, null, expect.stringMatching(/absolute path/), expect.stringMatching(/\.\./)]);
    expect(parseFingerprints('# Host src.example.com found: line 1 \nsrc.example.com ED25519 SHA256:abcDEF123+/=\n')).toEqual([{ type: 'ED25519', fingerprint: 'SHA256:abcDEF123+/=' }]);
    expect(parseFingerprints('256 SHA256:xyz987 [src.example.com]:2222 (ECDSA)\n')).toEqual([{ type: 'ECDSA', fingerprint: 'SHA256:xyz987' }]);
    expect(parseFingerprints('')).toEqual([]);
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

  it('inspects a cpmove archive without expanding the homedir listing', async () => {
    exec.mockClear();
    const info = await runOp('transfer.cpmove.inspect', { path: archive }, ctx);
    expect(info).toMatchObject({ top: 'cpmove-alice', username: 'alice', databases: ['alice_shop'], hasHomedir: true, hasGrants: true, hasShadow: true, hasAddons: true, hasParked: true, hasSubdomains: true, hasCpConfig: true, userdata: ['shop.example.net'] });
    const listing = exec.mock.calls.find((c) => c[0] === 'tar' && c[1][0] === '-tf');
    expect(listing[1]).toContain('--no-recursion');
    expect(listing[1]).not.toContain('*/homedir/public_html');
    // The directory entry is enough: no file below homedir/ is listed.
    expect(info.sample).toContain('cpmove-alice/homedir');
    expect(info.sample.some((e) => e.startsWith('cpmove-alice/homedir/'))).toBe(false);
    expect(info.entries).toBeLessThan(20);
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

  it('refuses archives with device nodes or escaping members before anything is extracted', async () => {
    const dest = `${root}/home-eve`;
    const devices = rawTar(root, 'devices.tar', [
      { name: 'cpmove-eve/cp/eve', content: 'DNS=eve.com\n' }, { name: 'cpmove-eve/homedir/', type: '5' }, { name: 'cpmove-eve/homedir/index.html', content: 'hi' },
      { name: 'cpmove-eve/homedir/sda', type: '4', mode: 0o660, major: 8, minor: 0 }, { name: 'cpmove-eve/homedir/tty', type: '3', mode: 0o666, major: 5, minor: 0 },
    ]);
    exec.mockClear();
    const err = await opError(runOp('transfer.cpmove.extract', { path: devices, destination: dest, members: ['cpmove-eve/homedir/*'], stripComponents: 2, owner: 'eve' }, ctx));
    expect(err.code).toBe('invalid_archive');
    expect(err.message).toMatch(/block device/);
    expect(exec.mock.calls.some((c) => c[0] === 'tar' && c[1][0] === '-xf')).toBe(false);
    expect(exec.mock.calls.some((c) => c[0] === 'chown')).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
    // Members outside the selected subtree do not matter; a device elsewhere in the archive leaves the dumps extractable.
    const only = rawTar(root, 'devices-elsewhere.tar', [{ name: 'cpmove-eve/mysql/eve_db.sql', content: 'CREATE TABLE t (id INT);\n' }, { name: 'cpmove-eve/homedir/sda', type: '4', major: 8, minor: 0 }]);
    expect(await runOp('transfer.cpmove.extract', { path: only, destination: `${root}/staging-eve`, members: ['cpmove-eve/mysql/eve_db.sql'], stripComponents: 2 }, ctx)).toMatchObject({ extracted: true });
    for (const [file, entries, re] of [
      ['absolute.tar', [{ name: 'cpmove-eve/homedir/index.html', content: 'x' }, { name: '/etc/cron.d/evil', content: 'x' }], /absolute path/],
      ['dotdot.tar', [{ name: 'cpmove-eve/homedir/index.html', content: 'x' }, { name: 'cpmove-eve/homedir/../../../tmp/evil', content: 'x' }], /\.\./],
    ]) {
      const archivePath = rawTar(root, file, entries);
      exec.mockClear();
      const e = await opError(runOp('transfer.cpmove.extract', { path: archivePath, destination: dest, members: ['*/homedir/*', '*/evil'] }, ctx));
      expect(e.code, file).toBe('invalid_archive');
      expect(e.message, file).toMatch(re);
      expect(exec.mock.calls.some((c) => c[0] === 'tar' && c[1][0] === '-xf'), file).toBe(false);
    }
    expect(fs.existsSync(dest)).toBe(false);
    // Member names follow "--" in every tar argv so an archive can never supply an option.
    exec.mockClear();
    await runOp('transfer.cpmove.extract', { path: archive, destination: `${root}/home-alice-2`, members: ['cpmove-alice/homedir/*'], stripComponents: 2 }, ctx);
    for (const call of exec.mock.calls.filter((c) => c[0] === 'tar')) expect(call[1].indexOf('--')).toBeGreaterThan(0);
    await runOp('transfer.cpmove.read_member', { path: archive, member: 'cpmove-alice/cp/alice' }, ctx);
    await runOp('transfer.cpmove.inspect', { path: archive }, ctx);
    for (const call of exec.mock.calls.filter((c) => c[0] === 'tar' && c[1][0] === '-xOf')) expect(call[1].indexOf('--')).toBeGreaterThan(0);
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

describe('dump scanning', () => {
  const ok = (sql, o = { database: 'alice_shop', definerPrefix: 'alice' }) => expect(scanSql(sql, o), sql).toBeNull();
  const bad = (sql, re, o = { database: 'alice_shop', definerPrefix: 'alice' }) => expect(scanSql(sql, o), sql).toMatch(re);

  it('accepts what mysqldump writes for one database', () => {
    ok("-- MySQL dump 10.19\n/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n/*!50503 SET NAMES utf8mb4 */;\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n-- Dumping data for table `grant`\nDROP TABLE IF EXISTS `t`;\nCREATE TABLE `t` (`event` int, `grant` int, `user` varchar(10));\nLOCK TABLES `t` WRITE;\nINSERT INTO `t` VALUES (1,2,'x'),(3,4,'y');\nUNLOCK TABLES;\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;");
    ok('CREATE DATABASE /*!32312 IF NOT EXISTS*/ `alice_shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\nUSE `alice_shop`;');
    ok('/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`alice_app`@`localhost` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS select 1 */;');
    ok('/*!50003 CREATE*/ /*!50017 DEFINER=`alice`@`localhost`*/ /*!50003 TRIGGER `t` BEFORE INSERT ON `x` FOR EACH ROW BEGIN END */;;');
    ok("CREATE DEFINER='alice_app'@'localhost' PROCEDURE p() BEGIN SELECT 1; END;");
    ok('CREATE DEFINER=`alice_app`@`%` EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1;');
  });

  it('ignores statement-like prose inside string literals and comments', () => {
    ok("INSERT INTO t VALUES ('I grant you all privileges on this');");
    ok("INSERT INTO t VALUES ('create user accounts here; DROP DATABASE mysql; USE mysql;');");
    ok("INSERT INTO t VALUES ('multi\nline text\nDROP USER x;\n');");
    ok("INSERT INTO t VALUES ('it\\'s; DROP USER x');");
    ok("INSERT INTO t VALUES ('it''s; GRANT ALL ON *.* TO x');");
    ok('/* DROP USER x; GRANT ALL ON *.* TO y */ SELECT 1;');
    ok('-- DROP USER x\n# GRANT ALL ON *.* TO y\nSELECT 1;');
    const codeOf = createSqlCodeFilter();
    expect(codeOf("INSERT INTO t VALUES ('a', 'b;c d'),")).toBe("INSERT INTO t VALUES ('a', ''),");
    expect(codeOf("('line one")).toBe('(');
    expect(codeOf("still string'), ('x'); DROP USER y;")).toBe("''), ('x'); DROP USER y;");
  });

  it('refuses user, grant, global, system-schema, file and foreign-definer statements', () => {
    bad("CREATE USER 'x'@'%' IDENTIFIED BY 'p';", /user or role management/);
    bad("CREATE\n\nUSER 'x'@'%';", /user or role management/);
    bad("DROP USER 'x'@'%';", /user or role management/);
    bad("ALTER USER 'root'@'localhost' IDENTIFIED BY 'p';", /user or role management/);
    bad("GRANT ALL PRIVILEGES ON *.* TO 'x'@'%' WITH GRANT OPTION;", /GRANT/);
    bad("GRANT SELECT ON `alice_shop`.* TO 'alice_app'@'localhost';", /GRANT/);
    bad("REVOKE ALL ON *.* FROM 'x'@'%';", /REVOKE/);
    bad("INSERT INTO t VALUES ('it\\'s'); DROP USER x;", /user or role management/);
    bad('USE mysql;', /switches to database "mysql"/);
    bad('SELECT 1; USE `sys`;', /switches to database "sys"/);
    bad('USE `alice_shop`;', /switches to database/, { database: 'alice_blog' });
    bad('DROP DATABASE alice_shop;', /DROP DATABASE/);
    bad('CREATE DATABASE /*!32312 IF NOT EXISTS*/ `mysql`;', /creates or alters database "mysql"/);
    bad('ALTER DATABASE `other` CHARACTER SET latin1;', /creates or alters database "other"/);
    bad('/*!50106 SET GLOBAL event_scheduler = ON */;', /SET GLOBAL/);
    bad('SET PERSIST max_connections = 1;', /SET GLOBAL/);
    bad("SET PASSWORD FOR 'root'@'localhost' = 'x';", /SET PASSWORD/);
    bad("CREATE FUNCTION f RETURNS STRING SONAME 'lib.so';", /SONAME/);
    bad("INSTALL PLUGIN x SONAME 'x.so';", /plugin installation/);
    bad("LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t;", /LOAD DATA/);
    bad("SELECT * FROM t INTO OUTFILE '/var/www/x.php';", /OUTFILE/);
    bad("INSERT INTO t VALUES (LOAD_FILE('/etc/shadow'));", /LOAD_FILE/);
    bad('FLUSH PRIVILEGES;', /FLUSH/);
    bad("CHANGE MASTER TO MASTER_HOST='evil';", /replication/);
    bad("SET sql_mode = 'NO_BACKSLASH_ESCAPES';", /sql_mode/);
    bad("SET sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES');", /sql_mode/);
    bad('/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */ /*!50001 CREATE VIEW `v` AS select 1 */;', /without an explicit DEFINER/);
    bad('CREATE ALGORITHM=MERGE DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1;', /DEFINER 'root'/);
    bad('/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS select 1 */;', /DEFINER 'root'/);
    bad("CREATE DEFINER='bob_app'@'localhost' PROCEDURE p() BEGIN END;", /DEFINER 'bob_app'/);
    bad('CREATE PROCEDURE p() BEGIN END;', /without an explicit DEFINER/);
    bad('CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN END;', /without an explicit DEFINER/);
    bad('CREATE DEFINER=CURRENT_USER PROCEDURE p() BEGIN END;', /CURRENT_USER/);
    bad('CREATE DEFINER = CURRENT_USER() FUNCTION f() RETURNS INT RETURN 1;', /CURRENT_USER/);
  });

  it('refuses @@global / @@persist assignments in every spelling', () => {
    bad('SET @@global.event_scheduler=ON;', /SET GLOBAL/);
    bad('SET @@GLOBAL.event_scheduler = ON;', /SET GLOBAL/);
    bad('SET @@ global . max_connections = 1;', /SET GLOBAL/);
    bad('SET @@persist.max_connections = 1;', /SET GLOBAL/);
    bad('SET @@PERSIST_ONLY.max_connections = 1;', /SET GLOBAL/);
    bad("/*!80000 SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'aaaa:1-5' */;", /GTID.*--set-gtid-purged=OFF/);
    bad('SET @@SESSION.SQL_LOG_BIN= 0;', /GTID and binary-log/);
    ok('/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\nSET @@session.foreign_key_checks = 0;\nSET @@SESSION.unique_checks=0;');
  });

  it('refuses statements that target the privilege tables or another schema', () => {
    bad("UPDATE mysql.user SET authentication_string='' WHERE User='root';", /system schema "mysql"/);
    bad("UPDATE `mysql`.`user` SET authentication_string='' WHERE User='root';", /system schema "mysql"/);
    bad("INSERT INTO mysql.global_grants VALUES ('x','%','SYSTEM_USER','N');", /system schema "mysql"/);
    bad('CREATE TABLE mysql.x (id INT);', /system schema "mysql"/);
    bad('REPLACE INTO mysql . db VALUES (1);', /system schema "mysql"/);
    bad('DELETE FROM performance_schema.setup_actors;', /system schema "performance_schema"/);
    bad('SELECT * FROM sys.session;', /system schema "sys"/);
    bad('DROP TABLE bob_db.orders;', /targets "bob_db.orders" outside database "alice_shop"/);
    bad('DROP TABLE IF EXISTS `t`, `bob_db`.`orders`;', /targets "bob_db.orders"/);
    bad('INSERT INTO bob_db.orders VALUES (1);', /targets "bob_db.orders"/);
    bad('UPDATE bob_db.orders SET paid = 1;', /targets "bob_db.orders"/);
    bad('DELETE FROM bob_db.orders;', /targets "bob_db.orders"/);
    bad('TRUNCATE TABLE bob_db.orders;', /targets "bob_db.orders"/);
    bad('ALTER TABLE bob_db.orders ADD COLUMN x INT;', /targets "bob_db.orders"/);
    bad('RENAME TABLE t TO bob_db.t;', /targets "bob_db.t"/);
    bad('LOCK TABLES bob_db.orders WRITE;', /targets "bob_db.orders"/);
    bad('CREATE DEFINER=`alice`@`localhost` VIEW bob_db.v AS SELECT 1;', /targets "bob_db.v"/);
    bad('CREATE DEFINER=`alice`@`localhost` TRIGGER t BEFORE INSERT ON bob_db.orders FOR EACH ROW BEGIN END;', /targets "bob_db.orders"/);
    bad('CREATE INDEX i ON bob_db.orders (id);', /targets "bob_db.orders"/);
    bad('CREATE DEFINER=`alice`@`localhost` PROCEDURE bob_db.p() BEGIN END;', /targets "bob_db.p"/);
    bad('CALL bob_db.p();', /targets "bob_db.p"/);
    bad('CREATE TABLE ALICE_BLOG.t (id INT);', /targets "ALICE_BLOG.t"/);
    // Qualified names of the target database, column references and literals are fine.
    ok('INSERT INTO alice_shop.t VALUES (1);\nDROP TABLE IF EXISTS `alice_shop`.`t`;\nCREATE TABLE `alice_shop`.`t` (id INT);');
    ok('/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`alice_app`@`localhost` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS select `alice_shop`.`t`.`id` AS `id` from `alice_shop`.`t` join `u` on `t`.`uid` = `u`.`id` */;');
    ok("INSERT INTO t VALUES ('mysql.user', 'UPDATE mysql.user SET x=1'), ('bob_db.orders');");
    ok('CREATE TABLE `t` (`id` int NOT NULL, `ts` timestamp ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (`id`) REFERENCES `u` (`id`) ON DELETE CASCADE);');
  });

  it('refuses the remaining file, instance and engine statements', () => {
    bad("LOAD XML INFILE '/etc/passwd' INTO TABLE t;", /LOAD DATA \/ LOAD XML INFILE/);
    bad("LOAD XML LOCAL INFILE '/etc/passwd' INTO TABLE t;", /LOAD XML/);
    bad('ALTER INSTANCE ROTATE INNODB MASTER KEY;', /server instance/);
    bad("CREATE TABLESPACE ts ADD DATAFILE '/var/www/x.ibd';", /TABLESPACE/);
    bad("CREATE TABLE t (id INT) DATA DIRECTORY='/var/www';", /DATA DIRECTORY/);
    bad("CREATE TABLE t (id INT) INDEX DIRECTORY = '/var/www';", /DATA DIRECTORY/);
    bad("CREATE TABLE t (id INT) ENGINE=FEDERATED CONNECTION='mysql://root@10.0.0.1/db/t';", /storage engine/);
    bad("CREATE TABLE t (id INT) ENGINE=CONNECT TABLE_TYPE=DOS FILE_NAME='/etc/passwd';", /storage engine/);
    bad("CREATE SERVER s FOREIGN DATA WRAPPER mysql OPTIONS (HOST '10.0.0.1');", /CREATE SERVER/);
    bad("IMPORT TABLE FROM '/tmp/x.sdi';", /IMPORT TABLE/);
    bad('SET ROLE ALL;', /SET ROLE/);
    bad('RESET MASTER;', /replication/);
    bad("BINLOG 'AAAA';", /replication/);
    bad('FLUSH TABLES WITH READ LOCK;', /FLUSH/);
    ok('CREATE TABLE t (id INT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\nFLUSH TABLES t;');
  });

  it('refuses mysql client commands, which the client runs as the user importing', () => {
    bad('system id', /client command "system"/);
    bad('system id;', /client command "system"/);
    bad('SELECT 1; system id;', /client command "system"/);
    bad('  SYSTEM id', /client command "system"/);
    bad('system\tid', /client command "system"/);
    bad('tee /etc/cron.d/x', /client command "tee"/);
    bad('tee /etc/cron.d/x;\nSELECT 1;', /client command "tee"/);
    bad('pager sh', /client command "pager"/);
    bad('source /etc/whm/other.sql', /client command "source"/);
    bad('connect mysql', /client command "connect"/);
    bad('charset gbk', /client command "charset"/);
    bad('status', /client command "status"/);
    bad('\\! id', /backslash command/);
    bad('\\!id', /backslash command/);
    bad('SELECT 1 \\! id', /backslash command/);
    bad('SELECT 1;\\! id', /backslash command/);
    bad('\\T /etc/cron.d/x', /backslash command/);
    bad('\\. /etc/whm/other.sql', /backslash command/);
    bad('\\P sh', /backslash command/);
    bad('SELECT 1\\G', /backslash command/);
    bad('/*! \\! id */ SELECT 1;', /backslash command/);
    bad('/*+ \\! id */ SELECT 1;', /backslash command/);
    bad('DELIMITER $$x', /statement delimiter/);
    bad('DELIMITER system', /statement delimiter/);
    bad('use mysql', /switches to database "mysql"/);
    bad('use `bob_db`', /switches to database "bob_db"/);
    // What the client itself treats as SQL or a plain comment is accepted.
    ok('status int,\nedit varchar(10),\nsource_id INT;');
    ok('/* \\! id */ SELECT 1;\n-- \\! id\n# \\T /etc/x\nSELECT 1;');
    ok("INSERT INTO t VALUES ('\\\\! id', 'system id', 'tee /etc/x', 'a\\'b');");
    ok("INSERT INTO t VALUES ('line one\nsystem id\n\\! id\nline four');");
    ok('INSERT INTO t VALUES (\\N, 1);');
    ok('INSERT INTO `sys\\tem` VALUES (1);');
    ok('DELIMITER ;;\nCREATE DEFINER=`alice`@`localhost` TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SELECT 1; END ;;\nDELIMITER ;\nSELECT 1;');
    ok('DELIMITER //\nCREATE DEFINER=`alice_app`@`localhost` PROCEDURE p() BEGIN SELECT 1; SELECT 2; END //\nDELIMITER ;');
    // A "system" statement after a ";;" delimiter switch is still a statement start.
    bad('DELIMITER ;;\nSELECT 1 ;;\nsystem id ;;', /client command "system"/);
    bad('DELIMITER ;;\nsystem id\n', /client command "system"/);
  });

  it('mirrors find_command(): long forms need the first word, bare-word commands take no arguments', () => {
    expect(clientCommand('system id')).toEqual({ name: 'system', args: 'id' });
    expect(clientCommand('   TEE   /tmp/x  ')).toEqual({ name: 'tee', args: '/tmp/x  ' });
    expect(clientCommand('status')).toEqual({ name: 'status', args: '' });
    expect(clientCommand('status int')).toBe(null);
    expect(clientCommand('system\nid')).toBe(null);
    expect(clientCommand('systemd restart')).toBe(null);
    expect(clientCommand('')).toBe(null);
    expect(clientCommand('SELECT system')).toBe(null);
  });
});

describe('transfer.mysql.import', () => {
  it('validates its arguments and never runs with a file outside the allowed roots', async () => {
    exec.mockClear();
    for (const database of ['a;b', 'Bob', '--x', 'a b', '']) {
      expect((await opError(runOp('transfer.mysql.import', { path: `${root}/staging/alice_shop.sql`, database }, ctx))).code, database).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.mysql.import', { path: `${root}/staging/alice_shop.sql` }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('transfer.mysql.import', { path: `${root}/x.sql`, database: 'alice_shop', credentials: { user: 'root;x' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('transfer.mysql.import', { path: `${root}/x.sql`, database: 'alice_shop', definerPrefix: 'Alice' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('transfer.mysql.import', { path: '/etc/passwd.sql', database: 'alice_shop' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('transfer.mysql.import', { path: `${root}/missing.sql`, database: 'alice_shop' }, ctx))).code).toBe('not_found');
    for (const database of ['mysql', 'sys', 'information_schema', 'performance_schema']) {
      expect((await opError(runOp('transfer.mysql.import', { path: `${root}/staging/alice_shop.sql`, database }, ctx))).code, database).toBe('refused');
    }
    // The path goes to the client's "source" line, which tokenises on whitespace and ";".
    for (const name of ['a b.sql', 'x;drop.sql', "it's.sql", 'tab\there.sql']) {
      const err = await opError(runOp('transfer.mysql.import', { path: `${root}/staging/${name}`, database: 'alice_shop' }, ctx));
      expect(err.code, name).toBe('refused');
      expect(err.message, name).toMatch(/source/);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a dump carrying privilege or system-schema statements before the client runs', async () => {
    exec.mockClear();
    const evil = `${root}/staging/evil.sql`;
    fs.mkdirSync(path.dirname(evil), { recursive: true });
    fs.writeFileSync(evil, `${'INSERT INTO t VALUES (1);\n'.repeat(50)}USE mysql;\nUPDATE user SET authentication_string='' WHERE User='root';\n`);
    const err = await opError(runOp('transfer.mysql.import', { path: evil, database: 'alice_shop', definerPrefix: 'alice' }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/line 51: the dump switches to database "mysql"/);
    fs.writeFileSync(evil, "CREATE TABLE t (id INT);\nCREATE\n  USER 'evil'@'%' IDENTIFIED BY 'x';\n");
    expect((await opError(runOp('transfer.mysql.import', { path: evil, database: 'alice_shop' }, ctx))).message).toMatch(/line 3: user or role management/);
    fs.writeFileSync(evil, "CREATE TABLE t (id INT);\nCREATE DEFINER=`root`@`localhost` PROCEDURE p() BEGIN END;\n");
    expect((await opError(runOp('transfer.mysql.import', { path: evil, database: 'alice_shop', definerPrefix: 'alice' }, ctx))).message).toMatch(/DEFINER 'root'/);
    fs.writeFileSync(evil, "CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\nsystem touch /etc/cron.d/x\n");
    expect((await opError(runOp('transfer.mysql.import', { path: evil, database: 'alice_shop', definerPrefix: 'alice' }, ctx))).message).toMatch(/line 3: the dump contains the mysql client command "system"/);
    fs.writeFileSync(evil, "CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1); \\! id\n");
    expect((await opError(runOp('transfer.mysql.import', { path: evil, database: 'alice_shop', definerPrefix: 'alice' }, ctx))).message).toMatch(/line 2: the dump contains a backslash command/);
    fs.writeFileSync(evil, "CREATE TABLE t (id INT);\nUPDATE mysql.user SET authentication_string='' WHERE User='root';\n");
    expect((await opError(runOp('transfer.mysql.import', { path: evil, database: 'alice_shop', definerPrefix: 'alice' }, ctx))).message).toMatch(/line 2: the dump references the system schema "mysql"/);
    fs.writeFileSync(evil, "CREATE TABLE t (id INT);\nSET @@global.event_scheduler=ON;\n");
    expect((await opError(runOp('transfer.mysql.import', { path: evil, database: 'alice_shop', definerPrefix: 'alice' }, ctx))).message).toMatch(/line 2: SET GLOBAL/);
    expect(exec).not.toHaveBeenCalled();
    // A clean dump passes the scan; without a client it stops at the capability check.
    if (!hasBinary('mysql') && !hasBinary('mariadb')) {
      expect((await opError(runOp('transfer.mysql.import', { path: `${root}/staging/alice_shop.sql`, database: 'alice_shop', definerPrefix: 'alice' }, ctx))).code).toBe('capability_missing');
      expect(exec).not.toHaveBeenCalled();
    }
  });
});

describe('transfer.mysql.create_user', () => {
  it('rejects users, hosts, hashes and privileges that are not strictly needed', async () => {
    exec.mockClear();
    const base = { user: 'alice_app', host: 'localhost', ownerPrefix: 'alice', auth: { plugin: 'mysql_native_password', hash: '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19' }, grants: [{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'] }] };
    const invalid = [
      { user: "alice_app'@'%" }, { user: 'Alice' }, { user: 'alice;drop' }, { host: "localhost'" }, { host: 'a b' }, { host: '' },
      { auth: { plugin: 'unix_socket', hash: '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19' } }, { auth: { plugin: 'mysql_native_password', hash: "' OR 1" } }, { auth: { plugin: 'mysql_native_password', hash: '*abc' } },
      { grants: [{ database: 'alice_shop', privileges: ['SUPER'] }] }, { grants: [{ database: 'alice_shop', privileges: ['FILE'] }] }, { grants: [{ database: 'alice_shop', privileges: ['GRANT OPTION'] }] },
      { grants: [{ database: 'alice_shop', privileges: [] }] }, { grants: [{ database: '*', privileges: ['SELECT'] }] }, { grants: [{ database: 'alice_shop', privileges: ['SELECT'], table: 'x' }] },
      { ownerPrefix: 'Alice' }, { extra: 1 },
    ];
    for (const patch of invalid) {
      expect((await opError(runOp('transfer.mysql.create_user', { ...base, ...patch }, ctx))).code, JSON.stringify(patch)).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.mysql.create_user', { ...base, user: 'bob_app' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('transfer.mysql.create_user', { ...base, user: 'root' }, ctx))).code).toBe('refused');
    for (const database of ['mysql', 'sys', 'bob_shop', 'alicex']) {
      expect((await opError(runOp('transfer.mysql.create_user', { ...base, grants: [{ database, privileges: ['SELECT'] }] }, ctx))).code, database).toBe('refused');
    }
    expect(exec).not.toHaveBeenCalled();
    if (!hasBinary('mysql') && !hasBinary('mariadb')) {
      expect((await opError(runOp('transfer.mysql.create_user', base, ctx))).code).toBe('capability_missing');
      expect(exec).not.toHaveBeenCalled();
    }
  });
});

describe('transfer.user.set_password_hash', () => {
  it('accepts only crypt hashes for managed users and never touches system accounts', async () => {
    exec.mockClear();
    const hash = '$6$saltsalt$abcdefghijklmnopqrstuvwxyz0123456789';
    for (const bad of ['plain', '$6$', 'x:y', `${hash}\nroot:x`, '$6$salt$with space', '', '!$6$saltsalt$abcdefghijklmnopq']) {
      expect((await opError(runOp('transfer.user.set_password_hash', { username: 'alice', hash: bad }, ctx))).code, bad).toBe('invalid_args');
    }
    for (const username of ['-r', 'Alice', 'a;b', '../x']) {
      expect((await opError(runOp('transfer.user.set_password_hash', { username, hash }, ctx))).code, username).toBe('invalid_args');
    }
    expect((await opError(runOp('transfer.user.set_password_hash', { username: 'definitely-no-such-user-xyz', hash }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('transfer.user.set_password_hash', { username: 'root', hash }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });
});
