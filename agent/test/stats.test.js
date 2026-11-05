import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, resolveBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { renderAwstatsConfig, detectGenerators, GENERATORS, STATS_ROOT, domainLogFiles, logTimestamp, mergeAccessLogs, goaccessArgv, goaccessOutputs, ioniceArgv, summarizeGoaccess, STATS_DIR, SUMMARY_VERSION } from '../src/ops/stats.js';
import { asUserArgv } from '../src/ops/as-user.js';

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
    const text = renderAwstatsConfig({ domain: 'example.com', logFile: '/var/log/whm/domlogs/alice/example.com-access.log', dataDir: '/var/lib/whm/stats/alice/example.com/awstats', aliases: ['www.example.com'] });
    expect(text).toContain('LogFile="/var/log/whm/domlogs/alice/example.com-access.log"');
    expect(text).toContain('SiteDomain="example.com"');
    expect(text).toContain('DirData="/var/lib/whm/stats/alice/example.com/awstats"');
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

describe('stats.goaccess (Visitors)', () => {
  const RUN = { username: 'alice', domain: 'example.com' };
  const REPORT = {
    general: { start_date: '04/Nov/2026', end_date: '05/Nov/2026', total_requests: 222, valid_requests: 220, failed_requests: 2, unique_visitors: 60, unique_files: 15, unique_not_found: 75, unique_referrers: 5, bandwidth: 1088699, log_size: 36264 },
    visitors: { data: [{ data: '20261104', hits: { count: 200 }, visitors: { count: 55 }, bytes: { count: 1000000 } }, { data: '20261105', hits: { count: 22 }, visitors: { count: 5 }, bytes: { count: 88699 } }, { data: 'garbage', hits: { count: 1 } }] },
    requests: { data: [{ data: '/about', hits: { count: 10 }, visitors: { count: 4 }, bytes: { count: 100 } }, { data: '/', hits: { count: 74 }, visitors: { count: 46 }, bytes: { count: 724513 } }] },
    not_found: { data: [{ data: '/favicon.ico', hits: { count: 11 }, visitors: { count: 0 }, bytes: { count: 26340 } }] },
    referring_sites: { data: [{ data: 'example.org', hits: { count: 11 }, visitors: { count: 3 }, bytes: { count: 31536 } }] },
    status_codes: { data: [{ data: '2xx Success', hits: { count: 111 }, visitors: { count: 60 }, bytes: { count: 820950 } }] },
    hosts: { data: [{ data: '203.0.113.9', hits: { count: 32 }, visitors: { count: 1 }, bytes: { count: 1 } }] },
  };

  it('builds the goaccess argv with the HTML file and the JSON report on stdout', () => {
    const logs = ['/var/log/whm/domlogs/alice/example.com-access.log', '/var/log/whm/domlogs/alice/example.com-ssl-access.log'];
    expect(goaccessArgv(logs, '/home/alice/.keel/stats/example.com.html')).toEqual(['--no-global-config', '--log-format=COMBINED', '--output=/home/alice/.keel/stats/example.com.html', '--output=json', ...logs]);
    expect(goaccessOutputs('/home/alice', 'example.com')).toEqual({ dir: `/home/alice/${STATS_DIR}`, html: '/home/alice/.keel/stats/example.com.html', summary: '/home/alice/.keel/stats/example.com.summary.json' });
  });

  it('wraps the as-user command in ionice when it exists and passes it through otherwise', () => {
    const info = { uid: 1001, gid: 1001, username: 'alice', home: '/home/alice' };
    resolveBinary.mockImplementation((name) => (name === 'goaccess' ? '/usr/bin/goaccess' : name === 'nice' ? '/usr/bin/nice' : actualExec.resolveBinary(name)));
    const [exe, args] = asUserArgv(info, 'goaccess', goaccessArgv(['/var/log/whm/domlogs/alice/example.com-access.log'], '/home/alice/.keel/stats/example.com.html'), { tool: 'setpriv', nice: true });
    expect(exe).toBe('nice');
    expect(args.slice(0, 3)).toEqual(['-n', '10', '--']);
    expect(args).toContain('--reuid');
    expect(args).toContain('1001');
    expect(args).toContain('--no-new-privs');
    expect(args.indexOf('/usr/bin/goaccess')).toBeGreaterThan(args.indexOf('--'));
    expect(ioniceArgv(exe, args, { ionice: false })).toEqual([exe, args]);
    const [wrapped, wrappedArgs] = ioniceArgv(exe, args, { ionice: true });
    expect(wrapped).toBe('ionice');
    expect(wrappedArgs.slice(0, 6)).toEqual(['-c', '2', '-n', '7', '--', '/usr/bin/nice']);
    expect(wrappedArgs.slice(6)).toEqual(args);
  });

  it('summarises the JSON report into bounded top lists and ignores hosts', () => {
    const s = summarizeGoaccess(REPORT, { domain: 'example.com', logFiles: ['/var/log/whm/domlogs/alice/example.com-access.log'], generatedAt: '2026-11-05T01:00:00.000Z' });
    expect(s).toMatchObject({ version: SUMMARY_VERSION, domain: 'example.com', generatedAt: '2026-11-05T01:00:00.000Z', period: { start: '04/Nov/2026', end: '05/Nov/2026' } });
    expect(s.totals).toEqual({ requests: 222, validRequests: 220, failedRequests: 2, visitors: 60, files: 15, notFound: 75, referrers: 5, bandwidth: 1088699, logBytes: 36264 });
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-04']);
    expect(s.pages.map((p) => p.label)).toEqual(['/', '/about']);
    expect(s.pages[0]).toEqual({ label: '/', hits: 74, visitors: 46, bytes: 724513 });
    expect(s.notFound[0].label).toBe('/favicon.ico');
    expect(s.referrers[0].label).toBe('example.org');
    expect(s.statusCodes[0].hits).toBe(111);
    expect(s.countries).toEqual([]);
    expect(s).not.toHaveProperty('hosts');
    expect(summarizeGoaccess(null, { domain: 'x.test' }).totals.requests).toBe(0);
    const big = { requests: { data: Array.from({ length: 50 }, (_, i) => ({ data: `/p${i}`, hits: { count: i } })) } };
    expect(summarizeGoaccess(big, { domain: 'x.test' }).pages).toHaveLength(10);
  });

  it('rejects injection, traversal and foreign log paths before running anything', async () => {
    exec.mockClear();
    const bad = [
      { ...RUN, username: 'root;id' }, { ...RUN, username: '-R' }, { ...RUN, domain: '-r' }, { ...RUN, domain: '../etc' }, { ...RUN, domain: 'a;b.com' }, { ...RUN, domain: 'Example.COM' },
      { ...RUN, logFiles: [] }, { ...RUN, logFiles: ['relative.log'] }, { ...RUN, logFiles: ['/var/log/whm/domlogs/alice/../bob/x.log'] }, { ...RUN, logFiles: ['/var/log/whm/x\0'] },
      { ...RUN, logFile: '/var/log/whm/domlogs/alice/example.com-access.log' }, { ...RUN, outHtml: '/home/alice/x.html' }, { ...RUN, extra: 1 },
    ];
    for (const args of bad) expect((await opError(runOp('stats.goaccess.run', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('stats.goaccess.detect', { verbose: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('stats.goaccess.detect reports presence without failing on a bare host', async () => {
    const d = await runOp('stats.goaccess.detect', {}, ctx);
    expect(d).toMatchObject({ installed: expect.any(Boolean), packages: { apt: ['goaccess'] }, statsDir: '.keel/stats' });
    if (d.installed) expect(d.version).toMatch(/^\d+\.\d+/);
  });

  it('pins every log under the account\'s own domlog directory and refuses foreign ones before any command', async () => {
    exec.mockClear();
    resolveBinary.mockImplementation((name) => (name === 'goaccess' ? '/usr/bin/true' : actualExec.resolveBinary(name)));
    const existingUser = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find((f) => Number(f[2]) >= 1000 && /^[a-z][a-z0-9_-]{0,31}$/.test(f[0]) && f[5]?.startsWith('/home/'))?.[0];
    const cases = [
      ['/etc/shadow', ['path_not_allowed', 'not_found']],
      ['/var/log/whm/domlogs/bob/example.com-access.log', ['path_not_allowed', 'not_found']],
      [`/var/log/whm/domlogs/${existingUser || 'alice'}/other.com-access.log`, ['path_not_allowed', 'not_found']],
      [`/var/log/whm/domlogs/${existingUser || 'alice'}/sub/example.com-access.log`, ['path_not_allowed', 'not_found']],
    ];
    for (const [log, codes] of cases) {
      const err = await opError(runOp('stats.goaccess.run', { ...RUN, username: existingUser || 'alice', logFiles: [log] }, ctx));
      expect(codes, log).toContain(err.code);
    }
    expect(exec).not.toHaveBeenCalled();
    // A missing or empty log is a skip, not a failure, and still runs nothing.
    if (existingUser) {
      const r = await runOp('stats.goaccess.run', { ...RUN, username: existingUser, logFiles: [`/var/log/whm/domlogs/${existingUser}/example.com-absent-access.log`] }, ctx);
      expect(r).toMatchObject({ skipped: true, reason: 'no_log', html: expect.stringContaining('/.keel/stats/example.com.html') });
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it('refuses to run when goaccess is missing', async () => {
    exec.mockClear();
    resolveBinary.mockImplementation((name) => (name === 'goaccess' ? null : actualExec.resolveBinary(name)));
    const err = await opError(runOp('stats.goaccess.run', RUN, ctx));
    expect(err.code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });
});
