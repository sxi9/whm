import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { exec } from '../src/exec.js';
import { runOp, createContext, catalog, OpError } from '../src/lib.js';
import { ALIASES_FILE, ALIASES_WORKDIR, MANAGED_USERS, parseAliases, renderRootAlias, renderUserAlias } from '../src/ops/contacts.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('contacts op schemas reject injection before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('contacts.nope', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('contacts.aliases.write', { targets: [] }, ctx))).code).toBe('unknown_op');
  });

  it('contacts.aliases.set_root refuses option-shaped, shell-shaped and traversal targets, extra keys and oversize lists', async () => {
    exec.mockClear();
    for (const target of ['-r', '-f/etc/passwd', 'a;b', '../etc', 'root@', '@example.com', 'a b@example.com', 'user@example', '"|/bin/sh"', 'Root', 'ops@example.com\nroot: evil', 'x'.repeat(255)]) {
      const err = await opError(runOp('contacts.aliases.set_root', { targets: [target] }, ctx));
      expect(err.code, target).toBe('invalid_args');
    }
    expect((await opError(runOp('contacts.aliases.set_root', { targets: 'ops@example.com' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('contacts.aliases.set_root', { targets: [], extra: 1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('contacts.aliases.set_root', {}, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('contacts.aliases.set_root', { targets: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('contacts.aliases.set manages only the allowlisted system users and rejects the same targets', async () => {
    exec.mockClear();
    expect(MANAGED_USERS).toEqual(['root', 'nobody']);
    for (const user of ['www-data', 'cpanel', 'Root', 'root:', '../root', 'alice', '']) {
      expect((await opError(runOp('contacts.aliases.set', { user, targets: ['ops@example.com'] }, ctx))).code, user).toBe('invalid_args');
    }
    expect((await opError(runOp('contacts.aliases.set', { targets: ['ops@example.com'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('contacts.aliases.set', { user: 'nobody', targets: ['-r'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('contacts.aliases.set', { user: 'nobody', targets: ['a;b@example.com'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('flags the alias writers as destructive and the readers as not', () => {
    expect(catalog.get('contacts.aliases.set_root').destructive).toBe(true);
    expect(catalog.get('contacts.aliases.set').destructive).toBe(true);
    expect(catalog.get('contacts.aliases.read').destructive).toBe(false);
    expect(catalog.get('contacts.exim.primary_hostname').destructive).toBe(false);
  });

  it('contacts.aliases.read and contacts.exim.primary_hostname take no arguments', async () => {
    expect((await opError(runOp('contacts.aliases.read', { path: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('contacts.exim.primary_hostname', { bin: '/bin/sh' }, ctx))).code).toBe('invalid_args');
  });

  it('/etc/aliases is the only alias location the agent may touch; backups and temp files stay under the agent state root', () => {
    expect(ctx.allowedRoots).toContain(ALIASES_FILE);
    expect(() => ctx.assertAllowedPath('/etc/aliases.db')).toThrow(OpError);
    expect(() => ctx.assertAllowedPath('/etc/aliases.whm-bak', 'write')).toThrow(OpError);
    expect(() => ctx.assertAllowedPath(`/etc/aliases.whm-tmp-${process.pid}`, 'write')).toThrow(OpError);
    expect(() => ctx.assertAllowedPath('/etc/aliases/../passwd')).toThrow(OpError);
    expect(() => ctx.assertAllowedPath('/etc/passwd')).toThrow(OpError);
    expect(ALIASES_WORKDIR.startsWith('/var/lib/whm/')).toBe(true);
    expect(ctx.assertAllowedPath(ALIASES_WORKDIR, 'write')).toBe(ALIASES_WORKDIR);
    expect(ctx.assertAllowedPath(`${ALIASES_WORKDIR}/aliases.20261026T000000Z.bak`, 'write')).toBe(`${ALIASES_WORKDIR}/aliases.20261026T000000Z.bak`);
    expect(ctx.assertAllowedPath(`${ALIASES_WORKDIR}/aliases.tmp-1`, 'write')).toBe(`${ALIASES_WORKDIR}/aliases.tmp-1`);
  });

  it('contacts.aliases.set_root refuses to run under a policy that excludes the state root', async () => {
    exec.mockClear();
    const narrow = createContext({ allowedRoots: [ALIASES_FILE] });
    expect((await opError(runOp('contacts.aliases.set_root', { targets: ['ops@example.com'] }, narrow))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('alias file parsing and rendering', () => {
  const sample = '# See man 5 aliases\npostmaster: root\nmailer-daemon: postmaster\nroot: ops@example.com,\n  oncall@example.com\nwebmaster:\troot\n';

  it('parses entries, continuation lines and comments', () => {
    expect(parseAliases(sample)).toEqual([
      { name: 'postmaster', targets: ['root'] },
      { name: 'mailer-daemon', targets: ['postmaster'] },
      { name: 'root', targets: ['ops@example.com', 'oncall@example.com'] },
      { name: 'webmaster', targets: ['root'] },
    ]);
    expect(parseAliases(null)).toEqual([]);
  });

  it('replaces the root entry (and its continuation) and keeps everything else', () => {
    const next = renderRootAlias(sample, ['admin@example.net']);
    expect(next).toContain('postmaster: root\n');
    expect(next).toContain('webmaster:\troot\n');
    expect(next).not.toContain('oncall@example.com');
    expect(next.match(/^root:/gm)).toHaveLength(1);
    expect(parseAliases(next).find((e) => e.name === 'root').targets).toEqual(['admin@example.net']);
    const again = renderRootAlias(next, ['a@example.com', 'b@example.com']);
    expect(again.match(/managed by WHM panel/g)).toHaveLength(1);
    expect(parseAliases(again).find((e) => e.name === 'root').targets).toEqual(['a@example.com', 'b@example.com']);
  });

  it('manages the nobody entry independently of root', () => {
    const withNobody = renderUserAlias(sample, 'nobody', ['root']);
    expect(parseAliases(withNobody).find((e) => e.name === 'nobody').targets).toEqual(['root']);
    expect(parseAliases(withNobody).find((e) => e.name === 'root').targets).toEqual(['ops@example.com', 'oncall@example.com']);
    const rootChanged = renderRootAlias(withNobody, ['admin@example.net']);
    expect(parseAliases(rootChanged).find((e) => e.name === 'nobody').targets).toEqual(['root']);
    expect(parseAliases(rootChanged).find((e) => e.name === 'root').targets).toEqual(['admin@example.net']);
    expect(rootChanged.match(/alias managed by WHM panel/g)).toHaveLength(2);
    const cleared = renderUserAlias(rootChanged, 'nobody', []);
    expect(parseAliases(cleared).some((e) => e.name === 'nobody')).toBe(false);
    expect(cleared.match(/alias managed by WHM panel/g)).toHaveLength(1);
    expect(() => renderUserAlias(sample, 'www-data', ['root'])).toThrow(OpError);
  });

  it('an empty target list removes the forwarding entry; a missing file starts from scratch', () => {
    expect(parseAliases(renderRootAlias(sample, [])).some((e) => e.name === 'root')).toBe(false);
    expect(renderRootAlias(null, ['ops@example.com'])).toBe('# root alias managed by WHM panel (Edit System Mail Preferences)\nroot: ops@example.com\n');
  });

  it('contacts.aliases.read reports the host file without failing when it is absent', async () => {
    const res = await runOp('contacts.aliases.read', {}, ctx);
    expect(res.path).toBe(ALIASES_FILE);
    expect(res.exists).toBe(fs.existsSync(ALIASES_FILE));
    expect(Array.isArray(res.root)).toBe(true);
    expect(Array.isArray(res.users.nobody)).toBe(true);
    expect(res.users.root).toEqual(res.root);
    expect(Array.isArray(res.entries)).toBe(true);
    expect([null, 'newaliases', 'exim']).toContain(res.rebuildTool);
  });
});
