import fs from 'node:fs';
import { newId } from '../shared/db.js';
import { createPsl } from '../shared/psl.js';

// Scheduled work (§18.2, §18.4, §18.9) bound to the hub scheduler by index.js.
export const MARKET_SCHEDULES = [
  { name: 'scan-queue', cron: '3-58/5 * * * *' },
  { name: 'verification-rechecks', cron: '20 4 1 * *' },
  { name: 'reverify-due', cron: '40 4 * * *' },
  { name: 'payouts-close', cron: '30 2 1 * *' },
  { name: 'evidence-purge', cron: '55 3 * * *' },
  { name: 'download-purge', cron: '25 * * * *' },
  { name: 'resign-packages', cron: '35 * * * *' },
  { name: 'psl-refresh', cron: '15 5 * * 0' },
  { name: 'entitlement-expiry', cron: '5 1 * * *' },
  { name: 'market-housekeeping', cron: '45 */6 * * *' },
];

export function createMarketJobs(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    upsertInstall: db.prepare(`INSERT INTO installs (id, plugin_id, license_id, activation_id, version, state, first_seen, last_seen) VALUES (@id, @plugin_id, @license_id, @activation_id, @version, @state, @now, @now)
      ON CONFLICT (plugin_id, activation_id) DO UPDATE SET version = excluded.version, state = excluded.state, last_seen = excluded.last_seen, license_id = excluded.license_id`),
    gone: db.prepare("UPDATE installs SET state = 'uninstalled', last_seen = @now WHERE activation_id = @activation_id AND state != 'uninstalled' AND plugin_id NOT IN (SELECT value FROM json_each(@ids))"),
  };

  const jobs = {
    // ctx.hooks.checkin: upserts `installs` for active activations only (ids and versions only).
    recordUsage({ activation, license, usage }) {
      const live = ctx.activations.find(activation.id);
      if (!live || live.status !== 'active') return { skipped: 'activation_inactive' };
      const plugins = Array.isArray(usage?.plugins) ? usage.plugins : null;
      if (!plugins) return { skipped: 'no_plugins' };
      const now = m.nowIso();
      const touched = new Set();
      db.transaction(() => {
        for (const p of plugins.slice(0, 500)) {
          if (typeof p?.id !== 'string' || typeof p?.version !== 'string') continue;
          stmts.upsertInstall.run({ id: newId('ins', m.now()), plugin_id: p.id, license_id: license.id, activation_id: activation.id, version: p.version, state: p.state || 'installed', now });
          touched.add(p.id);
        }
        stmts.gone.run({ now, activation_id: activation.id, ids: JSON.stringify(plugins.map((p) => p.id)) });
      })();
      for (const id of touched) if (db.prepare('SELECT 1 FROM plugins WHERE id = ?').get(id)) m.catalog.refreshCounts(id);
      return { recorded: touched.size };
    },
    async refreshPsl() {
      try {
        const res = await ctx.safeFetch('https://publicsuffix.org/list/public_suffix_list.dat', { maxBytes: 512 * 1024, timeoutMs: 15_000 });
        if (res.status !== 200) return { refreshed: false, status: res.status };
        const text = res.text();
        const fresh = createPsl({ text });
        if (fresh.size < 1000 || !fresh.isPublicSuffix('co.uk') || !fresh.isPublicSuffix('github.io')) return { refreshed: false, reason: 'implausible list' };
        fs.writeFileSync(cfg.public_suffix_list, text, { mode: 0o640 });
        Object.assign(ctx.psl, { rules: fresh.rules, size: fresh.size, publicSuffix: fresh.publicSuffix, isPublicSuffix: fresh.isPublicSuffix, registrableDomain: fresh.registrableDomain, normalizeHost: fresh.normalizeHost, source: cfg.public_suffix_list });
        return { refreshed: true, rules: fresh.size };
      } catch (err) {
        return { refreshed: false, reason: err.message };
      }
    },
  };

  jobs.handlers = {
    'scan-queue': () => m.scanner.scanQueue(),
    'verification-rechecks': () => m.verification.monthlyRecheck(),
    'reverify-due': () => m.developers.reverifyDue(),
    'payouts-close': () => m.payouts.close(),
    'evidence-purge': () => m.verification.purgeDocuments(),
    'download-purge': () => m.distribution.purge(),
    'resign-packages': () => { const k = ctx.keys.active('plugin'); return k ? m.signing.resignAll(k.kid, { by: 'resign-packages' }) : { skipped: 'no_active_key' }; },
    'psl-refresh': () => jobs.refreshPsl(),
    'entitlement-expiry': () => m.entitlements.expireDue(),
    'market-housekeeping': () => ({ rate_events: m.limits.prune(), sessions: m.devSecurity.pruneSessions(), counts: Object.keys(m.catalog.refreshCounts()).length }),
  };
  return jobs;
}
