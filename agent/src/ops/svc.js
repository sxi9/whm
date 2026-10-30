import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

let unitCache = { at: 0, units: null };

// list-unit-files is slow-ish; cache for a short period since the dashboard
// polls service status frequently.
async function knownUnits() {
  if (unitCache.units && Date.now() - unitCache.at < 30_000) return unitCache.units;
  if (!hasBinary('systemctl')) return new Set();
  const { stdout } = await exec('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager', '--plain'], { allowFailure: true });
  const units = new Set();
  for (const line of stdout.split('\n')) {
    const name = line.trim().split(/\s+/)[0];
    if (name?.endsWith('.service')) units.add(name.replace(/\.service$/, ''));
  }
  unitCache = { at: Date.now(), units };
  return units;
}

defineOp('svc.list_units', {
  description: 'All systemd service unit names present on this host',
  run: async () => [...(await knownUnits())].sort(),
});

// list-unit-files names a template (clamd@.service) but never its instances,
// so an instance candidate counts as present when its template is.
export const unitPresent = (units, name) => units.has(name) || (name.includes('@') && units.has(`${name.split('@')[0]}@`));

defineOp('svc.resolve', {
  description: 'Pick the first unit name that exists from a list of candidates (fresh: re-read the unit list, e.g. right after a package install)',
  schema: z.object({ candidates: z.array(arg.unit).min(1).max(10), fresh: z.boolean().default(false) }).strict(),
  run: async ({ candidates, fresh }) => {
    if (fresh) unitCache.at = 0;
    const units = await knownUnits();
    return { unit: candidates.find((c) => unitPresent(units, c)) || null };
  },
});

defineOp('svc.reset_failed', {
  description: 'systemctl reset-failed <unit>: clear the failed state and start-limit counters before a repair restart',
  schema: z.object({ unit: arg.unit }).strict(),
  run: async ({ unit }) => {
    if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'systemd is not available on this host');
    const { code, stderr } = await exec('systemctl', ['reset-failed', `${unit}.service`], { allowFailure: true });
    return { unit, ok: code === 0, output: stderr.trim() };
  },
});

function parseShow(stdout) {
  const kv = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

// The UnitFileState values that start at boot: the set `systemctl is-enabled`
// exits 0 for. 'generated' is a SysV init script (Debian pure-ftpd, proftpd),
// 'indirect' is pulled in via Also= of another unit, 'alias' is a symlink to an
// enabled unit; none of them are ever reported as plain 'enabled'.
export const ENABLED_UNIT_FILE_STATES = new Set(['enabled', 'enabled-runtime', 'static', 'indirect', 'generated', 'alias']);
export const unitStartsAtBoot = (unitFileState) => ENABLED_UNIT_FILE_STATES.has(unitFileState);

defineOp('svc.status', {
  description: 'Service state, enablement, PID, memory and uptime',
  schema: z.object({ unit: arg.unit }).strict(),
  run: async ({ unit }) => {
    if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'systemd is not available on this host');
    const props = ['ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'ExecMainStartTimestamp', 'MemoryCurrent', 'NRestarts', 'Description', 'LoadState', 'Result'];
    const { stdout } = await exec('systemctl', ['show', `${unit}.service`, '--no-pager', `--property=${props.join(',')}`], { allowFailure: true });
    const kv = parseShow(stdout);
    const installed = kv.LoadState && kv.LoadState !== 'not-found';
    return {
      unit,
      installed,
      active: kv.ActiveState === 'active',
      state: kv.ActiveState || 'unknown',
      subState: kv.SubState || null,
      enabled: unitStartsAtBoot(kv.UnitFileState),
      unitFileState: kv.UnitFileState || null,
      pid: Number(kv.MainPID) || null,
      startedAt: kv.ExecMainStartTimestamp || null,
      memoryBytes: /^\d+$/.test(kv.MemoryCurrent || '') ? Number(kv.MemoryCurrent) : null,
      restarts: Number(kv.NRestarts) || 0,
      description: kv.Description || null,
      result: kv.Result || null,
    };
  },
});

for (const verb of ['start', 'stop', 'restart', 'reload', 'enable', 'disable']) {
  defineOp(`svc.${verb}`, {
    description: `systemctl ${verb} <unit>`,
    destructive: verb === 'stop' || verb === 'disable' || verb === 'restart',
    timeoutMs: 120_000,
    schema: z.object({ unit: arg.unit }).strict(),
    run: async ({ unit }) => {
      const argv = [verb, `${unit}.service`];
      if (verb === 'enable') argv.push('--now');
      const { stderr } = await exec('systemctl', argv, { timeoutMs: 120_000 });
      unitCache.at = 0;
      return { unit, verb, output: stderr.trim() };
    },
  });
}

defineOp('svc.journal', {
  description: 'Recent journal lines for a unit',
  schema: z.object({ unit: arg.unit, lines: z.number().int().min(1).max(5000).default(200) }).strict(),
  run: async ({ unit, lines }) => {
    if (!hasBinary('journalctl')) return { unit, lines: [] };
    const { stdout } = await exec('journalctl', ['-u', `${unit}.service`, '-n', String(lines), '--no-pager', '-o', 'short-iso'], { allowFailure: true });
    return { unit, lines: stdout.split('\n').filter(Boolean) };
  },
});
