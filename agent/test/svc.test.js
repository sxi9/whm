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

describe('stack.apache_enmod rollback', () => {
  it('disables exactly the modules it enabled when the configtest fails, and never reloads', async () => {
    const { hasBinary } = await import('../src/exec.js');
    hasBinary.mockImplementation((name) => ['a2enmod', 'a2query', 'a2dismod', 'apache2ctl', 'systemctl'].includes(name));
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'a2query') return { code: argv[2] === 'ssl' ? 0 : 1, stdout: '', stderr: '', bin, argv };
      if (bin === 'apache2ctl') return { code: 1, stdout: '', stderr: 'AH00526: Syntax error on line 3 of /etc/apache2/mods-enabled/suexec.load:\nCannot load mod_suexec.so', bin, argv };
      return { code: 0, stdout: '', stderr: '', bin, argv };
    });
    try {
      const err = await opError(runOp('stack.apache_enmod', { modules: ['rewrite', 'ssl', 'suexec'] }, ctx));
      expect(err.code).toBe('config_invalid');
      expect(err.message).toMatch(/disabled again/);
      expect(err.details).toMatchObject({ enabled: ['rewrite', 'suexec'], rolledBack: ['rewrite', 'suexec'] });
      const calls = exec.mock.calls.map(([bin, argv]) => [bin, ...argv]);
      expect(calls.filter(([bin]) => bin === 'a2dismod')).toEqual([['a2dismod', '-q', '-f', 'rewrite'], ['a2dismod', '-q', '-f', 'suexec']]);
      expect(calls).not.toContainEqual(['a2dismod', '-q', '-f', 'ssl']);
      expect(calls.some(([bin, verb]) => bin === 'systemctl' && verb === 'reload')).toBe(false);
      expect(calls.findIndex(([bin]) => bin === 'a2dismod')).toBeGreaterThan(calls.findIndex(([bin]) => bin === 'apache2ctl'));
    } finally { const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); exec.mockImplementation(mod.exec); }
  });
});

describe('stack.postgres_initdb', () => {
  it('takes no arguments and is not destructive', async () => {
    const op = catalog.get('stack.postgres_initdb');
    expect(op).toBeTruthy();
    expect(op.destructive).toBe(false);
    expect((await opError(runOp('stack.postgres_initdb', { dataDir: '/tmp/x' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips where postgresql-setup does not exist (Debian) or a cluster already exists, else runs --initdb with argv only', async () => {
    const fs = (await import('node:fs')).default;
    const { hasBinary } = await import('../src/exec.js');
    const existsSync = vi.spyOn(fs, 'existsSync');
    try {
      hasBinary.mockImplementation(() => false);
      expect(await runOp('stack.postgres_initdb', {}, ctx)).toMatchObject({ skipped: true, reason: expect.stringMatching(/postgresql-setup/) });
      hasBinary.mockImplementation((name) => name === 'postgresql-setup');
      existsSync.mockImplementation((p) => p === '/var/lib/pgsql/data/PG_VERSION');
      expect(await runOp('stack.postgres_initdb', {}, ctx)).toMatchObject({ skipped: true, reason: expect.stringMatching(/already exists/) });
      expect(exec).not.toHaveBeenCalled();
      existsSync.mockImplementation(() => false);
      exec.mockResolvedValueOnce({ code: 0, stdout: ' * Initializing database in /var/lib/pgsql/data\n * Initialized, logs are in /var/lib/pgsql/initdb_postgresql.log\n', stderr: '', bin: '/usr/bin/postgresql-setup', argv: [] });
      const result = await runOp('stack.postgres_initdb', {}, ctx);
      expect(result).toMatchObject({ skipped: false, initialised: true, dataDir: '/var/lib/pgsql/data' });
      expect(result.output).toHaveLength(2);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][0]).toBe('postgresql-setup');
      expect(exec.mock.calls[0][1]).toEqual(['--initdb']);
    } finally { existsSync.mockRestore(); const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); }
  });
});

describe('svc.resolve template instances', () => {
  it('treats an instance as present when list-unit-files only names its template', async () => {
    const { unitPresent } = await import('../src/ops/svc.js');
    const units = new Set(['clamd@', 'clamav-freshclam', 'apache2']);
    expect(unitPresent(units, 'clamd@scan')).toBe(true);
    expect(unitPresent(units, 'apache2')).toBe(true);
    expect(unitPresent(units, 'clamd')).toBe(false);
    expect(unitPresent(units, 'php-fpm@www')).toBe(false);
    const { hasBinary } = await import('../src/exec.js');
    hasBinary.mockImplementation((name) => name === 'systemctl');
    exec.mockResolvedValueOnce({ code: 0, stdout: 'clamd@.service                 disabled        disabled\nclamav-freshclam.service       enabled         enabled\n', stderr: '', bin: '/bin/systemctl', argv: [] });
    try {
      const result = await runOp('svc.resolve', { candidates: ['clamav-daemon', 'clamd@scan', 'clamd'], fresh: true }, ctx);
      expect(result).toEqual({ unit: 'clamd@scan' });
      expect(exec.mock.calls[0][0]).toBe('systemctl');
      expect(exec.mock.calls[0][1]).toEqual(['list-unit-files', '--type=service', '--no-legend', '--no-pager', '--plain']);
    } finally { const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); }
  });
});

describe('svc.status enabled', () => {
  const show = (unitFileState, extra = '') => `ActiveState=active\nSubState=running\nUnitFileState=${unitFileState}\nMainPID=1234\nLoadState=loaded\nDescription=Test unit\n${extra}`;

  it('reports enabled for every UnitFileState that starts at boot, not only enabled/static', async () => {
    const { unitStartsAtBoot } = await import('../src/ops/svc.js');
    const { hasBinary } = await import('../src/exec.js');
    hasBinary.mockImplementation((name) => name === 'systemctl');
    try {
      // Debian pure-ftpd ships only /etc/init.d/pure-ftpd -> systemd-sysv-generator -> 'generated'.
      for (const state of ['enabled', 'enabled-runtime', 'static', 'indirect', 'generated', 'alias']) {
        expect(unitStartsAtBoot(state), state).toBe(true);
        exec.mockResolvedValueOnce({ code: 0, stdout: show(state), stderr: '', bin: '/bin/systemctl', argv: [] });
        const result = await runOp('svc.status', { unit: 'pure-ftpd' }, ctx);
        expect(result, state).toMatchObject({ unit: 'pure-ftpd', installed: true, active: true, enabled: true, unitFileState: state, pid: 1234 });
      }
      for (const state of ['disabled', 'masked', 'masked-runtime', 'linked', 'linked-runtime', 'transient', 'bad', '']) {
        expect(unitStartsAtBoot(state), JSON.stringify(state)).toBe(false);
        exec.mockResolvedValueOnce({ code: 0, stdout: show(state), stderr: '', bin: '/bin/systemctl', argv: [] });
        const result = await runOp('svc.status', { unit: 'pure-ftpd' }, ctx);
        expect(result.enabled, JSON.stringify(state)).toBe(false);
        expect(result.unitFileState).toBe(state || null);
      }
      expect(unitStartsAtBoot(undefined)).toBe(false);
      expect(exec.mock.calls.every(([bin, argv]) => bin === 'systemctl' && argv[0] === 'show' && argv[1] === 'pure-ftpd.service')).toBe(true);
    } finally { const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); }
  });

  it('reports a unit that systemd does not know as not installed and not enabled', async () => {
    const { hasBinary } = await import('../src/exec.js');
    hasBinary.mockImplementation((name) => name === 'systemctl');
    exec.mockResolvedValueOnce({ code: 0, stdout: 'ActiveState=inactive\nSubState=dead\nUnitFileState=\nMainPID=0\nLoadState=not-found\n', stderr: '', bin: '/bin/systemctl', argv: [] });
    try {
      const result = await runOp('svc.status', { unit: 'nope' }, ctx);
      expect(result).toMatchObject({ unit: 'nope', installed: false, active: false, enabled: false, unitFileState: null, pid: null });
    } finally { const mod = await vi.importActual('../src/exec.js'); hasBinary.mockImplementation(mod.hasBinary); }
  });
});
