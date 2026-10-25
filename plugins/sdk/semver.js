'use strict';

/**
 * WHM Plugin SDK — minimal semver (versions + ranges), zero dependencies.
 *
 * Supported range grammar (a subset of the npm grammar, deliberately explicit):
 *   alternatives:  A || B
 *   alternative:   whitespace-separated comparators, all must hold
 *   comparator:    *  x  1  1.2  1.2.3  1.x  1.2.x  ^1.2.3  ~1.2.3  >=1.2.3  >1.2  <2  <=1.2.3  =1.2.3
 *   hyphen range:  1.2.3 - 2.3.4
 * Pre-release identifiers compare lower than the release they precede.
 */

const VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const PARTIAL_RE =
  /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function mk(major, minor, patch, prerelease) {
  return {
    major,
    minor,
    patch,
    prerelease: prerelease ? String(prerelease).split('.') : [],
  };
}

/** Parse "1.2.3-beta.1+build" → {major, minor, patch, prerelease[], build} or null. */
function parse(v) {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  const out = mk(+m[1], +m[2], +m[3], m[4]);
  out.build = m[5] || '';
  out.raw = v.trim();
  return out;
}

function valid(v) {
  return parse(v) !== null;
}

function cmpIdent(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1; // numeric identifiers have lower precedence
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two parsed version objects (or strings). Returns -1 | 0 | 1. */
function compare(a, b) {
  const pa = typeof a === 'string' ? parse(a) : a;
  const pb = typeof b === 'string' ? parse(b) : b;
  if (!pa || !pb) throw new TypeError('compare(): invalid version');
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  const ra = pa.prerelease || [];
  const rb = pb.prerelease || [];
  if (!ra.length && !rb.length) return 0;
  if (!ra.length) return 1;
  if (!rb.length) return -1;
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const c = cmpIdent(ra[i], rb[i]);
    if (c !== 0) return c;
  }
  return Math.sign(ra.length - rb.length);
}

function isX(s) {
  return s === undefined || /^[xX*]$/.test(s);
}

/** Parse a possibly-partial version like "1", "1.2", "1.2.x", "1.2.3-rc.1". */
function parsePartial(s) {
  const m = PARTIAL_RE.exec(s);
  if (!m) return null;
  if (isX(m[1])) return { any: true };
  const major = +m[1];
  if (isX(m[2])) {
    return { partial: true, major, minor: null, patch: null, floor: mk(major, 0, 0), ceil: mk(major + 1, 0, 0) };
  }
  const minor = +m[2];
  if (isX(m[3])) {
    return { partial: true, major, minor, patch: null, floor: mk(major, minor, 0), ceil: mk(major, minor + 1, 0) };
  }
  const patch = +m[3];
  return { partial: false, major, minor, patch, floor: mk(major, minor, patch, m[4]), ceil: mk(major, minor, patch + 1) };
}

/** Parse one comparator token into an array of {op, v} primitives, or null. */
function parseComparator(tok) {
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(tok);
  if (!m) return null;
  const op = m[1] || '';
  const p = parsePartial(m[2]);
  if (!p) return null;
  if (p.any) {
    if (op === '' || op === '=' || op === '^' || op === '~' || op === '>=') return [];
    if (op === '<' || op === '>') return [{ op: '<', v: mk(0, 0, 0) }]; // matches nothing
    return [];
  }
  switch (op) {
    case '':
    case '=':
      return p.partial ? [{ op: '>=', v: p.floor }, { op: '<', v: p.ceil }] : [{ op: '=', v: p.floor }];
    case '^': {
      let ceil;
      if (p.major > 0) ceil = mk(p.major + 1, 0, 0);
      else if (p.minor === null) ceil = mk(1, 0, 0);
      else if (p.minor > 0 || p.patch === null) ceil = mk(0, p.minor + 1, 0);
      else ceil = mk(0, 0, p.patch + 1);
      return [{ op: '>=', v: p.floor }, { op: '<', v: ceil }];
    }
    case '~': {
      const ceil = p.minor === null ? mk(p.major + 1, 0, 0) : mk(p.major, p.minor + 1, 0);
      return [{ op: '>=', v: p.floor }, { op: '<', v: ceil }];
    }
    case '>=':
      return [{ op: '>=', v: p.floor }];
    case '>':
      return p.partial ? [{ op: '>=', v: p.ceil }] : [{ op: '>', v: p.floor }];
    case '<':
      return [{ op: '<', v: p.floor }];
    case '<=':
      return p.partial ? [{ op: '<', v: p.ceil }] : [{ op: '<=', v: p.floor }];
    default:
      return null;
  }
}

function parseAlternative(alt) {
  const s = alt.trim();
  if (s === '' || s === '*' || s === 'x' || s === 'X') return [];
  const hy = s.split(/\s+-\s+/);
  if (hy.length === 2) {
    const lo = parsePartial(hy[0]);
    const hi = parsePartial(hy[1]);
    if (!lo || !hi || lo.any || hi.any) return null;
    return [{ op: '>=', v: lo.floor }, hi.partial ? { op: '<', v: hi.ceil } : { op: '<=', v: hi.floor }];
  }
  if (hy.length > 2) return null;
  const comps = [];
  for (const tok of s.split(/\s+/)) {
    const c = parseComparator(tok);
    if (!c) return null;
    comps.push(...c);
  }
  return comps;
}

/** Parse a range string into [[{op,v}...], ...] (alternatives) or null when invalid. */
function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return null;
  const alts = [];
  for (const alt of range.split('||')) {
    const comps = parseAlternative(alt);
    if (!comps) return null;
    alts.push(comps);
  }
  return alts;
}

function validRange(range) {
  return parseRange(range) !== null;
}

function holds(cmp, op) {
  switch (op) {
    case '=': return cmp === 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    default: return false;
  }
}

/** True when `version` satisfies `range`. Throws TypeError on an invalid version or range. */
function satisfies(version, range) {
  const v = parse(version);
  if (!v) throw new TypeError(`satisfies(): invalid version "${version}"`);
  const alts = parseRange(range);
  if (!alts) throw new TypeError(`satisfies(): invalid range "${range}"`);
  return alts.some((comps) => comps.every((c) => holds(compare(v, c.v), c.op)));
}

/** Return the lowest version a range admits, as "x.y.z" (used to display "minimum host version"). */
function minVersion(range) {
  const alts = parseRange(range);
  if (!alts) return null;
  let best = null;
  for (const comps of alts) {
    let floor = mk(0, 0, 0);
    for (const c of comps) {
      if (c.op === '>=' || c.op === '=') {
        if (compare(c.v, floor) > 0) floor = c.v;
      } else if (c.op === '>') {
        const n = mk(c.v.major, c.v.minor, c.v.patch + 1);
        if (compare(n, floor) > 0) floor = n;
      }
    }
    if (best === null || compare(floor, best) < 0) best = floor;
  }
  return best ? `${best.major}.${best.minor}.${best.patch}` : null;
}

module.exports = { parse, valid, compare, parseRange, validRange, satisfies, minVersion };
