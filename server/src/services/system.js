import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

export function createSystemService(ctx) {
  const { db, agent, capabilities, settings, config } = ctx;
  const counts = {
    accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts'),
    suspended: db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE suspended = 1'),
    resellers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'reseller'"),
    domains: db.prepare('SELECT COUNT(*) AS n FROM account_domains'),
    jobsRunning: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'"),
  };

  async function serviceSummary() {
    await capabilities.ensureFresh();
    const rows = db.prepare('SELECT name, display_name, monitored FROM services WHERE monitored = 1 ORDER BY position').all();
    return Promise.all(rows.map(async (row) => {
      const unit = capabilities.unitFor(row.name);
      if (!unit) return { name: row.name, displayName: row.display_name, installed: false, active: false, state: 'not-installed' };
      try {
        const st = await agent.op('svc.status', { unit });
        return { name: row.name, displayName: row.display_name, unit, installed: st.installed, active: st.active, state: st.state, pid: st.pid, memoryBytes: st.memoryBytes };
      } catch (err) {
        return { name: row.name, displayName: row.display_name, unit, installed: true, active: false, state: 'unknown', error: err.message };
      }
    }));
  }

  return {
    // The dashboard "Statistics" panel + Server Information page.
    async status() {
      const info = await agent.op('sys.info');
      const snapshot = await capabilities.ensureFresh();
      return {
        panel: { name: 'WHM', version: pkg.version, mode: config.mode, env: config.env, node: process.version, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) },
        server: info,
        hostname: settings.get('basic.hostname') || info.hostname,
        mainIp: settings.get('basic.main_ip') || info.interfaces.flatMap((i) => i.addresses).find((a) => a.family === 'IPv4')?.address || null,
        counts: Object.fromEntries(Object.entries(counts).map(([k, s]) => [k, s.get().n])),
        capabilities: Object.fromEntries(Object.entries(snapshot.capabilities).map(([k, v]) => [k, v.installed])),
        services: await serviceSummary(),
        license: { status: 'unlicensed', edition: null },
        // Server Profile (Server Configuration) decides which categories the shell shows.
        profile: ctx.serverConfig?.profile?.summary?.() ?? { name: 'standard', label: 'Standard Node', hiddenCategories: [], services: null },
      };
    },
    info: () => agent.op('sys.info'),
    diskUsage: () => agent.op('sys.disk.usage'),
    processes: (opts) => agent.op('sys.processes', opts),
    async signal(pid, signal, req) {
      const result = await agent.op('sys.process.signal', { pid, signal }, { req });
      req?.audit?.({ action: 'process.signal', target: String(pid), args: { signal } });
      return result;
    },
    // "Change Root Password": the operating system root account, not the panel login.
    async setRootPassword(password, req) {
      await agent.op('user.set_password', { username: 'root', password }, { req });
      req?.audit?.({ action: 'system.root_password.change', target: 'root' });
      return { changed: true };
    },
    async renice(pid, niceness, req) {
      const result = await agent.op('sys.process.renice', { pid, niceness }, { req });
      req?.audit?.({ action: 'process.renice', target: String(pid), args: { niceness } });
      return result;
    },
    serviceSummary,
    capabilities: () => capabilities.ensureFresh(),
    refreshCapabilities: () => capabilities.refresh(),
  };
}

export function readVersionFile(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}
