import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { stanza, stripStanza, currentStanza, declaredElsewhere, detectLayout, parseNamedConf, resolveZonePath, signzoneArgv, removeZone, spliceOptionsBlock, optionsDirectives, chooseResolvers } from '../src/ops/dns.js';

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
    for (const name of ['dns.layout', 'dns.zone.list', 'dns.zone.read', 'dns.zone.write', 'dns.zone.remove', 'dns.checkzone', 'dns.checkconf', 'dns.reload', 'dns.dnssec.keygen', 'dns.dnssec.sign', 'dns.dnssec.status', 'dns.dnssec.remove', 'dns.resolve', 'dns.options.write']) {
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
  for (const op of ['dns.zone.read', 'dns.zone.write', 'dns.zone.remove', 'dns.checkzone', 'dns.dnssec.keygen', 'dns.dnssec.sign', 'dns.dnssec.status', 'dns.dnssec.remove']) {
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

  it('dns.reload refuses option-like and shell-like zone names and a non-boolean reconfig', async () => {
    for (const domain of ['-a', 'x;reload', 'a b.com']) expect((await opError(runOp('dns.reload', { domain }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('dns.reload', { domain: 'example.com', extra: 1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('dns.reload', { domain: 'example.com', reconfig: 'yes' }, ctx))).code).toBe('invalid_args');
  });

  it('zone text handed to named-checkzone / named may not use $INCLUDE or $GENERATE', async () => {
    exec.mockClear();
    const bodies = ['$INCLUDE /etc/shadow\n', '$TTL 1\n  $include "/etc/bind/rndc.key"\n', '@ IN SOA a. b. 1 1 1 1 1\n$GENERATE 1-100 host$ A 10.0.0.$\n', '$ORIGIN example.com.\n\t$INCLUDE keys/Kexample.com.key\n'];
    for (const body of bodies) {
      for (const op of ['dns.zone.write', 'dns.checkzone']) {
        const err = await opError(runOp(op, { domain: 'example.com', body }, ctx));
        expect(err.code, `${op} ${JSON.stringify(body)}`).toBe('invalid_args');
        expect(err.details.fields.body).toBeDefined();
      }
    }
    expect(exec).not.toHaveBeenCalled();
    // A TXT record mentioning the directive is data, not a directive.
    const ok = await opError(runOp('dns.checkzone', { domain: 'example.com', body: '@ IN TXT "$INCLUDE is just text"\n' }, ctx));
    expect(ok.code).not.toBe('invalid_args');
  });

  it('dns.dnssec.sign and dns.dnssec.status take only a domain', async () => {
    for (const op of ['dns.dnssec.sign', 'dns.dnssec.status']) {
      expect((await opError(runOp(op, { domain: 'example.com', maxAgeSeconds: 60 }, ctx))).code).toBe('invalid_args');
      expect((await opError(runOp(op, { domain: 'example.com', file: '/etc/shadow' }, ctx))).code).toBe('invalid_args');
    }
  });

  it('dnssec-signzone keeps the serial of the unsigned zone (the YYYYMMDDnn the panel tracks)', () => {
    const argv = signzoneArgv('/etc/bind/zones/keys/example.com', 'example.com', '/etc/bind/zones/example.com.db', '/etc/bind/zones/example.com.db.signed');
    expect(argv.slice(argv.indexOf('-N'), argv.indexOf('-N') + 2)).toEqual(['-N', 'keep']);
    expect(argv).not.toContain('unixtime');
    expect(argv).not.toContain('increment');
    expect(argv.slice(-1)).toEqual(['/etc/bind/zones/example.com.db']);
    expect(argv.slice(argv.indexOf('-f'), argv.indexOf('-f') + 2)).toEqual(['-f', '/etc/bind/zones/example.com.db.signed']);
    expect(argv.slice(argv.indexOf('-o'), argv.indexOf('-o') + 2)).toEqual(['-o', 'example.com']);
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

  it('dns.options.write takes only well-formed IPv4/IPv6 source addresses', async () => {
    exec.mockClear();
    for (const args of [{ ipv4: '1.2.3.4; rm -rf /' }, { ipv4: '2001:db8::1' }, { ipv6: '10.0.0.1' }, { ipv6: '2001:db8::1 }' }, { ipv4: '10.0.0.1', extra: true }, { address: '10.0.0.1' }]) {
      expect((await opError(runOp('dns.options.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
    if (!detectLayout().flavor) expect((await opError(runOp('dns.options.write', { ipv4: '10.0.0.1' }, ctx))).code).toBe('capability_missing');
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
      ['dns.reload', {}], ['dns.checkconf', {}], ['dns.dnssec.keygen', { domain: 'example.com' }], ['dns.dnssec.sign', { domain: 'example.com' }], ['dns.dnssec.status', { domain: 'example.com' }], ['dns.dnssec.remove', { domain: 'example.com' }],
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

  it('finds the current stanza of one zone so a changed file or ACL is detected', () => {
    const text = `${stanza('a.com', '/a')}${stanza('a.com.au', '/aau', ['10.0.0.2'])}`;
    expect(currentStanza(text, 'a.com')).toBe(stanza('a.com', '/a'));
    expect(currentStanza(text, 'a.com.au')).toBe(stanza('a.com.au', '/aau', ['10.0.0.2']));
    expect(currentStanza(text, 'a.com.au')).not.toBe(stanza('a.com.au', '/aau.signed', ['10.0.0.2']));
    expect(currentStanza(text, 'b.com')).toBeNull();
  });

  it('parses zone stanzas (name, type, file) and options.directory out of named.conf text', () => {
    const text = [
      'options {', '  directory "/var/cache/bind";', '  allow-transfer { none; };', '};',
      '// zone "commented.out" { type master; file "nope"; };',
      '/* zone "block.comment" { type master; file "nope"; }; */',
      '# zone "hash.comment" { type master; file "nope"; };',
      'zone "example.com" IN {', '  type master;', '  file "/etc/bind/db.example.com";', '  allow-transfer { 10.0.0.2; };', '  also-notify { 10.0.0.3; };', '};',
      'zone "Relative.Example." {', '  type primary;', '  file "db.relative";', '};',
      'zone "slave.example" { type slave; masters { 10.0.0.1; }; file "slaves/slave.db"; };',
      'view "internal" {', '  match-clients { 10/8; };', '  zone "view.example" { type master; file "/srv/view.db"; };', '};',
      'zone "." { type hint; file "named.ca"; };',
      'zone "nofile.example" { type master; };',
    ].join('\n');
    const conf = parseNamedConf(text);
    expect(conf.directory).toBe('/var/cache/bind');
    expect(conf.zones).toEqual([
      { domain: 'example.com', type: 'master', file: '/etc/bind/db.example.com' },
      { domain: 'relative.example', type: 'primary', file: 'db.relative' },
      { domain: 'slave.example', type: 'slave', file: 'slaves/slave.db' },
      { domain: 'view.example', type: 'master', file: '/srv/view.db' },
      { domain: '.', type: 'hint', file: 'named.ca' },
      { domain: 'nofile.example', type: 'master', file: null },
    ]);
    expect(parseNamedConf('')).toEqual({ directory: null, zones: [] });
    expect(parseNamedConf('zone "broken.example" { type master; file "x"').zones).toEqual([{ domain: 'broken.example', type: 'master', file: 'x' }]);
  });

  it('resolves relative zone files against options.directory or the flavor default', () => {
    expect(resolveZonePath('/etc/bind/db.x', '/var/cache/bind', { flavor: 'debian', zoneDir: '/etc/bind/zones' })).toBe('/etc/bind/db.x');
    expect(resolveZonePath('db.x', '/var/cache/bind', { flavor: 'debian', zoneDir: '/etc/bind/zones' })).toBe('/var/cache/bind/db.x');
    expect(resolveZonePath('db.x', null, { flavor: 'debian', zoneDir: '/etc/bind/zones' })).toBe('/var/cache/bind/db.x');
    expect(resolveZonePath('x.db', null, { flavor: 'rhel', zoneDir: '/var/named' })).toBe('/var/named/x.db');
    expect(resolveZonePath('/var/named//a/../x.db', null, { flavor: 'rhel', zoneDir: '/var/named' })).toBe('/var/named/x.db');
    expect(resolveZonePath(null, '/var/named', { flavor: 'rhel', zoneDir: '/var/named' })).toBeNull();
  });

  it('removeZone refuses a zone declared outside the panel include and only deletes panel-managed zones', async () => {
    if (detectLayout().binaries['named-checkconf']) return;
    fs.mkdirSync('/tmp/whm', { recursive: true });
    const dir = fs.mkdtempSync('/tmp/whm/dns-remove-');
    const layout = { flavor: 'rhel', confDir: dir, mainConf: path.join(dir, 'named.conf'), optionsConf: path.join(dir, 'named.conf'), includeFile: path.join(dir, 'named.whm.conf'), zoneDir: path.join(dir, 'zones') };
    try {
      fs.mkdirSync(layout.zoneDir, { recursive: true });
      fs.writeFileSync(layout.mainConf, `options { directory "${layout.zoneDir}"; };\nzone "hand.example" IN {\n  type master;\n  file "hand.db";\n};\ninclude "${layout.includeFile}";\n`);
      fs.writeFileSync(path.join(layout.zoneDir, 'hand.db'), '$TTL 1\n');
      fs.writeFileSync(path.join(layout.zoneDir, 'managed.example.db'), '$TTL 1\n');
      fs.writeFileSync(path.join(layout.zoneDir, 'managed.example.db.signed'), '$TTL 1\n');
      fs.writeFileSync(layout.includeFile, `${stanza('managed.example', path.join(layout.zoneDir, 'managed.example.db'))}${stanza('other.example', '/x')}`);
      const err = await opError(removeZone(layout, 'hand.example', ctx));
      expect(err.code).toBe('zone_external');
      expect(err.details).toMatchObject({ file: path.join(layout.zoneDir, 'hand.db'), type: 'master' });
      expect(fs.existsSync(path.join(layout.zoneDir, 'hand.db'))).toBe(true);
      expect(fs.readFileSync(layout.mainConf, 'utf8')).toContain('zone "hand.example"');
      const result = await removeZone(layout, 'managed.example', ctx);
      expect(result).toMatchObject({ domain: 'managed.example', stanzaRemoved: true, external: false });
      expect(result.removed).toEqual(expect.arrayContaining([path.join(layout.zoneDir, 'managed.example.db'), path.join(layout.zoneDir, 'managed.example.db.signed')]));
      expect(fs.existsSync(path.join(layout.zoneDir, 'managed.example.db'))).toBe(false);
      const include = fs.readFileSync(layout.includeFile, 'utf8');
      expect(include).not.toContain('zone "managed.example"');
      expect(include).toContain('zone "other.example"');
      // A zone with neither a file nor a stanza is a no-op, not an error.
      expect(await removeZone(layout, 'absent.example', ctx)).toMatchObject({ removed: [], stanzaRemoved: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splices the source-address directives into the one options block and removes them again', () => {
    const conf = 'options {\n\tdirectory "/var/cache/bind";\n\tallow-transfer { none; }; // comment with }\n\tlisten-on { any; };\n};\n\nzone "x.example" { type master; file "x"; };\n';
    const directives = optionsDirectives({ ipv4: '203.0.113.9', ipv6: '2001:db8::9' });
    expect(directives).toEqual(['query-source address 203.0.113.9;', 'notify-source 203.0.113.9;', 'transfer-source 203.0.113.9;', 'query-source-v6 address 2001:db8::9;', 'notify-source-v6 2001:db8::9;', 'transfer-source-v6 2001:db8::9;']);
    const once = spliceOptionsBlock(conf, directives);
    expect(once).toContain('    // BEGIN whm options\n    query-source address 203.0.113.9;');
    expect(once).toMatch(/listen-on \{ any; \};\n    \/\/ BEGIN whm options\n[\s\S]*?    \/\/ END whm options\n\};\n\nzone "x\.example"/);
    expect(once).toContain('zone "x.example"');
    const again = spliceOptionsBlock(once, optionsDirectives({ ipv4: '198.51.100.1' }));
    expect(again).not.toContain('203.0.113.9');
    expect(again).toContain('query-source address 198.51.100.1;');
    expect(again.match(/BEGIN whm options/g)).toHaveLength(1);
    expect(spliceOptionsBlock(again, [])).toBe(conf);
    expect(spliceOptionsBlock(conf, [])).toBe(conf);
    expect(spliceOptionsBlock(once, directives)).toBe(once);
    // Comments mentioning options do not count, and a missing block is an error.
    expect(() => spliceOptionsBlock('// options { }\nzone "a.example" { type master; file "a"; };\n', directives)).toThrow(OpError);
    expect(() => spliceOptionsBlock('options {\n directory "x";\n', directives)).toThrow(/not closed/);
    const nested = spliceOptionsBlock('options { directory "/var/named"; rate-limit { responses-per-second 5; }; };\n', optionsDirectives({ ipv4: '10.0.0.1' }));
    expect(nested).toMatch(/responses-per-second 5; };\n    \/\/ BEGIN whm options\n[\s\S]*\/\/ END whm options\n};/);
  });

  it('prefers the host resolvers, then systemd-resolved upstreams, then the stub, and only then public resolvers', () => {
    expect(chooseResolvers('nameserver 10.0.0.2\nnameserver 127.0.0.53\n', 'nameserver 10.1.1.1\n')).toEqual(['10.0.0.2']);
    expect(chooseResolvers('nameserver 127.0.0.53\noptions edns0\n', 'nameserver 10.1.1.1\nnameserver 10.1.1.2\n')).toEqual(['10.1.1.1', '10.1.1.2']);
    expect(chooseResolvers('nameserver 127.0.0.53\n', '')).toEqual(['127.0.0.53']);
    expect(chooseResolvers('nameserver ::1\n', 'nameserver 127.0.0.1\n')).toEqual(['::1']);
    expect(chooseResolvers('# empty\n', '')).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  it('detects a zone the operator declared outside the panel include and reports which file named loads', async () => {
    if (detectLayout().binaries['named-checkconf']) return;
    const dir = fs.mkdtempSync('/tmp/whm/dns-test-');
    const layout = { flavor: 'rhel', confDir: dir, mainConf: path.join(dir, 'named.conf'), includeFile: path.join(dir, 'named.whm.conf'), zoneDir: path.join(dir, 'zones') };
    try {
      fs.writeFileSync(layout.mainConf, 'options { directory "/var/named"; };\ninclude "named.rfc1912.zones";\nzone "hand.example" IN {\n  type master;\n  file "hand.db";\n};\nzone "secondary.example" { type slave; file "slaves/sec.db"; masters { 10.0.0.1; }; };\n');
      fs.writeFileSync(path.join(dir, 'named.rfc1912.zones'), 'zone "localhost" { type master; file "named.localhost"; };\nzone "other.example" {\n type master; file "/etc/bind/db.other"; };\n');
      fs.writeFileSync(layout.includeFile, `${stanza('managed.example', '/x')}`);
      expect(await declaredElsewhere(layout, 'hand.example', ctx)).toEqual({ external: true, type: 'master', file: '/var/named/hand.db' });
      expect(await declaredElsewhere(layout, 'other.example', ctx)).toEqual({ external: true, type: 'master', file: '/etc/bind/db.other' });
      expect(await declaredElsewhere(layout, 'secondary.example', ctx)).toEqual({ external: true, type: 'slave', file: '/var/named/slaves/sec.db' });
      expect(await declaredElsewhere(layout, 'managed.example', ctx)).toEqual({ external: false, type: null, file: null });
      expect(await declaredElsewhere(layout, 'example', ctx)).toMatchObject({ external: false });
      expect(await declaredElsewhere(layout, 'hand.example.org', ctx)).toMatchObject({ external: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
