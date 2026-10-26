import { paginate } from '../db/index.js';
import { notFound, conflict, badRequest, serviceUnavailable } from '../lib/errors.js';

export const PATTERN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
// Owner names as `ps -o user:32` prints them: system users such as "_apt",
// mixed case, bare UIDs for deleted users and names cut at 32 chars with a
// trailing "+". They are only ever compared, never passed to a program.
export const PS_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._$+-]{0,31}$/;
// The op schema's maximum; a snapshot that reaches it may have been cut short.
export const PROCESS_SCAN_LIMIT = 5000;

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
const isUniqueViolation = (err) => err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err?.message || '');
export const SIGNALS = ['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP', 'SIGSTOP'];
export const SCOPES = ['non-root', 'accounts'];

// "generic-sniffers" is a WHM meta-entry that stands for the usual packet sniffers.
export const GENERIC_SNIFFERS = ['tcpdump', 'ngrep', 'dsniff', 'ettercap', 'sniffit', 'linsniffer', 'sniffer', 'hunt', 'ethereal'];

// ps truncates the comm column to 15 characters, so a longer pattern is also
// matched by its 15-character prefix.
const COMM_MAX = 15;

const basename = (p) => String(p || '').split('/').pop();

function candidateNames(proc) {
  const names = new Set();
  const comm = String(proc.command || '').replace(/^-/, '').replace(/:$/, '');
  if (comm) names.add(comm.toLowerCase());
  const first = String(proc.args || '').trim().split(/\s+/)[0];
  const argv0 = basename(first).replace(/^-/, '').replace(/:$/, '');
  if (argv0) names.add(argv0.toLowerCase());
  return [...names];
}

// Returns the configured pattern a process trips, or null. `patterns` are the
// enabled pattern names; matching is case-insensitive on the process name and
// on the basename of its argv[0].
export function matchProcess(proc, patterns) {
  const names = candidateNames(proc);
  if (!names.length) return null;
  for (const pattern of patterns) {
    const wanted = pattern.toLowerCase() === 'generic-sniffers' ? GENERIC_SNIFFERS : [pattern.toLowerCase()];
    for (const w of wanted) {
      for (const n of names) {
        if (n === w) return pattern;
        if (n.length === COMM_MAX && w.length > COMM_MAX && w.startsWith(n)) return pattern;
      }
    }
  }
  return null;
}

export function createSystemHealthService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;
  const stmts = {
    patterns: db.prepare('SELECT * FROM bpk_patterns ORDER BY builtin DESC, name COLLATE NOCASE'),
    enabledPatterns: db.prepare('SELECT name FROM bpk_patterns WHERE enabled = 1 ORDER BY name'),
    patternById: db.prepare('SELECT * FROM bpk_patterns WHERE id = ?'),
    patternByName: db.prepare('SELECT * FROM bpk_patterns WHERE name = ? COLLATE NOCASE'),
    insertPattern: db.prepare('INSERT INTO bpk_patterns (name, enabled, note) VALUES (@name, @enabled, @note)'),
    updatePattern: db.prepare("UPDATE bpk_patterns SET name = @name, enabled = @enabled, note = @note, updated_at = datetime('now') WHERE id = @id"),
    deletePattern: db.prepare('DELETE FROM bpk_patterns WHERE id = ?'),
    insertRun: db.prepare('INSERT INTO bpk_runs (trigger, principal, dry_run) VALUES (@trigger, @principal, @dry_run)'),
    finishRun: db.prepare("UPDATE bpk_runs SET finished_at = datetime('now'), scanned = @scanned, matched = @matched, killed = @killed, failed = @failed, notified = @notified, error = @error WHERE id = @id"),
    runById: db.prepare('SELECT * FROM bpk_runs WHERE id = ?'),
    runs: db.prepare('SELECT * FROM bpk_runs ORDER BY id DESC LIMIT ?'),
    lastRun: db.prepare('SELECT * FROM bpk_runs ORDER BY id DESC LIMIT 1'),
    insertKill: db.prepare('INSERT INTO bpk_kills (run_id, pid, user, command, args, pattern, signal, result, error) VALUES (@run_id, @pid, @user, @command, @args, @pattern, @signal, @result, @error)'),
    clearKills: db.prepare('DELETE FROM bpk_kills'),
    pruneKills: db.prepare("DELETE FROM bpk_kills WHERE killed_at < datetime('now', ?)"),
    pruneRuns: db.prepare("DELETE FROM bpk_runs WHERE started_at < datetime('now', ?)"),
    killStats: db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN killed_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last24h, SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed FROM bpk_kills"),
    accountUsernames: db.prepare('SELECT username FROM accounts ORDER BY username'),
    accountDisk: db.prepare('SELECT a.username, a.domain, a.home_dir, a.disk_used_mb, a.disk_quota_mb, a.suspended, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id ORDER BY a.disk_used_mb DESC, a.username'),
  };

  const SCHEDULE = 'system-health-bpk';
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));

  function config() {
    return {
      enabled: Boolean(settings.get('system_health.bpk.enabled', true)),
      signal: settings.get('system_health.bpk.signal', 'SIGKILL'),
      notify: Boolean(settings.get('system_health.bpk.notify', true)),
      scope: settings.get('system_health.bpk.scope', 'non-root'),
      exemptUsers: settings.get('system_health.bpk.exempt_users', []) || [],
      retentionDays: Number(settings.get('system_health.bpk.retention_days', 90)) || 90,
    };
  }

  const shapePattern = (row) => row && { ...row, enabled: Boolean(row.enabled), builtin: Boolean(row.builtin) };
  const shapeRun = (row) => row && { ...row, dry_run: Boolean(row.dry_run), notified: Boolean(row.notified) };

  function requireProcps() {
    capabilities.require('procps', 'The "ps" program (procps) is not installed, so processes cannot be listed. Install procps (Debian/Ubuntu) or procps-ng (RHEL).');
  }

  // Processes the killer may act on: never root, never the panel or agent, never
  // exempt users, and (scope "accounts") only users that are panel accounts.
  function eligible(proc, cfg) {
    if (!proc.user || proc.user === 'root') return false;
    if (proc.pid <= 1 || proc.pid === process.pid) return false;
    if (cfg.exemptUsers.includes(proc.user)) return false;
    if (cfg.scope === 'accounts') return cfg.accountSet.has(proc.user);
    return true;
  }

  async function findMatches() {
    requireProcps();
    const cfg = config();
    cfg.accountSet = new Set(stmts.accountUsernames.all().map((r) => r.username));
    const patterns = stmts.enabledPatterns.all().map((r) => r.name);
    const processes = await agent.op('sys.processes', { sort: 'pid', limit: PROCESS_SCAN_LIMIT });
    const matches = [];
    for (const proc of processes) {
      if (!eligible(proc, cfg)) continue;
      const pattern = matchProcess(proc, patterns);
      if (pattern) matches.push({ pid: proc.pid, ppid: proc.ppid, user: proc.user, command: proc.command, args: proc.args, cpuPercent: proc.cpuPercent, memPercent: proc.memPercent, elapsedSeconds: proc.elapsedSeconds, pattern });
    }
    return { scanned: processes.length, truncated: processes.length >= PROCESS_SCAN_LIMIT, patterns, matches, config: cfg };
  }
  const TRUNCATED_MSG = `the process table was cut at ${PROCESS_SCAN_LIMIT} entries; processes with higher PIDs were not examined`;

  async function notify(run, kills) {
    if (!ctx.contacts?.notify || !kills.length) return false;
    const lines = kills.map((k) => `${k.result === 'killed' ? 'killed' : 'FAILED'} pid ${k.pid} (${k.user}) ${k.command}${k.args ? ' ' + k.args.slice(0, 120) : ''} [${k.pattern}]${k.error ? ': ' + k.error : ''}`);
    try {
      await ctx.contacts.notify({
        event: 'bpk.killed',
        subject: `Background Process Killer terminated ${kills.filter((k) => k.result === 'killed').length} process(es)`,
        body: `Run #${run.id} (${run.trigger}) on ${ctx.settings.get('basic.hostname') || 'this server'}:\n${lines.join('\n')}`,
        severity: 'warning',
      });
      return true;
    } catch (err) {
      logger.warn({ err }, 'background process killer notification failed');
      return false;
    }
  }

  // The agent re-reads the owner and age of the PID right before signalling and
  // refuses when they differ from the snapshot the match came from, so a PID
  // recycled onto another user's (or root's) process is never hit.
  const kill = (m, signal, req) => agent.op('bpk.kill', { pid: m.pid, signal, user: m.user, elapsedSeconds: m.elapsedSeconds }, { req });
  const killResult = (err) => (err.code === 'not_found' || err.code === 'owner_mismatch' ? 'gone' : 'failed');

  // One pass: list processes, kill every match (unless dryRun), log, notify.
  async function scan({ dryRun = false, trigger = 'manual', req = null, log = null } = {}) {
    const cfg = config();
    const { lastInsertRowid } = stmts.insertRun.run({ trigger, principal: req?.user?.username ?? null, dry_run: dryRun ? 1 : 0 });
    const runId = Number(lastInsertRowid);
    const kills = [];
    let scanned = 0;
    let matched = 0;
    let truncated = false;
    let notified = false;
    let error = null;
    try {
      const found = await findMatches();
      scanned = found.scanned;
      matched = found.matches.length;
      truncated = found.truncated;
      log?.(`${scanned} process(es) scanned, ${matched} match(es) against ${found.patterns.length} pattern(s)`);
      if (truncated) log?.(TRUNCATED_MSG, 'warn');
      for (const m of found.matches) {
        const entry = { run_id: runId, pid: m.pid, user: m.user, command: m.command, args: m.args || null, pattern: m.pattern, signal: cfg.signal, result: 'killed', error: null };
        if (dryRun) {
          entry.result = 'would-kill';
        } else {
          try {
            await kill(m, cfg.signal, req);
            log?.(`killed pid ${m.pid} (${m.user}) ${m.command} [${m.pattern}]`);
          } catch (err) {
            entry.result = killResult(err);
            entry.error = err.message;
            log?.(`pid ${m.pid} (${m.user}) ${m.command}: ${err.message}`, 'warn');
          }
        }
        stmts.insertKill.run(entry);
        kills.push(entry);
      }
      if (!dryRun && cfg.notify) notified = await notify({ id: runId, trigger }, kills.filter((k) => k.result !== 'gone'));
      stmts.pruneKills.run(`-${cfg.retentionDays} days`);
      stmts.pruneRuns.run(`-${cfg.retentionDays} days`);
    } catch (err) {
      error = err.message;
      stmts.finishRun.run({ id: runId, scanned, matched, killed: 0, failed: 0, notified: 0, error });
      throw err;
    }
    const killed = kills.filter((k) => k.result === 'killed').length;
    const failed = kills.filter((k) => k.result === 'failed').length;
    stmts.finishRun.run({ id: runId, scanned, matched, killed, failed, notified: notified ? 1 : 0, error });
    if (killed || failed || trigger === 'manual') audit(req, { action: 'system_health.bpk.scan', target: String(runId), args: { trigger, dryRun, scanned, matched, killed, failed, truncated, pids: kills.map((k) => k.pid) } });
    return { run: shapeRun(stmts.runById.get(runId)), kills, truncated };
  }

  // The feature's own state: off, or nothing ticked on the list. This is what
  // the schedule row follows.
  function featurePaused() {
    if (!config().enabled) return 'disabled';
    if (!stmts.enabledPatterns.all().length) return 'no_patterns';
    return null;
  }

  // Why the scheduled scan would do nothing right now, or null when it is armed.
  // The procps check only counts once detection has run (boot registers modules
  // before the first refresh); it is reported for display and makes the job
  // skip, but never drives the schedule row.
  function pausedReason() {
    const paused = featurePaused();
    if (paused) return paused;
    if (capabilities.snapshot().at && !capabilities.has('procps')) return 'procps_missing';
    return null;
  }

  // The enabled setting (and whether any name is ticked) is the single source
  // of truth for the schedule row, but the row is written only when that state
  // actually flips: `before` is featurePaused() from before the change. The
  // generic schedules endpoint may pause or resume the row too, and a page load
  // or an unrelated setting change must never revert that. Called without
  // `before` it aligns unconditionally (first boot, when the row is created).
  function alignSchedule(before) {
    const after = featurePaused();
    if (before !== undefined && Boolean(before) === Boolean(after)) return after;
    const schedule = ctx.scheduler.list().find((s) => s.name === SCHEDULE);
    if (schedule && Boolean(schedule.enabled) !== !after) {
      try { ctx.scheduler.update(SCHEDULE, { enabled: !after }); } catch (err) { logger.warn({ err }, 'could not toggle the background process killer schedule'); }
    }
    return after;
  }

  return {
    SCHEDULE,
    config,
    pausedReason,
    featurePaused,
    alignSchedule,

    // Page bootstrap: configuration, patterns, schedule and recent activity.
    // A read: nothing is written here.
    async overview() {
      await capabilities.ensureFresh();
      const paused = pausedReason();
      const schedule = ctx.scheduler.list().find((s) => s.name === SCHEDULE) || null;
      const stats = stmts.killStats.get();
      return {
        config: config(),
        capability: { procps: capabilities.has('procps'), notifications: Boolean(ctx.contacts?.notify) },
        patterns: stmts.patterns.all().map(shapePattern),
        schedule: schedule && { name: schedule.name, cron: schedule.cron, enabled: Boolean(schedule.enabled), paused, lastRunAt: schedule.last_run_at, nextRunAt: schedule.next_run_at },
        lastRun: shapeRun(stmts.lastRun.get()),
        stats: { total: stats.total || 0, last24h: stats.last24h || 0, failed: stats.failed || 0 },
        signals: SIGNALS,
        scopes: SCOPES,
      };
    },

    setConfig(patch, req) {
      const before = featurePaused();
      const current = config();
      const next = { ...current, ...patch };
      const values = {
        'system_health.bpk.enabled': Boolean(next.enabled),
        'system_health.bpk.signal': next.signal,
        'system_health.bpk.notify': Boolean(next.notify),
        'system_health.bpk.scope': next.scope,
        'system_health.bpk.exempt_users': [...new Set(next.exemptUsers)],
        'system_health.bpk.retention_days': next.retentionDays,
      };
      settings.setMany(values);
      alignSchedule(before);
      audit(req, { action: 'system_health.bpk.configure', args: patch });
      return config();
    },

    patterns: () => stmts.patterns.all().map(shapePattern),
    enabledPatterns: () => stmts.enabledPatterns.all().map((r) => r.name),

    addPattern({ name, note = null, enabled = true }, req) {
      if (stmts.patternByName.get(name)) throw conflict(`"${name}" is already on the list`);
      const before = featurePaused();
      let lastInsertRowid;
      try {
        ({ lastInsertRowid } = stmts.insertPattern.run({ name, enabled: enabled ? 1 : 0, note }));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`"${name}" is already on the list`);
        throw err;
      }
      alignSchedule(before);
      audit(req, { action: 'system_health.bpk.pattern.add', target: name, args: { enabled } });
      return shapePattern(stmts.patternById.get(lastInsertRowid));
    },

    updatePattern(id, patch, req) {
      const row = stmts.patternById.get(id);
      if (!row) throw notFound('Pattern');
      if (patch.name !== undefined && row.builtin) throw badRequest('Built-in entries cannot be renamed; disable it or add a new entry');
      const name = patch.name ?? row.name;
      const dup = stmts.patternByName.get(name);
      if (dup && dup.id !== row.id) throw conflict(`"${name}" is already on the list`);
      const before = featurePaused();
      try {
        stmts.updatePattern.run({ id: row.id, name, enabled: (patch.enabled ?? Boolean(row.enabled)) ? 1 : 0, note: patch.note === undefined ? row.note : patch.note });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`"${name}" is already on the list`);
        throw err;
      }
      alignSchedule(before);
      audit(req, { action: 'system_health.bpk.pattern.update', target: name, args: patch });
      return shapePattern(stmts.patternById.get(id));
    },

    removePattern(id, req) {
      const row = stmts.patternById.get(id);
      if (!row) throw notFound('Pattern');
      if (row.builtin) throw badRequest('Built-in entries cannot be removed; disable it instead');
      const before = featurePaused();
      stmts.deletePattern.run(id);
      alignSchedule(before);
      audit(req, { action: 'system_health.bpk.pattern.remove', target: row.name });
      return { removed: true, name: row.name };
    },

    // Live preview of what a run would kill right now (nothing is signalled).
    async matches() {
      const found = await findMatches();
      return { scanned: found.scanned, truncated: found.truncated, limit: PROCESS_SCAN_LIMIT, patterns: found.patterns, matches: found.matches, scope: found.config.scope };
    },

    scan,

    // Kill a single process that a preview listed; ownership of the match is
    // re-verified against the live process table before signalling.
    async killMatch(pid, req) {
      const found = await findMatches();
      const m = found.matches.find((x) => x.pid === pid);
      if (!m) throw notFound(`A disallowed process with PID ${pid}`);
      const cfg = found.config;
      const { lastInsertRowid } = stmts.insertRun.run({ trigger: 'manual', principal: req?.user?.username ?? null, dry_run: 0 });
      const runId = Number(lastInsertRowid);
      const entry = { run_id: runId, pid: m.pid, user: m.user, command: m.command, args: m.args || null, pattern: m.pattern, signal: cfg.signal, result: 'killed', error: null };
      try {
        await kill(m, cfg.signal, req);
      } catch (err) {
        entry.result = killResult(err);
        entry.error = err.message;
      }
      stmts.insertKill.run(entry);
      stmts.finishRun.run({ id: runId, scanned: found.scanned, matched: 1, killed: entry.result === 'killed' ? 1 : 0, failed: entry.result === 'failed' ? 1 : 0, notified: 0, error: null });
      audit(req, { action: 'system_health.bpk.kill', target: String(pid), args: { user: m.user, command: m.command, pattern: m.pattern, signal: cfg.signal, result: entry.result } });
      return { ...entry, runId };
    },

    kills(query) {
      const where = [];
      const params = {};
      if (query.q) { where.push("(user LIKE @q ESCAPE '\\' OR command LIKE @q ESCAPE '\\' OR args LIKE @q ESCAPE '\\' OR pattern LIKE @q ESCAPE '\\')"); params.q = `%${likeEscape(query.q)}%`; }
      if (query.user) { where.push('user = @user'); params.user = query.user; }
      if (query.result) { where.push('result = @result'); params.result = query.result; }
      return paginate(db, {
        select: '*', from: 'bpk_kills', where, params,
        sortable: { killed_at: 'killed_at', pid: 'pid', user: 'user', command: 'command', pattern: 'pattern', result: 'result' },
        defaultSort: 'killed_at', query: { ...query, dir: query.dir || (query.sort ? 'asc' : 'desc') },
      });
    },

    runs: (limit = 20) => stmts.runs.all(limit).map(shapeRun),

    clearKills(req) {
      const { changes } = stmts.clearKills.run();
      audit(req, { action: 'system_health.bpk.log.clear', args: { removed: changes } });
      return { removed: changes };
    },

    // Show Current Disk Usage: per-mount (df) plus what each account consumes,
    // as last sampled by Account Information's disk-usage job.
    async diskUsage() {
      const filesystems = await agent.op('sys.disk.usage');
      const sampledAt = settings.get('account_info.disk_refreshed_at', null);
      const canResample = Boolean(ctx.accountInfo?.enqueueDiskRefresh) || ctx.jobs.types().includes('account_info.disk_refresh');
      const accounts = stmts.accountDisk.all().map((a) => ({
        username: a.username, domain: a.domain, owner: a.owner, homeDir: a.home_dir, suspended: Boolean(a.suspended),
        diskUsedMb: a.disk_used_mb ?? 0, diskQuotaMb: a.disk_quota_mb || null,
        usedPercent: a.disk_quota_mb > 0 ? Math.min(100, Math.round(((a.disk_used_mb ?? 0) * 100) / a.disk_quota_mb)) : null,
      }));
      return { filesystems, accounts, accountsTotalMb: accounts.reduce((n, a) => n + a.diskUsedMb, 0), sampledAt, canResample };
    },

    // Re-measure every account now (Account Information owns the sampler).
    resampleDisk(req) {
      const user = req?.user ?? null;
      let job;
      if (ctx.accountInfo?.enqueueDiskRefresh) job = ctx.accountInfo.enqueueDiskRefresh(user);
      else if (ctx.jobs.types().includes('account_info.disk_refresh')) job = ctx.jobs.enqueue('account_info.disk_refresh', {}, { userId: user?.id ?? null });
      else throw serviceUnavailable('The Account Information module is not loaded, so disk usage cannot be resampled');
      audit(req, { action: 'system_health.disk.resample', target: String(job.id) });
      return { job };
    },

    processes(opts) { requireProcps(); return agent.op('sys.processes', opts); },
    signal: (pid, signal, req) => ctx.system.signal(pid, signal, req),
    renice(pid, niceness, req) { requireProcps(); return ctx.system.renice(pid, niceness, req); },
    matchProcess,
  };
}
