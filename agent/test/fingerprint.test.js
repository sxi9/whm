import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { h, combine, parseDefaultRouteDev, parseLinkMac, parseFindmntUuid } from '../src/ops/fingerprint.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();
const HEX64 = /^[0-9a-f]{64}$/;

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

  it('parses iproute2 and findmnt JSON defensively', () => {
    expect(parseDefaultRouteDev('[{"dst":"default","gateway":"10.0.0.1","dev":"eth0"}]')).toBe('eth0');
    expect(parseDefaultRouteDev('[{"dst":"default","dev":"eth0; rm -rf /"}]')).toBe(null);
    expect(parseDefaultRouteDev('not json')).toBe(null);
    expect(parseLinkMac('[{"ifname":"eth0","address":"AA:BB:CC:DD:EE:FF"}]')).toBe('aa:bb:cc:dd:ee:ff');
    expect(parseLinkMac('[{"ifname":"lo","address":"00:00:00:00:00:00"}]')).toBe(null);
    expect(parseLinkMac('[{"ifname":"x","address":"nope"}]')).toBe(null);
    expect(parseFindmntUuid('{"filesystems":[{"uuid":"9f1b2c3d-1111-2222-3333-444455556666"}]}')).toBe('9f1b2c3d-1111-2222-3333-444455556666');
    expect(parseFindmntUuid('{"filesystems":[{"uuid":"../x"}]}')).toBe(null);
    expect(parseFindmntUuid('{}')).toBe(null);
  });
});
