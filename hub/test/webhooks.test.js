import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootHub, DAY } from './support.js';
import { enqueue, deliver, backoffMs, BACKOFF_MINUTES, MAX_ATTEMPTS, signatureHeader, verifySignatureHeader, replay } from '../shared/webhooks.js';
import { openDb } from '../shared/db.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); const r = await responder(url, init, calls.length); if (r instanceof Error) throw r; return { status: r }; };
  fn.calls = calls;
  return fn;
}

test('the signature header is t=<unix>,v1=<hmac-sha256(secret, t + "." + body)>', () => {
  const body = '{"id":"evt_1"}';
  const header = signatureHeader('s3cret', body, 1700000000);
  assert.equal(header, `t=1700000000,v1=${crypto.createHmac('sha256', 's3cret').update(`1700000000.${body}`).digest('hex')}`);
  assert.equal(verifySignatureHeader('s3cret', body, header, { now: 1700000100 }), true);
  assert.equal(verifySignatureHeader('other', body, header, { now: 1700000100 }), false);
  assert.equal(verifySignatureHeader('s3cret', body + ' ', header, { now: 1700000100 }), false);
  assert.equal(verifySignatureHeader('s3cret', body, header, { now: 1700000000 + 301 }), false, 'stale timestamp');
});

test('enqueue fans out per subscribed enabled endpoint of the owner, and deliver signs + marks delivered', async () => {
  const create = async (events, enabled = 1, ownerType = 'vendor', ownerId = 'vnd_default') => {
    const res = await h.admin('post', '/v1/admin/webhooks').send({ url: 'https://hooks.example.test/in', events, secret: 'super-secret-value-1' });
    assert.equal(res.status, 201);
    if (!enabled) h.db.prepare('UPDATE webhook_endpoints SET enabled = 0 WHERE id = ?').run(res.body.data.id);
    if (ownerType !== 'vendor') h.db.prepare('UPDATE webhook_endpoints SET owner_type = ?, owner_id = ? WHERE id = ?').run(ownerType, ownerId, res.body.data.id);
    return res.body.data;
  };
  const all = await create(['*']);
  const only = await create(['license.revoked']);
  await create(['*'], 0);
  await create(['*'], 1, 'reseller', 'rsl_OTHER0000000001');
  const n = enqueue(h.db, { ownerType: 'vendor', ownerId: 'vnd_default', event: 'license.issued', data: { license_id: 'lic_x' }, now: h.clock.t });
  assert.equal(n, 1);
  assert.equal(enqueue(h.db, { ownerType: 'vendor', ownerId: 'vnd_default', event: 'license.revoked', data: {}, now: h.clock.t }), 2);
  const seen = [];
  const fetch = fakeFetch((url, init) => { seen.push(init); return 200; });
  const results = await deliver(h.db, { ownerType: 'vendor', fetch, crypto: h.ctx.crypto, now: () => h.clock.t });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.ok && r.status === 'delivered'));
  for (const init of seen) {
    assert.equal(init.method, 'POST');
    assert.ok(verifySignatureHeader('super-secret-value-1', init.body, init.headers['x-whm-webhook-signature'], { now: Math.floor(h.clock.t / 1000) }));
    const payload = JSON.parse(init.body);
    assert.ok(payload.id.startsWith('evt_') && payload.event && payload.ts && payload.data);
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'delivered'").get().n, 3);
  const list = await h.admin('get', `/v1/admin/webhooks/${all.id}/deliveries`);
  assert.equal(list.body.data.length, 2);
  assert.equal((await h.admin('get', `/v1/admin/webhooks/${only.id}/deliveries`)).body.data.length, 1);
});

test('retry follows the 1 m → 24 h backoff over 10 attempts, then fails; replay re-queues', async () => {
  assert.deepEqual(BACKOFF_MINUTES, [1, 5, 15, 60, 180, 360, 720, 1440, 1440, 1440]);
  assert.equal(MAX_ATTEMPTS, 10);
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(10), 1440 * 60_000);
  assert.equal(backoffMs(99), 1440 * 60_000);
  const res = await h.admin('post', '/v1/admin/webhooks').send({ url: 'https://flaky.example.test/x', events: ['webhook.test'] });
  const ep = res.body.data;
  enqueue(h.db, { ownerType: 'vendor', ownerId: 'vnd_default', event: 'webhook.test', data: {}, now: h.clock.t });
  const row = () => h.db.prepare('SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC').get(ep.id);
  const failing = fakeFetch((url, init, n) => (n % 2 ? 503 : new Error('ECONNRESET')));
  let t = h.clock.t;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const out = await deliver(h.db, { ownerType: 'vendor', fetch: failing, crypto: h.ctx.crypto, now: () => t });
    const d = out.find((r) => r.id === row().id);
    assert.ok(d, `attempt ${attempt} ran`);
    assert.equal(d.attempt, attempt);
    const r = row();
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(r.status, 'retrying');
      assert.equal(new Date(r.next_at).getTime() - t, backoffMs(attempt), `backoff after attempt ${attempt}`);
      const early = await deliver(h.db, { ownerType: 'vendor', fetch: failing, crypto: h.ctx.crypto, now: () => t + backoffMs(attempt) - 1000 });
      assert.ok(!early.some((x) => x.id === r.id), 'not due yet');
      t += backoffMs(attempt);
    } else {
      assert.equal(r.status, 'failed');
      assert.equal(r.next_at, null);
    }
  }
  assert.ok(failing.calls.length >= MAX_ATTEMPTS);
  const rp = await h.admin('post', `/v1/admin/webhooks/${ep.id}/deliveries/${row().id}/replay`);
  assert.equal(rp.status, 200);
  assert.equal(row().status, 'pending');
  assert.equal(row().attempt, 0);
  const ok = fakeFetch(() => 204);
  await deliver(h.db, { ownerType: 'vendor', fetch: ok, crypto: h.ctx.crypto, now: () => t });
  assert.equal(row().status, 'delivered');
  assert.equal(replay(h.db, { ownerType: 'vendor', id: 999999 }), false);
});

test('developer webhooks live in another database with their own table names', async () => {
  const mdb = openDb(':memory:');
  mdb.exec(`CREATE TABLE developer_webhooks (id TEXT PRIMARY KEY, developer_id TEXT, url TEXT, secret_enc TEXT, events_json TEXT, enabled INTEGER);
    CREATE TABLE developer_webhook_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT, event TEXT, payload_json TEXT, attempt INTEGER, status TEXT, next_at TEXT, last_code INTEGER, last_error TEXT, created_at TEXT, delivered_at TEXT);`);
  mdb.prepare('INSERT INTO developer_webhooks VALUES (?, ?, ?, ?, ?, 1)').run('dwh_1', 'dev_1', 'https://dev.example.test/hook', h.ctx.crypto.encrypt('dev-secret'), '["version.published"]');
  mdb.prepare('INSERT INTO developer_webhooks VALUES (?, ?, ?, ?, ?, 1)').run('dwh_2', 'dev_2', 'https://dev2.example.test/hook', h.ctx.crypto.encrypt('x'), '["*"]');
  assert.equal(enqueue(mdb, { ownerType: 'developer', ownerId: 'dev_1', event: 'version.published', data: { id: 'net.acme.x' } }), 1);
  assert.equal(enqueue(mdb, { ownerType: 'developer', ownerId: 'dev_1', event: 'version.rejected', data: {} }), 0);
  const fetch = fakeFetch(() => 200);
  const out = await deliver(mdb, { ownerType: 'developer', fetch, crypto: h.ctx.crypto });
  assert.equal(out.length, 1);
  assert.equal(fetch.calls[0].url, 'https://dev.example.test/hook');
  assert.ok(verifySignatureHeader('dev-secret', fetch.calls[0].init.body, fetch.calls[0].init.headers['x-whm-webhook-signature']));
  assert.equal(mdb.prepare("SELECT status FROM developer_webhook_deliveries").get().status, 'delivered');
  assert.throws(() => enqueue(mdb, { ownerType: 'nope', ownerId: 'x', event: 'e', data: {} }), /unknown webhook owner type/);
  mdb.close();
});

test('the scheduler job webhook-retry delivers through the hub fetch and the webhook test endpoint queues an event', async () => {
  const calls = [];
  const hub = await bootHub({ webhookFetch: async (url, init) => { calls.push({ url, init }); return { status: 200 }; } });
  try {
    const ep = (await hub.admin('post', '/v1/admin/webhooks').send({ url: 'https://ok.example.test/x', events: ['*'] })).body.data;
    const t = await hub.admin('post', `/v1/admin/webhooks/${ep.id}/test`);
    assert.equal(t.status, 202);
    assert.equal(t.body.data.queued, 1);
    const run = await hub.ctx.scheduler.run('webhook-retry');
    assert.equal(run.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].init.body).event, 'webhook.test');
    assert.ok(hub.ctx.scheduler.list().map((s) => s.name).includes('webhook-retry'));
    hub.advance(DAY);
  } finally {
    await hub.close();
  }
});

test('ctx.webhooks.deliver carries the hub fetch, crypto and clock, so a module passes only its db and owner type', async () => {
  const calls = [];
  const hub = await bootHub({ webhookFetch: async (url, init) => { calls.push({ url, init }); return { status: 200 }; } });
  try {
    const mdb = openDb(':memory:');
    mdb.exec(`CREATE TABLE developer_webhooks (id TEXT PRIMARY KEY, developer_id TEXT, url TEXT, secret_enc TEXT, events_json TEXT, enabled INTEGER);
      CREATE TABLE developer_webhook_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT, event TEXT, payload_json TEXT, attempt INTEGER, status TEXT, next_at TEXT, last_code INTEGER, last_error TEXT, created_at TEXT, delivered_at TEXT);`);
    mdb.prepare('INSERT INTO developer_webhooks VALUES (?, ?, ?, ?, ?, 1)').run('dwh_1', 'dev_1', 'https://dev.example.test/hook', hub.ctx.crypto.encrypt('dev-secret'), '["*"]');
    enqueue(mdb, { ownerType: 'developer', ownerId: 'dev_1', event: 'version.published', data: { id: 'net.acme.x' }, now: hub.clock.t });
    const out = await hub.ctx.webhooks.deliver(mdb, { ownerType: 'developer' });
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'delivered');
    assert.equal(calls[0].url, 'https://dev.example.test/hook');
    assert.equal(calls[0].init.timeoutMs, 10_000);
    assert.ok(verifySignatureHeader('dev-secret', calls[0].init.body, calls[0].init.headers['x-whm-webhook-signature'], { now: Math.floor(hub.clock.t / 1000) }), 'signed with the secret decrypted by the bound crypto');
    mdb.close();
  } finally {
    await hub.close();
  }
});

test('deliver() defaults to the SSRF-safe fetch and refuses to sign with a secret it cannot decrypt', async () => {
  const mdb = openDb(':memory:');
  mdb.exec(`CREATE TABLE developer_webhooks (id TEXT PRIMARY KEY, developer_id TEXT, url TEXT, secret_enc TEXT, events_json TEXT, enabled INTEGER);
    CREATE TABLE developer_webhook_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT, event TEXT, payload_json TEXT, attempt INTEGER, status TEXT, next_at TEXT, last_code INTEGER, last_error TEXT, created_at TEXT, delivered_at TEXT);`);
  mdb.prepare('INSERT INTO developer_webhooks VALUES (?, ?, ?, ?, ?, 1)').run('dwh_lo', 'dev_1', 'https://127.0.0.1/hook', h.ctx.crypto.encrypt('s'), '["*"]');
  enqueue(mdb, { ownerType: 'developer', ownerId: 'dev_1', event: 'version.published', data: {} });
  await assert.rejects(deliver(mdb, { ownerType: 'developer' }), /crypto service/);
  const out = await deliver(mdb, { ownerType: 'developer', crypto: h.ctx.crypto });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'retrying', 'the default fetch ran and refused the loopback target without touching the network');
  assert.match(mdb.prepare('SELECT last_error FROM developer_webhook_deliveries').get().last_error, /loopback/);
  mdb.close();
});
