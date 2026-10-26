import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { ALIASES_FILE, parseAliases, renderRootAlias } from '../src/ops/contacts.js';

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

  it('contacts.aliases.read takes no arguments', async () => {
    expect((await opError(runOp('contacts.aliases.read', { path: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
  });

  it('/etc/aliases is the only alias location the agent may touch', () => {
    expect(ctx.allowedRoots).toContain(ALIASES_FILE);
    expect(() => ctx.assertAllowedPath('/etc/aliases.db')).toThrow(OpError);
    expect(() => ctx.assertAllowedPath('/etc/aliases/../passwd')).toThrow(OpError);
    expect(() => ctx.assertAllowedPath('/etc/passwd')).toThrow(OpError);
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

  it('an empty target list removes the forwarding entry; a missing file starts from scratch', () => {
    expect(parseAliases(renderRootAlias(sample, [])).some((e) => e.name === 'root')).toBe(false);
    expect(renderRootAlias(null, ['ops@example.com'])).toBe('# root alias managed by WHM panel (Edit System Mail Preferences)\nroot: ops@example.com\n');
  });

  it('contacts.aliases.read reports the host file without failing when it is absent', async () => {
    const res = await runOp('contacts.aliases.read', {}, ctx);
    expect(res.path).toBe(ALIASES_FILE);
    expect(res.exists).toBe(fs.existsSync(ALIASES_FILE));
    expect(Array.isArray(res.root)).toBe(true);
    expect(Array.isArray(res.entries)).toBe(true);
    expect([null, 'newaliases', 'exim']).toContain(res.rebuildTool);
  });
});
