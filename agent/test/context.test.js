import { describe, it, expect } from 'vitest';
import { createContext, executeOp, DEFAULT_ALLOWED_ROOTS, OpError } from '../src/lib.js';

function rejects(ctx, p, mode) {
  try {
    ctx.assertAllowedPath(p, mode);
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error(`expected ${p} to be refused`);
}

describe('createContext().assertAllowedPath', () => {
  const ctx = createContext();

  it('exposes the resolved default roots and the principal', () => {
    expect(ctx.allowedRoots).toEqual(DEFAULT_ALLOWED_ROOTS);
    expect(ctx.principal).toBeNull();
    expect(createContext({ principal: { username: 'root' } }).principal).toEqual({ username: 'root' });
  });

  it('allows paths under an allowed root and the root itself', () => {
    expect(ctx.assertAllowedPath('/home/u/public_html')).toBe('/home/u/public_html');
    expect(ctx.assertAllowedPath('/home')).toBe('/home');
    expect(ctx.assertAllowedPath('/home/')).toBe('/home');
    expect(ctx.assertAllowedPath('/etc/hosts')).toBe('/etc/hosts');
    expect(ctx.assertAllowedPath('/var/lib/whm/backups/x.tar')).toBe('/var/lib/whm/backups/x.tar');
    expect(ctx.assertAllowedPath('/home/u//double/./slash')).toBe('/home/u/double/slash');
  });

  it('refuses paths outside every root', () => {
    const err = rejects(ctx, '/etc/passwd', 'write');
    expect(err.code).toBe('path_not_allowed');
    expect(err.message).toContain('/etc/passwd');
    expect(err.message).toContain('write');
    for (const p of ['/etc', '/etc/shadow', '/root', '/usr/bin/sh', '/', '/var/lib', '/var/log/whm2/x']) expect(rejects(ctx, p).code, p).toBe('path_not_allowed');
  });

  it('resolves ".." before checking, so traversal out of a root is refused', () => {
    expect(rejects(ctx, '/home/../etc').code).toBe('path_not_allowed');
    expect(rejects(ctx, '/home/u/../../etc/passwd').code).toBe('path_not_allowed');
    expect(ctx.assertAllowedPath('/home/u/../v')).toBe('/home/v');
  });

  it('is not fooled by a root used as a string prefix', () => {
    expect(rejects(ctx, '/homeX').code).toBe('path_not_allowed');
    // /home2…/home4 are real roots (extra home partitions); use a prefix that is not one.
    expect(rejects(ctx, '/homes/u').code).toBe('path_not_allowed');
    expect(rejects(ctx, '/etc/hosts.evil').code).toBe('path_not_allowed');
    expect(rejects(ctx, '/etc/hostsX/y').code).toBe('path_not_allowed');
    expect(rejects(ctx, '/var/lib/whmX').code).toBe('path_not_allowed');
  });

  it('honours extra allowed roots and replaces, not extends, the default list', () => {
    const custom = createContext({ allowedRoots: [...DEFAULT_ALLOWED_ROOTS, '/srv/data/'] });
    expect(custom.assertAllowedPath('/srv/data/x')).toBe('/srv/data/x');
    expect(custom.assertAllowedPath('/srv/data')).toBe('/srv/data');
    expect(rejects(custom, '/srv/dataX').code).toBe('path_not_allowed');
    expect(custom.assertAllowedPath('/home/u')).toBe('/home/u');

    const only = createContext({ allowedRoots: ['/srv/only'] });
    expect(only.assertAllowedPath('/srv/only/a')).toBe('/srv/only/a');
    expect(rejects(only, '/home/u').code).toBe('path_not_allowed');
    expect(rejects(createContext({ allowedRoots: [] }), '/home').code).toBe('path_not_allowed');
  });
});

describe('executeOp', () => {
  it('builds a context from options or reuses a ready-made one', async () => {
    await expect(executeOp('fs.stat', { path: '/etc/passwd' })).rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(executeOp('fs.stat', { path: '/etc/passwd' }, { allowedRoots: ['/etc'] })).resolves.toMatchObject({ path: '/etc/passwd', exists: true });
    await expect(executeOp('fs.stat', { path: '/etc/passwd' }, createContext({ allowedRoots: ['/etc'] }))).resolves.toMatchObject({ exists: true });
    await expect(executeOp('nope.op', {})).rejects.toMatchObject({ code: 'unknown_op' });
  });
});
