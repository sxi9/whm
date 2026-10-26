import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Manage Hooks: operator-installed executables under HOOKS_DIR receive panel
// events (account.created, login.failed, ...) with the JSON payload on stdin and
// `<event> <stage>` as argv. Nothing outside this directory can ever be run, and a
// script that is not root-owned or is writable by others is refused so an
// account user can never smuggle code into a root execution path.
export const HOOKS_DIR = '/usr/local/whm/hooks';

const hookName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);
const eventName = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){1,5}$/);
const stage = z.enum(['pre', 'post']);

export function inspectScript(name) {
  const file = path.join(HOOKS_DIR, name);
  let st;
  try { st = fs.lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT') return { name, path: file, exists: false };
    throw err;
  }
  const mode = st.mode & 0o7777;
  const problems = [];
  if (!st.isFile()) problems.push(st.isSymbolicLink() ? 'is a symbolic link' : 'is not a regular file');
  if (st.uid !== 0) problems.push(`is owned by uid ${st.uid}, not root`);
  if (mode & 0o022) problems.push(`is writable by group or others (mode ${mode.toString(8).padStart(4, '0')})`);
  if (!(mode & 0o100)) problems.push('is not executable by its owner');
  return { name, path: file, exists: true, size: st.size, mode: mode.toString(8).padStart(4, '0'), uid: st.uid, mtime: st.mtime.toISOString(), runnable: problems.length === 0, problems };
}

defineOp('hook.list', {
  description: 'List hook executables installed under /usr/local/whm/hooks and whether each may run',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(HOOKS_DIR, 'read');
    if (!fs.existsSync(HOOKS_DIR)) return { dir: HOOKS_DIR, exists: false, scripts: [] };
    const scripts = fs.readdirSync(HOOKS_DIR).filter((n) => hookName.safeParse(n).success).sort().map((n) => inspectScript(n));
    return { dir: HOOKS_DIR, exists: true, scripts };
  },
});

defineOp('hook.run', {
  description: 'Run one installed hook executable with the event payload on stdin',
  timeoutMs: 600_000,
  schema: z.object({
    name: hookName,
    event: eventName,
    stage: stage.default('post'),
    payload: arg.text,
    timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
  }).strict(),
  run: async ({ name, event, stage: st, payload, timeoutMs }, ctx) => {
    const file = ctx.assertAllowedPath(path.join(HOOKS_DIR, name), 'read');
    const info = inspectScript(name);
    if (!info.exists) throw new OpError('not_found', `Hook "${name}" is not installed in ${HOOKS_DIR}`);
    if (!info.runnable) throw new OpError('refused', `Hook "${name}" ${info.problems.join('; ')}`);
    const started = Date.now();
    const result = await exec(file, [event, st], {
      input: payload, timeoutMs, allowFailure: true, cwd: HOOKS_DIR,
      env: { WHM_HOOK_EVENT: event, WHM_HOOK_STAGE: st, WHM_HOOK_NAME: name, HOME: '/root' },
    });
    return {
      name, event, stage: st, exitCode: result.code, ok: result.code === 0, durationMs: Date.now() - started,
      stdout: result.stdout.slice(-64 * 1024), stderr: result.stderr.slice(-16 * 1024),
    };
  },
});
