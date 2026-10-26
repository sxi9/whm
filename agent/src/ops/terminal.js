import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveBinary, hasBinary } from '../exec.js';
import { defineOp, OpError } from './registry.js';

// The in-browser Terminal. An interactive shell outlives any single request, so
// this family keeps the child processes inside the agent and hands out chunks
// of their output on demand (the API polls terminal.read and streams the chunks
// over SSE). `script` gives the shell a real PTY while the agent talks to it over
// plain pipes; it is started with spawn() on an argv array for the same reason
// exec() uses execFile: nothing is ever parsed by a shell.
export const sessions = new Map();
export const LIMITS = { maxSessions: 8, historyBytes: 512 * 1024, exitedKeepMs: 5 * 60_000, sweepMs: 30_000 };

const sessionId = z.string().regex(/^[a-f0-9]{32}$/);
let sweeper = null;

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(sweep, LIMITS.sweepMs);
  sweeper.unref();
}

// An idle session is killed but kept (as closing/exited) for exitedKeepMs so
// the API's next read learns the reason instead of a bare not_found.
export function sweep(now = Date.now()) {
  const removed = [];
  for (const s of sessions.values()) {
    if (s.exited) {
      if (now - s.exitedAt > LIMITS.exitedKeepMs) { sessions.delete(s.id); removed.push(s.id); }
    } else if (s.closeReason) {
      if (now - s.closedAt > LIMITS.exitedKeepMs) { sessions.delete(s.id); removed.push(s.id); }
    } else if (now - s.lastActivity > s.idleMs) {
      terminate(s, 'idle', { keep: true });
      removed.push(s.id);
    }
  }
  return removed;
}

function terminate(s, reason, { keep = false } = {}) {
  if (!s.exited) {
    s.closeReason = reason;
    s.closedAt = Date.now();
    try { s.child.kill('SIGHUP'); } catch { /* already gone */ }
    const t = setTimeout(() => { if (!s.exited) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } } }, 2000);
    t.unref();
  }
  if (!keep) sessions.delete(s.id);
}

// Self-reported by the API, so not a security boundary; it keeps jobs and
// schedules (which run without a request principal) from ever opening a shell.
function requireRootPrincipal(ctx) {
  if (ctx?.principal?.role !== 'root') throw new OpError('refused', 'The terminal is available to the root administrator only');
}

function append(s, buf) {
  s.chunks.push({ offset: s.offset, data: buf });
  s.offset += buf.length;
  s.bytes += buf.length;
  while (s.bytes > LIMITS.historyBytes && s.chunks.length > 1) {
    const dropped = s.chunks.shift();
    s.bytes -= dropped.data.length;
  }
}

export function publicInfo(s) {
  return { id: s.id, pid: s.child.pid ?? null, shell: s.shell, startedAt: new Date(s.startedAt).toISOString(), lastActivity: new Date(s.lastActivity).toISOString(), exited: s.exited, exitCode: s.exitCode, signal: s.signal, closeReason: s.closeReason, offset: s.offset, idleMinutes: s.idleMs / 60_000 };
}

function get(id) {
  const s = sessions.get(id);
  if (!s) throw new OpError('not_found', `Terminal session ${id} does not exist (it may have expired)`);
  return s;
}

defineOp('terminal.open', {
  description: 'Start an interactive root shell on a PTY (script -qefc <shell> /dev/null) and keep it in the agent',
  destructive: true,
  schema: z.object({
    shell: z.enum(['/bin/bash', '/bin/sh']).default('/bin/bash'),
    cols: z.number().int().min(20).max(500).default(120),
    rows: z.number().int().min(5).max(200).default(32),
    idleMinutes: z.number().int().min(1).max(240).default(15),
  }).strict(),
  run: async ({ shell, cols, rows, idleMinutes }, ctx) => {
    requireRootPrincipal(ctx);
    if (!hasBinary('script')) throw new OpError('capability_missing', 'The "script" utility (util-linux) is required for the in-browser terminal');
    if (!fs.existsSync(shell)) throw new OpError('capability_missing', `${shell} is not installed on this server`);
    const live = [...sessions.values()].filter((s) => !s.exited).length;
    if (live >= LIMITS.maxSessions) throw new OpError('refused', `At most ${LIMITS.maxSessions} terminal sessions may be open at once`);
    const id = crypto.randomBytes(16).toString('hex');
    const home = fs.existsSync('/root') ? '/root' : '/';
    const child = spawn(resolveBinary('script'), ['-q', '-e', '-f', '-c', shell, '/dev/null'], {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: home, USER: 'root', LOGNAME: 'root', SHELL: shell, TERM: 'xterm-256color', LANG: 'C.UTF-8', COLUMNS: String(cols), LINES: String(rows), WHM_TERMINAL: id },
      windowsHide: true,
    });
    const s = { id, child, shell, chunks: [], offset: 0, bytes: 0, startedAt: Date.now(), lastActivity: Date.now(), exited: false, exitCode: null, signal: null, exitedAt: null, idleMs: idleMinutes * 60_000, closeReason: null, closedAt: null };
    child.stdout.on('data', (buf) => { append(s, buf); s.lastActivity = Date.now(); });
    child.stderr.on('data', (buf) => { append(s, buf); });
    child.stdin.on('error', () => {});
    child.on('error', (err) => { append(s, Buffer.from(`\r\n[terminal error: ${err.message}]\r\n`)); });
    child.on('exit', (code, signal) => { s.exited = true; s.exitCode = code; s.signal = signal; s.exitedAt = Date.now(); });
    // script never sets the PTY window size, so the shell is told the size the
    // client asked for (both values are validated integers; the leading space
    // keeps the line out of the shell history).
    child.stdin.write(` stty cols ${cols} rows ${rows}\r`);
    sessions.set(id, s);
    ensureSweeper();
    return publicInfo(s);
  },
});

defineOp('terminal.read', {
  description: 'Output produced by a terminal session since a byte offset (base64)',
  schema: z.object({ id: sessionId, since: z.number().int().min(0).default(0), maxBytes: z.number().int().min(1).max(1024 * 1024).default(64 * 1024) }).strict(),
  run: async ({ id, since, maxBytes }) => {
    const s = get(id);
    const oldest = s.chunks[0]?.offset ?? s.offset;
    const from = Math.max(since, oldest);
    const parts = [];
    let size = 0;
    for (const c of s.chunks) {
      if (c.offset + c.data.length <= from) continue;
      const take = c.data.subarray(Math.max(0, from - c.offset)).subarray(0, maxBytes - size);
      parts.push(take);
      size += take.length;
      if (size >= maxBytes) break;
    }
    const data = Buffer.concat(parts);
    return { id, since, offset: from + data.length, data: data.toString('base64'), truncated: since < oldest, exited: s.exited, exitCode: s.exitCode, signal: s.signal, closeReason: s.closeReason, lastActivity: new Date(s.lastActivity).toISOString() };
  },
});

defineOp('terminal.write', {
  description: 'Send keyboard input to a terminal session',
  schema: z.object({ id: sessionId, data: z.string().min(1).max(64 * 1024).regex(/^[^\0]*$/s) }).strict(),
  run: async ({ id, data }, ctx) => {
    requireRootPrincipal(ctx);
    const s = get(id);
    if (s.exited || s.closeReason) throw new OpError('exited', 'The shell has exited');
    s.lastActivity = Date.now();
    s.child.stdin.write(data);
    return { id, bytes: Buffer.byteLength(data) };
  },
});

defineOp('terminal.close', {
  description: 'Terminate a terminal session (SIGHUP, then SIGKILL)',
  destructive: true,
  schema: z.object({ id: sessionId }).strict(),
  run: async ({ id }) => {
    const s = sessions.get(id);
    if (!s) return { id, existed: false };
    terminate(s, 'closed');
    return { id, existed: true, pid: s.child.pid ?? null };
  },
});

defineOp('terminal.list', {
  description: 'Terminal sessions currently held by the agent',
  run: async () => [...sessions.values()].map(publicInfo),
});
