import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError, DEFAULT_ALLOWED_ROOTS } from '../src/lib.js';
import {
  F2B_JAILS, PANEL_FAILREGEX, renderFail2banJail, renderFail2banPanelFilter, parseFail2banStatus, parseFail2banJailStatus, parseJailFile, fail2banStatus, applyFail2ban, revertFail2ban,
  renderAptPeriodic, renderAptUnattended, parseIni, setIniValues, DNF_AUTOMATIC_VALUES, updatesStatus, applyUpdates, revertUpdates,
  SYSCTL_SETTINGS, SYSCTL_KEYS, renderSysctl, sysctlStatus, applySysctl, revertSysctl,
  BASELINE_CHAIN, parseSshdPorts, parseIptablesBaseline, parseNftBaseline, firewallStatus, applyFirewallBaseline, revertFirewallBaseline,
} from '../src/ops/hardening.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { hasBinary } = await import('../src/exec.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hardening-'));
const ctx = createContext({ allowedRoots: [tmp, ...DEFAULT_ALLOWED_ROOTS] });
const calls = () => exec.mock.calls.map(([bin, argv]) => [bin, ...argv]);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

// Pretend host: `binaries` exist, `answer(bin, argv)` overrides the default "exit 0, no output".
async function withHost(binaries, answer, fn) {
  const actual = await vi.importActual('../src/exec.js');
  hasBinary.mockImplementation((name) => binaries.includes(name));
  exec.mockClear();
  exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv, ...(answer(bin, argv) || {}) }));
  try { await fn(); } finally { hasBinary.mockImplementation(actual.hasBinary); exec.mockImplementation(actual.exec); }
}

beforeEach(() => { exec.mockClear(); });

// ------------------------------------------------------------------ schemas ---

describe('hardening op schemas reject injection before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('hardening.nope', {}, ctx))).code).toBe('unknown_op');
  });

  it('fail2ban jails, times, ports and addresses', async () => {
    const base = { jails: ['sshd'], bantime: 3600, findtime: 600, maxretry: 5, panelPorts: [2086, 2087] };
    for (const args of [
      { ...base, jails: ['sshd; id'] }, { ...base, jails: [] }, { ...base, jails: ['../x'] }, { ...base, bantime: 10 }, { ...base, bantime: 'forever' },
      { ...base, findtime: 0 }, { ...base, maxretry: 0 }, { ...base, panelPorts: [70000] }, { ...base, panelPorts: [] },
      { ...base, ignoreIps: ['1.2.3.4 -j ACCEPT'] }, { ...base, ignoreIps: ['1.2.3.4/33'] }, { ...base, ignoreIps: ['example.com'] }, { ...base, extra: 1 },
    ]) expect((await opError(runOp('hardening.jails.apply', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const args of [{ jail: 'sshd', ip: '1.2.3.4/24' }, { jail: 'nope', ip: '1.2.3.4' }, { jail: 'sshd', ip: '-s' }, { jail: 'sshd', ip: '1.2.3.4', extra: true }]) {
      expect((await opError(runOp('hardening.jails.unban', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('sysctl revert only restores catalogued keys with numeric values', async () => {
    for (const restore of [{ 'kernel.panic': '1' }, { 'net.ipv4.tcp_syncookies': '1; reboot' }, { 'net.ipv4.tcp_syncookies': 1 }, { 'net.ipv4.tcp_syncookies=1 kernel.panic': '1' }]) {
      expect((await opError(runOp('hardening.sysctl.revert', { restore }, ctx))).code, JSON.stringify(restore)).toBe('invalid_args');
    }
    expect((await opError(runOp('hardening.sysctl.revert', { restore: {}, extra: 1 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('firewall ports, ranges, ssh ports and policy', async () => {
    for (const args of [
      { tcp: [], sshPorts: [22] }, { tcp: ['22'], sshPorts: [22] }, { tcp: [0], sshPorts: [22] }, { tcp: [65536], sshPorts: [22] }, { tcp: [{ from: 80, to: 70 }], sshPorts: [22] },
      { tcp: [{ from: 80, to: 90, proto: 'x' }], sshPorts: [22] }, { tcp: [22], sshPorts: [] }, { tcp: [22], sshPorts: ['22'] }, { tcp: [22], udp: ['53 -j ACCEPT'], sshPorts: [22] }, { tcp: [22], sshPorts: [22], extra: 1 },
    ]) expect((await opError(runOp('hardening.firewall.apply', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('hardening.firewall.revert', { restorePolicy: 'REJECT' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('destructive flags are set on what tears down or releases', async () => {
    const { listOps } = await import('../src/lib.js');
    const flags = Object.fromEntries(listOps().filter((o) => o.name.startsWith('hardening.')).map((o) => [o.name, o.destructive]));
    expect(flags).toMatchObject({
      'hardening.jails.revert': true, 'hardening.jails.unban': true, 'hardening.updates.revert': true, 'hardening.sysctl.revert': true, 'hardening.firewall.apply': true, 'hardening.firewall.revert': true,
      'hardening.jails.status': false, 'hardening.sysctl.apply': false, 'hardening.updates.apply': false,
    });
  });
});

// --------------------------------------------------------------- fail2ban ---

describe('fail2ban rendering and parsing', () => {
  it('jail.local enables the chosen jails, disables the rest and carries the panel jail settings', () => {
    const text = renderFail2banJail({ jails: ['sshd', 'whm-panel', 'exim'], bantime: 3600, findtime: 600, maxretry: 5, panelPorts: [2086, 2087], ignoreIps: ['203.0.113.9'] });
    expect(text).toContain('Managed by WHM panel');
    expect(text).toMatch(/\[DEFAULT\]\nbantime {2}= 3600\nfindtime = 600\nmaxretry = 5\nignoreip = 127\.0\.0\.1\/8 ::1 203\.0\.113\.9/);
    expect(text).toMatch(/\[sshd\]\nenabled = true\nmode = aggressive/);
    expect(text).toMatch(/\[exim\]\nenabled = true/);
    expect(text).toMatch(/\[dovecot\]\nenabled = false/);
    expect(text).toMatch(/\[whm-panel\]\nenabled = true\nfilter = whm-panel\nbackend = systemd\njournalmatch = SYSLOG_IDENTIFIER=whm-panel\nport = 2086,2087/);
    for (const jail of F2B_JAILS) expect(text).toContain(`[${jail}]`);
    expect(parseJailFile(text).sort()).toEqual(['exim', 'sshd', 'whm-panel']);
  });

  it('the panel filter matches a failed login as pino-http logs it, and nothing else', () => {
    const filter = renderFail2banPanelFilter();
    expect(filter).toContain(`failregex = ${PANEL_FAILREGEX}`);
    expect(filter).toContain('journalmatch = SYSLOG_IDENTIFIER=whm-panel');
    // fail2ban expands <HOST> to its address patterns (IPv4, IPv6, the ::ffff: IPv4-mapped form, DNS); this stand-in covers the same characters.
    const re = new RegExp(PANEL_FAILREGEX.replace('<HOST>', '(?:::f{4,6}:)?(?<host>[\\w\\-.:^_]*\\w)'));
    const line = (url, status, ip = '203.0.113.5') => `{"level":40,"time":1761800000000,"pid":1,"hostname":"h","req":{"id":"abc-1","method":"POST","url":"${url}","ip":"${ip}"},"res":{"statusCode":${status}},"responseTime":12,"msg":"request completed"}`;
    expect(line('/api/auth/login', 401).match(re)?.groups.host).toBe('203.0.113.5');
    expect(line('/api/auth/2fa', 401).match(re)?.groups.host).toBe('203.0.113.5');
    expect(line('/api/auth/login?next=1', 403).match(re)?.groups.host).toBe('203.0.113.5');
    expect(line('/api/auth/login', 401, '::ffff:198.51.100.7').match(re)?.groups.host).toBe('198.51.100.7');
    expect(line('/api/auth/login', 401, '2001:db8::7').match(re)?.groups.host).toBe('2001:db8::7');
    expect(line('/api/auth/login', 200)).not.toMatch(re);
    expect(line('/api/auth/logout', 401)).not.toMatch(re);
    expect(line('/api/accounts', 401)).not.toMatch(re);
    expect(line('/api/auth/login', 429)).not.toMatch(re);
    expect(line('/api/auth/login', 401).replace('"method":"POST"', '"method":"GET"')).not.toMatch(re);
  });

  it('parses fail2ban-client status output', () => {
    expect(parseFail2banStatus('Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, whm-panel\n')).toEqual(['sshd', 'whm-panel']);
    expect(parseFail2banStatus('')).toEqual([]);
    expect(parseFail2banJailStatus('Status for the jail: sshd\n|- Filter\n|  |- Currently failed:\t2\n|  |- Total failed:\t9\n|  `- File list:\t/var/log/auth.log\n`- Actions\n   |- Currently banned:\t2\n   |- Total banned:\t3\n   `- Banned IP list:\t203.0.113.5 2001:db8::9\n'))
      .toEqual({ currentlyFailed: 2, totalFailed: 9, currentlyBanned: 2, totalBanned: 3, bannedIps: ['203.0.113.5', '2001:db8::9'] });
    expect(parseFail2banJailStatus('`- Banned IP list:\t\n').bannedIps).toEqual([]);
  });
});

describe('fail2ban apply validates before enabling, rolls back on a failed test, reports banned addresses', () => {
  const dir = path.join(tmp, 'fail2ban');
  const args = { jails: ['sshd', 'whm-panel'], bantime: 3600, findtime: 600, maxretry: 5, panelPorts: [2086, 2087], ignoreIps: [] };
  const statusAnswers = (bin, argv) => {
    if (bin === 'fail2ban-client' && argv[0] === 'ping') return { stdout: 'Server replied: pong\n' };
    if (bin === 'fail2ban-client' && argv[0] === 'status' && argv.length === 1) return { stdout: 'Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, whm-panel\n' };
    if (bin === 'fail2ban-client' && argv[0] === 'status' && argv[1] === 'sshd') return { stdout: '`- Actions\n   |- Currently banned:\t1\n   |- Total banned:\t4\n   `- Banned IP list:\t203.0.113.5\n' };
    if (bin === 'fail2ban-client' && argv[0] === 'status' && argv[1] === 'whm-panel') return { stdout: '`- Actions\n   |- Currently banned:\t0\n   |- Total banned:\t0\n   `- Banned IP list:\t\n' };
    if (bin === 'systemctl' && argv[0] === 'is-enabled') return { stdout: 'enabled\n' };
    return {};
  };

  it('writes the filter and the jails, runs fail2ban-client -t before enable/reload, then reports the live jails', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await withHost(['fail2ban-client', 'systemctl'], statusAnswers, async () => {
      const result = await applyFail2ban(args, ctx, { dir });
      expect(read(path.join(dir, 'jail.d/whm.local'))).toContain('[whm-panel]\nenabled = true');
      expect(read(path.join(dir, 'filter.d/whm-panel.conf'))).toContain('failregex');
      const c = calls();
      const test = c.findIndex(([bin, a]) => bin === 'fail2ban-client' && a === '-t');
      const enable = c.findIndex(([bin, a, b, unit]) => bin === 'systemctl' && a === 'enable' && b === '--now' && unit === 'fail2ban.service');
      const reload = c.findIndex(([bin, a]) => bin === 'fail2ban-client' && a === 'reload');
      expect(test).toBeGreaterThanOrEqual(0);
      expect(test).toBeLessThan(enable);
      expect(enable).toBeLessThan(reload);
      expect(result).toMatchObject({ validated: true, enabled: true, reloaded: true, jails: ['sshd', 'whm-panel'] });
      expect(result.status).toMatchObject({ installed: true, configured: true, running: true, bannedTotal: 1 });
      expect(result.status.jails.find((j) => j.name === 'sshd')).toMatchObject({ enabled: true, running: true, currentlyBanned: 1, bannedIps: ['203.0.113.5'] });
      expect(result.status.jails.find((j) => j.name === 'whm-panel')).toMatchObject({ currentlyBanned: 0, bannedIps: [] });
    });
  });

  it('a rejected configuration restores the previous files and never enables or reloads', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'jail.d'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jail.d/whm.local'), '[sshd]\nenabled = true\n');
    await withHost(['fail2ban-client', 'systemctl'], (bin, argv) => (bin === 'fail2ban-client' && argv[0] === '-t' ? { code: 255, stderr: "ERROR  Failed during configuration: Bad value substitution: option 'port' in section 'whm-panel'\n" } : statusAnswers(bin, argv)), async () => {
      const err = await opError(applyFail2ban(args, ctx, { dir }));
      expect(err.code).toBe('config_invalid');
      expect(err.message).toMatch(/Bad value substitution/);
      expect(read(path.join(dir, 'jail.d/whm.local'))).toBe('[sshd]\nenabled = true\n');
      expect(read(path.join(dir, 'filter.d/whm-panel.conf'))).toBeNull();
      expect(calls().some(([bin, a]) => (bin === 'systemctl' && a === 'enable') || (bin === 'fail2ban-client' && a === 'reload'))).toBe(false);
    });
  });

  it('refuses when fail2ban-client is missing, before touching any file', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await withHost(['systemctl'], () => ({}), async () => {
      expect((await opError(applyFail2ban(args, ctx, { dir }))).code).toBe('capability_missing');
      expect(fs.existsSync(path.join(dir, 'jail.d/whm.local'))).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });
  });

  it('status without the daemon reports installed: false and no live jails', async () => {
    await withHost([], () => ({}), async () => {
      expect(await fail2banStatus({ dir })).toMatchObject({ installed: false, configured: false, running: null, jails: [] });
      expect(exec).not.toHaveBeenCalled();
    });
  });

  it('revert removes both files and reloads a running fail2ban', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await withHost(['fail2ban-client', 'systemctl'], statusAnswers, async () => {
      await applyFail2ban(args, ctx, { dir });
      exec.mockClear();
      const result = await revertFail2ban(ctx, { dir });
      expect(result).toEqual({ jail: 'removed', filter: 'removed', reloaded: true });
      expect(fs.existsSync(path.join(dir, 'jail.d/whm.local'))).toBe(false);
      expect(calls()).toContainEqual(['fail2ban-client', 'reload']);
      expect(calls().some(([bin, a]) => bin === 'systemctl' && (a === 'stop' || a === 'disable'))).toBe(false);
    });
  });

  it('unban passes jail and address as separate argv elements', async () => {
    await withHost(['fail2ban-client'], () => ({ stdout: '1\n' }), async () => {
      const result = await runOp('hardening.jails.unban', { jail: 'sshd', ip: '203.0.113.5' }, ctx);
      expect(result).toMatchObject({ jail: 'sshd', ip: '203.0.113.5', released: true });
      expect(calls()).toEqual([['fail2ban-client', 'set', 'sshd', 'unbanip', '203.0.113.5']]);
    });
  });
});

// -------------------------------------------------------- automatic updates ---

describe('automatic updates rendering', () => {
  it('apt periodic and policy files: security origins only, no reboot', () => {
    expect(renderAptPeriodic()).toContain('APT::Periodic::Unattended-Upgrade "1";');
    expect(renderAptPeriodic()).toContain('APT::Periodic::Update-Package-Lists "1";');
    const policy = renderAptUnattended();
    expect(policy).toContain('#clear Unattended-Upgrade::Allowed-Origins;');
    expect(policy).toContain('#clear Unattended-Upgrade::Origins-Pattern;');
    expect(policy).toContain('"origin=Debian,codename=${distro_codename}-security,label=Debian-Security";');
    expect(policy).toContain('"origin=Ubuntu,archive=${distro_codename}-security,label=Ubuntu";');
    expect(policy).toContain('Unattended-Upgrade::Automatic-Reboot "false";');
    expect(policy).not.toMatch(/-updates"/);
  });

  it('dnf automatic.conf: the three keys are set in place and every other line survives', () => {
    const original = '[commands]\n# What kind of upgrade to perform\nupgrade_type = default\nrandom_sleep = 300\napply_updates = no\n\n[emitters]\nemit_via = stdio\n';
    const next = setIniValues(original, DNF_AUTOMATIC_VALUES);
    expect(next.startsWith('# Managed by WHM panel (Hardening)')).toBe(true);
    const ini = parseIni(next);
    expect(ini.commands).toMatchObject({ upgrade_type: 'security', apply_updates: 'yes', download_updates: 'yes', random_sleep: '300' });
    expect(ini.emitters).toEqual({ emit_via: 'stdio' });
    expect(next).toContain('# What kind of upgrade to perform');
    expect(next.match(/upgrade_type =/g)).toHaveLength(1);
    // Re-running on the managed file is idempotent (one marker, one value each).
    const again = setIniValues(next, DNF_AUTOMATIC_VALUES);
    expect(again).toBe(next);
    expect(parseIni(setIniValues('', DNF_AUTOMATIC_VALUES)).commands).toEqual({ upgrade_type: 'security', apply_updates: 'yes', download_updates: 'yes' });
  });
});

describe('automatic updates apply: validation before activation, originals preserved for revert', () => {
  const aptDir = path.join(tmp, 'apt.conf.d');
  const dnfConf = path.join(tmp, 'dnf', 'automatic.conf');

  it('debian: writes both files, checks apt-config dump, enables the timers; revert restores the operator\'s 20auto-upgrades', async () => {
    fs.rmSync(aptDir, { recursive: true, force: true });
    fs.mkdirSync(aptDir, { recursive: true });
    fs.writeFileSync(path.join(aptDir, '20auto-upgrades'), 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n');
    await withHost(['apt-get', 'unattended-upgrade', 'apt-config', 'systemctl'], (bin, argv) => {
      if (bin === 'apt-config' && argv[0] === 'dump') return { stdout: 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' };
      if (bin === 'systemctl' && argv[0] === 'is-enabled') return { stdout: 'enabled\n' };
      return {};
    }, async () => {
      const result = await applyUpdates(ctx, { aptDir, dnfConf });
      expect(result).toMatchObject({ family: 'debian', validated: true, timers: { 'apt-daily.timer': true, 'apt-daily-upgrade.timer': true } });
      expect(read(path.join(aptDir, '20auto-upgrades'))).toContain('Unattended-Upgrade "1"');
      expect(read(path.join(aptDir, '20auto-upgrades.whm-orig'))).toContain('Unattended-Upgrade "0"');
      expect(read(path.join(aptDir, '52whm-unattended-upgrades'))).toContain('#clear Unattended-Upgrade::Allowed-Origins;');
      const c = calls();
      expect(c.findIndex(([bin, a]) => bin === 'apt-config' && a === 'dump')).toBeLessThan(c.findIndex(([bin, a]) => bin === 'systemctl' && a === 'enable'));
      expect(c).toContainEqual(['systemctl', 'enable', '--now', 'apt-daily-upgrade.timer']);
      expect(result.status).toMatchObject({ family: 'debian', installed: true, configured: true, active: true, timerEnabled: true });
      exec.mockClear();
      const reverted = await revertUpdates(ctx, { aptDir, dnfConf });
      expect(reverted).toMatchObject({ family: 'debian', policy: 'removed', periodic: 'restored' });
      expect(read(path.join(aptDir, '20auto-upgrades'))).toContain('Unattended-Upgrade "0"');
      expect(fs.existsSync(path.join(aptDir, '52whm-unattended-upgrades'))).toBe(false);
      expect(fs.existsSync(path.join(aptDir, '20auto-upgrades.whm-orig'))).toBe(false);
    });
  });

  it('debian: a failed apt-config dump restores the files and enables nothing', async () => {
    fs.rmSync(aptDir, { recursive: true, force: true });
    await withHost(['apt-get', 'unattended-upgrade', 'apt-config', 'systemctl'], (bin, argv) => (bin === 'apt-config' && argv[0] === 'dump' ? { code: 100, stderr: 'E: Syntax error /etc/apt/apt.conf.d/52whm-unattended-upgrades:3: Extra junk at end of file\n' } : {}), async () => {
      const err = await opError(applyUpdates(ctx, { aptDir, dnfConf }));
      expect(err.code).toBe('config_invalid');
      expect(err.message).toMatch(/Syntax error/);
      expect(fs.existsSync(path.join(aptDir, '20auto-upgrades'))).toBe(false);
      expect(fs.existsSync(path.join(aptDir, '52whm-unattended-upgrades'))).toBe(false);
      expect(calls().some(([bin, a]) => bin === 'systemctl' && a === 'enable')).toBe(false);
    });
  });

  it('debian without the package is capability_missing; no package manager is capability_missing too', async () => {
    await withHost(['apt-get', 'systemctl'], () => ({}), async () => {
      expect((await opError(applyUpdates(ctx, { aptDir, dnfConf }))).code).toBe('capability_missing');
      expect(await updatesStatus({ aptDir, dnfConf })).toMatchObject({ family: 'debian', installed: false, packages: ['unattended-upgrades'] });
    });
    await withHost([], () => ({}), async () => {
      expect((await opError(applyUpdates(ctx, { aptDir, dnfConf }))).code).toBe('capability_missing');
      expect(await updatesStatus({ aptDir, dnfConf })).toMatchObject({ family: null, installed: false });
    });
  });

  it('rhel: rewrites automatic.conf in place, enables the dnf-automatic timer; revert restores the original and disables it', async () => {
    fs.rmSync(path.dirname(dnfConf), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dnfConf), { recursive: true });
    fs.writeFileSync(dnfConf, '[commands]\nupgrade_type = default\napply_updates = no\n[emitters]\nemit_via = stdio\n');
    await withHost(['dnf', 'dnf-automatic', 'systemctl'], (bin, argv) => {
      if (bin === 'systemctl' && argv[0] === 'list-unit-files') return { stdout: argv[3] === 'dnf-automatic.timer' ? 'dnf-automatic.timer disabled disabled\n' : '' };
      if (bin === 'systemctl' && argv[0] === 'is-enabled') return argv[1] === 'dnf-automatic.timer' ? { stdout: 'enabled\n' } : { code: 1, stdout: 'disabled\n' };
      return {};
    }, async () => {
      const result = await applyUpdates(ctx, { aptDir, dnfConf });
      expect(result).toMatchObject({ family: 'rhel', validated: true, timer: 'dnf-automatic.timer' });
      expect(parseIni(read(dnfConf)).commands).toMatchObject({ upgrade_type: 'security', apply_updates: 'yes', download_updates: 'yes' });
      expect(parseIni(read(`${dnfConf}.whm-orig`)).commands.upgrade_type).toBe('default');
      expect(calls()).toContainEqual(['systemctl', 'enable', '--now', 'dnf-automatic.timer']);
      expect(result.status).toMatchObject({ family: 'rhel', installed: true, configured: true, active: true, timerEnabled: true, timer: 'dnf-automatic.timer' });
      exec.mockClear();
      const reverted = await revertUpdates(ctx, { aptDir, dnfConf });
      expect(reverted).toMatchObject({ family: 'rhel', conf: 'restored', timers: { 'dnf-automatic.timer': true } });
      expect(parseIni(read(dnfConf)).commands.upgrade_type).toBe('default');
      expect(calls()).toContainEqual(['systemctl', 'disable', '--now', 'dnf-automatic.timer']);
    });
  });
});

// ------------------------------------------------------------------ sysctl ---

describe('sysctl', () => {
  const file = path.join(tmp, 'sysctl.d', '90-whm-hardening.conf');
  const procRoot = path.join(tmp, 'proc-sys');
  const seedProc = (values) => {
    fs.rmSync(procRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(values)) {
      const p = path.join(procRoot, ...key.split('.'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${value}\n`);
    }
  };

  it('renders every key of the catalogue with its hardened value', () => {
    const text = renderSysctl();
    expect(text.startsWith('# Managed by WHM panel (Hardening)')).toBe(true);
    for (const [k, v] of SYSCTL_SETTINGS) expect(text).toContain(`${k} = ${v}`);
    expect(text).toContain('net.ipv4.conf.all.rp_filter = 1');
    expect(text).toContain('net.ipv4.tcp_syncookies = 1');
    expect(text).toContain('net.ipv4.conf.all.accept_redirects = 0');
    expect(text).toContain('net.ipv4.conf.all.send_redirects = 0');
    expect(text).toContain('net.ipv4.conf.all.accept_source_route = 0');
    expect(text).toContain('net.ipv6.conf.all.accept_source_route = 0');
    expect(text).toContain('net.ipv4.conf.all.log_martians = 1');
    expect(SYSCTL_KEYS.every((k) => /^net\.ipv[46]\.[a-z_.]+$/.test(k))).toBe(true);
  });

  it('status compares the live kernel values and ignores keys the kernel does not expose', async () => {
    const live = Object.fromEntries(SYSCTL_SETTINGS.map(([k, v]) => [k, v]));
    delete live['net.ipv6.conf.all.accept_redirects'];
    live['net.ipv4.tcp_syncookies'] = '0';
    seedProc(live);
    fs.rmSync(file, { force: true });
    const s = await sysctlStatus({ file, procRoot });
    expect(s).toMatchObject({ configured: false, effective: false, applied: false, checked: SYSCTL_SETTINGS.length - 1, unavailable: ['net.ipv6.conf.all.accept_redirects'] });
    expect(s.mismatched).toEqual([{ key: 'net.ipv4.tcp_syncookies', expected: '1', current: '0' }]);
    seedProc({});
    expect(await sysctlStatus({ file, procRoot })).toMatchObject({ checked: 0, applied: false });
  });

  it('apply writes the file, loads it with sysctl -e -p and returns the previous values; a kernel refusal restores file and values', async () => {
    seedProc({ 'net.ipv4.tcp_syncookies': '0', 'net.ipv4.conf.all.rp_filter': '2' });
    fs.rmSync(file, { force: true });
    await withHost(['sysctl'], (bin, argv) => {
      if (bin === 'sysctl' && argv[0] === '-e') { for (const [k, v] of SYSCTL_SETTINGS) if (['net.ipv4.tcp_syncookies', 'net.ipv4.conf.all.rp_filter'].includes(k)) fs.writeFileSync(path.join(procRoot, ...k.split('.')), `${v}\n`); }
      return {};
    }, async () => {
      const result = await applySysctl(ctx, { file, procRoot });
      expect(result.previous).toEqual({ 'net.ipv4.tcp_syncookies': '0', 'net.ipv4.conf.all.rp_filter': '2' });
      expect(calls()).toEqual([['sysctl', '-e', '-p', file]]);
      expect(read(file)).toContain('net.ipv4.tcp_syncookies = 1');
      expect(result.status).toMatchObject({ configured: true, applied: true, checked: 2, mismatched: [] });
    });
    seedProc({ 'net.ipv4.tcp_syncookies': '0', 'net.ipv4.conf.all.rp_filter': '2' });
    fs.rmSync(file, { force: true });
    await withHost(['sysctl'], (bin, argv) => (bin === 'sysctl' && argv[0] === '-e' ? { code: 255, stderr: 'sysctl: setting key "net.ipv4.tcp_syncookies": Read-only file system\n' } : {}), async () => {
      const err = await opError(applySysctl(ctx, { file, procRoot }));
      expect(err.code).toBe('config_invalid');
      expect(err.message).toMatch(/Read-only file system/);
      expect(fs.existsSync(file)).toBe(false);
      const c = calls();
      expect(c[0]).toEqual(['sysctl', '-e', '-p', file]);
      expect(c.slice(1)).toEqual(expect.arrayContaining([['sysctl', '-w', 'net.ipv4.tcp_syncookies=0'], ['sysctl', '-w', 'net.ipv4.conf.all.rp_filter=2']]));
    });
  });

  it('apply is refused without any key in /proc/sys (containers) and without the sysctl program', async () => {
    seedProc({});
    await withHost(['sysctl'], () => ({}), async () => { expect((await opError(applySysctl(ctx, { file, procRoot }))).code).toBe('unsupported'); expect(exec).not.toHaveBeenCalled(); });
    await withHost([], () => ({}), async () => { expect((await opError(applySysctl(ctx, { file, procRoot }))).code).toBe('capability_missing'); });
  });

  it('revert removes the file and writes the recorded values back as key=value argv elements', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderSysctl());
    await withHost(['sysctl'], () => ({}), async () => {
      const result = await revertSysctl({ restore: { 'net.ipv4.tcp_syncookies': '0', 'net.ipv4.conf.all.log_martians': '0' } }, ctx, { file });
      expect(result).toMatchObject({ file: 'removed', restored: ['net.ipv4.tcp_syncookies', 'net.ipv4.conf.all.log_martians'] });
      expect(fs.existsSync(file)).toBe(false);
      expect(calls()).toEqual([['sysctl', '-w', 'net.ipv4.tcp_syncookies=0'], ['sysctl', '-w', 'net.ipv4.conf.all.log_martians=0']]);
    });
  });
});

// ---------------------------------------------------------------- firewall ---

const SS = 'LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=812,fd=3))\nLISTEN 0      128             [::]:22           [::]:*    users:(("sshd",pid=812,fd=4))\nLISTEN 0      511          0.0.0.0:2087      0.0.0.0:*    users:(("node",pid=900,fd=20))\nLISTEN 0      128          0.0.0.0:2222      0.0.0.0:*    users:(("sshd",pid=813,fd=3))\n';

describe('firewall parsers', () => {
  it('parseSshdPorts keeps only sshd listeners, de-duplicated and sorted', () => {
    expect(parseSshdPorts(SS)).toEqual([22, 2222]);
    expect(parseSshdPorts('')).toEqual([]);
  });

  it('parseIptablesBaseline reads the policy, the hook and the accepted ports', () => {
    const input = `-P INPUT DROP\n-A INPUT -j WHM_BLOCK\n-A INPUT -j ${BASELINE_CHAIN}\n`;
    const chain = `-N ${BASELINE_CHAIN}\n-A ${BASELINE_CHAIN} -i lo -j ACCEPT\n-A ${BASELINE_CHAIN} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n-A ${BASELINE_CHAIN} -p tcp -m tcp --dport 22 -j ACCEPT\n-A ${BASELINE_CHAIN} -p tcp -m tcp --dport 49152:65534 -j ACCEPT\n-A ${BASELINE_CHAIN} -p udp -m udp --dport 53 -j ACCEPT\n`;
    expect(parseIptablesBaseline(input, chain)).toEqual({ policy: 'DROP', hooked: true, chainPresent: true, tcp: [22, { from: 49152, to: 65534 }], udp: [53] });
    expect(parseIptablesBaseline('-P INPUT ACCEPT\n', null)).toEqual({ policy: 'ACCEPT', hooked: false, chainPresent: false, tcp: [], udp: [] });
  });

  it('parseNftBaseline reads the chain policy and port sets from nft -j output', () => {
    const json = JSON.stringify({ nftables: [
      { chain: { family: 'inet', table: 'whm', name: 'baseline', handle: 3, type: 'filter', hook: 'input', prio: 0, policy: 'drop' } },
      { rule: { family: 'inet', table: 'whm', chain: 'baseline', handle: 5, expr: [{ match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: { set: [22, 80, { range: [49152, 65534] }] } } }, { accept: null }] } },
      { rule: { family: 'inet', table: 'whm', chain: 'baseline', handle: 6, expr: [{ match: { op: '==', left: { payload: { protocol: 'udp', field: 'dport' } }, right: 53 } }, { accept: null }] } },
      { rule: { family: 'inet', table: 'whm', chain: 'block', handle: 7, expr: [{ match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 99 } }, { drop: null }] } },
    ] });
    expect(parseNftBaseline(json)).toEqual({ chainPresent: true, policy: 'drop', tcp: [22, 80, { from: 49152, to: 65534 }], udp: [53] });
    expect(parseNftBaseline('not json')).toEqual({ chainPresent: false, policy: null, tcp: [], udp: [] });
  });
});

describe('firewall baseline apply/revert: argv order and the SSH guard', () => {
  const ipt = (bin, argv, state) => {
    if (bin === 'ss') return { stdout: SS.split('\n').filter((l) => !l.includes('2222')).join('\n') };
    if (bin === 'systemctl' && argv[0] === 'is-active') return { code: 3 };
    if (bin === 'systemctl' && argv[0] === 'list-unit-files') return { stdout: '' };
    if ((bin === 'iptables' || bin === 'ip6tables') && argv[0] === '-S' && argv[1] === 'INPUT') return { stdout: state.policy === 'DROP' ? `-P INPUT DROP\n-A INPUT -j ${BASELINE_CHAIN}\n` : '-P INPUT ACCEPT\n' };
    if ((bin === 'iptables' || bin === 'ip6tables') && argv[0] === '-S' && argv[1] === BASELINE_CHAIN) return state.policy === 'DROP' ? { stdout: `-N ${BASELINE_CHAIN}\n-A ${BASELINE_CHAIN} -p tcp -m tcp --dport 22 -j ACCEPT\n` } : { code: 1 };
    if ((bin === 'iptables' || bin === 'ip6tables') && argv[0] === '-C') return { code: 1 };
    if ((bin === 'iptables' || bin === 'ip6tables') && argv[0] === '-P') { state.policy = argv[2]; return {}; }
    return {};
  };

  it('iptables: chain rules first, hook appended (not inserted), the DROP policy last, both address families', async () => {
    const state = { policy: 'ACCEPT' };
    await withHost(['iptables', 'ip6tables', 'ss', 'systemctl'], (bin, argv) => ipt(bin, argv, state), async () => {
      const result = await applyFirewallBaseline({ tcp: [22, 2086, 2087, 80, 443, { from: 49152, to: 65534 }], udp: [53], sshPorts: [22] }, ctx);
      expect(result).toMatchObject({ backend: 'iptables', previousPolicy: 'ACCEPT', sshPorts: [22], tcp: ['22', '2086', '2087', '80', '443', '49152-65534'], udp: ['53'] });
      const c = calls().filter(([bin]) => bin === 'iptables');
      const idx = (pred) => c.findIndex(pred);
      expect(c).toContainEqual(['iptables', '-A', BASELINE_CHAIN, '-i', 'lo', '-j', 'ACCEPT']);
      expect(c).toContainEqual(['iptables', '-A', BASELINE_CHAIN, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
      expect(c).toContainEqual(['iptables', '-A', BASELINE_CHAIN, '-p', 'icmp', '-j', 'ACCEPT']);
      expect(c).toContainEqual(['iptables', '-A', BASELINE_CHAIN, '-p', 'tcp', '--dport', '22', '-j', 'ACCEPT']);
      expect(c).toContainEqual(['iptables', '-A', BASELINE_CHAIN, '-p', 'tcp', '--dport', '49152:65534', '-j', 'ACCEPT']);
      expect(c).toContainEqual(['iptables', '-A', BASELINE_CHAIN, '-p', 'udp', '--dport', '53', '-j', 'ACCEPT']);
      expect(c).toContainEqual(['iptables', '-A', 'INPUT', '-j', BASELINE_CHAIN]);
      expect(c.some(([, a, b]) => a === '-I' && b === 'INPUT')).toBe(false);
      const lastRule = Math.max(...c.map((x, i) => (x[1] === '-A' && x[2] === BASELINE_CHAIN ? i : -1)));
      expect(lastRule).toBeLessThan(idx(([, a, b]) => a === '-A' && b === 'INPUT'));
      expect(idx(([, a, b]) => a === '-A' && b === 'INPUT')).toBeLessThan(idx(([, a, b, c2]) => a === '-P' && b === 'INPUT' && c2 === 'DROP'));
      const v6 = calls().filter(([bin]) => bin === 'ip6tables');
      expect(v6).toContainEqual(['ip6tables', '-A', BASELINE_CHAIN, '-p', 'ipv6-icmp', '-j', 'ACCEPT']);
      expect(v6).toContainEqual(['ip6tables', '-P', 'INPUT', 'DROP']);
      expect(result.status).toMatchObject({ applied: true, policy: 'DROP', hooked: true });
    });
  });

  it('refuses when a declared or a live sshd port is missing from the allow list, before any rule is written', async () => {
    const state = { policy: 'ACCEPT' };
    await withHost(['iptables', 'ss', 'systemctl'], (bin, argv) => ipt(bin, argv, state), async () => {
      const declared = await opError(applyFirewallBaseline({ tcp: [80, 443], udp: [], sshPorts: [22] }, ctx));
      expect(declared.code).toBe('refused');
      expect(declared.message).toMatch(/SSH port 22 is not in the allow list/);
      expect(calls().some(([bin]) => bin === 'iptables')).toBe(false);
      exec.mockClear();
      const live = await opError(applyFirewallBaseline({ tcp: [80, 443, 2222], udp: [], sshPorts: [2222] }, ctx));
      expect(live.code).toBe('refused');
      expect(live.message).toMatch(/sshd is listening on port 22/);
      expect(calls().some(([bin]) => bin === 'iptables')).toBe(false);
      expect(state.policy).toBe('ACCEPT');
    });
  });

  it('refuses while firewalld is active', async () => {
    const state = { policy: 'ACCEPT' };
    await withHost(['iptables', 'ss', 'systemctl'], (bin, argv) => (bin === 'systemctl' && argv[0] === 'is-active' ? { code: 0 } : ipt(bin, argv, state)), async () => {
      const err = await opError(applyFirewallBaseline({ tcp: [22], udp: [], sshPorts: [22] }, ctx));
      expect(err.code).toBe('refused');
      expect(err.message).toMatch(/firewalld/);
      expect(calls().some(([bin, a]) => bin === 'iptables' && a !== '-S')).toBe(false);
    });
  });

  it('a rule the kernel rejects tears everything down again (policy back to ACCEPT first)', async () => {
    const state = { policy: 'ACCEPT' };
    await withHost(['iptables', 'ss', 'systemctl'], (bin, argv) => {
      if (bin === 'iptables' && argv[0] === '-A' && argv.includes('--dport') && argv.includes('443')) throw Object.assign(new Error('iptables: No chain/target/match by that name.'), { code: 'command_failed' });
      return ipt(bin, argv, state);
    }, async () => {
      const err = await opError(applyFirewallBaseline({ tcp: [22, 443], udp: [], sshPorts: [22] }, ctx));
      expect(err.code).toBe('config_invalid');
      const c = calls().filter(([bin]) => bin === 'iptables');
      const failed = c.findIndex((x) => x.includes('443'));
      const tail = c.slice(failed + 1);
      expect(tail[0]).toEqual(['iptables', '-P', 'INPUT', 'ACCEPT']);
      expect(tail).toContainEqual(['iptables', '-D', 'INPUT', '-j', BASELINE_CHAIN]);
      expect(tail).toContainEqual(['iptables', '-F', BASELINE_CHAIN]);
      expect(tail).toContainEqual(['iptables', '-X', BASELINE_CHAIN]);
      expect(c.some(([, a, b, p]) => a === '-P' && b === 'INPUT' && p === 'DROP')).toBe(false);
    });
  });

  it('revert sets the recorded policy first, then unhooks and deletes the chain', async () => {
    const state = { policy: 'DROP' };
    await withHost(['iptables', 'ss', 'systemctl'], (bin, argv) => ipt(bin, argv, state), async () => {
      const result = await revertFirewallBaseline({ restorePolicy: 'ACCEPT' });
      const c = calls().filter(([bin]) => bin === 'iptables');
      expect(c[0]).toEqual(['iptables', '-P', 'INPUT', 'ACCEPT']);
      expect(c.findIndex(([, a, b]) => a === '-D' && b === 'INPUT')).toBeGreaterThan(0);
      expect(c.findIndex(([, a]) => a === '-F')).toBeLessThan(c.findIndex(([, a]) => a === '-X'));
      expect(result).toMatchObject({ backend: 'iptables', restorePolicy: 'ACCEPT' });
    });
  });

  it('nft: the chain is created accepting, filled, then flipped to drop; revert deletes it', async () => {
    let policy = null;
    await withHost(['nft', 'ss', 'systemctl'], (bin, argv) => {
      if (bin === 'ss') return { stdout: SS.split('\n').filter((l) => !l.includes('2222')).join('\n') };
      if (bin === 'systemctl') return { code: 3, stdout: '' };
      if (bin === 'nft' && argv[0] === 'add' && argv[1] === 'chain') { policy = argv[argv.length - 1].includes('drop') ? 'drop' : 'accept'; return {}; }
      if (bin === 'nft' && argv[0] === 'delete') { policy = null; return {}; }
      if (bin === 'nft' && argv[0] === '-j') return policy ? { stdout: JSON.stringify({ nftables: [{ chain: { name: 'baseline', policy } }] }) } : { code: 1 };
      return {};
    }, async () => {
      const result = await applyFirewallBaseline({ tcp: [22, 80, { from: 49152, to: 65534 }], udp: [53], sshPorts: [22] }, ctx);
      const c = calls().filter(([bin]) => bin === 'nft');
      expect(c[0]).toEqual(['nft', 'add', 'table', 'inet', 'whm']);
      expect(c[1]).toEqual(['nft', 'add', 'chain', 'inet', 'whm', 'baseline', '{ type filter hook input priority 0 ; policy accept ; }']);
      expect(c).toContainEqual(['nft', 'add', 'rule', 'inet', 'whm', 'baseline', 'ct', 'state', 'established,related', 'accept']);
      expect(c).toContainEqual(['nft', 'add', 'rule', 'inet', 'whm', 'baseline', 'tcp', 'dport', '{ 22, 80, 49152-65534 }', 'accept']);
      expect(c).toContainEqual(['nft', 'add', 'rule', 'inet', 'whm', 'baseline', 'udp', 'dport', '{ 53 }', 'accept']);
      const drop = c.findIndex((x) => x[2] === 'chain' && x[6] === '{ policy drop ; }');
      expect(drop).toBeGreaterThan(c.findIndex((x) => x[2] === 'rule' && x[6] === 'tcp'));
      expect(result).toMatchObject({ backend: 'nft', status: { applied: true } });
      exec.mockClear();
      const reverted = await revertFirewallBaseline({});
      expect(calls().filter(([bin]) => bin === 'nft')[0]).toEqual(['nft', 'delete', 'chain', 'inet', 'whm', 'baseline']);
      expect(reverted).toMatchObject({ backend: 'nft', status: { applied: false } });
    });
  });

  it('status reports sshd ports, the hub unit and firewalld/ufw conflicts', async () => {
    await withHost(['iptables', 'ss', 'systemctl', 'ufw'], (bin, argv) => {
      if (bin === 'ss') return { stdout: SS };
      if (bin === 'ufw') return { stdout: 'Status: active\n' };
      if (bin === 'systemctl' && argv[0] === 'is-active') return { code: 0 };
      if (bin === 'systemctl' && argv[0] === 'list-unit-files') return { stdout: 'whm-hub.service enabled enabled\n' };
      if (bin === 'iptables' && argv[1] === 'INPUT') return { stdout: '-P INPUT ACCEPT\n' };
      if (bin === 'iptables') return { code: 1 };
      return {};
    }, async () => {
      const s = await firewallStatus();
      expect(s).toMatchObject({ backend: 'iptables', applied: false, policy: 'ACCEPT', sshdPorts: [22, 2222], hubUnit: true, conflicts: { firewalld: true, ufw: true } });
    });
  });
});
