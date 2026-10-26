import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, resolveBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { renderAwstatsConfig, detectGenerators, GENERATORS, STATS_ROOT, domainLogFiles, logTimestamp, mergeAccessLogs } from '../src/ops/stats.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), resolveBinary: vi.fn(mod.resolveBinary) };
});

const ctx = createContext();
const GOOD = { generator: 'awstats', domain: 'example.com', username: 'alice' };
const LINE = (ts, tls) => `203.0.113.${tls ? 2 : 1} - - [${ts}] "GET /${tls ? 'secure' : 'plain'} HTTP/1.1" 200 12 "-" "curl"`;

const actualExec = await vi.importActual('../src/exec.js');
afterEach(() => { delete process.env.WHM_STATS_ROOT; resolveBinary.mockImplementation(actualExec.resolveBinary); });

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

  it('names both the plain and the TLS domlog of a domain', () => {
    expect(domainLogFiles('alice', 'example.com')).toEqual(['/var/log/whm/domlogs/alice/example.com-access.log', '/var/log/whm/domlogs/alice/example.com-ssl-access.log']);
  });

  it('parses combined-log timestamps with their zone offset', () => {
    expect(logTimestamp(LINE('10/Oct/2026:12:00:00 +0000'))).toBe(Date.UTC(2026, 9, 10, 12));
    expect(logTimestamp(LINE('10/Oct/2026:14:00:00 +0200'))).toBe(Date.UTC(2026, 9, 10, 12));
    expect(logTimestamp(LINE('10/Oct/2026:07:00:00 -0500'))).toBe(Date.UTC(2026, 9, 10, 12));
    expect(logTimestamp('garbage')).toBeNull();
  });

  it('merges the plain and TLS logs into one time-ordered stream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-stats-merge-'));
    try {
      const plain = path.join(dir, 'a-access.log');
      const tls = path.join(dir, 'a-ssl-access.log');
      fs.writeFileSync(plain, [LINE('10/Oct/2026:12:00:00 +0000'), LINE('10/Oct/2026:12:00:05 +0000'), 'continuation-without-timestamp', LINE('10/Oct/2026:12:00:30 +0000'), ''].join('\n'));
      fs.writeFileSync(tls, [LINE('10/Oct/2026:12:00:03 +0000', true), LINE('10/Oct/2026:12:00:10 +0000', true), ''].join('\n'));
      const dest = path.join(dir, 'merged.log');
      const r = await mergeAccessLogs([plain, tls], dest);
      expect(r).toEqual({ dest, lines: 6 });
      const lines = fs.readFileSync(dest, 'utf8').trim().split('\n');
      expect(lines.map((l) => (l.includes('/secure') ? 'tls' : l.includes('/plain') ? 'plain' : 'other'))).toEqual(['plain', 'tls', 'plain', 'other', 'tls', 'plain']);
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      { ...GOOD, logFiles: [] }, { ...GOOD, logFiles: ['relative.log'] }, { ...GOOD, logFiles: ['/var/log/../../etc/passwd'] }, { ...GOOD, logFiles: ['/var/log/whm/x\0'] }, { ...GOOD, logFile: '/var/log/whm/domlogs/alice/x.log' },
      { ...GOOD, homeDir: '/home/alice' }, { ...GOOD, aliases: ['bad alias'] }, { ...GOOD, aliases: ['-x.com'] }, { ...GOOD, extra: 1 },
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
    const log = await opError(runOp('stats.generate', { ...GOOD, logFiles: ['/etc/shadow'] }, ctx));
    expect(['path_not_allowed', 'capability_missing']).toContain(log.code);
    const missing = await opError(runOp('stats.generate', { ...GOOD, generator: 'analog', logFiles: ['/var/log/whm/domlogs/alice/example.com-access.log'] }, ctx));
    expect(['not_found', 'capability_missing']).toContain(missing.code);
    expect(exec).not.toHaveBeenCalled();
  });

  // The generators run as root: a symlink planted anywhere on the output path
  // must stop the op before anything is executed, written or chowned.
  it('stats.generate refuses a symlinked output directory before running the generator', async () => {
    exec.mockClear();
    resolveBinary.mockImplementation((name) => (name === 'awstats.pl' ? '/usr/bin/true' : null));
    const existingUser = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')[0]).find((u) => /^[a-z][a-z0-9_-]{0,31}$/.test(u));
    fs.mkdirSync('/tmp/whm', { recursive: true });
    const work = fs.mkdtempSync('/tmp/whm/stats-test-');
    const statsRoot = path.join(work, 'stats');
    const target = path.join(work, 'victim');
    try {
      fs.mkdirSync(statsRoot, { mode: 0o755 });
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'passwd'), 'untouched');
      fs.mkdirSync(path.join(statsRoot, existingUser));
      fs.symlinkSync(target, path.join(statsRoot, existingUser, 'example.com'));
      const log = path.join(work, 'example.com-access.log');
      fs.writeFileSync(log, `${LINE('10/Oct/2026:12:00:00 +0000')}\n`);
      process.env.WHM_STATS_ROOT = statsRoot;
      const err = await opError(runOp('stats.generate', { ...GOOD, username: existingUser, logFiles: [log, `${log}.absent`] }, ctx));
      expect(err.code).toBe('refused');
      expect(err.message).toContain('example.com');
      expect(exec).not.toHaveBeenCalled();
      expect(fs.readdirSync(target)).toEqual(['passwd']);
      expect(fs.statSync(target).uid).toBe(0);
      expect(fs.lstatSync(path.join(statsRoot, existingUser, 'example.com')).isSymbolicLink()).toBe(true);
      fs.chownSync(path.join(statsRoot, existingUser), 65534, 65534);
      fs.rmSync(path.join(statsRoot, existingUser, 'example.com'));
      const notRoot = await opError(runOp('stats.generate', { ...GOOD, username: existingUser, logFiles: [log] }, ctx));
      expect(notRoot.code).toBe('refused');
      expect(exec).not.toHaveBeenCalled();
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  });

  it('stats.remove_config only touches /etc/awstats', async () => {
    const r = await runOp('stats.remove_config', { domain: 'definitely-not-configured.test' }, ctx);
    expect(r).toMatchObject({ removed: false, path: '/etc/awstats/awstats.definitely-not-configured.test.conf' });
  });
});
