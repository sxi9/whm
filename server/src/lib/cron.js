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
    let lo = m[1] === '*' ? min : toNum(m[1]);
    let hi = m[1] === '*' ? max : m[2] != null ? toNum(m[2]) : lo;
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

export function isValidCron(expr) {
  try { parseCron(expr); return true; } catch { return false; }
}

// Vixie-cron semantics: when both day-of-month and day-of-week are restricted,
// a date matches if either does.
export function cronMatches(expr, date = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!c.minute.has(date.getMinutes()) || !c.hour.has(date.getHours()) || !c.month.has(date.getMonth() + 1)) return false;
  const domOk = c.dom.has(date.getDate());
  const dowOk = c.dow.has(date.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

export function nextCronRun(expr, from = new Date(), maxDays = 400) {
  const c = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + maxDays * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0); continue; }
    const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
    const dayOk = (c.domAny && c.dowAny) || (c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk);
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    return d;
  }
  return null;
}
