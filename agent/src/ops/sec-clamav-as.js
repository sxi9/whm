import { z } from 'zod';
import { hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { accountPath, asUser, lastLine } from './as-user.js';
import { parseClamscanOutput } from './sec.js';

// The account panel's virus scanner (P2-9): clamdscan runs as the account's
// uid with --fdpass, so the account opens every file itself and hands the
// descriptor to clamd. Nothing the account cannot read is ever scanned, and a
// symlink it planted reaches only what it may already reach. The home comes
// from /etc/passwd and the path must sit under it (accountPath). A separate
// family file so sec.js (root-side clamscan) never imports as-user.js.

export const CLAMAV_AS_TIMEOUT_MS = 15 * 60_000;
const BUFFER = 64 * 1024 * 1024;

// clamdscan exit codes: 0 clean, 1 something found, 2 an error occurred.
export function clamdFailure(r, target) {
  const line = lastLine(r);
  if (/Could not connect to clamd|Can't connect to clamd|connect.*(refused|No such file)/i.test(line)) return new OpError('capability_missing', `The ClamAV daemon is not running on this server (${line})`);
  if (/No such file or directory|cannot stat|does not exist/i.test(line)) return new OpError('not_found', `${target}: ${line}`);
  return new OpError('command_failed', `clamdscan failed: ${line}`, { target, stderr: String(r.stderr || '').slice(-4000) });
}

defineOp('sec.clamav.scan_as', {
  description: 'Scan one path of a hosting account with clamdscan --fdpass as the account itself; reports infected files only',
  timeoutMs: CLAMAV_AS_TIMEOUT_MS,
  schema: z.object({
    username: arg.username,
    path: arg.absPath,
    maxDurationSec: z.number().int().min(60).max(CLAMAV_AS_TIMEOUT_MS / 1000).default(CLAMAV_AS_TIMEOUT_MS / 1000),
  }).strict(),
  run: async ({ username, path: p, maxDurationSec }, ctx) => {
    const { info, home, target, real } = accountPath(username, p, ctx, 'read');
    if (!hasBinary('clamdscan')) throw new OpError('capability_missing', 'ClamAV is not installed on this server (clamdscan not found)');
    const argv = ['--fdpass', '--no-summary', '--infected', '--stdout', '--', real];
    const started = Date.now();
    let r;
    try {
      r = await asUser(info, 'clamdscan', argv, { timeoutMs: maxDurationSec * 1000, allowFailure: true, maxBuffer: BUFFER, nice: true });
    } catch (err) {
      if (err.code === 'timeout') throw new OpError('timeout', `clamdscan did not finish ${target} within ${maxDurationSec}s; scan a smaller folder`, { target, maxDurationSec });
      throw err;
    }
    const parsed = parseClamscanOutput(r.stdout);
    if (r.code === 2 && parsed.infected.length === 0 && parsed.errors.length === 0) throw clamdFailure(r, target);
    return { username, home, path: target, ...parsed, exitCode: r.code, durationMs: Date.now() - started };
  },
});
