import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

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

const hostRule = z.object({
  service: z.string().regex(/^(ALL|[A-Za-z0-9_.-]{1,32})$/, 'Daemon name such as sshd, vsftpd, ALL'),
  source: z.string().regex(/^(ALL|LOCAL|KNOWN|UNKNOWN|PARANOID|[A-Za-z0-9.:/_-]{1,255})$/, 'Host, IP, network/mask or wildcard'),
  action: z.enum(['allow', 'deny']),
  comment: z.string().regex(/^[^\n\0]{0,120}$/).optional(),
}).strict();

// All rules go into hosts.allow with explicit ALLOW/DENY so the operator's order is
// honoured (tcp wrappers stops at the first match); hosts.deny only carries a header.
export function renderHostsAllow(rules) {
  const lines = [`${MANAGED} (Host Access Control). Edit through the panel; manual changes are overwritten.`, ''];
  for (const r of rules) {
    if (r.comment) lines.push(`# ${r.comment}`);
    lines.push(`${r.service}: ${r.source}: ${r.action.toUpperCase()}`);
  }
  return `${lines.join('\n')}\n`;
}

defineOp('sec.hosts_allow.read', {
  description: 'Current /etc/hosts.allow and /etc/hosts.deny contents',
  run: async () => ({ allow: readText(HOSTS_ALLOW), deny: readText(HOSTS_DENY), supported: exists('/etc/hosts.allow') || exists('/etc/hosts.deny') || exists('/lib/x86_64-linux-gnu/libwrap.so.0') || exists('/usr/lib64/libwrap.so.0') }),
});

defineOp('sec.hosts_allow.write', {
  description: 'Render host access rules into /etc/hosts.allow (ordered ALLOW/DENY) and a managed /etc/hosts.deny',
  schema: z.object({ rules: z.array(hostRule).max(500) }).strict(),
  run: async ({ rules }, ctx) => {
    ctx.assertAllowedPath(HOSTS_ALLOW, 'write');
    ctx.assertAllowedPath(HOSTS_DENY, 'write');
    writeAtomic(HOSTS_ALLOW, renderHostsAllow(rules));
    writeAtomic(HOSTS_DENY, `${MANAGED} (Host Access Control). Rules live in /etc/hosts.allow with explicit ALLOW/DENY actions.\n`);
    return { rules: rules.length, files: [HOSTS_ALLOW, HOSTS_DENY] };
  },
});

// -------------------------------------------------------------------- sshd ---

const SSHD_CONFIG = '/etc/ssh/sshd_config';
const SSHD_MANAGED = '/etc/ssh/sshd_config.d/whm.conf';
const SSHD_INCLUDE = 'Include /etc/ssh/sshd_config.d/*.conf';

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

function sshdEffectiveFromFiles() {
  const merged = {};
  const main = readText(SSHD_CONFIG) || '';
  // Include'd drop-ins win over later lines in the main file only when the Include
  // precedes them; our managed file is read first in practice, so apply it last here
  // only for keys the main file does not set before the Include line.
  const includeIndex = main.indexOf(SSHD_INCLUDE);
  const before = includeIndex >= 0 ? main.slice(0, includeIndex) : '';
  const after = includeIndex >= 0 ? main.slice(includeIndex) : main;
  Object.assign(merged, parseSshdConfig(before));
  let dropins = [];
  try { dropins = fs.readdirSync('/etc/ssh/sshd_config.d').filter((f) => f.endsWith('.conf')).sort(); } catch { /* no drop-in dir */ }
  for (const f of dropins) for (const [k, v] of Object.entries(parseSshdConfig(readText(path.join('/etc/ssh/sshd_config.d', f))))) if (!(k in merged)) merged[k] = v;
  for (const [k, v] of Object.entries(parseSshdConfig(after))) if (!(k in merged)) merged[k] = v;
  return merged;
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
    let effective = {};
    let source = 'files';
    if (installed) {
      const { code, stdout } = await exec('sshd', ['-T'], { allowFailure: true, timeoutMs: 30_000 });
      if (code === 0) { effective = parseSshdConfig(stdout); source = 'sshd -T'; }
    }
    if (source === 'files') effective = sshdEffectiveFromFiles();
    const managedText = readText(SSHD_MANAGED);
    const managed = {};
    for (const line of (managedText || '').split('\n')) {
      const m = line.trim().match(/^(\w+)\s+(.+)$/);
      if (m && !line.startsWith('#')) managed[m[1]] = m[2];
    }
    const mainText = readText(SSHD_CONFIG);
    return { installed, source, effective, managed, managedPath: SSHD_MANAGED, includeActive: mainText == null ? false : mainText.includes(SSHD_INCLUDE), configPresent: mainText != null };
  },
});

defineOp('sec.sshd.set', {
  description: 'Write sshd settings to /etc/ssh/sshd_config.d/whm.conf, validate with sshd -t and reload',
  schema: z.object({ settings: sshdSettings }).strict(),
  run: async ({ settings }, ctx) => {
    ctx.assertAllowedPath(SSHD_MANAGED, 'write');
    ctx.assertAllowedPath(SSHD_CONFIG, 'write');
    if (!hasBinary('sshd')) throw new OpError('capability_missing', 'OpenSSH server (sshd) is not installed on this server');
    const current = {};
    for (const line of (readText(SSHD_MANAGED) || '').split('\n')) {
      const m = line.trim().match(/^(\w+)\s+(.+)$/);
      if (m && !line.startsWith('#')) current[m[1]] = m[2];
    }
    for (const [k, v] of Object.entries(settings)) {
      if (v === undefined) continue;
      if (v === null) delete current[k]; else current[k] = String(v);
    }
    const previousManaged = readText(SSHD_MANAGED);
    const previousMain = readText(SSHD_CONFIG);
    let includeAdded = false;
    if (previousMain != null && !previousMain.includes(SSHD_INCLUDE)) {
      // The Include must precede every Match block, so it goes at the very top.
      writeAtomic(SSHD_CONFIG, `${SSHD_INCLUDE}\n${previousMain}`, 0o600);
      includeAdded = true;
    }
    writeAtomic(SSHD_MANAGED, renderSshdManaged(current), 0o600);
    const { code, stderr } = await exec('sshd', ['-t'], { allowFailure: true, timeoutMs: 30_000 });
    if (code !== 0) {
      restore(SSHD_MANAGED, previousManaged);
      if (includeAdded) restore(SSHD_CONFIG, previousMain);
      throw new OpError('config_invalid', `sshd rejected the configuration; the previous files were restored: ${stderr.trim().split('\n').pop()}`, { output: stderr.trim() });
    }
    const reload = await reloadUnit(['ssh', 'sshd']);
    return { path: SSHD_MANAGED, settings: current, includeAdded, ...reload };
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
    const argv = ['-q', '-t', type, '-f', file, '-N', passphrase, '-C', comment ?? `root@whm-${name}`];
    if (bits && type !== 'ed25519') argv.push('-b', String(bits));
    await exec('ssh-keygen', argv, { timeoutMs: 120_000 });
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
    const entry = seen.get(real) || { realPath: real, paths: [], mode: (st.mode & 0o7777).toString(8).padStart(4, '0'), othersCanExecute: Boolean(st.mode & 0o001) };
    entry.paths.push(p);
    seen.set(real, entry);
  }
  const binaries = [...seen.values()];
  return { installed: binaries.length > 0, allowed: binaries.length > 0 && binaries.every((b) => b.othersCanExecute), binaries };
}

function setBinaryAccess(candidates, allow) {
  const state = binaryAccess(candidates);
  for (const b of state.binaries) fs.chmodSync(b.realPath, allow ? 0o755 : 0o750);
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
const FORKBOMB_DEFAULTS = { maxProcesses: 35, maxOpenFiles: 1024, maxMemoryMb: 512, excludeGroups: ['wheel', 'sudo'] };

export function renderForkBombConf({ maxProcesses, maxOpenFiles, maxMemoryMb, excludeGroups }) {
  const lines = [`${MANAGED} (Shell Fork Bomb Protection). Limits apply to PAM login sessions; root and the groups below are exempt.`];
  lines.push(`*          hard    nproc     ${maxProcesses}`);
  lines.push(`*          hard    nofile    ${maxOpenFiles}`);
  lines.push(`*          hard    as        ${maxMemoryMb * 1024}`);
  for (const who of ['root', ...excludeGroups.map((g) => `@${g}`)]) {
    lines.push(`${who.padEnd(10)} hard    nproc     unlimited`);
    lines.push(`${who.padEnd(10)} hard    nofile    unlimited`);
    lines.push(`${who.padEnd(10)} hard    as        unlimited`);
  }
  return `${lines.join('\n')}\n`;
}

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
  run: async () => ({ path: FORKBOMB_CONF, supported: exists('/etc/security/limits.d') || exists('/etc/security/limits.conf'), ...parseForkBombConf(readText(FORKBOMB_CONF)) }),
});

defineOp('sec.fork_bomb.set', {
  description: 'Enable or disable per-user process/memory limits via /etc/security/limits.d',
  schema: z.object({
    enabled: z.boolean(),
    maxProcesses: z.number().int().min(1).max(1_000_000).default(FORKBOMB_DEFAULTS.maxProcesses),
    maxOpenFiles: z.number().int().min(16).max(10_000_000).default(FORKBOMB_DEFAULTS.maxOpenFiles),
    maxMemoryMb: z.number().int().min(16).max(16_000_000).default(FORKBOMB_DEFAULTS.maxMemoryMb),
    excludeGroups: z.array(groupName).max(20).default(FORKBOMB_DEFAULTS.excludeGroups),
  }).strict(),
  run: async ({ enabled, ...limits }, ctx) => {
    ctx.assertAllowedPath(FORKBOMB_CONF, 'write');
    if (!enabled) {
      try { fs.unlinkSync(FORKBOMB_CONF); } catch { /* already disabled */ }
      return { path: FORKBOMB_CONF, enabled: false };
    }
    writeAtomic(FORKBOMB_CONF, renderForkBombConf(limits));
    return { path: FORKBOMB_CONF, enabled: true, ...limits };
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

async function smtpEnabled(backend) {
  if (backend === 'iptables') return (await exec('iptables', ['-C', 'OUTPUT', '-p', 'tcp', '--dport', '25', '-j', SMTP_CHAIN], { allowFailure: true })).code === 0;
  return (await exec('nft', ['list', 'chain', ...NFT_TABLE, 'smtp'], { allowFailure: true })).code === 0;
}

defineOp('sec.smtp_restrict.get', {
  description: 'Whether outbound port 25 is restricted to root and the mail groups',
  run: async () => {
    const backend = firewallBackend();
    const groups = MAIL_GROUPS.map(groupEntry).filter(Boolean);
    return { backend, enabled: backend ? await smtpEnabled(backend) : false, groups: groups.map((g) => g.name) };
  },
});

defineOp('sec.smtp_restrict.set', {
  description: 'Enable or disable the outbound SMTP restriction (owner-match firewall rules on port 25)',
  schema: z.object({ enabled: z.boolean() }).strict(),
  run: async ({ enabled }) => {
    const backend = requireFirewall();
    const groups = MAIL_GROUPS.map(groupEntry).filter(Boolean);
    if (backend === 'iptables') {
      if (!enabled) {
        for (let i = 0; i < 5; i++) if ((await exec('iptables', ['-D', 'OUTPUT', '-p', 'tcp', '--dport', '25', '-j', SMTP_CHAIN], { allowFailure: true })).code !== 0) break;
        await exec('iptables', ['-F', SMTP_CHAIN], { allowFailure: true });
        await exec('iptables', ['-X', SMTP_CHAIN], { allowFailure: true });
        return { backend, enabled: false };
      }
      await iptablesEnsureChain('iptables', SMTP_CHAIN, 'OUTPUT', ['-p', 'tcp', '--dport', '25']);
      await exec('iptables', ['-F', SMTP_CHAIN]);
      await exec('iptables', ['-A', SMTP_CHAIN, '-o', 'lo', '-j', 'ACCEPT']);
      await exec('iptables', ['-A', SMTP_CHAIN, '-m', 'owner', '--uid-owner', '0', '-j', 'ACCEPT']);
      for (const g of groups) await exec('iptables', ['-A', SMTP_CHAIN, '-m', 'owner', '--gid-owner', String(g.gid), '-j', 'ACCEPT']);
      await exec('iptables', ['-A', SMTP_CHAIN, '-j', 'REJECT', '--reject-with', 'tcp-reset']);
      return { backend, enabled: true, groups: groups.map((g) => g.name) };
    }
    if (!enabled) {
      await exec('nft', ['delete', 'chain', ...NFT_TABLE, 'smtp'], { allowFailure: true });
      return { backend, enabled: false };
    }
    await nftEnsureTable();
    await exec('nft', ['add', 'chain', ...NFT_TABLE, 'smtp', '{ type filter hook output priority 0 ; policy accept ; }']);
    await exec('nft', ['flush', 'chain', ...NFT_TABLE, 'smtp']);
    await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'oifname', 'lo', 'accept']);
    await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'tcp', 'dport', '25', 'meta', 'skuid', '0', 'accept']);
    for (const g of groups) await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'tcp', 'dport', '25', 'meta', 'skgid', String(g.gid), 'accept']);
    await exec('nft', ['add', 'rule', ...NFT_TABLE, 'smtp', 'tcp', 'dport', '25', 'reject', 'with', 'tcp', 'reset']);
    return { backend, enabled: true, groups: groups.map((g) => g.name) };
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

export function modsecLayout() {
  const apache = apacheFlavor();
  let base = null;
  if (exists('/etc/modsecurity') || exists('/etc/apache2/mods-available/security2.load')) base = { flavor: 'debian', baseDir: '/etc/modsecurity', mainConf: exists('/etc/modsecurity/modsecurity.conf') ? '/etc/modsecurity/modsecurity.conf' : null, recommended: exists('/etc/modsecurity/modsecurity.conf-recommended') ? '/etc/modsecurity/modsecurity.conf-recommended' : null, crsDirs: ['/usr/share/modsecurity-crs/rules', '/etc/modsecurity/crs', '/usr/share/modsecurity-crs'] };
  else if (exists('/etc/httpd/conf.d/mod_security.conf') || exists('/etc/httpd/modsecurity.d')) base = { flavor: 'rhel', baseDir: '/etc/httpd/modsecurity.d', mainConf: exists('/etc/httpd/conf.d/mod_security.conf') ? '/etc/httpd/conf.d/mod_security.conf' : null, recommended: null, crsDirs: ['/etc/httpd/modsecurity.d/activated_rules', '/usr/share/mod_modsecurity_crs/rules', '/etc/httpd/modsecurity.d/crs/rules'] };
  const includeDir = apache?.includeDir || null;
  return {
    installed: Boolean(base && apache),
    apache,
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

defineOp('sec.modsec.hits', {
  description: 'Recent ModSecurity events parsed from the Apache error log',
  schema: z.object({ maxBytes: z.number().int().min(4096).max(32 * 1024 * 1024).default(2 * 1024 * 1024), limit: z.number().int().min(1).max(5000).default(500) }).strict(),
  run: async ({ maxBytes, limit }, ctx) => {
    const layout = requireModsec();
    const file = layout.errorLog;
    ctx.assertAllowedPath(file, 'read');
    let content = '';
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try {
        const length = Math.min(size, maxBytes);
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, Math.max(0, size - length));
        content = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return { file, hits: [], available: false }; }
    const hits = parseModsecErrorLog(content);
    return { file, available: true, total: hits.length, hits: hits.slice(-limit).reverse() };
  },
});

async function download(url, dest, maxBytes) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new OpError('download_failed', `Download failed: HTTP ${res.status} for ${url}`);
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

defineOp('sec.modsec.vendor.install', {
  description: 'Download a rule set archive (.tar.gz/.zip URL) into the vendors directory',
  timeoutMs: 600_000,
  schema: z.object({ name: vendorName, url: z.string().url().max(2048).refine((u) => u.startsWith('https://'), 'Only https:// URLs are accepted') }).strict(),
  run: async ({ name, url }, ctx) => {
    const layout = requireModsec();
    if (!hasBinary('tar')) throw new OpError('capability_missing', 'tar is not installed');
    const dir = path.join(layout.vendorsDir, name);
    ctx.assertAllowedPath(dir, 'write');
    fs.mkdirSync('/tmp/whm', { recursive: true, mode: 0o700 });
    const archive = `/tmp/whm/modsec-vendor-${name}-${process.pid}.tar.gz`;
    const bytes = await download(url, archive, 100 * 1024 * 1024);
    const staging = `${dir}.whm-new`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o755 });
    try {
      await exec('tar', ['-xzf', archive, '-C', staging, '--strip-components=1', '--no-same-owner'], { timeoutMs: 600_000 });
    } finally { fs.rmSync(archive, { force: true }); }
    const rulesDir = exists(path.join(staging, 'rules')) ? path.join(dir, 'rules') : dir;
    if (exists(path.join(staging, 'crs-setup.conf.example')) && !exists(path.join(staging, 'crs-setup.conf'))) fs.copyFileSync(path.join(staging, 'crs-setup.conf.example'), path.join(staging, 'crs-setup.conf'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    for (const f of fs.readdirSync(rulesDir)) if (f.endsWith('.conf.example') && !exists(path.join(rulesDir, f.replace(/\.example$/, '')))) fs.copyFileSync(path.join(rulesDir, f), path.join(rulesDir, f.replace(/\.example$/, '')));
    const files = ruleFiles([rulesDir], 1);
    return { name, dir, rulesDir, bytes, ruleFiles: files.length, rules: files.reduce((n, f) => n + parseModsecRules(readText(f), f).length, 0), setupConf: exists(path.join(dir, 'crs-setup.conf')) ? path.join(dir, 'crs-setup.conf') : null };
  },
});

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
  schema: z.object({ enabled: z.boolean(), excludeUsers: z.array(arg.username).max(5000).default([]), homeRoot: arg.absPath.default('/home') }).strict(),
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
