import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { inspectResolvConf, renderResolvConf, RESOLV_CONF } from '../src/ops/resolver.js';

// write_static replaces the live /etc/resolv.conf, so it is never executed here:
// every call must stop at the schema or at the path guard.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

describe('resolver op catalog', () => {
  it('registers the family and marks the takeover destructive', () => {
    expect(catalog.has('resolver.inspect')).toBe(true);
    expect(catalog.has('resolver.write_static')).toBe(true);
    expect(catalog.get('resolver.write_static').destructive).toBe(true);
    expect(catalog.get('resolver.inspect').destructive).toBe(false);
  });

  it('rejects unknown ops in the family', async () => {
    expect((await opError(runOp('resolver.remove', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('resolver.write', { nameservers: ['1.1.1.1'] }, ctx))).code).toBe('unknown_op');
  });

  it('resolver.write_static refuses injection, traversal, too many servers and unknown fields', async () => {
    exec.mockClear();
    for (const nameservers of [['-r'], ['a;b'], ['../etc'], ['1.1.1.1; rm -rf /'], ['$(id)'], ['999.1.1.1'], ['1.1.1.1/24'], [''], [], ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'], 'nameserver 1.1.1.1', null]) {
      const err = await opError(runOp('resolver.write_static', { nameservers }, ctx));
      expect(err.code, JSON.stringify(nameservers)).toBe('invalid_args');
    }
    for (const search of [['-x'], ['a b'], ['x;y'], ['../'], ['example.com\n'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'example.com']) {
      const err = await opError(runOp('resolver.write_static', { nameservers: ['1.1.1.1'], search }, ctx));
      expect(err.code, JSON.stringify(search)).toBe('invalid_args');
    }
    expect((await opError(runOp('resolver.write_static', { nameservers: ['1.1.1.1'], path: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('resolver.write_static', { nameservers: ['1.1.1.1'], force: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('resolver.inspect takes no arguments', async () => {
    expect((await opError(runOp('resolver.inspect', { path: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
  });

  it('both ops stop at the path guard when /etc/resolv.conf is not an allowed root', async () => {
    const locked = createContext({ allowedRoots: ['/home'] });
    expect((await opError(runOp('resolver.inspect', {}, locked))).code).toBe('path_not_allowed');
    expect((await opError(runOp('resolver.write_static', { nameservers: ['1.1.1.1'] }, locked))).code).toBe('path_not_allowed');
  });

  it('is allowed to touch /etc/resolv.conf with the default roots', () => {
    expect(ctx.assertAllowedPath(RESOLV_CONF, 'write')).toBe(RESOLV_CONF);
  });
});

describe('resolver helpers', () => {
  it('renders a panel-managed resolv.conf', () => {
    expect(renderResolvConf({ nameservers: ['1.1.1.1', '1.0.0.1'], search: ['example.com'] })).toBe('# Managed by WHM panel (Resolver Configuration)\nsearch example.com\nnameserver 1.1.1.1\nnameserver 1.0.0.1\n');
    expect(renderResolvConf({ nameservers: ['9.9.9.9'] })).toBe('# Managed by WHM panel (Resolver Configuration)\nnameserver 9.9.9.9\n');
  });

  it('tells a regular file, a systemd-resolved stub symlink and a missing file apart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-resolver-'));
    try {
      const regular = path.join(dir, 'regular.conf');
      fs.writeFileSync(regular, 'nameserver 1.1.1.1\n');
      expect(inspectResolvConf(regular)).toMatchObject({ exists: true, isSymlink: false, isRegular: true, target: null, managedByResolved: false });
      const link = path.join(dir, 'resolv.conf');
      fs.symlinkSync('/run/systemd/resolve/stub-resolv.conf', link);
      expect(inspectResolvConf(link)).toMatchObject({ exists: true, isSymlink: true, isRegular: false, target: '/run/systemd/resolve/stub-resolv.conf', managedByResolved: true });
      const other = path.join(dir, 'other.conf');
      fs.symlinkSync(regular, other);
      expect(inspectResolvConf(other)).toMatchObject({ isSymlink: true, managedByResolved: false, target: regular });
      expect(inspectResolvConf(path.join(dir, 'missing'))).toMatchObject({ exists: false, isSymlink: false, isRegular: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
