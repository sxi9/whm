import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { PHP_MINORS } from '../managed-paths.js';

// Software: distro packages (apt / dnf / yum), language module installers,
// PHP versions + ini files, PHP-FPM pools and the NGINX reverse proxy. Every
// name that becomes an argv element is constrained to a package-identifier
// alphabet that cannot start with "-" or contain shell metacharacters.
//
// Long-running installers accept `wait: false`: the command is then started
// detached with its output in a log file under PKG_RUN_DIR and the op returns
// a run id at once, so no single agent request outlives the socket client's
// timeout; `pkg.run.status` polls the run and streams its output.

const pkgName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+._-]{0,99}$/, 'package name');
const searchTerm = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+._-]{0,63}$/, 'search term');
const perlModule = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_]*(::[A-Za-z0-9_]+)*$/, 'Perl module name');
const peclExtension = z.string().regex(/^[a-z][a-z0-9_]{0,63}(-(stable|beta|alpha|[0-9][0-9A-Za-z.]{0,31}))?$/, 'PECL extension');
const pearPackage = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'PEAR package');
const gemName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'gem name');
const pipName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'pip package');
const versionSpec = z.string().regex(/^[0-9][0-9A-Za-z.+~:-]{0,63}$/, 'version');
const phpVersionId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/, 'PHP version id');
const iniKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/, 'ini directive');
// Values are written to a file, never to argv; newlines would smuggle directives.
const iniValue = z.string().max(1024).regex(/^[^\r\n\0]*$/, 'single line');
const directives = z.record(iniKey, iniValue.nullable()).refine((d) => Object.keys(d).length <= 200, 'too many directives');
const port = z.number().int().min(1).max(65535);

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', APT_LISTCHANGES_FRONTEND: 'none', NEEDRESTART_MODE: 'a' };
const APT_DPKG_OPTS = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];
const LONG = 45 * 60_000;
const BIG = 64 * 1024 * 1024;
const wait = z.boolean().default(true);
const runId = z.string().regex(/^[a-z0-9]{1,16}-[0-9a-f]{12}$/, 'run id');

// Tests point this somewhere under /tmp/whm; it must stay under an allowed root.
export const PKG_RUN_DIR = '/var/lib/whm/pkg-runs';
const runDir = () => process.env.WHM_PKG_RUN_DIR || PKG_RUN_DIR;
const RUN_RETENTION_MS = 7 * 86_400_000;

export function detectManager() {
  if (hasBinary('apt-get')) return { manager: 'apt', family: 'debian', binary: 'apt-get', rpm: hasBinary('rpm') };
  if (hasBinary('dnf')) return { manager: 'dnf', family: 'rhel', binary: 'dnf', rpm: hasBinary('rpm') };
  if (hasBinary('yum')) return { manager: 'yum', family: 'rhel', binary: 'yum', rpm: hasBinary('rpm') };
  return { manager: null, family: null, binary: null, rpm: hasBinary('rpm') };
}

function requireManager() {
  const pm = detectManager();
  if (!pm.manager) throw new OpError('capability_missing', 'No supported package manager (apt-get, dnf or yum) is installed on this server');
  return pm;
}

const tail = (text, n = 400) => text.split('\n').filter((l) => l.trim()).slice(-n);

export function parseInstalledList(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, version, arch, status, ...summary] = line.split('\t');
    if (!name || (status && !status.startsWith('ii'))) continue;
    out.push({ name, version: version || null, arch: arch || null, summary: summary.join('\t').trim() || null });
  }
  return out;
}

export function parseAptSearch(stdout) {
  return stdout.split('\n').map((l) => l.match(/^(\S+) - (.*)$/)).filter(Boolean).map((m) => ({ name: m[1], summary: m[2].trim() }));
}

export function parseDnfSearch(stdout) {
  const out = [];
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    if (line.startsWith('=') || !line.includes(' : ')) continue;
    const m = line.match(/^(\S+?)(?:\.(noarch|x86_64|i686|aarch64|src))? : (.*)$/);
    if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], summary: m[3].trim() }); }
  }
  return out;
}

// `apt-get -s dist-upgrade` prints one "Inst pkg [old] (new repo [arch])" line per upgrade.
export function parseAptSimulation(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^Inst (\S+) (?:\[([^\]]+)\] )?\(([^\s)]+) ([^)]*)\)/);
    if (m) out.push({ name: m[1], current: m[2] || null, candidate: m[3], repo: m[4].trim(), security: /security/i.test(m[4]) });
  }
  return out;
}

// `dnf check-update` prints "name.arch  version  repo" rows; "Obsoleting Packages" ends the list.
export function parseDnfCheckUpdate(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (/^Obsoleting Packages/i.test(line)) break;
    const m = line.match(/^(\S+)\.(noarch|x86_64|i686|aarch64|src)\s+(\S+)\s+(\S+)\s*$/);
    if (m) out.push({ name: m[1], current: null, candidate: m[3], repo: m[4], security: /security/i.test(m[4]) });
  }
  return out;
}

export function parseAptPolicy(stdout) {
  const installed = stdout.match(/^\s*Installed:\s*(.+)$/m)?.[1]?.trim();
  const candidate = stdout.match(/^\s*Candidate:\s*(.+)$/m)?.[1]?.trim();
  return { installed: installed && installed !== '(none)' ? installed : null, candidate: candidate && candidate !== '(none)' ? candidate : null };
}

export function parseKeyValueBlock(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/);
    if (m && !(m[1] in out)) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

export function parsePeclList(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s+(\d[\w.-]*)\s+(\w+)\s*$/);
    if (m && m[1] !== 'Package') out.push({ name: m[1], version: m[2], state: m[3] });
  }
  return out;
}

export function parseGemList(stdout) {
  return stdout.split('\n').map((l) => l.match(/^(\S+) \(([^)]+)\)/)).filter(Boolean).map((m) => ({ name: m[1], version: m[2].split(',')[0].replace(/^default: /, '').trim(), versions: m[2].split(',').map((v) => v.replace(/^default: /, '').trim()) }));
}

// ExtUtils::Installed lists the interpreter itself as "Perl\t<version>"; it is not a module.
export function parsePerlModules(stdout) {
  return stdout.split('\n').filter((l) => l.trim()).map((l) => { const [name, version] = l.split('\t'); return { name: name.trim(), version: version?.trim() || null }; }).filter((m) => m.name && m.name !== 'Perl');
}

// ini files: directives before the first [section] belong to PHP; sections are
// kept verbatim. Only "key = value" lines count; ";key = value" is a comment.
export function parseIni(content) {
  const out = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/\s+;.*$/, '').replace(/^"(.*)"$/, '$1').trim();
  }
  return out;
}

const needsQuotes = (v) => /[\s;#"]/.test(v) && !/^".*"$/.test(v);

// Rewrites the first active "key = ..." line, otherwise replaces a commented
// ";key = ..." hint, otherwise appends. A null value removes the directive.
export function setIniDirectives(content, changes) {
  const lines = content.trim() === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');
  for (const [key, value] of Object.entries(changes)) {
    const active = new RegExp(`^\\s*${key.replace(/\./g, '\\.')}\\s*=`);
    const commented = new RegExp(`^\\s*;\\s*${key.replace(/\./g, '\\.')}\\s*=`);
    const rendered = value == null ? null : `${key} = ${needsQuotes(value) ? `"${value.replace(/"/g, '')}"` : value}`;
    const idx = lines.findIndex((l) => active.test(l));
    if (idx >= 0) {
      if (rendered == null) lines.splice(idx, 1); else lines[idx] = rendered;
      continue;
    }
    if (rendered == null) continue;
    const cidx = lines.findIndex((l) => commented.test(l));
    if (cidx >= 0) { lines.splice(cidx + 1, 0, rendered); continue; }
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(rendered);
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

const safeReaddir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const firstExisting = (paths) => paths.find((p) => fs.existsSync(p)) || null;

// PHP builds from source (pkg.php.build) live under /opt/keel/php/<minor>; the
// test override must stay under an allowed root exactly like WHM_NODE_DIR.
export const KEEL_PHP_DIR = '/opt/keel/php';
export const KEEL_PHP_RUN_DIR = '/run/keel-php';
export const SYSTEMD_UNIT_DIR = '/etc/systemd/system';
const keelPhpDir = () => process.env.WHM_KEEL_PHP_DIR || KEEL_PHP_DIR;
const systemdUnitDir = () => process.env.WHM_SYSTEMD_UNIT_DIR || SYSTEMD_UNIT_DIR;
const keelPhpUnit = (minor) => `keel-php${minor}-fpm`;

// PHP installations this host may carry, by packaging layout.
export function discoverPhp() {
  const found = new Map();
  const add = (id, binary, layout, extra) => { if (fs.existsSync(binary) && !found.has(id)) found.set(id, { id, binary, layout, ...extra }); };
  for (const dir of safeReaddir('/etc/php')) {
    if (!/^\d+\.\d+$/.test(dir)) continue;
    const base = `/etc/php/${dir}`;
    add(dir, `/usr/bin/php${dir}`, 'debian', {
      label: `PHP ${dir}`, iniPath: firstExisting([`${base}/fpm/php.ini`, `${base}/apache2/php.ini`, `${base}/cli/php.ini`]),
      iniPaths: Object.fromEntries(['fpm', 'apache2', 'cli'].map((s) => [s, fs.existsSync(`${base}/${s}/php.ini`) ? `${base}/${s}/php.ini` : null])),
      poolDir: `${base}/fpm/pool.d`, fpmUnit: `php${dir}-fpm`, packagePrefix: `php${dir}-`,
    });
  }
  for (const dir of safeReaddir('/opt/cpanel')) {
    if (!/^ea-php\d+$/.test(dir)) continue;
    const root = `/opt/cpanel/${dir}/root`;
    add(dir, `${root}/usr/bin/php`, 'ea4', { label: dir, iniPath: firstExisting([`${root}/etc/php.ini`]), iniPaths: { php: `${root}/etc/php.ini` }, poolDir: `${root}/etc/php-fpm.d`, fpmUnit: `${dir}-php-fpm`, packagePrefix: `${dir}-php-` });
  }
  for (const dir of safeReaddir('/opt/remi')) {
    if (!/^php\d+$/.test(dir)) continue;
    add(dir, `/opt/remi/${dir}/root/usr/bin/php`, 'remi', { label: `Remi ${dir}`, iniPath: firstExisting([`/etc/opt/remi/${dir}/php.ini`]), iniPaths: { php: `/etc/opt/remi/${dir}/php.ini` }, poolDir: `/etc/opt/remi/${dir}/php-fpm.d`, fpmUnit: `${dir}-php-fpm`, packagePrefix: `${dir}-php-` });
  }
  for (const dir of safeReaddir('/opt/rh')) {
    if (!/^rh-php\d+$/.test(dir)) continue;
    add(dir, `/opt/rh/${dir}/root/usr/bin/php`, 'scl', { label: dir, iniPath: firstExisting([`/etc/opt/rh/${dir}/php.ini`]), iniPaths: { php: `/etc/opt/rh/${dir}/php.ini` }, poolDir: `/etc/opt/rh/${dir}/php-fpm.d`, fpmUnit: `${dir}-php-fpm`, packagePrefix: `${dir}-php-` });
  }
  if (fs.existsSync('/etc/php.ini') && fs.existsSync('/usr/bin/php')) {
    add('system', '/usr/bin/php', 'rhel', { label: 'System PHP', iniPath: '/etc/php.ini', iniPaths: { php: '/etc/php.ini' }, poolDir: '/etc/php-fpm.d', fpmUnit: 'php-fpm', packagePrefix: 'php-' });
  }
  for (const dir of safeReaddir(keelPhpDir())) {
    if (!/^\d\.\d+$/.test(dir)) continue;
    const prefix = path.join(keelPhpDir(), dir);
    // php-build.sh writes .keel-build-ok as its last step; a prefix without it is a build that died in make install.
    if (!fs.existsSync(path.join(prefix, '.keel-build-ok')) || !fs.existsSync(path.join(prefix, 'etc', 'php-fpm.conf'))) continue;
    add(dir, path.join(prefix, 'bin', 'php'), 'keel', {
      label: `PHP ${dir} (Keel build)`, iniPath: path.join(prefix, 'lib', 'php.ini'), iniPaths: { php: path.join(prefix, 'lib', 'php.ini') },
      poolDir: path.join(prefix, 'etc', 'php-fpm.d'), fpmUnit: keelPhpUnit(dir), packagePrefix: null, source: true, prefix,
    });
  }
  // Only when nothing else was found: with Keel builds present /usr/bin/php is one of them (update-alternatives).
  if (found.size === 0 && fs.existsSync('/usr/bin/php')) {
    add('system', '/usr/bin/php', 'unknown', { label: 'System PHP', iniPath: null, iniPaths: {}, poolDir: null, fpmUnit: 'php-fpm', packagePrefix: 'php-' });
  }
  let defaultBinary = null;
  try { defaultBinary = fs.realpathSync('/usr/bin/php'); } catch { /* no system php */ }
  const versions = [...found.values()];
  const def = versions.find((v) => { try { return fs.realpathSync(v.binary) === defaultBinary; } catch { return false; } });
  return { versions, defaultId: def?.id ?? null, defaultBinary };
}

function phpVersion(id) {
  const { versions } = discoverPhp();
  const v = versions.find((x) => x.id === id);
  if (!v) throw new OpError('not_found', `PHP version "${id}" is not installed on this server`);
  return v;
}

async function unitActive(unit) {
  if (!hasBinary('systemctl')) return null;
  const { stdout, code } = await exec('systemctl', ['is-active', `${unit}.service`], { allowFailure: true });
  return code === 0 ? true : stdout.trim() === 'inactive' || stdout.trim() === 'failed' ? false : null;
}

async function phpIniCheck(binary, iniPath) {
  const { stderr, code } = await exec(binary, ['-n', '-c', iniPath, '-d', 'display_startup_errors=1', '-r', 'exit(0);'], { allowFailure: true, timeoutMs: 20_000 });
  const bad = code !== 0 || /syntax error|cannot parse|unexpected/i.test(stderr);
  return { ok: !bad, output: stderr.trim().slice(-2000) };
}

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const randomSuffix = () => crypto.randomBytes(6).toString('hex');

function passwdEntry(name) {
  const u = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${name}:`))?.split(':');
  if (!u) throw new OpError('not_found', `Unknown user "${name}"`);
  return { name, uid: Number(u[2]), gid: Number(u[3]), home: u[5] };
}

// Atomic replace: the temporary name is unguessable and created O_EXCL|O_NOFOLLOW,
// so a pre-planted link at that name fails instead of being followed; ownership
// is set on the descriptor, never by path.
function writeAtomic(target, content, { mode = 0o644, uid, gid } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.whm-${randomSuffix()}`;
  let fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  try {
    if (uid != null) fs.fchownSync(fd, uid, gid);
    fs.fchmodSync(fd, mode);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd != null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// For root-owned config trees (/etc/php, /etc/nginx) where a sibling backup is safe.
function writeIni(target, content) {
  const backup = fs.existsSync(target) ? `${target}.whm-bak` : null;
  if (backup) fs.copyFileSync(target, backup);
  writeAtomic(target, content);
  return backup;
}

function restoreIni(target, backup) {
  if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, target); else fs.rmSync(target, { force: true });
}

// .user.ini lives in a directory the account itself can write to, so every step
// assumes a hostile neighbour: the docroot is resolved with realpath and pinned
// under the account's home, the file must be a regular (non-link) file owned by
// the account, reads open with O_NOFOLLOW, and no root-owned backup or
// predictable temp name is ever left in the directory.
function userIniTarget(docroot, owner, ctx) {
  ctx.assertAllowedPath(docroot, 'read');
  let real;
  try { real = fs.realpathSync(docroot); } catch { throw new OpError('not_found', `Document root ${docroot} does not exist`); }
  ctx.assertAllowedPath(real, 'read');
  if (!fs.lstatSync(real).isDirectory()) throw new OpError('refused', `${docroot} is not a directory`);
  const account = owner ? passwdEntry(owner) : null;
  if (account) {
    let home;
    try { home = fs.realpathSync(account.home); } catch { throw new OpError('not_found', `Home directory of "${owner}" does not exist`); }
    if (real !== home && !real.startsWith(`${home}/`)) throw new OpError('refused', `Document root ${docroot} resolves to ${real}, outside the home directory of "${owner}"`);
  }
  return { docroot: real, target: path.join(real, '.user.ini'), account };
}

const ownedBy = (st, account) => (account ? st.uid === account.uid : st.uid === 0 || st.uid === process.getuid());

function inspectUserIni(target, account) {
  let st;
  try { st = fs.lstatSync(target); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (st.isSymbolicLink()) throw new OpError('refused', `${target} is a symbolic link; refusing to follow it`);
  if (!st.isFile()) throw new OpError('refused', `${target} is not a regular file`);
  if (!ownedBy(st, account)) throw new OpError('refused', `${target} is owned by uid ${st.uid}, not by ${account ? `"${account.name}" (uid ${account.uid})` : 'root'}`);
  if (st.size > 1024 * 1024) throw new OpError('refused', `${target} is larger than 1 MiB`);
  return st;
}

function readUserIni(target, account) {
  if (!inspectUserIni(target, account)) return null;
  let fd;
  try { fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW); } catch (err) { throw new OpError('refused', `${target} could not be opened without following links (${err.code})`); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || !ownedBy(st, account)) throw new OpError('refused', `${target} changed while it was being read`);
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function writeUserIni(target, content, account) {
  inspectUserIni(target, account);
  const tmp = `${target}.whm-${randomSuffix()}`;
  let fd;
  try { fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644); } catch (err) { throw new OpError('refused', `Could not create ${tmp} (${err.code})`); }
  try {
    if (account) fs.fchownSync(fd, account.uid, account.gid);
    fs.fchmodSync(fd, 0o644);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    inspectUserIni(target, account);
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd != null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// --- background runs ---------------------------------------------------------

const runPaths = (id) => ({ state: path.join(runDir(), `${id}.json`), log: path.join(runDir(), `${id}.log`) });

function readRunState(id) {
  try { return JSON.parse(fs.readFileSync(runPaths(id).state, 'utf8')); } catch { return null; }
}

function writeRunState(state) {
  writeAtomic(runPaths(state.id).state, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function sweepRuns() {
  const cutoff = Date.now() - RUN_RETENTION_MS;
  for (const file of safeReaddir(runDir())) {
    const full = path.join(runDir(), file);
    try { if (fs.lstatSync(full).isFile() && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }); } catch { /* raced */ }
  }
}

// `/proc/<pid>/cmdline` is checked as well as liveness so a recycled pid is not
// mistaken for the installer after a reboot or a daemon restart.
function runAlive(state) {
  try {
    const cmdline = fs.readFileSync(`/proc/${state.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    // A process may rewrite argv[0] as a title ("node (vitest 1)"); the binary name is its first word.
    return cmdline.length > 0 && path.basename(cmdline[0].split(' ')[0]) === path.basename(state.bin);
  } catch { return false; }
}

// Starts a command detached from the agent with stdout/stderr in a log file.
// The exit code is recorded by the agent when it sees it; when the agent was
// restarted meanwhile, pkg.run.status reports the run as lost and the caller
// verifies the outcome (package presence) itself.
export function startRun({ kind, bin, argv, env, input, timeoutMs }, ctx) {
  const resolvedBin = resolveBinary(bin);
  if (!resolvedBin) throw new OpError('binary_not_found', `Required program "${bin}" is not installed on this server`);
  for (const a of argv) if (typeof a !== 'string' || a.includes('\0')) throw new OpError('bad_argument', 'Command arguments must be NUL-free strings');
  ctx.assertAllowedPath(runDir(), 'write');
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  sweepRuns();
  const id = `${Date.now().toString(36)}-${randomSuffix()}`;
  const paths = runPaths(id);
  const fd = fs.openSync(paths.log, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  let child;
  try {
    child = spawn(resolvedBin, argv, { stdio: [input != null ? 'pipe' : 'ignore', fd, fd], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin', LANG: 'C', LC_ALL: 'C', ...env }, detached: true, windowsHide: true });
  } finally { fs.closeSync(fd); }
  const state = { id, kind, bin: resolvedBin, argv, pid: child.pid, startedAt: new Date().toISOString(), timeoutMs, status: 'running', code: null, signal: null, finishedAt: null, error: null, logPath: paths.log };
  writeRunState(state);
  // A poll may already have marked the run as timed out; that verdict stands.
  const conclude = (patch) => { try { const current = readRunState(id); if (!current || current.status !== 'running') return; writeRunState({ ...current, ...patch, finishedAt: new Date().toISOString() }); } catch { /* state dir gone */ } };
  child.on('error', (err) => conclude({ status: 'failed', error: err.message }));
  child.on('exit', (code, signal) => conclude({ status: signal ? 'killed' : 'finished', code, signal, error: signal ? `terminated by ${signal}` : null }));
  if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  child.unref();
  return state;
}

export async function pollRun(id, { offset = 0, maxBytes = 256 * 1024 } = {}, ctx) {
  ctx.assertAllowedPath(runDir(), 'read');
  let state = readRunState(id);
  if (!state) throw new OpError('not_found', `Unknown package run "${id}"`);
  if (state.status === 'running' && !runAlive(state)) {
    // The child's exit handler records the code a tick after the process is
    // gone; give it a moment before concluding the record was lost (agent restart).
    for (let i = 0; i < 20 && state.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = readRunState(id) || state;
    }
  }
  if (state.status === 'running' && !runAlive(state)) {
    state = { ...state, status: 'lost', finishedAt: new Date().toISOString(), error: 'the installer is no longer running but its exit status was not recorded (agent restarted?)' };
    writeRunState(state);
  } else if (state.status === 'running' && Date.now() - Date.parse(state.startedAt) > state.timeoutMs) {
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
    state = { ...state, status: 'timeout', finishedAt: new Date().toISOString(), error: `did not finish within ${Math.round(state.timeoutMs / 60_000)} minutes and was terminated` };
    writeRunState(state);
  }
  let size = 0;
  let chunk = '';
  try {
    size = fs.statSync(state.logPath).size;
    if (size > offset) {
      const length = Math.min(size - offset, maxBytes);
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(state.logPath, O_RDONLY | O_NOFOLLOW);
      try { fs.readSync(fd, buf, 0, length, offset); } finally { fs.closeSync(fd); }
      chunk = buf.toString('utf8');
    }
  } catch { /* log unreadable */ }
  // Only whole lines are handed out; a partial last line waits for the next poll.
  let consumed = chunk.length ? Buffer.byteLength(chunk) : 0;
  if (chunk.length && state.status === 'running' && !chunk.endsWith('\n')) {
    const cut = chunk.lastIndexOf('\n');
    chunk = cut >= 0 ? chunk.slice(0, cut + 1) : '';
    consumed = Buffer.byteLength(chunk);
  }
  const output = chunk.split('\n').map((l) => l.replace(/\r/g, '')).filter((l) => l.trim());
  return { ...state, output, offset: offset + consumed, logBytes: size, done: state.status !== 'running' };
}

async function runLong({ kind, bin, argv, env, input, timeoutMs = LONG, wait: waitFor = true, allowFailure = false }, ctx) {
  if (!waitFor) return { background: true, run: startRun({ kind, bin, argv, env, input, timeoutMs }, ctx) };
  const r = await exec(bin, argv, { env, input, timeoutMs, maxBuffer: BIG, allowFailure });
  return { background: false, code: r.code, output: tail(`${r.stdout}\n${r.stderr}`), stdout: r.stdout, stderr: r.stderr };
}

const finished = ({ background, code, output, run }) => (background ? { background, run } : { background, code, output });

defineOp('pkg.run.status', {
  description: 'State and new output of a background package run started with wait: false',
  schema: z.object({ id: runId, offset: z.number().int().min(0).default(0), maxBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(256 * 1024) }).strict(),
  run: async ({ id, offset, maxBytes }, ctx) => pollRun(id, { offset, maxBytes }, ctx),
});

async function rebootRequired() {
  if (fs.existsSync('/var/run/reboot-required')) return true;
  if (hasBinary('needs-restarting')) return (await exec('needs-restarting', ['-r'], { allowFailure: true, timeoutMs: 60_000 })).code === 1;
  return false;
}

defineOp('pkg.reboot_required', {
  description: 'Whether pending updates need a reboot (/var/run/reboot-required or needs-restarting -r)',
  run: async () => ({ rebootRequired: await rebootRequired() }),
});

// --- distro packages -------------------------------------------------------

defineOp('pkg.detect', {
  description: 'Which package manager this host uses (apt / dnf / yum) and whether rpm is present',
  run: async () => {
    const pm = detectManager();
    return { ...pm, rebootRequired: fs.existsSync('/var/run/reboot-required') };
  },
});

async function installedPackages() {
  const pm = requireManager();
  if (pm.family === 'debian') {
    const { stdout } = await exec('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\t${binary:Summary}\n'], { maxBuffer: 64 * 1024 * 1024 });
    return { pm, packages: parseInstalledList(stdout) };
  }
  const { stdout } = await exec('rpm', ['-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\tii\t%{SUMMARY}\n'], { maxBuffer: 64 * 1024 * 1024 });
  return { pm, packages: parseInstalledList(stdout) };
}

defineOp('pkg.list_installed', {
  description: 'Installed distro packages (dpkg-query / rpm -qa)',
  schema: z.object({ q: searchTerm.optional(), prefix: z.array(pkgName).max(50).optional() }).strict(),
  run: async ({ q, prefix }) => {
    const { pm, packages } = await installedPackages();
    let list = packages;
    if (q) { const needle = q.toLowerCase(); list = list.filter((p) => p.name.toLowerCase().includes(needle) || (p.summary || '').toLowerCase().includes(needle)); }
    if (prefix?.length) list = list.filter((p) => prefix.some((pre) => p.name === pre || p.name.startsWith(pre)));
    return { manager: pm.manager, total: packages.length, packages: list.sort((a, b) => a.name.localeCompare(b.name)) };
  },
});

// Several words are separate argv tokens: apt-cache search and dnf/yum search
// list the packages matching every one of them.
defineOp('pkg.search', {
  description: 'Search the package repositories by name',
  timeoutMs: 120_000,
  schema: z.object({ q: z.union([searchTerm, z.array(searchTerm).min(1).max(4)]), limit: z.number().int().min(1).max(500).default(100) }).strict(),
  run: async ({ q, limit }) => {
    const pm = requireManager();
    const terms = Array.isArray(q) ? q : [q];
    let results;
    if (pm.family === 'debian') {
      const { stdout } = await exec('apt-cache', ['search', '--names-only', '--', ...terms], { allowFailure: true, env: APT_ENV });
      results = parseAptSearch(stdout);
    } else {
      const { stdout } = await exec(pm.binary, ['-q', '-y', 'search', '--', ...terms], { allowFailure: true, timeoutMs: 120_000 });
      results = parseDnfSearch(stdout);
    }
    const needle = terms[0].toLowerCase();
    results.sort((a, b) => (a.name.toLowerCase() === needle ? -1 : b.name.toLowerCase() === needle ? 1 : a.name.toLowerCase().startsWith(needle) === b.name.toLowerCase().startsWith(needle) ? a.name.localeCompare(b.name) : a.name.toLowerCase().startsWith(needle) ? -1 : 1));
    results = results.slice(0, limit);
    const installed = new Map((await installedPackages()).packages.map((p) => [p.name, p.version]));
    return { manager: pm.manager, q: terms.join(' '), results: results.map((r) => ({ ...r, installed: installed.has(r.name), installedVersion: installed.get(r.name) ?? null })) };
  },
});

defineOp('pkg.info', {
  description: 'Installed and candidate version plus description of one package',
  schema: z.object({ name: pkgName }).strict(),
  run: async ({ name }) => {
    const pm = requireManager();
    if (pm.family === 'debian') {
      const policy = parseAptPolicy((await exec('apt-cache', ['policy', '--', name], { allowFailure: true, env: APT_ENV })).stdout);
      const show = parseKeyValueBlock((await exec('apt-cache', ['show', '--', name], { allowFailure: true, env: APT_ENV })).stdout);
      return { manager: pm.manager, name, ...policy, summary: show['Description-en'] || show.Description || null, section: show.Section || null, homepage: show.Homepage || null, size: show['Installed-Size'] ? Number(show['Installed-Size']) * 1024 : null };
    }
    const info = parseKeyValueBlock((await exec(pm.binary, ['-q', '-y', 'info', '--', name], { allowFailure: true, timeoutMs: 120_000 })).stdout);
    const { stdout: inst, code } = await exec('rpm', ['-q', '--qf', '%{VERSION}-%{RELEASE}', '--', name], { allowFailure: true });
    return { manager: pm.manager, name, installed: code === 0 ? inst.trim() : null, candidate: info.Version ? `${info.Version}${info.Release ? `-${info.Release}` : ''}` : null, summary: info.Summary || null, section: info.Repository || info['From repo'] || null, homepage: info.URL || null, size: null };
  },
});

defineOp('pkg.install', {
  description: 'Install distro packages non-interactively',
  timeoutMs: LONG,
  schema: z.object({ packages: z.array(pkgName).min(1).max(200), noRecommends: z.boolean().default(false), wait }).strict(),
  run: async ({ packages, noRecommends, wait: waitFor }, ctx) => {
    const pm = requireManager();
    const argv = pm.family === 'debian'
      ? ['install', '-y', '-q', ...APT_DPKG_OPTS, ...(noRecommends ? ['--no-install-recommends'] : []), '--', ...packages]
      : ['-y', '-q', 'install', '--', ...packages];
    return { manager: pm.manager, packages, ...finished(await runLong({ kind: 'install', bin: pm.binary, argv, env: APT_ENV, wait: waitFor }, ctx)) };
  },
});

// `apt-get -s remove` prints "Remv pkg [version]" (and "Purg") per package the
// transaction would take out, dependents included.
export function parseAptRemoveSimulation(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(?:Remv|Purg) (\S+)(?: \[([^\]]*)\])?/);
    if (m && !out.some((p) => p.name === m[1])) out.push({ name: m[1], version: m[2] || null, section: 'remove' });
  }
  return out;
}

// `dnf remove --assumeno` prints a transaction table with "Removing:",
// "Removing dependent packages:" and "Removing unused dependencies:" sections.
export function parseDnfRemoveSimulation(stdout) {
  const out = [];
  let section = null;
  for (const line of stdout.split('\n')) {
    if (/^Removing:/.test(line)) { section = 'remove'; continue; }
    if (/^Removing dependent packages:/.test(line)) { section = 'dependent'; continue; }
    if (/^Removing unused dependencies:/.test(line)) { section = 'unused'; continue; }
    if (/^(Transaction Summary|Installing|Upgrading|Downgrading)/.test(line) || /^=+$/.test(line.trim())) { if (/^Transaction Summary/.test(line)) section = null; continue; }
    if (!section || !/^\s+\S/.test(line)) continue;
    const m = line.match(/^\s+(\S+)\s+(noarch|x86_64|i686|aarch64|src)\s+(\S+)/);
    if (m && !out.some((p) => p.name === m[1])) out.push({ name: m[1], version: m[3], section });
  }
  return out;
}

// The package manager's own dry run over installed package names (apt-get -s
// remove / dnf remove --assumeno): every package the transaction would take
// out, reverse dependencies included. Changes nothing.
async function simulateRemoval(pm, present, purge) {
  if (pm.family === 'debian') {
    const r = await exec('apt-get', ['-s', '-q', '-o', 'Debug::NoLocking=true', purge ? 'purge' : 'remove', '--', ...present], { env: APT_ENV, allowFailure: true, timeoutMs: 5 * 60_000, maxBuffer: BIG });
    if (r.code !== 0) throw new OpError('command_failed', `apt-get could not simulate the removal: ${r.stderr.trim().split('\n').pop() || 'unknown error'}`, { output: tail(`${r.stdout}\n${r.stderr}`, 50) });
    return { removed: parseAptRemoveSimulation(r.stdout), output: tail(r.stdout, 200) };
  }
  const r = await exec(pm.binary, ['-q', 'remove', '--assumeno', '--', ...present], { allowFailure: true, timeoutMs: 5 * 60_000, maxBuffer: BIG });
  const removed = parseDnfRemoveSimulation(`${r.stdout}\n${r.stderr}`);
  if (!removed.length && r.code !== 0 && !/Operation aborted|Nothing to do/i.test(`${r.stdout}\n${r.stderr}`)) throw new OpError('command_failed', `${pm.binary} could not simulate the removal: ${r.stderr.trim().split('\n').pop() || 'unknown error'}`, { output: tail(`${r.stdout}\n${r.stderr}`, 50) });
  return { removed, output: tail(`${r.stdout}\n${r.stderr}`, 200) };
}

defineOp('pkg.remove_simulate', {
  description: 'Which packages a removal would take out, reverse dependencies included (apt-get -s remove / dnf remove --assumeno); changes nothing',
  timeoutMs: 5 * 60_000,
  schema: z.object({ packages: z.array(pkgName).min(1).max(200), purge: z.boolean().default(false) }).strict(),
  run: async ({ packages, purge }) => {
    const pm = requireManager();
    const installed = new Set((await installedPackages()).packages.map((p) => p.name));
    const present = packages.filter((p) => installed.has(p));
    if (!present.length) return { manager: pm.manager, requested: packages, present, remove: [], collateral: [], output: [] };
    const { removed, output } = await simulateRemoval(pm, present, purge);
    const requested = new Set(present);
    return { manager: pm.manager, requested: packages, present, remove: removed.map((p) => p.name), collateral: removed.filter((p) => !requested.has(p.name)), output };
  },
});

defineOp('pkg.remove', {
  description: 'Remove (or purge) distro packages',
  destructive: true,
  timeoutMs: LONG,
  schema: z.object({ packages: z.array(pkgName).min(1).max(200), purge: z.boolean().default(false), wait }).strict(),
  run: async ({ packages, purge, wait: waitFor }, ctx) => {
    const pm = requireManager();
    const argv = pm.family === 'debian' ? [purge ? 'purge' : 'remove', '-y', '-q', ...APT_DPKG_OPTS, '--', ...packages] : ['-y', '-q', 'remove', '--', ...packages];
    return { manager: pm.manager, packages, purge, ...finished(await runLong({ kind: 'remove', bin: pm.binary, argv, env: APT_ENV, wait: waitFor }, ctx)) };
  },
});

defineOp('pkg.update_index', {
  description: 'Refresh the package index (apt-get update / dnf makecache)',
  timeoutMs: 15 * 60_000,
  schema: z.object({ wait }).strict(),
  run: async ({ wait: waitFor }, ctx) => {
    const pm = requireManager();
    const argv = pm.family === 'debian' ? ['update', '-q'] : ['-y', '-q', 'makecache'];
    return { manager: pm.manager, ...finished(await runLong({ kind: 'update_index', bin: pm.binary, argv, env: APT_ENV, timeoutMs: 15 * 60_000, wait: waitFor }, ctx)) };
  },
});

defineOp('pkg.upgradable', {
  description: 'Packages with pending updates (simulation; changes nothing)',
  timeoutMs: 5 * 60_000,
  run: async () => {
    const pm = requireManager();
    let packages;
    if (pm.family === 'debian') {
      const { stdout } = await exec('apt-get', ['-s', '-q', '-o', 'Debug::NoLocking=true', 'dist-upgrade'], { env: APT_ENV, allowFailure: true, timeoutMs: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      packages = parseAptSimulation(stdout);
    } else {
      const { stdout } = await exec(pm.binary, ['-q', '-y', 'check-update'], { allowFailure: true, timeoutMs: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      packages = parseDnfCheckUpdate(stdout);
    }
    return { manager: pm.manager, count: packages.length, security: packages.filter((p) => p.security).length, packages, rebootRequired: fs.existsSync('/var/run/reboot-required') };
  },
});

// With wait: false the autoremove pass is not chained; the caller runs
// pkg.autoremove as its own step once the upgrade run has finished.
defineOp('pkg.upgrade', {
  description: 'Apply all pending OS updates non-interactively',
  timeoutMs: LONG,
  schema: z.object({ dist: z.boolean().default(true), autoremove: z.boolean().default(false), packages: z.array(pkgName).max(200).optional(), wait }).strict(),
  run: async ({ dist, autoremove, packages, wait: waitFor }, ctx) => {
    const pm = requireManager();
    const argv = pm.family === 'debian'
      ? [packages?.length ? 'install' : dist ? 'dist-upgrade' : 'upgrade', '-y', '-q', ...APT_DPKG_OPTS, ...(packages?.length ? ['--only-upgrade', '--', ...packages] : [])]
      : ['-y', '-q', 'upgrade', ...(packages?.length ? ['--', ...packages] : [])];
    const result = await runLong({ kind: 'upgrade', bin: pm.binary, argv, env: APT_ENV, wait: waitFor }, ctx);
    if (result.background) return { manager: pm.manager, ...finished(result), autoremovePending: autoremove };
    let autoremoveOutput = [];
    if (autoremove) {
      const r = await exec(pm.binary, pm.family === 'debian' ? ['autoremove', '-y', '-q'] : ['-y', '-q', 'autoremove'], { env: APT_ENV, allowFailure: true, timeoutMs: LONG });
      autoremoveOutput = tail(`${r.stdout}\n${r.stderr}`, 100);
    }
    return { manager: pm.manager, ...finished(result), autoremoveOutput, rebootRequired: await rebootRequired() };
  },
});

defineOp('pkg.autoremove', {
  description: 'Remove packages that were installed as dependencies and are no longer needed',
  destructive: true,
  timeoutMs: LONG,
  schema: z.object({ wait }).strict(),
  run: async ({ wait: waitFor }, ctx) => {
    const pm = requireManager();
    const argv = pm.family === 'debian' ? ['autoremove', '-y', '-q', ...APT_DPKG_OPTS] : ['-y', '-q', 'autoremove'];
    return { manager: pm.manager, ...finished(await runLong({ kind: 'autoremove', bin: pm.binary, argv, env: APT_ENV, wait: waitFor }, ctx)) };
  },
});

async function rpmCount() {
  return (await exec('rpm', ['-qa'], { allowFailure: true, maxBuffer: BIG })).stdout.split('\n').filter(Boolean).length;
}

defineOp('pkg.rebuild_rpmdb', {
  description: 'Rebuild the RPM database (rpm --rebuilddb); RHEL-family only',
  timeoutMs: 30 * 60_000,
  schema: z.object({ wait }).strict(),
  run: async ({ wait: waitFor }, ctx) => {
    if (!hasBinary('rpm')) throw new OpError('capability_missing', 'rpm is not installed; the RPM database only exists on RHEL-family systems (AlmaLinux, Rocky, CloudLinux, CentOS, Fedora)');
    const before = await rpmCount();
    const result = await runLong({ kind: 'rebuild_rpmdb', bin: 'rpm', argv: ['--rebuilddb'], timeoutMs: 30 * 60_000, wait: waitFor }, ctx);
    if (result.background) return { rebuilt: null, packagesBefore: before, ...finished(result) };
    return { rebuilt: true, packagesBefore: before, packagesAfter: await rpmCount(), ...finished(result), output: result.output.slice(-50) };
  },
});

defineOp('pkg.rpm_count', {
  description: 'Number of packages in the RPM database',
  run: async () => {
    if (!hasBinary('rpm')) throw new OpError('capability_missing', 'rpm is not installed');
    return { packages: await rpmCount() };
  },
});

// --- language module installers -------------------------------------------

const INSTALLERS = ['perl', 'cpan', 'cpanm', 'php', 'pecl', 'pear', 'ruby', 'gem', 'python3', 'pip3', 'pip'];

defineOp('pkg.module.detect', {
  description: 'Which language runtimes and module installers are present',
  run: async () => {
    const present = Object.fromEntries(INSTALLERS.map((b) => [b, hasBinary(b)]));
    const versions = {};
    const probe = async (bin, argv, re) => { if (!present[bin]) return; const r = await exec(bin, argv, { allowFailure: true, timeoutMs: 15_000 }); versions[bin] = (`${r.stdout}\n${r.stderr}`).match(re)?.[1] ?? null; };
    await probe('perl', ['-e', 'print $^V'], /v?(\d[\d.]+)/);
    await probe('php', ['-n', '-r', 'echo PHP_VERSION;'], /(\d[\d.]+)/);
    await probe('ruby', ['--version'], /ruby (\d[\d.]+)/);
    await probe('python3', ['--version'], /Python (\d[\d.]+)/);
    return { present, versions, perl: present.cpanm ? 'cpanm' : present.cpan ? 'cpan' : null, pip: present.pip3 ? 'pip3' : present.pip ? 'pip' : null };
  },
});

defineOp('pkg.perl.list', {
  description: 'Installed Perl modules (ExtUtils::Installed)',
  timeoutMs: 120_000,
  run: async () => {
    if (!hasBinary('perl')) throw new OpError('capability_missing', 'perl is not installed');
    const { stdout } = await exec('perl', ['-MExtUtils::Installed', '-e', 'my $i = ExtUtils::Installed->new(skip_cwd => 1); print join("\n", map { $_ . "\t" . ($i->version($_) // "") } $i->modules), "\n";'], { timeoutMs: 120_000, maxBuffer: 32 * 1024 * 1024 });
    return { modules: parsePerlModules(stdout) };
  },
});

defineOp('pkg.perl.install', {
  description: 'Install Perl modules from CPAN (cpanm, or cpan non-interactively)',
  timeoutMs: LONG,
  schema: z.object({ modules: z.array(perlModule).min(1).max(50), notest: z.boolean().default(true), wait }).strict(),
  run: async ({ modules, notest, wait: waitFor }, ctx) => {
    const env = { PERL_MM_USE_DEFAULT: '1', NONINTERACTIVE_TESTING: '1', AUTOMATED_TESTING: '1', PERL_AUTOINSTALL: '--defaultdeps', HOME: '/root' };
    if (hasBinary('cpanm')) return { installer: 'cpanm', modules, ...finished(await runLong({ kind: 'cpanm', bin: 'cpanm', argv: [...(notest ? ['--notest'] : []), '--quiet', '--', ...modules], env, wait: waitFor }, ctx)) };
    if (hasBinary('cpan')) return { installer: 'cpan', modules, ...finished(await runLong({ kind: 'cpan', bin: 'cpan', argv: [...(notest ? ['-T'] : []), '-i', ...modules], env, wait: waitFor }, ctx)) };
    throw new OpError('capability_missing', 'Neither cpanm nor cpan is installed; install the "cpanminus" (Debian) or "perl-App-cpanminus" (RHEL) package');
  },
});

defineOp('pkg.pecl.list', {
  description: 'Installed PECL extensions',
  run: async () => {
    if (!hasBinary('pecl')) throw new OpError('capability_missing', 'pecl is not installed; install php-pear');
    const { stdout } = await exec('pecl', ['list'], { allowFailure: true });
    return { extensions: parsePeclList(stdout) };
  },
});

export const peclIniHint = (text) => String(text ?? '').match(/You should add "([^"]+)" to php\.ini/)?.[1] ?? null;

defineOp('pkg.pecl.install', {
  description: 'Install a PECL extension (accepts the default answer to every build prompt)',
  timeoutMs: LONG,
  schema: z.object({ extension: peclExtension, force: z.boolean().default(false), wait }).strict(),
  run: async ({ extension, force, wait: waitFor }, ctx) => {
    if (!hasBinary('pecl')) throw new OpError('capability_missing', 'pecl is not installed; install php-pear (and php-dev / php-devel for building)');
    const result = await runLong({ kind: 'pecl', bin: 'pecl', argv: ['install', ...(force ? ['-f'] : []), extension], input: '\n'.repeat(40), wait: waitFor }, ctx);
    return { installer: 'pecl', extension, ...finished(result), iniHint: result.background ? null : peclIniHint(result.stdout) };
  },
});

defineOp('pkg.pear.list', {
  description: 'Installed PEAR packages',
  run: async () => {
    if (!hasBinary('pear')) throw new OpError('capability_missing', 'pear is not installed; install php-pear');
    const { stdout } = await exec('pear', ['list'], { allowFailure: true });
    return { packages: parsePeclList(stdout) };
  },
});

defineOp('pkg.pear.install', {
  description: 'Install a PEAR package',
  timeoutMs: LONG,
  schema: z.object({ package: pearPackage, wait }).strict(),
  run: async ({ package: name, wait: waitFor }, ctx) => {
    if (!hasBinary('pear')) throw new OpError('capability_missing', 'pear is not installed; install php-pear');
    return { installer: 'pear', package: name, ...finished(await runLong({ kind: 'pear', bin: 'pear', argv: ['install', '--alldeps', name], input: '\n'.repeat(10), wait: waitFor }, ctx)) };
  },
});

defineOp('pkg.gem.list', {
  description: 'Installed Ruby gems',
  run: async () => {
    if (!hasBinary('gem')) throw new OpError('capability_missing', 'Ruby (gem) is not installed; install the ruby package');
    const { stdout } = await exec('gem', ['list', '--local'], { timeoutMs: 120_000 });
    return { gems: parseGemList(stdout) };
  },
});

defineOp('pkg.gem.install', {
  description: 'Install a Ruby gem (no documentation)',
  timeoutMs: LONG,
  schema: z.object({ gem: gemName, version: versionSpec.optional(), wait }).strict(),
  run: async ({ gem, version, wait: waitFor }, ctx) => {
    if (!hasBinary('gem')) throw new OpError('capability_missing', 'Ruby (gem) is not installed; install the ruby package');
    return { installer: 'gem', gem, version: version ?? null, ...finished(await runLong({ kind: 'gem', bin: 'gem', argv: ['install', '--no-document', ...(version ? ['-v', version] : []), '--', gem], wait: waitFor }, ctx)) };
  },
});

const pipBinary = () => (hasBinary('pip3') ? 'pip3' : hasBinary('pip') ? 'pip' : null);

defineOp('pkg.pip.list', {
  description: 'Installed Python packages (system interpreter)',
  run: async () => {
    const pip = pipBinary();
    if (!pip) throw new OpError('capability_missing', 'pip is not installed; install python3-pip');
    const { stdout } = await exec(pip, ['list', '--format=json', '--disable-pip-version-check'], { timeoutMs: 120_000, maxBuffer: 32 * 1024 * 1024 });
    let parsed = [];
    try { parsed = JSON.parse(stdout); } catch { parsed = []; }
    return { packages: parsed.map((p) => ({ name: p.name, version: p.version })) };
  },
});

// PEP 668 distributions mark the system interpreter as externally managed and
// pip refuses to touch its site-packages unless told to.
async function externallyManaged() {
  if (!hasBinary('python3')) return false;
  const r = await exec('python3', ['-c', 'import sysconfig; print(sysconfig.get_path("stdlib"))'], { allowFailure: true, timeoutMs: 15_000 });
  const stdlib = r.stdout.trim();
  return r.code === 0 && stdlib.startsWith('/') && fs.existsSync(path.join(stdlib, 'EXTERNALLY-MANAGED'));
}

defineOp('pkg.pip.install', {
  description: 'Install a Python package into the system interpreter',
  timeoutMs: LONG,
  schema: z.object({ package: pipName, version: versionSpec.optional(), upgrade: z.boolean().default(false), wait }).strict(),
  run: async ({ package: name, version, upgrade, wait: waitFor }, ctx) => {
    const pip = pipBinary();
    if (!pip) throw new OpError('capability_missing', 'pip is not installed; install python3-pip');
    const spec = version ? `${name}==${version}` : name;
    const argv = ['install', '--disable-pip-version-check', ...(upgrade ? ['--upgrade'] : []), ...((await externallyManaged()) ? ['--break-system-packages'] : []), '--', spec];
    const result = await runLong({ kind: 'pip', bin: pip, argv, wait: waitFor, allowFailure: true }, ctx);
    if (!result.background && result.code !== 0) throw new OpError('command_failed', `pip exited with status ${result.code}: ${result.stderr.trim().split('\n').pop()}`, { output: result.output });
    return { installer: pip, package: name, version: version ?? null, ...finished(result) };
  },
});

// --- PHP ---------------------------------------------------------------------

defineOp('pkg.php.versions', {
  description: 'Installed PHP versions (Debian /etc/php/*, EA4 /opt/cpanel/ea-php*, Remi, RHEL stock) with ini paths and FPM units',
  timeoutMs: 120_000,
  schema: z.object({ modules: z.boolean().default(false) }).strict(),
  run: async ({ modules }) => {
    const { versions, defaultId, defaultBinary } = discoverPhp();
    const out = [];
    for (const v of versions) {
      const ver = await exec(v.binary, ['-n', '-r', 'echo PHP_VERSION;'], { allowFailure: true, timeoutMs: 20_000 });
      const entry = { ...v, version: ver.stdout.trim().match(/^\d[\d.]*/)?.[0] ?? null, isDefault: v.id === defaultId, fpmActive: await unitActive(v.fpmUnit), fpmInstalled: hasBinary(`php-fpm${v.id}`) || fs.existsSync(`/usr/sbin/php-fpm${v.id}`) || fs.existsSync(path.join(path.dirname(v.binary), '..', 'sbin', 'php-fpm')) || fs.existsSync(v.poolDir || '/nonexistent') };
      if (modules) {
        const m = await exec(v.binary, ['-m'], { allowFailure: true, timeoutMs: 20_000 });
        entry.modules = m.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('['));
      }
      out.push(entry);
    }
    return { versions: out, defaultId, defaultBinary };
  },
});

defineOp('pkg.php.default.set', {
  description: 'Point /usr/bin/php at a PHP version via update-alternatives / alternatives',
  schema: z.object({ version: phpVersionId }).strict(),
  run: async ({ version }) => {
    const v = phpVersion(version);
    const tool = hasBinary('update-alternatives') ? 'update-alternatives' : hasBinary('alternatives') ? 'alternatives' : null;
    if (!tool) throw new OpError('unsupported', 'Neither update-alternatives nor alternatives exists; set the CLI default manually');
    const r = await exec(tool, ['--set', 'php', v.binary], { allowFailure: true });
    if (r.code !== 0) {
      await exec(tool, ['--install', '/usr/bin/php', 'php', v.binary, '50']);
      await exec(tool, ['--set', 'php', v.binary]);
    }
    return { version, binary: v.binary, tool };
  },
});

// The package glob of one PHP build, by packaging layout; only names the
// package manager reports under that glob are passed on, so the argv never
// carries anything but installed package names.
export function phpPackageGlob(v) {
  if (v.layout === 'debian') return `php${v.id}-*`;
  if (v.layout === 'ea4') return `${v.id}-*`;
  if (v.layout === 'remi' || v.layout === 'scl') return `${v.id}-php-*`;
  if (v.layout === 'rhel') return 'php-*';
  return null;
}

// Discovery reads /etc/php, /opt/cpanel, /opt/remi and /usr/bin, which no test host carries; tests swap `discover`.
export const phpDiscovery = { discover: discoverPhp };

// A Keel source build is one prefix, one unit and one link; /etc/php is never touched.
async function removeKeelPhp(minor, ctx) {
  if (!phpMinor.safeParse(minor).success) throw new OpError('invalid_args', `"${minor}" is not a PHP minor this panel builds`);
  const root = keelPhpDir();
  if (root !== KEEL_PHP_DIR) ctx.assertAllowedPath(root, 'write');
  const prefix = path.join(root, minor);
  const unit = keelPhpUnit(minor);
  const unitFile = ctx.assertAllowedPath(path.join(systemdUnitDir(), `${unit}.service`), 'write');
  const link = ctx.assertAllowedPath(path.join(localBinDir(), `php${minor}`), 'write');
  ctx.assertAllowedPath(prefix, 'write');
  let unitRemoved = false;
  if (hasBinary('systemctl')) await exec('systemctl', ['disable', '--now', `${unit}.service`], { allowFailure: true, timeoutMs: 180_000 });
  try { fs.unlinkSync(unitFile); unitRemoved = true; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (unitRemoved && hasBinary('systemctl')) await exec('systemctl', ['daemon-reload'], { allowFailure: true, timeoutMs: 120_000 });
  let linkRemoved = false;
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() && fs.readlinkSync(link).startsWith(`${prefix}/`)) { fs.unlinkSync(link); linkRemoved = true; }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let removed = false;
  try {
    const st = fs.lstatSync(prefix);
    if (st.isSymbolicLink()) throw new OpError('refused', `${prefix} is a symbolic link; refusing to follow it`);
    fs.rmSync(prefix, { recursive: true, force: true });
    removed = true;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const builds = removeBuildDirs(root, minor);
  fs.rmSync(buildLockPath(root, minor), { force: true });
  return { version: minor, layout: 'keel', manager: null, packages: [], purge: true, background: false, code: 0, output: [], prefix, removed, unit, unitRemoved, link, linkRemoved, buildDirsRemoved: builds };
}

defineOp('pkg.php.remove', {
  description: 'Remove every package of one installed PHP version (or the prefix, unit and link of a Keel source build); refuses the CLI default, the last remaining version and a removal that would take other packages with it (unless force), keeps /etc/php/<ver> unless purge; dry only simulates',
  destructive: true,
  timeoutMs: LONG,
  schema: z.object({ version: phpVersionId, purge: z.boolean().default(false), force: z.boolean().default(false), extra: z.array(pkgName).max(200).default([]), dry: z.boolean().default(false), wait }).strict(),
  run: async ({ version, purge, force, extra: confirmed, dry, wait: waitFor }, ctx) => {
    const { versions, defaultId } = phpDiscovery.discover();
    const v = versions.find((x) => x.id === version);
    if (!v) throw new OpError('not_found', `PHP version "${version}" is not installed on this server`);
    if (v.id === defaultId) throw new OpError('refused', `PHP ${version} is the CLI default (/usr/bin/php); make another version the default first`);
    if (versions.length < 2) throw new OpError('refused', `PHP ${version} is the only installed version; install another one before removing it`);
    if (v.layout === 'keel') {
      if (dry) return { version, layout: 'keel', manager: null, packages: [], purge, dry: true, remove: [], extra: [], output: [] };
      return removeKeelPhp(v.id, ctx);
    }
    const glob = phpPackageGlob(v);
    if (!glob) throw new OpError('unsupported', `PHP ${version} (${v.binary}) is not a packaged build this panel can remove`);
    const pm = requireManager();
    const prefix = glob.slice(0, -1);
    let packages;
    if (pm.family === 'debian') {
      const r = await exec('dpkg-query', ['-W', '-f', '${binary:Package}\n', glob], { allowFailure: true, maxBuffer: BIG });
      // Multi-arch packages print as name:arch; apt-get removes every architecture by the bare name.
      packages = r.stdout.split('\n').map((l) => l.trim().replace(/:[a-z0-9-]+$/, '')).filter((l) => l.startsWith(prefix));
    } else {
      const r = await exec('rpm', ['-qa', '--qf', '%{NAME}\n', glob], { allowFailure: true, maxBuffer: BIG });
      packages = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(prefix));
      if (v.layout === 'rhel') { const base = await exec('rpm', ['-q', '--qf', '%{NAME}\n', '--', 'php'], { allowFailure: true }); if (base.code === 0) packages.push('php'); }
    }
    packages = [...new Set(packages)].filter((p) => pkgName.safeParse(p).success);
    if (!packages.length) throw new OpError('not_found', `No ${glob} packages are installed; PHP ${version} was not installed from packages`);
    // apt removes the reverse dependencies of the version packages with them
    // (roundcube-core and phpmyadmin went with php8.5-* on a live host): the
    // transaction is simulated first and anything outside the version's own
    // packages refuses the removal unless the caller forces it. The version's
    // own set also covers its metapackage (php8.5), libapache2-mod-php8.5 and
    // Debian's php-defaults metapackages (php, php-fpm, php-mysql...), which
    // carry nothing but depend on php<ver>-<ext>: a php-<ext> name is "own"
    // exactly when the matching php<ver>-<ext> is in the same transaction, so
    // a real versionless package (php-imagick) stays an honest extra.
    const requested = new Set(packages);
    const sim = await simulateRemoval(pm, packages, purge);
    const remove = sim.removed.map((p) => p.name);
    const bare = prefix.slice(0, -1);
    const own = (p) => p.startsWith(prefix) || p === bare || p === `libapache2-mod-${bare}` || (pm.family === 'debian' && (p === 'php' || (p.startsWith('php-') && remove.includes(p.replace(/^php-/, prefix)))));
    const extra = remove.filter((p) => !requested.has(p) && !own(p));
    if (dry) return { version, layout: v.layout, manager: pm.manager, packages, purge, dry: true, remove, extra, output: sim.output };
    if (extra.length && !force) throw new OpError('refused', `Removing PHP ${version} would also remove ${extra.join(', ')}; move what depends on it to another version first, or force the removal`, { version, packages, extra });
    // A forced removal is bound to the collateral the caller confirmed at
    // request time: a dependant that appeared since (an install that queued
    // behind it) is refused again instead of removed unseen.
    const unexpected = extra.filter((p) => !confirmed.includes(p));
    if (force && unexpected.length) throw new OpError('refused', `the removal would now also take ${unexpected.join(', ')}; confirm again`, { version, packages, extra, confirmed, unexpected });
    const argv = pm.family === 'debian' ? [purge ? 'purge' : 'remove', '-y', '-q', ...APT_DPKG_OPTS, '--', ...packages] : ['-y', '-q', 'remove', '--', ...packages];
    return { version, manager: pm.manager, packages, purge, forced: Boolean(force && extra.length), extra, confirmed, ...finished(await runLong({ kind: 'remove', bin: pm.binary, argv, env: APT_ENV, wait: waitFor }, ctx)) };
  },
});

defineOp('pkg.php.ini.read', {
  description: 'Read a PHP version\'s php.ini (parsed directives + raw content)',
  schema: z.object({ version: phpVersionId, sapi: z.enum(['fpm', 'apache2', 'cli', 'php']).optional() }).strict(),
  run: async ({ version, sapi }, ctx) => {
    const v = phpVersion(version);
    const target = sapi ? v.iniPaths?.[sapi] : v.iniPath;
    if (!target) throw new OpError('not_found', `No php.ini found for PHP ${version}${sapi ? ` (${sapi})` : ''}`);
    ctx.assertAllowedPath(target, 'read');
    const content = fs.readFileSync(target, 'utf8');
    return { version, path: target, sapis: v.iniPaths, content, directives: parseIni(content) };
  },
});

defineOp('pkg.php.ini.write', {
  description: 'Write a PHP version\'s php.ini (whole file or directive changes), validating with the php binary and rolling back on error',
  schema: z.object({ version: phpVersionId, sapi: z.enum(['fpm', 'apache2', 'cli', 'php']).optional(), content: arg.text.optional(), directives: directives.optional() }).strict()
    .refine((a) => a.content != null || a.directives != null, 'content or directives is required'),
  run: async ({ version, sapi, content, directives: changes }, ctx) => {
    const v = phpVersion(version);
    const target = sapi ? v.iniPaths?.[sapi] : v.iniPath;
    if (!target) throw new OpError('not_found', `No php.ini found for PHP ${version}`);
    ctx.assertAllowedPath(target, 'write');
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const next = changes ? setIniDirectives(content ?? current, changes) : content;
    const backup = writeIni(target, next);
    const check = await phpIniCheck(v.binary, target);
    if (!check.ok) {
      restoreIni(target, backup);
      throw new OpError('config_invalid', `php rejected the new ini: ${check.output.split('\n').pop() || 'syntax error'}`, { output: check.output });
    }
    return { version, path: target, bytes: Buffer.byteLength(next), directives: parseIni(next), fpmUnit: v.fpmUnit };
  },
});

defineOp('pkg.php.userini.read', {
  description: 'Read a document root\'s .user.ini (per-domain PHP settings); refuses links and files not owned by the account',
  schema: z.object({ docroot: arg.absPath, owner: arg.username.optional() }).strict(),
  run: async ({ docroot, owner }, ctx) => {
    const { docroot: real, target, account } = userIniTarget(docroot, owner, ctx);
    const content = readUserIni(target, account);
    return { docroot: real, path: target, exists: content != null, content: content ?? '', directives: parseIni(content ?? '') };
  },
});

defineOp('pkg.php.userini.write', {
  description: 'Write a document root\'s .user.ini (owned by the account); an empty result removes the file; refuses links and files not owned by the account',
  destructive: true,
  schema: z.object({ docroot: arg.absPath, owner: arg.username.optional(), content: arg.text.optional(), directives: directives.optional() }).strict()
    .refine((a) => a.content != null || a.directives != null, 'content or directives is required'),
  run: async ({ docroot, owner, content, directives: changes }, ctx) => {
    const { docroot: real, target, account } = userIniTarget(docroot, owner, ctx);
    ctx.assertAllowedPath(target, 'write');
    const current = readUserIni(target, account) ?? '';
    const next = changes ? setIniDirectives(content ?? current, changes) : content;
    if (!next.trim()) {
      if (inspectUserIni(target, account)) fs.unlinkSync(target);
      return { docroot: real, path: target, removed: true, directives: {} };
    }
    writeUserIni(target, next, account);
    return { docroot: real, path: target, bytes: Buffer.byteLength(next), directives: parseIni(next) };
  },
});

export function parseFpmPool(content, file) {
  const name = content.match(/^\s*\[([^\]]+)\]/m)?.[1] ?? path.basename(file, '.conf');
  const get = (k) => content.match(new RegExp(`^\\s*${k.replace(/\./g, '\\.')}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
  return { name, file, user: get('user'), group: get('group'), listen: get('listen'), pm: get('pm'), maxChildren: Number(get('pm.max_children')) || null, startServers: Number(get('pm.start_servers')) || null, maxRequests: Number(get('pm.max_requests')) || null, chroot: get('chroot') };
}

defineOp('pkg.phpfpm.pools', {
  description: 'PHP-FPM pools per installed version',
  schema: z.object({ version: phpVersionId.optional() }).strict(),
  run: async ({ version }, ctx) => {
    const { versions } = discoverPhp();
    const pools = [];
    for (const v of versions) {
      if (version && v.id !== version) continue;
      if (!v.poolDir || !fs.existsSync(v.poolDir)) continue;
      ctx.assertAllowedPath(v.poolDir, 'read');
      for (const file of safeReaddir(v.poolDir)) {
        if (!file.endsWith('.conf')) continue;
        const full = path.join(v.poolDir, file);
        try { pools.push({ version: v.id, fpmUnit: v.fpmUnit, ...parseFpmPool(fs.readFileSync(full, 'utf8'), full) }); } catch { /* unreadable pool file */ }
      }
    }
    return { pools };
  },
});

// --- NGINX reverse proxy ------------------------------------------------------

export const NGINX_PROXY_CONF = '/etc/nginx/conf.d/whm-proxy.conf';
export const NGINX_STATE_FILE = '/var/lib/whm/nginx-proxy.json';
const NGINX_MAIN_CONF = '/etc/nginx/nginx.conf';
const DEBIAN_DEFAULT_SITE = '/etc/nginx/sites-enabled/default';
const DEBIAN_DEFAULT_SITE_SRC = '/etc/nginx/sites-available/default';
const DEBIAN_DEFAULT_SITE_PARKED = '/etc/nginx/sites-available/default.whm-disabled';
const STOCK_MARK = '#whm-proxy# ';
const CACHE_PATH = '/var/cache/nginx/whm';

export function versionAtLeast(version, minimum) {
  const a = String(version || '').split('.').map((x) => parseInt(x, 10) || 0);
  const b = minimum.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

// `http2 on;` only exists from 1.25.1; older releases need the listen flag.
export const nginxHttp2Directive = (version) => Boolean(version) && versionAtLeast(version, '1.25.1');

// RHEL's stock nginx.conf carries the default server itself. Comments out every
// top-level server block with a marker so restoreServerBlocks can undo it.
export function disableServerBlocks(text) {
  const lines = String(text ?? '').split('\n');
  let inServer = false; let depth = 0; let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/#.*$/, '');
    if (!inServer && /^\s*server\s*\{/.test(code)) { inServer = true; depth = 0; }
    if (!inServer) continue;
    lines[i] = `${STOCK_MARK}${lines[i]}`;
    changed = true;
    depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    if (depth <= 0) inServer = false;
  }
  return { text: lines.join('\n'), changed };
}

export function restoreServerBlocks(text) {
  return String(text ?? '').split('\n').map((l) => (l.startsWith(STOCK_MARK) ? l.slice(STOCK_MARK.length) : l)).join('\n');
}

function readProxyState() { try { return JSON.parse(fs.readFileSync(NGINX_STATE_FILE, 'utf8')) || {}; } catch { return {}; } }
function writeProxyState(state) { fs.mkdirSync(path.dirname(NGINX_STATE_FILE), { recursive: true }); writeAtomic(NGINX_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); }

// Debian/Ubuntu enable a catch-all site and RHEL puts one into nginx.conf; both
// declare `default_server` on :80, which nginx refuses to share with ours.
function disableStockDefaults(ctx) {
  const changed = {};
  ctx.assertAllowedPath(DEBIAN_DEFAULT_SITE, 'write');
  ctx.assertAllowedPath(DEBIAN_DEFAULT_SITE_PARKED, 'write');
  ctx.assertAllowedPath(NGINX_MAIN_CONF, 'write');
  let st = null;
  try { st = fs.lstatSync(DEBIAN_DEFAULT_SITE); } catch { /* no stock site */ }
  if (st?.isSymbolicLink()) { changed.debianSite = { kind: 'symlink', target: fs.readlinkSync(DEBIAN_DEFAULT_SITE) }; fs.unlinkSync(DEBIAN_DEFAULT_SITE); }
  else if (st) { fs.renameSync(DEBIAN_DEFAULT_SITE, DEBIAN_DEFAULT_SITE_PARKED); changed.debianSite = { kind: 'file', parked: DEBIAN_DEFAULT_SITE_PARKED }; }
  if (fs.existsSync(NGINX_MAIN_CONF)) {
    const main = fs.readFileSync(NGINX_MAIN_CONF, 'utf8');
    const out = disableServerBlocks(main);
    if (out.changed) { fs.copyFileSync(NGINX_MAIN_CONF, `${NGINX_MAIN_CONF}.whm-bak`); writeAtomic(NGINX_MAIN_CONF, out.text); changed.mainConf = true; }
  }
  return changed;
}

function restoreStockDefaults(changed) {
  if (!changed) return;
  if (changed.debianSite?.kind === 'symlink' && !fs.existsSync(DEBIAN_DEFAULT_SITE)) { const target = changed.debianSite.target || DEBIAN_DEFAULT_SITE_SRC; if (fs.existsSync(path.resolve(path.dirname(DEBIAN_DEFAULT_SITE), target))) fs.symlinkSync(target, DEBIAN_DEFAULT_SITE); }
  if (changed.debianSite?.kind === 'file' && fs.existsSync(DEBIAN_DEFAULT_SITE_PARKED) && !fs.existsSync(DEBIAN_DEFAULT_SITE)) fs.renameSync(DEBIAN_DEFAULT_SITE_PARKED, DEBIAN_DEFAULT_SITE);
  if (changed.mainConf && fs.existsSync(NGINX_MAIN_CONF)) writeAtomic(NGINX_MAIN_CONF, restoreServerBlocks(fs.readFileSync(NGINX_MAIN_CONF, 'utf8')));
}

// Certificate paths are interpolated into a root-written nginx config, so they
// get a strict alphabet (no whitespace, ";", "{", "}", "#" or newlines that
// could smuggle directives) and must live under the panel's SSL stores. The
// API is not trusted to have produced clean paths.
export const NGINX_SSL_ROOTS = ['/etc/ssl/whm', '/etc/letsencrypt', '/etc/pki/tls/whm'];
export const nginxSslPath = z.string().regex(/^\/[A-Za-z0-9._/-]{1,255}$/, 'certificate path')
  .refine((p) => p.split('/').slice(1).every((seg) => seg && seg !== '.' && seg !== '..'), 'certificate path must be normalized')
  .refine((p) => NGINX_SSL_ROOTS.some((root) => p.startsWith(`${root}/`)), `certificate path must be under ${NGINX_SSL_ROOTS.join(', ')}`);

const domainEntry = z.object({
  domain: arg.hostname,
  aliases: z.array(arg.hostname).max(200).default([]),
  ssl: z.object({ cert: nginxSslPath, key: nginxSslPath }).strict().optional(),
}).strict();

const PROXY_HEADERS = [
  'proxy_http_version 1.1;',
  'proxy_set_header Host $host;',
  'proxy_set_header X-Real-IP $remote_addr;',
  'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  'proxy_set_header X-Forwarded-Proto $scheme;',
  'proxy_set_header X-Forwarded-Host $host;',
  'proxy_set_header X-Forwarded-Port $server_port;',
  'proxy_set_header Upgrade $http_upgrade;',
  'proxy_set_header Connection $connection_upgrade;',
  'proxy_read_timeout 300s;',
  'proxy_send_timeout 300s;',
  'proxy_buffers 16 32k;',
  'proxy_buffer_size 64k;',
];

// `ssl_reject_handshake` (nginx >= 1.19.4) lets the :443 catch-all refuse
// unknown names without a certificate; older releases get a self-signed one.
export const nginxRejectHandshake = (version) => Boolean(version) && versionAtLeast(version, '1.19.4');
export const NGINX_DEFAULT_CERT_DIR = '/etc/nginx/whm-default';

// A hostname is routed to a tenant's HTTPS block only when it is one of that
// block's names; everything else lands on the catch-all, never on the first
// ssl block nginx happens to find.
export function renderNginxProxy({ apachePort, cache, cacheMaxSizeMb = 1024, cacheTtl = '10m', domains = [], httpsPort = 443, httpPort = 80, http2Directive = false, cachePath = CACHE_PATH, rejectHandshake = false, defaultCert = null }) {
  const ind = (lines, n = 1) => lines.map((l) => `${'  '.repeat(n)}${l}`);
  const cacheLines = cache ? [
    `proxy_cache whm;`,
    `proxy_cache_valid 200 301 302 ${cacheTtl};`,
    'proxy_cache_valid 404 1m;',
    'proxy_cache_bypass $http_cookie $arg_nocache $http_cache_control;',
    'proxy_no_cache $http_cookie $http_authorization;',
    'proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;',
    'proxy_cache_lock on;',
    'proxy_ignore_headers Set-Cookie;',
    'add_header X-Cache-Status $upstream_cache_status;',
  ] : [];
  const location = ['location / {', ...ind([`proxy_pass http://127.0.0.1:${apachePort};`, ...PROXY_HEADERS, ...cacheLines]), '}'];
  const common = ['client_max_body_size 512m;', 'proxy_intercept_errors off;', 'server_tokens off;'];
  const out = [
    '# Managed by Keel (Software > NGINX Manager). Edits are overwritten on the next sync.',
    `# whm-proxy: version=1 apache_port=${apachePort} cache=${cache ? 'on' : 'off'} domains=${domains.length} generated=${new Date().toISOString()}`,
    '',
    'map $http_upgrade $connection_upgrade {',
    '  default upgrade;',
    "  ''      close;",
    '}',
    '',
  ];
  if (cache) out.push(`proxy_cache_path ${cachePath} levels=1:2 keys_zone=whm:64m max_size=${cacheMaxSizeMb}m inactive=60m use_temp_path=off;`, '');
  out.push('server {', ...ind([`listen ${httpPort} default_server;`, `listen [::]:${httpPort} default_server;`, 'server_name _;', ...common, ...location]), '}', '');
  const sslListen = http2Directive ? 'ssl' : 'ssl http2';
  if (rejectHandshake) {
    out.push('server {', ...ind([`listen ${httpsPort} ssl default_server;`, `listen [::]:${httpsPort} ssl default_server;`, 'server_name _;', 'ssl_reject_handshake on;']), '}', '');
  } else if (defaultCert) {
    out.push('server {', ...ind([`listen ${httpsPort} ssl default_server;`, `listen [::]:${httpsPort} ssl default_server;`, 'server_name _;', `ssl_certificate ${defaultCert.cert};`, `ssl_certificate_key ${defaultCert.key};`, 'ssl_protocols TLSv1.2 TLSv1.3;', 'return 444;']), '}', '');
  }
  for (const d of domains) {
    if (!d.ssl) continue;
    const names = [...new Set([d.domain, ...(d.aliases || [])])].join(' ');
    out.push('server {', ...ind([
      `listen ${httpsPort} ${sslListen};`, `listen [::]:${httpsPort} ${sslListen};`, ...(http2Directive ? ['http2 on;'] : []), `server_name ${names};`,
      `ssl_certificate ${d.ssl.cert};`, `ssl_certificate_key ${d.ssl.key};`,
      'ssl_session_cache shared:whm_ssl:10m;', 'ssl_session_timeout 1d;', 'ssl_protocols TLSv1.2 TLSv1.3;', 'ssl_prefer_server_ciphers off;',
      ...common, ...location,
    ]), '}', '');
  }
  return out.join('\n');
}

export function parseProxyHeader(content) {
  const m = content.match(/^# whm-proxy: (.*)$/m);
  if (!m) return null;
  const out = {};
  for (const kv of m[1].split(/\s+/)) { const [k, v] = kv.split('='); if (k) out[k] = v; }
  return { version: Number(out.version) || null, apachePort: Number(out.apache_port) || null, cache: out.cache === 'on', domains: Number(out.domains) || 0, generatedAt: out.generated || null };
}

// Fallback for nginx < 1.19.4: a throwaway self-signed certificate so the :443
// catch-all can exist and answer unknown names with a closed connection.
async function ensureDefaultCert(ctx) {
  const cert = path.join(NGINX_DEFAULT_CERT_DIR, 'cert.pem');
  const key = path.join(NGINX_DEFAULT_CERT_DIR, 'key.pem');
  ctx.assertAllowedPath(cert, 'write');
  ctx.assertAllowedPath(key, 'write');
  if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key, generated: false };
  if (!hasBinary('openssl')) return null;
  fs.mkdirSync(NGINX_DEFAULT_CERT_DIR, { recursive: true, mode: 0o700 });
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=default.invalid'], { timeoutMs: 60_000 });
  fs.chmodSync(key, 0o600);
  return { cert, key, generated: true };
}

async function nginxConfigTest() {
  if (!hasBinary('nginx')) return { ok: null, output: 'nginx is not installed' };
  const r = await exec('nginx', ['-t'], { allowFailure: true, timeoutMs: 60_000 });
  return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim().slice(-4000) };
}

async function nginxVersion() {
  if (!hasBinary('nginx')) return null;
  const r = await exec('nginx', ['-v'], { allowFailure: true, timeoutMs: 15_000 });
  return `${r.stdout}\n${r.stderr}`.match(/nginx\/(\d+(?:\.\d+)*)/)?.[1] ?? null;
}

defineOp('pkg.nginx.status', {
  description: 'NGINX install state, version, unit state and the panel-managed reverse proxy config',
  schema: z.object({ includeContent: z.boolean().default(false) }).strict(),
  run: async ({ includeContent }, ctx) => {
    const installed = hasBinary('nginx');
    const version = await nginxVersion();
    ctx.assertAllowedPath(NGINX_PROXY_CONF, 'read');
    const exists = fs.existsSync(NGINX_PROXY_CONF);
    const content = exists ? fs.readFileSync(NGINX_PROXY_CONF, 'utf8') : null;
    const state = readProxyState();
    return {
      installed, version, active: installed ? await unitActive('nginx') : null, enabled: null, http2Directive: nginxHttp2Directive(version), catchAll: nginxRejectHandshake(version) ? 'reject-handshake' : hasBinary('openssl') ? 'self-signed' : 'none',
      configPath: NGINX_PROXY_CONF, proxyConfigured: exists, proxy: content ? parseProxyHeader(content) : null,
      stockDefaults: { debianSite: state.debianSite ? 'disabled' : fs.existsSync(DEBIAN_DEFAULT_SITE) ? 'enabled' : 'absent', mainConf: state.mainConf ? 'disabled' : 'untouched' },
      content: includeContent ? content : undefined, confDirExists: fs.existsSync(path.dirname(NGINX_PROXY_CONF)),
    };
  },
});

defineOp('pkg.nginx.configtest', {
  description: 'nginx -t',
  run: async () => {
    if (!hasBinary('nginx')) throw new OpError('capability_missing', 'nginx is not installed');
    return nginxConfigTest();
  },
});

// nginx -t creates only the last path component of proxy_cache_path, and
// Debian/Ubuntu packages ship no /var/cache/nginx. The parent is created here
// when the agent may write there (operators extend the allowed roots in the
// agent config); otherwise the operator gets a clear message instead of a
// configtest failure that is rolled back every time.
function ensureCacheDir(ctx) {
  if (fs.existsSync(CACHE_PATH)) return;
  try { ctx.assertAllowedPath(CACHE_PATH, 'write'); } catch {
    if (fs.existsSync(path.dirname(CACHE_PATH))) return;
    throw new OpError('unsupported', `The cache directory ${path.dirname(CACHE_PATH)} does not exist and the agent may not create it; create it (owned by root, mode 0700) or add it to the agent's allowed roots, then enable the cache again`);
  }
  fs.mkdirSync(CACHE_PATH, { recursive: true, mode: 0o700 });
}

defineOp('pkg.nginx.proxy.write', {
  description: 'Render and install the reverse-proxy config (displacing the stock default site); validates with nginx -t and rolls back when invalid',
  destructive: true,
  schema: z.object({
    apachePort: port.default(8080), cache: z.boolean().default(false), cacheMaxSizeMb: z.number().int().min(64).max(1_048_576).default(1024),
    cacheTtl: z.string().regex(/^\d{1,5}[smhd]?$/).default('10m'), httpPort: port.default(80), httpsPort: port.default(443), domains: z.array(domainEntry).max(5000).default([]),
  }).strict(),
  run: async (args, ctx) => {
    if (!hasBinary('nginx')) throw new OpError('capability_missing', 'nginx is not installed; use "Install NGINX" first');
    ctx.assertAllowedPath(NGINX_PROXY_CONF, 'write');
    for (const d of args.domains) if (d.ssl) { ctx.assertAllowedPath(d.ssl.cert, 'read'); ctx.assertAllowedPath(d.ssl.key, 'read'); }
    const usable = args.domains.filter((d) => !d.ssl || (fs.existsSync(d.ssl.cert) && fs.existsSync(d.ssl.key)));
    if (args.cache) ensureCacheDir(ctx);
    const version = await nginxVersion();
    const rejectHandshake = nginxRejectHandshake(version);
    const defaultCert = rejectHandshake ? null : await ensureDefaultCert(ctx);
    const content = renderNginxProxy({ ...args, domains: usable, http2Directive: nginxHttp2Directive(version), rejectHandshake, defaultCert });
    const backup = writeIni(NGINX_PROXY_CONF, content);
    const previousState = readProxyState();
    const changed = disableStockDefaults(ctx);
    const test = await nginxConfigTest();
    if (!test.ok) {
      restoreIni(NGINX_PROXY_CONF, backup);
      restoreStockDefaults(changed);
      throw new OpError('config_invalid', `nginx -t rejected the generated configuration: ${test.output.split('\n').pop()}`, { output: test.output });
    }
    ctx.assertAllowedPath(NGINX_STATE_FILE, 'write');
    writeProxyState({ ...previousState, ...changed });
    return { path: NGINX_PROXY_CONF, bytes: Buffer.byteLength(content), nginxVersion: version, http2Directive: nginxHttp2Directive(version), catchAll: rejectHandshake ? 'reject-handshake' : defaultCert ? 'self-signed' : 'none', domains: usable.length, sslDomains: usable.filter((d) => d.ssl).length, sslNames: usable.filter((d) => d.ssl).reduce((n, d) => n + 1 + (d.aliases?.length || 0), 0), skipped: args.domains.length - usable.length, stockDefaultsDisabled: Object.keys(changed), configtest: test };
  },
});

defineOp('pkg.nginx.proxy.remove', {
  description: 'Remove the panel-managed reverse-proxy config and restore the stock default site it displaced',
  destructive: true,
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(NGINX_PROXY_CONF, 'write');
    ctx.assertAllowedPath(NGINX_STATE_FILE, 'write');
    const existed = fs.existsSync(NGINX_PROXY_CONF);
    if (existed) fs.renameSync(NGINX_PROXY_CONF, `${NGINX_PROXY_CONF}.disabled`);
    const state = readProxyState();
    const restored = Object.keys(state);
    if (restored.length) { ctx.assertAllowedPath(NGINX_MAIN_CONF, 'write'); restoreStockDefaults(state); fs.rmSync(NGINX_STATE_FILE, { force: true }); }
    return { path: NGINX_PROXY_CONF, removed: existed, stockDefaultsRestored: restored, configtest: await nginxConfigTest() };
  },
});

// --- runtimes: OS release, extra repositories, side-by-side Node.js ----------
// Everything here is driven by enums and integers: the repository is one of
// four names, the Node.js major an integer, and every path is built from
// constants. Tests move the directories with WHM_* overrides, which must stay
// under an allowed root exactly like WHM_PKG_RUN_DIR.

export const APT_SOURCES_DIR = '/etc/apt/sources.list.d';
export const APT_KEYRINGS_DIR = '/etc/apt/keyrings';
export const YUM_REPOS_DIR = '/etc/yum.repos.d';
export const NODE_DIR = '/opt/keel/node';
export const LOCAL_BIN_DIR = '/usr/local/bin';
export const OS_RELEASE_FILE = '/etc/os-release';
const aptSourcesDir = () => process.env.WHM_APT_SOURCES_DIR || APT_SOURCES_DIR;
const aptKeyringsDir = () => process.env.WHM_APT_KEYRINGS_DIR || APT_KEYRINGS_DIR;
const yumReposDir = () => process.env.WHM_YUM_REPOS_DIR || YUM_REPOS_DIR;
const nodeDir = () => process.env.WHM_NODE_DIR || NODE_DIR;
const localBinDir = () => process.env.WHM_LOCAL_BIN_DIR || LOCAL_BIN_DIR;
const osReleaseFile = () => process.env.WHM_OS_RELEASE_FILE || OS_RELEASE_FILE;

const SURY_KEY_URL = 'https://packages.sury.org/php/apt.gpg';
const SURY_KEY_FILE = 'keel-sury-php.gpg';
const SURY_LIST_FILE = 'keel-sury-php.list';
const PPAS = { php: 'ondrej/php', python: 'deadsnakes/ppa' };
const REMI_MAJORS = [8, 9, 10];
const PROBE_TIMEOUT = 15_000;
const CURL_SHORT = ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60'];
const CURL_LONG = ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '600'];

export function parseOsRelease(text) {
  const kv = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    value = value.replace(/\\(.)/g, '$1');
    if (!(key in kv)) kv[key] = value;
  }
  const id = kv.ID ? kv.ID.toLowerCase() : null;
  const idLike = (kv.ID_LIKE || '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = [id, ...idLike].filter(Boolean);
  const family = all.some((x) => x === 'debian' || x === 'ubuntu') ? 'debian' : all.some((x) => ['rhel', 'fedora', 'centos'].includes(x)) ? 'rhel' : null;
  return { id, idLike, versionId: kv.VERSION_ID || null, codename: kv.VERSION_CODENAME || kv.UBUNTU_CODENAME || null, family };
}

function readOsRelease(ctx) {
  const file = osReleaseFile();
  if (file !== OS_RELEASE_FILE) ctx.assertAllowedPath(file, 'read');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { try { text = fs.readFileSync('/usr/lib/os-release', 'utf8'); } catch { text = ''; } }
  return parseOsRelease(text);
}

defineOp('pkg.os.release', {
  description: 'Distribution identity from /etc/os-release (id, id_like, version, codename, family)',
  run: async (_args, ctx) => readOsRelease(ctx),
});

const readSmall = (file) => { try { const st = fs.lstatSync(file); if (!st.isFile() || st.size > 256 * 1024) return ''; return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

function sourceMentioning(dir, needles) {
  for (const name of safeReaddir(dir)) {
    if (!/\.(list|sources)$/.test(name)) continue;
    const full = path.join(dir, name);
    const text = readSmall(full);
    if (needles.some((n) => text.includes(n))) return full;
  }
  return null;
}

const ppaPresent = (ppa, ctx) => { const dir = aptSourcesDir(); ctx.assertAllowedPath(dir, 'read'); return sourceMentioning(dir, [`ppa.launchpadcontent.net/${ppa}`, `ppa.launchpad.net/${ppa}`]); };

// A PPA without a series for this release (ondrej/php has none for Ubuntu
// 26.04 "resolute") breaks every later apt-get update once added, so the
// series index is asked for first. A failed probe (offline host) answers
// null and the caller carries on as before.
const CURL_HEAD = ['-fsSI', '--proto', '=https', '--proto-redir', '=https', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code}'];
const CODENAME_RE = /^[a-z][a-z0-9]{1,31}$/;
export async function probePpaSeries(ppa, codename) {
  if (!CODENAME_RE.test(codename || '')) return { supported: null, error: 'codename unknown' };
  const url = `https://ppa.launchpadcontent.net/${ppa}/ubuntu/dists/${codename}/InRelease`;
  let r;
  try { r = await exec('curl', [...CURL_HEAD, url], { allowFailure: true, timeoutMs: 30_000 }); } catch (err) { return { supported: null, error: err.message }; }
  const status = Number.parseInt(String(r.stdout).trim().slice(-3), 10);
  if (r.code === 0 || status === 200) return { supported: true };
  if (status === 404) return { supported: false, status };
  return { supported: null, error: `probe failed (curl exit ${r.code}${status ? `, HTTP ${status}` : ''})` };
}

const unsupportedPpa = (ppa, os) => `ppa:${ppa} has no packages for Ubuntu ${os.versionId || ''} ${os.codename || ''}`.replace(/\s+/g, ' ').trim() + '; the distribution ships its own versions only';

async function ensurePpa(repo, ctx) {
  const ppa = PPAS[repo];
  const found = ppaPresent(ppa, ctx);
  if (found) return { action: 'present', detail: `ppa:${ppa} in ${found}` };
  const os = readOsRelease(ctx);
  const probe = await probePpaSeries(ppa, os.codename);
  if (probe.supported === false) return { action: 'unsupported', detail: unsupportedPpa(ppa, os) };
  ctx.assertAllowedPath(aptSourcesDir(), 'write');
  if (!hasBinary('add-apt-repository')) {
    await exec('apt-get', ['install', '-y', '-q', ...APT_DPKG_OPTS, '--', 'software-properties-common'], { env: APT_ENV, timeoutMs: LONG, maxBuffer: BIG });
    if (!hasBinary('add-apt-repository')) throw new OpError('binary_not_found', 'add-apt-repository is still missing after installing software-properties-common');
  }
  await exec('add-apt-repository', ['-y', '--no-update', `ppa:${ppa}`], { env: APT_ENV, timeoutMs: 10 * 60_000, maxBuffer: BIG });
  return { action: 'added', detail: `ppa:${ppa} (${ppaPresent(ppa, ctx) || 'added by add-apt-repository'})` };
}

// The key is fetched into a name created O_EXCL|O_NOFOLLOW under the keyrings
// directory (root-owned 0755), checked to still be a regular file, then renamed
// into place; the list file goes through writeAtomic.
async function ensureSury(codename, ctx) {
  const sources = aptSourcesDir();
  const keyrings = aptKeyringsDir();
  ctx.assertAllowedPath(sources, 'read');
  const found = sourceMentioning(sources, ['packages.sury.org/php']);
  if (found) return { action: 'present', detail: `packages.sury.org in ${found}` };
  if (!CODENAME_RE.test(codename || '')) throw new OpError('unsupported', 'The Debian codename is unknown (VERSION_CODENAME missing from /etc/os-release or not a plain series name)');
  ctx.assertAllowedPath(sources, 'write');
  ctx.assertAllowedPath(keyrings, 'write');
  fs.mkdirSync(keyrings, { recursive: true, mode: 0o755 });
  fs.mkdirSync(sources, { recursive: true, mode: 0o755 });
  const keyPath = path.join(keyrings, SURY_KEY_FILE);
  const tmp = path.join(keyrings, `.${SURY_KEY_FILE}.whm-${randomSuffix()}`);
  fs.closeSync(fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644));
  try {
    await exec('curl', [...CURL_SHORT, '-o', tmp, SURY_KEY_URL], { timeoutMs: 90_000 });
    const st = fs.lstatSync(tmp);
    if (!st.isFile() || st.size === 0) throw new OpError('download_failed', `The sury signing key download at ${tmp} is empty or not a regular file`);
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, keyPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const listPath = path.join(sources, SURY_LIST_FILE);
  writeAtomic(listPath, `deb [signed-by=${keyPath}] https://packages.sury.org/php/ ${codename} main\n`);
  return { action: 'added', detail: `${listPath} (${codename}), key ${keyPath}` };
}

async function rpmInstalled(name) {
  const r = await exec('rpm', ['-q', '--', name], { allowFailure: true, timeoutMs: 60_000 });
  return r.code === 0;
}

async function ensureEpel(ctx) {
  ctx.assertAllowedPath(yumReposDir(), 'read');
  if (await rpmInstalled('epel-release')) return { action: 'present', detail: 'epel-release is installed' };
  ctx.assertAllowedPath(yumReposDir(), 'write');
  await exec('dnf', ['-y', '-q', 'install', '--', 'epel-release'], { timeoutMs: LONG, maxBuffer: BIG });
  return { action: 'added', detail: 'epel-release installed' };
}

// CRB (PowerTools on EL8) carries the -devel packages a PHP source build needs.
async function ensureCrb(os, ctx) {
  ctx.assertAllowedPath(yumReposDir(), 'read');
  const major = Number.parseInt(String(os.versionId || ''), 10);
  const name = major === 8 ? 'powertools' : 'crb';
  const enabled = await exec('dnf', ['-q', 'repolist', '--enabled'], { allowFailure: true, timeoutMs: 120_000, maxBuffer: BIG });
  if (enabled.code === 0 && enabled.stdout.split('\n').some((l) => l.trim().toLowerCase().startsWith(name))) return { action: 'present', detail: `${name} is enabled` };
  ctx.assertAllowedPath(yumReposDir(), 'write');
  const r = await exec('dnf', ['-y', '-q', 'config-manager', '--set-enabled', name], { allowFailure: true, timeoutMs: LONG, maxBuffer: BIG });
  if (r.code !== 0) return { action: 'unsupported', detail: `dnf config-manager could not enable ${name}: ${(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}`}` };
  return { action: 'added', detail: `${name} enabled` };
}

async function ensureRemi(os, ctx) {
  ctx.assertAllowedPath(yumReposDir(), 'read');
  if (await rpmInstalled('remi-release')) return { action: 'present', detail: 'remi-release is installed' };
  const major = Number.parseInt(String(os.versionId || ''), 10);
  if (!REMI_MAJORS.includes(major)) return { action: 'unsupported', detail: `Remi provides packages for Enterprise Linux ${REMI_MAJORS.join(', ')}; this host reports version ${os.versionId || 'unknown'}` };
  ctx.assertAllowedPath(yumReposDir(), 'write');
  await exec('dnf', ['-y', '-q', 'install', '--', `https://rpms.remirepo.net/enterprise/remi-release-${major}.rpm`], { timeoutMs: LONG, maxBuffer: BIG });
  return { action: 'added', detail: `remi-release-${major} installed` };
}

const combine = (steps) => ({ action: steps.some((s) => s.action === 'unsupported') ? 'unsupported' : steps.some((s) => s.action === 'added') ? 'added' : 'present', detail: steps.map((s) => s.detail).filter(Boolean).join('; ') });

defineOp('pkg.repo.ensure', {
  description: 'Make sure one of the curated package repositories (php, python, epel, remi, crb) is configured; idempotent, never refreshes the index',
  timeoutMs: LONG,
  schema: z.object({ repo: z.enum(['php', 'python', 'epel', 'remi', 'crb']) }).strict(),
  run: async ({ repo }, ctx) => {
    const os = readOsRelease(ctx);
    const base = { repo, family: os.family };
    if (os.family === 'debian') {
      if (repo === 'epel' || repo === 'remi' || repo === 'crb') return { ...base, action: 'unsupported', detail: `${repo} is an Enterprise Linux repository; this host is ${os.id || 'Debian-family'}` };
      if (os.id === 'ubuntu') return { ...base, ...(await ensurePpa(repo, ctx)) };
      if (os.id === 'debian') {
        if (repo === 'php') return { ...base, ...(await ensureSury(os.codename, ctx)) };
        return { ...base, action: 'unsupported', detail: 'Debian ships one Python version; the deadsnakes PPA is Ubuntu only' };
      }
      return { ...base, action: 'unsupported', detail: `No ${repo} repository is known for ${os.id || 'this Debian derivative'}` };
    }
    if (os.family === 'rhel') {
      if (repo === 'epel') return { ...base, ...(await ensureEpel(ctx)) };
      if (repo === 'crb') return { ...base, ...(await ensureCrb(os, ctx)) };
      if (repo === 'remi') return { ...base, ...(await ensureRemi(os, ctx)) };
      if (repo === 'php') {
        const epel = await ensureEpel(ctx);
        const remi = await ensureRemi(os, ctx);
        return { ...base, ...combine([epel, remi]) };
      }
      return { ...base, action: 'present', detail: 'Python versions come from AppStream' };
    }
    return { ...base, action: 'unsupported', detail: `Unknown distribution family (ID=${os.id || '?'})` };
  },
});

defineOp('pkg.repo.status', {
  description: 'Whether one of the curated repositories is configured and whether it publishes packages for this release; never writes',
  timeoutMs: 60_000,
  schema: z.object({ repo: z.enum(['php', 'python', 'epel', 'remi']) }).strict(),
  run: async ({ repo }, ctx) => {
    const os = readOsRelease(ctx);
    const base = { repo, family: os.family };
    if (os.family === 'debian') {
      if (repo === 'epel' || repo === 'remi') return { ...base, present: false, supported: false, detail: `${repo} is an Enterprise Linux repository; this host is ${os.id || 'Debian-family'}` };
      if (os.id === 'ubuntu') {
        const ppa = PPAS[repo];
        const found = ppaPresent(ppa, ctx);
        if (found) return { ...base, present: true, supported: true, detail: `ppa:${ppa} in ${found}` };
        const probe = await probePpaSeries(ppa, os.codename);
        if (probe.supported === false) return { ...base, present: false, supported: false, detail: unsupportedPpa(ppa, os) };
        return { ...base, present: false, supported: probe.supported, detail: probe.supported ? `ppa:${ppa} publishes ${os.codename}` : `ppa:${ppa} could not be checked: ${probe.error}` };
      }
      if (os.id === 'debian') {
        if (repo === 'php') { const sources = aptSourcesDir(); ctx.assertAllowedPath(sources, 'read'); const found = sourceMentioning(sources, ['packages.sury.org/php']); return { ...base, present: Boolean(found), supported: true, detail: found ? `packages.sury.org in ${found}` : 'packages.sury.org supports every stable Debian release' }; }
        return { ...base, present: false, supported: false, detail: 'Debian ships one Python version; the deadsnakes PPA is Ubuntu only' };
      }
      return { ...base, present: false, supported: false, detail: `No ${repo} repository is known for ${os.id || 'this Debian derivative'}` };
    }
    if (os.family === 'rhel') {
      if (repo === 'python') return { ...base, present: true, supported: true, detail: 'Python versions come from AppStream' };
      ctx.assertAllowedPath(yumReposDir(), 'read');
      const epel = repo !== 'remi' ? await rpmInstalled('epel-release') : null;
      const remi = repo !== 'epel' ? await rpmInstalled('remi-release') : null;
      const major = Number.parseInt(String(os.versionId || ''), 10);
      const remiOk = REMI_MAJORS.includes(major);
      if (repo === 'epel') return { ...base, present: epel, supported: true, detail: epel ? 'epel-release is installed' : 'epel-release is installable' };
      const present = repo === 'remi' ? remi : Boolean(epel && remi);
      if (!present && !remiOk) return { ...base, present, supported: false, detail: `Remi provides packages for Enterprise Linux ${REMI_MAJORS.join(', ')}; this host reports version ${os.versionId || 'unknown'}` };
      return { ...base, present, supported: true, detail: present ? 'remi-release is installed' : `remi-release-${major} is installable` };
    }
    return { ...base, present: false, supported: false, detail: `Unknown distribution family (ID=${os.id || '?'})` };
  },
});

// --- Node.js builds under /opt/keel/node/<major> ---------------------------

const nodeMajor = z.number().int().min(16).max(30);
const NODE_ARCH = { x64: 'x64', arm64: 'arm64' };
const NODE_LINKS = ['node', 'npm', 'npx'];

export function pickNodeTarball(shasums, major, arch) {
  const re = new RegExp(`^([0-9a-f]{64})\\s+(node-v(${Number(major)}\\.\\d+\\.\\d+)-linux-${arch}\\.tar\\.xz)\\s*$`);
  for (const line of String(shasums || '').split('\n')) {
    const m = re.exec(line.trim());
    if (m) return { file: m[2], sha256: m[1], version: `v${m[3]}` };
  }
  return null;
}

export function verifySha256(buffer, hex) {
  const actual = crypto.createHash('sha256').update(buffer).digest();
  let expected;
  try { expected = Buffer.from(String(hex).trim().toLowerCase(), 'hex'); } catch { return false; }
  return expected.length === 32 && crypto.timingSafeEqual(actual, expected);
}

const versionOf = (stdout, re = /v?(\d+\.\d+(?:\.\d+)?)/) => stdout.match(re)?.[1] ?? null;

async function probeVersion(bin, argv = ['--version'], re) {
  if (!hasBinary(bin)) return null;
  try {
    // cwd pinned to / so composer (and anything else that looks at the working directory) never boots project plugins or scripts from an account tree.
    const r = await exec(bin, argv, { allowFailure: true, timeoutMs: PROBE_TIMEOUT, cwd: '/', env: { COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_INTERACTION: '1' } });
    return versionOf(`${r.stdout}\n${r.stderr}`, re);
  } catch { return null; }
}

// Every entry of <extracted>/bin must belong to the user running the agent (root on a real host); a foreign uid means tar kept the archive's ownership and the tree is not safe to expose through /usr/local/bin.
function assertOwnedByUs(binDir, file) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return;
  const entries = [binDir, ...fs.readdirSync(binDir).map((n) => path.join(binDir, n))];
  for (const p of entries) {
    const st = fs.lstatSync(p);
    if (st.uid !== uid) throw new OpError('extract_failed', `${file}: ${p} is owned by uid ${st.uid} after extraction, expected ${uid}; nothing was installed`);
  }
}

async function nodeVersionAt(bin) {
  try { const r = await exec(bin, ['--version'], { allowFailure: true, timeoutMs: PROBE_TIMEOUT }); return r.code === 0 ? r.stdout.trim() || null : null; } catch { return null; }
}

async function listNode(ctx) {
  const dir = nodeDir();
  if (dir !== NODE_DIR) ctx.assertAllowedPath(dir, 'read');
  const versions = [];
  for (const name of safeReaddir(dir).sort((a, b) => Number(a) - Number(b))) {
    if (!/^\d+$/.test(name)) continue;
    const bin = path.join(dir, name, 'bin', 'node');
    if (!fs.existsSync(bin)) continue;
    versions.push({ major: Number(name), version: await nodeVersionAt(bin), path: path.join(dir, name), bin });
  }
  const systemPath = resolveBinary('node');
  const system = systemPath ? { version: await nodeVersionAt(systemPath), path: systemPath } : null;
  return { system, versions };
}

defineOp('pkg.node.list', {
  description: 'Node.js builds under /opt/keel/node plus the system node on PATH',
  run: async (_args, ctx) => listNode(ctx),
});

// Only a link that already points into the Node.js tree is replaced; anything
// else at that name belongs to the operator and is reported, not overwritten.
function placeSymlink(link, target, root) {
  let st = null;
  try { st = fs.lstatSync(link); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (st) {
    if (!st.isSymbolicLink()) return { link, placed: false, reason: 'exists and is not a symbolic link' };
    const current = fs.readlinkSync(link);
    if (current !== target && !current.startsWith(`${root}/`)) return { link, placed: false, reason: `points to ${current}` };
  }
  const tmp = path.join(path.dirname(link), `.${path.basename(link)}.whm-${randomSuffix()}`);
  fs.symlinkSync(target, tmp);
  try { fs.renameSync(tmp, link); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  return { link, placed: true };
}

defineOp('pkg.node.install', {
  description: 'Install the latest official nodejs.org build of a major version under /opt/keel/node/<major> with node<major>/npm<major>/npx<major> links; the system node is never touched',
  timeoutMs: 15 * 60_000,
  schema: z.object({ major: nodeMajor, wait }).strict(),
  run: async ({ major }, ctx) => {
    const arch = NODE_ARCH[process.arch];
    if (!arch) throw new OpError('unsupported', `No official Node.js build exists for the ${process.arch} architecture`);
    const root = nodeDir();
    const binDir = localBinDir();
    ctx.assertAllowedPath(root, 'write');
    for (const name of NODE_LINKS) ctx.assertAllowedPath(path.join(binDir, `${name}${major}`), 'write');
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    const output = [];
    const tmpdir = fs.mkdtempSync(path.join(root, '.tmp-'));
    try {
      const index = await exec('curl', [...CURL_LONG, `https://nodejs.org/dist/latest-v${major}.x/SHASUMS256.txt`], { timeoutMs: 620_000, maxBuffer: BIG });
      const pick = pickNodeTarball(index.stdout, major, arch);
      if (!pick) throw new OpError('not_found', `nodejs.org publishes no linux-${arch} build for Node.js ${major}.x`);
      output.push(`Downloading ${pick.file} (${pick.version})`);
      const archive = path.join(tmpdir, pick.file);
      await exec('curl', [...CURL_LONG, '-o', archive, `https://nodejs.org/dist/latest-v${major}.x/${pick.file}`], { timeoutMs: 620_000, maxBuffer: BIG });
      const st = fs.lstatSync(archive);
      if (!st.isFile()) throw new OpError('download_failed', `${archive} is not a regular file`);
      if (!verifySha256(fs.readFileSync(archive), pick.sha256)) throw new OpError('checksum_mismatch', `${pick.file} does not match the SHA-256 published by nodejs.org; nothing was installed`);
      output.push(`Checksum verified (${pick.sha256.slice(0, 12)})`);
      // Running as root, GNU tar defaults to --same-owner/-p and would hand the tree to the uid recorded in the archive (nodejs.org builds carry uid 1000, an ordinary hosting account). Pin ownership and modes to the extracting user and verify before the tree is put in place.
      await exec('tar', ['--no-same-owner', '--no-same-permissions', '-xJf', archive, '-C', tmpdir], { timeoutMs: 10 * 60_000, maxBuffer: BIG });
      fs.rmSync(archive, { force: true });
      const extracted = path.join(tmpdir, pick.file.replace(/\.tar\.xz$/, ''));
      if (!fs.existsSync(path.join(extracted, 'bin', 'node'))) throw new OpError('extract_failed', `${pick.file} did not contain bin/node`);
      assertOwnedByUs(path.join(extracted, 'bin'), pick.file);
      const target = path.join(root, String(major));
      let old = null;
      if (fs.existsSync(target)) { old = path.join(root, `.old-${randomSuffix()}`); fs.renameSync(target, old); }
      try { fs.renameSync(extracted, target); } catch (err) { if (old) fs.renameSync(old, target); throw err; }
      if (old) { fs.rmSync(old, { recursive: true, force: true }); output.push(`Replaced the previous Node.js ${major} build`); }
      const symlinks = [];
      const conflicts = [];
      for (const name of NODE_LINKS) {
        const placed = placeSymlink(path.join(binDir, `${name}${major}`), path.join(target, 'bin', name), root);
        if (placed.placed) symlinks.push(placed.link); else { conflicts.push(placed); output.push(`Left ${placed.link} alone: it ${placed.reason}`); }
      }
      const version = (await nodeVersionAt(path.join(target, 'bin', 'node'))) || pick.version;
      output.push(`Node.js ${version} installed under ${target}`);
      return { major, version, path: target, bin: path.join(target, 'bin', 'node'), symlinks, ...(conflicts.length ? { conflicts } : {}), output };
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  },
});

defineOp('pkg.node.release', {
  description: 'The latest official nodejs.org build of a major version for this architecture (SHASUMS256 lookup; changes nothing)',
  timeoutMs: 120_000,
  schema: z.object({ major: nodeMajor }).strict(),
  run: async ({ major }) => {
    const arch = NODE_ARCH[process.arch];
    if (!arch) throw new OpError('unsupported', `No official Node.js build exists for the ${process.arch} architecture`);
    const index = await exec('curl', [...CURL_SHORT, `https://nodejs.org/dist/latest-v${major}.x/SHASUMS256.txt`], { timeoutMs: 90_000, maxBuffer: BIG });
    const pick = pickNodeTarball(index.stdout, major, arch);
    if (!pick) throw new OpError('not_found', `nodejs.org publishes no linux-${arch} build for Node.js ${major}.x`);
    return { major, arch, ...pick };
  },
});

defineOp('pkg.node.remove', {
  description: 'Remove a Node.js build under /opt/keel/node/<major> and the node<major>/npm<major>/npx<major> links that point into it',
  destructive: true,
  schema: z.object({ major: nodeMajor }).strict(),
  run: async ({ major }, ctx) => {
    const root = nodeDir();
    const binDir = localBinDir();
    ctx.assertAllowedPath(root, 'write');
    for (const name of NODE_LINKS) ctx.assertAllowedPath(path.join(binDir, `${name}${major}`), 'write');
    const target = path.join(root, String(major));
    const symlinks = [];
    for (const name of NODE_LINKS) {
      const link = path.join(binDir, `${name}${major}`);
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink() && fs.readlinkSync(link).startsWith(`${target}/`)) { fs.unlinkSync(link); symlinks.push(link); }
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    let removed = false;
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) throw new OpError('refused', `${target} is a symbolic link; refusing to follow it`);
      fs.rmSync(target, { recursive: true, force: true });
      removed = true;
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return { major, removed, path: target, symlinks };
  },
});

// --- PHP from the official php.net source under /opt/keel/php/<minor> --------
// The minor is the only caller-supplied value and it is pinned to a two-part
// number; every path is built from it, the release metadata comes from php.net
// over https only and the build runs one static script shipped in the repo
// whose parameters travel in the environment, never on the command line.

// PHP_MINORS also generates the exact unit/link paths the agent may write, so the schema and the allowed roots cannot drift apart.
export const phpMinor = z.string().refine((m) => PHP_MINORS.includes(m), 'PHP minor such as 8.4');
// php.net's last 7.4 / 8.0 releases predate libxml2 2.12 and ICU 75 and do not compile on current distributions.
export const PHP_SOURCE_MINORS = ['8.1', '8.2', '8.3', '8.4', '8.5'];
const PHP_RELEASES_URL = 'https://www.php.net/releases/index.php';
const PHP_DIST_URL = 'https://www.php.net/distributions';
const PHP_BUILD_TIMEOUT = 90 * 60_000;
const CURL_PHP = ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '900'];
const BUILD_MARKER = 'keel-build.json';
const BUILD_OK = '.keel-build-ok';
const BUILD_SCRIPT = new URL('./php-build.sh', import.meta.url);
const FPM_OWNERS = ['www-data', 'apache', 'nginx', 'nobody'];

export function parsePhpRelease(text, minor) {
  let data;
  try { data = JSON.parse(String(text || '')); } catch { throw new OpError('invalid_release', 'php.net answered with something that is not JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.version) throw new OpError('not_found', `php.net publishes no release for PHP ${minor}`);
  const version = String(data.version);
  if (!/^\d+\.\d+\.\d+$/.test(version) || !version.startsWith(`${minor}.`)) throw new OpError('invalid_release', `php.net reports version "${version}" for PHP ${minor}`);
  const entry = (Array.isArray(data.source) ? data.source : []).find((s) => s && typeof s.filename === 'string' && s.filename === `php-${version}.tar.xz`);
  if (!entry) throw new OpError('invalid_release', `php.net lists no php-${version}.tar.xz source archive`);
  const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new OpError('invalid_release', `php.net lists no SHA-256 for ${entry.filename}`);
  return { version, filename: entry.filename, sha256 };
}

export function renderPhpUnit(minor) {
  if (!phpMinor.safeParse(minor).success) throw new OpError('invalid_args', `"${minor}" is not a PHP minor this panel builds`);
  const prefix = `${KEEL_PHP_DIR}/${minor}`;
  return [
    '[Unit]',
    `Description=Keel PHP ${minor} FPM`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStartPre=+/usr/bin/mkdir -p ${KEEL_PHP_RUN_DIR}`,
    `ExecStart=${prefix}/sbin/php-fpm --nodaemonize --fpm-config ${prefix}/etc/php-fpm.conf`,
    'ExecReload=/bin/kill -USR2 $MAINPID',
    'PrivateTmp=true',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function fpmOwner() {
  const passwd = (() => { try { return fs.readFileSync('/etc/passwd', 'utf8'); } catch { return ''; } })();
  const present = FPM_OWNERS.find((u) => passwd.split('\n').some((l) => l.startsWith(`${u}:`)));
  return present || (fs.existsSync('/etc/apache2') ? 'www-data' : 'apache');
}

function readBuildMarker(dir) {
  try { const m = JSON.parse(fs.readFileSync(path.join(dir, BUILD_MARKER), 'utf8')); return m && typeof m === 'object' ? m : null; } catch { return null; }
}

function buildDirsFor(root, minor) {
  return safeReaddir(root).filter((n) => n.startsWith('.build-')).map((n) => path.join(root, n)).filter((d) => { try { return fs.lstatSync(d).isDirectory() && readBuildMarker(d)?.minor === minor; } catch { return false; } });
}

// A background build is alive while its run is still running; a sync build
// (no run id) counts as alive until the 90-minute budget has passed, a finished
// one is marked done by the op itself.
function buildLive(marker) {
  if (!marker || marker.done) return false;
  if (marker.runId) {
    const state = readRunState(marker.runId);
    return Boolean(state) && state.status === 'running' && runAlive(state);
  }
  const started = Date.parse(marker.startedAt || '') || 0;
  return Date.now() - started < PHP_BUILD_TIMEOUT;
}

function removeBuildDirs(root, minor) {
  const dirs = buildDirsFor(root, minor);
  for (const d of dirs) {
    const marker = readBuildMarker(d);
    if (buildLive(marker)) throw new OpError('in_use', `A build of PHP ${minor} started ${marker.startedAt} is still running (${d})`);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  return dirs;
}

const buildLockPath = (root, minor) => path.join(root, `.build-${minor}.lock`);

// One build per minor: the lock is taken before the first network call so two
// pkg.php.build calls cannot both pass the marker check. A lock left by an
// agent that died is stale once no build of the minor is alive and its holder
// process is gone (or the budget has passed).
function takeBuildLock(root, minor) {
  const lock = buildLockPath(root, minor);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); } finally { fs.closeSync(fd); }
      return lock;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* unreadable: stale */ }
      const started = Date.parse(holder?.startedAt || '') || 0;
      const holderAlive = (() => { try { return Number.isInteger(holder?.pid) && holder.pid > 0 && (process.kill(holder.pid, 0), true); } catch { return false; } })();
      if (buildDirsFor(root, minor).some((d) => buildLive(readBuildMarker(d))) || (holderAlive && Date.now() - started < PHP_BUILD_TIMEOUT)) {
        throw new OpError('in_use', `A build of PHP ${minor} is already in progress (${lock})`);
      }
      fs.rmSync(lock, { force: true });
    }
  }
  throw new OpError('in_use', `A build of PHP ${minor} is already in progress (${lock})`);
}

function keelPaths(minor, ctx) {
  const root = keelPhpDir();
  if (root !== KEEL_PHP_DIR) ctx.assertAllowedPath(root, 'write');
  const prefix = ctx.assertAllowedPath(path.join(root, minor), 'write');
  const unit = keelPhpUnit(minor);
  const unitFile = ctx.assertAllowedPath(path.join(systemdUnitDir(), `${unit}.service`), 'write');
  const link = ctx.assertAllowedPath(path.join(localBinDir(), `php${minor}`), 'write');
  return { root, prefix, unit, unitFile, link, binary: path.join(prefix, 'bin', 'php'), fpm: path.join(prefix, 'sbin', 'php-fpm') };
}

defineOp('pkg.php.build', {
  description: 'Build a PHP minor from the official php.net source into /opt/keel/php/<minor> (download, checksum, configure/make/make install through the shipped php-build.sh); pkg.php.build.finish registers the FPM unit afterwards',
  timeoutMs: PHP_BUILD_TIMEOUT,
  schema: z.object({ minor: phpMinor, wait }).strict(),
  run: async ({ minor, wait: waitFor }, ctx) => {
    const { root, prefix } = keelPaths(minor, ctx);
    if (!PHP_SOURCE_MINORS.includes(minor)) throw new OpError('unsupported', `php.net's last PHP ${minor} release does not compile against this OS's libxml2/ICU; source builds cover PHP ${PHP_SOURCE_MINORS.join(', ')}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    const lock = takeBuildLock(root, minor);
    let builddir = null;
    try {
      removeBuildDirs(root, minor);
      const output = [];
      const index = await exec('curl', [...CURL_SHORT, `${PHP_RELEASES_URL}?json&version=${minor}`], { timeoutMs: 90_000, maxBuffer: BIG });
      const release = parsePhpRelease(index.stdout, minor);
      output.push(`Resolved PHP ${minor} to ${release.version} (${release.filename})`);
      builddir = fs.mkdtempSync(path.join(root, '.build-'));
      fs.chmodSync(builddir, 0o700);
      const marker = { minor, version: release.version, startedAt: new Date().toISOString() };
      const markerPath = path.join(builddir, BUILD_MARKER);
      writeAtomic(markerPath, JSON.stringify(marker), { mode: 0o600 });
      const archive = path.join(builddir, release.filename);
      const src = path.join(builddir, `php-${release.version}`);
      output.push(`Downloading ${PHP_DIST_URL}/${release.filename}`);
      await exec('curl', [...CURL_PHP, '-o', archive, `${PHP_DIST_URL}/${release.filename}`], { timeoutMs: 920_000, maxBuffer: BIG });
      const st = fs.lstatSync(archive);
      if (!st.isFile()) throw new OpError('download_failed', `${archive} is not a regular file`);
      if (!verifySha256(fs.readFileSync(archive), release.sha256)) throw new OpError('checksum_mismatch', `${release.filename} does not match the SHA-256 published by php.net; nothing was built`);
      output.push(`Checksum verified (${release.sha256.slice(0, 12)})`);
      // GNU tar as root would keep the archive's uid; the source tree stays ours and configure/make run in it as root.
      await exec('tar', ['--no-same-owner', '--no-same-permissions', '-xJf', archive, '-C', builddir], { timeoutMs: 10 * 60_000, maxBuffer: BIG });
      fs.rmSync(archive, { force: true });
      if (!fs.existsSync(path.join(src, 'configure'))) throw new OpError('extract_failed', `${release.filename} did not contain php-${release.version}/configure`);
      // A Windows checkout may carry CRLF; bash would read "\r" as part of every line.
      const script = fs.readFileSync(BUILD_SCRIPT, 'utf8').replace(/\r\n/g, '\n');
      const scriptPath = path.join(builddir, 'php-build.sh');
      writeAtomic(scriptPath, script, { mode: 0o700 });
      const owner = fpmOwner();
      const env = {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/root',
        KEEL_PHP_SRC: src, KEEL_PHP_PREFIX: prefix, KEEL_PHP_MINOR: minor, KEEL_PHP_JOBS: String(Math.max(1, os.cpus().length || 1)), KEEL_FPM_USER: owner, KEEL_FPM_GROUP: owner,
      };
      output.push(`Building PHP ${release.version} into ${prefix} with ${env.KEEL_PHP_JOBS} job(s) as ${scriptPath}`);
      const result = await runLong({ kind: 'build', bin: 'bash', argv: [scriptPath], env, timeoutMs: PHP_BUILD_TIMEOUT, wait: waitFor, allowFailure: true }, ctx);
      if (!result.background && result.code !== 0) throw new OpError('build_failed', `The PHP ${release.version} build exited with status ${result.code}: ${result.output.slice(-1)[0] || 'no output'}`, { output: result.output.slice(-40) });
      // The run id lets the next build (and finish/remove) tell a failed background build from one still running.
      writeAtomic(markerPath, JSON.stringify(result.background ? { ...marker, runId: result.run.id } : { ...marker, done: true }), { mode: 0o600 });
      const done = finished(result);
      return { minor, version: release.version, release, prefix, buildDir: builddir, script: scriptPath, ...done, output: done.background ? output : [...output, ...done.output] };
    } catch (err) {
      if (builddir) fs.rmSync(builddir, { recursive: true, force: true });
      throw err;
    } finally {
      fs.rmSync(lock, { force: true });
    }
  },
});

defineOp('pkg.php.release', {
  description: 'The newest php.net release of a minor (JSON index lookup; changes nothing)',
  timeoutMs: 120_000,
  schema: z.object({ minor: phpMinor }).strict(),
  run: async ({ minor }) => {
    const index = await exec('curl', [...CURL_SHORT, `${PHP_RELEASES_URL}?json&version=${minor}`], { timeoutMs: 90_000, maxBuffer: BIG });
    return { minor, ...parsePhpRelease(index.stdout, minor) };
  },
});

async function phpVersionAt(bin) {
  try { const r = await exec(bin, ['-n', '-r', 'echo PHP_VERSION;'], { allowFailure: true, timeoutMs: PROBE_TIMEOUT }); return r.code === 0 ? r.stdout.trim().match(/^\d[\d.]*/)?.[0] ?? null : null; } catch { return null; }
}

defineOp('pkg.php.build.finish', {
  description: 'After pkg.php.build: write the keel-php<minor>-fpm unit, enable and start it (restart it when it already exists), place /usr/local/bin/php<minor> and drop the build directory; idempotent',
  timeoutMs: 10 * 60_000,
  schema: z.object({ minor: phpMinor }).strict(),
  run: async ({ minor }, ctx) => {
    const { root, prefix, unit, unitFile, link, binary, fpm } = keelPaths(minor, ctx);
    if (!fs.existsSync(binary) || !fs.existsSync(fpm) || !fs.existsSync(path.join(prefix, 'etc', 'php-fpm.conf')) || !fs.existsSync(path.join(prefix, BUILD_OK))) {
      throw new OpError('build_failed', `PHP ${minor} is not installed under ${prefix} (bin/php, sbin/php-fpm, etc/php-fpm.conf or ${BUILD_OK} missing); the build did not complete`);
    }
    const marker = buildDirsFor(root, minor).map(readBuildMarker).find(Boolean);
    if (buildLive(marker)) throw new OpError('in_use', `A build of PHP ${minor} started ${marker.startedAt} is still running`);
    const version = (await phpVersionAt(binary)) || marker?.version || null;
    // A unit that is running belongs to an earlier build of the minor: the new
    // binaries are picked up by a restart, enable --now would leave the old
    // php-fpm running. A unit file alone is not enough: a first enable that
    // failed, or a unit the admin stopped, gets enable --now again rather than
    // a restart that would leave it unenabled or start what was stopped on purpose.
    const wasActive = hasBinary('systemctl') && fs.existsSync(unitFile) ? await unitActive(unit) === true : false;
    writeAtomic(unitFile, renderPhpUnit(minor), { mode: 0o644 });
    let active = null;
    let enabled = null;
    let unitError = null;
    if (hasBinary('systemctl')) {
      await exec('systemctl', ['daemon-reload'], { allowFailure: true, timeoutMs: 120_000 });
      const r = await exec('systemctl', wasActive ? ['restart', `${unit}.service`] : ['enable', '--now', `${unit}.service`], { allowFailure: true, timeoutMs: 180_000 });
      if (r.code !== 0) unitError = (r.stderr || r.stdout).trim().split('\n').pop() || `systemctl exited with status ${r.code}`;
      active = await unitActive(unit);
      const en = await exec('systemctl', ['is-enabled', `${unit}.service`], { allowFailure: true, timeoutMs: 60_000 });
      enabled = en.code === 0 ? true : en.stdout.trim() === 'disabled' ? false : null;
    }
    const placed = placeSymlink(link, binary, root);
    const buildDirsRemoved = removeBuildDirs(root, minor);
    fs.rmSync(buildLockPath(root, minor), { force: true });
    return { minor, version, prefix, binary, unit, unitFile, active, enabled, ...(unitError ? { unitError } : {}), ...(wasActive ? { restarted: true } : {}), link: placed.placed ? link : null, ...(placed.placed ? {} : { linkConflict: placed.reason }), buildDirsRemoved };
  },
});

// --- what is installed, for the one-click catalog ----------------------------

const PYTHON_MINORS = ['3.8', '3.9', '3.10', '3.11', '3.12', '3.13', '3.14'];

defineOp('pkg.runtime.detect', {
  description: 'Installed language runtimes (PHP, Node.js, Python, Ruby, Go, Composer, Perl) found by probing their binaries; installs nothing',
  timeoutMs: 120_000,
  run: async (_args, ctx) => {
    const os = readOsRelease(ctx);
    const php = [];
    for (const v of discoverPhp().versions) {
      let version = null;
      try { const r = await exec(v.binary, ['-n', '-r', 'echo PHP_VERSION;'], { allowFailure: true, timeoutMs: PROBE_TIMEOUT }); version = r.stdout.trim().match(/^\d[\d.]*/)?.[0] ?? null; } catch { /* unreadable binary */ }
      php.push({ id: v.id, version, layout: v.layout, source: Boolean(v.source), ...(v.prefix ? { prefix: v.prefix } : {}) });
    }
    const node = await listNode(ctx);
    const python = [];
    for (const minor of PYTHON_MINORS) {
      const bin = resolveBinary(`python${minor}`);
      if (!bin) continue;
      python.push({ minor, version: await probeVersion(`python${minor}`, ['--version'], /Python (\d+\.\d+(?:\.\d+)?)/), bin });
    }
    return {
      os, php, node, python,
      ruby: await probeVersion('ruby', ['--version'], /ruby (\d+\.\d+(?:\.\d+)?)/),
      go: await probeVersion('go', ['version'], /go(\d+\.\d+(?:\.\d+)?)/),
      composer: await probeVersion('composer', ['--version', '--no-ansi', '--no-interaction', '--no-plugins', '--no-scripts'], /Composer(?: version)? (\d+\.\d+(?:\.\d+)?)/),
      perl: await probeVersion('perl', ['-e', 'print $^V'], /v?(\d+\.\d+(?:\.\d+)?)/),
    };
  },
});
