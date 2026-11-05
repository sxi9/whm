import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { parseDigShort, parseTraceroute, isPublicAddress, LOOKUP_TYPES, TRACE_MAX_HOPS } from '../src/ops/dns-track.js';

// exec and hasBinary are spied so the ops can be driven without dig or
// traceroute on the box; no probe is ever sent from a test.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary, ExecError } = await import('../src/exec.js');

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

const TRACE_OUT = `traceroute to example.com (93.184.216.34), 20 hops max, 60 byte packets
 1  10.0.0.1  0.412 ms  0.398 ms  0.371 ms
 2  * * *
 3  198.51.100.7  1.201 ms 198.51.100.8  1.150 ms  1.102 ms
 4  203.0.113.9  12.5 ms  * 12.9 ms
 5  93.184.216.34  13.001 ms !X 12.980 ms  12.944 ms
`;

beforeEach(() => { exec.mockClear(); hasBinary.mockReset(); hasBinary.mockReturnValue(true); });

describe('dns-track op catalog', () => {
  it('registers both read-only ops', () => {
    expect(catalog.has('dns.lookup')).toBe(true);
    expect(catalog.has('dns.trace')).toBe(true);
    expect(catalog.get('dns.lookup').destructive).toBe(false);
    expect(catalog.get('dns.trace').destructive).toBe(false);
    expect(LOOKUP_TYPES).toEqual(['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA', 'PTR']);
  });
});

describe('dns-track schemas refuse injection before anything runs', () => {
  const bad = ['-x', '--help', '+trace', 'a;b.com', 'a b.com', 'example.com/../x', 'Example.COM', '', 'example.com\n', '$(id).com', '`id`.com', 'a.com|cat', 'x'.repeat(254), 'localhost;id', '-1.2.3.4',
    // Not public: the host's own loopback, private, CGNAT, link-local (cloud metadata), unspecified and multicast ranges.
    'localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1'];
  it('isPublicAddress keeps documentation and public ranges and refuses the host-local ones', () => {
    for (const ip of ['203.0.113.9', '198.51.100.1', '172.32.0.1', '8.8.8.8', '2001:db8::1', '2606:4700::1111', '::ffff:203.0.113.9']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.255.254', '192.168.0.1', '169.254.169.254', '100.127.0.1', '0.0.0.0', '239.1.1.1', '255.255.255.255', '::1', '::', 'fc00::', 'fdff::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', 'example.com']) expect(isPublicAddress(ip), ip).toBe(false);
  });
  it('dns.lookup refuses bad names, unknown types and extra keys', async () => {
    for (const name of bad) {
      const err = await opError(runOp('dns.lookup', { name }, ctx));
      expect(err.code, JSON.stringify(name)).toBe('invalid_args');
      expect(err.details.fields.name).toBeDefined();
    }
    for (const args of [{ name: 'example.com', type: 'ANY' }, { name: 'example.com', type: 'a' }, { name: 'example.com', type: 'AXFR' }, { name: 'example.com', extra: 1 }]) {
      expect((await opError(runOp('dns.lookup', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('dns.trace refuses bad hosts and extra keys', async () => {
    for (const host of bad) {
      const err = await opError(runOp('dns.trace', { host }, ctx));
      expect(err.code, JSON.stringify(host)).toBe('invalid_args');
      expect(err.details.fields.host).toBeDefined();
    }
    expect((await opError(runOp('dns.trace', { host: 'example.com', m: 99 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('dns.lookup', () => {
  it('runs dig +short with a pinned argv and the name last', async () => {
    exec.mockResolvedValueOnce({ code: 0, stdout: '93.184.216.34\n93.184.216.35\n', stderr: '', bin: 'dig', argv: [] });
    const r = await runOp('dns.lookup', { name: 'example.com', type: 'A' }, ctx);
    expect(exec).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = exec.mock.calls[0];
    expect(bin).toBe('dig');
    expect(argv).toEqual(['+short', '+time=3', '+tries=1', 'example.com', 'A']);
    expect(opts.timeoutMs).toBe(15_000);
    expect(opts.allowFailure).toBe(true);
    expect(r).toMatchObject({ name: 'example.com', type: 'A', answers: ['93.184.216.34', '93.184.216.35'], error: null, exitCode: 0 });
  });

  it('defaults to A and accepts every pinned type and an IPv6 literal', async () => {
    exec.mockResolvedValue({ code: 0, stdout: '', stderr: '', bin: 'dig', argv: [] });
    const r = await runOp('dns.lookup', { name: 'example.com' }, ctx);
    expect(r.type).toBe('A');
    for (const type of LOOKUP_TYPES) await runOp('dns.lookup', { name: 'example.com', type }, ctx);
    await runOp('dns.lookup', { name: '2001:db8::1', type: 'AAAA' }, ctx);
    expect(exec.mock.calls.at(-1)[1]).toEqual(['+short', '+time=3', '+tries=1', '2001:db8::1', 'AAAA']);
  });

  it('turns a PTR lookup of a literal address into dig -x with the address after the flag', async () => {
    exec.mockResolvedValueOnce({ code: 0, stdout: 'host.example.com.\n', stderr: '', bin: 'dig', argv: [] });
    const r = await runOp('dns.lookup', { name: '203.0.113.9', type: 'PTR' }, ctx);
    expect(exec.mock.calls[0][1]).toEqual(['+short', '+time=3', '+tries=1', '-x', '203.0.113.9']);
    expect(r.answers).toEqual(['host.example.com.']);
    exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', bin: 'dig', argv: [] });
    await runOp('dns.lookup', { name: '9.113.0.203.in-addr.arpa', type: 'PTR' }, ctx);
    expect(exec.mock.calls[1][1]).toEqual(['+short', '+time=3', '+tries=1', '9.113.0.203.in-addr.arpa', 'PTR']);
  });

  it('reports a timeout as a structured error and keeps the diagnostics', async () => {
    exec.mockResolvedValueOnce({ code: 9, stdout: ';; communications error to 127.0.0.53#53: timed out\n;; no servers could be reached\n', stderr: '', bin: 'dig', argv: [] });
    const r = await runOp('dns.lookup', { name: 'example.com', type: 'MX' }, ctx);
    expect(r.answers).toEqual([]);
    expect(r.error).toBe('timeout');
    expect(r.notes[0]).toContain('timed out');
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '', bin: 'dig', argv: [] });
    expect((await runOp('dns.lookup', { name: 'example.com' }, ctx)).error).toBe('failed');
  });

  it('stops with capability_missing and the dnsutils hint when dig is absent', async () => {
    hasBinary.mockReturnValue(false);
    const err = await opError(runOp('dns.lookup', { name: 'example.com' }, ctx));
    expect(err.code).toBe('capability_missing');
    expect(err.details.package).toBe('dnsutils');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('dns.trace', () => {
  it('runs traceroute -n -w 2 -m 20 with the host last and parses the hops', async () => {
    exec.mockResolvedValueOnce({ code: 0, stdout: TRACE_OUT, stderr: '', bin: 'traceroute', argv: [] });
    const r = await runOp('dns.trace', { host: 'example.com' }, ctx);
    const [bin, argv, opts] = exec.mock.calls[0];
    expect(bin).toBe('traceroute');
    expect(argv).toEqual(['-n', '-w', '2', '-m', String(TRACE_MAX_HOPS), 'example.com']);
    expect(opts.timeoutMs).toBe(60_000);
    expect(r.target).toBe('93.184.216.34');
    expect(r.reached).toBe(true);
    expect(r.error).toBeNull();
    expect(r.hops).toHaveLength(5);
    expect(r.hops[0]).toEqual({ hop: 1, address: '10.0.0.1', addresses: ['10.0.0.1'], rtts: [0.412, 0.398, 0.371], timeouts: 0 });
    expect(r.hops[1]).toEqual({ hop: 2, address: null, addresses: [], rtts: [], timeouts: 3 });
    expect(r.hops[2].addresses).toEqual(['198.51.100.7', '198.51.100.8']);
    expect(r.hops[3]).toMatchObject({ rtts: [12.5, 12.9], timeouts: 1 });
    expect(r.hops[4].rtts).toEqual([13.001, 12.98, 12.944]);
  });

  it('accepts an IPv6 literal and reports an unresolvable host without throwing', async () => {
    exec.mockResolvedValueOnce({ code: 0, stdout: 'traceroute to 2001:db8::1 (2001:db8::1), 20 hops max, 80 byte packets\n 1  * * *\n', stderr: '', bin: 'traceroute', argv: [] });
    const r = await runOp('dns.trace', { host: '2001:db8::1' }, ctx);
    expect(exec.mock.calls[0][1].at(-1)).toBe('2001:db8::1');
    expect(r.reached).toBe(false);
    exec.mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'nope.invalid: Name or service not known\nCannot handle "host" cmdline arg `nope.invalid\' on position 1 (argc 2)\n', bin: 'traceroute', argv: [] });
    const u = await runOp('dns.trace', { host: 'nope.invalid' }, ctx);
    expect(u.error).toBe('unknown_host');
    expect(u.hops).toEqual([]);
  });

  it('answers error:timeout with no hops when the 60 s cap kills the run', async () => {
    exec.mockRejectedValueOnce(new ExecError('timeout', '"traceroute" did not finish within 60000ms', { stderr: '' }));
    const r = await runOp('dns.trace', { host: 'example.com' }, ctx);
    expect(r).toMatchObject({ host: 'example.com', error: 'timeout', hops: [], reached: false });
  });

  it('stops with capability_missing and the traceroute hint when the binary is absent', async () => {
    hasBinary.mockReturnValue(false);
    const err = await opError(runOp('dns.trace', { host: 'example.com' }, ctx));
    expect(err.code).toBe('capability_missing');
    expect(err.details.package).toBe('traceroute');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('parsers', () => {
  it('parseDigShort splits answers from ;; notes and keeps TXT quoting', () => {
    const { answers, notes } = parseDigShort('10 mail.example.com.\n"v=spf1 -all"\n\n;; Warning: x\n');
    expect(answers).toEqual(['10 mail.example.com.', '"v=spf1 -all"']);
    expect(notes).toEqual(['Warning: x']);
    expect(parseDigShort('')).toEqual({ answers: [], notes: [] });
  });

  it('parseTraceroute ignores lines that are not hops and reads the target from the header', () => {
    const r = parseTraceroute('garbage\n' + TRACE_OUT + 'trailing text\n');
    expect(r.target).toBe('93.184.216.34');
    expect(r.hops.map((h) => h.hop)).toEqual([1, 2, 3, 4, 5]);
    expect(r.reached).toBe(true);
    expect(parseTraceroute('')).toEqual({ header: null, target: null, hops: [], reached: false });
  });
});
