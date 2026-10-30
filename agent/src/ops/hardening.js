import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { firewallBackend } from './sec.js';
import { detectManager } from './pkg.js';

// Hardening op family: the one-click items behind Security Advisor › Hardening.
// Every file this family writes carries MANAGED, is validated by the daemon's
// own checker (fail2ban-client -t, apt-config dump, the kernel's own answer to
// sysctl -p) before anything is activated, and is put back the way it was when
// the checker or the activation fails. A file that existed before the panel
// touched it is kept beside it as "<file>.whm-orig" so Revert restores the
// distribution's version instead of deleting it.

const MANAGED = '# Managed by WHM panel (Hardening)';
const MANAGED_TEXT = 'Managed by WHM panel (Hardening)';

// ---------------------------------------------------------------- helpers ---

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

const isManaged = (text) => typeof text === 'string' && text.includes(MANAGED_TEXT);
const origPath = (file) => `${file}.whm-orig`;

// Writes atomically; the first time an unmanaged file is replaced its content
// is preserved as <file>.whm-orig so a revert can restore it.
function writeManaged(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = readText(file);
  if (previous != null && !isManaged(previous) && !exists(origPath(file))) fs.writeFileSync(origPath(file), previous, { mode });
  const tmp = `${file}.whm-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function restore(file, previous) {
  if (previous == null) { try { fs.unlinkSync(file); } catch { /* already gone */ } } else fs.writeFileSync(file, previous);
}

// Revert of a managed file: the preserved original comes back when there is
// one, otherwise the file is removed. Returns what happened.
function restoreOriginal(file) {
  const orig = origPath(file);
  if (exists(orig)) {
    fs.copyFileSync(orig, file);
    fs.unlinkSync(orig);
    return 'restored';
  }
  if (exists(file)) { fs.unlinkSync(file); return 'removed'; }
  return 'absent';
}

const lastLine = (s) => String(s || '').trim().split('\n').pop() || '';

async function unitActive(unit) {
  if (!hasBinary('systemctl')) return null;
  const { code } = await exec('systemctl', ['is-active', '--quiet', `${unit}`], { allowFailure: true, timeoutMs: 15_000 });
  return code === 0;
}

async function unitEnabled(unit) {
  if (!hasBinary('systemctl')) return null;
  const { code, stdout } = await exec('systemctl', ['is-enabled', unit], { allowFailure: true, timeoutMs: 15_000 });
  return code === 0 && /^(enabled|static|alias|indirect)/.test(stdout.trim());
}

async function unitExists(unit) {
  if (!hasBinary('systemctl')) return false;
  const { code, stdout } = await exec('systemctl', ['list-unit-files', '--no-legend', '--no-pager', unit], { allowFailure: true, timeoutMs: 15_000 });
  return code === 0 && stdout.split('\n').some((l) => l.trim().startsWith(unit));
}

// ---------------------------------------------------------------- fail2ban ---

export const FAIL2BAN_DIR = '/etc/fail2ban';
export const F2B_JAIL_FILE = 'jail.d/whm.local';
export const F2B_FILTER_FILE = 'filter.d/whm-panel.conf';
export const F2B_JAILS = ['sshd', 'exim', 'dovecot', 'pure-ftpd', 'proftpd', 'apache-auth', 'apache-badbots', 'whm-panel'];
const f2bJail = z.enum(F2B_JAILS);
const port = z.number().int().min(1).max(65535);
const ipOrCidr = z.string().max(64).refine((v) => {
  const [addr, prefix, ...rest] = v.split('/');
  const family = net.isIP(addr);
  if (!family || rest.length) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}, 'IP address or CIDR network');

const f2bPaths = (dir) => ({ jail: path.join(dir, F2B_JAIL_FILE), filter: path.join(dir, F2B_FILTER_FILE) });

// The panel logs every request as one pino JSON line on the whm-panel journal
// unit (deploy/whm-panel.service: SyslogIdentifier=whm-panel): a failed login
// is a POST to /api/auth/login (or the 2FA step) answered 401/403, with the
// client address in req.ip. <HOST> already allows the ::ffff: IPv4-mapped form.
export const PANEL_FAILREGEX = '^.*"req":\\{"id":"[^"]*","method":"POST","url":"/api/auth/(?:login|2fa)(?:\\?[^"]*)?","ip":"<HOST>"\\},"res":\\{"statusCode":(?:401|403)\\}';

export function renderFail2banPanelFilter() {
  return [
    `${MANAGED}. Panel login failures as pino-http logs them on the whm-panel journal unit.`,
    '[Definition]',
    `failregex = ${PANEL_FAILREGEX}`,
    'ignoreregex =',
    '',
    '[Init]',
    'journalmatch = SYSLOG_IDENTIFIER=whm-panel',
    '',
  ].join('\n');
}

export function renderFail2banJail({ jails, bantime, findtime, maxretry, panelPorts, ignoreIps = [] }) {
  const on = new Set(jails);
  const lines = [
    `${MANAGED}. Rewritten by Security Advisor › Hardening; put your own jails in another jail.d/*.local file.`,
    '[DEFAULT]',
    `bantime  = ${bantime}`,
    `findtime = ${findtime}`,
    `maxretry = ${maxretry}`,
    `ignoreip = ${['127.0.0.1/8', '::1', ...ignoreIps].join(' ')}`,
    '',
  ];
  for (const jail of F2B_JAILS) {
    lines.push(`[${jail}]`, `enabled = ${on.has(jail) ? 'true' : 'false'}`);
    if (jail === 'sshd') lines.push('mode = aggressive');
    if (jail === 'whm-panel') lines.push('filter = whm-panel', 'backend = systemd', 'journalmatch = SYSLOG_IDENTIFIER=whm-panel', `port = ${panelPorts.join(',')}`);
    lines.push('');
  }
  return lines.join('\n');
}

// "Jail list:\tsshd, whm-panel" from `fail2ban-client status`.
export function parseFail2banStatus(stdout) {
  const m = String(stdout || '').match(/Jail list:\s*(.*)$/m);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// Per-jail status: "Currently banned:\t1", "Banned IP list:\t1.2.3.4 5.6.7.8".
export function parseFail2banJailStatus(stdout) {
  const text = String(stdout || '');
  const num = (label) => { const m = text.match(new RegExp(`${label}:\\s*(\\d+)`)); return m ? Number(m[1]) : 0; };
  const list = text.match(/Banned IP list:\s*(.*)$/m);
  return {
    currentlyFailed: num('Currently failed'), totalFailed: num('Total failed'),
    currentlyBanned: num('Currently banned'), totalBanned: num('Total banned'),
    bannedIps: list ? list[1].split(/\s+/).map((s) => s.trim()).filter((s) => net.isIP(s)) : [],
  };
}

export function parseJailFile(text) {
  const enabled = [];
  let section = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const s = line.match(/^\[([^\]]+)\]$/);
    if (s) { section = s[1]; continue; }
    const kv = line.match(/^enabled\s*=\s*(\S+)/i);
    if (kv && section && section !== 'DEFAULT' && kv[1].toLowerCase() === 'true') enabled.push(section);
  }
  return enabled;
}

async function fail2banPing() {
  const { code, stdout } = await exec('fail2ban-client', ['ping'], { allowFailure: true, timeoutMs: 15_000 });
  return code === 0 && /pong/i.test(stdout);
}

export async function fail2banStatus({ dir = FAIL2BAN_DIR } = {}) {
  const installed = hasBinary('fail2ban-client');
  const files = f2bPaths(dir);
  const jailText = readText(files.jail);
  const configured = isManaged(jailText) && isManaged(readText(files.filter));
  const enabledJails = configured ? parseJailFile(jailText) : [];
  const out = { installed, configured, path: files.jail, filterPath: files.filter, running: null, unitEnabled: null, jails: [], bannedTotal: 0 };
  if (!installed) return out;
  out.running = await fail2banPing();
  out.unitEnabled = await unitEnabled('fail2ban.service');
  if (!out.running) { out.jails = enabledJails.map((name) => ({ name, enabled: true, running: false, currentlyBanned: 0, totalBanned: 0, bannedIps: [] })); return out; }
  const live = parseFail2banStatus((await exec('fail2ban-client', ['status'], { allowFailure: true, timeoutMs: 15_000 })).stdout);
  const names = [...new Set([...enabledJails, ...live.filter((j) => F2B_JAILS.includes(j))])];
  for (const name of names) {
    if (!F2B_JAILS.includes(name)) continue;
    const running = live.includes(name);
    const stats = running ? parseFail2banJailStatus((await exec('fail2ban-client', ['status', name], { allowFailure: true, timeoutMs: 15_000 })).stdout) : { currentlyBanned: 0, totalBanned: 0, bannedIps: [], currentlyFailed: 0, totalFailed: 0 };
    out.jails.push({ name, enabled: enabledJails.includes(name), running, ...stats });
    out.bannedTotal += stats.currentlyBanned;
  }
  return out;
}

export async function applyFail2ban(args, ctx, { dir = FAIL2BAN_DIR } = {}) {
  if (!hasBinary('fail2ban-client')) throw new OpError('capability_missing', 'Fail2ban is not installed on this server (install the fail2ban package)');
  const files = f2bPaths(dir);
  ctx.assertAllowedPath(files.jail, 'write');
  ctx.assertAllowedPath(files.filter, 'write');
  const previous = { jail: readText(files.jail), filter: readText(files.filter) };
  writeManaged(files.filter, renderFail2banPanelFilter());
  writeManaged(files.jail, renderFail2banJail(args));
  const rollback = () => { restore(files.jail, previous.jail); restore(files.filter, previous.filter); };
  const test = await exec('fail2ban-client', ['-t'], { allowFailure: true, timeoutMs: 60_000 });
  if (test.code !== 0) {
    rollback();
    throw new OpError('config_invalid', `fail2ban rejected the jail configuration; the previous files were restored: ${lastLine(test.stderr || test.stdout)}`, { output: `${test.stdout}\n${test.stderr}`.trim() });
  }
  let enabled = null;
  if (hasBinary('systemctl')) enabled = (await exec('systemctl', ['enable', '--now', 'fail2ban.service'], { allowFailure: true, timeoutMs: 120_000 })).code === 0;
  let reloaded = (await exec('fail2ban-client', ['reload'], { allowFailure: true, timeoutMs: 120_000 })).code === 0;
  if (!reloaded && hasBinary('systemctl')) reloaded = (await exec('systemctl', ['restart', 'fail2ban.service'], { allowFailure: true, timeoutMs: 120_000 })).code === 0;
  if (!(await fail2banPing())) {
    rollback();
    if (hasBinary('systemctl')) await exec('systemctl', ['restart', 'fail2ban.service'], { allowFailure: true, timeoutMs: 120_000 });
    throw new OpError('config_invalid', 'fail2ban did not come up with the new jails (check "journalctl -u fail2ban"); the previous files were restored', { enabled, reloaded });
  }
  return { path: files.jail, filterPath: files.filter, jails: args.jails, validated: true, enabled, reloaded, status: await fail2banStatus({ dir }) };
}

export async function revertFail2ban(ctx, { dir = FAIL2BAN_DIR } = {}) {
  const files = f2bPaths(dir);
  ctx.assertAllowedPath(files.jail, 'write');
  ctx.assertAllowedPath(files.filter, 'write');
  const result = { jail: restoreOriginal(files.jail), filter: restoreOriginal(files.filter), reloaded: false };
  if (hasBinary('fail2ban-client') && await fail2banPing()) result.reloaded = (await exec('fail2ban-client', ['reload'], { allowFailure: true, timeoutMs: 120_000 })).code === 0;
  return result;
}

defineOp('hardening.jails.status', {
  description: 'Whether Fail2ban is installed, configured by the panel and running, with the banned addresses of every panel-managed jail',
  run: async () => fail2banStatus(),
});

defineOp('hardening.jails.apply', {
  description: `Write ${FAIL2BAN_DIR}/${F2B_JAIL_FILE} (sshd, exim, dovecot, FTP, Apache and panel jails) and the panel login filter, validate with fail2ban-client -t (rolled back on error), enable and reload fail2ban`,
  timeoutMs: 300_000,
  schema: z.object({
    jails: z.array(f2bJail).min(1).max(F2B_JAILS.length),
    bantime: z.number().int().min(60).max(31_536_000),
    findtime: z.number().int().min(60).max(86_400),
    maxretry: z.number().int().min(1).max(100),
    panelPorts: z.array(port).min(1).max(4),
    ignoreIps: z.array(ipOrCidr).max(20).default([]),
  }).strict(),
  run: async (args, ctx) => applyFail2ban({ ...args, jails: [...new Set(args.jails)] }, ctx),
});

defineOp('hardening.jails.revert', {
  description: 'Remove the panel-managed jails and filter and reload fail2ban (the service itself keeps running for other jails)',
  destructive: true,
  run: async (_args, ctx) => revertFail2ban(ctx),
});

defineOp('hardening.jails.unban', {
  description: 'Release an address from one panel-managed jail',
  destructive: true,
  schema: z.object({ jail: f2bJail, ip: arg.ip }).strict(),
  run: async ({ jail, ip }) => {
    if (!hasBinary('fail2ban-client')) throw new OpError('capability_missing', 'Fail2ban is not installed on this server');
    const { code, stdout, stderr } = await exec('fail2ban-client', ['set', jail, 'unbanip', ip], { allowFailure: true, timeoutMs: 30_000 });
    if (code !== 0) throw new OpError('refused', `fail2ban did not release ${ip} from ${jail}: ${lastLine(stderr || stdout)}`);
    return { jail, ip, released: true, output: stdout.trim() };
  },
});

// --------------------------------------------------- automatic updates ---

export const APT_CONF_DIR = '/etc/apt/apt.conf.d';
export const APT_PERIODIC_FILE = '20auto-upgrades';
// Later apt.conf.d files win and lists are cleared with #clear, so the policy
// goes in a file after the package's 50unattended-upgrades instead of
// replacing that conffile (which dpkg would then prompt about on upgrades).
export const APT_POLICY_FILE = '52whm-unattended-upgrades';
export const DNF_AUTOMATIC_CONF = '/etc/dnf/automatic.conf';
export const UPDATE_PACKAGES = { debian: ['unattended-upgrades'], rhel: ['dnf-automatic'] };

const aptPaths = (dir) => ({ periodic: path.join(dir, APT_PERIODIC_FILE), policy: path.join(dir, APT_POLICY_FILE) });

export function renderAptPeriodic() {
  return [
    `// ${MANAGED_TEXT}. Daily index refresh and unattended security upgrades.`,
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
    'APT::Periodic::AutocleanInterval "7";',
    '',
  ].join('\n');
}

export function renderAptUnattended() {
  return [
    `// ${MANAGED_TEXT}. Security origins only, never an automatic reboot.`,
    '#clear Unattended-Upgrade::Allowed-Origins;',
    '#clear Unattended-Upgrade::Origins-Pattern;',
    'Unattended-Upgrade::Origins-Pattern {',
    '  "origin=Debian,codename=${distro_codename},label=Debian-Security";',
    '  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";',
    '  "origin=Ubuntu,archive=${distro_codename}-security,label=Ubuntu";',
    '  "origin=UbuntuESMApps,archive=${distro_codename}-apps-security,label=Ubuntu Pro";',
    '  "origin=UbuntuESM,archive=${distro_codename}-infra-security,label=Ubuntu Pro";',
    '};',
    'Unattended-Upgrade::Automatic-Reboot "false";',
    'Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";',
    'Unattended-Upgrade::Remove-Unused-Dependencies "true";',
    'Unattended-Upgrade::MinimalSteps "true";',
    '',
  ].join('\n');
}

// dnf-automatic only reads /etc/dnf/automatic.conf, so the three keys are set
// in place and every other line of the file is kept.
export const DNF_AUTOMATIC_VALUES = { commands: { upgrade_type: 'security', apply_updates: 'yes', download_updates: 'yes' } };

export function parseIni(text) {
  const out = {};
  let section = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = line.match(/^\[([^\]]+)\]$/);
    if (s) { section = s[1]; out[section] ||= {}; continue; }
    const kv = line.match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (kv && section) out[section][kv[1]] = kv[2].trim();
  }
  return out;
}

export function setIniValues(text, values) {
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = Object.fromEntries(Object.entries(values).map(([s, kv]) => [s, { ...kv }]));
  const out = [];
  let section = null;
  const flush = () => { if (section && pending[section]) { for (const [k, v] of Object.entries(pending[section])) out.push(`${k} = ${v}`); delete pending[section]; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#') && line.includes(MANAGED_TEXT)) continue;
    const s = line.match(/^\[([^\]]+)\]$/);
    if (s) { flush(); section = s[1]; out.push(raw); continue; }
    const kv = line.match(/^([^=\s]+)\s*=/);
    if (kv && section && pending[section] && Object.hasOwn(pending[section], kv[1])) {
      out.push(`${kv[1]} = ${pending[section][kv[1]]}`);
      delete pending[section][kv[1]];
      continue;
    }
    out.push(raw);
  }
  flush();
  for (const [s, kv] of Object.entries(pending)) {
    if (!Object.keys(kv).length) continue;
    out.push(`[${s}]`);
    for (const [k, v] of Object.entries(kv)) out.push(`${k} = ${v}`);
  }
  return `${MANAGED}: upgrade_type, apply_updates and download_updates are set by the panel.\n${out.join('\n')}\n`;
}

const DNF_TIMERS = ['dnf-automatic.timer', 'dnf-automatic-install.timer'];
const APT_TIMERS = ['apt-daily.timer', 'apt-daily-upgrade.timer'];

async function aptPeriodicActive() {
  if (!hasBinary('apt-config')) return null;
  const { code, stdout } = await exec('apt-config', ['dump'], { allowFailure: true, timeoutMs: 30_000 });
  if (code !== 0) return null;
  return /APT::Periodic::Unattended-Upgrade "1";/.test(stdout);
}

export async function updatesStatus({ aptDir = APT_CONF_DIR, dnfConf = DNF_AUTOMATIC_CONF } = {}) {
  const { family } = detectManager();
  const out = { family, installed: false, configured: false, active: null, timerEnabled: null, packages: family ? UPDATE_PACKAGES[family] : [], files: [] };
  if (family === 'debian') {
    const files = aptPaths(aptDir);
    out.files = [files.periodic, files.policy];
    out.installed = hasBinary('unattended-upgrade');
    out.configured = isManaged(readText(files.periodic)) && isManaged(readText(files.policy));
    if (!out.installed) return out;
    out.active = await aptPeriodicActive();
    out.timerEnabled = await unitEnabled(APT_TIMERS[1]);
    return out;
  }
  if (family === 'rhel') {
    out.files = [dnfConf];
    out.installed = hasBinary('dnf-automatic');
    const text = readText(dnfConf);
    const ini = parseIni(text);
    const want = DNF_AUTOMATIC_VALUES.commands;
    out.configured = isManaged(text) && Object.entries(want).every(([k, v]) => ini.commands?.[k] === v);
    if (!out.installed) return out;
    out.active = Object.entries(want).every(([k, v]) => ini.commands?.[k] === v);
    out.timerEnabled = false;
    for (const timer of DNF_TIMERS) { if (await unitEnabled(timer)) { out.timerEnabled = true; out.timer = timer; break; } }
    return out;
  }
  return out;
}

export async function applyUpdates(ctx, { aptDir = APT_CONF_DIR, dnfConf = DNF_AUTOMATIC_CONF } = {}) {
  const { family } = detectManager();
  if (family === 'debian') {
    if (!hasBinary('unattended-upgrade')) throw new OpError('capability_missing', 'The unattended-upgrades package is not installed');
    const files = aptPaths(aptDir);
    ctx.assertAllowedPath(files.periodic, 'write');
    ctx.assertAllowedPath(files.policy, 'write');
    const previous = { periodic: readText(files.periodic), policy: readText(files.policy) };
    writeManaged(files.periodic, renderAptPeriodic());
    writeManaged(files.policy, renderAptUnattended());
    const test = hasBinary('apt-config') ? await exec('apt-config', ['dump'], { allowFailure: true, timeoutMs: 30_000 }) : { code: 0, stdout: 'APT::Periodic::Unattended-Upgrade "1";', stderr: '' };
    if (test.code !== 0 || !/APT::Periodic::Unattended-Upgrade "1";/.test(test.stdout)) {
      restore(files.periodic, previous.periodic);
      restore(files.policy, previous.policy);
      throw new OpError('config_invalid', `apt rejected the unattended-upgrades configuration; the previous files were restored: ${lastLine(test.stderr) || 'APT::Periodic::Unattended-Upgrade is not 1'}`, { output: test.stderr.trim() });
    }
    const timers = {};
    if (hasBinary('systemctl')) for (const t of APT_TIMERS) timers[t] = (await exec('systemctl', ['enable', '--now', t], { allowFailure: true, timeoutMs: 60_000 })).code === 0;
    return { family, files: [files.periodic, files.policy], validated: true, timers, status: await updatesStatus({ aptDir, dnfConf }) };
  }
  if (family === 'rhel') {
    if (!hasBinary('dnf-automatic')) throw new OpError('capability_missing', 'The dnf-automatic package is not installed');
    ctx.assertAllowedPath(dnfConf, 'write');
    const previous = readText(dnfConf);
    const next = setIniValues(previous || '', DNF_AUTOMATIC_VALUES);
    const check = parseIni(next);
    if (!Object.entries(DNF_AUTOMATIC_VALUES.commands).every(([k, v]) => check.commands?.[k] === v)) throw new OpError('config_invalid', `${dnfConf} could not be rewritten with the security-only settings`);
    writeManaged(dnfConf, next);
    const timers = {};
    let enabledTimer = null;
    if (hasBinary('systemctl')) {
      for (const t of DNF_TIMERS) {
        if (!(await unitExists(t))) { timers[t] = null; continue; }
        timers[t] = (await exec('systemctl', ['enable', '--now', t], { allowFailure: true, timeoutMs: 60_000 })).code === 0;
        if (timers[t]) { enabledTimer = t; break; }
      }
      if (!enabledTimer) { restore(dnfConf, previous); throw new OpError('config_invalid', 'No dnf-automatic timer could be enabled; the previous automatic.conf was restored', { timers }); }
    }
    return { family, files: [dnfConf], validated: true, timers, timer: enabledTimer, status: await updatesStatus({ aptDir, dnfConf }) };
  }
  throw new OpError('capability_missing', 'No supported package manager (apt-get, dnf or yum) is installed on this server');
}

export async function revertUpdates(ctx, { aptDir = APT_CONF_DIR, dnfConf = DNF_AUTOMATIC_CONF } = {}) {
  const { family } = detectManager();
  if (family === 'debian') {
    const files = aptPaths(aptDir);
    ctx.assertAllowedPath(files.periodic, 'write');
    ctx.assertAllowedPath(files.policy, 'write');
    const result = { family, policy: restoreOriginal(files.policy), periodic: restoreOriginal(files.periodic) };
    // With no periodic file at all apt's default is off; a restored original keeps whatever the operator had.
    if (result.periodic === 'removed') writeManaged(files.periodic, `// ${MANAGED_TEXT}. Unattended upgrades switched off by Revert.\nAPT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n`);
    return result;
  }
  if (family === 'rhel') {
    ctx.assertAllowedPath(dnfConf, 'write');
    const result = { family, conf: restoreOriginal(dnfConf), timers: {} };
    if (hasBinary('systemctl')) for (const t of DNF_TIMERS) if (await unitExists(t)) result.timers[t] = (await exec('systemctl', ['disable', '--now', t], { allowFailure: true, timeoutMs: 60_000 })).code === 0;
    return result;
  }
  return { family: null, skipped: true };
}

defineOp('hardening.updates.status', {
  description: 'Automatic security updates: package family, whether unattended-upgrades / dnf-automatic is installed, configured by the panel and scheduled',
  run: async () => updatesStatus(),
});

defineOp('hardening.updates.apply', {
  description: `Enable automatic security-only updates without reboots (Debian: ${APT_CONF_DIR}/${APT_PERIODIC_FILE} + ${APT_POLICY_FILE}, validated with apt-config dump; RHEL: ${DNF_AUTOMATIC_CONF} + dnf-automatic timer)`,
  timeoutMs: 180_000,
  run: async (_args, ctx) => applyUpdates(ctx),
});

defineOp('hardening.updates.revert', {
  description: 'Restore the distribution\'s automatic-update files (or switch the schedule off) and disable the dnf-automatic timer',
  destructive: true,
  run: async (_args, ctx) => revertUpdates(ctx),
});

// ------------------------------------------------------------------ sysctl ---

export const SYSCTL_FILE = '/etc/sysctl.d/90-whm-hardening.conf';
export const SYSCTL_SETTINGS = [
  ['net.ipv4.conf.all.rp_filter', '1'],
  ['net.ipv4.conf.default.rp_filter', '1'],
  ['net.ipv4.tcp_syncookies', '1'],
  ['net.ipv4.conf.all.accept_redirects', '0'],
  ['net.ipv4.conf.default.accept_redirects', '0'],
  ['net.ipv4.conf.all.secure_redirects', '0'],
  ['net.ipv4.conf.default.secure_redirects', '0'],
  ['net.ipv6.conf.all.accept_redirects', '0'],
  ['net.ipv6.conf.default.accept_redirects', '0'],
  ['net.ipv4.conf.all.send_redirects', '0'],
  ['net.ipv4.conf.default.send_redirects', '0'],
  ['net.ipv4.conf.all.accept_source_route', '0'],
  ['net.ipv4.conf.default.accept_source_route', '0'],
  ['net.ipv6.conf.all.accept_source_route', '0'],
  ['net.ipv6.conf.default.accept_source_route', '0'],
  ['net.ipv4.conf.all.log_martians', '1'],
  ['net.ipv4.conf.default.log_martians', '1'],
  ['net.ipv4.icmp_echo_ignore_broadcasts', '1'],
  ['net.ipv4.icmp_ignore_bogus_error_responses', '1'],
];
export const SYSCTL_KEYS = SYSCTL_SETTINGS.map(([k]) => k);
const sysctlKey = z.enum(SYSCTL_KEYS);
const sysctlValue = z.string().regex(/^\d{1,10}$/);

export function renderSysctl() {
  return [
    `${MANAGED}. Reverse-path filtering, SYN cookies, no ICMP redirects or source routing, martians logged.`,
    ...SYSCTL_SETTINGS.map(([k, v]) => `${k} = ${v}`),
    '',
  ].join('\n');
}

const procPath = (root, key) => path.join(root, ...key.split('.'));

export function readSysctlValues({ procRoot = '/proc/sys' } = {}) {
  const current = {};
  for (const key of SYSCTL_KEYS) {
    const text = readText(procPath(procRoot, key));
    if (text != null) current[key] = text.trim();
  }
  return current;
}

export async function sysctlStatus({ file = SYSCTL_FILE, procRoot = '/proc/sys' } = {}) {
  const configured = isManaged(readText(file));
  const current = readSysctlValues({ procRoot });
  const mismatched = [];
  const unavailable = [];
  for (const [key, expected] of SYSCTL_SETTINGS) {
    if (!(key in current)) { unavailable.push(key); continue; }
    if (current[key] !== expected) mismatched.push({ key, expected, current: current[key] });
  }
  const checked = SYSCTL_SETTINGS.length - unavailable.length;
  return { path: file, configured, effective: checked > 0 && mismatched.length === 0, applied: configured && checked > 0 && mismatched.length === 0, checked, mismatched, unavailable };
}

export async function applySysctl(ctx, { file = SYSCTL_FILE, procRoot = '/proc/sys' } = {}) {
  if (!hasBinary('sysctl')) throw new OpError('capability_missing', 'sysctl (procps) is not installed on this server');
  ctx.assertAllowedPath(file, 'write');
  const previousValues = readSysctlValues({ procRoot });
  if (!Object.keys(previousValues).length) throw new OpError('unsupported', `None of the hardening keys exist under ${procRoot}; this kernel or container does not expose them`);
  const previousText = readText(file);
  writeManaged(file, renderSysctl());
  const load = await exec('sysctl', ['-e', '-p', file], { allowFailure: true, timeoutMs: 30_000 });
  if (load.code !== 0) {
    restore(file, previousText);
    for (const [key, value] of Object.entries(previousValues)) await exec('sysctl', ['-w', `${key}=${value}`], { allowFailure: true, timeoutMs: 15_000 });
    throw new OpError('config_invalid', `The kernel rejected the sysctl settings; the file and the previous values were restored: ${lastLine(load.stderr)}`, { output: load.stderr.trim() });
  }
  return { path: file, previous: previousValues, validated: true, status: await sysctlStatus({ file, procRoot }) };
}

export async function revertSysctl({ restore: values = {} }, ctx, { file = SYSCTL_FILE } = {}) {
  ctx.assertAllowedPath(file, 'write');
  const result = { path: file, file: restoreOriginal(file), restored: [] };
  if (!hasBinary('sysctl')) return result;
  for (const [key, value] of Object.entries(values)) {
    const { code } = await exec('sysctl', ['-w', `${key}=${value}`], { allowFailure: true, timeoutMs: 15_000 });
    if (code === 0) result.restored.push(key);
  }
  return result;
}

defineOp('hardening.sysctl.status', {
  description: `Whether ${SYSCTL_FILE} is in place and every kernel network hardening key holds its value`,
  run: async () => sysctlStatus(),
});

defineOp('hardening.sysctl.apply', {
  description: `Write ${SYSCTL_FILE} and load it with sysctl -p (the file and the previous values are restored when the kernel rejects it)`,
  run: async (_args, ctx) => applySysctl(ctx),
});

defineOp('hardening.sysctl.revert', {
  description: `Remove ${SYSCTL_FILE} and set the keys back to the values recorded when it was applied`,
  destructive: true,
  schema: z.object({ restore: z.record(sysctlKey, sysctlValue).default({}) }).strict(),
  run: async (args, ctx) => revertSysctl(args, ctx),
});

// -------------------------------------------------------- firewall baseline ---

export const BASELINE_CHAIN = 'WHM_BASELINE';
const NFT_TABLE = ['inet', 'whm'];
const NFT_CHAIN = 'baseline';
const portRange = z.object({ from: port, to: port }).strict().refine((r) => r.from <= r.to, 'from must not exceed to');
const portList = z.array(z.union([port, portRange])).max(64);
const policy = z.enum(['ACCEPT', 'DROP']);

// `ss -ltnpH`: "LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))".
export function parseSshdPorts(stdout) {
  const ports = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] !== 'LISTEN') continue;
    if (!/users:\(\("sshd"/.test(line)) continue;
    const p = Number(cols[3].slice(cols[3].lastIndexOf(':') + 1));
    if (Number.isInteger(p) && p > 0) ports.add(p);
  }
  return [...ports].sort((a, b) => a - b);
}

async function sshdListeningPorts() {
  if (!hasBinary('ss')) return null;
  const { code, stdout } = await exec('ss', ['-ltnpH'], { allowFailure: true, timeoutMs: 15_000 });
  return code === 0 ? parseSshdPorts(stdout) : null;
}

const portKey = (p) => (typeof p === 'number' ? String(p) : `${p.from}-${p.to}`);
const inList = (list, n) => list.some((p) => (typeof p === 'number' ? p === n : n >= p.from && n <= p.to));

// `iptables -S INPUT` + `iptables -S WHM_BASELINE`.
export function parseIptablesBaseline(inputRules, chainRules) {
  const policyLine = String(inputRules || '').split('\n').find((l) => l.startsWith('-P INPUT '));
  const hooked = String(inputRules || '').split('\n').some((l) => l.trim() === `-A INPUT -j ${BASELINE_CHAIN}`);
  const tcp = []; const udp = [];
  for (const line of String(chainRules || '').split('\n')) {
    const m = line.match(/-p (tcp|udp) (?:-m \1 )?--dport (\d+)(?::(\d+))? -j ACCEPT/);
    if (!m) continue;
    const entry = m[3] ? { from: Number(m[2]), to: Number(m[3]) } : Number(m[2]);
    (m[1] === 'tcp' ? tcp : udp).push(entry);
  }
  return { policy: policyLine ? policyLine.split(' ')[2] : null, hooked, chainPresent: chainRules != null, tcp, udp };
}

// `nft -j list chain inet whm baseline`.
export function parseNftBaseline(json) {
  const out = { chainPresent: false, policy: null, tcp: [], udp: [] };
  let doc;
  try { doc = JSON.parse(json); } catch { return out; }
  for (const item of doc.nftables || []) {
    if (item.chain && item.chain.name === NFT_CHAIN) { out.chainPresent = true; out.policy = item.chain.policy || null; }
    const rule = item.rule;
    if (!rule || rule.chain !== NFT_CHAIN) continue;
    let proto = null; let ports = null; let accept = false;
    for (const e of rule.expr || []) {
      const m = e.match;
      if (m && m.left?.payload?.field === 'dport') {
        proto = m.left.payload.protocol;
        const right = m.right?.set ?? [m.right];
        ports = right.map((r) => (typeof r === 'number' ? r : r?.range ? { from: r.range[0], to: r.range[1] } : null)).filter((r) => r != null);
      }
      if (e.accept !== undefined) accept = true;
    }
    if (proto && ports && accept) (proto === 'tcp' ? out.tcp : out.udp).push(...ports);
  }
  return out;
}

export async function firewallStatus() {
  const backend = firewallBackend();
  const out = { backend, applied: false, chainPresent: false, policy: null, hooked: null, families: {}, sshdPorts: await sshdListeningPorts(), hubUnit: await unitExists('whm-hub.service'), conflicts: { firewalld: await unitActive('firewalld.service'), ufw: null } };
  if (hasBinary('ufw')) { const { code, stdout } = await exec('ufw', ['status'], { allowFailure: true, timeoutMs: 15_000 }); out.conflicts.ufw = code === 0 && /^Status:\s*active/m.test(stdout); }
  if (backend === 'iptables') {
    for (const [family, bin] of [['ipv4', 'iptables'], ['ipv6', 'ip6tables']]) {
      if (!hasBinary(bin)) { out.families[family] = null; continue; }
      const input = await exec(bin, ['-S', 'INPUT'], { allowFailure: true, timeoutMs: 15_000 });
      const chain = await exec(bin, ['-S', BASELINE_CHAIN], { allowFailure: true, timeoutMs: 15_000 });
      out.families[family] = parseIptablesBaseline(input.code === 0 ? input.stdout : '', chain.code === 0 ? chain.stdout : null);
    }
    const v4 = out.families.ipv4;
    out.chainPresent = Boolean(v4?.chainPresent);
    out.policy = v4?.policy ?? null;
    out.hooked = Boolean(v4?.hooked);
    out.tcp = v4?.tcp || []; out.udp = v4?.udp || [];
    out.applied = out.chainPresent && out.hooked && out.policy === 'DROP';
  } else if (backend === 'nft') {
    const { code, stdout } = await exec('nft', ['-j', 'list', 'chain', ...NFT_TABLE, NFT_CHAIN], { allowFailure: true, timeoutMs: 15_000 });
    const parsed = code === 0 ? parseNftBaseline(stdout) : { chainPresent: false, policy: null, tcp: [], udp: [] };
    out.chainPresent = parsed.chainPresent; out.policy = parsed.policy ? parsed.policy.toUpperCase() : null; out.hooked = parsed.chainPresent;
    out.tcp = parsed.tcp; out.udp = parsed.udp;
    out.applied = parsed.chainPresent && parsed.policy === 'drop';
  }
  return out;
}

async function iptablesTeardown(bin) {
  await exec(bin, ['-P', 'INPUT', 'ACCEPT'], { allowFailure: true });
  for (let i = 0; i < 10; i++) if ((await exec(bin, ['-D', 'INPUT', '-j', BASELINE_CHAIN], { allowFailure: true })).code !== 0) break;
  await exec(bin, ['-F', BASELINE_CHAIN], { allowFailure: true });
  await exec(bin, ['-X', BASELINE_CHAIN], { allowFailure: true });
}

const iptDport = (p) => (typeof p === 'number' ? String(p) : `${p.from}:${p.to}`);
const nftSet = (list) => `{ ${list.map((p) => (typeof p === 'number' ? String(p) : `${p.from}-${p.to}`)).join(', ')} }`;

export async function applyFirewallBaseline({ tcp, udp, sshPorts }, ctx) {
  const backend = firewallBackend();
  if (!backend) throw new OpError('capability_missing', 'Neither iptables nor nftables (nft) is installed; the firewall baseline needs one of them');
  const missing = sshPorts.filter((p) => !inList(tcp, p));
  if (missing.length) throw new OpError('refused', `SSH port ${missing.join(', ')} is not in the allow list; the baseline was not applied`);
  const live = await sshdListeningPorts();
  const liveMissing = (live || []).filter((p) => !inList(tcp, p));
  if (liveMissing.length) throw new OpError('refused', `sshd is listening on port ${liveMissing.join(', ')}, which is not in the allow list; the baseline was not applied`);
  if (await unitActive('firewalld.service')) throw new OpError('refused', 'firewalld is active and owns the input policy; manage the baseline there or stop firewalld first');
  if (hasBinary('ufw')) { const { code, stdout } = await exec('ufw', ['status'], { allowFailure: true, timeoutMs: 15_000 }); if (code === 0 && /^Status:\s*active/m.test(stdout)) throw new OpError('refused', 'ufw is active and owns the input policy; manage the baseline there or disable ufw first'); }
  const applied = [];
  let previousPolicy = 'ACCEPT';
  try {
    if (backend === 'iptables') {
      for (const bin of ['iptables', 'ip6tables'].filter(hasBinary)) {
        const before = await exec(bin, ['-S', 'INPUT'], { allowFailure: true });
        if (bin === 'iptables' && before.code === 0) previousPolicy = parseIptablesBaseline(before.stdout, null).policy || 'ACCEPT';
        applied.push(bin);
        await exec(bin, ['-N', BASELINE_CHAIN], { allowFailure: true });
        await exec(bin, ['-F', BASELINE_CHAIN]);
        await exec(bin, ['-A', BASELINE_CHAIN, '-i', 'lo', '-j', 'ACCEPT']);
        await exec(bin, ['-A', BASELINE_CHAIN, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
        await exec(bin, ['-A', BASELINE_CHAIN, '-m', 'conntrack', '--ctstate', 'INVALID', '-j', 'DROP']);
        await exec(bin, ['-A', BASELINE_CHAIN, '-p', bin === 'ip6tables' ? 'ipv6-icmp' : 'icmp', '-j', 'ACCEPT']);
        for (const p of tcp) await exec(bin, ['-A', BASELINE_CHAIN, '-p', 'tcp', '--dport', iptDport(p), '-j', 'ACCEPT']);
        for (const p of udp) await exec(bin, ['-A', BASELINE_CHAIN, '-p', 'udp', '--dport', iptDport(p), '-j', 'ACCEPT']);
        // Appended, not inserted: WHM_BLOCK and fail2ban's chains stay ahead so a
        // banned address is dropped before the baseline accepts its port.
        if ((await exec(bin, ['-C', 'INPUT', '-j', BASELINE_CHAIN], { allowFailure: true })).code !== 0) await exec(bin, ['-A', 'INPUT', '-j', BASELINE_CHAIN]);
        await exec(bin, ['-P', 'INPUT', 'DROP']);
      }
    } else {
      applied.push('nft');
      await exec('nft', ['add', 'table', ...NFT_TABLE]);
      // Created accepting: the accept rules go in before the policy flips to drop.
      await exec('nft', ['add', 'chain', ...NFT_TABLE, NFT_CHAIN, '{ type filter hook input priority 0 ; policy accept ; }']);
      await exec('nft', ['flush', 'chain', ...NFT_TABLE, NFT_CHAIN]);
      await exec('nft', ['add', 'rule', ...NFT_TABLE, NFT_CHAIN, 'iif', 'lo', 'accept']);
      await exec('nft', ['add', 'rule', ...NFT_TABLE, NFT_CHAIN, 'ct', 'state', 'established,related', 'accept']);
      await exec('nft', ['add', 'rule', ...NFT_TABLE, NFT_CHAIN, 'ct', 'state', 'invalid', 'drop']);
      await exec('nft', ['add', 'rule', ...NFT_TABLE, NFT_CHAIN, 'meta', 'l4proto', '{ icmp, ipv6-icmp }', 'accept']);
      if (tcp.length) await exec('nft', ['add', 'rule', ...NFT_TABLE, NFT_CHAIN, 'tcp', 'dport', nftSet(tcp), 'accept']);
      if (udp.length) await exec('nft', ['add', 'rule', ...NFT_TABLE, NFT_CHAIN, 'udp', 'dport', nftSet(udp), 'accept']);
      await exec('nft', ['add', 'chain', ...NFT_TABLE, NFT_CHAIN, '{ policy drop ; }']);
    }
  } catch (err) {
    if (backend === 'iptables') for (const bin of applied) await iptablesTeardown(bin);
    else await exec('nft', ['delete', 'chain', ...NFT_TABLE, NFT_CHAIN], { allowFailure: true });
    throw new OpError('config_invalid', `The firewall rejected the baseline rules; everything was taken down again: ${err.message}`, { backend });
  }
  const status = await firewallStatus();
  if (!status.applied) {
    if (backend === 'iptables') for (const bin of applied) await iptablesTeardown(bin);
    else await exec('nft', ['delete', 'chain', ...NFT_TABLE, NFT_CHAIN], { allowFailure: true });
    throw new OpError('config_invalid', 'The baseline did not take effect; it was taken down again', { backend, status });
  }
  return { backend, previousPolicy, tcp: tcp.map(portKey), udp: udp.map(portKey), sshPorts, status };
}

export async function revertFirewallBaseline({ restorePolicy = 'ACCEPT' } = {}) {
  const backend = firewallBackend();
  if (!backend) return { backend: null, skipped: true };
  if (backend === 'iptables') {
    for (const bin of ['iptables', 'ip6tables'].filter(hasBinary)) {
      await exec(bin, ['-P', 'INPUT', restorePolicy], { allowFailure: true });
      for (let i = 0; i < 10; i++) if ((await exec(bin, ['-D', 'INPUT', '-j', BASELINE_CHAIN], { allowFailure: true })).code !== 0) break;
      await exec(bin, ['-F', BASELINE_CHAIN], { allowFailure: true });
      await exec(bin, ['-X', BASELINE_CHAIN], { allowFailure: true });
    }
  } else {
    await exec('nft', ['delete', 'chain', ...NFT_TABLE, NFT_CHAIN], { allowFailure: true });
  }
  return { backend, restorePolicy, status: await firewallStatus() };
}

defineOp('hardening.firewall.status', {
  description: `Whether the ${BASELINE_CHAIN} chain (iptables) or inet whm baseline (nft) is in place with a default-deny input policy, the ports it allows, the ports sshd listens on and whether firewalld/ufw own the policy`,
  run: async () => firewallStatus(),
});

defineOp('hardening.firewall.apply', {
  description: 'Install the default-deny input baseline: loopback, established traffic, ICMP and the given TCP/UDP ports are accepted, everything else dropped. Refused unless every port sshd listens on is in the list and no firewalld/ufw is active',
  destructive: true,
  timeoutMs: 120_000,
  schema: z.object({ tcp: portList.min(1), udp: portList.default([]), sshPorts: z.array(port).min(1).max(8) }).strict(),
  run: async (args, ctx) => applyFirewallBaseline(args, ctx),
});

defineOp('hardening.firewall.revert', {
  description: 'Set the input policy back, unhook and delete the baseline chain',
  destructive: true,
  schema: z.object({ restorePolicy: policy.default('ACCEPT') }).strict(),
  run: async (args) => revertFirewallBaseline(args),
});
