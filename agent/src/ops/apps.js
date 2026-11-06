import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { accountPath, assertManaged, asUser, failureOf, lastLine } from './as-user.js';

// Application Manager (contract §65): an account's Node.js or Python program runs
// as a systemd service under the account's own uid and is reached by Apache over
// loopback (the vhost proxies of web.vhost.write). The unit file is rendered here
// from a fixed template — never from text the panel sends — into
// /etc/whm/apps/<username>/<name>.service and linked into systemd with
// `systemctl link`; nothing under /etc/systemd/system is written by this module.
// Dependency installs (npm, pip) run as the account, never as root.

export const APPS_DIR = '/etc/whm/apps';
export const NODE_DIR = '/opt/keel/node';
export const UNIT_PREFIX = 'keel-app';
export const APP_TYPES = ['node', 'python'];
export const APP_NAME_RE = /^[a-z0-9-]{2,32}$/;
// A path relative to the home: no leading "/" or "-", no ".." segment, only
// characters systemd reads verbatim in WorkingDirectory=/ExecStart= (no spaces, quotes or "%").
export const APP_REL_RE = /^(?!-)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._][A-Za-z0-9._\/-]{0,255}$/;
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const ENV_VALUE_RE = /^[^\0\r\n]{0,1024}$/;
export const NODE_RUNTIME_RE = /^(system|[1-9]\d)$/;
export const PYTHON_RUNTIME_RE = /^(system|3\.\d{1,2})$/;
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
export const LOGS_MAX_LINES = 500;
export const DEPS_TIMEOUT_MS = 20 * 60_000;
export const RESERVED_ENV = new Set(['PORT', 'HOME', 'USER', 'LOGNAME', 'PATH']);
const MANAGED = '# Managed by Keel (Application Manager). Edit through the panel; manual changes are overwritten.';

const appsDir = () => process.env.WHM_APPS_DIR || APPS_DIR;
const nodeDir = () => process.env.WHM_NODE_DIR || NODE_DIR;

// "." separates the two parts because neither a username nor an app name may
// contain it ("-" is legal in both, so "a-b"/"c" and "a"/"b-c" would collide).
export const unitName = (username, name) => `${UNIT_PREFIX}-${username}.${name}`;
export const unitFile = (username, name) => path.join(appsDir(), username, `${name}.service`);

const appName = z.string().regex(APP_NAME_RE, '2 to 32 lowercase letters, digits or "-"');
const appRel = z.string().regex(APP_REL_RE, 'A path relative to the home directory without "..", spaces or quotes');
const appType = z.enum(APP_TYPES);
const runtime = z.string().regex(/^(system|[1-9]\d|3\.\d{1,2})$/, 'A Node.js major such as 22, a Python minor such as 3.12, or "system"');
const port = z.number().int().min(PORT_MIN).max(PORT_MAX);
const envMap = z.record(z.string().regex(ENV_KEY_RE, 'Upper-case letters, digits and "_", not starting with a digit'), z.string().regex(ENV_VALUE_RE, 'One line of at most 1024 characters'))
  .refine((m) => Object.keys(m).length <= 64, 'At most 64 variables')
  .refine((m) => !Object.keys(m).some((k) => RESERVED_ENV.has(k)), `${[...RESERVED_ENV].join(', ')} are set by the panel`);
const memoryMax = z.string().regex(/^[1-9]\d{0,5}[MG]$/, 'A size such as 512M or 2G');

const appSchema = z.object({
  username: arg.username, name: appName, type: appType, dir: appRel, entry: appRel, runtime, port, env: envMap.default({}), memoryMax: memoryMax.nullable().optional(),
}).strict().superRefine((a, ctx) => {
  const re = a.type === 'node' ? NODE_RUNTIME_RE : PYTHON_RUNTIME_RE;
  if (!re.test(a.runtime)) ctx.addIssue({ code: 'custom', path: ['runtime'], message: a.type === 'node' ? 'A Node.js major such as 22, or "system"' : 'A Python minor such as 3.12, or "system"' });
});
const unitRef = z.object({ username: arg.username, name: appName }).strict();

// The unit carries the account's own variables (keys, passwords): only root
// reads the directory and the file; systemd runs as root and `systemctl link`
// needs nothing more than the path.
function writeAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// systemd reads Environment= values inside double quotes with backslash escapes
// and expands %-specifiers (%h, %u, …) in them, so a literal % is doubled; the
// schema already keeps the value to one line.
export function quoteEnv(key, value) {
  return `"${key}=${String(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The interpreter the unit starts: a Keel Node.js build (/opt/keel/node/<major>/bin/node),
// the system node, a python3.x on PATH or the system python3. Resolved here, as
// root, so the unit never searches a PATH the account controls.
export function interpreterFor(type, runtimeId) {
  if (type === 'node') {
    if (runtimeId === 'system') {
      const bin = resolveBinary('node');
      if (!bin) throw new OpError('capability_missing', 'No system Node.js is installed (install nodejs, or a Keel Node.js build)');
      return { bin, npm: resolveBinary('npm'), binDir: path.dirname(bin) };
    }
    const dir = path.join(nodeDir(), runtimeId);
    const bin = path.join(dir, 'bin', 'node');
    if (!fs.existsSync(bin)) throw new OpError('not_found', `Node.js ${runtimeId} is not installed under ${nodeDir()}`);
    return { bin, npm: path.join(dir, 'bin', 'npm'), binDir: path.join(dir, 'bin') };
  }
  const name = runtimeId === 'system' ? 'python3' : `python${runtimeId}`;
  const bin = resolveBinary(name);
  if (!bin) throw new OpError(runtimeId === 'system' ? 'capability_missing' : 'not_found', `${name} is not installed on this server`);
  return { bin, binDir: path.dirname(bin) };
}

// The unit text. Hardening is fixed: the service runs as the account with no
// new privileges, sees the file system read-only except its home, gets a
// private /tmp and is restarted only after a failure.
export function renderUnit({ username, name, type, dir, entry, runtime: runtimeId, port: appPort, env = {}, memoryMax: mem = null, home, gid, execBin, venv = false }) {
  const workdir = path.posix.join(home, dir);
  const program = venv ? path.posix.join(workdir, '.venv', 'bin', 'python') : execBin;
  const lines = [
    MANAGED,
    `# whm-app ${JSON.stringify({ username, name, type, dir, entry, runtime: runtimeId, port: appPort, venv })}`,
    '[Unit]',
    `Description=Keel application ${name} (${username}, ${type})`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${username}`,
    `Group=${gid != null ? gid : username}`,
    `WorkingDirectory=${workdir}`,
    `Environment=${quoteEnv('PORT', String(appPort))}`,
    `Environment=${quoteEnv('HOME', home)}`,
    `Environment=${quoteEnv('PATH', `${path.dirname(execBin)}:/usr/local/bin:/usr/bin:/bin`)}`,
    ...(type === 'node' ? [`Environment=${quoteEnv('NODE_ENV', 'production')}`] : []),
    ...Object.keys(env).sort().map((k) => `Environment=${quoteEnv(k, env[k])}`),
    `ExecStart=${program} ${path.posix.join(workdir, entry)}`,
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStopSec=20',
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    `ReadWritePaths=${home}`,
    'PrivateTmp=true',
    'ProtectKernelTunables=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${unitName(username, name)}`,
    ...(mem ? [`MemoryMax=${mem}`] : []),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ];
  return `${lines.join('\n')}\n`;
}

export function parseUnitMeta(text) {
  const line = (text || '').split('\n').find((l) => l.startsWith('# whm-app '));
  if (!line) return null;
  try { return JSON.parse(line.slice('# whm-app '.length)); } catch { return null; }
}

function requireSystemd() {
  if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'systemd is not available on this host');
}

async function systemctl(argv, { allowFailure = false, timeoutMs = 120_000 } = {}) {
  return exec('systemctl', argv, { allowFailure, timeoutMs });
}

const systemLink = (unit) => path.join('/etc/systemd/system', `${unit}.service`);

function linkedTo(unit) {
  try {
    const st = fs.lstatSync(systemLink(unit));
    return st.isSymbolicLink() ? fs.readlinkSync(systemLink(unit)) : false;
  } catch { return null; }
}

export function parseShow(stdout) {
  const kv = {};
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const installed = Boolean(kv.LoadState) && kv.LoadState !== 'not-found';
  return {
    installed,
    active: kv.ActiveState === 'active',
    state: installed ? kv.ActiveState || 'unknown' : 'absent',
    subState: kv.SubState || null,
    enabled: kv.UnitFileState === 'enabled' || kv.UnitFileState === 'linked',
    unitFileState: kv.UnitFileState || null,
    pid: Number(kv.MainPID) || null,
    startedAt: kv.ExecMainStartTimestamp || null,
    memoryBytes: /^\d+$/.test(kv.MemoryCurrent || '') ? Number(kv.MemoryCurrent) : null,
    restarts: Number(kv.NRestarts) || 0,
    result: kv.Result || null,
  };
}

async function unitStatus(unit) {
  const props = ['ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'ExecMainStartTimestamp', 'MemoryCurrent', 'NRestarts', 'LoadState', 'Result'];
  const { stdout } = await systemctl(['show', `${unit}.service`, '--no-pager', `--property=${props.join(',')}`], { allowFailure: true });
  return { unit, ...parseShow(stdout) };
}

// The account's app directory and entry file, resolved through as-user.js
// (home from /etc/passwd, symlinks confined to the home) and required to exist.
function appDirOf(username, dir, entry, ctx) {
  const info = assertManaged(username);
  const home = ctx.assertAllowedPath(path.resolve(info.home), 'read');
  const d = accountPath(username, path.join(home, dir), ctx, 'read');
  let st = null;
  try { st = fs.statSync(d.real); } catch { st = null; }
  if (!st || !st.isDirectory()) throw new OpError('not_found', `${dir} is not a directory in the home of ${username}`);
  const e = accountPath(username, path.join(home, dir, entry), ctx, 'read');
  let est = null;
  try { est = fs.statSync(e.real); } catch { est = null; }
  if (!est || !est.isFile()) throw new OpError('not_found', `${path.posix.join(dir, entry)} does not exist; upload the application first`);
  return { info, home, dir: d, entry: e, venv: fs.existsSync(path.join(d.real, '.venv', 'bin', 'python')) };
}

defineOp('apps.unit.write', {
  description: 'Render the systemd unit of an account application under /etc/whm/apps, link it into systemd, enable it and (re)start it',
  timeoutMs: 180_000,
  schema: appSchema,
  run: async (a, ctx) => {
    requireSystemd();
    const app = appDirOf(a.username, a.dir, a.entry, ctx);
    const interp = interpreterFor(a.type, a.runtime);
    const unit = unitName(a.username, a.name);
    const file = ctx.assertAllowedPath(unitFile(a.username, a.name), 'write');
    const venv = a.type === 'python' && app.venv;
    const content = renderUnit({ ...a, home: app.home, gid: app.info.gid, execBin: interp.bin, venv });
    const previous = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } })();
    if (previous != null && !previous.startsWith(MANAGED)) throw new OpError('refused', `${file} was not written by the panel; refusing to overwrite it`);
    const link = linkedTo(unit);
    if (link !== file && link != null) throw new OpError('refused', `${systemLink(unit)} exists and is not the panel's link`);
    writeAtomic(file, content);
    if (link !== file) {
      const r = await systemctl(['link', file], { allowFailure: true });
      if (r.code !== 0) throw new OpError('command_failed', `systemctl link: ${lastLine(r)}`);
    }
    await systemctl(['daemon-reload'], { allowFailure: true });
    const en = await systemctl(['enable', `${unit}.service`], { allowFailure: true });
    if (en.code !== 0) throw new OpError('command_failed', `systemctl enable: ${lastLine(en)}`);
    const start = await systemctl(['restart', `${unit}.service`], { allowFailure: true });
    const status = await unitStatus(unit);
    return { unit, path: file, bytes: Buffer.byteLength(content), interpreter: interp.bin, venv, started: start.code === 0, startError: start.code === 0 ? null : lastLine(start), status };
  },
});

defineOp('apps.unit.remove', {
  description: 'Stop, disable and unlink the systemd unit of an account application and delete its file under /etc/whm/apps',
  destructive: true,
  timeoutMs: 120_000,
  schema: unitRef,
  run: async ({ username, name }, ctx) => {
    requireSystemd();
    const unit = unitName(username, name);
    const file = ctx.assertAllowedPath(unitFile(username, name), 'write');
    const existed = fs.existsSync(file);
    if (existed && !fs.readFileSync(file, 'utf8').startsWith(MANAGED)) throw new OpError('refused', `${file} was not written by the panel; refusing to delete it`);
    await systemctl(['disable', '--now', `${unit}.service`], { allowFailure: true });
    // `disable` drops the link that `systemctl link` created; a stale one left by hand is reported, not forced.
    const link = linkedTo(unit);
    if (link === file) { try { fs.unlinkSync(systemLink(unit)); } catch { /* raced */ } }
    if (existed) fs.unlinkSync(file);
    await systemctl(['daemon-reload'], { allowFailure: true });
    await systemctl(['reset-failed', `${unit}.service`], { allowFailure: true });
    return { unit, path: file, removed: existed };
  },
});

defineOp('apps.unit.control', {
  description: 'Start, stop or restart the systemd unit of an account application',
  destructive: true,
  timeoutMs: 120_000,
  schema: unitRef.extend({ action: z.enum(['start', 'stop', 'restart']) }).strict(),
  run: async ({ username, name, action }) => {
    requireSystemd();
    const unit = unitName(username, name);
    const status = await unitStatus(unit);
    if (!status.installed) throw new OpError('not_found', `${unit} is not installed`);
    const r = await systemctl([action, `${unit}.service`], { allowFailure: true });
    if (r.code !== 0) throw new OpError('command_failed', `systemctl ${action}: ${lastLine(r)}`);
    return { unit, action, status: await unitStatus(unit) };
  },
});

defineOp('apps.unit.status', {
  description: 'State, PID, memory and restarts of the systemd unit of an account application',
  schema: unitRef,
  run: async ({ username, name }) => {
    requireSystemd();
    return unitStatus(unitName(username, name));
  },
});

defineOp('apps.unit.logs', {
  description: 'Newest journal lines of an account application',
  schema: unitRef.extend({ lines: z.number().int().min(1).max(LOGS_MAX_LINES).default(100) }).strict(),
  run: async ({ username, name, lines }) => {
    const unit = unitName(username, name);
    if (!hasBinary('journalctl')) return { unit, lines: [] };
    const { stdout } = await exec('journalctl', ['-u', `${unit}.service`, '-n', String(lines), '--no-pager', '-o', 'cat'], { allowFailure: true });
    return { unit, lines: stdout.split('\n').filter((l) => l !== '') };
  },
});

defineOp('apps.deps.install', {
  description: 'Install the dependencies of an account application as the account: npm install --omit=dev, or a .venv with pip install -r requirements.txt',
  timeoutMs: DEPS_TIMEOUT_MS + 30_000,
  schema: z.object({ username: arg.username, dir: appRel, type: appType, runtime }).strict(),
  run: async ({ username, dir, type, runtime: runtimeId }, ctx) => {
    const info = assertManaged(username);
    const home = ctx.assertAllowedPath(path.resolve(info.home), 'read');
    const d = accountPath(username, path.join(home, dir), ctx, 'read');
    if (!fs.existsSync(d.real) || !fs.statSync(d.real).isDirectory()) throw new OpError('not_found', `${dir} is not a directory in the home of ${username}`);
    const interp = interpreterFor(type, runtimeId);
    const steps = [];
    const env = { PATH: `${interp.binDir}:/usr/local/bin:/usr/bin:/bin`, CI: '1' };
    const run = async (label, bin, argv) => {
      const r = await asUser(info, bin, argv, { cwd: d.target, timeoutMs: DEPS_TIMEOUT_MS, allowFailure: true, env, nice: true });
      const output = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-80).join('\n');
      steps.push({ step: label, command: `${path.basename(bin)} ${argv.join(' ')}`, code: r.code, output });
      if (r.code !== 0) throw failureOf(r, label);
      return r;
    };
    if (type === 'node') {
      if (!fs.existsSync(path.join(d.real, 'package.json'))) return { dir, type, steps, skipped: 'no package.json' };
      if (!interp.npm || !fs.existsSync(interp.npm)) throw new OpError('capability_missing', `npm is not installed next to ${interp.bin}`);
      await run('npm install', interp.npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']);
      return { dir, type, steps };
    }
    const venv = path.join(d.real, '.venv');
    if (!fs.existsSync(path.join(venv, 'bin', 'python'))) await run('python -m venv', interp.bin, ['-m', 'venv', '.venv']);
    else steps.push({ step: 'python -m venv', command: 'skipped (exists)', code: 0, output: '' });
    if (!fs.existsSync(path.join(d.real, 'requirements.txt'))) return { dir, type, steps, skipped: 'no requirements.txt' };
    await run('pip install', path.join(venv, 'bin', 'python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', 'requirements.txt']);
    return { dir, type, steps };
  },
});

// `ss -ltn` lists listening TCP sockets as "LISTEN 0 128 0.0.0.0:31000 ..." or "[::]:31000".
export function parseListening(stdout) {
  const ports = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN') continue;
    const local = cols[3] || '';
    const m = local.match(/:(\d+)$/);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

defineOp('apps.port.free', {
  description: 'Whether nothing on this host listens on a loopback/any TCP port (ss -ltn)',
  schema: z.object({ port }).strict(),
  run: async ({ port: p }) => {
    if (!hasBinary('ss')) return { port: p, free: null, checked: false };
    const { stdout } = await exec('ss', ['-ltn'], { allowFailure: true, timeoutMs: 15_000 });
    return { port: p, free: !parseListening(stdout).has(p), checked: true };
  },
});
