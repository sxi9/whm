import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { stanza, stripStanza, detectLayout } from '../src/ops/dns.js';

// exec is spied with the real implementation behind it so tests can prove an op
// refused before any program ran. Nothing here writes to a BIND directory: the
// dev box has no BIND layout, so every disk op must stop at capability_missing.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

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

describe('dns op catalog', () => {
  it('registers the whole family with destructive flags on removals', () => {
    for (const name of ['dns.layout', 'dns.zone.list', 'dns.zone.read', 'dns.zone.write', 'dns.zone.remove', 'dns.checkzone', 'dns.checkconf', 'dns.reload', 'dns.dnssec.keygen', 'dns.dnssec.sign', 'dns.dnssec.remove', 'dns.resolve']) {
      expect(catalog.has(name), name).toBe(true);
    }
    expect(catalog.get('dns.zone.remove').destructive).toBe(true);
    expect(catalog.get('dns.dnssec.remove').destructive).toBe(true);
    expect(catalog.get('dns.zone.write').destructive).toBe(false);
  });

  it('rejects unknown ops in the family', async () => {
    expect((await opError(runOp('dns.zone.exec', { domain: 'example.com' }, ctx))).code).toBe('unknown_op');
  });
});

describe('dns schemas reject injection and traversal', () => {
  const bad = ['-r', 'a;b.com', '../etc', 'example.com/../x', 'Example.COM', 'exa mple.com', '', 'example.com\n', '$(id).com', 'localhost'];
  for (const op of ['dns.zone.read', 'dns.zone.write', 'dns.zone.remove', 'dns.checkzone', 'dns.dnssec.keygen', 'dns.dnssec.sign', 'dns.dnssec.remove']) {
    it(`${op} refuses bad domains before running anything`, async () => {
      exec.mockClear();
      for (const domain of bad) {
        const err = await opError(runOp(op, { domain, body: op === 'dns.zone.write' ? 'x' : undefined }, ctx));
        expect(err.code, `${op} ${JSON.stringify(domain)}`).toBe('invalid_args');
        expect(err.details.fields.domain).toBeDefined();
      }
      expect(exec).not.toHaveBeenCalled();
    });
  }

  it('dns.reload refuses option-like and shell-like zone names', async () => {
    for (const domain of ['-a', 'x;reload', 'a b.com']) expect((await opError(runOp('dns.reload', { domain }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('dns.reload', { domain: 'example.com', extra: 1 }, ctx))).code).toBe('invalid_args');
  });

  it('dns.zone.write validates allowTransfer as IPs and rejects unknown keys', async () => {
    for (const allowTransfer of [['10.0.0.1; rm -rf /'], ['not-an-ip'], 'x']) {
      expect((await opError(runOp('dns.zone.write', { domain: 'example.com', body: '', allowTransfer }, ctx))).code).toBe('invalid_args');
    }
    expect((await opError(runOp('dns.zone.write', { domain: 'example.com', body: '', path: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('dns.zone.write', { domain: 'example.com' }, ctx))).code).toBe('invalid_args');
  });

  it('dns.dnssec.keygen only accepts known algorithms and bounded key sizes', async () => {
    expect((await opError(runOp('dns.dnssec.keygen', { domain: 'example.com', algorithm: 'RSASHA256 -f' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('dns.dnssec.keygen', { domain: 'example.com', bits: 128 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('dns.dnssec.keygen', { domain: 'example.com', bits: '2048' }, ctx))).code).toBe('invalid_args');
  });

  it('dns.resolve constrains name, type and servers', async () => {
    for (const args of [{ name: '--help' }, { name: 'a b' }, { name: 'example.com', type: 'ANY' }, { name: 'example.com', servers: ['8.8.8.8;id'] }, { name: 'example.com', servers: new Array(9).fill('8.8.8.8') }, { name: 'example.com', timeoutMs: 10 }]) {
      expect((await opError(runOp('dns.resolve', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
  });
});

describe('dns ops on a host without BIND', () => {
  it('dns.layout reports the installation state without throwing', async () => {
    const layout = await runOp('dns.layout', {}, ctx);
    expect(typeof layout.installed).toBe('boolean');
    expect(layout.binaries).toHaveProperty('named');
    expect(layout.binaries).toHaveProperty('rndc');
    expect([null, 'debian', 'rhel']).toContain(layout.flavor);
    expect(layout).toEqual(detectLayout());
  });

  it('dns.zone.list is empty and non-fatal', async () => {
    const result = await runOp('dns.zone.list', {}, ctx);
    expect(Array.isArray(result.zones)).toBe(true);
  });

  it('disk ops stop with capability_missing before executing anything', async () => {
    if (detectLayout().flavor) return;
    exec.mockClear();
    for (const [op, args] of [
      ['dns.zone.read', { domain: 'example.com' }], ['dns.zone.write', { domain: 'example.com', body: '$TTL 1\n' }], ['dns.zone.remove', { domain: 'example.com' }],
      ['dns.reload', {}], ['dns.checkconf', {}], ['dns.dnssec.keygen', { domain: 'example.com' }], ['dns.dnssec.sign', { domain: 'example.com' }], ['dns.dnssec.remove', { domain: 'example.com' }],
    ]) {
      expect((await opError(runOp(op, args, ctx))).code, op).toBe('capability_missing');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('dns.checkzone needs named-checkzone', async () => {
    if (detectLayout().binaries['named-checkzone']) return;
    expect((await opError(runOp('dns.checkzone', { domain: 'example.com', body: '@ IN SOA a. b. 1 1 1 1 1\n' }, ctx))).code).toBe('capability_missing');
  });

  it('dns.resolve returns a structured error instead of throwing when the server is unreachable', async () => {
    const result = await runOp('dns.resolve', { name: 'example.invalid', type: 'A', servers: ['127.0.0.1'], timeoutMs: 300 }, ctx);
    expect(result.servers).toEqual(['127.0.0.1']);
    expect(Array.isArray(result.answers)).toBe(true);
    expect(result.error === null || typeof result.error === 'string').toBe(true);
  });
});

describe('named include stanza helpers', () => {
  it('renders a stanza with markers and transfer ACL', () => {
    const s = stanza('example.com', '/etc/bind/zones/example.com.db', ['10.0.0.2']);
    expect(s).toContain('// BEGIN whm zone example.com\n');
    expect(s).toContain('zone "example.com" {');
    expect(s).toContain('file "/etc/bind/zones/example.com.db";');
    expect(s).toContain('allow-transfer { 10.0.0.2; };');
    expect(s.endsWith('// END whm zone example.com\n')).toBe(true);
    expect(stanza('a.com', '/x')).toContain('allow-transfer { none; };');
  });

  it('strips exactly one zone and leaves the neighbours untouched', () => {
    const text = `// header\n${stanza('a.com', '/a')}${stanza('a.com.au', '/aau')}${stanza('b.com', '/b')}`;
    const out = stripStanza(text, 'a.com');
    expect(out).not.toContain('zone "a.com" {');
    expect(out).toContain('zone "a.com.au" {');
    expect(out).toContain('zone "b.com" {');
    expect(out).toContain('// header');
    expect(stripStanza(out, 'nope.com')).toBe(out);
  });
});
