import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SEARCH_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin', '/usr/local/sbin', '/usr/local/bin'];
const resolved = new Map();

export class ExecError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function resolveBinary(name) {
  if (resolved.has(name)) return resolved.get(name);
  let found = null;
  // Only a regular file counts: a directory that happens to carry a program's
  // name (or "..") must never be cached as that program.
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (path.isAbsolute(name)) {
    if (isFile(name)) found = name;
  } else {
    for (const dir of SEARCH_DIRS) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) { found = candidate; break; }
    }
  }
  if (found) resolved.set(name, found);
  return found;
}

export const hasBinary = (name) => Boolean(resolveBinary(name));

// The single choke point for running programs. `argv` is passed to execFile as an
// array, so no element is ever interpreted by a shell. Callers validate every
// element with a schema before it reaches here; this layer only enforces types.
export function exec(name, argv = [], { timeoutMs = 60_000, input, env, cwd, allowFailure = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const bin = resolveBinary(name);
  if (!bin) return Promise.reject(new ExecError('binary_not_found', `Required program "${name}" is not installed on this server`, { bin: name }));
  for (const a of argv) {
    if (typeof a !== 'string' || a.includes('\0')) {
      return Promise.reject(new ExecError('bad_argument', 'Command arguments must be NUL-free strings', { bin: name }));
    }
  }
  return new Promise((resolve, reject) => {
    const child = execFile(bin, argv, {
      timeout: timeoutMs,
      maxBuffer,
      cwd,
      env: { PATH: SEARCH_DIRS.join(':'), LANG: 'C', LC_ALL: 'C', ...env },
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? null : 0;
      if (err && err.killed) {
        return reject(new ExecError('timeout', `"${name}" did not finish within ${timeoutMs}ms`, { bin, argv, stderr: String(stderr).slice(-4000) }));
      }
      if (err && code === null) {
        return reject(new ExecError('spawn_failed', `Could not run "${name}": ${err.message}`, { bin, argv }));
      }
      const result = { code, stdout: String(stdout), stderr: String(stderr), bin, argv };
      if (code !== 0 && !allowFailure) {
        return reject(new ExecError('command_failed', `"${name}" exited with status ${code}: ${result.stderr.trim().split('\n').pop() || 'no error output'}`, {
          ...result, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000),
        }));
      }
      resolve(result);
    });
    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
