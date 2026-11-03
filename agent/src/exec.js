import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

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

const isReadable = (v) => v != null && typeof v === 'object' && typeof v.pipe === 'function' && typeof v.on === 'function';

// The single choke point for running programs. `argv` is passed to execFile as an
// array, so no element is ever interpreted by a shell. Callers validate every
// element with a schema before it reaches here; this layer only enforces types.
// `input` is written to the child's stdin: a string or Buffer is written whole,
// a Readable stream is piped (nothing is buffered, so a multi-GB file the
// caller opened root-side can feed a program running as an account); a stream
// that errors before it ends kills the child and rejects with `input_failed`,
// so a short read never passes as a successful run.
// `stdinFd` / `stdoutFd` hand the child an already-open descriptor as its
// stdin or stdout instead of a pipe: a file root opened is then read or
// written by a program running as an account without the account ever being
// able to reach it by path. With `stdoutFd` the result's stdout is empty.
export function exec(name, argv = [], { timeoutMs = 60_000, input, env, cwd, allowFailure = false, maxBuffer = 16 * 1024 * 1024, stdinFd, stdoutFd } = {}) {
  const bin = resolveBinary(name);
  if (!bin) return Promise.reject(new ExecError('binary_not_found', `Required program "${name}" is not installed on this server`, { bin: name }));
  for (const a of argv) {
    if (typeof a !== 'string' || a.includes('\0')) {
      return Promise.reject(new ExecError('bad_argument', 'Command arguments must be NUL-free strings', { bin: name }));
    }
  }
  if (input != null && typeof input !== 'string' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array) && !isReadable(input)) {
    return Promise.reject(new ExecError('bad_argument', 'Command input must be a string, a Buffer or a Readable stream', { bin: name }));
  }
  const isFd = (v) => Number.isInteger(v) && v >= 0;
  if ((stdinFd != null && !isFd(stdinFd)) || (stdoutFd != null && !isFd(stdoutFd)) || (stdinFd != null && input != null)) {
    return Promise.reject(new ExecError('bad_argument', 'stdinFd and stdoutFd must be open descriptors, and stdinFd excludes input', { bin: name }));
  }
  const options = { timeoutMs, env, cwd, allowFailure, maxBuffer };
  if (stdinFd != null || stdoutFd != null) return execWithFds(name, bin, argv, { ...options, stdinFd, stdoutFd });
  return new Promise((resolve, reject) => {
    let inputError = null;
    const child = execFile(bin, argv, {
      timeout: timeoutMs,
      maxBuffer,
      cwd,
      env: { PATH: SEARCH_DIRS.join(':'), LANG: 'C', LC_ALL: 'C', ...env },
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? null : 0;
      if (inputError) {
        return reject(new ExecError('input_failed', `Could not feed "${name}" its input: ${inputError.message}`, { bin, argv, stderr: String(stderr).slice(-4000) }));
      }
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
    if (input == null) return;
    child.stdin.on('error', () => {});
    if (!isReadable(input)) {
      child.stdin.end(input);
      return;
    }
    input.once('error', (err) => {
      inputError = err;
      input.unpipe(child.stdin);
      child.stdin.destroy();
      child.kill('SIGKILL');
    });
    input.pipe(child.stdin);
  });
}

// execFile never forwards `stdio`, so a run with inherited descriptors goes
// through spawn with the same outcome mapping as above: timeout, spawn_failed,
// command_failed (unless allowFailure), and maxBuffer kills the child.
function execWithFds(name, bin, argv, { timeoutMs, env, cwd, allowFailure, maxBuffer, stdinFd, stdoutFd }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, {
        cwd,
        env: { PATH: SEARCH_DIRS.join(':'), LANG: 'C', LC_ALL: 'C', ...env },
        stdio: [stdinFd ?? 'ignore', stdoutFd ?? 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return reject(new ExecError('spawn_failed', `Could not run "${name}": ${err.message}`, { bin, argv }));
    }
    const out = [];
    const errOut = [];
    let killedBy = null;
    let settled = false;
    const timer = setTimeout(() => { killedBy = 'timeout'; child.kill('SIGTERM'); }, timeoutMs);
    const collect = (chunks, len) => (chunk) => {
      if (len.n + chunk.length > maxBuffer) { killedBy = killedBy || 'maxBuffer'; child.kill('SIGKILL'); return; }
      len.n += chunk.length;
      chunks.push(chunk);
    };
    const outCount = { n: 0 };
    const errCount = { n: 0 };
    child.stdout?.on('data', collect(out, outCount));
    child.stderr?.on('data', collect(errOut, errCount));
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    child.on('error', (err) => finish(() => reject(new ExecError('spawn_failed', `Could not run "${name}": ${err.message}`, { bin, argv }))));
    child.on('close', (code, signal) => finish(() => {
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(errOut).toString();
      if (killedBy === 'timeout') return reject(new ExecError('timeout', `"${name}" did not finish within ${timeoutMs}ms`, { bin, argv, stderr: stderr.slice(-4000) }));
      if (killedBy === 'maxBuffer') return reject(new ExecError('spawn_failed', `Could not run "${name}": stdout maxBuffer length exceeded`, { bin, argv }));
      if (code === null) return reject(new ExecError('spawn_failed', `Could not run "${name}": killed by ${signal}`, { bin, argv }));
      const result = { code, stdout, stderr, bin, argv };
      if (code !== 0 && !allowFailure) {
        return reject(new ExecError('command_failed', `"${name}" exited with status ${code}: ${stderr.trim().split('\n').pop() || 'no error output'}`, {
          ...result, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000),
        }));
      }
      resolve(result);
    }));
  });
}
