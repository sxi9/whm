import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { DOMLOGS_ROOT, selinuxMode } from './web.js';

// Security Center op family: TCP wrappers, sshd, root SSH keys, compiler and
// traceroute access, fork bomb limits, the panel's firewall chains, SMTP
// restrictions, ModSecurity and Apache mod_userdir. Every write to a config file
// is atomic, backed up and, where a validator exists (sshd -t, apachectl -t),
// rolled back when the validator rejects it.

const MANAGED = '# Managed by WHM panel';

// ---------------------------------------------------------------- helpers ---

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) fs.copyFileSync(file, `${file}.whm-bak`);
  const tmp = `${file}.whm-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function restore(file, previous) {
  if (previous == null) { try { fs.unlinkSync(file); } catch { /* already gone */ } } else fs.writeFileSync(file, previous);
}

const lastLine = (s) => String(s || '').trim().split('\n').pop() || '';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Scratch space for files root will execute or unpack. A world-writable parent
// such as /tmp lets any local user plant the directory (or a symlink) ahead of
// us and swap its contents between write and exec, so the parent must be a real
// root-owned directory nobody else can write to; the fresh mkdtemp dir is 0700.
export function privateTempDir(parent, prefix) {
  let st;
  try { st = fs.lstatSync(parent); } catch { throw new OpError('path_not_allowed', `${parent} does not exist`); }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new OpError('path_not_allowed', `${parent} is not a directory`);
  if (st.uid !== 0 || (st.mode & 0o022) !== 0) throw new OpError('path_not_allowed', `${parent} must be owned by root and not group/world writable before the agent stages files in it`);
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function groupEntry(name) {
  const line = (readText('/etc/group') || '').split('\n').find((l) => l.startsWith(`${name}:`));
  return line ? { name, gid: Number(line.split(':')[2]) } : null;
}

async function reloadUnit(candidates) {
  if (!hasBinary('systemctl')) return { reloaded: false, unit: null };
  for (const unit of candidates) {
    const { code } = await exec('systemctl', ['reload-or-restart', `${unit}.service`], { allowFailure: true, timeoutMs: 120_000 });
    if (code === 0) return { reloaded: true, unit };
  }
  return { reloaded: false, unit: null };
}

export function apacheFlavor() {
  if (exists('/etc/apache2')) {
    return { flavor: 'debian', bin: ['apache2ctl', 'apachectl'].find(hasBinary) || null, confDir: '/etc/apache2', includeDir: '/etc/apache2/conf-enabled', modsEnabled: '/etc/apache2/mods-enabled', units: ['apache2'], logDir: '/var/log/apache2', errorLog: '/var/log/apache2/error.log' };
  }
  if (exists('/etc/httpd')) {
    return { flavor: 'rhel', bin: ['httpd', 'apachectl'].find(hasBinary) || null, confDir: '/etc/httpd', includeDir: '/etc/httpd/conf.d', modsEnabled: '/etc/httpd/conf.modules.d', units: ['httpd'], logDir: '/var/log/httpd', errorLog: '/var/log/httpd/error_log' };
  }
  return null;
}

function requireApache() {
  const apache = apacheFlavor();
  if (!apache) throw new OpError('capability_missing', 'Apache is not installed on this server (no /etc/apache2 or /etc/httpd)');
  if (!apache.bin) throw new OpError('capability_missing', 'Apache configuration directory exists but no apachectl/httpd binary was found');
  return apache;
}

async function apacheConfigTest(apache) {
  const { code, stderr } = await exec(apache.bin, ['-t'], { allowFailure: true, timeoutMs: 60_000 });
  return { ok: code === 0, output: stderr.trim() };
}

// Writes an Apache include, validates the whole config and rolls back on error.
async function writeApacheInclude(apache, file, content) {
  const previous = readText(file);
  writeAtomic(file, content);
  const test = await apacheConfigTest(apache);
  if (!test.ok) {
    restore(file, previous);
    throw new OpError('config_invalid', `Apache rejected the new configuration; the previous file was restored: ${test.output.split('\n').pop()}`, { output: test.output });
  }
  return { path: file, validated: true };
}

const ipOrCidr = z.string().max(64).refine((v) => {
  const [addr, prefix] = v.split('/');
  const family = net.isIP(addr);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}, 'Must be an IPv4/IPv6 address or CIDR network');

const groupName = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/i);

// ------------------------------------------------------- host access control ---

const HOSTS_ALLOW = '/etc/hosts.allow';
const HOSTS_DENY = '/etc/hosts.deny';

// libwrap splits fields on ":" and only understands IPv6 in brackets
// ("[2001:db8::]/32"), so any source containing a colon must be an IPv6 address
// or network; it is rendered bracketed whether or not the operator typed them.
export function hostSourceForm(source) {
  const s = String(source || '');
  if (!s.includes(':')) return s;
  const m = s.match(/^\[?([0-9a-fA-F:.]+)\]?(?:\/(\d{1,3}))?$/);
  if (!m || net.isIP(m[1]) !== 6) return null;
  if (m[2] !== undefined && Number(m[2]) > 128) return null;
  return `[${m[1].toLowerCase()}]${m[2] !== undefined ? `/${m[2]}` : ''}`;
}

const hostRule = z.object({
  service: z.string().regex(/^(ALL|[A-Za-z0-9_.-]{1,32})$/, 'Daemon name such as sshd, vsftpd, ALL'),
  source: z.string().regex(/^(ALL|LOCAL|KNOWN|UNKNOWN|PARANOID|\[?[A-Za-z0-9.:/_-]{1,255}\]?(\/\d{1,3})?)$/, 'Host, IP, network/mask or wildcard').refine((v) => hostSourceForm(v) !== null, 'An address containing ":" must be an IPv6 address or network, e.g. [2001:db8::]/32'),
  action: z.enum(['allow', 'deny']),
  comment: z.string().regex(/^[^\n\0]{0,120}$/).optional(),
}).strict();

// All rules go into hosts.allow with explicit ALLOW/DENY so the operator's order is
// honoured (tcp wrappers stops at the first match); hosts.deny only carries a header.
export function renderHostsAllow(rules) {
  const lines = [`${MANAGED} (Host Access Control). Edit through the panel; manual changes are overwritten.`, ''];
  for (const r of rules) {
    if (r.comment) lines.push(`# ${r.comment}`);
    lines.push(`${r.service}: ${hostSourceForm(r.source) ?? r.source}: ${r.action.toUpperCase()}`);
  }
  return `${lines.join('\n')}\n`;
}

// hosts.deny is only taken over when the panel already owns it or it carries no
// rules; a distro or hand-written deny file keeps applying and is reported as such.
export function hostsDenyManaged(text) {
  if (text == null) return true;
  if (text.startsWith(MANAGED)) return true;
  return !text.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'));
}

// Whether the host honours hosts.allow at all is decided by the TCP wrappers
// library being present (Debian/Ubuntu multiarch dirs, RHEL lib64), never by the
// files themselves: the panel writes those on every host, including RHEL 8+
// where tcp_wrappers was removed and nothing consults them.
const LIBWRAP_DIRS = ['/lib', '/usr/lib', '/lib64', '/usr/lib64'];

export function findLibwrap(dirs = LIBWRAP_DIRS) {
  for (const dir of dirs) {
    for (const name of ['libwrap.so.0', 'libwrap.so']) if (exists(path.join(dir, name))) return path.join(dir, name);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries.sort()) if (/-linux-(gnu|musl)/.test(e) && exists(path.join(dir, e, 'libwrap.so.0'))) return path.join(dir, e, 'libwrap.so.0');
  }
  return null;
}

async function daemonLinksLibwrap(name) {
  const bin = resolveBinary(name);
  if (!bin || !hasBinary('ldd')) return null;
  const { code, stdout } = await exec('ldd', [bin], { allowFailure: true, timeoutMs: 15_000 });
  return code === 0 ? /\blibwrap\.so/.test(stdout) : null;
}

defineOp('sec.hosts_allow.read', {
  description: 'Current /etc/hosts.allow and /etc/hosts.deny contents, plus whether libwrap exists and sshd links it',
  run: async () => {
    const deny = readText(HOSTS_DENY);
    const library = findLibwrap();
    return { allow: readText(HOSTS_ALLOW), deny, denyManaged: hostsDenyManaged(deny), supported: library !== null, library, daemons: { sshd: await daemonLinksLibwrap('sshd') } };
  },
});

defineOp('sec.hosts_allow.write', {
  description: 'Render host access rules into /etc/hosts.allow (ordered ALLOW/DENY); /etc/hosts.deny is only rewritten when the panel already manages it',
  schema: z.object({ rules: z.array(hostRule).max(500) }).strict(),
  run: async ({ rules }, ctx) => {
    ctx.assertAllowedPath(HOSTS_ALLOW, 'write');
    ctx.assertAllowedPath(HOSTS_DENY, 'write');
    writeAtomic(HOSTS_ALLOW, renderHostsAllow(rules));
    const denyUntouched = !hostsDenyManaged(readText(HOSTS_DENY));
    if (!denyUntouched) writeAtomic(HOSTS_DENY, `${MANAGED} (Host Access Control). Rules live in /etc/hosts.allow with explicit ALLOW/DENY actions.\n`);
    return { rules: rules.length, files: denyUntouched ? [HOSTS_ALLOW] : [HOSTS_ALLOW, HOSTS_DENY], denyUntouched };
  },
});

// -------------------------------------------------------------------- sshd ---

const SSHD_CONFIG = '/etc/ssh/sshd_config';
const SSHD_DROPIN_DIR = '/etc/ssh/sshd_config.d';
// sshd takes the first value it reads and Include globs are expanded in lexical
// order, so the drop-in must sort before distro files such as 50-cloud-init.conf
// (which sets PasswordAuthentication yes) or it is silently ignored.
const SSHD_MANAGED = `${SSHD_DROPIN_DIR}/00-whm.conf`;
const SSHD_LEGACY_MANAGED = `${SSHD_DROPIN_DIR}/whm.conf`;
const SSHD_INCLUDE = 'Include /etc/ssh/sshd_config.d/*.conf';
const SSHD_VALUE_ALIASES = { 'without-password': 'prohibit-password' };

const yesNo = z.enum(['yes', 'no']);
const sshdSettings = z.object({
  PasswordAuthentication: yesNo.nullable().optional(),
  PermitRootLogin: z.enum(['yes', 'no', 'prohibit-password', 'without-password', 'forced-commands-only']).nullable().optional(),
  PubkeyAuthentication: yesNo.nullable().optional(),
  KbdInteractiveAuthentication: yesNo.nullable().optional(),
  ChallengeResponseAuthentication: yesNo.nullable().optional(),
  PermitEmptyPasswords: yesNo.nullable().optional(),
  UsePAM: yesNo.nullable().optional(),
  X11Forwarding: yesNo.nullable().optional(),
  AllowTcpForwarding: z.enum(['yes', 'no', 'local', 'remote']).nullable().optional(),
  MaxAuthTries: z.number().int().min(1).max(100).nullable().optional(),
  Port: z.number().int().min(1).max(65535).nullable().optional(),
  LoginGraceTime: z.number().int().min(1).max(3600).nullable().optional(),
  ClientAliveInterval: z.number().int().min(0).max(86400).nullable().optional(),
  ClientAliveCountMax: z.number().int().min(0).max(1000).nullable().optional(),
}).strict();

export function parseSshdConfig(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^match\b/i.test(line)) break;
    const m = line.match(/^(\w+)\s*[=\s]\s*(.+)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

// Everything sshd reads before the managed drop-in, in order: the main file up to
// the Include line (the whole file when the Include is missing, since the drop-in
// is then never read) and the drop-ins that sort before ours.
function sshdSourcesBefore() {
  const main = readText(SSHD_CONFIG) || '';
  const includeIndex = main.indexOf(SSHD_INCLUDE);
  const sources = [{ file: includeIndex >= 0 ? `${SSHD_CONFIG} (before the Include line)` : `${SSHD_CONFIG} (no Include line)`, settings: parseSshdConfig(includeIndex >= 0 ? main.slice(0, includeIndex) : main) }];
  let dropins = [];
  try { dropins = fs.readdirSync(SSHD_DROPIN_DIR).filter((f) => f.endsWith('.conf')).sort(); } catch { /* no drop-in dir */ }
  for (const f of dropins) {
    if (f >= path.basename(SSHD_MANAGED)) break;
    sources.push({ file: path.join(SSHD_DROPIN_DIR, f), settings: parseSshdConfig(readText(path.join(SSHD_DROPIN_DIR, f))) });
  }
  return { sources, main, includeIndex, dropins };
}

function sshdEffectiveFromFiles() {
  const merged = {};
  const { main, includeIndex, dropins } = sshdSourcesBefore();
  const before = includeIndex >= 0 ? main.slice(0, includeIndex) : '';
  const after = includeIndex >= 0 ? main.slice(includeIndex) : main;
  Object.assign(merged, parseSshdConfig(before));
  if (includeIndex >= 0) for (const f of dropins) for (const [k, v] of Object.entries(parseSshdConfig(readText(path.join(SSHD_DROPIN_DIR, f))))) if (!(k in merged)) merged[k] = v;
  for (const [k, v] of Object.entries(parseSshdConfig(after))) if (!(k in merged)) merged[k] = v;
  return merged;
}

const sshdNorm = (v) => { const s = String(v).trim().toLowerCase(); return SSHD_VALUE_ALIASES[s] || s; };

// Managed values that sshd does not actually apply, each with the earlier file
// that supplies the winning value when it can be identified.
export function sshdShadowed(managed, effective, sources = []) {
  const out = [];
  for (const [k, v] of Object.entries(managed)) {
    const key = k.toLowerCase();
    if (!(key in effective) || sshdNorm(effective[key]) === sshdNorm(v)) continue;
    const by = sources.find((s) => key in s.settings && sshdNorm(s.settings[key]) === sshdNorm(effective[key]))?.file || null;
    out.push({ key: k, managed: String(v), effective: String(effective[key]), by });
  }
  return out;
}

function readSshdManaged(file = SSHD_MANAGED) {
  const managed = {};
  for (const line of (readText(file) || '').split('\n')) {
    const m = line.trim().match(/^(\w+)\s+(.+)$/);
    if (m && !line.startsWith('#')) managed[m[1]] = m[2];
  }
  return managed;
}

async function sshdEffective() {
  if (hasBinary('sshd')) {
    const { code, stdout } = await exec('sshd', ['-T'], { allowFailure: true, timeoutMs: 30_000 });
    if (code === 0) return { effective: parseSshdConfig(stdout), source: 'sshd -T' };
  }
  return { effective: sshdEffectiveFromFiles(), source: 'files' };
}

function renderSshdManaged(settings) {
  const lines = [`${MANAGED} (SSH Password Authorization Tweak). Loaded through ${SSHD_INCLUDE}; first value wins.`];
  for (const [k, v] of Object.entries(settings)) if (v != null) lines.push(`${k} ${v}`);
  return `${lines.join('\n')}\n`;
}

defineOp('sec.sshd.get', {
  description: 'Effective sshd settings (sshd -T when available) plus the panel-managed drop-in',
  run: async () => {
    const installed = hasBinary('sshd');
    const { effective, source } = await sshdEffective();
    const legacy = exists(SSHD_LEGACY_MANAGED) && !exists(SSHD_MANAGED);
    const managed = readSshdManaged(legacy ? SSHD_LEGACY_MANAGED : SSHD_MANAGED);
    const mainText = readText(SSHD_CONFIG);
    const includeActive = mainText == null ? false : mainText.includes(SSHD_INCLUDE);
    return { installed, source, effective, managed, managedPath: SSHD_MANAGED, legacyPath: legacy ? SSHD_LEGACY_MANAGED : null, includeActive, configPresent: mainText != null, shadowed: sshdShadowed(managed, effective, sshdSourcesBefore().sources) };
  },
});

const SSH_PORT_DEFAULT = 22;
const SSHD_UNITS = ['ssh', 'sshd'];

// `semanage port -l` lines: "ssh_port_t   tcp   22" or "http_port_t   tcp   80, 81, 443, 8008-8010".
export function semanagePorts(stdout, type = 'ssh_port_t', proto = 'tcp') {
  const ranges = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(\S+)\s+(tcp|udp|sctp|dccp)\s+(.+)$/);
    if (!m || m[1] !== type || m[2] !== proto) continue;
    for (const item of m[3].split(',')) {
      const r = item.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (r) ranges.push({ from: Number(r[1]), to: Number(r[2] ?? r[1]) });
    }
  }
  return ranges;
}

export const selinuxPortLabelled = (stdout, port, type = 'ssh_port_t') => semanagePorts(stdout, type).some((r) => port >= r.from && port <= r.to);

// `ss -ltnH` rows: "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*" (the header is skipped
// when an old iproute2 ignores -H); the port is whatever follows the last ":"
// of the local address, which also covers "[::]:22" and "*:22".
export function parseListeningPorts(stdout) {
  const ports = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] !== 'LISTEN') continue;
    const port = Number(cols[3].slice(cols[3].lastIndexOf(':') + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports;
}

// A re-exec'd sshd cannot bind a port SELinux has not labelled ssh_port_t: it
// logs "Bind to port N failed: Permission denied" and exits while the reload
// itself returns 0. The label is added before any file changes so a missing
// semanage (policycoreutils-python-utils) refuses the change with nothing touched.
async function ensureSshdSelinuxPort(port) {
  const mode = await selinuxMode();
  if (!mode || mode === 'disabled' || port === SSH_PORT_DEFAULT) return { mode, labelled: null, warnings: [] };
  const type = 'ssh_port_t';
  if (!hasBinary('semanage')) {
    if (mode === 'enforcing') throw new OpError('capability_missing', `SELinux is enforcing and semanage is not installed, so sshd could not bind port ${port}: install policycoreutils-python-utils (dnf install policycoreutils-python-utils) and save again`);
    return { mode, labelled: false, warnings: [`semanage is missing (policycoreutils-python-utils): port ${port} is not labelled ${type} and sshd will fail to bind it once SELinux enforces`] };
  }
  const list = await exec('semanage', ['port', '-l'], { allowFailure: true, timeoutMs: 120_000 });
  if (list.code === 0 && selinuxPortLabelled(list.stdout, port, type)) return { mode, labelled: true, added: false, warnings: [] };
  let r = await exec('semanage', ['port', '-a', '-t', type, '-p', 'tcp', String(port)], { allowFailure: true, timeoutMs: 120_000 });
  if (r.code !== 0 && /already defined/i.test(r.stderr)) r = await exec('semanage', ['port', '-m', '-t', type, '-p', 'tcp', String(port)], { allowFailure: true, timeoutMs: 120_000 });
  if (r.code !== 0) {
    const reason = `SELinux refused to label port ${port} as ${type}: ${lastLine(r.stderr) || `exit ${r.code}`}`;
    if (mode === 'enforcing') throw new OpError('command_failed', `${reason}; sshd would not be able to bind it, so nothing was changed`);
    return { mode, labelled: false, warnings: [reason] };
  }
  return { mode, labelled: true, added: true, warnings: [] };
}

// A host firewall that only admits the ssh service locks the operator out the
// moment sshd moves; firewalld (runtime + permanent) and an active ufw get the
// port opened before sshd rebinds. A failure is reported, not fatal.
async function openSshdFirewallPort(port) {
  const out = { firewalld: null, ufw: null, warnings: [] };
  if (port === SSH_PORT_DEFAULT) return out;
  if (hasBinary('firewall-cmd')) {
    const state = await exec('firewall-cmd', ['--state'], { allowFailure: true, timeoutMs: 30_000 });
    if (state.code === 0 && /running/i.test(state.stdout)) {
      const runtime = await exec('firewall-cmd', [`--add-port=${port}/tcp`], { allowFailure: true, timeoutMs: 60_000 });
      const permanent = await exec('firewall-cmd', ['--permanent', `--add-port=${port}/tcp`], { allowFailure: true, timeoutMs: 60_000 });
      out.firewalld = runtime.code === 0 && permanent.code === 0 ? 'opened' : 'failed';
      if (out.firewalld === 'failed') out.warnings.push(`firewalld did not open ${port}/tcp: ${lastLine(permanent.stderr || runtime.stderr) || 'unknown error'}; open it before reconnecting`);
    } else out.firewalld = 'inactive';
  }
  if (hasBinary('ufw')) {
    const status = await exec('ufw', ['status'], { allowFailure: true, timeoutMs: 30_000 });
    if (status.code === 0 && /^Status:\s*active/m.test(status.stdout)) {
      const r = await exec('ufw', ['allow', `${port}/tcp`], { allowFailure: true, timeoutMs: 60_000 });
      out.ufw = r.code === 0 ? 'opened' : 'failed';
      if (out.ufw === 'failed') out.warnings.push(`ufw did not allow ${port}/tcp: ${lastLine(r.stderr) || 'unknown error'}; open it before reconnecting`);
    } else out.ufw = 'inactive';
  }
  return out;
}

// Ubuntu 22.10+ runs sshd through ssh.socket: the listener comes from the socket
// unit's ListenStream, so Port in sshd_config is ignored and a reload keeps
// port 22. The socket unit's own drop-in directory is outside the agent's
// roots, so a port change moves the host to the classic service (Ubuntu's
// documented alternative): the socket is disabled and stopped, which also stops
// the service it is required by, and ssh.service is enabled and started so it
// binds from sshd_config. Open sessions survive (KillMode=process).
async function sshdSocketActivation() {
  if (!hasBinary('systemctl')) return null;
  for (const unit of SSHD_UNITS) {
    const r = await exec('systemctl', ['is-active', `${unit}.socket`], { allowFailure: true, timeoutMs: 30_000 });
    if (r.stdout.trim() === 'active') return unit;
  }
  return null;
}

async function convertSshdToService(unit) {
  await exec('systemctl', ['disable', '--now', `${unit}.socket`], { timeoutMs: 120_000 });
  await exec('systemctl', ['enable', `${unit}.service`], { timeoutMs: 120_000 });
  await exec('systemctl', ['restart', `${unit}.service`], { timeoutMs: 120_000 });
  return { reloaded: true, unit };
}

async function sshdListening(port) {
  if (!hasBinary('ss')) return null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await exec('ss', ['-ltnH'], { allowFailure: true, timeoutMs: 15_000 });
    if (r.code !== 0) return null;
    if (parseListeningPorts(r.stdout).has(port)) return true;
    await sleep(300);
  }
  return false;
}

defineOp('sec.sshd.set', {
  description: `Write sshd settings to ${SSHD_MANAGED}, validate with sshd -t, label/open a changed port (SELinux, firewalld/ufw), reload, verify the listener and report values other files override`,
  schema: z.object({ settings: sshdSettings }).strict(),
  run: async ({ settings }, ctx) => {
    ctx.assertAllowedPath(SSHD_MANAGED, 'write');
    ctx.assertAllowedPath(SSHD_LEGACY_MANAGED, 'write');
    ctx.assertAllowedPath(SSHD_CONFIG, 'write');
    if (!hasBinary('sshd')) throw new OpError('capability_missing', 'OpenSSH server (sshd) is not installed on this server');
    const previousManaged = readText(SSHD_MANAGED);
    const previousLegacy = readText(SSHD_LEGACY_MANAGED);
    const current = readSshdManaged(previousManaged == null && previousLegacy != null ? SSHD_LEGACY_MANAGED : SSHD_MANAGED);
    for (const [k, v] of Object.entries(settings)) {
      if (v === undefined) continue;
      if (v === null) delete current[k]; else current[k] = String(v);
    }
    const port = current.Port != null ? Number(current.Port) : null;
    const warnings = [];
    const selinux = port != null ? await ensureSshdSelinuxPort(port) : { mode: null, labelled: null, warnings: [] };
    warnings.push(...selinux.warnings);
    const previousMain = readText(SSHD_CONFIG);
    let includeAdded = false;
    if (previousMain != null && !previousMain.includes(SSHD_INCLUDE)) {
      // The Include must precede every Match block, so it goes at the very top.
      writeAtomic(SSHD_CONFIG, `${SSHD_INCLUDE}\n${previousMain}`, 0o600);
      includeAdded = true;
    }
    writeAtomic(SSHD_MANAGED, renderSshdManaged(current), 0o600);
    if (previousLegacy != null) { try { fs.unlinkSync(SSHD_LEGACY_MANAGED); } catch { /* already gone */ } }
    const rollback = () => {
      restore(SSHD_MANAGED, previousManaged);
      if (previousLegacy != null) restore(SSHD_LEGACY_MANAGED, previousLegacy);
      if (includeAdded) restore(SSHD_CONFIG, previousMain);
    };
    const { code, stderr } = await exec('sshd', ['-t'], { allowFailure: true, timeoutMs: 30_000 });
    if (code !== 0) {
      rollback();
      throw new OpError('config_invalid', `sshd rejected the configuration; the previous files were restored: ${lastLine(stderr)}`, { output: stderr.trim() });
    }
    const firewall = port != null ? await openSshdFirewallPort(port) : { firewalld: null, ufw: null, warnings: [] };
    warnings.push(...firewall.warnings);
    const socketUnit = port != null ? await sshdSocketActivation() : null;
    let reload;
    if (socketUnit) {
      reload = await convertSshdToService(socketUnit);
      warnings.push(`${socketUnit}.socket (systemd socket activation, which ignores Port) was disabled; sshd now runs as ${socketUnit}.service and listens on the configured port`);
    } else reload = await reloadUnit(SSHD_UNITS);
    const { effective } = await sshdEffective();
    const expectPort = Number(effective.port) || port || SSH_PORT_DEFAULT;
    const listening = reload.reloaded ? await sshdListening(expectPort) : null;
    if (listening === false) {
      rollback();
      const again = await reloadUnit(SSHD_UNITS);
      const restored = again.reloaded ? await sshdListening(Number((await sshdEffective()).effective.port) || SSH_PORT_DEFAULT) : null;
      throw new OpError('config_invalid', `sshd is not listening on port ${expectPort} after the reload (check "journalctl -u ${reload.unit || 'sshd'}"); the previous files were restored${restored ? ' and sshd is listening again on its previous port' : again.reloaded ? ' but sshd is still not listening: check the journal before closing this session' : ''}`, { port: expectPort, restored, warnings });
    }
    return { path: SSHD_MANAGED, settings: current, includeAdded, migratedLegacy: previousLegacy != null, ...reload, port: expectPort, listening, selinux: { mode: selinux.mode, labelled: selinux.labelled }, firewall: { firewalld: firewall.firewalld, ufw: firewall.ufw }, socketActivation: socketUnit ? { unit: `${socketUnit}.socket`, disabled: true } : null, warnings, shadowed: sshdShadowed(current, effective, sshdSourcesBefore().sources) };
  },
});

// ---------------------------------------------------------- root SSH keys ---

const SSH_DIR = '/root/.ssh';
const AUTHORIZED_KEYS = `${SSH_DIR}/authorized_keys`;
const KEY_TYPE = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;
const keyName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/, 'Letters, digits, "_", "." or "-"');
const publicKeyLine = z.string().max(16 * 1024).regex(/^\S+( \S+)* (ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-\S+) [A-Za-z0-9+/]+=* ?[^\n\r\0]{0,256}$|^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-\S+) [A-Za-z0-9+/]+=* ?[^\n\r\0]{0,256}$/, 'Must be a single OpenSSH public key line');
const fingerprintArg = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);

export function fingerprintOf(blobBase64) {
  return `SHA256:${crypto.createHash('sha256').update(Buffer.from(blobBase64, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

export function parsePublicKeyLine(line) {
  const tokens = line.trim().split(/\s+/);
  const i = tokens.findIndex((t) => KEY_TYPE.test(t));
  if (i < 0 || !tokens[i + 1]) return null;
  const blob = tokens[i + 1];
  if (!/^[A-Za-z0-9+/]+=*$/.test(blob)) return null;
  return { options: tokens.slice(0, i).join(' ') || null, type: tokens[i], blob, comment: tokens.slice(i + 2).join(' ') || null, fingerprint: fingerprintOf(blob) };
}

export function parseAuthorizedKeys(text) {
  const out = [];
  (text || '').split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const key = parsePublicKeyLine(line);
    if (key) out.push({ index, ...key, line });
  });
  return out;
}

function ensureSshDir() {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SSH_DIR, 0o700);
}

function appendAuthorized(line) {
  ensureSshDir();
  const key = parsePublicKeyLine(line);
  if (!key) throw new OpError('invalid_args', 'Not a valid OpenSSH public key');
  const current = readText(AUTHORIZED_KEYS) || '';
  if (parseAuthorizedKeys(current).some((k) => k.fingerprint === key.fingerprint)) throw new OpError('exists', `A key with fingerprint ${key.fingerprint} is already authorized`);
  const next = `${current.endsWith('\n') || current === '' ? current : `${current}\n`}${line.trim()}\n`;
  writeAtomic(AUTHORIZED_KEYS, next, 0o600);
  return key;
}

// Root-only helper that answers ssh-keygen's passphrase prompts from the
// environment (both "Enter passphrase" and "Enter same passphrase again"). It
// lives in a fresh 0700 directory under root's own ~/.ssh, never under /tmp.
function writeAskpassHelper() {
  ensureSshDir();
  const dir = privateTempDir(SSH_DIR, '.whm-askpass-');
  const helper = path.join(dir, 'askpass.sh');
  fs.writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' "$WHM_SSH_PASSPHRASE"\n', { mode: 0o700 });
  fs.chmodSync(helper, 0o700);
  return { helper, dir };
}

function listKeyPairs() {
  ensureSshDir();
  const authorized = new Set(parseAuthorizedKeys(readText(AUTHORIZED_KEYS)).map((k) => k.fingerprint));
  const pairs = [];
  for (const file of fs.readdirSync(SSH_DIR)) {
    if (!file.endsWith('.pub')) continue;
    const name = file.slice(0, -4);
    const key = parsePublicKeyLine(readText(path.join(SSH_DIR, file)) || '');
    if (!key) continue;
    let mtime = null;
    try { mtime = fs.statSync(path.join(SSH_DIR, file)).mtime.toISOString(); } catch { /* vanished */ }
    pairs.push({ name, type: key.type, fingerprint: key.fingerprint, comment: key.comment, publicKey: `${key.type} ${key.blob}${key.comment ? ` ${key.comment}` : ''}`, hasPrivateKey: exists(path.join(SSH_DIR, name)), authorized: authorized.has(key.fingerprint), createdAt: mtime });
  }
  return pairs.sort((a, b) => a.name.localeCompare(b.name));
}

defineOp('sec.ssh_keys.list', {
  description: "root's key pairs under /root/.ssh and the keys in authorized_keys",
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(SSH_DIR, 'read');
    return { dir: SSH_DIR, keys: listKeyPairs(), authorized: parseAuthorizedKeys(readText(AUTHORIZED_KEYS)).map(({ line, ...k }) => k), keygenAvailable: hasBinary('ssh-keygen') };
  },
});

defineOp('sec.ssh_keys.add', {
  description: "Authorize a public key for root (append to /root/.ssh/authorized_keys)",
  schema: z.object({ publicKey: publicKeyLine }).strict(),
  run: async ({ publicKey }, ctx) => {
    ctx.assertAllowedPath(AUTHORIZED_KEYS, 'write');
    const key = appendAuthorized(publicKey);
    return { fingerprint: key.fingerprint, type: key.type, comment: key.comment };
  },
});

defineOp('sec.ssh_keys.remove', {
  description: 'De-authorize a key by fingerprint (remove from authorized_keys)',
  destructive: true,
  schema: z.object({ fingerprint: fingerprintArg }).strict(),
  run: async ({ fingerprint }, ctx) => {
    ctx.assertAllowedPath(AUTHORIZED_KEYS, 'write');
    const current = readText(AUTHORIZED_KEYS);
    if (current == null) return { fingerprint, removed: 0 };
    const drop = new Set(parseAuthorizedKeys(current).filter((k) => k.fingerprint === fingerprint).map((k) => k.index));
    if (!drop.size) return { fingerprint, removed: 0 };
    writeAtomic(AUTHORIZED_KEYS, `${current.split('\n').filter((_l, i) => !drop.has(i)).join('\n').replace(/\n*$/, '')}\n`, 0o600);
    return { fingerprint, removed: drop.size };
  },
});

defineOp('sec.ssh_keys.generate', {
  description: 'Generate a key pair for root with ssh-keygen',
  schema: z.object({
    name: keyName,
    type: z.enum(['ed25519', 'rsa', 'ecdsa']).default('ed25519'),
    bits: z.number().int().refine((b) => [256, 384, 521, 2048, 3072, 4096].includes(b)).optional(),
    comment: z.string().regex(/^[^\n\r\0]{0,128}$/).optional(),
    passphrase: z.string().regex(/^[^\n\r\0]{0,256}$/).default(''),
    authorize: z.boolean().default(false),
  }).strict(),
  run: async ({ name, type, bits, comment, passphrase, authorize }, ctx) => {
    ctx.assertAllowedPath(SSH_DIR, 'write');
    if (!hasBinary('ssh-keygen')) throw new OpError('capability_missing', 'ssh-keygen is not installed (openssh-client package)');
    if (type === 'rsa' && bits && bits < 2048) throw new OpError('invalid_args', 'RSA keys must be at least 2048 bits');
    if (type === 'ecdsa' && bits && ![256, 384, 521].includes(bits)) throw new OpError('invalid_args', 'ECDSA keys must be 256, 384 or 521 bits');
    ensureSshDir();
    const file = path.join(SSH_DIR, name);
    if (exists(file) || exists(`${file}.pub`)) throw new OpError('exists', `A key named "${name}" already exists`);
    const argv = ['-q', '-t', type, '-f', file, '-C', comment ?? `root@whm-${name}`];
    if (bits && type !== 'ed25519') argv.push('-b', String(bits));
    // The passphrase must never appear in argv (/proc/<pid>/cmdline is world
    // readable); an empty one is the documented "-N ''" and carries no secret.
    // A non-empty passphrase reaches ssh-keygen through SSH_ASKPASS: the helper
    // echoes an environment variable, and /proc/<pid>/environ is owner-only.
    if (!passphrase) argv.push('-N', '');
    const askpass = passphrase ? writeAskpassHelper() : null;
    try {
      await exec('ssh-keygen', argv, { timeoutMs: 120_000, env: askpass ? { SSH_ASKPASS: askpass.helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', WHM_SSH_PASSPHRASE: passphrase } : undefined });
    } catch (err) {
      for (const f of [file, `${file}.pub`]) { try { fs.unlinkSync(f); } catch { /* not created */ } }
      throw new OpError(err.code === 'binary_not_found' ? 'capability_missing' : 'command_failed', `ssh-keygen failed: ${String(err.details?.stderr || err.message).trim().split('\n').pop()}`, { bin: 'ssh-keygen' });
    } finally {
      if (askpass) fs.rmSync(askpass.dir, { recursive: true, force: true });
    }
    const key = parsePublicKeyLine(readText(`${file}.pub`) || '');
    if (authorize) appendAuthorized(readText(`${file}.pub`));
    return { name, type: key?.type, fingerprint: key?.fingerprint, publicKey: (readText(`${file}.pub`) || '').trim(), privateKeyPath: file, authorized: authorize, encrypted: passphrase.length > 0 };
  },
});

defineOp('sec.ssh_keys.authorize', {
  description: "Authorize one of root's own key pairs by name",
  schema: z.object({ name: keyName }).strict(),
  run: async ({ name }, ctx) => {
    ctx.assertAllowedPath(AUTHORIZED_KEYS, 'write');
    const pub = readText(path.join(SSH_DIR, `${name}.pub`));
    if (pub == null) throw new OpError('not_found', `No public key named "${name}.pub" in ${SSH_DIR}`);
    const key = appendAuthorized(pub);
    return { name, fingerprint: key.fingerprint };
  },
});

defineOp('sec.ssh_keys.delete_pair', {
  description: 'Delete a key pair (private + public file), optionally de-authorizing it',
  destructive: true,
  schema: z.object({ name: keyName, deauthorize: z.boolean().default(true) }).strict(),
  run: async ({ name, deauthorize }, ctx) => {
    ctx.assertAllowedPath(SSH_DIR, 'write');
    const pub = readText(path.join(SSH_DIR, `${name}.pub`));
    const key = pub ? parsePublicKeyLine(pub) : null;
    let removed = 0;
    for (const f of [path.join(SSH_DIR, name), path.join(SSH_DIR, `${name}.pub`)]) {
      try { fs.unlinkSync(f); removed++; } catch { /* missing */ }
    }
    if (!removed) throw new OpError('not_found', `No key named "${name}"`);
    let deauthorized = 0;
    if (deauthorize && key) {
      const current = readText(AUTHORIZED_KEYS);
      if (current) {
        const drop = new Set(parseAuthorizedKeys(current).filter((k) => k.fingerprint === key.fingerprint).map((k) => k.index));
        if (drop.size) { writeAtomic(AUTHORIZED_KEYS, `${current.split('\n').filter((_l, i) => !drop.has(i)).join('\n').replace(/\n*$/, '')}\n`, 0o600); deauthorized = drop.size; }
      }
    }
    return { name, removedFiles: removed, deauthorized };
  },
});

defineOp('sec.ssh_keys.export', {
  description: "Read one of root's private keys (for download; audited by the panel)",
  schema: z.object({ name: keyName }).strict(),
  run: async ({ name }, ctx) => {
    ctx.assertAllowedPath(SSH_DIR, 'read');
    const privateKey = readText(path.join(SSH_DIR, name));
    if (privateKey == null) throw new OpError('not_found', `No private key named "${name}"`);
    return { name, privateKey, publicKey: (readText(path.join(SSH_DIR, `${name}.pub`)) || '').trim() };
  },
});

// -------------------------------------------- compiler / traceroute access ---

const COMPILERS = ['/usr/bin/gcc', '/usr/bin/cc', '/usr/bin/g++', '/usr/bin/c++', '/usr/bin/cpp', '/usr/bin/clang', '/usr/bin/clang++', '/usr/bin/x86_64-linux-gnu-gcc', '/usr/bin/x86_64-linux-gnu-g++', '/usr/bin/aarch64-linux-gnu-gcc', '/usr/bin/tcc'];
const TRACEROUTE = ['/usr/bin/traceroute', '/usr/sbin/traceroute', '/bin/traceroute', '/usr/bin/traceroute6', '/usr/sbin/traceroute6', '/usr/bin/tracepath', '/usr/bin/tracepath6', '/usr/bin/tcptraceroute', '/usr/sbin/tcptraceroute', '/usr/bin/mtr', '/usr/sbin/mtr', '/usr/bin/lft'];

function versionedCompilers() {
  const out = [];
  try {
    for (const f of fs.readdirSync('/usr/bin')) if (/^(gcc|g\+\+|clang|clang\+\+|cc)-\d+(\.\d+)*$/.test(f)) out.push(`/usr/bin/${f}`);
  } catch { /* no /usr/bin */ }
  return out;
}

// A binary is "available to everyone" when its real file has the other-execute
// bit. Symlinks (cc -> /etc/alternatives/cc -> gcc) resolve to one target that is
// changed once.
function binaryAccess(candidates) {
  const seen = new Map();
  for (const p of candidates) {
    let real;
    try { real = fs.realpathSync(p); } catch { continue; }
    let st;
    try { st = fs.statSync(real); } catch { continue; }
    if (!st.isFile()) continue;
    const entry = seen.get(real) || { realPath: real, paths: [], mode: (st.mode & 0o7777).toString(8).padStart(4, '0'), specialBits: st.mode & 0o7000, othersCanExecute: Boolean(st.mode & 0o001) };
    entry.paths.push(p);
    seen.set(real, entry);
  }
  const binaries = [...seen.values()];
  return { installed: binaries.length > 0, allowed: binaries.length > 0 && binaries.every((b) => b.othersCanExecute), binaries };
}

// Only the rwx bits change: setuid/setgid bits shipped by the distribution
// (traceroute, mtr-packet) stay, or the tool breaks for everyone once re-enabled.
export function accessMode(currentMode, allow) {
  return (currentMode & 0o7000) | (allow ? 0o755 : 0o750);
}

function setBinaryAccess(candidates, allow) {
  const state = binaryAccess(candidates);
  for (const b of state.binaries) fs.chmodSync(b.realPath, accessMode(b.specialBits, allow));
  return binaryAccess(candidates);
}

defineOp('sec.compiler_access.get', { description: 'Whether unprivileged users can execute the C/C++ compilers', run: async () => binaryAccess([...COMPILERS, ...versionedCompilers()]) });
defineOp('sec.compiler_access.set', {
  description: 'Allow (0755) or deny (0750) compiler binaries to unprivileged users',
  schema: z.object({ allow: z.boolean() }).strict(),
  run: async ({ allow }) => setBinaryAccess([...COMPILERS, ...versionedCompilers()], allow),
});
defineOp('sec.traceroute.get', { description: 'Whether unprivileged users can execute traceroute tools', run: async () => binaryAccess(TRACEROUTE) });
defineOp('sec.traceroute.set', {
  description: 'Allow (0755) or deny (0750) traceroute binaries to unprivileged users',
  schema: z.object({ enabled: z.boolean() }).strict(),
  run: async ({ enabled }) => setBinaryAccess(TRACEROUTE, enabled),
});

// ---------------------------------------------------- fork bomb protection ---

const FORKBOMB_CONF = '/etc/security/limits.d/whm-forkbomb.conf';
const FORKBOMB_DEFAULTS = { maxProcesses: 35, maxOpenFiles: 1024, excludeGroups: ['wheel', 'sudo'] };
// pam_limits applies a hard "as" (RLIMIT_AS) to every account shell and cron
// job; Node.js, Java and Go reserve more address space than a few hundred MB at
// startup and abort under it (WHM's own limits.sh sets -v unlimited). The memory
// cap is therefore opt-in and never below a size those runtimes start under.
export const FORKBOMB_MEMORY_FLOOR_MB = 4096;

export function renderForkBombConf({ maxProcesses, maxOpenFiles, maxMemoryMb = null, excludeGroups }) {
  const lines = [`${MANAGED} (Shell Fork Bomb Protection). Limits apply to PAM login sessions; root and the groups below are exempt.`];
  const limits = [['nproc', maxProcesses], ['nofile', maxOpenFiles]];
  if (maxMemoryMb != null) limits.push(['as', maxMemoryMb * 1024]);
  for (const [item, value] of limits) lines.push(`*          hard    ${item.padEnd(9)} ${value}`);
  for (const who of ['root', ...excludeGroups.map((g) => `@${g}`)]) for (const [item] of limits) lines.push(`${who.padEnd(10)} hard    ${item.padEnd(9)} unlimited`);
  return `${lines.join('\n')}\n`;
}

// maxMemoryMb is only present when the file carries an "as" line, so a page
// that echoes the state back enables protection without a memory cap.
export function parseForkBombConf(text) {
  if (text == null) return { enabled: false, ...FORKBOMB_DEFAULTS };
  const out = { enabled: true, ...FORKBOMB_DEFAULTS, excludeGroups: [] };
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+hard\s+(nproc|nofile|as)\s+(\S+)$/);
    if (!m) continue;
    if (m[1] === '*') {
      if (m[2] === 'nproc') out.maxProcesses = Number(m[3]);
      if (m[2] === 'nofile') out.maxOpenFiles = Number(m[3]);
      if (m[2] === 'as') out.maxMemoryMb = Math.round(Number(m[3]) / 1024);
    } else if (m[1].startsWith('@') && !out.excludeGroups.includes(m[1].slice(1))) out.excludeGroups.push(m[1].slice(1));
  }
  return out;
}

defineOp('sec.fork_bomb.get', {
  description: 'Current shell fork bomb protection limits',
  run: async () => {
    const state = parseForkBombConf(readText(FORKBOMB_CONF));
    const warnings = state.maxMemoryMb != null && state.maxMemoryMb < FORKBOMB_MEMORY_FLOOR_MB ? [`The current file caps virtual memory at ${state.maxMemoryMb} MB, which makes Node.js, Java and Go abort at startup in every account shell and cron job; raise the memory limit to at least ${FORKBOMB_MEMORY_FLOOR_MB} MB, or disable and re-enable the protection to drop the cap`] : [];
    return { path: FORKBOMB_CONF, supported: exists('/etc/security/limits.d') || exists('/etc/security/limits.conf'), memoryFloorMb: FORKBOMB_MEMORY_FLOOR_MB, ...state, warnings };
  },
});

defineOp('sec.fork_bomb.set', {
  description: 'Enable or disable per-user process/file limits via /etc/security/limits.d (virtual-memory cap optional, never below the runtime floor)',
  schema: z.object({
    enabled: z.boolean(),
    maxProcesses: z.number().int().min(1).max(1_000_000).default(FORKBOMB_DEFAULTS.maxProcesses),
    maxOpenFiles: z.number().int().min(16).max(10_000_000).default(FORKBOMB_DEFAULTS.maxOpenFiles),
    maxMemoryMb: z.number().int().min(FORKBOMB_MEMORY_FLOOR_MB, `A virtual-memory cap below ${FORKBOMB_MEMORY_FLOOR_MB} MB aborts Node.js, Java and Go at startup in every account shell and cron job; leave it empty to apply no memory limit`).max(16_000_000).nullable().optional(),
    excludeGroups: z.array(groupName).max(20).default(FORKBOMB_DEFAULTS.excludeGroups),
  }).strict(),
  run: async ({ enabled, ...limits }, ctx) => {
    ctx.assertAllowedPath(FORKBOMB_CONF, 'write');
    if (!enabled) {
      try { fs.unlinkSync(FORKBOMB_CONF); } catch { /* already disabled */ }
      return { path: FORKBOMB_CONF, enabled: false };
    }
    const applied = { ...limits, maxMemoryMb: limits.maxMemoryMb ?? null };
    writeAtomic(FORKBOMB_CONF, renderForkBombConf(applied));
    return { path: FORKBOMB_CONF, enabled: true, ...applied };
  },
});

// ---------------------------------------------------------------- firewall ---

const BLOCK_CHAIN = 'WHM_BLOCK';
const SMTP_CHAIN = 'WHM_SMTP';
const NFT_TABLE = ['inet', 'whm'];

export function firewallBackend() {
  if (hasBinary('iptables')) return 'iptables';
  if (hasBinary('nft')) return 'nft';
  return null;
}

function requireFirewall() {
  const backend = firewallBackend();
  if (!backend) throw new OpError('capability_missing', 'Neither iptables nor nftables (nft) is installed; the panel firewall needs one of them');
  return backend;
}

const ipt = (ip) => (net.isIP(ip.split('/')[0]) === 6 ? 'ip6tables' : 'iptables');

async function iptablesEnsureChain(bin, chain, hook, extra = []) {
  await exec(bin, ['-N', chain], { allowFailure: true });
  const { code } = await exec(bin, ['-C', hook, ...extra, '-j', chain], { allowFailure: true });
  if (code !== 0) await exec(bin, ['-I', hook, '1', ...extra, '-j', chain]);
}

async function nftEnsureTable() {
  await exec('nft', ['add', 'table', ...NFT_TABLE]);
}

export function parseIptablesRules(stdout, chain) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(new RegExp(`^-A ${chain} -s (\\S+) -j DROP`));
    if (m) out.push({ ip: m[1].replace(/\/32$|\/128$/, '') });
  }
  return out;
}

export function parseNftChain(json, chain) {
  const out = [];
  try {
    for (const item of JSON.parse(json).nftables || []) {
      const rule = item.rule;
      if (!rule || rule.chain !== chain) continue;
      for (const e of rule.expr || []) {
        const m = e.match;
        const field = m?.left?.payload?.field;
        if (m && field === 'saddr') out.push({ ip: typeof m.right === 'string' ? m.right : m.right?.prefix ? `${m.right.prefix.addr}/${m.right.prefix.len}` : String(m.right), handle: rule.handle });
      }
    }
  } catch { /* unparseable */ }
  return out;
}

async function listBlocked(backend) {
  if (backend === 'iptables') {
    const entries = [];
    for (const bin of ['iptables', 'ip6tables']) {
      if (!hasBinary(bin)) continue;
      const { code, stdout } = await exec(bin, ['-S', BLOCK_CHAIN], { allowFailure: true });
      if (code === 0) entries.push(...parseIptablesRules(stdout, BLOCK_CHAIN));
    }
    return entries;
  }
  const { code, stdout } = await exec('nft', ['-j', 'list', 'chain', ...NFT_TABLE, 'block'], { allowFailure: true });
  return code === 0 ? parseNftChain(stdout, 'block') : [];
}

defineOp('sec.firewall.detect', {
  description: 'Which firewall backend the panel will use and whether its chains exist',
  run: async () => {
    const backend = firewallBackend();
    let chainExists = false;
    if (backend === 'iptables') chainExists = (await exec('iptables', ['-S', BLOCK_CHAIN], { allowFailure: true })).code === 0;
    else if (backend === 'nft') chainExists = (await exec('nft', ['list', 'chain', ...NFT_TABLE, 'block'], { allowFailure: true })).code === 0;
    return { backend, available: { iptables: hasBinary('iptables'), ip6tables: hasBinary('ip6tables'), nft: hasBinary('nft'), ufw: hasBinary('ufw'), firewalld: hasBinary('firewall-cmd') }, blockChain: BLOCK_CHAIN, chainExists };
  },
});

defineOp('sec.firewall.list', {
  description: `Addresses currently dropped by the ${BLOCK_CHAIN} chain`,
  run: async () => { const backend = requireFirewall(); return { backend, entries: await listBlocked(backend) }; },
});

defineOp('sec.firewall.block', {
  description: `Drop all traffic from an address (adds it to ${BLOCK_CHAIN})`,
  schema: z.object({ ip: ipOrCidr }).strict(),
  run: async ({ ip }) => {
    const backend = requireFirewall();
    if (backend === 'iptables') {
      const bin = ipt(ip);
      if (!hasBinary(bin)) throw new OpError('capability_missing', `${bin} is not installed`);
      await iptablesEnsureChain(bin, BLOCK_CHAIN, 'INPUT');
      const { code } = await exec(bin, ['-C', BLOCK_CHAIN, '-s', ip, '-j', 'DROP'], { allowFailure: true });
      if (code !== 0) await exec(bin, ['-A', BLOCK_CHAIN, '-s', ip, '-j', 'DROP']);
      return { backend, ip, added: code !== 0 };
    }
    await nftEnsureTable();
    await exec('nft', ['add', 'chain', ...NFT_TABLE, 'block', '{ type filter hook input priority -10 ; policy accept ; }']);
    const present = (await listBlocked(backend)).some((e) => e.ip === ip);
    if (!present) await exec('nft', ['add', 'rule', ...NFT_TABLE, 'block', net.isIP(ip.split('/')[0]) === 6 ? 'ip6' : 'ip', 'saddr', ip, 'drop']);
    return { backend, ip, added: !present };
  },
});

defineOp('sec.firewall.unblock', {
  description: `Remove an address from ${BLOCK_CHAIN}`,
  destructive: true,
  schema: z.object({ ip: ipOrCidr }).strict(),
  run: async ({ ip }) => {
    const backend = requireFirewall();
    if (backend === 'iptables') {
      const bin = ipt(ip);
      if (!hasBinary(bin)) return { backend, ip, removed: false };
      let removed = 0;
      for (let i = 0; i < 10; i++) {
        const { code } = await exec(bin, ['-D', BLOCK_CHAIN, '-s', ip, '-j', 'DROP'], { allowFailure: true });
        if (code !== 0) break;
        removed++;
      }
      return { backend, ip, removed: removed > 0 };
    }
    const handles = (await listBlocked(backend)).filter((e) => e.ip === ip && e.handle != null).map((e) => e.handle);
    for (const h of handles) await exec('nft', ['delete', 'rule', ...NFT_TABLE, 'block', 'handle', String(h)]);
    return { backend, ip, removed: handles.length > 0 };
  },
});

defineOp('sec.firewall.flush', {
  description: `Remove every address from ${BLOCK_CHAIN}`,
  destructive: true,
  run: async () => {
    const backend = requireFirewall();
    if (backend === 'iptables') {
      for (const bin of ['iptables', 'ip6tables']) if (hasBinary(bin)) await exec(bin, ['-F', BLOCK_CHAIN], { allowFailure: true });
    } else {
      await exec('nft', ['flush', 'chain', ...NFT_TABLE, 'block'], { allowFailure: true });
    }
    return { backend, flushed: true };
  },
});

// --------------------------------------------------------- SMTP restriction ---

const MAIL_GROUPS = ['mail', 'exim', 'Debian-exim', 'mailnull', 'postfix', 'mailman'];

// The iptables backend needs one chain per address family; ip6tables may be
// absent, in which case IPv6 is reported as unprotected rather than assumed.
const SMTP_FAMILIES = { ipv4: 'iptables', ipv6: 'ip6tables' };

async function smtpFamilies(backend) {
  if (backend === 'iptables') {
    const families = {};
    for (const [family, bin] of Object.entries(SMTP_FAMILIES)) families[family] = hasBinary(bin) ? (await exec(bin, ['-C', 'OUTPUT', '-p', 'tcp', '--dport', '25', '-j', SMTP_CHAIN], { allowFailure: true })).code === 0 : null;
    return families;
  }
  const on = (await exec('nft', ['list', 'chain', ...NFT_TABLE, 'smtp'], { allowFailure: true })).code === 0;
  return { ipv4: on, ipv6: on };
}

const smtpSummary = (families) => ({ families, enabled: Object.values(families).some((v) => v === true) && Object.values(families).every((v) => v !== false), unprotected: Object.entries(families).filter(([, v]) => v !== true).map(([f]) => f) });

defineOp('sec.smtp_restrict.get', {
  description: 'Whether outbound port 25 is restricted to root and the mail groups (per address family)',
  run: async () => {
    const backend = firewallBackend();
    const groups = MAIL_GROUPS.map(groupEntry).filter(Boolean);
    const families = backend ? await smtpFamilies(backend) : { ipv4: false, ipv6: false };
    return { backend, ...smtpSummary(families), groups: groups.map((g) => g.name) };
  },
});

async function iptablesSmtpTeardown(bin) {
  for (let i = 0; i < 5; i++) if ((await exec(bin, ['-D', 'OUTPUT', '-p', 'tcp', '--dport', '25', '-j', SMTP_CHAIN], { allowFailure: true })).code !== 0) break;
  await exec(bin, ['-F', SMTP_CHAIN], { allowFailure: true });
  await exec(bin, ['-X', SMTP_CHAIN], { allowFailure: true });
}

async function iptablesSmtpApply(bin, groups) {
  await iptablesEnsureChain(bin, SMTP_CHAIN, 'OUTPUT', ['-p', 'tcp', '--dport', '25']);
  await exec(bin, ['-F', SMTP_CHAIN]);
  await exec(bin, ['-A', SMTP_CHAIN, '-o', 'lo', '-j', 'ACCEPT']);
  await exec(bin, ['-A', SMTP_CHAIN, '-m', 'owner', '--uid-owner', '0', '-j', 'ACCEPT']);
  for (const g of groups) await exec(bin, ['-A', SMTP_CHAIN, '-m', 'owner', '--gid-owner', String(g.gid), '-j', 'ACCEPT']);
  // iptables-nft refuses "--reject-with tcp-reset" unless the rule itself
  // matches tcp (RULE_APPEND failed: Invalid argument), even inside a chain
  // that is only reached for tcp/25.
  await exec(bin, ['-A', SMTP_CHAIN, '-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset']);
}

defineOp('sec.smtp_restrict.set', {
  description: 'Enable or disable the outbound SMTP restriction (owner-match firewall rules on port 25, IPv4 and IPv6)',
  schema: z.object({ enabled: z.boolean() }).strict(),
  run: async ({ enabled }) => {
    const backend = requireFirewall();
    const groups = MAIL_GROUPS.map(groupEntry).filter(Boolean);
    if (backend === 'iptables') {
      const bins = Object.values(SMTP_FAMILIES).filter(hasBinary);
      if (!enabled) {
        for (const bin of bins) await iptablesSmtpTeardown(bin);
        return { backend, ...smtpSummary(await smtpFamilies(backend)) };
      }
      for (const bin of bins) await iptablesSmtpApply(bin, groups);
      return { backend, ...smtpSummary(await smtpFamilies(backend)), groups: groups.map((g) => g.name) };
    }
    if (!enabled) {
      await exec('nft', ['delete', 'chain', ...NFT_TABLE, 'smtp'], { allowFailure: true });
      return { backend, ...smtpSummary({ ipv4: false, ipv6: false }) };
    }
    await nftEnsureTable();
    await exec('nft', ['add', 'chain', ...NFT_TABLE, 'smtp', '{ type filter hook output priority 0 ; policy accept ; }']);
    await exec('nft', ['flush', 'chain', ...NFT_TABLE, 'smtp']);
    await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'oifname', 'lo', 'accept']);
    await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'tcp', 'dport', '25', 'meta', 'skuid', '0', 'accept']);
    for (const g of groups) await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'tcp', 'dport', '25', 'meta', 'skgid', String(g.gid), 'accept']);
    await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'tcp', 'dport', '25', 'reject', 'with', 'tcp', 'reset']);
    return { backend, ...smtpSummary({ ipv4: true, ipv6: true }), groups: groups.map((g) => g.name) };
  },
});

// ------------------------------------------------------------- ModSecurity ---

const MODSEC_DIRECTIVES = {
  SecRuleEngine: z.enum(['On', 'Off', 'DetectionOnly']),
  SecAuditEngine: z.enum(['On', 'Off', 'RelevantOnly']),
  SecRequestBodyAccess: z.enum(['On', 'Off']),
  SecResponseBodyAccess: z.enum(['On', 'Off']),
  SecRequestBodyLimit: z.number().int().min(1024).max(2_147_483_647),
  SecRequestBodyNoFilesLimit: z.number().int().min(1024).max(2_147_483_647),
  SecRequestBodyLimitAction: z.enum(['Reject', 'ProcessPartial']),
  SecResponseBodyLimit: z.number().int().min(1024).max(2_147_483_647),
  SecAuditLogRelevantStatus: z.string().regex(/^[\^$()|\[\]\d\-.?+*]{1,64}$/),
  SecAuditLogParts: z.string().regex(/^[A-KZ]{1,12}$/),
  SecPcreMatchLimit: z.number().int().min(1000).max(100_000_000),
  SecPcreMatchLimitRecursion: z.number().int().min(1000).max(100_000_000),
  SecConnEngine: z.enum(['On', 'Off', 'DetectionOnly']),
};
const modsecDirectives = z.object(Object.fromEntries(Object.entries(MODSEC_DIRECTIVES).map(([k, s]) => [k, s.nullable().optional()]))).strict();
const vendorName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Lowercase letters, digits, "_" or "-"');

// Debian's security2.conf loads /usr/share/modsecurity-crs/*.load (the packaged
// OWASP CRS) by default; a CRS vendor installed on top would define the same rule
// ids twice and fail `apachectl -t`.
export function parseDistroCrsInclude(text) {
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^Include(?:Optional)?\s+"?([^"\s]*modsecurity-crs[^"\s]*)"?/i);
    if (m) return { active: true, directive: line, path: m[1] };
  }
  return { active: false, directive: null, path: null };
}

export function distroCrsInclude(apache) {
  if (!apache) return { active: false, directive: null, path: null, file: null };
  const file = apache.flavor === 'debian' ? `${apache.modsEnabled}/security2.conf` : [`${apache.includeDir}/mod_security.conf`, `${apache.includeDir}/mod_security_crs.conf`].find(exists) || null;
  return { ...parseDistroCrsInclude(file ? readText(file) : null), file };
}

export function modsecLayout() {
  const apache = apacheFlavor();
  let base = null;
  if (exists('/etc/modsecurity') || exists('/etc/apache2/mods-available/security2.load')) base = { flavor: 'debian', baseDir: '/etc/modsecurity', mainConf: exists('/etc/modsecurity/modsecurity.conf') ? '/etc/modsecurity/modsecurity.conf' : null, recommended: exists('/etc/modsecurity/modsecurity.conf-recommended') ? '/etc/modsecurity/modsecurity.conf-recommended' : null, crsDirs: ['/usr/share/modsecurity-crs/rules', '/etc/modsecurity/crs', '/usr/share/modsecurity-crs'] };
  else if (exists('/etc/httpd/conf.d/mod_security.conf') || exists('/etc/httpd/modsecurity.d')) base = { flavor: 'rhel', baseDir: '/etc/httpd/modsecurity.d', mainConf: exists('/etc/httpd/conf.d/mod_security.conf') ? '/etc/httpd/conf.d/mod_security.conf' : null, recommended: null, crsDirs: ['/etc/httpd/modsecurity.d/activated_rules', '/usr/share/mod_modsecurity_crs/rules', '/etc/httpd/modsecurity.d/crs/rules'] };
  const includeDir = apache?.includeDir || null;
  return {
    installed: Boolean(base && apache),
    apache,
    distroCrs: distroCrsInclude(apache),
    ...(base || { flavor: null, baseDir: null, mainConf: null, recommended: null, crsDirs: [] }),
    configConf: includeDir ? `${includeDir}/zz-whm-modsec-10-config.conf` : null,
    vendorsConf: includeDir ? `${includeDir}/zz-whm-modsec-20-vendors.conf` : null,
    disabledConf: includeDir ? `${includeDir}/zz-whm-modsec-90-disabled.conf` : null,
    vendorsDir: base ? `${base.baseDir}/whm-vendors` : null,
    auditLog: apache ? [`${apache.logDir}/modsec_audit.log`, '/var/log/modsec_audit.log'].find(exists) || `${apache.logDir}/modsec_audit.log` : null,
    errorLog: apache?.errorLog || null,
  };
}

function requireModsec() {
  const layout = modsecLayout();
  if (!layout.installed) throw new OpError('capability_missing', 'ModSecurity is not installed (no /etc/modsecurity or mod_security.conf found alongside Apache)');
  return layout;
}

export function parseModsecDirectives(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(Sec[A-Za-z]+)\s+"?([^"\s]+)"?$/);
    if (m && m[1] in MODSEC_DIRECTIVES) out[m[1]] = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  return out;
}

function renderModsecConfig(directives) {
  const lines = [`${MANAGED} (ModSecurity Configuration). Overrides the distribution defaults; loaded after modsecurity.conf.`, '<IfModule security2_module>'];
  for (const [k, v] of Object.entries(directives)) if (v != null) lines.push(`  ${k} ${typeof v === 'string' && /[|\[\]()]/.test(v) ? `"${v}"` : v}`);
  lines.push('</IfModule>');
  return `${lines.join('\n')}\n`;
}

defineOp('sec.modsec.detect', { description: 'Where ModSecurity lives on this host and whether Apache has it loaded', run: async () => {
  const layout = modsecLayout();
  let moduleLoaded = null;
  if (layout.apache?.bin) {
    const { code, stdout } = await exec(layout.apache.bin, ['-M'], { allowFailure: true, timeoutMs: 30_000 });
    moduleLoaded = code === 0 ? /security[23]_module/.test(stdout) : null;
  }
  return { ...layout, apache: layout.apache ? { flavor: layout.apache.flavor, bin: layout.apache.bin, includeDir: layout.apache.includeDir } : null, moduleLoaded };
} });

defineOp('sec.modsec.get_config', {
  description: 'Effective ModSecurity engine directives (distribution file + panel overrides)',
  run: async () => {
    const layout = requireModsec();
    const base = parseModsecDirectives(readText(layout.mainConf));
    const managed = parseModsecDirectives(readText(layout.configConf));
    return { base, managed, effective: { ...base, ...managed }, mainConf: layout.mainConf, managedPath: layout.configConf, recommended: layout.recommended };
  },
});

defineOp('sec.modsec.set_config', {
  description: 'Write ModSecurity engine directives to the panel include, validate Apache config and roll back on error',
  schema: z.object({ directives: modsecDirectives }).strict(),
  run: async ({ directives }, ctx) => {
    const layout = requireModsec();
    const apache = requireApache();
    ctx.assertAllowedPath(layout.configConf, 'write');
    const current = parseModsecDirectives(readText(layout.configConf));
    for (const [k, v] of Object.entries(directives)) {
      if (v === undefined) continue;
      if (v === null) delete current[k]; else current[k] = v;
    }
    await writeApacheInclude(apache, layout.configConf, renderModsecConfig(current));
    return { path: layout.configConf, directives: current, unit: apache.units[0] };
  },
});

export function parseModsecRules(text, file) {
  const joined = (text || '').replace(/\\\r?\n/g, ' ');
  const rules = [];
  for (const raw of joined.split('\n')) {
    const line = raw.trim();
    if (!/^Sec(Rule|Action)\b/.test(line)) continue;
    const id = line.match(/\bid:'?(\d+)'?/)?.[1];
    if (!id) continue;
    rules.push({ id: Number(id), file, msg: line.match(/\bmsg:'([^']*)'/)?.[1] || line.match(/\bmsg:([^,"']+)/)?.[1] || null, severity: line.match(/\bseverity:'?([A-Z0-9]+)'?/i)?.[1] || null, phase: Number(line.match(/\bphase:(\d)/)?.[1]) || null, tag: line.match(/\btag:'([^']*)'/)?.[1] || null, action: line.startsWith('SecAction') ? 'action' : 'rule' });
  }
  return rules;
}

function ruleFiles(dirs, depth = 2) {
  const out = [];
  const walk = (dir, d) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && d > 0 && e.name !== 'whm-vendors') walk(p, d - 1);
      else if (e.isFile() && e.name.endsWith('.conf')) out.push(p);
    }
  };
  for (const dir of dirs) walk(dir, depth);
  return [...new Set(out)].sort();
}

defineOp('sec.modsec.list_rules', {
  description: 'Rule ids/messages across the distribution, CRS and vendor rule files',
  schema: z.object({ limit: z.number().int().min(1).max(20000).default(5000) }).strict(),
  run: async ({ limit }) => {
    const layout = requireModsec();
    const dirs = [layout.baseDir, ...layout.crsDirs, layout.vendorsDir].filter(exists);
    const vendorFiles = [];
    try {
      for (const v of fs.readdirSync(layout.vendorsDir)) vendorFiles.push(...ruleFiles([path.join(layout.vendorsDir, v)], 3).map((f) => ({ f, vendor: v })));
    } catch { /* no vendors */ }
    const files = [...ruleFiles(dirs).map((f) => ({ f, vendor: null })), ...vendorFiles];
    const rules = [];
    const summary = [];
    for (const { f, vendor } of files) {
      const parsed = parseModsecRules(readText(f), f).map((r) => ({ ...r, vendor }));
      summary.push({ file: f, vendor, rules: parsed.length });
      for (const r of parsed) { if (rules.length < limit) rules.push(r); }
    }
    return { files: summary, rules, truncated: summary.reduce((n, s) => n + s.rules, 0) > rules.length };
  },
});

defineOp('sec.modsec.set_disabled', {
  description: 'Write SecRuleRemoveById entries for disabled rule ids, validate and reload-safe',
  schema: z.object({ ids: z.array(z.number().int().min(1).max(999_999_999)).max(5000) }).strict(),
  run: async ({ ids }, ctx) => {
    const layout = requireModsec();
    const apache = requireApache();
    ctx.assertAllowedPath(layout.disabledConf, 'write');
    const lines = [`${MANAGED} (ModSecurity Tools). Rules disabled from the panel; loaded after all rule sets.`, '<IfModule security2_module>', ...ids.map((id) => `  SecRuleRemoveById ${id}`), '</IfModule>'];
    await writeApacheInclude(apache, layout.disabledConf, `${lines.join('\n')}\n`);
    return { path: layout.disabledConf, ids, unit: apache.units[0] };
  },
});

export function parseModsecErrorLog(text) {
  const hits = [];
  for (const line of (text || '').split('\n')) {
    if (!line.includes('ModSecurity:')) continue;
    const field = (name) => line.match(new RegExp(`\\[${name} "((?:[^"\\\\]|\\\\.)*)"\\]`))?.[1] ?? null;
    hits.push({
      ts: line.match(/^\[([^\]]+)\]/)?.[1] ?? null,
      client: line.match(/\[client ([^\]\s]+?)(?::\d+)?\]/)?.[1] ?? null,
      action: line.match(/ModSecurity: (Warning|Access denied[^.]*|[^.]+)\./)?.[1] ?? null,
      id: Number(field('id')) || null,
      msg: field('msg'),
      severity: field('severity'),
      uri: field('uri'),
      hostname: field('hostname'),
      file: field('file'),
      line: Number(field('line')) || null,
      uniqueId: field('unique_id'),
    });
  }
  return hits;
}

function tailText(file, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, maxBytes);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, Math.max(0, size - length));
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Apache's "[Wed Oct 25 10:00:00.123456 2026]" stamp as epoch milliseconds (0
// when unparseable), used only to interleave hits from several logs.
export function modsecHitTime(ts) {
  const m = String(ts || '').match(/^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{4})$/);
  if (!m || !(m[1].toLowerCase() in MONTHS)) return 0;
  return Date.UTC(Number(m[7]), MONTHS[m[1].toLowerCase()], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number((m[6] || '0').padEnd(3, '0').slice(0, 3)));
}

// ModSecurity 2 logs through ap_log_rerror, i.e. into the ErrorLog of the vhost
// that served the request, and every panel vhost has its own
// <domlogs>/<user>/<domain>[-ssl]-error.log (web.js); only requests that land
// on the default vhost ever reach the global error log.
export function domlogErrorLogs(root = DOMLOGS_ROOT) {
  const out = [];
  let users = [];
  try { users = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const u of users) {
    if (!u.isDirectory()) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(root, u.name)); } catch { continue; }
    for (const name of names) {
      const m = name.match(/^(.+?)(-ssl)?-error\.log$/);
      if (!m) continue;
      const file = path.join(root, u.name, name);
      let st;
      try { st = fs.lstatSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ file, user: u.name, domain: m[1], ssl: Boolean(m[2]), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const MODSEC_HIT_FILES_MAX = 200;
const MODSEC_HIT_FILE_MIN_BYTES = 32 * 1024;

// Tails every log (the byte budget is shared, never below 32 KB per file) and
// merges the hits by timestamp, newest last; each row names the log it came from.
export function collectModsecHits(logs, { maxBytes, limit }) {
  const perFile = Math.max(MODSEC_HIT_FILE_MIN_BYTES, Math.floor(maxBytes / Math.max(1, logs.length)));
  const files = [];
  const hits = [];
  for (const log of logs) {
    const content = tailText(log.file, perFile);
    files.push({ file: log.file, user: log.user ?? null, domain: log.domain ?? null, readable: content != null });
    if (content == null) continue;
    for (const hit of parseModsecErrorLog(content)) hits.push({ ...hit, log: log.file, user: log.user ?? null, domain: log.domain ?? null, time: modsecHitTime(hit.ts) });
  }
  hits.sort((a, b) => a.time - b.time);
  return { files, total: hits.length, hits: hits.slice(-limit).reverse().map(({ time, ...h }) => h) };
}

defineOp('sec.modsec.hits', {
  description: "Recent ModSecurity events parsed from the global Apache error log and every panel vhost's error log",
  schema: z.object({ maxBytes: z.number().int().min(4096).max(32 * 1024 * 1024).default(2 * 1024 * 1024), limit: z.number().int().min(1).max(5000).default(500) }).strict(),
  run: async ({ maxBytes, limit }, ctx) => {
    const layout = requireModsec();
    ctx.assertAllowedPath(layout.errorLog, 'read');
    const domlogs = domlogErrorLogs();
    const logs = [{ file: layout.errorLog, user: null, domain: null }, ...domlogs.slice(0, MODSEC_HIT_FILES_MAX)];
    for (const log of logs) ctx.assertAllowedPath(log.file, 'read');
    const { files, total, hits } = collectModsecHits(logs, { maxBytes, limit });
    const vhostLogs = files.length - 1;
    return {
      file: vhostLogs ? `${layout.errorLog} and ${vhostLogs} vhost error log${vhostLogs === 1 ? '' : 's'} under ${DOMLOGS_ROOT}` : layout.errorLog,
      errorLog: layout.errorLog, files, truncated: domlogs.length > MODSEC_HIT_FILES_MAX,
      available: files.some((f) => f.readable), total, hits,
    };
  },
});

// Redirects are followed by hand so every hop stays on https: the archive is
// unpacked into Apache's config tree as root and must never arrive in plaintext.
async function download(url, dest, maxBytes) {
  let current = url;
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    if (!location) throw new OpError('download_failed', `Download failed: HTTP ${res.status} without a Location header for ${current}`);
    const next = new URL(location, current).toString();
    if (!next.startsWith('https://')) throw new OpError('refused', `Refusing to follow a redirect to a non-https URL (${next})`);
    if (hop >= 5) throw new OpError('download_failed', `Too many redirects while downloading ${url}`);
    current = next;
  }
  if (!res.ok) throw new OpError('download_failed', `Download failed: HTTP ${res.status} for ${current}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new OpError('too_large', `Rule set exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
  return total;
}

// The archive kind comes from its leading bytes, not the URL (GitHub archive
// links carry no extension that tar would recognise).
export function archiveFormat(head) {
  const b = Buffer.from(head);
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'tar.gz';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b.length >= 3 && b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68) return 'tar.bz2';
  if (b.length >= 6 && b[0] === 0xfd && b.subarray(1, 6).toString('latin1') === '7zXZ\0') return 'tar.xz';
  if (b.length >= 262 && b.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return null;
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

// The archive is unpacked as root into Apache's config tree and its rule files
// are Included by Apache, so nothing the archive says about modes or special
// entries may survive: symlinks (a rules/x.conf -> /etc/shadow), device nodes,
// fifos and sockets are removed and every directory/file is reset to 0755/0644,
// which is what keeps a hosting account from editing a vendor rule.
export function sanitizeExtractedTree(root) {
  const removed = [];
  const walk = (dir) => {
    fs.chmodSync(dir, 0o755);
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) fs.chmodSync(p, 0o644);
      else { fs.unlinkSync(p); removed.push(p); }
    }
  };
  walk(root);
  return removed;
}

// A zip has no --strip-components: when it unpacks to a single top-level
// directory (GitHub archives do), that directory's contents become the root.
// lstat, so a top-level symlink can never have its target's entries moved.
function flattenSingleDir(staging) {
  const entries = fs.readdirSync(staging);
  if (entries.length !== 1) return;
  const only = path.join(staging, entries[0]);
  if (!fs.lstatSync(only).isDirectory()) return;
  for (const e of fs.readdirSync(only)) fs.renameSync(path.join(only, e), path.join(staging, e));
  fs.rmdirSync(only);
}

export async function extractArchive(archive, staging) {
  const format = archiveFormat(readHead(archive, 512));
  if (!format) throw new OpError('unsupported', 'The download is not a recognised archive (expected .tar.gz, .tar.bz2, .tar.xz, .tar or .zip)');
  if (format === 'zip') {
    if (!hasBinary('unzip')) throw new OpError('capability_missing', 'unzip is not installed; install it or use a .tar.gz archive');
    await exec('unzip', ['-q', '-o', archive, '-d', staging], { timeoutMs: 600_000 });
    const removed = sanitizeExtractedTree(staging);
    flattenSingleDir(staging);
    return { format, removed };
  }
  if (!hasBinary('tar')) throw new OpError('capability_missing', 'tar is not installed');
  const flag = { 'tar.gz': '-xzf', 'tar.bz2': '-xjf', 'tar.xz': '-xJf', tar: '-xf' }[format];
  await exec('tar', [flag, archive, '-C', staging, '--strip-components=1', '--no-same-owner', '--no-same-permissions'], { timeoutMs: 600_000 });
  return { format, removed: sanitizeExtractedTree(staging) };
}

defineOp('sec.modsec.vendor.install', {
  description: 'Download a rule set archive (.tar.gz, .tar.bz2, .tar.xz, .tar or .zip over https) into the vendors directory',
  timeoutMs: 600_000,
  schema: z.object({ name: vendorName, url: z.string().url().max(2048).refine((u) => u.startsWith('https://'), 'Only https:// URLs are accepted') }).strict(),
  run: async ({ name, url }, ctx) => {
    const layout = requireModsec();
    const dir = path.join(layout.vendorsDir, name);
    ctx.assertAllowedPath(dir, 'write');
    ctx.assertAllowedPath(layout.baseDir, 'write');
    // The archive is unpacked into Apache's config tree, so it is staged inside
    // the root-owned ModSecurity directory rather than a shared temp dir.
    const scratch = privateTempDir(layout.baseDir, '.whm-vendor-');
    const archive = path.join(scratch, `${name}.archive`);
    const staging = `${dir}.whm-new`;
    try {
      const bytes = await download(url, archive, 100 * 1024 * 1024);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true, mode: 0o755 });
      const { format, removed } = await extractArchive(archive, staging);
      return { ...finishVendorInstall(name, dir, staging, bytes), format, removedEntries: removed.length };
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  },
});

function finishVendorInstall(name, dir, staging, bytes) {
  const rulesDir = exists(path.join(staging, 'rules')) ? path.join(dir, 'rules') : dir;
  if (exists(path.join(staging, 'crs-setup.conf.example')) && !exists(path.join(staging, 'crs-setup.conf'))) fs.copyFileSync(path.join(staging, 'crs-setup.conf.example'), path.join(staging, 'crs-setup.conf'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  for (const f of fs.readdirSync(rulesDir)) if (f.endsWith('.conf.example') && !exists(path.join(rulesDir, f.replace(/\.example$/, '')))) fs.copyFileSync(path.join(rulesDir, f), path.join(rulesDir, f.replace(/\.example$/, '')));
  const files = ruleFiles([rulesDir], 1);
  return { name, dir, rulesDir, bytes, ruleFiles: files.length, rules: files.reduce((n, f) => n + parseModsecRules(readText(f), f).length, 0), setupConf: exists(path.join(dir, 'crs-setup.conf')) ? path.join(dir, 'crs-setup.conf') : null };
}

defineOp('sec.modsec.vendor.remove', {
  description: 'Delete an installed vendor rule set directory',
  destructive: true,
  schema: z.object({ name: vendorName }).strict(),
  run: async ({ name }, ctx) => {
    const layout = requireModsec();
    const dir = path.join(layout.vendorsDir, name);
    ctx.assertAllowedPath(dir, 'write');
    const existed = exists(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { name, existed };
  },
});

defineOp('sec.modsec.vendors.apply', {
  description: 'Write the include file that loads the enabled vendor rule sets, validate and roll back on error',
  schema: z.object({ vendors: z.array(z.object({ name: vendorName, enabled: z.boolean() }).strict()).max(50) }).strict(),
  run: async ({ vendors }, ctx) => {
    const layout = requireModsec();
    const apache = requireApache();
    ctx.assertAllowedPath(layout.vendorsConf, 'write');
    const lines = [`${MANAGED} (ModSecurity Vendors). Enabled vendor rule sets.`, '<IfModule security2_module>'];
    const loaded = [];
    for (const v of vendors) {
      const dir = path.join(layout.vendorsDir, v.name);
      if (!v.enabled || !exists(dir)) continue;
      const rulesDir = exists(path.join(dir, 'rules')) ? path.join(dir, 'rules') : dir;
      if (exists(path.join(dir, 'crs-setup.conf'))) lines.push(`  Include ${path.join(dir, 'crs-setup.conf')}`);
      lines.push(`  IncludeOptional ${rulesDir}/*.conf`);
      loaded.push(v.name);
    }
    lines.push('</IfModule>');
    await writeApacheInclude(apache, layout.vendorsConf, `${lines.join('\n')}\n`);
    return { path: layout.vendorsConf, loaded, unit: apache.units[0] };
  },
});

// ------------------------------------------------------------ mod_userdir ---

function userdirConfPath(apache) { return `${apache.includeDir}/zz-whm-userdir.conf`; }

export function renderUserdirConf({ enabled, excludeUsers, homeRoot }) {
  const lines = [`${MANAGED} (Apache mod_userdir Tweak).`, '<IfModule mod_userdir.c>'];
  if (!enabled) lines.push('  UserDir disabled');
  else {
    lines.push('  UserDir public_html');
    lines.push(`  UserDir disabled ${['root', ...excludeUsers].join(' ')}`);
    lines.push(`  <Directory "${homeRoot}/*/public_html">`, '    AllowOverride FileInfo AuthConfig Limit Indexes', '    Options MultiViews Indexes SymLinksIfOwnerMatch IncludesNoExec', '    Require all granted', '  </Directory>');
  }
  lines.push('</IfModule>');
  return `${lines.join('\n')}\n`;
}

export function parseUserdirConf(text) {
  if (text == null) return { configured: false, enabled: false, excludeUsers: [] };
  const lines = text.split('\n').map((l) => l.trim());
  const disabledLine = lines.find((l) => /^UserDir disabled/.test(l));
  if (disabledLine === 'UserDir disabled' && !lines.some((l) => /^UserDir public_html/.test(l))) return { configured: true, enabled: false, excludeUsers: [] };
  return { configured: true, enabled: lines.some((l) => /^UserDir public_html/.test(l)), excludeUsers: (disabledLine || '').replace(/^UserDir disabled\s*/, '').split(/\s+/).filter((u) => u && u !== 'root') };
}

defineOp('sec.userdir.get', {
  description: 'Apache mod_userdir state (module loaded, ~user URLs enabled, excluded users)',
  run: async () => {
    const apache = apacheFlavor();
    if (!apache) return { installed: false, configured: false, enabled: false, excludeUsers: [] };
    const file = userdirConfPath(apache);
    let moduleEnabled = null;
    if (apache.flavor === 'debian') moduleEnabled = exists(`${apache.modsEnabled}/userdir.load`);
    else {
      const mods = ruleFiles([apache.modsEnabled], 0).map((f) => readText(f) || '').join('\n');
      moduleEnabled = /^\s*LoadModule\s+userdir_module/m.test(mods);
    }
    return { installed: true, flavor: apache.flavor, path: file, moduleEnabled, ...parseUserdirConf(readText(file)) };
  },
});

defineOp('sec.userdir.set', {
  description: 'Enable/disable ~user URLs via a managed Apache include (validates config, rolls back on error)',
  // homeRoot is interpolated into an Apache <Directory "..."> block, so only
  // plain path characters are accepted (no quotes, spaces or newlines).
  schema: z.object({ enabled: z.boolean(), excludeUsers: z.array(arg.username).max(5000).default([]), homeRoot: z.string().max(200).regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/, 'Plain absolute path').refine((p) => !p.split('/').includes('..'), 'No ".." segments').default('/home') }).strict(),
  run: async ({ enabled, excludeUsers, homeRoot }, ctx) => {
    const apache = requireApache();
    const file = userdirConfPath(apache);
    ctx.assertAllowedPath(file, 'write');
    let moduleEnabledNow = false;
    if (enabled && apache.flavor === 'debian' && !exists(`${apache.modsEnabled}/userdir.load`) && hasBinary('a2enmod')) {
      await exec('a2enmod', ['-q', 'userdir']);
      moduleEnabledNow = true;
    }
    await writeApacheInclude(apache, file, renderUserdirConf({ enabled, excludeUsers, homeRoot }));
    return { path: file, enabled, excludeUsers, moduleEnabledNow, unit: apache.units[0] };
  },
});

// --------------------------------------------------------- advisor probes ---

const SENSITIVE_FILES = [
  { path: '/etc/shadow', maxMode: 0o640 }, { path: '/etc/gshadow', maxMode: 0o640 }, { path: '/etc/sudoers', maxMode: 0o440 },
  { path: '/root/.ssh/authorized_keys', maxMode: 0o600 }, { path: '/etc/ssh/sshd_config', maxMode: 0o644 }, { path: '/root', maxMode: 0o750 },
];

defineOp('sec.scan.filesystem', {
  description: 'World-writable directories under a root (sample) and permissions of sensitive files',
  schema: z.object({ root: arg.absPath.default('/home'), limit: z.number().int().min(1).max(500).default(50), maxDepth: z.number().int().min(1).max(6).default(3) }).strict(),
  run: async ({ root, limit, maxDepth }, ctx) => {
    ctx.assertAllowedPath(root, 'read');
    let worldWritable = [];
    let scanned = exists(root);
    if (scanned && hasBinary('find')) {
      const { code, stdout } = await exec('find', [root, '-maxdepth', String(maxDepth), '-type', 'd', '-perm', '-0002', '!', '-perm', '-1000'], { allowFailure: true, timeoutMs: 120_000 });
      scanned = code === 0 || stdout.length > 0;
      worldWritable = stdout.split('\n').filter(Boolean).slice(0, limit);
    }
    const sensitive = SENSITIVE_FILES.map((f) => {
      try {
        const mode = fs.statSync(f.path).mode & 0o777;
        return { path: f.path, exists: true, mode: mode.toString(8).padStart(4, '0'), maxMode: f.maxMode.toString(8).padStart(4, '0'), ok: (mode & ~f.maxMode) === 0 };
      } catch { return { path: f.path, exists: false, ok: true }; }
    });
    return { root, scanned, worldWritable, sensitive };
  },
});

// ------------------------------------------------------- malware scanners ---
// Used by the bundled ImunifyAV plugin: the vendor CLI when it is installed,
// clamscan as the fallback, and nothing else. Plugin permissions can only name
// ops whose segments are plain lowercase words, so these have no underscores.

const IMUNIFY_BIN = 'imunify-antivirus';
const IMUNIFY_TIMEOUT_MS = 120_000;
const CLAMAV_DB_DIRS = ['/var/lib/clamav'];

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

async function imunify(argv, { allowFailure = true } = {}) {
  if (!hasBinary(IMUNIFY_BIN)) throw new OpError('capability_missing', 'ImunifyAV is not installed on this server (imunify-antivirus not found)');
  const r = await exec(IMUNIFY_BIN, [...argv, '--json'], { allowFailure, timeoutMs: IMUNIFY_TIMEOUT_MS });
  return { ...r, json: parseJsonOutput(r.stdout) };
}

export function parseImunifyVersion(stdout) {
  const j = parseJsonOutput(stdout);
  if (j && typeof j === 'object' && j.version) return String(j.version);
  const m = /(\d+\.\d+(?:\.\d+)?(?:-\d+)?)/.exec(String(stdout || ''));
  return m ? m[1] : null;
}

// Both list shapes the CLI has used: a bare array, or { items, max_count }.
export function imunifyItems(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.result)) return json.result;
  return [];
}

export function shapeImunifyFinding(item) {
  return {
    id: item.id != null ? String(item.id) : null, file: item.file ?? item.filename ?? null, user: item.username ?? item.user ?? null,
    signature: item.type ?? item.malicious_type ?? item.hash ?? null, status: item.status ?? null, detected: item.created ?? item.timestamp ?? item.detected ?? null,
    cleaned: Boolean(item.cleaned), quarantined: /quarantin/i.test(String(item.status || '')) || Boolean(item.quarantined),
  };
}

defineOp('sec.imunify.detect', {
  description: 'Whether the ImunifyAV CLI is installed and which version',
  run: async () => {
    if (!hasBinary(IMUNIFY_BIN)) return { installed: false, version: null };
    const r = await exec(IMUNIFY_BIN, ['version', '--json'], { allowFailure: true, timeoutMs: IMUNIFY_TIMEOUT_MS });
    return { installed: true, version: parseImunifyVersion(r.stdout), ok: r.code === 0 };
  },
});

defineOp('sec.imunify.status', {
  description: 'ImunifyAV on-demand scanner status',
  run: async () => {
    const r = await imunify(['malware', 'on-demand', 'status']);
    const j = r.json && typeof r.json === 'object' ? r.json : {};
    return { ok: r.code === 0, status: j.status ?? (r.code === 0 ? 'unknown' : 'error'), path: j.path ?? null, scanned: j.scanned ?? j.total_files ?? null, infected: j.infected ?? null, started: j.started ?? j.start_time ?? null, raw: r.code === 0 ? j : r.stderr.slice(-1000) };
  },
});

defineOp('sec.imunify.scan', {
  description: 'Start an ImunifyAV on-demand scan of a directory',
  destructive: true,
  schema: z.object({ path: arg.absPath.default('/home'), intensity: z.enum(['low', 'moderate', 'high']).default('moderate') }).strict(),
  run: async ({ path: target, intensity }, ctx) => {
    ctx.assertAllowedPath(target, 'read');
    const r = await imunify(['malware', 'on-demand', 'start', `--path=${target}`, `--intensity-cpu=${intensity === 'low' ? '2' : intensity === 'high' ? '7' : '4'}`]);
    if (r.code !== 0) throw new OpError('command_failed', `ImunifyAV refused to start the scan: ${r.stderr.trim().split('\n').pop() || r.stdout.trim().split('\n').pop() || 'no output'}`, { path: target });
    return { started: true, path: target, result: r.json ?? null };
  },
});

defineOp('sec.imunify.results', {
  description: 'Malicious files ImunifyAV has found (newest first)',
  schema: z.object({ limit: z.number().int().min(1).max(1000).default(100), username: arg.username.optional() }).strict(),
  run: async ({ limit, username }) => {
    const argv = ['malware', 'malicious', 'list', `--limit=${limit}`, '--order-by=created', '--order-direction=desc'];
    if (username) argv.push(`--user=${username}`);
    const r = await imunify(argv);
    if (r.code !== 0) throw new OpError('command_failed', `ImunifyAV could not list findings: ${r.stderr.trim().split('\n').pop() || 'no output'}`);
    const items = imunifyItems(r.json).map(shapeImunifyFinding);
    return { total: r.json?.max_count ?? items.length, items };
  },
});

defineOp('sec.imunify.quarantine', {
  description: 'Files ImunifyAV has quarantined',
  schema: z.object({ limit: z.number().int().min(1).max(1000).default(100) }).strict(),
  run: async ({ limit }) => {
    const r = await imunify(['malware', 'malicious', 'list', `--limit=${limit}`, '--order-by=created', '--order-direction=desc']);
    if (r.code !== 0) throw new OpError('command_failed', `ImunifyAV could not list quarantined files: ${r.stderr.trim().split('\n').pop() || 'no output'}`);
    return { items: imunifyItems(r.json).map(shapeImunifyFinding).filter((f) => f.quarantined) };
  },
});

export function parseClamavVersion(stdout) {
  const m = /ClamAV\s+([0-9][0-9.]*)(?:\/(\d+))?/.exec(String(stdout || ''));
  return m ? { version: m[1], signatures: m[2] ? Number(m[2]) : null } : { version: null, signatures: null };
}

// "path: Signature FOUND" lines of `clamscan -i`; errors and summaries are kept
// apart so a permission problem is never reported as an infection.
export function parseClamscanOutput(stdout) {
  const infected = [];
  const errors = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    let m = /^(.*): (.+) FOUND$/.exec(line);
    if (m) { infected.push({ file: m[1], signature: m[2] }); continue; }
    m = /^(.*): (.+) ERROR$/.exec(line);
    if (m) errors.push({ file: m[1], error: m[2] });
  }
  return { infected, errors };
}

function clamavDatabaseAge() {
  let newest = null;
  for (const dir of CLAMAV_DB_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/\.(cvd|cld)$/.test(n)) continue;
      try { const t = fs.statSync(path.join(dir, n)).mtimeMs; if (newest == null || t > newest) newest = t; } catch { /* vanished */ }
    }
  }
  return newest == null ? null : Math.max(0, Math.floor((Date.now() - newest) / 1000));
}

defineOp('sec.clamav.detect', {
  description: 'Whether clamscan/freshclam are installed, the engine version and the signature database age',
  run: async () => {
    if (!hasBinary('clamscan')) return { installed: false, version: null, signatures: null, freshclam: hasBinary('freshclam'), databaseAgeSec: null };
    const r = await exec('clamscan', ['--version'], { allowFailure: true, timeoutMs: 30_000 });
    return { installed: true, ...parseClamavVersion(r.stdout), freshclam: hasBinary('freshclam'), databaseAgeSec: clamavDatabaseAge() };
  },
});

// Account home directories come from /etc/passwd so a caller never names an
// arbitrary path for a Unix user; explicit paths must sit under an allowed root.
function homeOfUser(username) {
  const line = (readText('/etc/passwd') || '').split('\n').find((l) => l.startsWith(`${username}:`));
  if (!line) throw new OpError('not_found', `Unknown user "${username}"`);
  const home = line.split(':')[5];
  if (!home || !path.isAbsolute(home)) throw new OpError('not_found', `User "${username}" has no home directory`);
  return home;
}

// Every agent call crosses the panel socket in one request and the client
// gives up after an hour (lib/agent-client.js), so one clamscan run is capped
// well below that; callers split a large home into chunks (sec.clamav.targets)
// and scan them one call at a time.
export const CLAMAV_CALL_MAX_SEC = 3300;
export const CLAMAV_CALL_DEFAULT_SEC = 2700;
const CLAMAV_SKIP_ENTRIES = new Set(['.cache', '.wp-cli', 'tmp', '.trash']);
// clamscan follows symlinks by default (--follow-dir-symlinks=1 and
// --follow-file-symlinks=1 cover links named on the command line), which as
// root would walk wherever an account points one; both are off, so a link
// inside a home is reported by name and never traversed.
export const CLAMSCAN_BASE_ARGV = ['-i', '--no-summary', '--stdout', '--follow-dir-symlinks=0', '--follow-file-symlinks=0', '--exclude-dir=^/home/[^/]+/\\.cache', '--exclude-dir=^/proc', '--exclude-dir=^/sys'];

// Splits a home directory into scan chunks: every directory down to `depth`
// levels becomes its own chunk and the loose files of each level are grouped
// into one, so no single clamscan call covers more than a slice of the tree.
// Symbolic links are left out (clamscan follows a link named on the command
// line) and the chunks keep the walk order so progress reads top to bottom.
export function listScanChunks(home, { depth = 2, maxChunks = 200 } = {}) {
  const chunks = [];
  const overflow = [];
  const split = (dir, level, label) => {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    const files = [];
    for (const name of names) {
      if (level === 1 && CLAMAV_SKIP_ENTRIES.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (level < depth) split(full, level + 1, `${label}${name}/`);
        else if (chunks.length < maxChunks) chunks.push({ label: `${label}${name}/`, paths: [full] });
        else overflow.push(full);
      } else if (st.isFile()) files.push(full);
    }
    if (files.length) { if (chunks.length < maxChunks) chunks.push({ label: `${label}(files)`, paths: files }); else overflow.push(...files); }
  };
  split(home, 1, '');
  if (overflow.length) chunks.push({ label: '(remaining)', paths: overflow });
  return chunks;
}

defineOp('sec.clamav.targets', {
  description: 'Split an account home directory into clamscan chunks that each fit one bounded sec.clamav.scan call',
  schema: z.object({ username: arg.username, depth: z.number().int().min(1).max(3).default(2), maxChunks: z.number().int().min(1).max(500).default(200) }).strict(),
  run: async ({ username, depth, maxChunks }, ctx) => {
    const home = homeOfUser(username);
    ctx.assertAllowedPath(home, 'read');
    if (!exists(home)) return { username, home, chunks: [] };
    const chunks = listScanChunks(home, { depth, maxChunks });
    return { username, home, chunks, files: chunks.reduce((n, c) => n + c.paths.length, 0) };
  },
});

defineOp('sec.clamav.scan', {
  description: 'Scan account home directories (or explicit paths) with clamscan; reports infected files only. One call is capped at maxDurationSec (< the agent-client timeout); split big trees with sec.clamav.targets',
  timeoutMs: CLAMAV_CALL_MAX_SEC * 1000,
  schema: z.object({
    usernames: z.array(arg.username).max(500).default([]),
    paths: z.array(arg.absPath).max(2000).default([]),
    maxFileMb: z.number().int().min(1).max(4000).default(25),
    recursive: z.boolean().default(true),
    maxDurationSec: z.number().int().min(60).max(CLAMAV_CALL_MAX_SEC).default(CLAMAV_CALL_DEFAULT_SEC),
  }).strict().refine((v) => v.usernames.length + v.paths.length > 0, 'usernames or paths is required'),
  run: async ({ usernames, paths, maxFileMb, recursive, maxDurationSec }, ctx) => {
    const targets = [];
    const skipped = [];
    // A target is listed by sec.clamav.targets minutes before it is scanned, so
    // the account may have swapped it for a symlink by now; a link named on the
    // command line would otherwise be followed by root (into / if it points there).
    const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
    const add = (p) => { if (!exists(p)) return; if (isLink(p)) skipped.push({ path: p, reason: 'symlink' }); else targets.push(p); };
    for (const p of paths) { ctx.assertAllowedPath(p, 'read'); add(p); }
    for (const u of usernames) {
      const home = homeOfUser(u);
      ctx.assertAllowedPath(home, 'read');
      add(home);
    }
    if (!hasBinary('clamscan')) throw new OpError('capability_missing', 'ClamAV is not installed on this server (clamscan not found)');
    if (!targets.length) return { targets: [], skipped, infected: [], errors: [], scanned: 0, exitCode: 0 };
    const argv = [...CLAMSCAN_BASE_ARGV, `--max-filesize=${maxFileMb}M`, `--max-scansize=${Math.max(maxFileMb * 4, 100)}M`];
    if (recursive) argv.unshift('-r');
    const started = Date.now();
    let r;
    try {
      r = await exec('clamscan', [...argv, '--', ...targets], { allowFailure: true, timeoutMs: maxDurationSec * 1000, maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      if (err.code === 'timeout') throw new OpError('timeout', `clamscan did not finish ${targets.length} target${targets.length === 1 ? '' : 's'} within ${maxDurationSec}s; scan a smaller chunk`, { targets, maxDurationSec });
      throw err;
    }
    const parsed = parseClamscanOutput(r.stdout);
    if (r.code === 2 && parsed.infected.length === 0 && !parsed.errors.length) throw new OpError('command_failed', `clamscan failed: ${r.stderr.trim().split('\n').pop() || 'no error output'}`, { targets });
    return { targets, skipped, ...parsed, exitCode: r.code, durationMs: Date.now() - started };
  },
});

// ------------------------------------------------------ network counters ---

export function parseNetDev(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = /^\s*([^\s:]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 16 || f.some((n) => !Number.isFinite(n))) continue;
    out.push({ iface: m[1], rxBytes: f[0], rxPackets: f[1], rxErrors: f[2], rxDropped: f[3], txBytes: f[8], txPackets: f[9], txErrors: f[10], txDropped: f[11] });
  }
  return out;
}

defineOp('sec.netdev.read', {
  description: 'Per-interface byte and packet counters from /proc/net/dev (for the Server Monitoring plugin)',
  schema: z.object({ includeLoopback: z.boolean().default(false) }).strict(),
  run: async ({ includeLoopback }) => {
    const text = readText('/proc/net/dev');
    if (text == null) throw new OpError('capability_missing', '/proc/net/dev is not readable on this host');
    const interfaces = parseNetDev(text).filter((i) => includeLoopback || i.iface !== 'lo');
    return { ts: Date.now(), interfaces };
  },
});
