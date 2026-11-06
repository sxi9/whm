import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { assertManaged, asUserArgv, requireAsUser } from './as-user.js';
import { TERM_RUN_DIR } from '../managed-paths.js';

// The account panel's Terminal (contract §68). The shell never runs inside the
// agent: term.open starts the shipped static bridge (term-bridge.py, parameters
// by argv and environment only) as the account through setpriv/runuser, and the
// bridge forks the account's login shell on a pty and serves one client on a unix
// socket under /run/whm/term/<id>/. The agent keeps only the bridge's pid and its
// control pipe (resize lines), so no shell byte ever passes through here. The
// panel process connects to the socket itself (group whmpanel, mode 0660).
export const BRIDGE = fileURLToPath(new URL('./term-bridge.py', import.meta.url));
export const PANEL_GROUP = 'whmpanel';
export const SOCKET_NAME = 'pty.sock';
export const LIMITS = { maxSessions: 32, perAccount: 4, idleSeconds: 15 * 60, maxSeconds: 4 * 60 * 60, readyMs: 10_000 };
export const DISABLED_SHELLS = new Set(['nologin', 'false']);
export const sessions = new Map();

const sessionId = z.string().regex(/^[a-f0-9]{32}$/);
const size = z.object({ cols: z.number().int().min(20).max(500).default(120), rows: z.number().int().min(5).max(200).default(32) });
const runDir = () => process.env.WHM_TERM_DIR || TERM_RUN_DIR;

export function groupIdOf(name, groupFile = '/etc/group') {
  try {
    const line = fs.readFileSync(groupFile, 'utf8').split('\n').find((l) => l.startsWith(`${name}:`));
    const gid = line ? Number(line.split(':')[2]) : NaN;
    return Number.isInteger(gid) ? gid : null;
  } catch { return null; }
}

// The shell the bridge will exec: from /etc/passwd, absolute, executable and
// not one of the "no login" programs an account without shell access carries.
export function loginShellOf(info) {
  const shell = info.shell || '';
  if (!path.isAbsolute(shell) || DISABLED_SHELLS.has(path.basename(shell))) throw new OpError('shell_disabled', `${info.username} has no shell access (${shell || 'no shell'})`);
  let st = null;
  try { st = fs.statSync(shell); } catch { st = null; }
  if (!st || !st.isFile() || (st.mode & 0o111) === 0) throw new OpError('capability_missing', `${shell} is not installed on this server`);
  return shell;
}

// /run/whm/term is root:whmpanel 0711 (the account traverses to its own
// directory, nobody lists it); the session directory is account:whmpanel 0710
// only until the bridge has bound its socket (adoptSocket hands it back to root).
function ensureRunDir() {
  const dir = runDir();
  let st;
  try { st = fs.lstatSync(dir); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(dir, { recursive: true, mode: 0o711 });
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OpError('path_not_allowed', `${dir} is not a directory`);
  if (st.uid !== 0 && st.uid !== process.getuid?.()) throw new OpError('path_not_allowed', `${dir} is owned by uid ${st.uid}, not by the agent`);
  const gid = groupIdOf(PANEL_GROUP);
  if ((st.mode & 0o777) !== 0o711) fs.chmodSync(dir, 0o711);
  if (gid != null && st.gid !== gid) { try { fs.chownSync(dir, 0, gid); } catch { /* not root (tests) */ } }
  return { dir, gid };
}

export function publicInfo(s) {
  return { id: s.id, username: s.username, socket: s.socket, pid: s.child.pid ?? null, startedAt: new Date(s.startedAt).toISOString(), cols: s.cols, rows: s.rows, exited: s.exited, exitReason: s.exitReason };
}

function cleanup(s) {
  sessions.delete(s.id);
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

function terminate(s) {
  if (s.exited) { cleanup(s); return; }
  try { s.child.kill('SIGHUP'); } catch { /* already gone */ }
  const t = setTimeout(() => { if (!s.exited) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } } }, 2000);
  t.unref();
}

function get(id) {
  const s = sessions.get(id);
  if (!s) throw new OpError('not_found', `Terminal session ${id} does not exist (it may have ended)`);
  return s;
}

// The socket the bridge created, checked without following links before root
// changes its group: a socket owned by the account at the expected path, nothing
// else. The session directory then goes back to root: while the account owns it,
// a shell could replace pty.sock with a link to another socket (the agent's own)
// and have the panel relay the browser into it. The bridge's own unlink of the
// socket at exit fails with EACCES from then on, which it swallows; cleanup()
// removes the directory as root.
function adoptSocket(socketPath, info, gid) {
  const st = fs.lstatSync(socketPath);
  if (!st.isSocket() || st.uid !== info.uid) throw new OpError('refused', `${socketPath} is not the account's socket`);
  const dir = path.dirname(socketPath);
  try { fs.chownSync(dir, 0, gid ?? 0); } catch { /* not root (tests) */ }
  fs.chmodSync(dir, 0o710);
  if (gid != null) fs.chownSync(socketPath, info.uid, gid);
  fs.chmodSync(socketPath, 0o660);
}

defineOp('term.open', {
  description: 'Start a login shell of a hosting account on a pty behind a unix socket under /run/whm/term (the shipped term-bridge.py, run as the account)',
  destructive: true,
  timeoutMs: 30_000,
  schema: size.extend({ username: arg.username }).strict(),
  run: async ({ username, cols, rows }, ctx) => {
    const info = assertManaged(username);
    const shell = loginShellOf(info);
    if (!hasBinary('python3')) throw new OpError('capability_missing', 'python3 is required for the in-browser terminal');
    const tool = requireAsUser();
    const live = [...sessions.values()].filter((s) => !s.exited);
    if (live.length >= LIMITS.maxSessions) throw new OpError('refused', `At most ${LIMITS.maxSessions} terminal sessions may be open on this server at once`);
    if (live.filter((s) => s.username === username).length >= LIMITS.perAccount) throw new OpError('refused', `At most ${LIMITS.perAccount} terminal sessions may be open for ${username} at once`);
    const { dir: root, gid } = ensureRunDir();
    const id = crypto.randomBytes(16).toString('hex');
    const dir = ctx.assertAllowedPath(path.join(root, id), 'write');
    const socketPath = path.join(dir, SOCKET_NAME);
    fs.mkdirSync(dir, { mode: 0o710 });
    try { fs.chownSync(dir, info.uid, gid ?? info.gid); } catch { /* not root (tests) */ }
    const [exe, args] = asUserArgv(info, resolveBinary('python3'), [BRIDGE, socketPath, String(cols), String(rows), String(LIMITS.idleSeconds), String(LIMITS.maxSeconds)], { tool });
    const child = spawn(exe, args, {
      cwd: info.home,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: info.home, USER: info.username, LOGNAME: info.username, SHELL: shell, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
      windowsHide: true,
    });
    const s = { id, username, dir, socket: socketPath, child, cols, rows, startedAt: Date.now(), exited: false, exitReason: null, stderr: '' };
    child.stdin.on('error', () => {});
    child.stderr.on('data', (buf) => { s.stderr = (s.stderr + buf.toString()).slice(-4000); });
    child.on('error', (err) => { s.stderr = `${s.stderr}${err.message}`; });
    const ready = new Promise((resolve) => {
      let out = '';
      child.stdout.on('data', (buf) => {
        out += buf.toString();
        if (/^ready$/m.test(out)) resolve(true);
        const m = out.match(/^exit (\w+)$/m);
        if (m) s.exitReason = m[1];
      });
      child.on('exit', () => resolve(false));
      setTimeout(() => resolve(false), LIMITS.readyMs).unref();
    });
    child.on('exit', (code, signal) => {
      s.exited = true;
      s.exitCode = code;
      s.signal = signal;
      cleanup(s);
    });
    sessions.set(id, s);
    if (!(await ready)) {
      terminate(s);
      const line = s.stderr.trim().split('\n').pop() || 'the terminal bridge did not start';
      if (/^shell_disabled/.test(line)) throw new OpError('shell_disabled', line);
      throw new OpError('command_failed', `term-bridge: ${line}`);
    }
    try {
      adoptSocket(socketPath, info, gid);
    } catch (err) {
      terminate(s);
      throw err instanceof OpError ? err : new OpError('command_failed', `terminal socket: ${err.message}`);
    }
    return publicInfo(s);
  },
});

defineOp('term.resize', {
  description: 'Tell a terminal session its new window size',
  schema: size.extend({ id: sessionId }).strict(),
  run: async ({ id, cols, rows }) => {
    const s = get(id);
    if (s.exited) throw new OpError('exited', 'The terminal has ended');
    s.cols = cols;
    s.rows = rows;
    s.child.stdin.write(`resize ${cols} ${rows}\n`);
    return { id, cols, rows };
  },
});

defineOp('term.close', {
  description: 'End a terminal session (SIGHUP to the bridge, SIGKILL after 2 s) and remove its socket directory',
  destructive: true,
  schema: z.object({ id: sessionId }).strict(),
  run: async ({ id }) => {
    const s = sessions.get(id);
    if (!s) return { id, existed: false };
    terminate(s);
    return { id, existed: true, pid: s.child.pid ?? null };
  },
});

defineOp('term.list', {
  description: 'Terminal sessions of a hosting account currently held by the agent',
  schema: z.object({ username: arg.username }).strict(),
  run: async ({ username }) => [...sessions.values()].filter((s) => s.username === username && !s.exited).map(publicInfo),
});
