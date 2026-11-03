import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, ExecError, hasBinary, resolveBinary } from '../src/exec.js';

async function execError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ExecError);
    return err;
  }
  throw new Error('expected exec to reject');
}

describe('resolveBinary / hasBinary', () => {
  it('finds programs in the fixed search path only', () => {
    expect(resolveBinary('sh')).toMatch(/^\/(usr\/)?bin\/sh$/);
    expect(hasBinary('sh')).toBe(true);
    expect(hasBinary('definitely-not-a-binary-xyz')).toBe(false);
    expect(resolveBinary('definitely-not-a-binary-xyz')).toBeNull();
    expect(resolveBinary('/usr/bin/env')).toBe('/usr/bin/env');
    expect(resolveBinary('/nonexistent/path/to/bin')).toBeNull();
  });
});

describe('exec', () => {
  it('resolves with exit code 0 and captured output', async () => {
    const result = await exec('true');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.bin).toMatch(/\/true$/);
    const echo = await exec('echo', ['hello', 'world']);
    expect(echo.stdout).toBe('hello world\n');
    expect(echo.argv).toEqual(['hello', 'world']);
  });

  it('does not interpret shell metacharacters in arguments', async () => {
    const result = await exec('echo', ['$HOME;', 'id', '&&', 'ls', '|', 'cat', '`id`']);
    expect(result.stdout).toBe('$HOME; id && ls | cat `id`\n');
  });

  it('rejects non-zero exit codes unless allowFailure is set', async () => {
    const err = await execError(exec('sh', ['-c', 'echo oops >&2; exit 3']));
    expect(err.code).toBe('command_failed');
    expect(err.message).toContain('status 3');
    expect(err.message).toContain('oops');
    expect(err.details).toMatchObject({ code: 3, stderr: 'oops\n' });

    const tolerated = await exec('sh', ['-c', 'exit 3'], { allowFailure: true });
    expect(tolerated.code).toBe(3);
  });

  it('rejects a missing program with binary_not_found', async () => {
    const err = await execError(exec('definitely-not-a-binary-xyz'));
    expect(err.code).toBe('binary_not_found');
    expect(err.details).toEqual({ bin: 'definitely-not-a-binary-xyz' });
  });

  it('rejects argv elements that are not NUL-free strings', async () => {
    expect((await execError(exec('echo', [42]))).code).toBe('bad_argument');
    expect((await execError(exec('echo', ['ok', null]))).code).toBe('bad_argument');
    expect((await execError(exec('echo', [{ toString: () => 'x' }]))).code).toBe('bad_argument');
    expect((await execError(exec('echo', ['a\0b']))).code).toBe('bad_argument');
  });

  it('passes input to stdin', async () => {
    const result = await exec('cat', [], { input: 'hi' });
    expect(result.stdout).toBe('hi');
    expect((await exec('cat', [], { input: 'multi\nline\n' })).stdout).toBe('multi\nline\n');
  });

  it('runs with a minimal, fixed environment plus any extra variables', async () => {
    const result = await exec('sh', ['-c', 'echo "$LANG|$WHM_TEST_VAR|${HOME:-unset}"'], { env: { WHM_TEST_VAR: 'yes' } });
    expect(result.stdout).toBe('C|yes|unset\n');
    expect((await exec('sh', ['-c', 'pwd'], { cwd: '/tmp' })).stdout).toBe('/tmp\n');
  });

  it('hands the child inherited descriptors as stdin / stdout instead of pipes, with the same outcome mapping', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-exec-fd-'));
    const open = (name, flags, mode) => fs.openSync(path.join(dir, name), flags, mode);
    try {
      fs.writeFileSync(path.join(dir, 'in.txt'), 'from fd');
      let fd = open('in.txt', 'r');
      expect((await exec('cat', [], { stdinFd: fd })).stdout).toBe('from fd');
      fs.closeSync(fd);
      // A program that reopens its input by name (unzip does, to seek) finds the same file behind /dev/fd/0.
      fd = open('in.txt', 'r');
      expect((await exec('cat', ['/dev/fd/0'], { stdinFd: fd })).stdout).toBe('from fd');
      fs.closeSync(fd);
      const wfd = open('out.txt', 'w', 0o600);
      const w = await exec('echo', ['to fd'], { stdoutFd: wfd });
      fs.closeSync(wfd);
      expect(w).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('to fd\n');
      fd = open('in.txt', 'r');
      expect((await execError(exec('cat', [], { stdinFd: 'no' }))).code).toBe('bad_argument');
      expect((await execError(exec('cat', [], { stdinFd: fd, input: 'both' }))).code).toBe('bad_argument');
      expect((await execError(exec('false', [], { stdinFd: fd }))).code).toBe('command_failed');
      expect((await exec('false', [], { stdinFd: fd, allowFailure: true })).code).toBe(1);
      expect((await execError(exec('sleep', ['2'], { stdinFd: fd, timeoutMs: 100 }))).code).toBe('timeout');
      expect((await execError(exec('yes', [], { stdinFd: fd, maxBuffer: 4096 }))).code).toBe('spawn_failed');
      fs.closeSync(fd);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('kills the process and rejects with timeout when it runs too long', async () => {
    const started = Date.now();
    const err = await execError(exec('sleep', ['2'], { timeoutMs: 100 }));
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('100ms');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
