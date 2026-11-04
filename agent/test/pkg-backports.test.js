import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { changelogMentions, debianChangelogPaths } from '../src/ops/pkg-backports.js';

// The advisor's distro-backport check: read-only, package names derived from
// the discovered PHP layout, never from the caller.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();

async function invalid(args) {
  exec.mockClear();
  let err;
  try { await runOp('pkg.php.backports', args, ctx); } catch (e) { err = e; }
  expect(err, JSON.stringify(args)).toBeInstanceOf(OpError);
  expect(err.code, JSON.stringify(args)).toBe('invalid_args');
  expect(exec).not.toHaveBeenCalled();
}

describe('pkg.php.backports', () => {
  it('is a non-destructive catalog op with a strict schema', async () => {
    expect(catalog.get('pkg.php.backports')).toMatchObject({ destructive: false, timeoutMs: 60_000 });
    for (const args of [
      { version: '../8.5', ids: ['CVE-2026-1'] }, { version: '8.5', ids: [] }, { version: '8.5', ids: ['-x'] }, { version: '8.5', ids: ['CVE 1'] },
      { version: '8.5', ids: ['CVE-1;id'] }, { version: '8.5', ids: ['x'.repeat(65)] }, { version: '8.5' }, { ids: ['CVE-2026-1'] },
      { version: '8.5', ids: ['CVE-2026-1'], package: 'php8.5-fpm' }, { version: 'PHP 8.5', ids: ['CVE-2026-1'] }, { version: '8.5', ids: new Array(51).fill('CVE-2026-1') },
    ]) await invalid(args);
  });

  it('answers checked:false for a PHP version that is not installed, without running a program', async () => {
    exec.mockClear();
    const r = await runOp('pkg.php.backports', { version: 'nonexistent-9.9', ids: ['CVE-2026-109619'] }, ctx);
    expect(r).toEqual({ version: 'nonexistent-9.9', package: null, layout: null, checked: false, installed: null, source: null, mentioned: [] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('matches advisory ids literally against the changelog text and names the distro packages from the prefix', () => {
    const text = 'php8.5 (8.5.4-0ubuntu1.5) resolute-security; urgency=medium\n  * SECURITY UPDATE: Remote RCE via state corruption\n    - debian/patches/CVE-2026-109618_109619.patch\n    - CVE-2026-109618\n    - CVE-2026-109619\n';
    expect(changelogMentions(text, ['CVE-2026-109619', 'CVE-2026-115560'])).toEqual(['CVE-2026-109619']);
    expect(changelogMentions(null, ['CVE-2026-109619'])).toEqual([]);
    expect(debianChangelogPaths('php8.5-').map((p) => p.file)).toEqual(['/usr/share/doc/php8.5-fpm/changelog.Debian.gz', '/usr/share/doc/php8.5-common/changelog.Debian.gz', '/usr/share/doc/php8.5-cli/changelog.Debian.gz']);
  });
});
