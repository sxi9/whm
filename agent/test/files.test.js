import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { assertUnderHome, resolveUnderHome, landsInSshDir, asUserArgv, assertManaged, accountPath, SYSTEM_USERS } from '../src/ops/as-user.js';
import { CHUNK_READ_MAX, FIND_FORMAT, EXTRACT_MAX_BYTES, STDIN_ARCHIVE, parseFind, readRangeArgv, parseTarListing, parseZipListing, checkArchiveMembers, listArchiveArgv, resolveMemberPath, diskLinkReader, sshFingerprint, sshChanges } from '../src/ops/files.js';

// exec is spied with the real implementation behind it so every test proves an
// op refused before any program ran. No files.* op is ever executed here: each
// would run a command under a real account's uid.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const MiB = 1024 * 1024;
const OPS = ['files.list', 'files.stat', 'files.read', 'files.chunk_read', 'files.write', 'files.chunk_write', 'files.mkdir', 'files.move', 'files.copy', 'files.remove', 'files.chmod', 'files.du', 'files.archive', 'files.extract'];

// A hosting account the tests may name without changing anything (every op
// refuses before a command runs). Its home must sit under an allowed root.
const MANAGED = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find(([name, , uid, , , home]) => Number(uid) >= 1000 && Number(uid) < 65534 && /^\/home\//.test(home || '') && !SYSTEM_USERS.has(name));
const USER = MANAGED?.[0] ?? null;
const HOME = MANAGED?.[5] ?? null;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

// Minimal valid arguments per op, against which single fields are then corrupted.
function validArgs(op, home = '/home/alice') {
  const p = `${home}/public_html/index.html`;
  switch (op) {
    case 'files.move': case 'files.copy': return { username: 'alice', from: p, to: `${home}/public_html/copy.html` };
    case 'files.remove': return { username: 'alice', paths: [p] };
    case 'files.write': return { username: 'alice', path: p, content: 'hello' };
    case 'files.chunk_write': return { username: 'alice', path: p, data: 'aGVsbG8=' };
    case 'files.chmod': return { username: 'alice', path: p, mode: '0644' };
    case 'files.archive': return { username: 'alice', paths: [p], dest: `${home}/backup.zip`, format: 'zip' };
    case 'files.extract': return { username: 'alice', archive: `${home}/backup.zip`, dest: `${home}/restored` };
    default: return { username: 'alice', path: p };
  }
}

const pathFields = (op) => (['files.move', 'files.copy'].includes(op) ? ['from', 'to'] : op === 'files.remove' ? ['paths'] : op === 'files.archive' ? ['paths', 'dest'] : op === 'files.extract' ? ['archive', 'dest'] : ['path']);

describe('files op catalog', () => {
  it('registers every op of the family with the documented destructive flags', () => {
    for (const name of OPS) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('files.remove').destructive).toBe(true);
    for (const name of OPS.filter((n) => n !== 'files.remove')) expect(catalog.get(name).destructive, name).toBe(false);
    expect(catalog.get('files.archive').timeoutMs).toBe(1_800_000);
    expect(catalog.get('files.extract').timeoutMs).toBe(1_800_000);
  });
});

describe('files.list record format', () => {
  it('passes exec()\'s NUL check and still yields NUL-separated records (names may hold newlines and tabs)', async () => {
    expect(FIND_FORMAT.includes('\0')).toBe(false);
    expect(FIND_FORMAT.endsWith('\\0')).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-find-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'odd\tname\nhere'), 'yy');
      const r = await exec('find', ['-P', dir, '-mindepth', '1', '-maxdepth', '1', '-printf', FIND_FORMAT]);
      expect(r.stdout.split('\0').filter(Boolean)).toHaveLength(3);
      const entries = parseFind(r.stdout);
      expect(entries.map((e) => [e.name, e.type, e.size])).toEqual([['sub', 'dir', entries[0].size], ['a.txt', 'file', 1], ['odd\tname\nhere', 'file', 2]]);
      expect(entries[1].mode).toMatch(/^0[0-7]{3}$/);
      expect(entries[1].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('files.* schemas reject injection, traversal and option smuggling before anything runs', () => {
  it('rejects usernames that are not a plain account name', async () => {
    exec.mockClear();
    for (const op of OPS) {
      for (const username of ['-root', 'Admin', 'a;b', '../x', '', 'alice user', '$(id)', 'bob\n']) {
        const err = await opError(runOp(op, { ...validArgs(op), username }, ctx));
        expect(err.code, `${op} ${JSON.stringify(username)}`).toBe('invalid_args');
      }
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses system accounts (root) and unknown users without touching the host', async () => {
    exec.mockClear();
    for (const op of OPS) {
      expect((await opError(runOp(op, { ...validArgs(op, '/home/root'), username: 'root' }, ctx))).code, op).toBe('refused');
      expect((await opError(runOp(op, { ...validArgs(op, '/home/daemon'), username: 'daemon' }, ctx))).code, op).toBe('refused');
      const ghost = `nouser${crypto.randomBytes(3).toString('hex')}`;
      expect((await opError(runOp(op, { ...validArgs(op, `/home/${ghost}`), username: ghost }, ctx))).code, op).toBe('not_found');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects relative paths, "..", NUL and empty paths in every path field', async () => {
    exec.mockClear();
    const bad = ['public_html/index.html', '/home/alice/../etc/passwd', '/home/alice/public_html/..', '/home/alice/x\0y', '', '../', '/home/alice/./../../etc'];
    for (const op of OPS) {
      for (const field of pathFields(op)) {
        for (const value of bad) {
          if (value === '/home/alice/./../../etc') continue;
          const args = { ...validArgs(op), [field]: field === 'paths' ? [value] : value };
          const err = await opError(runOp(op, args, ctx));
          expect(err.code, `${op}.${field}=${JSON.stringify(value)}`).toBe('invalid_args');
        }
      }
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects unknown keys, bad limits, modes, formats and chunk encodings', async () => {
    exec.mockClear();
    const cases = [
      ['files.list', { ...validArgs('files.list'), limit: 10001 }],
      ['files.list', { ...validArgs('files.list'), limit: 0 }],
      ['files.list', { ...validArgs('files.list'), follow: true }],
      ['files.read', { ...validArgs('files.read'), maxBytes: 4 * MiB + 1 }],
      ['files.chunk_read', { ...validArgs('files.chunk_read'), length: CHUNK_READ_MAX + 1 }],
      ['files.chunk_read', { ...validArgs('files.chunk_read'), length: 8 * MiB }],
      ['files.extract', { ...validArgs('files.extract'), allowSshDir: 'yes' }],
      ['files.write', { ...validArgs('files.write'), protectSshDir: 'yes' }],
      ['files.remove', { ...validArgs('files.remove'), protectSshDir: 1 }],
      ['files.move', { ...validArgs('files.move'), protectSshDir: null }],
      ['files.chunk_read', { ...validArgs('files.chunk_read'), offset: -1 }],
      ['files.write', { ...validArgs('files.write'), mode: '0778' }],
      ['files.write', { ...validArgs('files.write'), mode: 'u+x' }],
      ['files.write', { ...validArgs('files.write'), content: 'x'.repeat(4 * MiB + 1) }],
      ['files.chunk_write', { ...validArgs('files.chunk_write'), data: 'not base64!' }],
      ['files.chunk_write', { ...validArgs('files.chunk_write'), data: '' }],
      ['files.mkdir', { ...validArgs('files.mkdir'), mode: '0778' }],
      ['files.mkdir', { ...validArgs('files.mkdir'), mode: '-p' }],
      ['files.chmod', { ...validArgs('files.chmod'), mode: '0778' }],
      ['files.chmod', { ...validArgs('files.chmod'), mode: '-R' }],
      ['files.chmod', { ...validArgs('files.chmod'), recursive: 'yes' }],
      ['files.remove', { ...validArgs('files.remove'), paths: [] }],
      ['files.remove', { ...validArgs('files.remove'), paths: Array.from({ length: 201 }, (_, i) => `/home/alice/f${i}`) }],
      ['files.du', { ...validArgs('files.du'), depth: 3 }],
      ['files.archive', { ...validArgs('files.archive'), format: 'rar' }],
      ['files.archive', { ...validArgs('files.archive'), paths: Array.from({ length: 501 }, (_, i) => `/home/alice/f${i}`) }],
      ['files.archive', { ...validArgs('files.archive'), dest: '-o' }],
      ['files.move', { ...validArgs('files.move'), overwrite: 'force' }],
      ['files.extract', { ...validArgs('files.extract'), strip: 1 }],
    ];
    for (const [op, args] of cases) expect((await opError(runOp(op, args, ctx))).code, `${op} ${JSON.stringify(args).slice(0, 80)}`).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('range reads are bounded and dumped without a shell', () => {
  it('caps one chunk read at 2 MiB whatever the caller asks for', () => {
    expect(CHUNK_READ_MAX).toBe(2 * MiB);
    const schema = catalog.get('files.chunk_read').schema;
    expect(schema.safeParse({ username: 'alice', path: '/home/alice/x', length: CHUNK_READ_MAX }).success).toBe(true);
    expect(schema.safeParse({ username: 'alice', path: '/home/alice/x', length: CHUNK_READ_MAX + 1 }).success).toBe(false);
    expect(schema.parse({ username: 'alice', path: '/home/alice/x' }).length).toBe(CHUNK_READ_MAX);
  });

  it('builds the hexdump argv (two characters per byte) and the od fallback, with a stdout buffer sized to the range', () => {
    expect(readRangeArgv('/home/alice/big.bin', 4096, 1024, 'hexdump')).toEqual(['hexdump', ['-v', '-e', '1/1 "%02x"', '-s', '4096', '-n', '1024', '--', '/home/alice/big.bin'], 2 * 1024 + MiB]);
    expect(readRangeArgv('/home/alice/-dash', 0, 7, 'od')).toEqual(['od', ['-An', '-v', '-tx1', '-w4096', '-j', '0', '-N', '7', '--', '/home/alice/-dash'], 3 * 7 + MiB]);
    const [bin] = readRangeArgv('/home/alice/x', 0, 1);
    expect(bin).toBe(hasBinary('hexdump') ? 'hexdump' : 'od');
  });
});

describe('archive member inspection before extraction', () => {
  const home = '/home/alice';
  const TAR = [
    'drwxr-xr-x alice/alice       0 2026-11-01 10:00 site/',
    '-rw-r--r-- alice/alice    1234 2026-11-01 10:00 site/index.html',
    'lrwxrwxrwx alice/alice       0 2026-11-01 10:00 site/current -> ./index.html',
    'hrw-r--r-- alice/alice       0 2026-11-01 10:00 site/copy.html link to site/index.html',
    '-rw-r--r-- alice/alice      12 2026-11-01 10:00:15 with space.txt',
  ].join('\n');
  const ZIP = [
    'Archive:  /home/alice/site.zip',
    'Zip file size: 1234 bytes, number of entries: 3',
    'drwxr-xr-x  3.0 unx        0 bx stor 26-Nov-01 10:00 site/',
    '-rw-r--r--  3.0 unx     1234 tx defN 26-Nov-01 10:00 site/index.html',
    'lrwxrwxrwx  3.0 unx       10 tx stor 26-Nov-01 10:00 site/current',
    '-rw-a--     2.0 fat      512 bx defN 26-Nov-01 10:00 README.TXT',
    '3 files, 1756 bytes uncompressed, 900 bytes compressed:  48.7%',
  ].join('\n');

  it('parses tar and zipinfo listings into typed members, keeping names with spaces and link targets', () => {
    expect(parseTarListing(TAR)).toEqual([
      { type: 'dir', name: 'site/', target: null },
      { type: 'file', name: 'site/index.html', target: null },
      { type: 'symlink', name: 'site/current', target: './index.html' },
      { type: 'hardlink', name: 'site/copy.html', target: 'site/index.html' },
      { type: 'file', name: 'with space.txt', target: null },
    ]);
    expect(parseZipListing(ZIP)).toEqual([
      { type: 'dir', name: 'site/', target: null },
      { type: 'file', name: 'site/index.html', target: null },
      { type: 'symlink', name: 'site/current', target: null },
      { type: 'file', name: 'README.TXT', target: null },
    ]);
    expect(listArchiveArgv(true, '/home/alice/a.zip')).toEqual(['unzip', ['-Z', '--', '/home/alice/a.zip']]);
    expect(listArchiveArgv(false, '/home/alice/a.tgz')).toEqual(['tar', ['--list', '--verbose', '--file', '/home/alice/a.tgz']]);
  });

  it('accepts members that stay inside the destination, including relative links within it', () => {
    expect(checkArchiveMembers(parseTarListing(TAR), { home, dest: `${home}/public_html` })).toBe(5);
    expect(checkArchiveMembers(parseTarListing(TAR), { home, dest: home })).toBe(5);
    expect(checkArchiveMembers([{ type: 'file', name: './a/b', target: null }, { type: 'file', name: 'a/./c', target: null }], { home, dest: home })).toBe(2);
  });

  it('refuses absolute and ".." member names and links that point out of the destination', () => {
    for (const name of ['/etc/cron.d/x', '../other', 'a/../../b', 'a/..']) {
      expect(() => checkArchiveMembers([{ type: 'file', name, target: null }], { home, dest: `${home}/x` }), name).toThrow(/outside the destination/);
    }
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'up', target: '../../etc' }], { home, dest: `${home}/x` })).toThrow(/pointing outside/);
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'abs', target: '/tmp' }], { home, dest: `${home}/x` })).toThrow(/pointing outside/);
    expect(checkArchiveMembers([{ type: 'symlink', name: 'd/up', target: '..' }], { home, dest: `${home}/x` })).toBe(1);
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'd/up', target: '../..' }], { home, dest: `${home}/x` })).toThrow(/pointing outside/);
    expect(checkArchiveMembers([{ type: 'symlink', name: 'd/sib', target: '../e' }], { home, dest: `${home}/x` })).toBe(1);
  });

  it('keeps .ssh for the SSH-key feature unless the caller may write it directly', () => {
    const planted = parseTarListing('-rw------- alice/alice 100 2026-11-01 10:00 .ssh/authorized_keys');
    expect(() => checkArchiveMembers(planted, { home, dest: home })).toThrow(/into \.ssh/);
    expect(() => checkArchiveMembers(planted, { home, dest: home, allowSshDir: false })).toThrow(/into \.ssh/);
    expect(checkArchiveMembers(planted, { home, dest: home, allowSshDir: true })).toBe(1);
    expect(checkArchiveMembers(planted, { home, dest: `${home}/public_html` })).toBe(1);
    expect(() => checkArchiveMembers([{ type: 'file', name: '.ssh', target: null }], { home, dest: home })).toThrow(/into \.ssh/);
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'keys', target: '.ssh' }], { home, dest: home })).toThrow(/link into \.ssh/);
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'd/keys', target: '../../.ssh' }], { home, dest: `${home}/x` })).toThrow(/pointing outside/);
    // A name containing " -> " cannot hide a link target from the check.
    const tricky = parseTarListing('lrwxrwxrwx alice/alice 0 2026-11-01 10:00 x -> y -> ../.ssh');
    expect(tricky).toEqual([{ type: 'symlink', name: 'x -> y', target: '../.ssh' }]);
    expect(() => checkArchiveMembers(tricky, { home, dest: `${home}/x` })).toThrow(/pointing outside/);
    // zip symlinks carry no listed target, so they are refused while .ssh is protected.
    const zipLink = parseZipListing('lrwxrwxrwx  3.0 unx       10 tx stor 26-Nov-01 10:00 site/current');
    expect(() => checkArchiveMembers(zipLink, { home, dest: `${home}/x` })).toThrow(/symbolic link; zip/);
    expect(checkArchiveMembers(zipLink, { home, dest: `${home}/x`, allowSshDir: true })).toBe(1);
    expect(checkArchiveMembers([{ type: 'file', name: '.sshx/k', target: null }, { type: 'file', name: 'a/.ssh/k', target: null }], { home, dest: home })).toBe(2);
  });

  it('follows link chains the way tar writes them: a later member through an earlier link, or through a link already on disk', () => {
    // GNU tar creates `x -> .` and `y -> x/.ssh` as it reads them, then opens
    // y/authorized_keys through them: that lands in <home>/.ssh.
    const chain = parseTarListing([
      'lrwxrwxrwx alice/alice 0 2026-11-01 10:00 x -> .',
      'lrwxrwxrwx alice/alice 0 2026-11-01 10:00 y -> x/.ssh',
      '-rw------- alice/alice 100 2026-11-01 10:00 y/authorized_keys',
    ].join('\n'));
    expect(() => checkArchiveMembers(chain, { home, dest: home })).toThrow(/\.ssh/);
    expect(checkArchiveMembers(chain, { home, dest: home, allowSshDir: true })).toBe(3);
    // A link to the destination itself (the home) is a link to .ssh's parent.
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'x', target: '.' }], { home, dest: home })).toThrow(/parent directory/);
    expect(checkArchiveMembers([{ type: 'symlink', name: 'x', target: '.' }], { home, dest: `${home}/public_html` })).toBe(1);
    // ".." after a link is resolved against the link's target, not the name.
    const upThrough = [{ type: 'symlink', name: 'x', target: '.' }, { type: 'symlink', name: 'y', target: 'x/..' }, { type: 'file', name: 'y/.ssh/authorized_keys', target: null }];
    expect(() => checkArchiveMembers(upThrough, { home, dest: `${home}/sub` })).toThrow(/outside the destination/);
    expect(resolveMemberPath('y/.ssh/k', { dest: `${home}/sub`, links: new Map([['x', '.'], ['y', 'x/..']]) })).toBe(`${home}/.ssh/k`);
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'y', target: 'x/..' }, { type: 'file', name: 'y/.ssh/k', target: null }], { home, dest: `${home}/sub`, readLink: (abs) => (abs === `${home}/sub/x` ? '.' : null) })).toThrow(/outside the destination/);
    // A hard link into .ssh, or out of the destination, is refused too.
    expect(() => checkArchiveMembers(parseTarListing('hrw------- alice/alice 0 2026-11-01 10:00 k link to .ssh/authorized_keys'), { home, dest: home })).toThrow(/hard link into \.ssh/);
    expect(() => checkArchiveMembers([{ type: 'hardlink', name: 'k', target: '../etc/passwd' }], { home, dest: `${home}/x` })).toThrow(/hard link pointing outside/);
    expect(checkArchiveMembers([{ type: 'hardlink', name: 'k', target: 'site/index.html' }], { home, dest: home })).toBe(1);
    // Links already on disk (readLink) are followed the same way.
    const onDisk = (abs) => (abs === `${home}/lnk` ? '.' : abs === `${home}/out` ? '/etc' : null);
    expect(() => checkArchiveMembers([{ type: 'file', name: 'lnk/.ssh/authorized_keys', target: null }], { home, dest: home, readLink: onDisk })).toThrow(/\.ssh through a symbolic link/);
    expect(() => checkArchiveMembers([{ type: 'file', name: 'out/cron.d/x', target: null }], { home, dest: home, readLink: onDisk })).toThrow(/outside the home directory/);
    expect(checkArchiveMembers([{ type: 'file', name: 'lnk/public_html/x', target: null }], { home, dest: home, readLink: onDisk })).toBe(1);
    expect(checkArchiveMembers([{ type: 'file', name: 'lnk/.ssh/k', target: null }], { home, dest: home, readLink: onDisk, allowSshDir: true })).toBe(1);
    // A link loop cannot spin the check.
    expect(() => checkArchiveMembers([{ type: 'symlink', name: 'a', target: 'b' }, { type: 'symlink', name: 'b', target: 'a' }, { type: 'file', name: 'a/x', target: null }], { home, dest: home })).toThrow(/too many symbolic links/);
    // The file member whose own name is a link is written at its name (tar unlinks first), not through the link.
    expect(checkArchiveMembers([{ type: 'symlink', name: 'cur', target: './index.html' }, { type: 'file', name: 'cur', target: null }], { home, dest: home })).toBe(2);
  });

  it('reads on-disk links without following them and fingerprints .ssh so an extraction that reached it is detected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssh-'));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      fs.symlinkSync('.', path.join(home, 'lnk'));
      fs.writeFileSync(path.join(home, 'file'), 'x');
      const readLink = diskLinkReader();
      expect(readLink(path.join(home, 'lnk'))).toBe('.');
      expect(readLink(path.join(home, 'file'))).toBeNull();
      expect(readLink(path.join(home, 'missing'))).toBeNull();
      expect(() => checkArchiveMembers([{ type: 'file', name: 'lnk/.ssh/authorized_keys', target: null }], { home, dest: home, readLink })).toThrow(/\.ssh/);
      const absent = sshFingerprint(home);
      expect(absent).toMatchObject({ exists: false });
      expect(sshChanges(absent, absent)).toEqual({ remove: [], mode: null });
      fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
      fs.writeFileSync(path.join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA a\n', { mode: 0o600 });
      const created = sshFingerprint(home);
      expect(sshChanges(absent, created)).toEqual({ remove: ['.'], mode: null });
      expect(sshChanges(created, created)).toEqual({ remove: [], mode: null });
      fs.writeFileSync(path.join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA attacker\n');
      fs.mkdirSync(path.join(home, '.ssh', 'd'));
      fs.writeFileSync(path.join(home, '.ssh', 'd', 'k'), 'k');
      const changed = sshFingerprint(home);
      expect(sshChanges(created, changed).remove.sort()).toEqual(['authorized_keys', 'd']);
      fs.chmodSync(path.join(home, '.ssh'), 0o755);
      expect(sshChanges(changed, sshFingerprint(home))).toEqual({ remove: [], mode: '700' });
      fs.rmSync(path.join(home, '.ssh'), { recursive: true });
      fs.symlinkSync('/etc', path.join(home, '.ssh'));
      expect(sshChanges(changed, sshFingerprint(home))).toEqual({ remove: ['.'], mode: null });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('is run by files.extract before anything is extracted and .ssh is checked again afterwards', () => {
    const src = fs.readFileSync(new URL('../src/ops/files.js', import.meta.url), 'utf8');
    const run = src.slice(src.indexOf("defineOp('files.extract'"));
    expect(run.indexOf('sshFingerprint(')).toBeGreaterThan(-1);
    expect(run.indexOf('sshFingerprint(')).toBeLessThan(run.indexOf("'--extract'"));
    expect(run.indexOf('revertSshChanges(')).toBeGreaterThan(run.indexOf("'--extract'"));
    expect(run).toContain('readLink: diskLinkReader()');
  });

  it('is run by files.extract before anything is extracted', () => {
    const src = fs.readFileSync(new URL('../src/ops/files.js', import.meta.url), 'utf8');
    const run = src.slice(src.indexOf("defineOp('files.extract'"));
    expect(run.indexOf('checkArchiveMembers(')).toBeGreaterThan(-1);
    expect(run.indexOf('checkArchiveMembers(')).toBeLessThan(run.indexOf("'--extract'"));
    expect(run.indexOf('checkArchiveMembers(')).toBeLessThan(run.indexOf("'-o', '-q'"));
  });

  it('lists and extracts from the root-held copy, never from the file in the home, and removes the copy', () => {
    const src = fs.readFileSync(new URL('../src/ops/files.js', import.meta.url), 'utf8');
    const run = src.slice(src.indexOf("defineOp('files.extract'"));
    expect(STDIN_ARCHIVE).toEqual({ zip: '/dev/fd/0', tar: '-' });
    expect(EXTRACT_MAX_BYTES).toBe(4 * 1024 * MiB);
    // The copy is made by the account (dd onto root's descriptor) before the listing, bounded in size.
    expect(run.indexOf("'dd', [`if=${src.target}`")).toBeGreaterThan(-1);
    expect(run.indexOf("'dd', [`if=${src.target}`")).toBeLessThan(run.indexOf('listArchiveArgv('));
    expect(run).toContain('`count=${EXTRACT_MAX_BYTES + 1}`');
    expect(run).toContain('stdoutFd: scratch.fd');
    // Neither the listing nor the extraction names the home path; both read an inherited descriptor of the copy.
    expect(run).toContain('listArchiveArgv(zip, zip ? STDIN_ARCHIVE.zip : STDIN_ARCHIVE.tar)');
    expect(run).toContain("'--extract', '--file', STDIN_ARCHIVE.tar");
    expect(run).toContain("'-o', '-q', STDIN_ARCHIVE.zip");
    expect(run.match(/stdinFd: fd/g)).toHaveLength(3);
    expect(run.slice(run.indexOf('listArchiveArgv(zip'))).not.toContain(', src.target');
    expect(run.indexOf('fs.unlinkSync(scratch.file)')).toBeGreaterThan(run.indexOf('finally {'));
  });
});

// A real extraction as the managed account (root only): the archive in the home
// is swapped between the listing and the extraction, as a tenant could do, and
// what lands in the destination must be what was listed.
describe('files.extract against a swapped archive', () => {
  const canRun = Boolean(USER) && typeof process.getuid === 'function' && process.getuid() === 0 && ['setpriv', 'tar', 'dd', 'nice'].every(hasBinary) && fs.existsSync(HOME || '/nonexistent');
  let actual;
  let info;
  let dir;
  let stage;
  let outside;
  beforeAll(async () => {
    actual = await vi.importActual('../src/exec.js');
    if (!canRun) return;
    info = assertManaged(USER);
    dir = fs.mkdtempSync(path.join(HOME, '.whm-extract-test-'));
    stage = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-extract-stage-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-extract-outside-'));
    fs.chmodSync(outside, 0o777);
    fs.chownSync(dir, info.uid, info.gid);
  });
  afterAll(() => {
    exec.mockImplementation(actual.exec);
    for (const d of [dir, stage, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  const own = (p) => fs.chownSync(p, info.uid, info.gid);
  const swapOnExtract = (evil, target, marker) => {
    exec.mockImplementation(async (bin, argv, opts) => {
      if (argv.includes(marker)) { fs.copyFileSync(evil, target); own(target); }
      return actual.exec(bin, argv, opts);
    });
  };
  const scratchFiles = () => { try { return fs.readdirSync('/tmp/whm').filter((n) => n.startsWith('extract-')); } catch { return []; } };

  it.skipIf(!canRun)('tar: extracts only the listed members and leaves the swapped archive\'s link escape unused', async () => {
    const good = path.join(stage, 'good');
    fs.mkdirSync(good);
    fs.writeFileSync(path.join(good, 'a.txt'), 'listed');
    const archive = path.join(dir, 'site.tar');
    await actual.exec('tar', ['-cf', archive, '-C', good, 'a.txt']);
    own(archive);
    // evil.tar: a symlink member to a world-writable directory outside the home, then a file through it.
    const evilA = path.join(stage, 'evil-a');
    const evilB = path.join(stage, 'evil-b');
    fs.mkdirSync(evilA); fs.symlinkSync(outside, path.join(evilA, 'lnk'));
    fs.mkdirSync(path.join(evilB, 'lnk'), { recursive: true }); fs.writeFileSync(path.join(evilB, 'lnk', 'pwned.txt'), 'escaped');
    const evil = path.join(stage, 'evil.tar');
    await actual.exec('tar', ['-cf', evil, '-C', evilA, 'lnk']);
    await actual.exec('tar', ['-rf', evil, '-C', evilB, 'lnk/pwned.txt']);
    expect(parseTarListing((await actual.exec('tar', ['--list', '--verbose', '--file', evil])).stdout).map((m) => m.type)).toEqual(['symlink', 'file']);
    swapOnExtract(evil, archive, '--extract');
    exec.mockClear();
    const res = await runOp('files.extract', { username: USER, archive, dest: `${dir}/out` }, ctx);
    expect(res).toMatchObject({ format: 'tar', members: 1 });
    expect(fs.readdirSync(`${dir}/out`)).toEqual(['a.txt']);
    expect(fs.readFileSync(`${dir}/out/a.txt`, 'utf8')).toBe('listed');
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false);
    expect(fs.existsSync(`${dir}/out/lnk`)).toBe(false);
    const tarCalls = exec.mock.calls.filter(([, argv]) => argv.includes('--file'));
    expect(tarCalls).toHaveLength(2);
    for (const [, argv, opts] of tarCalls) { expect(argv[argv.indexOf('--file') + 1]).toBe('-'); expect(opts.stdinFd).toBeTypeOf('number'); }
    expect(exec.mock.calls.some(([, argv]) => argv.includes(`if=${archive}`))).toBe(true);
    expect(scratchFiles()).toEqual([]);
  });

  it.skipIf(!canRun || !hasBinary('zip') || !hasBinary('unzip'))('zip: the same, through /dev/fd/0', async () => {
    const good = path.join(stage, 'good-zip');
    fs.mkdirSync(good);
    fs.writeFileSync(path.join(good, 'b.txt'), 'listed');
    const archive = path.join(dir, 'site.zip');
    await actual.exec('zip', ['-q', '-j', archive, path.join(good, 'b.txt')]);
    own(archive);
    const evilDir = path.join(stage, 'evil-zip');
    fs.mkdirSync(evilDir);
    fs.writeFileSync(path.join(evilDir, 'pwned.txt'), 'swapped');
    const evil = path.join(stage, 'evil.zip');
    await actual.exec('zip', ['-q', '-j', evil, path.join(evilDir, 'pwned.txt')]);
    swapOnExtract(evil, archive, '-o');
    exec.mockClear();
    const res = await runOp('files.extract', { username: USER, archive, dest: `${dir}/out-zip` }, ctx);
    expect(res).toMatchObject({ format: 'zip', members: 1 });
    expect(fs.readdirSync(`${dir}/out-zip`)).toEqual(['b.txt']);
    const unzipCalls = exec.mock.calls.filter(([, argv]) => argv.some((a) => /\/unzip$/.test(a)));
    expect(unzipCalls).toHaveLength(2);
    for (const [, argv, opts] of unzipCalls) { expect(argv).toContain('/dev/fd/0'); expect(argv).not.toContain(archive); expect(opts.stdinFd).toBeTypeOf('number'); }
    expect(scratchFiles()).toEqual([]);
  });

  it.skipIf(!canRun)('refuses an archive above the size bound before copying anything', async () => {
    const archive = path.join(dir, 'huge.tar');
    const fd = fs.openSync(archive, 'w', 0o644);
    fs.ftruncateSync(fd, EXTRACT_MAX_BYTES + 1);
    fs.closeSync(fd);
    own(archive);
    exec.mockImplementation(actual.exec);
    exec.mockClear();
    const err = await opError(runOp('files.extract', { username: USER, archive, dest: `${dir}/out-huge` }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/larger than/);
    expect(exec).not.toHaveBeenCalled();
    expect(scratchFiles()).toEqual([]);
    fs.unlinkSync(archive);
  });
});

describe('assertUnderHome', () => {
  let root;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-files-')); });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('passes lexically contained paths and refuses anything outside the home', () => {
    const home = path.join(root, 'alice');
    fs.mkdirSync(path.join(home, 'public_html'), { recursive: true });
    expect(assertUnderHome(home, `${home}/public_html`)).toBe(`${home}/public_html`);
    expect(assertUnderHome(home, home)).toBe(home);
    expect(assertUnderHome(home, `${home}/public_html/../public_html/x`)).toBe(`${home}/public_html/x`);
    expect(() => assertUnderHome(home, `${home}/../bob/x`)).toThrow(/not inside/);
    expect(() => assertUnderHome(home, `${root}/alice2/x`)).toThrow(/not inside/);
    expect(() => assertUnderHome(home, '/etc/passwd')).toThrow(/not inside/);
  });

  it('refuses a path that leaves the home through a symbolic link even though it passes lexically', () => {
    const home = path.join(root, 'bob');
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync('/etc', path.join(home, 'etc'));
    expect(`${home}/etc/passwd`.startsWith(`${home}/`)).toBe(true);
    expect(() => assertUnderHome(home, `${home}/etc/passwd`)).toThrow(/escapes the home directory/);
    expect(() => assertUnderHome(home, `${home}/etc`)).toThrow(/escapes the home directory/);
    // A link that stays inside the home is the account's own business.
    fs.mkdirSync(path.join(home, 'public_html'));
    fs.symlinkSync(path.join(home, 'public_html'), path.join(home, 'www'));
    expect(assertUnderHome(home, `${home}/www/index.html`)).toBe(`${home}/www/index.html`);
  });

  it('resolves a not-yet-existing target through its nearest existing parent', () => {
    const home = path.join(root, 'carol');
    fs.mkdirSync(path.join(home, 'public_html'), { recursive: true });
    expect(assertUnderHome(home, `${home}/public_html/new/deep/file.txt`)).toBe(`${home}/public_html/new/deep/file.txt`);
    fs.symlinkSync('/tmp', path.join(home, 'tmp'));
    expect(() => assertUnderHome(home, `${home}/tmp/new/file.txt`)).toThrow(/escapes the home directory/);
    expect(() => assertUnderHome(`${root}/nobody-here`, `${root}/nobody-here/x`)).toThrow(/does not exist/);
  });

  it('reports where a path really lands so a write into .ssh through a link is refused', () => {
    const home = path.join(root, 'erin');
    fs.mkdirSync(path.join(home, 'public_html'), { recursive: true });
    fs.symlinkSync('.', path.join(home, 'lnk'));
    fs.symlinkSync('public_html', path.join(home, 'www'));
    const r = resolveUnderHome(home, `${home}/lnk/.ssh/authorized_keys`);
    expect(r).toEqual({ resolved: `${home}/lnk/.ssh/authorized_keys`, real: `${fs.realpathSync(home)}/.ssh/authorized_keys`, realHome: fs.realpathSync(home) });
    expect(landsInSshDir(r.real, r.realHome)).toBe(true);
    expect(landsInSshDir(`${r.realHome}/.ssh`, r.realHome)).toBe(true);
    expect(landsInSshDir(`${r.realHome}/.sshx/k`, r.realHome)).toBe(false);
    expect(landsInSshDir(`${r.realHome}/public_html/.ssh/k`, r.realHome)).toBe(false);
    const w = resolveUnderHome(home, `${home}/www/.ssh/k`);
    expect(landsInSshDir(w.real, w.realHome)).toBe(false);
  });

  it('refuses a home that is itself relocated by a tenant link when the path escapes it', () => {
    const real = path.join(root, 'dave-real');
    const home = path.join(root, 'dave');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, home);
    // The home may be a link (administrator layout); paths resolve relative to its target.
    expect(assertUnderHome(home, `${home}/a`)).toBe(`${home}/a`);
    fs.symlinkSync(root, path.join(real, 'up'));
    expect(() => assertUnderHome(home, `${home}/up/x`)).toThrow(/escapes the home directory/);
  });
});

describe('asUserArgv', () => {
  it('builds the exact setpriv argv: uid, gid, no groups, no new privileges, "--", absolute program', () => {
    const info = { username: 'alice', uid: 30001, gid: 30002, home: '/home/alice' };
    expect(asUserArgv(info, '/usr/bin/find', ['-P', '/home/alice', '-maxdepth', '1'], { tool: 'setpriv' })).toEqual([
      'setpriv', ['--reuid', '30001', '--regid', '30002', '--clear-groups', '--no-new-privs', '--', '/usr/bin/find', '-P', '/home/alice', '-maxdepth', '1'],
    ]);
    expect(asUserArgv(info, '/bin/rm', ['-rf', '--', '/home/alice/x'], { tool: 'runuser' })).toEqual([
      'runuser', ['-u', 'alice', '--', '/bin/rm', '-rf', '--', '/home/alice/x'],
    ]);
    expect(() => asUserArgv(info, '/bin/rm', [], { tool: 'sudo' })).toThrow(OpError);
    expect(() => asUserArgv(info, `no-such-program-${crypto.randomBytes(3).toString('hex')}`, [])).toThrow(/not installed/);
  });

  it.skipIf(!hasBinary('setpriv'))('wraps low-priority work in nice with the wrapper resolved to an absolute path', () => {
    const info = { username: 'alice', uid: 30001, gid: 30001, home: '/home/alice' };
    const [exe, args] = asUserArgv(info, '/usr/bin/tar', ['--create'], { tool: 'setpriv', nice: true });
    expect(exe).toBe('nice');
    expect(args.slice(0, 3)).toEqual(['-n', '10', '--']);
    expect(path.isAbsolute(args[3])).toBe(true);
    expect(args[3]).toMatch(/\/setpriv$/);
    expect(args.slice(4)).toEqual(['--reuid', '30001', '--regid', '30001', '--clear-groups', '--no-new-privs', '--', '/usr/bin/tar', '--create']);
  });
});

describe('account resolution', () => {
  it('refuses every system user and a uid below 1000', () => {
    for (const name of ['root', 'daemon', 'www-data', 'mysql', 'sshd', 'nobody']) expect(() => assertManaged(name)).toThrow(OpError);
    expect(() => assertManaged('root')).toThrow(/system account/);
    expect(() => assertManaged(`ghost${crypto.randomBytes(3).toString('hex')}`)).toThrow(/does not exist/);
  });

  it.skipIf(!USER)('pins paths to the home from /etc/passwd and the allowed roots', () => {
    expect(() => accountPath(USER, '/etc/passwd', ctx, 'read')).toThrow(/not inside/);
    expect(() => accountPath(USER, `${path.dirname(HOME)}/someone-else/x`, ctx, 'read')).toThrow(/not inside/);
    expect(accountPath(USER, `${HOME}/public_html`, ctx, 'read')).toMatchObject({ home: HOME, target: `${HOME}/public_html`, info: { username: USER } });
  });
});

describe('files.* refuse the home itself, setuid modes and self-containing moves before any command runs', () => {
  it.skipIf(!USER)('never deletes, writes over or creates the home directory', async () => {
    exec.mockClear();
    expect((await opError(runOp('files.remove', { username: USER, paths: [HOME] }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.remove', { username: USER, paths: [`${HOME}/x`, '/home'] }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('files.write', { username: USER, path: HOME, content: 'x' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.mkdir', { username: USER, path: HOME }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.move', { username: USER, from: HOME, to: `${HOME}/x` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.move', { username: USER, from: `${HOME}/a`, to: `${HOME}/a/b` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.copy', { username: USER, from: `${HOME}/a`, to: `${HOME}/a` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.archive', { username: USER, paths: [HOME], dest: `${HOME}/all.zip`, format: 'zip' }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });

  it.skipIf(!USER)('refuses setuid/setgid modes, paths of other accounts and wrong archive names', async () => {
    exec.mockClear();
    expect((await opError(runOp('files.chmod', { username: USER, path: `${HOME}/bin/x`, mode: '4755' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.mkdir', { username: USER, path: `${HOME}/bin`, mode: '2755' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.write', { username: USER, path: `${HOME}/x`, content: '', mode: '6644' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('files.list', { username: USER, path: '/home/someone-else' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('files.read', { username: USER, path: '/etc/shadow' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('files.chunk_write', { username: USER, path: `/var/lib/whm/x`, data: 'aGk=' }, ctx))).code).toBe('path_not_allowed');
    if (hasBinary('zip')) expect((await opError(runOp('files.archive', { username: USER, paths: [`${HOME}/public_html`], dest: `${HOME}/site.tar.gz`, format: 'zip' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('files.extract', { username: USER, archive: `${HOME}/site.rar`, dest: `${HOME}/out` }, ctx))).code).toBe('unsupported');
    expect(exec).not.toHaveBeenCalled();
  });
});
