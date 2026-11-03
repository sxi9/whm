import { z } from 'zod';
import { HttpError, unprocessable } from '../lib/errors.js';
import { isValidCron } from '../lib/cron.js';

// The account's own crontab for the account panel. The table is rendered here
// from structured env/jobs input, validated with lib/cron.js (5-field) and the
// alias list below (lib/cron.js knows no @reboot), then handed to the agent,
// which validates it again line by line and feeds it to crontab on stdin.

export const MAX_LINES = 500;
export const ALIASES = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];
export const SHELLS = ['/bin/bash', '/bin/sh', '/usr/sbin/nologin', '/usr/local/bin/jailshell'];

export const envEntry = z.object({
  key: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'Upper-case letters, digits and "_"'),
  value: z.string().max(1024).regex(/^[^\0\n\r]*$/, 'A single line'),
}).strict();
export const jobEntry = z.object({
  schedule: z.string().trim().min(1).max(100).regex(/^[^\0\n\r]+$/),
  command: z.string().regex(/^[^\0\r\n]{1,2000}$/, 'One line, at most 2000 characters'),
}).strict();
export const crontabBody = z.object({
  env: z.array(envEntry).max(MAX_LINES).default([]),
  jobs: z.array(jobEntry).max(MAX_LINES).default([]),
}).strict();

export const isValidSchedule = (s) => ALIASES.includes(s) || (/^(\S+\s+){4}\S+$/.test(s) && isValidCron(s));

export function renderCrontab({ env = [], jobs = [] }) {
  const lines = [...env.map((e) => `${e.key}=${e.value}`), ...jobs.map((j) => `${j.schedule.replace(/\s+/g, ' ')} ${j.command}`)];
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function parseCrontab(raw) {
  const env = [];
  const jobs = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const e = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (e) { env.push({ key: e[1], value: e[2].trim() }); continue; }
    const alias = line.trim().match(/^(@[a-z]+)\s+(.+)$/);
    if (alias) { if (ALIASES.includes(alias[1])) jobs.push({ schedule: alias[1], command: alias[2] }); continue; }
    const m = line.trim().match(/^((?:\S+\s+){4}\S+)\s+(.+)$/);
    if (m) jobs.push({ schedule: m[1].replace(/\s+/g, ' '), command: m[2] });
  }
  return { env, jobs };
}

export function createPanelCronService(ctx) {
  const { agent } = ctx;

  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: scope.mode === 'acting' ? { ...args, actingAs: scope.username, by: scope.actor?.username } : args };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };
  const op = (name, args, req) => agent.op(name, args, { req });

  function gate(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
    if (scope.features?.cron === false) throw new HttpError(403, 'feature_disabled', 'Cron jobs are not enabled for this account\'s package');
  }

  function validateTable({ env, jobs }) {
    const fields = {};
    env.forEach((e, i) => {
      if (e.key === 'SHELL' && !SHELLS.includes(e.value.replace(/^"(.*)"$/, '$1'))) (fields[`env.${i}.value`] ||= []).push(`SHELL must be one of ${SHELLS.join(', ')}`);
    });
    jobs.forEach((j, i) => {
      if (!isValidSchedule(j.schedule)) (fields[`jobs.${i}.schedule`] ||= []).push('Not a valid 5-field schedule or @alias');
      if (/^[*\d,/-]+$/.test(j.command.split(/\s+/)[0])) (fields[`jobs.${i}.command`] ||= []).push('The command may not start with a schedule field');
    });
    if (env.length + jobs.length > MAX_LINES) (fields.jobs ||= []).push(`A crontab holds at most ${MAX_LINES} lines`);
    if (Object.keys(fields).length) throw unprocessable('Request validation failed', fields);
  }

  return {
    renderCrontab,
    parseCrontab,

    async get(scope, req) {
      gate(scope);
      const r = await op('cron.user.read', { username: scope.username }, req);
      return { exists: Boolean(r.exists), env: r.env ?? [], jobs: (r.jobs ?? []).map((j) => ({ id: j.id, schedule: j.schedule, command: j.command, line: j.line })), raw: r.raw ?? '' };
    },

    async set(scope, input, req) {
      gate(scope);
      const body = { env: input.env ?? [], jobs: input.jobs ?? [] };
      validateTable(body);
      const content = renderCrontab(body);
      const r = await op('cron.user.write', { username: scope.username, content }, req);
      audit(req, scope, 'panel.cron.set', { jobs: body.jobs.length, env: body.env.length, lines: r.lines });
      return { exists: content !== '', env: body.env, jobs: body.jobs, lines: r.lines ?? 0 };
    },

    async remove(scope, req) {
      gate(scope);
      const r = await op('cron.user.remove', { username: scope.username }, req);
      audit(req, scope, 'panel.cron.remove', { existed: Boolean(r.existed) });
      return { removed: true, existed: Boolean(r.existed) };
    },
  };
}
