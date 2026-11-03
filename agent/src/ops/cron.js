import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { assertManaged } from './as-user.js';

// Per-account crontabs through crontab(1). The username always follows -u, so
// it is never read as an option (arg.username cannot start with "-" either),
// and the new table arrives on stdin: nothing of it ever becomes an argument.

export const MAX_LINES = 500;
export const MAX_BYTES = 65536;
export const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
export const COMMAND = /^[^\0\r\n]{1,2000}$/;
export const ALIASES = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];
// A command whose first word looks like a schedule field is a 6-field line.
const SCHEDULE_TOKEN = /^[*\d,\/-]+$/;
const SHELLS = new Set(['/bin/bash', '/bin/sh', '/usr/sbin/nologin', '/usr/local/bin/jailshell']);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function validField(field, index) {
  const [min, max] = RANGES[index];
  const names = index === 3 ? MONTHS : index === 4 ? DAYS : {};
  if (!field || field.length > 100) return false;
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d{1,2}))?$/i);
    if (!m) return false;
    const toNum = (v) => (v === undefined ? undefined : names[v.toLowerCase()] ?? (/^\d+$/.test(v) ? Number(v) : NaN));
    const lo = m[1] === '*' ? min : toNum(m[1]);
    const hi = m[1] === '*' ? max : m[2] != null ? toNum(m[2]) : lo;
    const step = m[3] ? Number(m[3]) : 1;
    if ([lo, hi, step].some((n) => Number.isNaN(n)) || step < 1 || lo < min || hi > max || lo > hi) return false;
  }
  return true;
}

export function isValidSchedule(schedule) {
  if (ALIASES.includes(schedule)) return true;
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(validField);
}

// Splits a crontab line into its schedule and command, or null when it is not a job line.
export function splitJob(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('@')) {
    const m = trimmed.match(/^(@[a-z]+)\s+(.+)$/);
    return m && ALIASES.includes(m[1]) ? { schedule: m[1], command: m[2] } : null;
  }
  const m = trimmed.match(/^((?:\S+\s+){4}\S+)\s+(.+)$/);
  return m ? { schedule: m[1].replace(/\s+/g, ' '), command: m[2] } : null;
}

export function splitEnv(line) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  return m ? { key: m[1], value: m[2].trim() } : null;
}

// Returns the first problem of a crontab text, or null when every line is a
// blank, a comment, an environment assignment or a job the panel accepts.
export function validateCrontab(content) {
  if (typeof content !== 'string') return 'content must be a string';
  if (content.includes('\0')) return 'NUL bytes are not allowed';
  if (content.includes('\r')) return 'carriage returns are not allowed';
  if (Buffer.byteLength(content) > MAX_BYTES) return `the crontab exceeds ${MAX_BYTES} bytes`;
  const lines = content.split('\n');
  if (lines.length > MAX_LINES + 1 || (lines.length === MAX_LINES + 1 && lines[MAX_LINES] !== '')) return `the crontab exceeds ${MAX_LINES} lines`;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const where = `line ${i + 1}`;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.trimStart().startsWith('-')) return `${where}: a line may not start with "-"`;
    const env = splitEnv(line);
    if (env) {
      if (!ENV_KEY.test(env.key)) return `${where}: environment keys are upper-case letters, digits and "_"`;
      if (env.value.length > 1024) return `${where}: environment values are at most 1024 characters`;
      if (env.key === 'SHELL') {
        const value = env.value.replace(/^"(.*)"$/, '$1');
        if (!SHELLS.has(value)) return `${where}: SHELL must be one of ${[...SHELLS].join(', ')}`;
      }
      continue;
    }
    const job = splitJob(line);
    if (!job) return `${where}: not a schedule followed by a command`;
    if (!isValidSchedule(job.schedule)) return `${where}: "${job.schedule}" is not a valid schedule`;
    if (!COMMAND.test(job.command)) return `${where}: the command is empty or longer than 2000 characters`;
    if (SCHEDULE_TOKEN.test(job.command.split(/\s+/)[0])) return `${where}: the schedule has more than 5 fields`;
  }
  return null;
}

export function parseCrontab(raw) {
  const env = [];
  const jobs = [];
  const seen = new Map();
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const e = splitEnv(line);
    if (e) { env.push(e); continue; }
    const job = splitJob(line);
    if (!job) continue;
    const hash = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
    const n = (seen.get(hash) || 0) + 1;
    seen.set(hash, n);
    jobs.push({ id: n === 1 ? hash : `${hash}-${n}`, schedule: job.schedule, command: job.command, line, lineNumber: index + 1 });
  }
  return { env, jobs };
}

function requireCrontab() {
  if (!hasBinary('crontab')) throw new OpError('capability_missing', 'crontab (cron) is not installed on this server');
}

const noCrontab = (r) => /no crontab for/i.test(r.stderr) || /no crontab for/i.test(r.stdout);
const denied = (r) => /not allowed|cron\.deny|cron\.allow|permission denied/i.test(r.stderr);

defineOp('cron.user.read', {
  description: "Read a hosting account's crontab (crontab -u <user> -l) parsed into environment lines and jobs",
  schema: z.object({ username: arg.username }).strict(),
  run: async ({ username }) => {
    requireCrontab();
    assertManaged(username);
    const r = await exec('crontab', ['-u', username, '-l'], { allowFailure: true, timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (noCrontab(r)) return { username, exists: false, raw: '', env: [], jobs: [] };
      if (denied(r)) throw new OpError('refused', `cron refuses ${username}: ${r.stderr.trim().split('\n').pop()}`);
      throw new OpError('command_failed', `crontab -l failed: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
    }
    return { username, exists: true, raw: r.stdout, ...parseCrontab(r.stdout) };
  },
});

defineOp('cron.user.write', {
  description: "Replace a hosting account's crontab from validated content passed on stdin (crontab -u <user> -)",
  destructive: true,
  schema: z.object({ username: arg.username, content: z.string().max(MAX_BYTES) }).strict(),
  run: async ({ username, content }) => {
    requireCrontab();
    assertManaged(username);
    const problem = validateCrontab(content);
    if (problem) throw new OpError('invalid_crontab', problem);
    const text = content.endsWith('\n') || content === '' ? content : `${content}\n`;
    const r = await exec('crontab', ['-u', username, '-'], { input: text, allowFailure: true, timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (denied(r)) throw new OpError('refused', `cron refuses ${username}: ${r.stderr.trim().split('\n').pop()}`);
      throw new OpError('invalid_crontab', `crontab rejected the table: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
    }
    const parsed = parseCrontab(text);
    return { username, lines: text === '' ? 0 : text.split('\n').length - 1, jobs: parsed.jobs.length, env: parsed.env.length };
  },
});

defineOp('cron.user.remove', {
  description: "Remove a hosting account's crontab (crontab -u <user> -r)",
  destructive: true,
  schema: z.object({ username: arg.username }).strict(),
  run: async ({ username }) => {
    requireCrontab();
    assertManaged(username);
    const r = await exec('crontab', ['-u', username, '-r'], { allowFailure: true, timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (noCrontab(r)) return { username, existed: false };
      if (denied(r)) throw new OpError('refused', `cron refuses ${username}: ${r.stderr.trim().split('\n').pop()}`);
      throw new OpError('command_failed', `crontab -r failed: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
    }
    return { username, existed: true };
  },
});
