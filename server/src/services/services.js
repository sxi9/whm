import { notFound, badRequest } from '../lib/errors.js';

const VERBS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);

// Service Manager + Restart Services.
export function createServiceManager({ db, agent, capabilities }) {
  const byName = db.prepare('SELECT * FROM services WHERE name = ?');
  const all = db.prepare('SELECT * FROM services ORDER BY position');
  const update = db.prepare('UPDATE services SET monitored = @monitored, enabled = @enabled, restart_on_failure = @restart_on_failure WHERE name = @name');

  function resolve(name) {
    const row = byName.get(name);
    if (!row) throw notFound('Service');
    const unit = capabilities.unitFor(name);
    return { row, unit };
  }

  return {
    async list() {
      await capabilities.ensureFresh();
      return Promise.all(all.all().map(async (row) => {
        const unit = capabilities.unitFor(row.name);
        const base = { name: row.name, displayName: row.display_name, unit, monitored: Boolean(row.monitored), enabled: Boolean(row.enabled), restartOnFailure: Boolean(row.restart_on_failure), candidates: JSON.parse(row.unit_candidates) };
        if (!unit) return { ...base, installed: false, active: false, state: 'not-installed' };
        try {
          const st = await agent.op('svc.status', { unit });
          return { ...base, installed: st.installed, active: st.active, state: st.state, subState: st.subState, pid: st.pid, startedAt: st.startedAt, memoryBytes: st.memoryBytes, restarts: st.restarts, unitEnabled: st.enabled };
        } catch (err) {
          return { ...base, installed: true, active: false, state: 'unknown', error: err.message };
        }
      }));
    },

    async status(name) {
      await capabilities.ensureFresh();
      const { row, unit } = resolve(name);
      if (!unit) return { name, displayName: row.display_name, installed: false };
      return { name, displayName: row.display_name, ...(await agent.op('svc.status', { unit })) };
    },

    async action(name, verb, req) {
      if (!VERBS.has(verb)) throw badRequest(`Unknown service action "${verb}"`);
      await capabilities.ensureFresh();
      const { row, unit } = resolve(name);
      if (!unit) throw notFound(`An installed unit for ${row.display_name}`);
      const result = await agent.op(`svc.${verb}`, { unit }, { req });
      req?.audit?.({ action: `service.${verb}`, target: unit });
      const status = await agent.op('svc.status', { unit });
      return { ...result, status };
    },

    journal(name, lines) {
      const { unit } = resolve(name);
      if (!unit) throw notFound('Installed unit');
      return agent.op('svc.journal', { unit, lines });
    },

    configure(name, { monitored, enabled, restartOnFailure }) {
      const { row } = resolve(name);
      update.run({ name, monitored: monitored ?? row.monitored ? 1 : 0, enabled: enabled ?? row.enabled ? 1 : 0, restart_on_failure: restartOnFailure ?? row.restart_on_failure ? 1 : 0 });
      return byName.get(name);
    },
  };
}
