import { describe, it, expect, vi } from 'vitest';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import fs from 'node:fs';
import {
  renderHostsAllow, hostSourceForm, hostsDenyManaged, accessMode, archiveFormat, parseDistroCrsInclude, parseSshdConfig, sshdShadowed, parseAuthorizedKeys, parsePublicKeyLine, fingerprintOf, renderForkBombConf, parseForkBombConf,
  parseIptablesRules, parseNftChain, parseModsecDirectives, parseModsecRules, parseModsecErrorLog, renderUserdirConf, parseUserdirConf, firewallBackend, privateTempDir,
} from '../src/ops/sec.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@example';

describe('sec op schemas reject injection and traversal before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('sec.nope', {}, ctx))).code).toBe('unknown_op');
  });

  it('host access rules', async () => {
    exec.mockClear();
    for (const rule of [
      { service: 'sshd; rm -rf /', source: 'ALL', action: 'allow' },
      { service: 'sshd', source: '1.2.3.4 ALL', action: 'allow' },
      { service: 'sshd', source: 'ALL', action: 'DROP' },
      { service: 'sshd', source: 'ALL', action: 'allow', comment: 'multi\nline' },
      { service: '../etc', source: 'ALL', action: 'allow' },
      // ":" is libwrap's field separator: only a real IPv6 address/network may contain it.
      { service: 'sshd', source: 'host:name', action: 'allow' },
      { service: 'sshd', source: '2001:db8::1: ALLOW', action: 'deny' },
      { service: 'sshd', source: '2001:db8::/129', action: 'allow' },
      { service: 'sshd', source: '[2001:db8::zz]', action: 'allow' },
    ]) expect((await opError(runOp('sec.hosts_allow.write', { rules: [rule] }, ctx))).code, JSON.stringify(rule)).toBe('invalid_args');
    expect((await opError(runOp('sec.hosts_allow.write', { rules: [], extra: 1 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('sshd settings', async () => {
    exec.mockClear();
    for (const settings of [{ PasswordAuthentication: 'maybe' }, { PermitRootLogin: 'yes; id' }, { Port: 70000 }, { Banner: '/etc/issue' }, { MaxAuthTries: '3' }]) {
      expect((await opError(runOp('sec.sshd.set', { settings }, ctx))).code).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('ssh keys', async () => {
    exec.mockClear();
    expect((await opError(runOp('sec.ssh_keys.generate', { name: 'ok', passphrase: 'a\nb' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.generate', { name: '-rf' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.generate', { name: '../id_rsa' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.generate', { name: 'a/b' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.generate', { name: 'ok', type: 'dsa' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.generate', { name: 'ok', bits: 1024 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.generate', { name: 'ok', comment: 'a\nb' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.add', { publicKey: 'ssh-rsa AAAA\nssh-rsa BBBB' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.add', { publicKey: 'not a key' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.remove', { fingerprint: 'MD5:aa' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.export', { name: '../../etc/shadow' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.ssh_keys.delete_pair', { name: 'x', deauthorize: 'yes' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('compiler, traceroute and fork bomb', async () => {
    exec.mockClear();
    expect((await opError(runOp('sec.compiler_access.set', { allow: 'no' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.traceroute.set', { enabled: 1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.fork_bomb.set', { enabled: true, maxProcesses: -1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.fork_bomb.set', { enabled: true, excludeGroups: ['wheel sudo'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.fork_bomb.set', { enabled: true, excludeGroups: ['-r'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('firewall addresses', async () => {
    exec.mockClear();
    for (const ip of ['-s', '1.2.3.4;id', '1.2.3.4/33', '::1/129', 'example.com', '1.2.3', '1.2.3.4 -j ACCEPT']) {
      expect((await opError(runOp('sec.firewall.block', { ip }, ctx))).code, ip).toBe('invalid_args');
      expect((await opError(runOp('sec.firewall.unblock', { ip }, ctx))).code, ip).toBe('invalid_args');
    }
    expect((await opError(runOp('sec.smtp_restrict.set', { enabled: 'on' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('modsecurity', async () => {
    exec.mockClear();
    expect((await opError(runOp('sec.modsec.set_config', { directives: { SecRuleEngine: 'Maybe' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.modsec.set_config', { directives: { SecAuditLog: '/etc/passwd' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.modsec.set_config', { directives: { SecAuditLogRelevantStatus: '^(?:5|4(?!04))" Include /etc/passwd' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.modsec.set_disabled', { ids: ['941100'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.modsec.vendor.install', { name: 'owasp', url: 'http://example.com/x.tgz' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.modsec.vendor.install', { name: '../x', url: 'https://example.com/x.tgz' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.modsec.vendor.remove', { name: 'OWASP' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.modsec.vendors.apply', { vendors: [{ name: 'a b', enabled: true }] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('userdir and scan', async () => {
    exec.mockClear();
    expect((await opError(runOp('sec.userdir.set', { enabled: true, excludeUsers: ['-r'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sec.userdir.set', { enabled: true, homeRoot: '/home/../etc' }, ctx))).code).toBe('invalid_args');
    // homeRoot lands inside <Directory "..."> so anything that could close the
    // quote or add a directive is refused before Apache config is touched.
    for (const homeRoot of ['/home">\nInclude /etc/passwd', '/home"', '/home dir', '/home\n', 'home', '/home/', '/', `/${'a'.repeat(200)}`]) {
      expect((await opError(runOp('sec.userdir.set', { enabled: true, homeRoot }, ctx))).code, JSON.stringify(homeRoot)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
    expect((await opError(runOp('sec.scan.filesystem', { root: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('sec.scan.filesystem', { root: 'relative' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('sec ops refuse to act when the subsystem is missing (no side effects)', () => {
  it('sshd.set and ssh_keys.generate need their binaries', async () => {
    const { hasBinary } = await import('../src/exec.js');
    exec.mockClear();
    if (!hasBinary('sshd')) expect((await opError(runOp('sec.sshd.set', { settings: { PasswordAuthentication: 'no' } }, ctx))).code).toBe('capability_missing');
    if (!hasBinary('ssh-keygen')) expect((await opError(runOp('sec.ssh_keys.generate', { name: 'whm-test-key' }, ctx))).code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('modsec writers need ModSecurity + Apache', async () => {
    const detect = await runOp('sec.modsec.detect', {}, ctx);
    if (detect.installed) return;
    exec.mockClear();
    expect((await opError(runOp('sec.modsec.set_config', { directives: { SecRuleEngine: 'On' } }, ctx))).code).toBe('capability_missing');
    expect((await opError(runOp('sec.modsec.set_disabled', { ids: [1] }, ctx))).code).toBe('capability_missing');
    expect((await opError(runOp('sec.modsec.vendors.apply', { vendors: [] }, ctx))).code).toBe('capability_missing');
    expect((await opError(runOp('sec.modsec.hits', {}, ctx))).code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('read-only probes work on any host', async () => {
    const cc = await runOp('sec.compiler_access.get', {}, ctx);
    expect(typeof cc.installed).toBe('boolean');
    for (const b of cc.binaries) expect(b.mode).toMatch(/^0[0-7]{3}$/);
    const fb = await runOp('sec.fork_bomb.get', {}, ctx);
    expect(fb).toMatchObject({ path: '/etc/security/limits.d/whm-forkbomb.conf', maxProcesses: expect.any(Number) });
    const fw = await runOp('sec.firewall.detect', {}, ctx);
    expect([null, 'iptables', 'nft']).toContain(fw.backend);
    expect(fw.backend).toBe(firewallBackend());
    const sshd = await runOp('sec.sshd.get', {}, ctx);
    expect(typeof sshd.installed).toBe('boolean');
    expect(typeof sshd.effective).toBe('object');
    expect(sshd.managedPath).toBe('/etc/ssh/sshd_config.d/00-whm.conf');
    expect(Array.isArray(sshd.shadowed)).toBe(true);
    const scan = await runOp('sec.scan.filesystem', { root: '/home', limit: 5 }, ctx);
    expect(Array.isArray(scan.worldWritable)).toBe(true);
    expect(scan.sensitive.find((f) => f.path === '/etc/shadow')).toBeTruthy();
  });
});

describe('pure renderers and parsers', () => {
  it('renders hosts.allow with ordered ALLOW/DENY', () => {
    const text = renderHostsAllow([{ service: 'sshd', source: '192.0.2.0/24', action: 'allow', comment: 'office' }, { service: 'ALL', source: 'ALL', action: 'deny' }]);
    expect(text).toContain('# office\nsshd: 192.0.2.0/24: ALLOW\nALL: ALL: DENY\n');
    expect(text.startsWith('# Managed by WHM panel')).toBe(true);
  });

  it('brackets IPv6 sources the way libwrap parses them', () => {
    expect(hostSourceForm('2001:db8::/32')).toBe('[2001:db8::]/32');
    expect(hostSourceForm('[2001:DB8::1]')).toBe('[2001:db8::1]');
    expect(hostSourceForm('2001:db8::1')).toBe('[2001:db8::1]');
    expect(hostSourceForm('192.0.2.0/24')).toBe('192.0.2.0/24');
    expect(hostSourceForm('.example.com')).toBe('.example.com');
    expect(hostSourceForm('host:name')).toBeNull();
    expect(hostSourceForm('2001:db8::/129')).toBeNull();
    const text = renderHostsAllow([{ service: 'sshd', source: '2001:db8::/32', action: 'allow' }, { service: 'sshd', source: '2001:db8:0:0:0:0:0:1', action: 'deny' }]);
    expect(text).toContain('sshd: [2001:db8::]/32: ALLOW\nsshd: [2001:db8:0:0:0:0:0:1]: DENY\n');
    expect(text).not.toMatch(/: 2001:/);
  });

  it('only treats hosts.deny as panel-managed when it is ours or has no rules', () => {
    expect(hostsDenyManaged(null)).toBe(true);
    expect(hostsDenyManaged('')).toBe(true);
    expect(hostsDenyManaged('# comment only\n\n')).toBe(true);
    expect(hostsDenyManaged('# Managed by WHM panel (Host Access Control).\n')).toBe(true);
    expect(hostsDenyManaged('# distro default\nALL: PARANOID\n')).toBe(false);
  });

  it('keeps setuid/setgid bits when toggling binary access', () => {
    expect(accessMode(0o4755, false)).toBe(0o4750);
    expect(accessMode(0o4750, true)).toBe(0o4755);
    expect(accessMode(0o2755, false)).toBe(0o2750);
    expect(accessMode(0o755, false)).toBe(0o750);
    expect(accessMode(0o700, true)).toBe(0o755);
  });

  it('detects the archive kind from its leading bytes', () => {
    expect(archiveFormat(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe('tar.gz');
    expect(archiveFormat(Buffer.from('PK\u0003\u0004rest', 'latin1'))).toBe('zip');
    expect(archiveFormat(Buffer.from('BZh91AY', 'latin1'))).toBe('tar.bz2');
    expect(archiveFormat(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))).toBe('tar.xz');
    const tar = Buffer.alloc(512);
    tar.write('ustar', 257, 'latin1');
    expect(archiveFormat(tar)).toBe('tar');
    expect(archiveFormat(Buffer.from('<!doctype html>'))).toBeNull();
    expect(archiveFormat(Buffer.alloc(0))).toBeNull();
  });

  it('spots the distribution CRS include in security2.conf', () => {
    expect(parseDistroCrsInclude('<IfModule security2_module>\n\tIncludeOptional /etc/modsecurity/*.conf\n\tIncludeOptional /usr/share/modsecurity-crs/*.load\n</IfModule>\n')).toEqual({ active: true, directive: 'IncludeOptional /usr/share/modsecurity-crs/*.load', path: '/usr/share/modsecurity-crs/*.load' });
    expect(parseDistroCrsInclude('<IfModule security2_module>\n\tIncludeOptional /etc/modsecurity/*.conf\n\t# IncludeOptional /usr/share/modsecurity-crs/*.load\n</IfModule>\n')).toEqual({ active: false, directive: null, path: null });
    expect(parseDistroCrsInclude(null).active).toBe(false);
  });

  it('parses sshd config and stops at Match blocks', () => {
    const cfg = parseSshdConfig('# comment\nPort 2222\nPasswordAuthentication no\nPermitRootLogin=prohibit-password\nMatch User foo\nPasswordAuthentication yes\n');
    expect(cfg).toEqual({ port: '2222', passwordauthentication: 'no', permitrootlogin: 'prohibit-password' });
  });

  it('reports managed sshd values that an earlier file overrides', () => {
    const managed = { PasswordAuthentication: 'no', PermitRootLogin: 'without-password', MaxAuthTries: '4', Port: '22' };
    const effective = { passwordauthentication: 'yes', permitrootlogin: 'prohibit-password', maxauthtries: '6', port: '22' };
    const sources = [
      { file: '/etc/ssh/sshd_config (before the Include line)', settings: { maxauthtries: '6' } },
      { file: '/etc/ssh/sshd_config.d/00-cloud-init.conf', settings: { passwordauthentication: 'yes' } },
    ];
    expect(sshdShadowed(managed, effective, sources)).toEqual([
      { key: 'PasswordAuthentication', managed: 'no', effective: 'yes', by: '/etc/ssh/sshd_config.d/00-cloud-init.conf' },
      { key: 'MaxAuthTries', managed: '4', effective: '6', by: '/etc/ssh/sshd_config (before the Include line)' },
    ]);
    expect(sshdShadowed({ PasswordAuthentication: 'no' }, { passwordauthentication: 'yes' }, [])).toEqual([{ key: 'PasswordAuthentication', managed: 'no', effective: 'yes', by: null }]);
    expect(sshdShadowed({ PasswordAuthentication: 'no' }, {}, [])).toEqual([]);
  });

  it('never stages root-executed files under a directory another user could own', () => {
    // /tmp is sticky and world-writable: any local user can pre-create a subdir there.
    expect(() => privateTempDir('/tmp', 'whm-test-')).toThrow(OpError);
    expect(() => privateTempDir('/nonexistent-whm-dir', 'x-')).toThrow(OpError);
    const base = fs.mkdtempSync('/tmp/whm/sec-tmpdir-');
    try {
      fs.chmodSync(base, 0o700);
      const link = `${base}/link`;
      fs.symlinkSync(base, link);
      expect(() => privateTempDir(link, 'x-')).toThrow(/not a directory/);
      fs.chmodSync(base, 0o775);
      expect(() => privateTempDir(base, 'x-')).toThrow(/group\/world writable/);
      fs.chmodSync(base, 0o755);
      if (process.getuid?.() === 0) {
        const dir = privateTempDir(base, 'x-');
        expect(dir.startsWith(`${base}/x-`)).toBe(true);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      } else expect(() => privateTempDir(base, 'x-')).toThrow(/owned by root/);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('parses authorized_keys lines with options and computes SHA256 fingerprints', () => {
    const keys = parseAuthorizedKeys(`# header\n\n${ED25519}\nno-pty,command="/bin/true" ${ED25519.replace('user@example', 'restricted')}\ngarbage line\n`);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({ index: 2, type: 'ssh-ed25519', comment: 'user@example', options: null });
    expect(keys[1]).toMatchObject({ index: 3, options: 'no-pty,command="/bin/true"', comment: 'restricted' });
    expect(keys[0].fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(keys[0].fingerprint).toBe(fingerprintOf(parsePublicKeyLine(ED25519).blob));
    expect(parsePublicKeyLine('ssh-rsa not-base64!!')).toBeNull();
  });

  it('fork bomb conf round-trips', () => {
    const text = renderForkBombConf({ maxProcesses: 40, maxOpenFiles: 200, maxMemoryMb: 300, excludeGroups: ['wheel'] });
    expect(text).toContain('*          hard    nproc     40');
    expect(text).toContain('*          hard    as        307200');
    expect(text).toContain('@wheel     hard    nproc     unlimited');
    expect(parseForkBombConf(text)).toEqual({ enabled: true, maxProcesses: 40, maxOpenFiles: 200, maxMemoryMb: 300, excludeGroups: ['wheel'] });
    expect(parseForkBombConf(null).enabled).toBe(false);
  });

  it('parses iptables -S and nft -j output', () => {
    expect(parseIptablesRules('-N WHM_BLOCK\n-A WHM_BLOCK -s 203.0.113.9/32 -j DROP\n-A WHM_BLOCK -s 10.0.0.0/8 -j DROP\n-A WHM_BLOCK -s 1.1.1.1/32 -j ACCEPT\n', 'WHM_BLOCK')).toEqual([{ ip: '203.0.113.9' }, { ip: '10.0.0.0/8' }]);
    const nft = JSON.stringify({ nftables: [{ rule: { family: 'inet', table: 'whm', chain: 'block', handle: 7, expr: [{ match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: '203.0.113.9' } }, { drop: null }] } }, { rule: { chain: 'other', handle: 8, expr: [] } }] });
    expect(parseNftChain(nft, 'block')).toEqual([{ ip: '203.0.113.9', handle: 7 }]);
    expect(parseNftChain('not json', 'block')).toEqual([]);
  });

  it('parses ModSecurity directives, rules and error-log hits', () => {
    expect(parseModsecDirectives('SecRuleEngine DetectionOnly\nSecRequestBodyLimit 13107200\nSecAuditLog /var/log/x\n# SecRuleEngine On\n')).toEqual({ SecRuleEngine: 'DetectionOnly', SecRequestBodyLimit: 13107200 });
    const rules = parseModsecRules(`SecRule REQUEST_HEADERS:User-Agent "@pm nikto" \\\n    "id:913100,phase:1,deny,msg:'Found User-Agent associated with security scanner',severity:'CRITICAL',tag:'attack-reputation-scanner'"\nSecAction "id:900990,phase:1,pass,nolog"\nSecRule ARGS "x" "phase:2,deny"\n`, '/x.conf');
    expect(rules).toEqual([
      { id: 913100, file: '/x.conf', msg: 'Found User-Agent associated with security scanner', severity: 'CRITICAL', phase: 1, tag: 'attack-reputation-scanner', action: 'rule' },
      { id: 900990, file: '/x.conf', msg: null, severity: null, phase: 1, tag: null, action: 'action' },
    ]);
    const hits = parseModsecErrorLog('[Wed Oct 25 10:00:00.123456 2026] [:error] [pid 12] [client 203.0.113.5:4444] ModSecurity: Warning. Pattern match "x" at ARGS:q. [file "/x.conf"] [line "12"] [id "941100"] [msg "XSS Attack Detected"] [severity "CRITICAL"] [hostname "example.com"] [uri "/index.php"] [unique_id "abc"]\n[Wed Oct 25 10:00:01 2026] [core:notice] unrelated\n');
    expect(hits).toEqual([{ ts: 'Wed Oct 25 10:00:00.123456 2026', client: '203.0.113.5', action: 'Warning', id: 941100, msg: 'XSS Attack Detected', severity: 'CRITICAL', uri: '/index.php', hostname: 'example.com', file: '/x.conf', line: 12, uniqueId: 'abc' }]);
  });

  it('renders and parses the userdir include', () => {
    const on = renderUserdirConf({ enabled: true, excludeUsers: ['alice', 'bob'], homeRoot: '/home' });
    expect(on).toContain('UserDir public_html');
    expect(on).toContain('UserDir disabled root alice bob');
    expect(parseUserdirConf(on)).toEqual({ configured: true, enabled: true, excludeUsers: ['alice', 'bob'] });
    const off = renderUserdirConf({ enabled: false, excludeUsers: [], homeRoot: '/home' });
    expect(parseUserdirConf(off)).toEqual({ configured: true, enabled: false, excludeUsers: [] });
    expect(parseUserdirConf(null)).toEqual({ configured: false, enabled: false, excludeUsers: [] });
  });
});
