import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches, nextCronRun, isValidCron } from '../src/lib/cron.js';

const sorted = (set) => [...set].sort((a, b) => a - b);
const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('parseCron', () => {
  it('expands "*" to the full range of every field', () => {
    const c = parseCron('* * * * *');
    expect(sorted(c.minute)).toEqual(range(0, 59));
    expect(sorted(c.hour)).toEqual(range(0, 23));
    expect(sorted(c.dom)).toEqual(range(1, 31));
    expect(sorted(c.month)).toEqual(range(1, 12));
    expect(sorted(c.dow)).toEqual(range(0, 6));
    expect(c.domAny).toBe(true);
    expect(c.dowAny).toBe(true);
  });

  it('resolves aliases', () => {
    expect(parseCron('@daily')).toEqual(parseCron('0 0 * * *'));
    expect(parseCron('@midnight')).toEqual(parseCron('0 0 * * *'));
    expect(parseCron('@hourly')).toEqual(parseCron('0 * * * *'));
    expect(parseCron('@weekly')).toEqual(parseCron('0 0 * * 0'));
    expect(parseCron('@monthly')).toEqual(parseCron('0 0 1 * *'));
    expect(parseCron('@yearly')).toEqual(parseCron('0 0 1 1 *'));
    expect(parseCron('@annually')).toEqual(parseCron('0 0 1 1 *'));
    expect(parseCron('  @daily  ')).toEqual(parseCron('0 0 * * *'));
  });

  it('parses lists, ranges and steps', () => {
    expect(sorted(parseCron('1,15,30 * * * *').minute)).toEqual([1, 15, 30]);
    expect(sorted(parseCron('0 9-17 * * *').hour)).toEqual(range(9, 17));
    expect(sorted(parseCron('*/15 * * * *').minute)).toEqual([0, 15, 30, 45]);
    expect(sorted(parseCron('1-10/3 * * * *').minute)).toEqual([1, 4, 7, 10]);
    expect(sorted(parseCron('0 0 1,15 * *').dom)).toEqual([1, 15]);
    expect(sorted(parseCron('0 */6 * * *').hour)).toEqual([0, 6, 12, 18]);
    expect(sorted(parseCron('5,10-12,*/30 * * * *').minute)).toEqual([0, 5, 10, 11, 12, 30]);
  });

  it('accepts month and weekday names in any case', () => {
    const c = parseCron('0 0 * jan,DEC Mon-fri');
    expect(sorted(c.month)).toEqual([1, 12]);
    expect(sorted(c.dow)).toEqual([1, 2, 3, 4, 5]);
    expect(c.domAny).toBe(true);
    expect(c.dowAny).toBe(false);
  });

  it('folds Sunday given as 7 into 0', () => {
    expect(sorted(parseCron('0 0 * * 7').dow)).toEqual([0]);
    expect(sorted(parseCron('0 0 * * 5-7').dow)).toEqual([0, 5, 6]);
  });

  it('tolerates extra whitespace between fields', () => {
    expect(parseCron('0   2 *  * *')).toEqual(parseCron('0 2 * * *'));
  });

  it('throws on invalid input', () => {
    const bad = [
      '', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * 0 *', '* * * * 8',
      'a * * * *', '*/0 * * * *', '5-1 * * * *', '1,,2 * * * *', '@fortnightly', '0 0 * foo *', '0 0 * * mon;rm', '1;2 * * * *',
    ];
    for (const expr of bad) expect(() => parseCron(expr), expr).toThrow();
  });
});

describe('isValidCron', () => {
  it('mirrors parseCron without throwing', () => {
    for (const ok of ['* * * * *', '@hourly', '0 2 * * *', '0 9-17 * * mon-fri', '*/5 * * * *']) expect(isValidCron(ok), ok).toBe(true);
    for (const bad of ['', 'nope', '* * * *', '60 * * * *', '*/0 * * * *']) expect(isValidCron(bad), bad).toBe(false);
  });
});

describe('cronMatches', () => {
  // 2026-04-13 is a Monday, 2026-04-14 a Tuesday, 2026-04-17 a Friday.
  const mon13 = local(2026, 4, 13);
  const tue14 = local(2026, 4, 14);
  const fri17 = local(2026, 4, 17);

  it('uses fixtures with the expected weekdays', () => {
    expect(mon13.getDay()).toBe(1);
    expect(tue14.getDay()).toBe(2);
    expect(fri17.getDay()).toBe(5);
  });

  it('matches minute, hour and month exactly', () => {
    expect(cronMatches('30 14 * * *', local(2026, 1, 15, 14, 30))).toBe(true);
    expect(cronMatches('30 14 * * *', local(2026, 1, 15, 14, 31))).toBe(false);
    expect(cronMatches('30 14 * * *', local(2026, 1, 15, 15, 30))).toBe(false);
    expect(cronMatches('30 14 * 2 *', local(2026, 1, 15, 14, 30))).toBe(false);
    expect(cronMatches('30 14 * 1 *', local(2026, 1, 15, 14, 30))).toBe(true);
  });

  it('accepts a pre-parsed expression', () => {
    const parsed = parseCron('*/10 * * * *');
    expect(cronMatches(parsed, local(2026, 1, 1, 0, 20))).toBe(true);
    expect(cronMatches(parsed, local(2026, 1, 1, 0, 25))).toBe(false);
  });

  it('restricts by day-of-week alone when day-of-month is "*"', () => {
    expect(cronMatches('0 0 * * 5', fri17)).toBe(true);
    expect(cronMatches('0 0 * * 5', mon13)).toBe(false);
    expect(cronMatches('0 0 * * mon', mon13)).toBe(true);
  });

  it('restricts by day-of-month alone when day-of-week is "*"', () => {
    expect(cronMatches('0 0 13 * *', mon13)).toBe(true);
    expect(cronMatches('0 0 13 * *', fri17)).toBe(false);
  });

  it('ORs day-of-month and day-of-week when both are restricted (Vixie semantics)', () => {
    expect(cronMatches('0 0 13 * 5', mon13)).toBe(true);
    expect(cronMatches('0 0 13 * 5', fri17)).toBe(true);
    expect(cronMatches('0 0 13 * 5', tue14)).toBe(false);
  });
});

describe('nextCronRun', () => {
  it('finds the next occurrence strictly after the given time', () => {
    expect(nextCronRun('30 14 * * *', local(2026, 4, 13, 10, 15))).toEqual(local(2026, 4, 13, 14, 30));
    expect(nextCronRun('30 14 * * *', local(2026, 4, 13, 14, 30))).toEqual(local(2026, 4, 14, 14, 30));
    expect(nextCronRun('30 14 * * *', local(2026, 4, 13, 15, 0))).toEqual(local(2026, 4, 14, 14, 30));
    expect(nextCronRun('*/15 * * * *', local(2026, 4, 13, 10, 7))).toEqual(local(2026, 4, 13, 10, 15));
    expect(nextCronRun('*/15 * * * *', new Date(2026, 3, 13, 10, 15, 30))).toEqual(local(2026, 4, 13, 10, 30));
  });

  it('rolls over days, months and years', () => {
    expect(nextCronRun('0 0 1 * *', local(2026, 4, 13, 12, 0))).toEqual(local(2026, 5, 1, 0, 0));
    expect(nextCronRun('0 0 1 1 *', local(2026, 4, 13, 12, 0))).toEqual(local(2027, 1, 1, 0, 0));
    expect(nextCronRun('0 0 * * mon', local(2026, 4, 13, 0, 0))).toEqual(local(2026, 4, 20, 0, 0));
    expect(nextCronRun('@weekly', local(2026, 4, 13, 0, 0))).toEqual(local(2026, 4, 19, 0, 0));
  });

  it('applies Vixie dom/dow semantics', () => {
    expect(nextCronRun('0 0 13 * 5', local(2026, 4, 13, 0, 0))).toEqual(local(2026, 4, 17, 0, 0));
    expect(nextCronRun('0 0 13 * 5', local(2026, 4, 24, 0, 1))).toEqual(local(2026, 5, 1, 0, 0));
  });

  it('returns null when nothing matches within the horizon', () => {
    expect(nextCronRun('0 0 31 2 *', local(2026, 4, 13, 0, 0))).toBeNull();
    expect(nextCronRun('0 0 29 2 *', local(2026, 4, 13, 0, 0), 30)).toBeNull();
  });

  it('throws on an invalid expression', () => {
    expect(() => nextCronRun('nope', local(2026, 4, 13))).toThrow();
  });
});
