import { notFound, unprocessable, CapabilityError } from '../lib/errors.js';

// Server Status. Attached as ctx.serverStatus; other categories may call:
//   serverStatus.apache()                      -> Apache worker status (throws CapabilityError without Apache)
//   serverStatus.apacheWorkers()               -> mod_status per-slot worker table (needs ExtendedStatus On)
//   serverStatus.processLog.latest()           -> the most recent process sample with its entries, or null
//   serverStatus.processLog.settings()         -> { enabled, topN, retentionDays, schedule }
// Lazily used when present: ctx.web.apache.settings().serverStatus (whether the panel's Apache include
// renders the /server-status Location block) and ctx.web.apache.update({ serverStatus: true }, req).

export const SCOREBOARD_STATES = [
  ['_', 'waiting', 'Waiting for connection'],
  ['S', 'starting', 'Starting up'],
  ['R', 'reading', 'Reading request'],
  ['W', 'sending', 'Sending reply'],
  ['K', 'keepalive', 'Keepalive (read)'],
  ['D', 'dns', 'DNS lookup'],
  ['C', 'closing', 'Closing connection'],
  ['L', 'logging', 'Logging'],
  ['G', 'graceful', 'Gracefully finishing'],
  ['I', 'idle', 'Idle cleanup of worker'],
  ['.', 'open', 'Open slot with no current process'],
];

const SAMPLE_JOB = 'server_status.process_sample';
const SAMPLE_SCHEDULE = 'process-log-sampler';
const SAMPLE_CRON = '*/5 * * * *';
const SETTING_KEYS = { enabled: 'server_status.process_log.enabled', topN: 'server_status.process_log.top_n', retentionDays: 'server_status.process_log.retention_days' };

export function parseScoreboard(scoreboard) {
  const text = String(scoreboard || '');
  const counts = {};
  for (const ch of text) counts[ch] = (counts[ch] || 0) + 1;
  const states = SCOREBOARD_STATES.map(([char, key, label]) => ({ char, key, label, count: counts[char] || 0 }));
  const known = new Set(SCOREBOARD_STATES.map(([c]) => c));
  const other = [...text].filter((c) => !known.has(c)).length;
  return { total: text.length, open: counts['.'] || 0, used: text.length - (counts['.'] || 0), states, other, raw: text };
}

// Apache's ServerUptimeSeconds / Total Accesses counters give a lifetime average;
// the UI also wants recent throughput, so it is derived between two polls here.
export function throughputBetween(previous, current) {
  if (!previous || !current) return null;
  const seconds = (current.at - previous.at) / 1000;
  if (seconds <= 0 || current.totalAccesses == null || previous.totalAccesses == null || current.totalAccesses < previous.totalAccesses) return null;
  return {
    windowSeconds: Math.round(seconds),
    requestsPerSecond: (current.totalAccesses - previous.totalAccesses) / seconds,
    bytesPerSecond: current.totalKBytes != null && previous.totalKBytes != null && current.totalKBytes >= previous.totalKBytes ? ((current.totalKBytes - previous.totalKBytes) * 1024) / seconds : null,
  };
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function sqlNow(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Top-N by CPU plus top-N by memory, de-duplicated by PID, so a memory hog that
// is idle on CPU still shows up in the daily log.
export function pickTopProcesses(processes, topN) {
  const byCpu = [...processes].sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0)).slice(0, topN);
  const byMem = [...processes].sort((a, b) => (b.memPercent || 0) - (a.memPercent || 0) || (b.rssBytes || 0) - (a.rssBytes || 0)).slice(0, topN);
  const seen = new Map();
  for (const p of [...byCpu, ...byMem]) if (!seen.has(p.pid)) seen.set(p.pid, p);
  return [...seen.values()];
}

export function createServerStatusService(ctx) {
  const { db, agent, capabilities, settings, scheduler, jobs } = ctx;
  const audit = (req, entry) => req?.audit?.(entry);
  let lastProbe = null;

  const stmts = {
    insertSample: db.prepare(`INSERT INTO process_log_samples (sampled_at, day, load1, load5, load15, mem_used_bytes, mem_total_bytes, process_count, cpu_percent, mem_percent)
      VALUES (@sampled_at, @day, @load1, @load5, @load15, @mem_used_bytes, @mem_total_bytes, @process_count, @cpu_percent, @mem_percent)`),
    insertEntry: db.prepare(`INSERT OR REPLACE INTO process_log_entries (sample_id, pid, user, command, args, cpu_percent, mem_percent, rss_bytes, elapsed_seconds)
      VALUES (@sample_id, @pid, @user, @command, @args, @cpu_percent, @mem_percent, @rss_bytes, @elapsed_seconds)`),
    pruneSamples: db.prepare('DELETE FROM process_log_samples WHERE day < ?'),
    pruneOrphans: db.prepare('DELETE FROM process_log_entries WHERE sample_id NOT IN (SELECT id FROM process_log_samples)'),
    days: db.prepare(`SELECT day, COUNT(*) AS samples, MIN(sampled_at) AS first_at, MAX(sampled_at) AS last_at, MAX(load1) AS peak_load1, AVG(load1) AS avg_load1,
      MAX(cpu_percent) AS peak_cpu, AVG(cpu_percent) AS avg_cpu, MAX(mem_percent) AS peak_mem FROM process_log_samples GROUP BY day ORDER BY day DESC`),
    samplesForDay: db.prepare('SELECT * FROM process_log_samples WHERE day = ? ORDER BY sampled_at'),
    sample: db.prepare('SELECT * FROM process_log_samples WHERE id = ?'),
    latest: db.prepare('SELECT * FROM process_log_samples ORDER BY id DESC LIMIT 1'),
    entries: db.prepare('SELECT * FROM process_log_entries WHERE sample_id = ? ORDER BY cpu_percent DESC, mem_percent DESC'),
    userSeries: db.prepare(`SELECT e.sample_id, SUM(e.cpu_percent) AS cpu_percent, SUM(e.mem_percent) AS mem_percent, SUM(e.rss_bytes) AS rss_bytes, COUNT(*) AS processes
      FROM process_log_entries e JOIN process_log_samples s ON s.id = e.sample_id WHERE s.day = ? AND e.user = ? GROUP BY e.sample_id`),
    // One row per user+command: several PIDs of the same program (Apache workers,
    // PHP-FPM children) are summed per sample, then averaged over the samples.
    processAgg: db.prepare(`SELECT e.user, e.command, COUNT(*) AS entries, COUNT(DISTINCT e.sample_id) AS samples, SUM(e.cpu_percent) / COUNT(DISTINCT e.sample_id) AS avg_cpu, MAX(e.cpu_percent) AS peak_cpu,
      SUM(e.mem_percent) / COUNT(DISTINCT e.sample_id) AS avg_mem, MAX(e.mem_percent) AS peak_mem, MAX(e.rss_bytes) AS peak_rss, MAX(e.elapsed_seconds) AS max_elapsed, MAX(e.args) AS args
      FROM process_log_entries e JOIN process_log_samples s ON s.id = e.sample_id WHERE s.day = @day AND (@user IS NULL OR e.user = @user)
      GROUP BY e.user, e.command ORDER BY avg_cpu DESC, avg_mem DESC LIMIT 200`),
    userAgg: db.prepare(`SELECT e.user, COUNT(DISTINCT e.command) AS commands, COUNT(DISTINCT e.sample_id) AS samples, COUNT(*) AS entries, SUM(e.cpu_percent) AS cpu_total,
      SUM(e.mem_percent) AS mem_total, MAX(e.cpu_percent) AS peak_cpu, MAX(e.rss_bytes) AS peak_rss
      FROM process_log_entries e JOIN process_log_samples s ON s.id = e.sample_id WHERE s.day = ? GROUP BY e.user ORDER BY cpu_total DESC`),
    deleteDay: db.prepare('DELETE FROM process_log_samples WHERE day = ?'),
    countDay: db.prepare('SELECT COUNT(*) AS n FROM process_log_samples WHERE day = ?'),
  };

  const listenPorts = () => ({ http: 80, https: 443, bind: null, ...(settings.get('service_config.apache_ports', null) || {}) });

  function instructionsFor(reason, { flavor, probe, configuredInPanel, panelAvailable }) {
    const reloadHint = flavor === 'rhel' ? 'systemctl reload httpd' : 'systemctl reload apache2';
    switch (reason) {
      case 'module_missing':
        return {
          title: 'mod_status is not loaded',
          steps: flavor === 'rhel'
            ? ['Make sure /etc/httpd/conf.modules.d/00-base.conf contains "LoadModule status_module modules/mod_status.so".', `Reload Apache: ${reloadHint}.`, 'Re-check this page.']
            : ['Enable the module: a2enmod status', `Reload Apache: ${reloadHint}.`, 'Re-check this page.'],
        };
      case 'apache_down':
        return { title: 'Apache is not running', steps: ['Start the web server from Service Status or Service Manager.', 'Worker statistics are only available while Apache is up.'] };
      case 'unreachable':
        return {
          title: `mod_status is loaded but ${probe.host}:${probe.port}/server-status does not answer`,
          steps: [
            panelAvailable && configuredInPanel === false ? 'Turn on "Server status page" in Apache Configuration (or use "Enable in Apache Configuration" above); the panel then writes the Location block and reloads Apache.'
              : 'Add to the Apache configuration: ExtendedStatus On, then <Location "/server-status"> SetHandler server-status / Require local </Location>.',
            `Make sure Apache listens on ${probe.host}:${probe.port} (the ports configured in Apache Configuration); the probe is sent there with Host: localhost.`,
            `Reload Apache: ${reloadHint}, then re-check.`,
          ],
        };
      default:
        return null;
    }
  }

  async function apache() {
    await capabilities.ensureFresh();
    capabilities.require('apache', 'Apache is not installed on this server. Install apache2 (Debian/Ubuntu) or httpd (RHEL) to see worker status.');
    const ports = listenPorts();
    const probe = { host: ports.bind || '127.0.0.1', port: ports.http };
    const st = await agent.op('web.status', { port: ports.http, bind: ports.bind });
    if (!st?.installed) throw new CapabilityError('apache', 'Apache binaries were not found by the agent; install apache2 or httpd.');
    const ss = st.serverStatus || null;
    const active = Boolean(st.unit?.active);
    const reason = !st.statusModule ? 'module_missing' : !active ? 'apache_down' : !ss ? 'unreachable' : null;
    let configuredInPanel = null;
    try { configuredInPanel = typeof ctx.web?.apache?.settings === 'function' ? Boolean(ctx.web.apache.settings().serverStatus) : null; } catch { configuredInPanel = null; }
    const panelAvailable = typeof ctx.web?.apache?.update === 'function';
    const now = Date.now();
    const current = ss ? { at: now, totalAccesses: ss.totalAccesses, totalKBytes: ss.totalKBytes } : null;
    const recent = ss && lastProbe && lastProbe.uptimeSeconds != null && ss.uptimeSeconds != null && ss.uptimeSeconds >= lastProbe.uptimeSeconds ? throughputBetween(lastProbe, current) : null;
    lastProbe = current ? { ...current, uptimeSeconds: ss.uptimeSeconds } : null;
    const scoreboard = ss?.scoreboard ? parseScoreboard(ss.scoreboard) : null;
    return {
      installed: true,
      flavor: st.flavor || null,
      version: st.version || ss?.serverVersion || null,
      built: st.built || null,
      mpm: st.mpm || ss?.mpm || null,
      unit: st.unit || null,
      active,
      modStatus: Boolean(st.statusModule),
      modules: (st.modules || []).length,
      managedVhosts: st.managedVhosts ?? null,
      probe,
      reason,
      instructions: instructionsFor(reason, { flavor: st.flavor, probe, configuredInPanel, panelAvailable }),
      configuredInPanel,
      canEnableFromPanel: panelAvailable && configuredInPanel === false,
      status: ss ? {
        uptimeSeconds: ss.uptimeSeconds, totalAccesses: ss.totalAccesses, totalKBytes: ss.totalKBytes, requestsPerSecond: ss.requestsPerSecond, bytesPerSecond: ss.bytesPerSecond, bytesPerRequest: ss.bytesPerRequest,
        busyWorkers: ss.busyWorkers, idleWorkers: ss.idleWorkers, cpuLoad: ss.cpuLoad, load: ss.load || [null, null, null], recent,
        extended: ss.raw ? Object.keys(ss.raw).some((k) => /^(CPUUser|CPUSystem|ServerUptime|Total Duration|DurationPerReq)$/.test(k)) : null,
        counters: ss.raw ? Object.fromEntries(Object.entries(ss.raw).filter(([k]) => !/^(Scoreboard|TLSSessionCacheStatus)$/.test(k))) : {},
      } : null,
      scoreboard,
      checkedAt: new Date(now).toISOString(),
    };
  }

  // The per-slot table comes from the HTML report, which mod_status renders
  // only with ExtendedStatus On; the ?auto counters stay available without it.
  async function apacheWorkers() {
    await capabilities.ensureFresh();
    capabilities.require('apache', 'Apache is not installed on this server. Install apache2 (Debian/Ubuntu) or httpd (RHEL) to see worker status.');
    const ports = listenPorts();
    const out = await agent.op('modstatus.workers', { port: ports.http, bind: ports.bind });
    const workers = (out?.workers || []).map((w) => {
      const state = SCOREBOARD_STATES.find(([c]) => c === w.mode);
      return { ...w, stateKey: state?.[1] || null, stateLabel: state?.[2] || null };
    });
    const reason = !out?.reachable ? 'unreachable' : !out.statusPage ? 'unreachable' : out.extended === false ? 'extended_off' : null;
    const active = workers.filter((w) => w.pid != null && w.mode !== '.');
    return {
      probe: out?.probe || { host: ports.bind || '127.0.0.1', port: ports.http },
      available: reason == null,
      reason,
      instructions: reason === 'extended_off' ? {
        title: 'ExtendedStatus is Off',
        steps: ['Apache only renders the per-worker table with "ExtendedStatus On" in its configuration (the panel\'s Apache include sets it when "Server status page" is enabled).', 'Reload Apache, then re-check this page.'],
      } : reason === 'unreachable' ? { title: `${out?.probe?.host || ports.bind || '127.0.0.1'}:${out?.probe?.port || ports.http}/server-status did not answer`, steps: ['Check the Apache status panel above: it explains how to load mod_status and the Location block.'] } : null,
      columns: out?.columns || [],
      workers,
      summary: {
        slots: workers.length, active: active.length, open: workers.filter((w) => w.mode === '.').length,
        vhosts: [...new Set(active.filter((w) => ['W', 'R', 'K', 'C', 'L', 'G'].includes(w.mode) && w.vhost).map((w) => w.vhost))].length,
        clients: [...new Set(active.filter((w) => ['W', 'R', 'K', 'C'].includes(w.mode) && w.client).map((w) => w.client))].length,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  async function enableModStatus(req) {
    await capabilities.ensureFresh();
    capabilities.require('apache', 'Apache is not installed on this server.');
    if (typeof ctx.web?.apache?.update !== 'function') throw unprocessable('Apache Configuration (Service Configuration) is not available on this panel; add the /server-status Location block by hand.');
    const result = await ctx.web.apache.update({ serverStatus: true }, req);
    audit(req, { action: 'server_status.apache.enable_status', target: 'apache' });
    return { enabled: true, applied: result?.applied ?? null, lastApply: result?.lastApply ?? null };
  }

  // ------------------------------------------------------- daily process log ---

  const processLog = {
    settings() {
      const schedule = scheduler.list().find((r) => r.name === SAMPLE_SCHEDULE) || null;
      return {
        enabled: settings.get(SETTING_KEYS.enabled, true) !== false,
        topN: Number(settings.get(SETTING_KEYS.topN, 25)) || 25,
        retentionDays: Number(settings.get(SETTING_KEYS.retentionDays, 14)) || 14,
        schedule: schedule ? { name: schedule.name, cron: schedule.cron, enabled: Boolean(schedule.enabled), lastRunAt: schedule.last_run_at, nextRunAt: schedule.next_run_at } : null,
      };
    },
    updateSettings(input, req) {
      const values = {};
      if (input.enabled != null) values[SETTING_KEYS.enabled] = Boolean(input.enabled);
      if (input.topN != null) values[SETTING_KEYS.topN] = input.topN;
      if (input.retentionDays != null) values[SETTING_KEYS.retentionDays] = input.retentionDays;
      if (Object.keys(values).length) settings.setMany(values);
      if (input.enabled != null) scheduler.update(SAMPLE_SCHEDULE, { enabled: Boolean(input.enabled) });
      if (input.retentionDays != null) processLog.prune(input.retentionDays);
      audit(req, { action: 'server_status.process_log.settings', args: input });
      return processLog.settings();
    },
    // The setting is the source of truth and the schedule row follows it; the
    // row is written only when it disagrees, never on every boot or page load.
    alignSchedule() {
      const row = scheduler.list().find((r) => r.name === SAMPLE_SCHEDULE);
      if (!row) return null;
      const enabled = settings.get(SETTING_KEYS.enabled, true) !== false;
      if (Boolean(row.enabled) === enabled) return { changed: false, enabled };
      scheduler.update(SAMPLE_SCHEDULE, { enabled });
      return { changed: true, enabled };
    },
    prune(retentionDays = processLog.settings().retentionDays) {
      const cutoff = dayKey(new Date(Date.now() - retentionDays * 86_400_000));
      const samples = stmts.pruneSamples.run(cutoff).changes;
      stmts.pruneOrphans.run();
      return { cutoff, samples };
    },
    async sample(job) {
      const { topN, enabled } = processLog.settings();
      if (!enabled && !job?.params?.manual) {
        job?.log?.('Sampler is paused in Daily Process Log settings; nothing recorded', 'warn');
        return { skipped: 'paused' };
      }
      const now = new Date();
      const processes = await agent.op('sys.processes', { sort: 'cpu', limit: 5000 });
      let info = null;
      try { info = await agent.op('sys.info'); } catch (err) { job?.log?.(`sys.info failed: ${err.message}`, 'warn'); }
      const picked = pickTopProcesses(processes, topN);
      const totals = processes.reduce((acc, p) => ({ cpu: acc.cpu + (p.cpuPercent || 0), mem: acc.mem + (p.memPercent || 0) }), { cpu: 0, mem: 0 });
      const mem = info?.memory;
      const sampleId = db.transaction(() => {
        const { lastInsertRowid } = stmts.insertSample.run({
          sampled_at: sqlNow(now), day: dayKey(now),
          load1: info?.loadAverage?.[0] ?? null, load5: info?.loadAverage?.[1] ?? null, load15: info?.loadAverage?.[2] ?? null,
          mem_used_bytes: mem ? Math.max(0, (mem.totalBytes || 0) - (mem.availableBytes ?? mem.freeBytes ?? 0)) : null, mem_total_bytes: mem?.totalBytes ?? null,
          process_count: processes.length, cpu_percent: Math.round(totals.cpu * 100) / 100, mem_percent: Math.round(totals.mem * 100) / 100,
        });
        for (const p of picked) {
          stmts.insertEntry.run({ sample_id: lastInsertRowid, pid: p.pid, user: String(p.user || '?').slice(0, 64), command: String(p.command || '?').slice(0, 128), args: p.args ? String(p.args).slice(0, 512) : null,
            cpu_percent: p.cpuPercent || 0, mem_percent: p.memPercent || 0, rss_bytes: p.rssBytes || 0, elapsed_seconds: p.elapsedSeconds ?? null });
        }
        return Number(lastInsertRowid);
      })();
      const pruned = processLog.prune();
      job?.log?.(`Recorded ${picked.length} of ${processes.length} processes (sample #${sampleId}); pruned ${pruned.samples} sample(s) before ${pruned.cutoff}`);
      job?.progress?.(100, `sample #${sampleId}`);
      return { sampleId, processes: processes.length, recorded: picked.length, pruned: pruned.samples };
    },
    enqueueSample(req) {
      const job = jobs.enqueue(SAMPLE_JOB, { manual: true }, { userId: req?.user?.id ?? null });
      audit(req, { action: 'server_status.process_log.sample', args: { jobId: job?.id ?? null } });
      return job;
    },
    days() {
      const s = processLog.settings();
      return { days: stmts.days.all().map((r) => ({ day: r.day, samples: r.samples, firstAt: r.first_at, lastAt: r.last_at, peakLoad1: r.peak_load1, avgLoad1: r.avg_load1, peakCpu: r.peak_cpu, avgCpu: r.avg_cpu, peakMem: r.peak_mem })), settings: s };
    },
    day(date, { user } = {}) {
      const rows = stmts.samplesForDay.all(date);
      const userSeries = user ? new Map(stmts.userSeries.all(date, user).map((r) => [r.sample_id, r])) : null;
      const series = rows.map((r) => {
        const u = userSeries?.get(r.id);
        return { id: r.id, at: r.sampled_at, load1: r.load1, load5: r.load5, load15: r.load15, cpuPercent: r.cpu_percent, memPercent: r.mem_percent, memUsedBytes: r.mem_used_bytes, memTotalBytes: r.mem_total_bytes, processCount: r.process_count,
          ...(user ? { userCpuPercent: u?.cpu_percent ?? 0, userMemPercent: u?.mem_percent ?? 0, userRssBytes: u?.rss_bytes ?? 0, userProcesses: u?.processes ?? 0 } : {}) };
      });
      const processes = stmts.processAgg.all({ day: date, user: user || null }).map((r) => ({ user: r.user, command: r.command, args: r.args, entries: r.entries, samples: r.samples, avgCpu: r.avg_cpu, peakCpu: r.peak_cpu, avgMem: r.avg_mem, peakMem: r.peak_mem, peakRssBytes: r.peak_rss, maxElapsedSeconds: r.max_elapsed }));
      const users = stmts.userAgg.all(date).map((r) => ({ user: r.user, commands: r.commands, samples: r.samples, entries: r.entries, avgCpu: rows.length ? r.cpu_total / rows.length : 0, avgMem: rows.length ? r.mem_total / rows.length : 0, peakCpu: r.peak_cpu, peakRssBytes: r.peak_rss }));
      const peak = rows.reduce((acc, r) => ({ load1: Math.max(acc.load1, r.load1 ?? 0), cpu: Math.max(acc.cpu, r.cpu_percent ?? 0), mem: Math.max(acc.mem, r.mem_percent ?? 0) }), { load1: 0, cpu: 0, mem: 0 });
      return { date, user: user || null, samples: rows.length, series, processes, users, peak, firstAt: rows[0]?.sampled_at ?? null, lastAt: rows.at(-1)?.sampled_at ?? null };
    },
    sampleDetail(id) {
      const row = stmts.sample.get(id);
      if (!row) throw notFound('Process sample');
      return shapeSample(row);
    },
    latest() {
      const row = stmts.latest.get();
      return row ? shapeSample(row) : null;
    },
    purgeDay(date, req) {
      const existing = stmts.countDay.get(date).n;
      if (!existing) throw notFound('Process log for that day');
      const deleted = db.transaction(() => { const n = stmts.deleteDay.run(date).changes; stmts.pruneOrphans.run(); return n; })();
      audit(req, { action: 'server_status.process_log.purge', target: date, args: { samples: deleted } });
      return { date, deleted };
    },
  };

  function shapeSample(row) {
    return {
      id: row.id, at: row.sampled_at, day: row.day, load: [row.load1, row.load5, row.load15], cpuPercent: row.cpu_percent, memPercent: row.mem_percent, memUsedBytes: row.mem_used_bytes, memTotalBytes: row.mem_total_bytes, processCount: row.process_count,
      entries: stmts.entries.all(row.id).map((e) => ({ pid: e.pid, user: e.user, command: e.command, args: e.args, cpuPercent: e.cpu_percent, memPercent: e.mem_percent, rssBytes: e.rss_bytes, elapsedSeconds: e.elapsed_seconds })),
    };
  }

  return {
    apache,
    apacheWorkers,
    enableModStatus,
    processLog,
    jobs: { [SAMPLE_JOB]: (job) => processLog.sample(job) },
    schedule: { name: SAMPLE_SCHEDULE, cron: SAMPLE_CRON, jobType: SAMPLE_JOB },
  };
}
