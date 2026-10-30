import { describe, it, expect } from 'vitest';
import { runOp, listOps, OpError, createContext, catalog } from '../src/lib.js';
import { arg, defineOp } from '../src/ops/index.js';

const ctx = createContext();
const accepts = (schema, value) => schema.safeParse(value).success;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

describe('runOp', () => {
  it('rejects ops that are not in the catalog', async () => {
    const err = await opError(runOp('sys.nope', {}, ctx));
    expect(err.code).toBe('unknown_op');
    expect((await opError(runOp('', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('shell.exec', { cmd: 'id' }, ctx))).code).toBe('unknown_op');
  });

  it('rejects invalid arguments with field details before running anything', async () => {
    const err = await opError(runOp('svc.status', { unit: 'ssh;rm -rf /' }, ctx));
    expect(err.code).toBe('invalid_args');
    expect(err.details.fields.unit).toHaveLength(1);

    const missing = await opError(runOp('user.create', {}, ctx));
    expect(missing.code).toBe('invalid_args');
    expect(Object.keys(missing.details.fields).sort()).toEqual(['homeDir', 'username']);

    const extra = await opError(runOp('fs.stat', { path: '/home/x', bogus: true }, ctx));
    expect(extra.code).toBe('invalid_args');
    expect(extra.details.fields._).toEqual([expect.stringMatching(/unrecognized/i)]);

    const typed = await opError(runOp('sys.processes', { limit: '5' }, ctx));
    expect(typed.code).toBe('invalid_args');
    expect(typed.details.fields.limit).toHaveLength(1);
  });

  it('treats a missing args object as {}', async () => {
    await expect(runOp('sys.binaries', undefined, ctx)).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(runOp('sys.resolvers.get', undefined, ctx)).resolves.toHaveProperty('nameservers');
  });

  it('wraps unexpected handler errors as op_failed and passes OpError through', async () => {
    defineOp('test.throws', { run: async () => { throw new TypeError('kaboom'); } });
    defineOp('test.op_error', { run: async () => { throw new OpError('custom_code', 'custom'); } });
    const wrapped = await opError(runOp('test.throws', {}, ctx));
    expect(wrapped.code).toBe('op_failed');
    expect(wrapped.message).toBe('kaboom');
    expect(wrapped.details).toEqual({ op: 'test.throws' });
    expect((await opError(runOp('test.op_error', {}, ctx))).code).toBe('custom_code');
    catalog.delete('test.throws');
    catalog.delete('test.op_error');
  });
});

describe('defineOp', () => {
  it('enforces op naming and uniqueness', () => {
    expect(() => defineOp('BadName', { run: async () => {} })).toThrow(/invalid op name/);
    expect(() => defineOp('nodot', { run: async () => {} })).toThrow(/invalid op name/);
    expect(() => defineOp('sys.info', { run: async () => {} })).toThrow(/defined twice/);
  });
});

describe('listOps', () => {
  it('describes a non-empty catalog of well-formed names', () => {
    const ops = listOps();
    expect(ops.length).toBeGreaterThan(30);
    for (const op of ops) {
      expect(op.name).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      expect(typeof op.description).toBe('string');
      expect(typeof op.destructive).toBe('boolean');
    }
    const names = ops.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['sys.info', 'svc.status', 'user.create', 'fs.write_file', 'sys.binaries', 'user.delete', 'fs.remove', 'svc.restart']));
    expect(new Set(names).size).toBe(names.length);
    expect(ops.find((o) => o.name === 'user.delete').destructive).toBe(true);
    expect(ops.find((o) => o.name === 'sys.info').destructive).toBe(false);
  });
});

describe('arg schemas', () => {
  it('username rejects option-like and shell-unsafe values', () => {
    for (const bad of ['-r', 'a b', 'A', 'root;id', '1abc', '', 'a'.repeat(33), 'a\nb', 'a/b']) expect(accepts(arg.username, bad), bad).toBe(false);
    for (const good of ['web01', 'a', 'a_b-c', 'a'.repeat(32)]) expect(accepts(arg.username, good), good).toBe(true);
  });

  it('psUser takes the owner names ps prints but nothing option-like', () => {
    for (const good of ['Debian-exim', '_apt', 'systemd+', 'www-data', 'root', '1000', 'machine$', 'a'.repeat(32)]) expect(accepts(arg.psUser, good), good).toBe(true);
    for (const bad of ['-r', '--help', 'a b', 'root;id', 'a/b', 'a\nb', '', '$(id)', 'a'.repeat(33)]) expect(accepts(arg.psUser, bad), bad).toBe(false);
    const schema = catalog.get('sys.processes').schema;
    expect(schema.safeParse({ user: 'Debian-exim' }).success).toBe(true);
    expect(schema.safeParse({ user: '-u' }).success).toBe(false);
  });

  it('absPath rejects traversal and relative paths', () => {
    for (const bad of ['/home/../etc', 'relative', '/home/x/..', '/../etc', '/..', '/home/x\n/../etc', '', '/home/x\0']) expect(accepts(arg.absPath, bad), bad).toBe(false);
    for (const good of ['/home/x', '/', '/home/x/..hidden', '/var/lib/whm/a b/c.txt']) expect(accepts(arg.absPath, good), good).toBe(true);
  });

  it('unit, mode, shell, signal, pid and names are tightly constrained', () => {
    for (const bad of ['ssh;rm', 'ssh rm', 'ssh/../x', '', 'a'.repeat(81)]) expect(accepts(arg.unit, bad), bad).toBe(false);
    for (const good of ['ssh', 'php8.3-fpm', 'getty@tty1', 'whm-agentd']) expect(accepts(arg.unit, good), good).toBe(true);

    for (const bad of ['999', '0888', '75501', '75', 'rwx', '0o755', '']) expect(accepts(arg.mode, bad), bad).toBe(false);
    for (const good of ['0750', '750', '0644', '1777']) expect(accepts(arg.mode, good), good).toBe(true);

    expect(accepts(arg.shell, '/bin/bash')).toBe(true);
    expect(accepts(arg.shell, '/bin/zsh')).toBe(false);
    expect(accepts(arg.signal, 'SIGKILL')).toBe(true);
    expect(accepts(arg.signal, '9')).toBe(false);
    expect(accepts(arg.pid, 1234)).toBe(true);
    expect(accepts(arg.pid, 0)).toBe(false);
    expect(accepts(arg.pid, '1234')).toBe(false);
    expect(accepts(arg.identifier, 'web01_shop')).toBe(true);
    expect(accepts(arg.identifier, 'web01-shop')).toBe(false);
    expect(accepts(arg.iface, 'eth0')).toBe(true);
    expect(accepts(arg.iface, 'eth0;ls')).toBe(false);
    expect(accepts(arg.ip, '10.0.0.5')).toBe(true);
    expect(accepts(arg.ipv4, '::1')).toBe(false);
    expect(accepts(arg.ipv6, '::1')).toBe(true);
  });

  it('domain and hostname', () => {
    expect(accepts(arg.domain, 'example.com')).toBe(true);
    expect(accepts(arg.domain, 'Example.com')).toBe(false);
    expect(accepts(arg.domain, 'localhost')).toBe(false);
    expect(accepts(arg.domain, 'exa mple.com')).toBe(false);
    for (const good of ['server', 'srv.example.com', 'srv.lan1', 'a.b', 'a-b.c-d']) expect(accepts(arg.hostname, good), good).toBe(true);
    for (const bad of ['srv example', '-srv', '--help', '-rf', 'srv.-x', 'srv-', 'srv.x-', '', 'a..b']) expect(accepts(arg.hostname, bad), bad).toBe(false);
  });

  it('text is bounded and mysqlHost is restricted', () => {
    expect(accepts(arg.text, 'anything\ngoes; here')).toBe(true);
    expect(accepts(arg.text, 'x'.repeat(4 * 1024 * 1024 + 1))).toBe(false);
    expect(accepts(arg.mysqlHost, '10.0.0.%')).toBe(true);
    expect(accepts(arg.mysqlHost, "'; DROP")).toBe(false);
  });
});
