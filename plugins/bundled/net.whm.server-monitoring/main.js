'use strict';

// Server Monitoring: an in-process timer started in activate() samples
// ctx.api.system.info plus the interface counters from the agent into the
// "samples" collection, prunes it to the retention window and evaluates the
// alert thresholds. Routes serve the page under Plugins › Server Monitoring.
//
// Sampling deliberately does not run as a scheduled job: every job run costs
// the panel a jobs + job_logs row and an SSE event that nothing prunes, which
// at one sample a minute is about a million rows a year. The timer writes one
// "samples" document per tick (pruned to retentionDays) and the "sample" job
// only backs the manual "Sample now" action. The one remaining per-call cost
// is the audit_log row the host writes for every plugin agent call, so the
// network counters (the only agent call) are read at most every
// NET_COUNTERS_EVERY_MS and the rates are carried forward in between.

const timers = require('timers');

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3 };
const MAX_POINTS = 360;
const MAX_ALERT_ROWS = 500;
const PRUNE_EVERY_MS = 3600e3;
const NET_COUNTERS_EVERY_MS = 5 * 60e3;
const NET_SLACK_MS = 5e3;
const MIN_INTERVAL_MIN = 1;
const MAX_INTERVAL_MIN = 60;
const collectors = new WeakMap();
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

// Interface counters are one agent call each (audited by the host), so they
// are read every NET_COUNTERS_EVERY_MS at most unless the caller forces it
// (manual "Sample now"); samples in between carry the last measured rates.
async function readNetwork(ctx, settings, ts, log, force) {
  const previous = await ctx.store.get('net:last');
  const due = force || !previous || ts - previous.ts >= NET_COUNTERS_EVERY_MS - NET_SLACK_MS;
  if (!due) {
    const rates = (await ctx.store.get('net:rates')) || { rxRate: null, txRate: null };
    return { ...previous, rxRate: rates.rxRate, txRate: rates.txRate, measuredAt: previous.ts, carried: true };
  }
  let counters = null;
  try {
    const r = await ctx.agent.op('sec.netdev.read', {});
    if (r && Array.isArray(r.interfaces)) counters = { ts, ...sumInterfaces(r.interfaces, settings.netInterface || null) };
  } catch (err) {
    if (!(await ctx.store.get('net:unavailable'))) { log('warn', 'network counters unavailable; sampling continues without them', { error: err.message }); await ctx.store.set('net:unavailable', true); }
  }
  if (!counters) return null;
  const rates = netRates(counters, previous);
  await ctx.store.set('net:last', counters);
  await ctx.store.set('net:rates', rates);
  return { ...counters, ...rates, measuredAt: ts, carried: false };
}

async function collectSample(ctx, log, { force = false } = {}) {
  const settings = await ctx.settings.getAll();
  const ts = ctx.now();
  const info = await ctx.api.system.info();
  const net = await readNetwork(ctx, settings, ts, log, force);
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

// ------------------------------------------------------------- collector ---
// One timer per plugin context. Ticks never overlap (a slow sample is skipped,
// not queued) and a failing tick is logged, never thrown into the timer. The
// timer is unref'd so it can never keep the panel process alive on shutdown.

const intervalMsOf = (settings) => Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(Number(settings.intervalMin) || MIN_INTERVAL_MIN))) * 60e3;

function stopCollector(ctx) {
  const c = collectors.get(ctx);
  if (!c) return false;
  if (c.timer) timers.clearInterval(c.timer);
  c.timer = null;
  c.running = false;
  return true;
}

function startCollector(ctx, intervalMs) {
  stopCollector(ctx);
  const log = (level, msg, fields) => ctx.log[level](msg, fields);
  const c = {
    running: true, intervalMs, timer: null, busy: false, ticks: 0, failures: 0, lastTickAt: null, lastError: null, startedAt: ctx.now(),
    async tick() {
      if (c.busy) return { skipped: true, reason: 'busy' };
      c.busy = true;
      try {
        const settings = await ctx.settings.getAll();
        if (settings.enabled === false) return { skipped: true, reason: 'disabled' };
        const r = await collectSample(ctx, log, { force: false });
        c.ticks++;
        c.lastTickAt = r.sample.ts;
        c.lastError = null;
        return r;
      } catch (err) {
        c.failures++;
        c.lastError = { at: ctx.now(), message: err.message };
        log('warn', 'sample could not be collected', { error: err.message });
        return { error: err.message };
      } finally { c.busy = false; }
    },
  };
  c.timer = timers.setInterval(() => { c.tick().catch(() => {}); }, intervalMs);
  if (c.timer && typeof c.timer.unref === 'function') c.timer.unref();
  collectors.set(ctx, c);
  return c;
}

async function syncCollector(ctx) {
  const settings = await ctx.settings.getAll();
  const current = collectors.get(ctx);
  if (settings.enabled === false) {
    if (stopCollector(ctx)) ctx.log.info('sampling stopped: disabled in the plugin settings');
    return null;
  }
  const intervalMs = intervalMsOf(settings);
  if (current && current.running && current.intervalMs === intervalMs) return current;
  const c = startCollector(ctx, intervalMs);
  ctx.log.info(`sampling every ${intervalMs / 60e3} minute${intervalMs === 60e3 ? '' : 's'} in-process`);
  return c;
}

const collectorOf = (ctx) => collectors.get(ctx) || null;

module.exports = {
  async activate(ctx) {
    ctx.log.info('server monitoring active', { version: ctx.plugin.version });
    await syncCollector(ctx);
    ctx.settings.onChange((key) => {
      if (key !== 'enabled' && key !== 'intervalMin') return;
      syncCollector(ctx).catch((err) => ctx.log.warn('collector could not be restarted after a settings change', { error: err.message }));
    });
  },

  async deactivate(ctx) {
    stopCollector(ctx);
  },

  jobs: {
    // Backs the manual "Sample now" action only; the timer does the regular
    // sampling without a job row per tick.
    async sample(job, ctx) {
      const settings = await ctx.settings.getAll();
      if (settings.enabled === false) { job.log('sampling is disabled in the plugin settings'); return { skipped: true }; }
      const log = (level, msg, fields) => ctx.log[level](msg, fields);
      const { sample, alertsFired } = await collectSample(ctx, log, { force: true });
      const c = collectorOf(ctx);
      if (c) c.lastTickAt = sample.ts;
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
      const c = collectorOf(ctx);
      res.json({
        enabled: settings.enabled !== false, intervalMin: intervalMsOf(settings) / 60e3, collector: c ? { running: c.running, intervalMs: c.intervalMs, ticks: c.ticks, failures: c.failures, lastTickAt: c.lastTickAt, lastError: c.lastError, startedAt: c.startedAt } : { running: false },
        lastSampleAt: last?.ts ?? null, latest: last || null, sampleCount: total, thresholds: { load1: settings.loadThreshold, memPct: settings.memThresholdPct, diskPct: settings.diskThresholdPct }, alertsEnabled: settings.alertsEnabled !== false, activeAlerts: active, retentionDays: settings.retentionDays,
      });
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

module.exports.__test = { sumInterfaces, netRates, shapeSample, downsample, evaluateAlerts, collectSample, collectorOf, syncCollector, METRICS, RANGES, NET_COUNTERS_EVERY_MS };
