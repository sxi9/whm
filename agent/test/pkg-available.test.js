import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError } from '../src/lib.js';

// pkg.available splits names into what the package manager can install and what
// the distribution does not ship (php-opcache on PHP ≥ 8.5, for example), so one
// unknown name never fails a whole stack install.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    hasBinary: vi.fn((name) => ['apt-get', 'dpkg-query', 'apt-cache'].includes(name)),
    exec: vi.fn(async (bin, argv) => {
      const name = argv[argv.length - 1];
      if (bin === 'apt-cache' && argv[0] === 'policy') {
        if (name === 'php-opcache') return { code: 0, stdout: 'php-opcache:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n', stderr: '', bin, argv };
        if (name === 'apache2') return { code: 0, stdout: 'apache2:\n  Installed: 2.4.62-1\n  Candidate: 2.4.62-1\n', stderr: '', bin, argv };
        return { code: 0, stdout: `${name}:\n  Installed: (none)\n  Candidate: 8.5.1-1\n`, stderr: '', bin, argv };
      }
      return { code: 0, stdout: '', stderr: '', bin, argv };
    }),
  };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();
async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('pkg.available', () => {
  it('refuses injection in package names before anything runs', async () => {
    exec.mockClear();
    for (const bad of ['-r', 'a;b', 'a b', '../x', '$(id)', '', 'a\nb']) {
      expect((await opError(runOp('pkg.available', { packages: [bad] }, ctx))).code, bad).toBe('invalid_args');
    }
    expect((await opError(runOp('pkg.available', { packages: [] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports installed and candidate packages as offered and dropped names as missing (apt)', async () => {
    exec.mockClear();
    const r = await runOp('pkg.available', { packages: ['apache2', 'php-fpm', 'php-opcache'] }, ctx);
    expect(r).toEqual({ manager: 'apt', offered: ['apache2', 'php-fpm'], missing: ['php-opcache'] });
    for (const [bin, argv] of exec.mock.calls) { expect(bin).toBe('apt-cache'); expect(argv.slice(0, 2)).toEqual(['policy', '--']); }
  });
});
