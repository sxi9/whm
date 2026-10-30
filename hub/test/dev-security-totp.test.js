import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb, migrate, hasColumn } from '../shared/db.js';
import { MARKET_MIGRATIONS } from '../marketplace/index.js';
import { bootMarket, totpCode, TOTP_STEP_MS } from './market-support.js';

// Developer TOTP (RFC 6238 §5.2): a code is accepted once per account. Every
// developer check (login, step-up, enrolment confirm, disable, password reset)
// goes through devSecurity.verifyTotp, which records the time step of the last
// accepted code in developers.totp_last_step and refuses that step afterwards.

let h;
before(async () => { h = await bootMarket(); });
after(() => h.close());

const lastStep = (id) => h.mdb.prepare('SELECT totp_last_step FROM developers WHERE id = ?').get(id).totp_last_step;
const currentStep = () => Math.floor(h.ctx.clock.now() / TOTP_STEP_MS);
const login = (dev, totp) => request.agent(h.ctx.app).post('/v1/dev/login').send({ email: dev.email, password: dev.password, totp });

test('migration 001b adds developers.totp_last_step and re-applies cleanly on a database whose ledger lags', () => {
  assert.ok(hasColumn(h.mdb, 'developers', 'totp_last_step'));
  const db = openDb(':memory:', { migrationsDir: MARKET_MIGRATIONS });
  assert.ok(hasColumn(db, 'developers', 'totp_last_step'));
  db.prepare("DELETE FROM schema_migrations WHERE name = '001b_developer-totp-step.sql'").run();
  assert.deepEqual(migrate(db, MARKET_MIGRATIONS), ['001b_developer-totp-step.sql']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('developers') WHERE name = 'totp_last_step'").get().n, 1);
  assert.deepEqual(migrate(db, MARKET_MIGRATIONS), [], 'nothing left to apply');
  db.close();
});

test('the login code is spent: step-up, disable, reset and a second login refuse it as totp_reused without a strike, the next step works', async () => {
  const dev = await h.developer({ key: null });
  const used = lastStep(dev.id);
  assert.equal(used, currentStep(), 'login recorded the step of its code');
  const code = totpCode(dev.secret);
  const replay = await dev.post('/v1/dev/2fa/stepup', { totp: code });
  assert.equal(replay.status, 401, JSON.stringify(replay.body));
  assert.equal(replay.body.error.code, 'totp_reused');
  assert.equal(dev.row().failed_logins, 0, 'a replay verified, so it is not a guess: no failed-login strike');
  assert.equal((await dev.post('/v1/dev/2fa/disable', { code })).body.error.code, 'totp_reused');
  assert.equal(dev.row().totp_enabled, 1, 'TOTP stays on');
  assert.equal((await login(dev, code)).body.error.code, 'totp_reused');
  assert.equal((await h.http.post('/v1/dev/password/reset').send({ email: dev.email })).status, 202);
  const token = /reset\/([A-Za-z0-9_-]+)/.exec(h.sent.slice(-1)[0].message)[1];
  assert.equal((await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again', totp: code })).body.error.code, 'totp_reused');
  assert.equal(dev.row().failed_logins, 0);
  assert.equal(h.m.limits.count(`totp:${dev.id}`, 15 * 60_000), 0, 'the wrong-code budget is untouched by replays');
  assert.equal(lastStep(dev.id), used, 'a refused replay never moves the step');
  h.nextTotpStep();
  const ok = await dev.post('/v1/dev/2fa/stepup', { totp: totpCode(dev.secret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(lastStep(dev.id), used + 1);
  assert.equal((await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again', totp: totpCode(dev.secret) })).body.error.code, 'totp_reused', 'the reset cannot reuse the step-up code either');
});

test('replaying one code spends neither the wrong-code budget nor a login strike; a wrong code afterwards still counts', async () => {
  const dev = await h.developer({ key: null });
  const code = totpCode(dev.secret);
  for (let i = 0; i < 4; i++) {
    const replay = await dev.post('/v1/dev/2fa/stepup', { totp: code });
    assert.equal(replay.status, 401, `replay ${i + 1}: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.error.code, 'totp_reused', `replay ${i + 1}`);
  }
  assert.equal(h.m.limits.count(`totp:${dev.id}`, 15 * 60_000), 0, 'four replays, no budget spent');
  assert.equal(dev.row().failed_logins, 0);
  assert.equal(dev.row().locked_until, null);
  const wrong = await dev.post('/v1/dev/2fa/stepup', { totp: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.body.error.code, 'invalid_totp');
  assert.equal(h.m.limits.count(`totp:${dev.id}`, 15 * 60_000), 1, 'a wrong code still counts');
  assert.equal(dev.row().failed_logins, 1);
  h.nextTotpStep();
  assert.equal((await dev.post('/v1/dev/2fa/stepup', { totp: totpCode(dev.secret) })).status, 200, 'the budget is intact for the next code');
});

test('the same code sent by three requests at once is accepted exactly once (compare-and-set on the step)', async () => {
  const dev = await h.developer({ key: null });
  h.nextTotpStep();
  const code = totpCode(dev.secret);
  const results = await Promise.all([1, 2, 3].map(() => dev.post('/v1/dev/2fa/stepup', { totp: code })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401], JSON.stringify(results.map((r) => r.body)));
  assert.deepEqual(results.filter((r) => r.status === 401).map((r) => r.body.error.code), ['totp_reused', 'totp_reused']);
  assert.equal(dev.row().failed_logins, 0, 'the losers of the race are replays, not guesses');
  assert.equal(lastStep(dev.id), currentStep());
});

test('the enrolment code is spent too, and a re-enrolment within the step of the last accepted code waits for the next one', async () => {
  const dev = await h.developer({ key: null, totp: false });
  const start = await dev.post('/v1/dev/2fa/start');
  assert.equal(start.status, 200);
  const secret = start.body.data.secret;
  const code = totpCode(secret);
  assert.equal((await dev.post('/v1/dev/2fa/confirm', { code })).status, 200);
  assert.equal(lastStep(dev.id), currentStep(), 'the confirmation recorded its step');
  const again = await login(dev, code);
  assert.equal(again.status, 401, JSON.stringify(again.body));
  assert.equal(again.body.error.code, 'totp_reused');
  h.nextTotpStep();
  assert.equal((await login(dev, totpCode(secret))).status, 200);
  // disable with this step's code, then start a fresh secret: its code for the
  // same step is at the last accepted step, so it is refused until the clock moves
  h.nextTotpStep();
  assert.equal((await dev.post('/v1/dev/2fa/disable', { code: totpCode(secret) })).status, 200);
  const fresh = (await dev.post('/v1/dev/2fa/start')).body.data.secret;
  const sameStep = await dev.post('/v1/dev/2fa/confirm', { code: totpCode(fresh) });
  assert.equal(sameStep.body.error.code, 'totp_reused');
  assert.equal(dev.row().totp_enabled, 0);
  h.nextTotpStep();
  assert.equal((await dev.post('/v1/dev/2fa/confirm', { code: totpCode(fresh) })).status, 200);
  assert.equal(dev.row().totp_enabled, 1);
});

test('a code from the previous step is outside the window: it never verifies and never moves the step', async () => {
  const dev = await h.developer({ key: null });
  const used = lastStep(dev.id);
  h.nextTotpStep();
  h.nextTotpStep();
  const stale = totpCode(dev.secret);
  h.nextTotpStep();
  const res = await dev.post('/v1/dev/2fa/stepup', { totp: stale });
  assert.equal(res.body.error.code, 'invalid_totp');
  assert.equal(lastStep(dev.id), used);
  assert.equal((await dev.post('/v1/dev/2fa/stepup', { totp: totpCode(dev.secret) })).status, 200);
  assert.equal(lastStep(dev.id), used + 3);
});
