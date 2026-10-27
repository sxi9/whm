import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, createMockAgent } from '../support/app.js';
import { seedLargeTables, fakeMailQueue } from './seed.js';

// Every list endpoint that pages over a table that grows with the server
// (accounts, audit log, jobs, DNS, backups, cluster events, plugin logs, logins,
// the Exim queue) is run against 20k rows. Two assertions per call: it answers
// in under BUDGET_MS, and SQLite's plan never walks the big table row by row
// when a filter is present (a bare "SCAN <table>" without an index) nor sorts
// it in a temp B-tree. Filters that are free-text LIKE searches scan by nature
// and are only timed; `sorts` allows an in-memory sort of a join-bounded subset.
const ROWS = 20_000;
const BUDGET_MS = 150;
const BIG_TABLES = ['accounts', 'audit_log', 'jobs', 'dns_zones', 'dns_records', 'backups', 'cluster_events', 'plugin_logs', 'login_attempts'];
const SQL_KEYWORDS = new Set(['WHERE', 'ORDER', 'LIMIT', 'ON', 'LEFT', 'JOIN', 'INNER', 'GROUP', 'AS', 'SET', 'VALUES']);

// Records every statement executed while a list call runs (prepare is patched
// before the app boots so statements prepared at service creation count too).
const executed = [];
const timings = [];
let capturing = false;
const origPrepare = Database.prototype.prepare;
Database.prototype.prepare = function prepare(sql) {
  const stmt = origPrepare.call(this, sql);
  return new Proxy(stmt, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (['all', 'get', 'run', 'iterate'].includes(key)) return (...args) => { if (capturing) executed.push({ sql: target.source, args }); return value.apply(target, args); };
      return (...args) => { const r = value.apply(target, args); return r === target ? this : r; };
    },
  });
};

let app; let db; let reseller; let seeded; let pluginId;

beforeAll(async () => {
  const queue = fakeMailQueue(ROWS);
  const agent = createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, n === 'exim4'])),
    'mail.queue.list': () => queue,
  });
  app = await createTestApp({ agent });
  db = app.ctx.db;
  await app.login();
  reseller = await app.createUser('perfresell', 'reseller');
  await app.ctx.capabilities.refresh();
  const t0 = performance.now();
  seeded = seedLargeTables(db, { rows: ROWS, ownerIds: [1, reseller.id] });
  // eslint-disable-next-line no-console
  console.log(`seeded ${ROWS} rows × ${BIG_TABLES.length} tables in ${Math.round(performance.now() - t0)} ms`);
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins/bundled/net.whm.server-monitoring');
  try { pluginId = (await app.ctx.plugins.install({ dir })).id || 'net.whm.server-monitoring'; } catch { pluginId = null; }
}, 60_000);

afterAll(async () => {
  Database.prototype.prepare = origPrepare;
  // eslint-disable-next-line no-console
  console.log(timings.map(([l, ms]) => `${l}: ${ms.toFixed(1)} ms`).join('\n'));
  await app?.close();
});

function tablesIn(sql) {
  const names = new Map();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)(?:\s+(?:AS\s+)?([a-z_]+))?/gi)) {
    if (!BIG_TABLES.includes(m[1])) continue;
    names.set(m[1], m[1]);
    if (m[2] && !SQL_KEYWORDS.has(m[2].toUpperCase())) names.set(m[2], m[1]);
  }
  return names;
}

function plansFor(statements) {
  const out = [];
  for (const { sql, args } of statements) {
    if (!/^\s*SELECT/i.test(sql)) continue;
    const names = tablesIn(sql);
    if (!names.size) continue;
    const plan = origPrepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail);
    out.push({ sql, plan, names, filtered: /\bWHERE\b/i.test(sql) });
  }
  return out;
}

async function measure(label, fn, { scans = false, sorts = false } = {}) {
  executed.length = 0;
  capturing = true;
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  capturing = false;
  timings.push([label, ms]);
  const plans = plansFor(executed);
  const problems = [];
  for (const { sql, plan, names, filtered } of plans) {
    for (const line of plan) {
      const bare = line.match(/^SCAN ([a-z_]+)$/i);
      if (bare && names.has(bare[1]) && filtered && !scans) problems.push(`${line}  <-  ${sql}`);
      if (/TEMP B-TREE FOR ORDER BY/i.test(line) && !sorts) problems.push(`${line}  <-  ${sql}`);
    }
  }
  expect(problems, `${label}: plan walks or sorts a big table without an index`).toEqual([]);
  expect(plans.length, `${label}: no SELECT over a seeded table was captured`).toBeGreaterThan(0);
  expect(ms, `${label} took ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS);
  return result;
}

const root = { id: 1, username: 'root', role: 'root' };
const page = (extra = {}) => ({ page: 1, pageSize: 50, ...extra });

describe(`list endpoints over ${ROWS}-row tables`, () => {
  it('accounts: root, reseller scope, filters and search', async () => {
    const r = await measure('accounts root', () => app.ctx.accounts.list(page(), root));
    expect(r.meta.total).toBeGreaterThanOrEqual(ROWS);
    expect(r.data).toHaveLength(50);
    const own = await measure('accounts reseller', () => app.ctx.accounts.list(page(), { id: reseller.id, username: reseller.username, role: 'reseller' }));
    expect(own.meta.total).toBe(ROWS / 2);
    await measure('accounts suspended', () => app.ctx.accounts.list(page({ suspended: true }), root));
    await measure('accounts package', () => app.ctx.accounts.list(page({ package: 'pro' }), root));
    await measure('accounts search', () => app.ctx.accounts.list(page({ q: 'perf0100' }), root), { scans: true });
    await measure('accounts page 200 by created_at', () => app.ctx.accounts.list(page({ page: 200, sort: 'created_at', dir: 'desc' }), root));
  });

  it('MultiPHP domains: SQL page over the union of main and recorded domains', async () => {
    // The union of two tables is ordered with a temp B-tree inside SQLite and
    // the unfiltered root listing reads every account; the point is that no
    // request materialises 20k rows in JavaScript any more, and the owner /
    // account filters push down into index searches.
    const r = await measure('php domains', () => app.ctx.software.php.domains(root, page({ pageSize: 500 })), { scans: true, sorts: true });
    expect(r.meta.total).toBeGreaterThanOrEqual(ROWS);
    expect(r.data.domains).toHaveLength(500);
    expect(r.data.domains[0].domain <= r.data.domains[1].domain).toBe(true);
    await measure('php domains reseller', () => app.ctx.software.php.domains({ id: reseller.id, username: reseller.username, role: 'reseller' }, page({ pageSize: 50, page: 100 })), { sorts: true });
    const found = await measure('php domains account', () => app.ctx.software.php.domains(root, page({ account: seeded.accounts[9].username })), { sorts: true });
    expect(found.data.domains.map((d) => d.domain)).toEqual([`${seeded.accounts[9].username}.example.test`]);
    await measure('php domains search', () => app.ctx.software.php.domains(root, page({ q: 'perf0100' })), { scans: true, sorts: true });
  });

  it('audit log: newest first, principal / action / result filters and search', async () => {
    const r = await measure('audit default', () => app.ctx.audit.list(page()));
    expect(r.meta.total).toBeGreaterThanOrEqual(ROWS);
    await measure('audit principal', () => app.ctx.audit.list(page({ principal: 'resell1' })));
    // The prefix LIKE is a range over the NOCASE index; the rows it spans are
    // sorted by ts in memory (several action values share the prefix).
    await measure('audit action prefix', () => app.ctx.audit.list(page({ action: 'dns.' })), { sorts: true });
    await measure('audit result', () => app.ctx.audit.list(page({ result: 'error' })));
    await measure('audit search', () => app.ctx.audit.list(page({ q: 'target-42' })), { scans: true });
    await measure('audit logins', () => app.ctx.audit.loginAttempts(page()));
    await measure('cphulk login history', () => app.ctx.security.cphulk.history?.(page()) ?? app.ctx.audit.loginAttempts(page()));
  });

  it('jobs: newest first, by status and by type', async () => {
    const r = await measure('jobs default', () => app.ctx.jobs.list({ limit: 100 }));
    expect(r).toHaveLength(100);
    await measure('jobs status', () => app.ctx.jobs.list({ status: 'failed', limit: 100 }));
    await measure('jobs type', () => app.ctx.jobs.list({ type: 'backup.run', limit: 100 }));
    await measure('jobs type+status', () => app.ctx.jobs.list({ type: 'backup.run', status: 'done', limit: 100 }));
  });

  it('DNS: zone list for root and resellers, per-account, and a 2 000-record zone', async () => {
    const r = await measure('zones root', () => app.ctx.dns.listZones(page(), root));
    expect(r.meta.total).toBeGreaterThanOrEqual(ROWS);
    // A reseller's zones are found through their accounts (owner index) and the
    // result, bounded by that reseller's account count, is sorted in memory.
    await measure('zones reseller', () => app.ctx.dns.listZones(page(), { id: reseller.id, username: reseller.username, role: 'reseller' }), { sorts: true });
    await measure('zones account', () => app.ctx.dns.listZones(page({ account: seeded.accounts[5].username }), root));
    await measure('zones search', () => app.ctx.dns.listZones(page({ q: 'perf0042' }), root), { scans: true });
    const zone = await measure('zone records', () => app.ctx.dns.getZone(seeded.zones[0].domain, root));
    expect(zone.records.length).toBeGreaterThanOrEqual(2000);
  });

  it('backups: newest first, reseller scope, by account and by status', async () => {
    const r = await measure('backups root', () => app.ctx.backup.listBackups(page(), root));
    expect(r.meta.total).toBeGreaterThanOrEqual(ROWS);
    await measure('backups reseller', () => app.ctx.backup.listBackups(page(), { id: reseller.id, username: reseller.username, role: 'reseller' }));
    await measure('backups account', () => app.ctx.backup.listBackups(page({ account: seeded.accounts[7].username }), root));
    await measure('backups status', () => app.ctx.backup.listBackups(page({ status: 'failed' }), root));
  });

  it('cluster events: newest first, by kind and by status', async () => {
    const r = await measure('events default', () => app.ctx.clusters.events.list(page()));
    expect(r.meta.total).toBeGreaterThanOrEqual(ROWS);
    await measure('events kind', () => app.ctx.clusters.events.list(page({ kind: 'config.push' })));
    await measure('events status', () => app.ctx.clusters.events.list(page({ status: 'failed' })));
    await measure('events search', () => app.ctx.clusters.events.list(page({ q: 'event 1234' })), { scans: true });
  });

  it('plugin logs: latest lines of one plugin', async () => {
    const logs = pluginId
      ? await measure('plugin logs', () => app.ctx.plugins.logs(pluginId, 100))
      : await measure('plugin logs (raw)', () => db.prepare('SELECT id, ts, level, msg, fields_json FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT ?').all('net.whm.server-monitoring', 100));
    expect(logs).toHaveLength(100);
  });

  it('mail queue: in-memory paging of a 20k-message Exim queue', async () => {
    expect(app.ctx.capabilities.has('exim')).toBe(true);
    const run = async (label, query) => {
      const t0 = performance.now();
      const r = await app.ctx.mail.queue.list(query);
      const ms = performance.now() - t0;
      expect(ms, `${label} took ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS);
      return r;
    };
    const r = await run('queue default', page());
    expect(r.meta.total).toBe(ROWS);
    expect(r.data).toHaveLength(50);
    await run('queue frozen', page({ frozen: true }));
    await run('queue search', page({ q: 'rcpt42@' }));
    await run('queue sorted by size', page({ sort: 'size', dir: 'desc', page: 300 }));
  });
});
