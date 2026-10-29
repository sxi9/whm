import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

beforeEach(() => { exec.mockClear(); });

describe('svc.reset_failed', () => {
  it('is in the catalog and not destructive', () => {
    const op = catalog.get('svc.reset_failed');
    expect(op).toBeTruthy();
    expect(op.destructive).toBe(false);
  });

  it('rejects unit names that could be read as options or paths before running anything', async () => {
    for (const unit of ['-x', '--all', '../apache2', 'apache2 ', 'apache2;reboot', 'a b', 'x'.repeat(81), '', 'ünit', 'apache2\n']) {
      const err = await opError(runOp('svc.reset_failed', { unit }, ctx));
      expect(err.code, JSON.stringify(unit)).toBe('invalid_args');
    }
    expect((await opError(runOp('svc.reset_failed', {}, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('svc.reset_failed', { unit: 'apache2', extra: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('svc.reset_failed', { unit: ['apache2'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('accepts the unit names services use (instances, dots, @)', async () => {
    for (const unit of ['apache2', 'php8.3-fpm', 'clamd@scan', 'whm-agentd', 'mariadb']) {
      const op = catalog.get('svc.reset_failed');
      expect(op.schema.safeParse({ unit }).success, unit).toBe(true);
    }
  });

  it('runs systemctl reset-failed <unit>.service with argv only', async () => {
    const { hasBinary } = await import('../src/exec.js');
    hasBinary.mockImplementation((name) => name === 'systemctl');
    exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', bin: '/bin/systemctl', argv: [] });
    try {
      const result = await runOp('svc.reset_failed', { unit: 'apache2' }, ctx);
      expect(result).toMatchObject({ unit: 'apache2', ok: true });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][0]).toBe('systemctl');
      expect(exec.mock.calls[0][1]).toEqual(['reset-failed', 'apache2.service']);
    } finally { const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); }
  });
});

describe('svc.resolve fresh', () => {
  it('accepts fresh as a boolean only', () => {
    const op = catalog.get('svc.resolve');
    expect(op.schema.safeParse({ candidates: ['apache2', 'httpd'], fresh: true }).success).toBe(true);
    expect(op.schema.safeParse({ candidates: ['apache2'] }).success).toBe(true);
    expect(op.schema.safeParse({ candidates: ['apache2'], fresh: 'yes' }).success).toBe(false);
    expect(op.schema.safeParse({ candidates: ['-x'], fresh: true }).success).toBe(false);
  });
});

describe('stack.apache_enmod', () => {
  it('rejects module names that are not plain a2enmod names and never runs', async () => {
    for (const modules of [['-m'], ['Rewrite'], ['proxy fcgi'], ['x;y'], ['../ssl'], [''], [], Array.from({ length: 21 }, (_, i) => `m${i}`), 'rewrite']) {
      const err = await opError(runOp('stack.apache_enmod', { modules }, ctx));
      expect(err.code, JSON.stringify(modules)).toBe('invalid_args');
    }
    expect((await opError(runOp('stack.apache_enmod', { modules: ['rewrite'], extra: 1 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports skipped where a2enmod does not exist instead of failing', async () => {
    const { hasBinary } = await import('../src/exec.js');
    hasBinary.mockImplementation(() => false);
    try {
      const result = await runOp('stack.apache_enmod', { modules: ['rewrite', 'ssl'] }, ctx);
      expect(result).toMatchObject({ skipped: true, enabled: [], failed: [], reloaded: false });
      expect(exec).not.toHaveBeenCalled();
    } finally { const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); }
  });

  it('queries before enabling, enables only what is off and reloads a running Apache', async () => {
    const { hasBinary } = await import('../src/exec.js');
    hasBinary.mockImplementation((name) => ['a2enmod', 'a2query', 'apache2ctl', 'systemctl'].includes(name));
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'a2query') return { code: argv[2] === 'ssl' ? 0 : 1, stdout: '', stderr: '', bin, argv };
      if (bin === 'a2enmod') return { code: argv[1] === 'nope' ? 1 : 0, stdout: '', stderr: argv[1] === 'nope' ? 'ERROR: Module nope does not exist!' : '', bin, argv };
      return { code: 0, stdout: '', stderr: '', bin, argv };
    });
    try {
      const result = await runOp('stack.apache_enmod', { modules: ['rewrite', 'ssl', 'nope'] }, ctx);
      expect(result).toMatchObject({ skipped: false, enabled: ['rewrite'], alreadyEnabled: ['ssl'], reloaded: true });
      expect(result.failed).toEqual([{ module: 'nope', error: 'ERROR: Module nope does not exist!' }]);
      const calls = exec.mock.calls.map(([bin, argv]) => [bin, ...argv]);
      expect(calls).toContainEqual(['a2enmod', '-q', 'rewrite']);
      expect(calls).not.toContainEqual(['a2enmod', '-q', 'ssl']);
      expect(calls).toContainEqual(['apache2ctl', '-t']);
      expect(calls).toContainEqual(['systemctl', 'reload', 'apache2.service']);
    } finally { const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); exec.mockImplementation(mod.exec); }
  });
});
