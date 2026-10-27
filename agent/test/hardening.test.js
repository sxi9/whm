import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { ensurePrivateDir, arg } from '../src/ops/registry.js';
import { unsafeMember, parseTarListing } from '../src/ops/transfer.js';
import { screenDumpForClientCommands } from '../src/ops/backup.js';

// Phase 6 hardening pass: catalog-wide schema strictness, option smuggling
// through unit/binary names, symlink-safe writes under account trees, private
// scratch directories, hard links in untrusted archives and mysql client
// commands hidden in restored dumps. exec is spied with the real implementation
// behind it so every refusal is proven to happen before a program runs.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary, resolveBinary } = await import('../src/exec.js');

const ctx = createContext();
const TMP_ROOT = '/tmp/whm';
let root;
let tmpRootExisted;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  fs.mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 });
  root = fs.mkdtempSync(`${TMP_ROOT}/hardening-`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// Unwraps refinements, defaults and unions down to the object schemas and
// reports whether every one of them refuses unknown keys.
function isStrict(schema) {
  const def = schema?._def;
  if (!def) return false;
  switch (def.typeName) {
    case 'ZodObject': return def.unknownKeys === 'strict';
    case 'ZodEffects': return isStrict(def.schema);
    case 'ZodDefault': case 'ZodOptional': case 'ZodNullable': return isStrict(def.innerType);
    case 'ZodUnion': return def.options.every(isStrict);
    case 'ZodDiscriminatedUnion': return [...def.options.values()].every(isStrict);
    case 'ZodIntersection': return isStrict(def.left) && isStrict(def.right);
    case 'ZodPipeline': return isStrict(def.in);
    default: return false;
  }
}

describe('catalog-wide guarantees', () => {
  it('every op has a strict argument schema (unknown keys are refused)', () => {
    const loose = [...catalog.values()].filter((op) => !isStrict(op.schema)).map((op) => op.name);
    expect(loose).toEqual([]);
  });

  it('an unknown key is refused before anything runs, for every op', async () => {
    exec.mockClear();
    for (const name of catalog.keys()) {
      const err = await opError(runOp(name, { __whm_injected: 'x' }, ctx));
      expect(err.code, name).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('flags the ops that stop, kill, delete or overwrite as destructive', () => {
    for (const name of ['svc.stop', 'svc.restart', 'svc.disable', 'db.restart', 'pg.restart', 'web.restart', 'sys.reboot', 'sys.process.signal', 'fs.remove', 'user.delete', 'web.vhost.remove', 'dns.zone.remove', 'backup.db.import']) {
      expect(catalog.get(name).destructive, name).toBe(true);
    }
  });
});

describe('systemd unit names cannot smuggle options', () => {
  it('refuses unit names that start with "-" or "." for every svc op', async () => {
    exec.mockClear();
    for (const verb of ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'status', 'journal']) {
      for (const unit of ['-x', '--force', '--now', '.hidden', '', 'a b', 'x;rm', 'u'.repeat(81)]) {
        expect((await opError(runOp(`svc.${verb}`, { unit }, ctx))).code, `${verb} ${JSON.stringify(unit)}`).toBe('invalid_args');
      }
    }
    expect((await opError(runOp('svc.resolve', { candidates: ['-x'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('still accepts the unit names real hosts use', () => {
    for (const unit of ['apache2', 'php8.1-fpm', 'postgresql@14-main', 'pure-ftpd-mysql', 'whm-ips', 'php83-php-fpm', 'named']) expect(arg.unit.safeParse(unit).success, unit).toBe(true);
  });
});

describe('binary resolution', () => {
  it('sys.binaries refuses names that are path segments rather than programs', async () => {
    exec.mockClear();
    for (const names of [['..'], ['.'], ['.profile'], ['a/b'], ['-v'], ['']]) {
      expect((await opError(runOp('sys.binaries', { names }, ctx))).code, JSON.stringify(names)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('resolveBinary only accepts regular files, never a directory named like a program', () => {
    const dir = path.join(root, 'notabin');
    fs.mkdirSync(dir);
    expect(resolveBinary(dir)).toBeNull();
    const file = path.join(root, 'isabin');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveBinary(file)).toBe(file);
    expect(resolveBinary(path.join(root, 'missing'))).toBeNull();
  });
});

describe('fs.write_file never follows a planted link', () => {
  it('replaces a symlink target name instead of writing through it, and backs up exclusively', async () => {
    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'victim stays');
    const target = path.join(root, 'conf.txt');
    fs.symlinkSync(victim, target);
    const bakVictim = path.join(root, 'bak-victim.txt');
    fs.writeFileSync(bakVictim, 'bak victim stays');
    fs.symlinkSync(bakVictim, `${target}.whm-bak`);
    await expect(runOp('fs.write_file', { path: target, content: 'new content', backup: true }, ctx)).resolves.toEqual({ path: target, bytes: 11 });
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim stays');
    expect(fs.readFileSync(bakVictim, 'utf8')).toBe('bak victim stays');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('new content');
    expect(fs.lstatSync(`${target}.whm-bak`).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(`${target}.whm-bak`, 'utf8')).toBe('victim stays');
    expect(fs.readdirSync(root).some((n) => n.includes('.whm-tmp-'))).toBe(false);
  });

  it('fs.chown refuses option-shaped owners and groups before chown runs', async () => {
    exec.mockClear();
    for (const args of [{ path: `${root}/x`, owner: '-R' }, { path: `${root}/x`, owner: 'alice', group: '..' }, { path: `${root}/x`, owner: 'alice', group: '-R' }, { path: 'relative', owner: 'alice' }, { path: `${root}/../../etc`, owner: 'alice' }]) {
      expect((await opError(runOp('fs.chown', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('fs.chown', { path: '/etc/shadow', owner: 'alice' }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('fs.copy_tree', () => {
  it('runs rsync without device or special file recreation', async () => {
    const from = path.join(root, 'tree-src');
    const to = path.join(root, 'tree-dst');
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, 'a.txt'), 'a');
    exec.mockClear();
    try { await runOp('fs.copy_tree', { from, to }, ctx); } catch (err) { expect(err.code).toBe('binary_not_found'); }
    expect(exec).toHaveBeenCalledTimes(1);
    const [bin, argv] = exec.mock.calls[0];
    expect(bin).toBe('rsync');
    expect(argv).toEqual(expect.arrayContaining(['-a', '--no-devices', '--no-specials', '--numeric-ids', `${from}/`, `${to}/`]));
    expect(argv).not.toContain('--delete');
    expect(argv.indexOf('--no-devices')).toBeGreaterThan(argv.indexOf('-a'));
  });

  it('refuses sources and destinations outside the allowed roots or with traversal', async () => {
    exec.mockClear();
    expect((await opError(runOp('fs.copy_tree', { from: '/etc', to: `${root}/x` }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.copy_tree', { from: `${root}/x`, to: '/usr/lib/x' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.copy_tree', { from: `${root}/../x`, to: `${root}/y` }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('ensurePrivateDir (scratch space root writes secrets into)', () => {
  it('creates a missing directory 0700 and tightens one the agent owns', () => {
    const fresh = path.join(root, 'scratch-new');
    expect(ensurePrivateDir(fresh)).toBe(fresh);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
    const loose = path.join(root, 'scratch-loose');
    fs.mkdirSync(loose, { mode: 0o777 });
    fs.chmodSync(loose, 0o1777);
    ensurePrivateDir(loose);
    expect(fs.statSync(loose).mode & 0o7777).toBe(0o700);
  });

  it('refuses a symbolic link or a plain file in place of the directory', () => {
    const link = path.join(root, 'scratch-link');
    fs.symlinkSync(root, link);
    expect(() => ensurePrivateDir(link)).toThrow(/not a directory/);
    const file = path.join(root, 'scratch-file');
    fs.writeFileSync(file, '');
    expect(() => ensurePrivateDir(file)).toThrow(/not a directory/);
  });

  it.skipIf(process.getuid?.() !== 0)('refuses a directory another user planted', () => {
    const planted = path.join(root, 'scratch-planted');
    fs.mkdirSync(planted, { mode: 0o755 });
    fs.chownSync(planted, 65534, 65534);
    expect(() => ensurePrivateDir(planted)).toThrow(/owned by uid 65534/);
  });
});

describe('untrusted archives: hard links', () => {
  it('parses hard link members and refuses those that point outside the archive', () => {
    const listing = parseTarListing([
      '-rw-r--r-- 0/0        5 2026-10-26 19:08 cpmove-eve/homedir/a.txt',
      'hrw-r--r-- 0/0        0 2026-10-26 19:08 cpmove-eve/homedir/b.txt link to cpmove-eve/homedir/a.txt',
      'hrw-r--r-- 0/0        0 2026-10-26 19:08 cpmove-eve/homedir/shadow link to /etc/shadow',
      'hrw-r--r-- 0/0        0 2026-10-26 19:08 cpmove-eve/homedir/passwd link to ../../../../etc/passwd',
      'hrw-r--r-- 0/0        0 2026-10-26 19:08 cpmove-eve/homedir/odd link to ./cpmove-eve/homedir/a.txt',
    ].join('\n'));
    expect(listing.map((e) => e.type)).toEqual(['-', 'h', 'h', 'h', 'h']);
    expect(listing[2].link).toBe('/etc/shadow');
    expect(listing.map(unsafeMember)).toEqual([null, null, expect.stringMatching(/hard link to "\/etc\/shadow"/), expect.stringMatching(/hard link/), null]);
  });
});

describe('backup.db.import screens dumps for mysql client commands', () => {
  const header = ['-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)', '--', '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;', '/*!40000 DROP DATABASE IF EXISTS `shop`*/;', 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;', 'USE `shop`;', 'DROP TABLE IF EXISTS `t`;', 'CREATE TABLE `t` (`id` int NOT NULL, `note` text) ENGINE=InnoDB;', "INSERT INTO `t` VALUES (1,'\\\\! rm -rf /'),(2,'system id\\nsource /etc/passwd');", 'DELIMITER ;;', '/*!50003 CREATE*/ /*!50017 DEFINER=`shop_u`@`localhost`*/ /*!50003 TRIGGER `tr` BEFORE INSERT ON `t` FOR EACH ROW BEGIN SET NEW.note = NEW.note; END */;;', 'DELIMITER ;', '-- Dump completed on 2026-10-26 19:08:00'];
  const dump = (name, extra = []) => { const f = path.join(root, `${name}.sql`); fs.writeFileSync(f, [...header, ...extra].join('\n') + '\n'); return f; };

  it('passes a mysqldump of the target database, strings and triggers included', async () => {
    await expect(screenDumpForClientCommands(dump('clean'), { database: 'shop' })).resolves.toEqual({ ok: true, lines: header.length });
  });

  it('refuses system, backslash, tee and source commands and a USE of another database', async () => {
    for (const [name, line, reason] of [['sys', 'system id', /client command "system"/], ['bang', '\\! id', /backslash command/], ['tee', 'tee /tmp/whm-out', /client command "tee"/], ['src', 'source /etc/passwd', /client command "source"/], ['use', 'USE `mysql`;', /switches to database "mysql"/]]) {
      const r = await screenDumpForClientCommands(dump(name, [line]), { database: 'shop' });
      expect(r.ok, name).toBe(false);
      expect(r.line, name).toBe(header.length + 1);
      expect(r.reason, name).toMatch(reason);
    }
  });

  it('backup.db.import refuses such a dump before the client or the server is touched', async () => {
    const original = hasBinary.getMockImplementation();
    hasBinary.mockImplementation((n) => n === 'mysql' || original(n));
    exec.mockClear();
    try {
      const file = dump('import-evil', ['\\! touch /tmp/whm-pwned']);
      const err = await opError(runOp('backup.db.import', { file, database: 'shop' }, ctx));
      expect(err.code).toBe('refused');
      expect(err.message).toMatch(/line 14: the dump contains a backslash command/);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      hasBinary.mockImplementation(original);
    }
  });
});

describe('schemas of ops that had no rejection tests', () => {
  const cases = [
    ['sys.process.renice', [{ pid: 1, niceness: 20 }, { pid: 0, niceness: 0 }, { pid: '1', niceness: 0 }, { pid: 1, niceness: -21 }]],
    ['sys.hostname.set', [{ hostname: '-x.example.com' }, { hostname: 'a b' }, { hostname: 'x;reboot' }, { hostname: '' }, { hostname: 'a..b' }]],
    ['sys.time.set', [{ timezone: '../../etc/passwd' }, { timezone: 'Europe/Berlin;rm' }, { timezone: '/etc/localtime' }, { timezone: 'A/B/C/D' }, { ntp: 'yes' }]],
    ['sys.reboot', [{ mode: 'now' }, {}, { mode: 'graceful', force: true }]],
    ['user.quota_report', [{ filesystem: 'relative' }, { filesystem: '/../' }, { filesystem: '/home/../etc' }]],
    ['user.groups.set_membership', [{ username: '-u', group: 'sudo', member: true }, { username: 'alice', group: 'sudo;x', member: true }, { username: 'alice', group: '..', member: true }, { username: 'alice', group: 'sudo', member: 'yes' }, { username: 'Alice', group: 'sudo', member: true }]],
    ['sec.ssh_keys.authorize', [{ name: '../id_rsa' }, { name: '-f' }, { name: 'a/b' }, { name: '' }, { name: '.ssh' }]],
    ['sec.ssh_keys.export', [{ name: '../../etc/shadow' }, { name: '-' }, { name: 'a b' }]],
    ['sec.modsec.list_rules', [{ limit: 0 }, { limit: 20001 }, { limit: '5' }]],
    ['sec.imunify.scan', [{ path: 'home' }, { path: '/home/../etc' }, { intensity: 'max' }]],
    ['sec.imunify.results', [{ username: '-u' }, { limit: 0 }, { username: 'a;b' }]],
    ['sec.imunify.quarantine', [{ limit: 1001 }]],
    ['sec.netdev.read', [{ includeLoopback: 'yes' }]],
    ['pkg.php.versions', [{ modules: 'yes' }]],
    ['pkg.nginx.status', [{ includeContent: 1 }]],
    ['svc.journal', [{ unit: 'ssh', lines: 0 }, { unit: 'ssh', lines: 5001 }, { unit: 'ssh', lines: '10' }]],
    ['svc.resolve', [{ candidates: [] }, { candidates: Array.from({ length: 11 }, (_, i) => `u${i}`) }, { candidates: ['a b'] }]],
    ['mail.greylist.selftest', [{ db: '/tmp/x' }]],
    ['web.dovecot.include.remove', [{ path: '/etc/dovecot/x' }]],
    ['fs.copy_tree', [{ from: 'src', to: '/tmp/whm/x' }, { from: '/tmp/whm/x', to: 'dst' }, { from: '/tmp/whm/x', to: '/tmp/whm/y', deleteExtraneous: 'yes' }]],
  ];
  for (const [name, bad] of cases) {
    it(`${name} refuses bad arguments before anything runs`, async () => {
      exec.mockClear();
      for (const args of bad) expect((await opError(runOp(name, args, ctx))).code, `${name} ${JSON.stringify(args)}`).toBe('invalid_args');
      expect(exec).not.toHaveBeenCalled();
    });
  }

  it('path ops refuse locations outside the allowed roots before any read', async () => {
    exec.mockClear();
    expect((await opError(runOp('sec.imunify.scan', { path: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.chmod', { path: '/etc/shadow', mode: '0644' }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });
});
