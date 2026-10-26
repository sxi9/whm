import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

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
    return cmdline.length > 0 && path.basename(cmdline[0]) === path.basename(state.bin);
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

export function pollRun(id, { offset = 0, maxBytes = 256 * 1024 } = {}, ctx) {
  ctx.assertAllowedPath(runDir(), 'read');
  let state = readRunState(id);
  if (!state) throw new OpError('not_found', `Unknown package run "${id}"`);
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

defineOp('pkg.search', {
  description: 'Search the package repositories by name',
  timeoutMs: 120_000,
  schema: z.object({ q: searchTerm, limit: z.number().int().min(1).max(500).default(100) }).strict(),
  run: async ({ q, limit }) => {
    const pm = requireManager();
    let results;
    if (pm.family === 'debian') {
      const { stdout } = await exec('apt-cache', ['search', '--names-only', '--', q], { allowFailure: true, env: APT_ENV });
      results = parseAptSearch(stdout);
    } else {
      const { stdout } = await exec(pm.binary, ['-q', '-y', 'search', '--', q], { allowFailure: true, timeoutMs: 120_000 });
      results = parseDnfSearch(stdout);
    }
    const needle = q.toLowerCase();
    results.sort((a, b) => (a.name.toLowerCase() === needle ? -1 : b.name.toLowerCase() === needle ? 1 : a.name.toLowerCase().startsWith(needle) === b.name.toLowerCase().startsWith(needle) ? a.name.localeCompare(b.name) : a.name.toLowerCase().startsWith(needle) ? -1 : 1));
    results = results.slice(0, limit);
    const installed = new Map((await installedPackages()).packages.map((p) => [p.name, p.version]));
    return { manager: pm.manager, q, results: results.map((r) => ({ ...r, installed: installed.has(r.name), installedVersion: installed.get(r.name) ?? null })) };
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

defineOp('pkg.remove_simulate', {
  description: 'Which packages a removal would take out, reverse dependencies included (apt-get -s remove / dnf remove --assumeno); changes nothing',
  timeoutMs: 5 * 60_000,
  schema: z.object({ packages: z.array(pkgName).min(1).max(200), purge: z.boolean().default(false) }).strict(),
  run: async ({ packages, purge }) => {
    const pm = requireManager();
    const installed = new Set((await installedPackages()).packages.map((p) => p.name));
    const present = packages.filter((p) => installed.has(p));
    if (!present.length) return { manager: pm.manager, requested: packages, present, remove: [], collateral: [], output: [] };
    let removed;
    let output;
    if (pm.family === 'debian') {
      const r = await exec('apt-get', ['-s', '-q', '-o', 'Debug::NoLocking=true', purge ? 'purge' : 'remove', '--', ...present], { env: APT_ENV, allowFailure: true, timeoutMs: 5 * 60_000, maxBuffer: BIG });
      if (r.code !== 0) throw new OpError('command_failed', `apt-get could not simulate the removal: ${r.stderr.trim().split('\n').pop() || 'unknown error'}`, { output: tail(`${r.stdout}\n${r.stderr}`, 50) });
      removed = parseAptRemoveSimulation(r.stdout);
      output = tail(r.stdout, 200);
    } else {
      const r = await exec(pm.binary, ['-q', 'remove', '--assumeno', '--', ...present], { allowFailure: true, timeoutMs: 5 * 60_000, maxBuffer: BIG });
      removed = parseDnfRemoveSimulation(`${r.stdout}\n${r.stderr}`);
      if (!removed.length && r.code !== 0 && !/Operation aborted|Nothing to do/i.test(`${r.stdout}\n${r.stderr}`)) throw new OpError('command_failed', `${pm.binary} could not simulate the removal: ${r.stderr.trim().split('\n').pop() || 'unknown error'}`, { output: tail(`${r.stdout}\n${r.stderr}`, 50) });
      output = tail(`${r.stdout}\n${r.stderr}`, 200);
    }
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
    '# Managed by WHM panel (Software > NGINX Manager). Edits are overwritten on the next sync.',
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
