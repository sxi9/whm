'use strict';

/**
 * WHM Plugin SDK — cron expression parser + next-run calculator (UTC), zero deps.
 *
 * Grammar: five whitespace-separated fields  "minute hour day-of-month month day-of-week"
 *   values   *  N  a-b  a-b/s  * /s  a,b,c   (lists of any of the former)
 *   month    1-12 or jan..dec (case-insensitive); day-of-week 0-7 or sun..sat (7 == 0)
 *   aliases  @yearly @annually @monthly @weekly @daily @midnight @hourly
 * Day matching follows Vixie cron: when BOTH day-of-month and day-of-week are restricted
 * the day matches if EITHER does; when one is "*" only the other is consulted.
 */

const { CronError } = require('./errors');

const ALIASES = Object.freeze({
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
});

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function parseValue(raw, spec, expr) {
  const s = raw.toLowerCase();
  if (spec.names) {
    const idx = spec.names.indexOf(s);
    if (idx !== -1) return idx + spec.nameBase;
  }
  if (!/^\d+$/.test(s)) throw new CronError(`invalid ${spec.name} value "${raw}"`, expr);
  const n = Number(s);
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${spec.name} value ${n} out of range ${spec.min}-${spec.max}`, expr);
  }
  return n;
}

function parseField(text, spec, expr) {
  if (text === '') throw new CronError(`empty ${spec.name} field`, expr);
  const set = new Set();
  for (const item of text.split(',')) {
    if (item === '') throw new CronError(`empty list item in ${spec.name}`, expr);
    const parts = item.split('/');
    if (parts.length > 2) throw new CronError(`invalid step in ${spec.name}: "${item}"`, expr);
    let step = 1;
    if (parts.length === 2) {
      if (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1) {
        throw new CronError(`invalid step "${parts[1]}" in ${spec.name}`, expr);
      }
      step = Number(parts[1]);
    }
    let lo;
    let hi;
    const base = parts[0];
    if (base === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (base.includes('-')) {
      const [a, b, ...rest] = base.split('-');
      if (rest.length || a === '' || b === '') throw new CronError(`invalid range "${base}" in ${spec.name}`, expr);
      lo = parseValue(a, spec, expr);
      hi = parseValue(b, spec, expr);
      if (lo > hi) throw new CronError(`descending range "${base}" in ${spec.name}`, expr);
    } else {
      lo = parseValue(base, spec, expr);
      hi = parts.length === 2 ? spec.max : lo;
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (spec.name === 'day-of-week' && set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  return set;
}

/**
 * Parse an expression. Returns { expr, fields: [Set×5], domStar, dowStar } or throws CronError.
 */
function parse(expr) {
  if (typeof expr !== 'string') throw new CronError('cron expression must be a string', expr);
  let text = expr.trim();
  if (text === '') throw new CronError('empty cron expression', expr);
  if (text.startsWith('@')) {
    const alias = ALIASES[text.toLowerCase()];
    if (!alias) throw new CronError(`unknown cron alias "${text}"`, expr);
    text = alias;
  }
  const raw = text.split(/\s+/);
  if (raw.length !== 5) throw new CronError(`expected 5 fields, got ${raw.length}`, expr);
  const fields = raw.map((f, i) => parseField(f, FIELDS[i], expr));
  return { expr: expr.trim(), fields, domStar: raw[2] === '*', dowStar: raw[4] === '*' };
}

/** Non-throwing validation → { ok, error? }. */
function validate(expr) {
  try {
    parse(expr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function dayMatches(c, d) {
  const dom = c.fields[2].has(d.getUTCDate());
  const dow = c.fields[4].has(d.getUTCDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dow;
  if (c.dowStar) return dom;
  return dom || dow;
}

/**
 * Next firing time strictly after `fromMs` (epoch ms, UTC). Accepts a string or a parsed object.
 */
function next(exprOrParsed, fromMs) {
  const c = typeof exprOrParsed === 'string' ? parse(exprOrParsed) : exprOrParsed;
  if (!Number.isFinite(fromMs)) throw new TypeError('next(): fromMs must be a number');
  const [minutes, hours, , months] = c.fields;
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = t + 5 * 366 * 86400000;
  while (t <= limit) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    const da = d.getUTCDate();
    const h = d.getUTCHours();
    if (!months.has(mo + 1)) { t = Date.UTC(y, mo + 1, 1); continue; }
    if (!dayMatches(c, d)) { t = Date.UTC(y, mo, da + 1); continue; }
    if (!hours.has(h)) { t = Date.UTC(y, mo, da, h + 1); continue; }
    if (!minutes.has(d.getUTCMinutes())) { t += 60000; continue; }
    return t;
  }
  throw new CronError(`"${c.expr}" never fires within 5 years`, c.expr);
}

module.exports = { ALIASES, parse, validate, next };
