import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootHub, DAY } from './support.js';
import { addMonths } from '../license/services/licenses.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

test('issue → renew (expiry extends from max(now, expires_at)) → upgrade → downgrade refused / forced → suspend/unsuspend → revoke → rekey', async () => {
  const issued = await h.admin('post', '/v1/admin/licenses').send({ sku: 'whm-solo-annual', customer: { email: 'ops@acme.example', name: 'Acme' }, term_months: 12, notes: 'order #5531', external_ref: 'whmcs:5531' });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const { license_id: id, key } = issued.body.data;
  assert.match(key, /^WHM-/);
  assert.equal(issued.body.data.edition, 'solo');
  assert.equal(issued.body.data.max_activations, 1);
  const lic0 = h.ctx.licenses.get(id);
  assert.equal(lic0.expires_at, addMonths(lic0.starts_at, 12));
  assert.equal(h.db.prepare('SELECT key_hash FROM licenses WHERE id = ?').get(id).key_hash.length, 64);
  assert.equal(h.ctx.mailer.sent.at(-1).template, 'license.issued');
  assert.ok(!h.ctx.mailer.sent.at(-1).message.includes(key), 'the key is never mailed');
  assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()).includes(key), 'the key is never audited');

  // renew from the future expiry (not from now)
  const renewed = await h.admin('post', `/v1/admin/licenses/${id}/renew`).send({ term_months: 12 });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.data.expires_at, addMonths(lic0.expires_at, 12));
  // renew an expired license from now
  h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 40 * DAY).toISOString(), id);
  const renewed2 = await h.admin('post', `/v1/admin/licenses/${id}/renew`).send({ term_months: 1 });
  assert.equal(renewed2.body.data.expires_at, addMonths(new Date(h.clock.t).toISOString(), 1));
  assert.equal(renewed2.body.data.status, 'active');

  // activate + report usage so downgrade checks have data
  const server = h.fp('lc');
  const act = await h.activate(key, server);
  await h.panel('/v1/checkin', { token: act.body.data.token, ...server, panel_version: '1.0.0', usage: { accounts: 41, resellers: 2, domains: 50 } });

  const up = await h.admin('post', `/v1/admin/licenses/${id}/change-edition`).send({ sku: 'whm-pro-annual', prorate: true });
  assert.equal(up.status, 200);
  assert.equal(up.body.data.edition, 'pro');
  assert.equal(up.body.data.limits.max_accounts, -1);
  assert.equal(up.body.data.features.transfers, true);
  const next = await h.panel('/v1/checkin', { token: act.body.data.token, ...server, panel_version: '1.0.0' });
  assert.equal(h.ctx.licenses.verifyToken(next.body.data.token).payload.ed, 'pro', 'edition changes take effect at the next check-in');
  assert.ok(next.body.data.messages.some((m) => m.code === 'edition_changed'));

  const down = await h.admin('post', `/v1/admin/licenses/${id}/change-edition`).send({ sku: 'whm-solo-annual' });
  assert.equal(down.status, 409);
  assert.equal(down.body.error.code, 'over_limit');
  assert.equal(down.body.error.accounts, 41);
  assert.equal(down.body.error.max_accounts, 25);
  const forced = await h.admin('post', `/v1/admin/licenses/${id}/change-edition`).send({ sku: 'whm-solo-annual', force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.data.edition, 'solo');

  const sus = await h.admin('post', `/v1/admin/licenses/${id}/suspend`).send({ reason: 'invoice overdue' });
  assert.equal(sus.body.data.status, 'suspended');
  assert.equal((await h.activate(key, server)).body.error.code, 'suspended');
  const unsus = await h.admin('post', `/v1/admin/licenses/${id}/unsuspend`).send({});
  assert.equal(unsus.body.data.status, 'active');

  const rev = await h.admin('post', `/v1/admin/licenses/${id}/revoke`).send({ reason: 'chargeback' });
  assert.equal(rev.body.data.status, 'revoked');
  assert.equal(h.ctx.activations.get(act.body.data.activation_id).status, 'blocked');
  const revs = h.db.prepare('SELECT * FROM revocations WHERE license_id = ?').all(id);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].reason, 'chargeback');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'license.revoke' AND target = ?").get(id).n, 1);
  assert.equal((await h.admin('post', `/v1/admin/licenses/${id}/renew`).send({ term_months: 1 })).body.error.code, 'revoked');

  const rk = await h.admin('post', `/v1/admin/licenses/${id}/rekey`).send({ reason: 'customer lost key' });
  assert.equal(rk.status, 200);
  assert.notEqual(rk.body.data.key, key);
  assert.equal(h.ctx.licenses.findByKey(key), null, 'the old key no longer resolves');
  assert.equal(h.ctx.licenses.findByKey(rk.body.data.key).id, id);
  assert.equal(h.ctx.activations.get(act.body.data.activation_id).license_id, id, 'activations untouched');
});

test('rekey keeps existing activations and tokens working', async () => {
  const { license, key } = h.issue('whm-pro-annual');
  const server = h.fp('rk');
  const a = await h.activate(key, server);
  const { key: newKey } = h.ctx.licenses.rekey(license.id, { reason: 'lost' });
  const c = await h.panel('/v1/checkin', { token: a.body.data.token, ...server, panel_version: '1.0.0' });
  assert.equal(c.status, 200);
  assert.equal((await h.activate(key, server)).body.error.code, 'invalid_key');
  assert.equal((await h.activate(newKey, server)).status, 200);
});

test('webhooks and audit rows are produced by every lifecycle transition', async () => {
  h.db.prepare('INSERT INTO webhook_endpoints (id, owner_type, owner_id, url, secret_enc, events_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run('whk_LIFE00000000001', 'vendor', 'vnd_default', 'https://hooks.example.test/all', h.ctx.crypto.encrypt('s'), '["*"]', new Date().toISOString());
  const { license } = h.issue('whm-pro-annual');
  h.ctx.licenses.renew(license.id, { term_months: 1 });
  h.ctx.licenses.changeEdition(license.id, { sku: 'whm-reseller-annual-5' });
  h.ctx.licenses.suspend(license.id, { reason: 'x' });
  h.ctx.licenses.unsuspend(license.id);
  h.ctx.licenses.revoke(license.id, { reason: 'x' });
  const events = h.db.prepare("SELECT event FROM webhook_deliveries WHERE endpoint_id = 'whk_LIFE00000000001' AND json_extract(payload_json, '$.data.license_id') = ? ORDER BY id").all(license.id).map((r) => r.event);
  assert.deepEqual(events, ['license.issued', 'license.renewed', 'license.edition_changed', 'license.suspended', 'license.revoked']);
  const actions = h.db.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(license.id).map((r) => r.action);
  assert.deepEqual(actions, ['license.issue', 'license.renew', 'license.change_edition', 'license.suspend', 'license.unsuspend', 'license.revoke']);
});

test('the hourly expire job moves licenses past expires_at + grace to expired and mails the customer', () => {
  const { license } = h.issue('whm-solo-monthly');
  h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 8 * DAY).toISOString(), license.id);
  const within = h.issue('whm-solo-monthly');
  h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 6 * DAY).toISOString(), within.license.id);
  const before = h.ctx.mailer.sent.length;
  const out = h.ctx.licenses.expireDue();
  assert.equal(out.expired, 1);
  assert.equal(h.ctx.licenses.get(license.id).status, 'expired');
  assert.equal(h.ctx.licenses.get(within.license.id).status, 'active');
  assert.equal(h.ctx.licenses.statusAt(h.ctx.licenses.get(within.license.id)), 'grace');
  assert.equal(h.ctx.mailer.sent.length, before + 1);
  assert.equal(h.ctx.mailer.sent.at(-1).template, 'license.expired');
});

test('expiring reminders fire at 30/14/7/1 days', () => {
  const mk = (days) => { const { license } = h.issue('whm-pro-annual'); h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t + days * DAY - 3600_000).toISOString(), license.id); return license.id; };
  const ids = [mk(30), mk(14), mk(7), mk(1), mk(3)];
  const before = h.ctx.mailer.sent.length;
  const out = h.ctx.licenses.expiringReminders();
  assert.equal(out.reminders, 4);
  const mails = h.ctx.mailer.sent.slice(before);
  assert.deepEqual(mails.map((m) => m.data.days_left).sort((a, b) => a - b), [1, 7, 14, 30]);
  void ids;
});

test('bulk issue runs as a job whose result (keys once) is readable by its owner only', async () => {
  const customer = h.ctx.customers.create({ name: 'Bulk', email: 'bulk@example.test' });
  const res = await h.admin('post', '/v1/admin/licenses/bulk').send({ sku: 'whm-solo-annual', count: 3, customer_id: customer.id });
  assert.equal(res.status, 202);
  const jobId = res.body.data.job.id;
  await h.ctx.jobs.settle();
  const job = await h.admin('get', `/v1/admin/jobs/${jobId}`);
  assert.equal(job.body.data.status, 'done');
  assert.equal(job.body.data.result.licenses.length, 3);
  assert.ok(job.body.data.result.licenses.every((l) => /^WHM-/.test(l.key)));
  const csv = await h.admin('get', `/v1/admin/jobs/${jobId}?format=csv`);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.equal(csv.text.split('\r\n').filter(Boolean).length, 4);
  const stored = h.db.prepare('SELECT result_json FROM jobs WHERE id = ?').get(jobId).result_json;
  assert.ok(stored.startsWith('v1:') && !stored.includes('WHM-'), 'job results are encrypted at rest');
  const reseller = h.ctx.resellers.create({ name: 'R', email: 'r-job@example.test', quota: { solo: 10 } });
  const rk = h.createApiKey({ ownerType: 'reseller', ownerId: reseller.id, scopes: ['license:read', 'license:issue'] });
  const other = await h.asKey(rk)('get', `/v1/reseller/jobs/${jobId}`);
  assert.equal(other.status, 404);
  // the same vendor tenant, but another principal or a read-only scope: never the keys
  const readOnly = h.createApiKey({ scopes: ['report:read', 'admin:read'] });
  const ro = await h.asKey(readOnly)('get', `/v1/admin/jobs/${jobId}`);
  assert.equal(ro.status, 403);
  assert.equal(ro.body.error.code, 'insufficient_scope');
  assert.equal((await h.asKey(readOnly)('get', `/v1/admin/jobs/${jobId}?format=csv`)).status, 403);
  const otherAdmin = h.createApiKey({ scopes: ['admin:*'] });
  assert.equal((await h.asKey(otherAdmin)('get', `/v1/admin/jobs/${jobId}`)).status, 404, 'another vendor key did not queue the job');
  assert.equal((await h.asKey(otherAdmin)('get', `/v1/jobs/${jobId}`)).status, 404);
  const alias = await h.admin('get', `/v1/jobs/${jobId}`);
  assert.equal(alias.status, 200, '§16.6 GET /v1/jobs/:id resolves by principal');
  assert.equal(alias.body.data.result.licenses.length, 3);
  assert.equal((await h.asKey(readOnly)('get', `/v1/jobs/${jobId}`)).status, 403);
  assert.equal((await h.http.get(`/v1/jobs/${jobId}`)).status, 401);
  assert.equal(h.db.prepare('SELECT created_by FROM jobs WHERE id = ?').get(jobId).created_by.startsWith('apikey:'), true);
});

test('public status lookup by prefix carries no PII; recover always answers 202', async () => {
  const { license } = h.issue('whm-pro-annual');
  const res = await h.http.get(`/v1/status/${license.key_prefix}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.prefix, license.key_prefix);
  assert.ok(res.body.data.matches.some((m) => m.edition === 'pro' && m.status === 'active'));
  assert.ok(!JSON.stringify(res.body).includes('@'));
  assert.equal((await h.http.get('/v1/status/nope')).status, 422);
  const customer = h.ctx.customers.get(license.customer_id);
  const before = h.ctx.mailer.sent.length;
  const r1 = await h.http.post('/v1/recover').send({ email: customer.email });
  const r2 = await h.http.post('/v1/recover').send({ email: 'nobody@example.test' });
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 202);
  assert.equal(h.ctx.mailer.sent.length, before + 1);
  const mail = h.ctx.mailer.sent.at(-1);
  assert.equal(mail.template, 'license.recover');
  assert.ok(mail.message.includes(license.key_prefix) && !/WHM-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z*~$=]{4}/.test(mail.message));
});

test('products are data: the editions matrix is seeded and editable', async () => {
  const list = await h.admin('get', '/v1/admin/products');
  assert.deepEqual([...new Set(list.body.data.map((p) => p.edition))], ['trial', 'solo', 'pro', 'reseller', 'enterprise']);
  const trial = list.body.data.find((p) => p.sku === 'whm-trial');
  assert.equal(trial.limits.max_accounts, 5);
  assert.equal(trial.term_days, 14);
  const upd = await h.admin('put', '/v1/admin/products/whm-solo-annual').send({ price_cents: 16000, limits: { max_accounts: 30 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.price_cents, 16000);
  assert.equal(upd.body.data.limits.max_accounts, 30);
  const created = await h.admin('post', '/v1/admin/products').send({ sku: 'whm-pro-2y', name: 'Pro 2y', edition: 'pro', rank: 30, term: 'contract', limits: { max_accounts: -1, max_resellers: 5, max_activations: 2 }, features: { api: true } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.features.transfers, false);
  const issued = h.issue('whm-pro-2y', { term_months: 24 });
  assert.equal(issued.license.max_activations, 2);
  assert.equal(issued.license.expires_at, addMonths(issued.license.starts_at, 24));
});

test('a future starts_at makes the license pending until that date, then usable; the hourly job promotes the row', async () => {
  const { license, key } = h.issue('whm-pro-annual', { starts_at: new Date(h.clock.t + 2 * DAY).toISOString() });
  assert.equal(license.status, 'pending');
  assert.equal(h.ctx.licenses.statusAt(license), 'pending');
  assert.equal((await h.activate(key, h.fp('pend'))).body.error.code, 'not_started');
  assert.equal(h.ctx.licenses.expireDue().started, 0, 'not promoted before starts_at');
  h.advance(3 * DAY);
  assert.equal(h.ctx.licenses.statusAt(h.ctx.licenses.get(license.id)), 'active', 'status is time-based even before the job runs');
  const server = h.fp('pend');
  const act = await h.activate(key, server);
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal(act.body.data.status, 'active');
  const out = h.ctx.licenses.expireDue();
  assert.equal(out.started, 1);
  assert.equal(h.ctx.licenses.get(license.id).status, 'active');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'license.start' AND target = ?").get(license.id).n, 1);
  assert.equal(h.ctx.licenses.expireDue().started, 0, 'promotion happens once');
  const c = await h.panel('/v1/checkin', { token: act.body.data.token, ...server, panel_version: '1.0.0' });
  assert.equal(c.body.data.status, 'active');
  // a pending license whose window has already closed when it begins expires like any other
  const late = h.issue('whm-pro-annual', { starts_at: new Date(h.clock.t + DAY).toISOString() });
  h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 20 * DAY).toISOString(), late.license.id);
  h.advance(2 * DAY);
  const both = h.ctx.licenses.expireDue();
  assert.equal(both.started, 1);
  assert.ok(both.expired >= 1);
  assert.equal(h.ctx.licenses.get(late.license.id).status, 'expired');
});
