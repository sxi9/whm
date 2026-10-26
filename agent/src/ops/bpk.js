import { z } from 'zod';
import { defineOp, arg, OpError } from './registry.js';
import { exec } from '../exec.js';

// Background Process Killer. The panel matches processes against a `ps`
// snapshot and later asks for them to be killed; between those two moments a
// PID can be recycled onto a different (possibly root) process, so the owner
// and age are re-read immediately before the signal and the kill is refused
// when they no longer describe the process that was matched.
export function parsePsOwner(stdout) {
  const line = String(stdout || '').split('\n').find((l) => l.trim());
  if (!line) return null;
  const [user, etimes] = line.trim().split(/\s+/);
  return { user, elapsedSeconds: Number(etimes) };
}

// The owner is whatever `ps -o user:32` printed for the snapshot: system users
// such as "_apt", mixed case, a bare UID for a deleted user, or a name cut at
// 32 characters with a trailing "+". It is only compared with the live owner,
// never passed to a program.
export const psUser = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._$+-]{0,31}$/, 'not a process owner name as ps prints it');

defineOp('bpk.kill', {
  description: 'Signal a matched process after re-verifying its owner (never root) and age',
  destructive: true,
  schema: z.object({
    pid: arg.pid,
    signal: arg.signal.default('SIGKILL'),
    user: psUser,
    elapsedSeconds: z.number().int().nonnegative().optional(),
  }).strict(),
  run: async ({ pid, signal, user, elapsedSeconds }) => {
    if (pid === 1 || pid === process.pid) throw new OpError('refused', 'Refusing to signal PID 1 or the agent itself');
    if (user === 'root') throw new OpError('refused', 'The background process killer never signals root-owned processes');
    const { code, stdout } = await exec('ps', ['-o', 'user:32=,etimes=', '-p', String(pid)], { allowFailure: true });
    const live = code === 0 ? parsePsOwner(stdout) : null;
    if (!live) throw new OpError('not_found', `No process with PID ${pid}`);
    if (live.user !== user) throw new OpError('owner_mismatch', `PID ${pid} now belongs to "${live.user}", not "${user}"; the process that was matched has exited`);
    if (elapsedSeconds != null && live.elapsedSeconds < elapsedSeconds) throw new OpError('owner_mismatch', `PID ${pid} was recycled since it was matched (now ${live.elapsedSeconds}s old, was ${elapsedSeconds}s)`);
    try {
      process.kill(pid, signal);
    } catch (err) {
      if (err.code === 'ESRCH') throw new OpError('not_found', `No process with PID ${pid}`);
      throw new OpError('signal_failed', err.message);
    }
    return { pid, signal, user: live.user, elapsedSeconds: live.elapsedSeconds };
  },
});
