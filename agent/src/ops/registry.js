import { z } from 'zod';
import { ExecError } from '../exec.js';

// The op catalog is the whole privileged surface of the panel. Each entry is a
// named operation with a zod schema for its arguments; anything that is not in
// the catalog, or whose arguments fail the schema, is refused before any code runs.
export const catalog = new Map();

export class OpError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function defineOp(name, { schema = z.object({}).strict(), run, description = '', destructive = false, timeoutMs }) {
  if (!/^[a-z]+(\.[a-z_]+)+$/.test(name)) throw new Error(`invalid op name "${name}"`);
  if (catalog.has(name)) throw new Error(`op "${name}" defined twice`);
  catalog.set(name, { name, schema, run, description, destructive, timeoutMs });
}

export function listOps() {
  return [...catalog.values()].map(({ name, description, destructive }) => ({ name, description, destructive }));
}

export async function runOp(name, args, ctx) {
  const op = catalog.get(name);
  if (!op) throw new OpError('unknown_op', `Operation "${name}" is not in the agent catalog`);
  const parsed = op.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) (fields[issue.path.join('.') || '_'] ||= []).push(issue.message);
    throw new OpError('invalid_args', `Invalid arguments for "${name}"`, { fields });
  }
  try {
    return await op.run(parsed.data, ctx);
  } catch (err) {
    if (err instanceof OpError) throw err;
    if (err instanceof ExecError) throw new OpError(err.code, err.message, err.details);
    throw new OpError('op_failed', err.message, { op: name });
  }
}

// Shared argument schemas. These mirror server/src/lib/validate.js on purpose:
// the agent must not trust that the API validated anything.
export const arg = {
  username: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  domain: z.string().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  hostname: z.string().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  unit: z.string().regex(/^[A-Za-z0-9@._-]{1,80}$/),
  ipv4: z.string().ip({ version: 'v4' }),
  ipv6: z.string().ip({ version: 'v6' }),
  ip: z.string().ip(),
  iface: z.string().regex(/^[a-zA-Z0-9._-]{1,15}$/),
  absPath: z.string().regex(/^\/(?!(?:.*\/)?\.\.(?:\/|$))[^\0]*$/s),
  shell: z.enum(['/bin/bash', '/bin/sh', '/usr/sbin/nologin', '/usr/local/bin/jailshell']),
  pid: z.number().int().positive().max(4194304),
  signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGSTOP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2']),
  identifier: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  mode: z.string().regex(/^0?[0-7]{3,4}$/),
  // Arbitrary text that is only ever written to a file or passed via stdin.
  text: z.string().max(4 * 1024 * 1024),
  mysqlHost: z.string().regex(/^[A-Za-z0-9.%:_-]{1,255}$/),
};
