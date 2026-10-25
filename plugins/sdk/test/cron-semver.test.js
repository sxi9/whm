'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('../cron');
const semver = require('../semver');
const { CronError } = require('../errors');

const T = (iso) => new Date(iso).getTime();

test('cron.parse accepts valid expressions and aliases', () => {
  for (const e of ['* * * * *', '0 2 * * *', '*/15 * * * *', '0 0 1 * *', '30 4 1,15 * 5', '0 9-17 * * mon-fri', '0 0 * jan,jul *', '@daily', '@hourly', '5 4 * * 7']) {
    assert.equal(cron.validate(e).ok, true, e);
  }
});

test('cron.parse rejects malformed expressions with CronError', () => {
  for (const e of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a * * * *', '*/0 * * * *', '5-1 * * * *', '@fortnightly', '1,,2 * * * *', 42]) {
    assert.throws(() => cron.parse(e), CronError, String(e));
    assert.equal(cron.validate(e).ok, false, String(e));
  }
});

test('cron.next computes the next UTC firing time', () => {
  assert.equal(cron.next('0 2 * * *', T('2026-01-01T00:00:00Z')), T('2026-01-01T02:00:00Z'));
  assert.equal(cron.next('0 2 * * *', T('2026-01-01T02:00:00Z')), T('2026-01-02T02:00:00Z'));
  assert.equal(cron.next('*/15 * * * *', T('2026-01-01T00:07:30Z')), T('2026-01-01T00:15:00Z'));
  assert.equal(cron.next('0 0 1 * *', T('2026-01-15T12:00:00Z')), T('2026-02-01T00:00:00Z'));
  assert.equal(cron.next('0 0 * * mon', T('2026-01-01T00:00:00Z')), T('2026-01-05T00:00:00Z')); // 2026-01-01 is a Thursday
  assert.equal(cron.next('0 0 29 2 *', T('2026-01-01T00:00:00Z')), T('2028-02-29T00:00:00Z'));
  assert.equal(cron.next('@weekly', T('2026-01-01T00:00:00Z')), T('2026-01-04T00:00:00Z'));
  // dom OR dow when both restricted (Vixie semantics): 1st of month or any Monday
  assert.equal(cron.next('0 0 1 * 1', T('2026-01-01T00:00:00Z')), T('2026-01-05T00:00:00Z'));
  assert.equal(cron.next('0 0 1 * 1', T('2026-01-26T00:00:00Z')), T('2026-02-01T00:00:00Z'));
});

test('semver.valid / compare', () => {
  assert.ok(semver.valid('1.0.0'));
  assert.ok(semver.valid('1.0.0-rc.1+build'));
  assert.ok(!semver.valid('1.0'));
  assert.ok(!semver.valid('01.0.0'));
  assert.equal(semver.compare('1.0.0', '1.0.1'), -1);
  assert.equal(semver.compare('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(semver.compare('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(semver.compare('2.0.0', '1.9.9'), 1);
  assert.equal(semver.compare('1.2.3', 'v1.2.3'), 0);
});

test('semver.satisfies across the supported range grammar', () => {
  const yes = (v, r) => assert.equal(semver.satisfies(v, r), true, `${v} should satisfy ${r}`);
  const no = (v, r) => assert.equal(semver.satisfies(v, r), false, `${v} should NOT satisfy ${r}`);
  yes('1.5.0', '^1.0.0'); no('2.0.0', '^1.0.0'); no('0.9.9', '^1.0.0');
  yes('0.2.5', '^0.2.1'); no('0.3.0', '^0.2.1'); yes('0.0.3', '^0.0.3'); no('0.0.4', '^0.0.3');
  yes('1.2.9', '~1.2.3'); no('1.3.0', '~1.2.3'); yes('1.9.0', '~1'); no('2.0.0', '~1');
  yes('1.0.0', '>=1.0.0 <2.0.0'); no('2.0.0', '>=1.0.0 <2.0.0');
  yes('1.7.0', '1.x'); no('2.0.0', '1.x'); yes('1.2.7', '1.2.x'); no('1.3.0', '1.2.x');
  yes('9.9.9', '*'); yes('1.2.3', '1.2.3'); no('1.2.4', '1.2.3'); yes('1.2.4', '=1.2.x');
  yes('1.5.0', '1.0.0 - 2.0.0'); yes('2.0.0', '1.0.0 - 2.0.0'); no('2.0.1', '1.0.0 - 2.0.0'); yes('2.5.0', '1.0 - 2'); no('3.0.0', '1.0 - 2');
  yes('2.1.0', '^1 || ^2'); no('3.0.0', '^1 || ^2');
  yes('1.1.0', '>1.0'); no('1.0.5', '>1.0'); yes('1.0.5', '<=1.0'); no('1.1.0', '<=1.0');
  no('1.0.0-beta', '>=1.0.0'); yes('1.0.0-beta', '>=1.0.0-alpha');
  assert.throws(() => semver.satisfies('x', '*'), TypeError);
  assert.throws(() => semver.satisfies('1.0.0', 'latest'), TypeError);
});

test('semver.validRange / minVersion', () => {
  assert.ok(semver.validRange('^1.2.0'));
  assert.ok(!semver.validRange(''));
  assert.ok(!semver.validRange('>= <'));
  assert.ok(!semver.validRange('1.2.3 - 2.0.0 - 3.0.0'));
  assert.equal(semver.minVersion('^1.2.0'), '1.2.0');
  assert.equal(semver.minVersion('>1.2.0'), '1.2.1');
  assert.equal(semver.minVersion('^2 || ^1.5'), '1.5.0');
  assert.equal(semver.minVersion('*'), '0.0.0');
});
