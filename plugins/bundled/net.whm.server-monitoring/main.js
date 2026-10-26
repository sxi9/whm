'use strict';

// Server Monitoring: a cron job samples ctx.api.system.info plus the interface
// counters from the agent every minute into the "samples" collection, prunes
// it to the retention window and evaluates the alert thresholds. Routes serve
// the page under Plugins › Server Monitoring.

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3 };
const MAX_POINTS = 360;
const MAX_ALERT_ROWS = 500;
const PRUNE_EVERY_MS = 3600e3;
const METRICS = {
  load1: { label: '1-minute load', setting: 'loadThreshold', unit: '' },
  memPct: { label: 'Memory used', setting: 'memThresholdPct', unit: '%' },
  diskPct: { label: 'Disk used', setting: 'diskThresholdPct', unit: '%' },
};

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

function sumInterfaces(interfaces, wanted) {
  const list = (interfaces || []).filter((i) => (wanted ? i.iface === wanted : i.iface !== 'lo'));
  return list.reduce((acc, i) => ({ rxBytes: acc.rxBytes + (i.rxBytes || 0), txBytes: acc.txBytes + (i.txBytes || 0) }), { rxBytes: 0, txBytes: 0 });
}

// Counter deltas become bytes per second; a reset counter (reboot, interface
// re-created) yields no rate for that minute instead of a negative spike.
function netRates(now, previous) {
  if (!now) return { rxRate: null, txRate: null };
  if (!previous || previous.ts >= now.ts) return { rxRate: null, txRate: null };
  const dt = (now.ts - previous.ts) / 1000;
  const rx = now.rxBytes - previous.rxBytes;
  const tx = now.txBytes - previous.txBytes;
  return { rxRate: rx >= 0 ? round(rx / dt, 0) : null, txRate: tx >= 0 ? round(tx / dt, 0) : null };
}

function shapeSample(info, net, ts) {
  const mem = info.mem || {};
  const memPct = mem.totalMb ? round((mem.usedMb / mem.totalMb) * 100, 1) : null;
  const disks = (info.disk || []).map((d) => ({ mount: d.mount, usedMb: d.usedMb, totalMb: d.totalMb, pct: d.totalMb ? round((d.usedMb / d.totalMb) * 100, 1) : null }));
  const diskPct = disks.length ? Math.max(...disks.map((d) => d.pct ?? 0)) : null;
  return {
    ts, load: (info.load || []).map((l) => round(l, 2)), load1: round(info.load?.[0], 2), memUsedMb: mem.usedMb ?? null, memTotalMb: mem.totalMb ?? null, memPct,
    disks, diskPct, uptimeSec: info.uptimeSec ?? null, net,
  };
}

function downsample(points, max) {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out = [];
  const avg = (vals) => { const v = vals.filter((x) => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 2) : null; };
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size);
    out.push({
      ts: bucket[bucket.length - 1].ts, load1: avg(bucket.map((p) => p.load1)), memPct: avg(bucket.map((p) => p.memPct)), diskPct: avg(bucket.map((p) => p.diskPct)),
      rxRate: avg(bucket.map((p) => p.net?.rxRate)), txRate: avg(bucket.map((p) => p.net?.txRate)),
    });
  }
  return out;
}

const flat = (p) => ({ ts: p.ts, load1: p.load1, memPct: p.memPct, diskPct: p.diskPct, rxRate: p.net?.rxRate ?? null, txRate: p.net?.txRate ?? null });

async function evaluateAlerts(ctx, sample, settings, log) {
  if (!settings.alertsEnabled) return [];
  const fired = [];
  const alerts = ctx.store.collection('alerts');
  const cooldownMs = (settings.alertCooldownMin || 60) * 60e3;
  for (const [key, def] of Object.entries(METRICS)) {
    const threshold = Number(settings[def.setting] || 0);
    const value = sample[key];
    const state = (await ctx.store.get(`alert:${key}`)) || { active: false, lastNotifiedAt: 0, docId: null };
    const over = threshold > 0 && value != null && value >= threshold;
    if (over && !state.active) {
      const doc = await alerts.insert({ at: sample.ts, metric: def.label, key, value, threshold, unit: def.unit, state: 'active', resolvedAt: null });
      let notified = false;
      if (sample.ts - (state.lastNotifiedAt || 0) >= cooldownMs) {
        try {
          await ctx.api.contacts.notify({ event: 'net.whm.server-monitoring.alert', severity: 'warning', subject: `${def.label} is ${value}${def.unit} (threshold ${threshold}${def.unit})`, body: `Server Monitoring measured ${def.label.toLowerCase()} at ${value}${def.unit} on ${new Date(sample.ts).toISOString()}, above the configured threshold of ${threshold}${def.unit}.` });
          notified = true;
        } catch (err) { log('warn', `alert for ${key} could not be delivered`, { error: err.message }); }
      }
      await ctx.store.set(`alert:${key}`, { active: true, since: sample.ts, lastNotifiedAt: notified ? sample.ts : state.lastNotifiedAt || 0, docId: doc.id });
      fired.push({ key, value, threshold });
    } else if (!over && state.active) {
      if (state.docId) await alerts.update({ id: state.docId }, { state: 'resolved', resolvedAt: sample.ts });
      await ctx.store.set(`alert:${key}`, { active: false, lastNotifiedAt: state.lastNotifiedAt || 0, docId: null });
      try {
        await ctx.api.contacts.notify({ event: 'net.whm.server-monitoring.recovered', severity: 'info', subject: `${def.label} is back to ${value ?? '?'}${def.unit}`, body: `${def.label} dropped below ${threshold}${def.unit} at ${new Date(sample.ts).toISOString()}.` });
      } catch { /* recovery notices are best effort */ }
    }
  }
  return fired;
}

async function collectSample(ctx, log) {
  const settings = await ctx.settings.getAll();
  const ts = ctx.now();
  const info = await ctx.api.system.info();
  let counters = null;
  try {
    const r = await ctx.agent.op('sec.netdev.read', {});
    if (r && Array.isArray(r.interfaces)) counters = { ts, ...sumInterfaces(r.interfaces, settings.netInterface || null) };
  } catch (err) {
    if (!(await ctx.store.get('net:unavailable'))) { log('warn', 'network counters unavailable; sampling continues without them', { error: err.message }); await ctx.store.set('net:unavailable', true); }
  }
  const previous = await ctx.store.get('net:last');
  const net = counters ? { ...counters, ...netRates(counters, previous) } : null;
  if (counters) await ctx.store.set('net:last', counters);
  const sample = shapeSample(info, net, ts);
  const samples = ctx.store.collection('samples');
  await samples.insert(sample);
  await ctx.store.set('lastSample', { ts, load1: sample.load1, memPct: sample.memPct, diskPct: sample.diskPct });
  const lastPrune = (await ctx.store.get('lastPruneAt')) || 0;
  if (ts - lastPrune >= PRUNE_EVERY_MS) {
    const cutoff = ts - Math.max(1, Number(settings.retentionDays) || 7) * 86400e3;
    const removed = await samples.remove({ ts: { $lt: cutoff } });
    const alerts = ctx.store.collection('alerts');
    const total = await alerts.count();
    if (total > MAX_ALERT_ROWS) {
      const old = await alerts.find({}, { sort: { at: 1 }, limit: total - MAX_ALERT_ROWS });
      for (const a of old) await alerts.remove({ id: a.id });
    }
    await ctx.store.set('lastPruneAt', ts);
    if (removed) log('info', `pruned ${removed} samples older than ${settings.retentionDays} days`);
  }
  const alertsFired = await evaluateAlerts(ctx, sample, settings, log);
  return { sample, alertsFired };
}

module.exports = {
  async activate(ctx) {
    ctx.log.info('server monitoring active', { version: ctx.plugin.version });
  },

  jobs: {
    async sample(job, ctx) {
      const settings = await ctx.settings.getAll();
      if (settings.enabled === false) { job.log('sampling is disabled in the plugin settings'); return { skipped: true }; }
      const log = (level, msg, fields) => ctx.log[level](msg, fields);
      const { sample, alertsFired } = await collectSample(ctx, log);
      job.progress(100, 'sampled');
      return { ts: sample.ts, load1: sample.load1, memPct: sample.memPct, diskPct: sample.diskPct, alertsFired: alertsFired.length };
    },
  },

  routes(http, ctx) {
    http.get('/status', async (req, res) => {
      const settings = await ctx.settings.getAll();
      const last = await ctx.store.get('lastSample');
      const total = await ctx.store.collection('samples').count();
      const active = [];
      for (const [key, def] of Object.entries(METRICS)) {
        const s = await ctx.store.get(`alert:${key}`);
        if (s?.active) active.push({ key, metric: def.label, since: s.since, threshold: settings[def.setting], unit: def.unit });
      }
      res.json({ enabled: settings.enabled !== false, lastSampleAt: last?.ts ?? null, latest: last || null, sampleCount: total, thresholds: { load1: settings.loadThreshold, memPct: settings.memThresholdPct, diskPct: settings.diskThresholdPct }, alertsEnabled: settings.alertsEnabled !== false, activeAlerts: active, retentionDays: settings.retentionDays });
    });

    http.get('/metrics', async (req, res) => {
      const range = RANGES[req.query.range] ? req.query.range : '24h';
      const to = ctx.now();
      const from = to - RANGES[range];
      const rows = await ctx.store.collection('samples').find({ ts: { $gte: from } }, { sort: { ts: 1 } });
      const points = downsample(rows.map(flat), MAX_POINTS);
      const latest = rows.length ? rows[rows.length - 1] : null;
      const settings = await ctx.settings.getAll();
      res.json({ range, from, to, points, latest, thresholds: { load1: settings.loadThreshold, memPct: settings.memThresholdPct, diskPct: settings.diskThresholdPct }, hostname: null });
    });

    http.get('/alerts', async (req, res) => {
      const rows = await ctx.store.collection('alerts').find({}, { sort: { at: -1 }, limit: 200 });
      res.json(rows.map((a) => ({ id: a.id, at: new Date(a.at).toISOString(), metric: a.metric, value: `${a.value}${a.unit || ''}`, threshold: `${a.threshold}${a.unit || ''}`, state: a.state, resolvedAt: a.resolvedAt ? new Date(a.resolvedAt).toISOString() : null })));
    });

    http.post('/sample', async (req, res) => {
      const jobId = await ctx.jobs.run('sample', {});
      await ctx.api.audit.record({ action: 'sample.manual', target: 'host', details: { jobId, by: req.user.username } });
      res.status(202).json({ jobId });
    });
  },
};

module.exports.__test = { sumInterfaces, netRates, shapeSample, downsample, evaluateAlerts, collectSample, METRICS, RANGES };
