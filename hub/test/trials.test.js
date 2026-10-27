import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootHub, DAY } from './support.js';
import { KIDS, pubOf } from './fixtures/index.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

const start = (email, server) => h.panel('/v1/trial', { email, ...server, hostname: 'trial.example.test', panel_version: '1.0.0' });

test('a trial creates customer, 14-day license, activation and token in one call', async () => {
  const server = h.fp('t1');
  const res = await start('ops@trial.example', server);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { data } = res.body;
  assert.match(data.key, /^WHM-/);
  assert.match(data.activation_id, /^act_/);
  const v = h.ctx.licenses.verifyToken(data.token);
  assert.equal(v.payload.ed, 'trial');
  assert.equal(v.payload.lim.max_accounts, 5);
  assert.equal(v.payload.feat.marketplace_free, true);
  assert.equal(v.payload.feat.api, false);
  assert.equal(Math.round((new Date(data.expires_at).getTime() - h.clock.t) / DAY), 14);
  const trial = h.db.prepare('SELECT * FROM trials').get();
  assert.equal(trial.fingerprint, server.fingerprint);
  assert.equal(trial.email_hash, h.ctx.trials.emailHash('ops@trial.example'));
  assert.ok(!JSON.stringify(trial).includes('ops@trial.example'), 'trials store the e-mail hash only');
  assert.equal(h.ctx.mailer.sent.at(-1).template, 'trial.started');
});

test('one trial per fingerprint and per e-mail hash', async () => {
  const server = h.fp('t2');
  assert.equal((await start('first@trial.example', server)).status, 201);
  const sameServer = await start('other@trial.example', server);
  assert.equal(sameServer.status, 409);
  assert.equal(sameServer.body.error.code, 'trial_exists');
  const sameEmail = await start('First@Trial.Example', h.fp('t3'));
  assert.equal(sameEmail.status, 409);
  assert.equal(sameEmail.body.error.code, 'trial_exists');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM licenses WHERE edition = 'trial'").get().n, 2);
});

test('trials are not renewable and cannot activate a second server', async () => {
  const server = h.fp('t4');
  const res = await start('norenew@trial.example', server);
  const lid = h.ctx.licenses.verifyToken(res.body.data.token).payload.lid;
  const renew = await h.admin('post', `/v1/admin/licenses/${lid}/renew`).send({ term_months: 1 });
  assert.equal(renew.status, 409);
  assert.equal(renew.body.error.code, 'not_renewable');
  const second = await h.activate(res.body.data.key, h.fp('t4b'));
  assert.equal(second.body.error.code, 'activation_limit');
});

test('conversion carries the activation over: the panel gets the paid token at its next check-in', async () => {
  const server = h.fp('t5');
  const res = await start('convert@trial.example', server);
  const trialId = h.db.prepare('SELECT id FROM trials WHERE fingerprint = ?').get(server.fingerprint).id;
  const conv = await h.admin('post', `/v1/admin/trials/${trialId}/convert`).send({ sku: 'whm-solo-annual' });
  assert.equal(conv.status, 200, JSON.stringify(conv.body));
  assert.match(conv.body.data.key, /^WHM-/);
  const newId = conv.body.data.license_id;
  assert.equal(h.ctx.activations.get(res.body.data.activation_id).license_id, newId);
  const check = await h.panel('/v1/checkin', { token: res.body.data.token, ...server, panel_version: '1.0.0' });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const payload = h.ctx.licenses.verifyToken(check.body.data.token).payload;
  assert.equal(payload.ed, 'solo');
  assert.equal(payload.lid, newId);
  assert.ok(check.body.data.messages.some((m) => m.code === 'trial_converted'));
  const trial = h.ctx.trials.get(trialId);
  assert.equal(trial.converted_license_id, newId);
  const old = h.ctx.licenses.get(payload.lid === newId ? trial.license_id : newId);
  assert.equal(old.status, 'expired');
  assert.equal((await h.admin('post', `/v1/admin/trials/${trialId}/convert`).send({ sku: 'whm-solo-annual' })).body.error.code, 'already_converted');
  const list = await h.admin('get', '/v1/admin/trials?converted=true');
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.funnel.converted, 1);
});

test('the daily trial-expiry job expires ended trials', async () => {
  const server = h.fp('t6');
  const res = await start('expire@trial.example', server);
  const lid = h.ctx.licenses.verifyToken(res.body.data.token).payload.lid;
  h.advance(15 * DAY);
  assert.ok(h.ctx.trials.expireDue().expired >= 1);
  assert.equal(h.ctx.licenses.get(lid).status, 'expired');
  const check = await h.panel('/v1/checkin', { token: res.body.data.token, ...server, panel_version: '1.0.0' });
  assert.equal(check.body.data.status, 'expired');
  h.advance(-15 * DAY);
});

test('malformed trial requests are rejected by zod', async () => {
  const bad = await h.panel('/v1/trial', { email: 'not-an-email', ...h.fp('t7'), hostname: 'x.example' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.fields.email);
});

test('a trial that fails to activate leaves nothing behind, so the customer can retry', async () => {
  const bare = await bootHub({ keys: false });
  try {
    const server = bare.fp('atomic');
    const begin = (opts) => bare.panel('/v1/trial', { email: 'retry@trial.example', ...server, hostname: 'trial.example.test', panel_version: '1.0.0' }, opts);
    const failed = await begin({ skipVerify: true });
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, 'no_active_key');
    assert.deepEqual(bare.db.prepare('SELECT (SELECT COUNT(*) FROM trials) AS trials, (SELECT COUNT(*) FROM licenses) AS licenses, (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM activations) AS activations').get(), { trials: 0, licenses: 0, customers: 0, activations: 0 });
    bare.ctx.keys.register({ purpose: 'license', publicPem: pubOf(KIDS.licenseA), status: 'active', activatedAt: new Date(bare.clock.t).toISOString() });
    bare.ctx.keys.register({ purpose: 'plugin', publicPem: pubOf(KIDS.pluginA), status: 'active', activatedAt: new Date(bare.clock.t).toISOString() });
    const ok = await begin();
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(bare.db.prepare('SELECT COUNT(*) AS n FROM trials').get().n, 1);
    assert.equal((await begin()).body.error.code, 'trial_exists');
  } finally {
    await bare.close();
  }
});

test('trials are vendor-owned: a reseller customer is refused and a trial-created customer is marked source=trial', async () => {
  const rs = h.ctx.resellers.create({ name: 'Trial Reseller', email: 'trials@reseller.test' });
  h.ctx.customers.create({ name: 'Theirs', email: 'theirs@reseller-customer.test', reseller_id: rs.id });
  const refused = await start('theirs@reseller-customer.test', h.fp('rs-cust'));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'trial_unavailable');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM trials WHERE email_hash = ?').get(h.ctx.trials.emailHash('theirs@reseller-customer.test')).n, 0);
  const fresh = await start('fresh@trial.example', h.fp('fresh-cust'));
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  const customer = h.ctx.customers.findByEmail('fresh@trial.example');
  assert.equal(customer.source, 'trial');
  assert.equal(customer.reseller_id, null);
  assert.equal(h.ctx.licenses.list({ customer_id: customer.id }).data[0].reseller_id, null);
  assert.equal(h.ctx.customers.create({ name: 'Manual', email: 'manual@vendor-customer.test' }).source, 'manual');
});
