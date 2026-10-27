// Minute-resolution in-process scheduler. Jobs are plain functions registered
// with ensure(name, cron, fn); runDue(at) runs those whose cron matches the
// minute of `at` and have not run in that minute. Cron parsing follows the
// panel's lib/cron.js (Vixie semantics).
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ALIASES = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(field, index) {
  const [min, max] = RANGES[index];
  const names = index === 3 ? MONTHS : index === 4 ? DAYS : {};
  const set = new Set();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d+))?$/i);
    if (!m) throw new Error(`invalid cron field "${field}"`);
    const toNum = (v) => (names[v.toLowerCase()] ?? Number(v));
    const lo = m[1] === '*' ? min : toNum(m[1]);
    const hi = m[1] === '*' ? max : m[2] != null ? toNum(m[2]) : lo;
    const step = m[3] ? Number(m[3]) : 1;
    if ([lo, hi, step].some((n) => Number.isNaN(n)) || step < 1 || lo < min || hi > max || lo > hi) throw new Error(`invalid cron field "${field}"`);
    for (let v = lo; v <= hi; v += step) set.add(index === 4 && v === 7 ? 0 : v);
  }
  return set;
}

export function parseCron(expr) {
  const text = ALIASES[expr.trim()] || expr.trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) throw new Error('cron expression must have 5 fields');
  const [minute, hour, dom, month, dow] = fields.map(parseField);
  return { minute, hour, dom, month, dow, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

export function cronMatches(expr, date = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!c.minute.has(date.getUTCMinutes()) || !c.hour.has(date.getUTCHours()) || !c.month.has(date.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(date.getUTCDate());
  const dowOk = c.dow.has(date.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

// The §16.11 schedule list; index.js binds the functions.
export const LICENSE_SCHEDULES = [
  { name: 'expire-licenses', cron: '5 * * * *' },
  { name: 'expiring-reminders', cron: '15 6 * * *' },
  { name: 'stale-activations', cron: '25 6 * * *' },
  { name: 'trial-expiry', cron: '35 6 * * *' },
  { name: 'webhook-retry', cron: '10 * * * *' },
  { name: 'nonce-prune', cron: '*/10 * * * *' },
  { name: 'checkin-prune', cron: '45 3 * * *' },
  { name: 'db-backup', cron: '50 * * * *' },
];

export function createScheduler({ logger, now = () => Date.now() } = {}) {
  const jobs = new Map();
  let timer = null;

  async function runOne(job, at) {
    job.lastRunAt = at.toISOString();
    job.runs++;
    try {
      const result = await job.fn({ now: at });
      job.lastResult = result ?? null;
      job.lastError = null;
      return { name: job.name, ok: true, result: job.lastResult };
    } catch (err) {
      job.lastError = String(err?.message || err);
      logger?.error({ err, schedule: job.name }, 'scheduled job failed');
      return { name: job.name, ok: false, error: job.lastError };
    }
  }

  return {
    ensure(name, cron, fn) {
      parseCron(cron);
      const existing = jobs.get(name);
      if (existing) { existing.cron = cron; existing.fn = fn; return existing; }
      const job = { name, cron, fn, lastRunAt: null, lastResult: null, lastError: null, runs: 0 };
      jobs.set(name, job);
      return job;
    },
    remove: (name) => jobs.delete(name),
    list: () => [...jobs.values()].map(({ fn, ...j }) => ({ ...j })),
    async run(name) {
      const job = jobs.get(name);
      if (!job) throw new Error(`no schedule named "${name}"`);
      return runOne(job, new Date(now()));
    },
    async runDue(at = new Date(now())) {
      const minuteKey = at.toISOString().slice(0, 16);
      const out = [];
      for (const job of jobs.values()) {
        if (job.lastRunAt && job.lastRunAt.slice(0, 16) === minuteKey) continue;
        if (!cronMatches(job.cron, at)) continue;
        out.push(await runOne(job, at));
      }
      return out;
    },
    start() {
      const delay = 60_000 - (now() % 60_000);
      timer = setTimeout(() => {
        this.runDue();
        timer = setInterval(() => this.runDue(), 60_000);
        timer.unref();
      }, delay);
      timer.unref();
    },
    stop() { if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; } },
  };
}
