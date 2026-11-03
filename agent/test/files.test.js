import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { assertUnderHome, asUserArgv, assertManaged, accountPath, SYSTEM_USERS } from '../src/ops/as-user.js';

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
      ['files.chunk_read', { ...validArgs('files.chunk_read'), length: 8 * MiB + 1 }],
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
