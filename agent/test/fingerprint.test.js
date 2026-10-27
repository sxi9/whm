import crypto from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { exec, hasBinary } from '../src/exec.js';
import { h, combine, parseDefaultRouteDev, parseLinkMac, parseFindmntUuid, parseFindmntSource, parseBlkidUuid } from '../src/ops/fingerprint.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const actual = await vi.importActual('../src/exec.js');
const ctx = createContext();
const HEX64 = /^[0-9a-f]{64}$/;

afterEach(() => {
  exec.mockReset();
  exec.mockImplementation(actual.exec);
  hasBinary.mockReset();
  hasBinary.mockImplementation(actual.hasBinary);
});

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

describe('sys.fingerprint', () => {
  it('is registered read-only and takes no arguments at all', async () => {
    expect(catalog.has('sys.fingerprint')).toBe(true);
    expect(catalog.get('sys.fingerprint').destructive).toBe(false);
    for (const args of [{ path: '/etc/machine-id' }, { raw: true }, { components: ['mac'] }, { iface: 'eth0; id' }, { x: 1 }]) {
      expect((await opError(runOp('sys.fingerprint', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
  });

  it('returns only hashes: every component is a sha256 hex digest and no raw identifier appears', async () => {
    const out = await runOp('sys.fingerprint', {}, ctx);
    expect(out.version).toBe('whmfp1');
    expect(out.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(out.components).sort()).toEqual(['disk', 'mac', 'machine_id']);
    for (const v of Object.values(out.components)) expect(v).toMatch(HEX64);
    expect(Object.keys(out.available).sort()).toEqual(['disk', 'mac', 'machine_id']);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/[0-9a-f]{2}(:[0-9a-f]{2}){5}/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toMatch(/\/dev\//);
    expect(out.fingerprint).toBe(combine(out.components));
  });

  it('is deterministic for the same host and changes when a component changes', async () => {
    const a = await runOp('sys.fingerprint', {}, ctx);
    const b = await runOp('sys.fingerprint', {}, ctx);
    expect(a.fingerprint).toBe(b.fingerprint);
    const changed = combine({ ...a.components, mac: h('02:00:00:00:00:01') });
    expect(changed).not.toBe(a.fingerprint);
    expect(combine({ machine_id: h('a'), mac: h('b'), disk: h('c') })).toBe(`sha256:${crypto.createHash('sha256').update(`whmfp1|${h('a')}|${h('b')}|${h('c')}`).digest('hex')}`);
  });

  it('parses iproute2, findmnt and blkid output defensively', () => {
    expect(parseDefaultRouteDev('[{"dst":"default","gateway":"10.0.0.1","dev":"eth0"}]')).toBe('eth0');
    expect(parseDefaultRouteDev('[{"dst":"default","dev":"eth0; rm -rf /"}]')).toBe(null);
    expect(parseDefaultRouteDev('[{"dst":"default","dev":".."}]')).toBe(null);
    expect(parseDefaultRouteDev('[{"dst":"default","dev":"."}]')).toBe(null);
    expect(parseDefaultRouteDev('[{"dst":"default","dev":"../../etc"}]')).toBe(null);
    expect(parseDefaultRouteDev('[{"dst":"default","dev":"br-lan.10"}]')).toBe('br-lan.10');
    expect(parseDefaultRouteDev('not json')).toBe(null);
    expect(parseLinkMac('[{"ifname":"eth0","address":"AA:BB:CC:DD:EE:FF"}]')).toBe('aa:bb:cc:dd:ee:ff');
    expect(parseLinkMac('[{"ifname":"lo","address":"00:00:00:00:00:00"}]')).toBe(null);
    expect(parseLinkMac('[{"ifname":"x","address":"nope"}]')).toBe(null);
    expect(parseFindmntUuid('{"filesystems":[{"uuid":"9f1b2c3d-1111-2222-3333-444455556666"}]}')).toBe('9f1b2c3d-1111-2222-3333-444455556666');
    expect(parseFindmntUuid('{"filesystems":[{"uuid":"../x"}]}')).toBe(null);
    expect(parseFindmntUuid('{}')).toBe(null);
    expect(parseFindmntSource('{"filesystems":[{"uuid":null,"source":"/dev/sda1"}]}')).toBe('/dev/sda1');
    expect(parseFindmntSource('{"filesystems":[{"source":"/dev/mapper/vg0-root"}]}')).toBe('/dev/mapper/vg0-root');
    expect(parseFindmntSource('{"filesystems":[{"source":"/dev/nvme0n1p2[/@]"}]}')).toBe('/dev/nvme0n1p2');
    expect(parseFindmntSource('{"filesystems":[{"source":"overlay"}]}')).toBe(null);
    expect(parseFindmntSource('{"filesystems":[{"source":"/dev/../etc/passwd"}]}')).toBe(null);
    expect(parseFindmntSource('{"filesystems":[{"source":"/dev/sda1 -o x"}]}')).toBe(null);
    expect(parseFindmntSource('{"filesystems":[{"source":"/etc/passwd"}]}')).toBe(null);
    expect(parseFindmntSource('nope')).toBe(null);
    expect(parseBlkidUuid('9f1b2c3d-1111-2222-3333-444455556666\n')).toBe('9f1b2c3d-1111-2222-3333-444455556666');
    expect(parseBlkidUuid('')).toBe(null);
    expect(parseBlkidUuid('bad value with spaces')).toBe(null);
  });

  it('falls back to blkid on the root source when findmnt reports no UUID, and only then to /dev/disk/by-id', async () => {
    const calls = [];
    hasBinary.mockImplementation(() => true);
    exec.mockImplementation(async (bin, argv) => {
      calls.push([bin, argv]);
      if (bin === 'ip' && argv.includes('route')) return { code: 0, stdout: '[{"dst":"default","dev":"eth0"}]', stderr: '' };
      if (bin === 'ip' && argv.includes('link')) return { code: 0, stdout: '[{"ifname":"eth0","address":"02:00:00:00:00:01"}]', stderr: '' };
      if (bin === 'findmnt') return { code: 0, stdout: '{"filesystems":[{"uuid":null,"source":"/dev/mapper/vg0-root"}]}', stderr: '' };
      if (bin === 'blkid') return { code: 0, stdout: '9f1b2c3d-1111-2222-3333-444455556666\n', stderr: '' };
      throw new Error(`unexpected ${bin}`);
    });
    const out = await runOp('sys.fingerprint', {}, ctx);
    expect(calls.find(([b]) => b === 'findmnt')[1]).toEqual(['-J', '-o', 'UUID,SOURCE', '/']);
    expect(calls.find(([b]) => b === 'blkid')[1]).toEqual(['-o', 'value', '-s', 'UUID', '/dev/mapper/vg0-root']);
    expect(out.components.disk).toBe(h('9f1b2c3d-1111-2222-3333-444455556666'));
    expect(out.components.mac).toBe(h('02:00:00:00:00:01'));
    expect(out.available.disk).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/\/dev\/|9f1b2c3d/);

    // blkid absent or silent: no blkid call, the by-id listing (or "missing") decides
    calls.length = 0;
    hasBinary.mockImplementation((name) => name !== 'blkid');
    const noBlkid = await runOp('sys.fingerprint', {}, ctx);
    expect(calls.some(([b]) => b === 'blkid')).toBe(false);
    expect(noBlkid.components.disk).toMatch(HEX64);
    expect(noBlkid.components.disk).not.toBe(out.components.disk);
  });
});
