import { describe, it, expect, vi } from 'vitest';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { renderAwstatsConfig, detectGenerators, GENERATORS } from '../src/ops/stats.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();
const GOOD = { generator: 'awstats', domain: 'example.com', username: 'alice', homeDir: '/home/alice' };

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('stats helpers', () => {
  it('renders an AWStats config pointing at the domain log and data directory', () => {
    const text = renderAwstatsConfig({ domain: 'example.com', logFile: '/var/log/whm/domlogs/alice/example.com-access.log', dataDir: '/home/alice/tmp/awstats', aliases: ['www.example.com'] });
    expect(text).toContain('LogFile="/var/log/whm/domlogs/alice/example.com-access.log"');
    expect(text).toContain('SiteDomain="example.com"');
    expect(text).toContain('DirData="/home/alice/tmp/awstats"');
    expect(text).toContain('www.example.com');
    expect(text).toContain('AllowToUpdateStatsFromBrowser=0');
  });

  it('detects the three generators by binary presence', () => {
    const found = detectGenerators();
    expect(Object.keys(found)).toEqual(GENERATORS);
    expect(found.awstats).toHaveProperty('bin');
  });
});

describe('stats ops', () => {
  it('unknown ops are refused and generate arguments reject injection and traversal', async () => {
    exec.mockClear();
    expect((await opError(runOp('stats.run_all', {}, ctx))).code).toBe('unknown_op');
    const bad = [
      { ...GOOD, generator: 'goaccess' }, { ...GOOD, generator: 'awstats; id' },
      { ...GOOD, domain: '-r' }, { ...GOOD, domain: 'a;b.com' }, { ...GOOD, domain: '../etc' }, { ...GOOD, domain: 'exa mple.com' }, { ...GOOD, domain: 'Example.COM' },
      { ...GOOD, username: '-R' }, { ...GOOD, username: 'root;id' }, { ...GOOD, username: 'Alice' },
      { ...GOOD, homeDir: 'home/alice' }, { ...GOOD, homeDir: '/home/alice/../../etc' }, { ...GOOD, homeDir: '/home/alice\0' },
      { ...GOOD, logFile: 'relative.log' }, { ...GOOD, logFile: '/var/log/../../etc/passwd' },
      { ...GOOD, aliases: ['bad alias'] }, { ...GOOD, aliases: ['-x.com'] }, { ...GOOD, extra: 1 },
    ];
    for (const args of bad) expect((await opError(runOp('stats.generate', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const domain of ['-r', 'a;b', '../x', 'a b']) expect((await opError(runOp('stats.remove_config', { domain }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('stats.detect', { verbose: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('stats.detect reports presence without failing on a bare host', async () => {
    const d = await runOp('stats.detect', {}, ctx);
    expect(d.domlogsRoot).toBe('/var/log/whm/domlogs');
    for (const g of GENERATORS) expect(d.generators[g]).toMatchObject({ installed: expect.any(Boolean), packages: { apt: expect.any(Array) } });
  });

  it('stats.generate refuses paths outside the allowed roots or missing generators before running anything', async () => {
    exec.mockClear();
    const outside = await opError(runOp('stats.generate', { ...GOOD, homeDir: '/etc/alice' }, ctx));
    expect(['path_not_allowed', 'capability_missing']).toContain(outside.code);
    const log = await opError(runOp('stats.generate', { ...GOOD, logFile: '/etc/shadow' }, ctx));
    expect(['path_not_allowed', 'capability_missing']).toContain(log.code);
    expect(exec).not.toHaveBeenCalled();
  });

  it('stats.remove_config only touches /etc/awstats', async () => {
    const r = await runOp('stats.remove_config', { domain: 'definitely-not-configured.test' }, ctx);
    expect(r).toMatchObject({ removed: false, path: '/etc/awstats/awstats.definitely-not-configured.test.conf' });
  });
});
