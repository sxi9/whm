'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMockHost } = require(path.join(__dirname, '..', '..', '..', 'sdk', 'mock-host'));
const manifest = require('../plugin.json');
const mod = require('../main');

const NOW = Date.UTC(2026, 0, 1);
const NETDEV = (rx, tx) => ({ ts: NOW, interfaces: [{ iface: 'lo', rxBytes: 9, txBytes: 9 }, { iface: 'eth0', rxBytes: rx, txBytes: tx, rxPackets: 1, txPackets: 1 }] });

function host(opts = {}) {
  const h = createMockHost({ manifest, now: NOW, agentOps: { 'sec.netdev.read': () => NETDEV(1000, 500) }, ...opts });
  return h;
}

test('manifest is valid and declares the minute cron for the sample job', () => {
  assert.equal(manifest.cron[0].schedule, '* * * * *');
  assert.ok(manifest.permissions.includes('agent:op:sec.netdev.read'));
});

test('the sample job stores load, memory, disk and network rates and the cron fires every minute', async () => {
  const h = host();
  assert.deepEqual(await h.load(mod), { ok: true });
  const first = await h.runJob('sample', {});
  assert.equal(first.status, 'done');
  assert.equal(first.result.load1, 0.1);
  assert.equal(first.result.memPct, 25);
  assert.equal(first.result.diskPct, 40);
  const docs = await h.ctx.store.collection('samples').find({});
  assert.equal(docs.length, 1);
  assert.equal(docs[0].net.rxRate, null, 'the first sample has no previous counters');
  await h.advance(60e3);
  const after = await h.ctx.store.collection('samples').find({}, { sort: { ts: 1 } });
  assert.equal(after.length, 2, 'the cron entry produced a second sample');
  assert.equal(after[1].net.rxRate, 0, 'unchanged counters give a zero rate');
  // schedule, ui:sidebar and jobs are exercised by the manifest (cron, pages) and the routes, not by the job itself.
  assert.deepEqual(h.unusedPermissions().filter((p) => !['contacts:notify', 'audit:write', 'jobs', 'schedule', 'ui:sidebar'].includes(p)), []);
});

test('network rates come from counter deltas and a reset counter yields no rate', () => {
  const { netRates, sumInterfaces } = mod.__test;
  const sum = sumInterfaces(NETDEV(1000, 500).interfaces, null);
  assert.deepEqual(sum, { rxBytes: 1000, txBytes: 500 });
  assert.deepEqual(netRates({ ts: 60e3, rxBytes: 7000, txBytes: 1100 }, { ts: 0, rxBytes: 1000, txBytes: 500 }), { rxRate: 100, txRate: 10 });
  assert.deepEqual(netRates({ ts: 60e3, rxBytes: 10, txBytes: 10 }, { ts: 0, rxBytes: 1000, txBytes: 500 }), { rxRate: null, txRate: null });
  assert.deepEqual(sumInterfaces(NETDEV(1000, 500).interfaces, 'lo'), { rxBytes: 9, txBytes: 9 });
});

test('alerts fire once per crossing with a cooldown, resolve on recovery and are listed', async () => {
  const h = host({ systemInfo: { load: [9, 1, 1] } });
  await h.load(mod);
  await h.runJob('sample', {});
  assert.equal(h.state.notifications.length, 1);
  assert.match(h.state.notifications[0].subject, /1-minute load is 9/);
  assert.equal(h.state.notifications[0].severity, 'warning');
  await h.advance(60e3);
  assert.equal(h.state.notifications.length, 1, 'an active alert does not notify again');
  const status = await h.callRoute('GET', '/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.data.activeAlerts.length, 1);
  assert.equal(status.body.data.activeAlerts[0].key, 'load1');
  const alerts = await h.callRoute('GET', '/alerts');
  assert.equal(alerts.body.data.length, 1);
  assert.equal(alerts.body.data[0].state, 'active');
  // Threshold raised above the measured value: the alert resolves.
  await h.ctx.settings.set('loadThreshold', 50);
  await h.runJob('sample', {});
  const resolved = await h.callRoute('GET', '/alerts');
  assert.equal(resolved.body.data[0].state, 'resolved');
  assert.equal(h.state.notifications.length, 2);
  assert.equal(h.state.notifications[1].severity, 'info');
});

test('a missing Contact Manager never fails the sample job', async () => {
  // Without the contacts:notify scope the host answers notify() with an error,
  // exactly like a panel without a Contact Manager does.
  const h = createMockHost({ manifest: { ...manifest, permissions: manifest.permissions.filter((p) => p !== 'contacts:notify') }, now: NOW, agentOps: { 'sec.netdev.read': () => NETDEV(1, 1) }, systemInfo: { mem: { totalMb: 100, usedMb: 99 } } });
  await h.load(mod);
  const r = await h.runJob('sample', {});
  assert.equal(r.status, 'done');
  assert.equal(r.result.alertsFired, 1);
  assert.ok(h.state.logs.some((l) => /could not be delivered/.test(l.msg)));
  assert.equal(h.state.notifications.length, 0);
});

test('GET /metrics returns the requested range downsampled to at most 360 points and POST /sample queues the job', async () => {
  const h = host();
  await h.load(mod);
  const samples = h.ctx.store.collection('samples');
  for (let i = 0; i < 1000; i++) await samples.insert({ ts: NOW - (1000 - i) * 60e3, load1: i % 5, memPct: 50, diskPct: 40, net: { rxRate: 10, txRate: 5 } });
  const r = await h.callRoute('GET', '/metrics', { query: { range: '24h' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.range, '24h');
  assert.ok(r.body.data.points.length <= 360 && r.body.data.points.length > 100);
  assert.ok(r.body.data.points.every((p) => p.ts >= NOW - 24 * 3600e3));
  const bad = await h.callRoute('GET', '/metrics', { query: { range: '99d' } });
  assert.equal(bad.body.data.range, '24h', 'unknown ranges fall back to 24h');
  const run = await h.callRoute('POST', '/sample');
  assert.equal(run.status, 202);
  assert.ok(run.body.data.jobId);
  await h.flush();
  assert.equal(h.state.audit.length, 1);
  const user = await h.callRoute('GET', '/status', { user: { id: 2, username: 'bob', role: 'user' } });
  assert.equal(user.status, 403);
});

test('samples older than the retention window are pruned and sampling can be switched off', async () => {
  const h = host();
  await h.load(mod);
  const samples = h.ctx.store.collection('samples');
  await samples.insert({ ts: NOW - 8 * 86400e3, load1: 1 });
  await samples.insert({ ts: NOW - 6 * 86400e3, load1: 1 });
  await h.runJob('sample', {});
  const left = await samples.find({}, { sort: { ts: 1 } });
  assert.equal(left.length, 2);
  assert.ok(left.every((d) => d.ts >= NOW - 7 * 86400e3));
  await h.ctx.settings.set('enabled', false);
  const r = await h.runJob('sample', {});
  assert.deepEqual(r.result, { skipped: true });
});
