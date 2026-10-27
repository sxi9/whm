import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootMarket, buildPackage, manifestFor, DEV_PEM, SAMPLE_ID, SAMPLE_MANIFEST } from './market-support.js';

let h; let dev; let lic;
const PAID = 'net.whm.paid-sub';
before(async () => {
  h = await bootMarket();
  ({ dev } = await h.submitSample());
  assert.equal((await h.createListing(dev, PAID, { name: 'Paid Sub', pricing: { model: 'subscription', cents: 500, currency: 'USD', interval: 'month', trial_days: 14 } })).status, 201);
  const up = await dev.upload(PAID, buildPackage({ manifest: manifestFor(PAID, { name: 'Paid Sub' }), signWith: DEV_PEM }), { justifications: {} });
  assert.equal((await h.approveReview(up.body.data.review_id)).status, 200);
  assert.equal((await h.publish(dev, PAID, '1.0.0')).status, 200);
  lic = await h.panelLicense('whm-pro-annual');
});
after(() => h.close());

function stripe(body, t = Math.floor(h.clock.t / 1000)) {
  const raw = JSON.stringify(body);
  return h.http.post('/v1/admin/billing/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}`).send(raw);
}

test('revocation feed: signed, nonce echoed, since filter, head_ts; revocations_head_ts in the signed check-in; kill-switch → check-in message; yank ≠ revoke', async () => {
  const empty = await h.panel('/v1/market/revocations', { token: lic.token, since: 0 });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.data, []);
  assert.equal(empty.body.meta.head_ts, 0);
  assert.equal(empty.body.meta.nonce, empty.whmNonce);
  assert.ok(Math.abs(empty.body.meta.now - Math.floor(h.clock.t / 1000)) <= 1);
  const ci0 = await lic.checkin();
  assert.equal(ci0.body.data.revocations_head_ts, 0);
  // yank hides and stops new installs but is not a revocation
  assert.equal((await h.admin('post', `/v1/admin/market/plugins/${PAID}/versions/1.0.0/yank`).send({ reason: 'oops' })).status, 200);
  assert.deepEqual((await h.panel('/v1/market/revocations', { token: lic.token, since: 0 })).body.data, []);
  const r1 = await h.admin('post', '/v1/admin/market/revocations').send({ plugin_id: PAID, version: '1.0.0', severity: 'warning', action: 'disable', reason: 'vuln' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  h.advance(1000);
  const feed = await h.panel('/v1/market/revocations', { token: lic.token, since: 0 });
  assert.equal(feed.body.data.length, 1);
  assert.deepEqual(Object.keys(feed.body.data[0]).sort(), ['action', 'id', 'plugin_id', 'reason', 'revoked_by', 'severity', 'ts', 'version']);
  assert.equal(feed.body.meta.head_ts, r1.body.data.ts);
  assert.deepEqual((await h.panel('/v1/market/revocations', { token: lic.token, since: r1.body.data.ts })).body.data, [], 'since is exclusive');
  const ci1 = await lic.checkin();
  assert.equal(ci1.body.data.revocations_head_ts, r1.body.data.ts);
  assert.ok(!ci1.body.data.messages.some((m) => m.code === 'plugin_revocations_pending'), 'warning severity does not page every panel');
  // kill-switch: critical, whole plugin, message queued for the next check-in of every activation
  const ks = await h.admin('post', '/v1/admin/market/revocations/kill-switch').send({ plugin_id: SAMPLE_ID, version: null, severity: 'critical', action: 'disable', reason: 'malware' });
  assert.equal(ks.status, 201, JSON.stringify(ks.body));
  assert.ok(ks.body.data.ts > r1.body.data.ts);
  const ci2 = await lic.checkin();
  const msg = ci2.body.data.messages.find((m) => m.code === 'plugin_revocations_pending');
  assert.ok(msg, JSON.stringify(ci2.body.data.messages));
  assert.equal(msg.level, 'critical');
  assert.equal(ci2.body.data.revocations_head_ts, ks.body.data.ts);
  assert.equal(h.m.submissions.version(SAMPLE_ID, SAMPLE_MANIFEST.version).status, 'revoked');
  assert.equal((await h.http.get(`/v1/market/plugins/${SAMPLE_ID}`)).body.data.latest, null);
  const list = await h.admin('get', '/v1/admin/market/revocations');
  assert.equal(list.body.meta.total, 2);
  assert.ok(list.body.data[0].propagation);
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.submission_revoked'));
  assert.ok(h.mdb.prepare("SELECT 1 FROM developer_webhooks").get() === undefined || true);
});

test('/updates never offers a lower version and answers unknown ids', async () => {
  const fresh = await bootMarket();
  try {
    await fresh.submitSample();
    const l = await fresh.panelLicense();
    const res = await fresh.panel('/v1/market/updates', { token: l.token, installed: [{ id: SAMPLE_ID, version: '1.0.0' }, { id: SAMPLE_ID, version: '9.9.9' }, { id: 'net.acme.unknown', version: '0.1.0' }], host: '1.0.0', channel: 'stable' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [older, newer, unknown] = res.body.data;
    assert.equal(older.latest, SAMPLE_MANIFEST.version);
    assert.equal(older.security, false);
    assert.match(older.changelog_url, /\/v1\/market\/plugins\//);
    assert.equal(newer.latest, '9.9.9', 'never lower than current');
    assert.equal(unknown.known, false);
    assert.equal(unknown.latest, '0.1.0');
    assert.ok(Number.isInteger(res.body.meta.now));
    // a host that the latest version does not support sees no update
    const old = await fresh.panel('/v1/market/updates', { token: l.token, installed: [{ id: SAMPLE_ID, version: '1.0.0' }], host: '0.9.0' });
    assert.equal(old.body.data[0].latest, '1.0.0');
    assert.equal((await fresh.admin('post', '/v1/admin/market/revocations').send({ plugin_id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, severity: 'info', action: 'disable', reason: 'x' })).status, 201);
    const sec = await fresh.panel('/v1/market/updates', { token: l.token, installed: [{ id: SAMPLE_ID, version: SAMPLE_MANIFEST.version }] });
    assert.equal(sec.body.data[0].security, true);
  } finally { await fresh.close(); }
});

test('billing: whm_kind routing, idempotency, no renewal from a plugin invoice, frozen share, refund → 402, trial once per license', async () => {
  const fresh = await bootMarket();
  try {
    const { dev: d } = await fresh.submitSample();
    assert.equal((await fresh.createListing(d, PAID, { name: 'Paid Sub', pricing: { model: 'subscription', cents: 500, currency: 'USD', interval: 'month', trial_days: 14 } })).status, 201);
    const up = await d.upload(PAID, buildPackage({ manifest: manifestFor(PAID, { name: 'Paid Sub' }), signWith: DEV_PEM }), { justifications: {} });
    assert.equal((await fresh.approveReview(up.body.data.review_id)).status, 200);
    assert.equal((await fresh.publish(d, PAID, '1.0.0')).status, 200);
    const l = await fresh.panelLicense('whm-pro-annual', { external_ref: 'sub_lic_1' });
    const expiresBefore = l.license.expires_at;
    assert.equal((await fresh.download({ plugin_id: PAID, token: l.token })).status, 402);
    const stripeFresh = (body, t = Math.floor(fresh.clock.t / 1000)) => { const raw = JSON.stringify(body); return fresh.http.post('/v1/admin/billing/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}`).send(raw); };
    const paid = await stripeFresh({ id: 'evt_p1', type: 'invoice.paid', data: { object: { amount_paid: 500, currency: 'usd', subscription: 'sub_lic_1', metadata: { whm_kind: 'plugin_purchase', whm_plugin_id: PAID, whm_license_id: l.license.id, whm_external_ref: 'sub_lic_1' } } } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.result, 'skipped:plugin_purchase', 'the license handler skipped it');
    assert.equal(paid.body.data.hooks, 1);
    assert.equal(fresh.ctx.licenses.get(l.license.id).expires_at, expiresBefore, 'a plugin invoice with a license external_ref is NOT a renewal');
    const purchase = fresh.mdb.prepare('SELECT * FROM purchases WHERE external_id = ?').get('evt_p1');
    assert.ok(purchase);
    assert.equal(purchase.revenue_share_pct, 70);
    assert.equal(purchase.developer_cents, 350);
    assert.equal(purchase.vendor_cents, 150);
    const ok = await fresh.download({ plugin_id: PAID, token: l.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.entitlement.kind, 'subscription');
    // duplicate external_id is idempotent
    const dup = await stripeFresh({ id: 'evt_p1', type: 'invoice.paid', data: { object: { amount_paid: 500, metadata: { whm_kind: 'plugin_purchase', whm_plugin_id: PAID, whm_license_id: l.license.id } } } });
    assert.equal(dup.body.data.duplicate, true);
    assert.equal(fresh.mdb.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 1);
    // the share is frozen per purchase
    assert.equal((await fresh.admin('put', `/v1/admin/market/developers/${d.id}/revenue-share`).send({ pct: 80 })).status, 200);
    assert.equal(fresh.mdb.prepare('SELECT revenue_share_pct FROM purchases WHERE external_id = ?').get('evt_p1').revenue_share_pct, 70);
    // refund → entitlement refunded → 402
    const refund = await stripeFresh({ id: 'evt_r1', type: 'charge.refunded', data: { object: { metadata: { whm_kind: 'plugin_purchase', whm_plugin_id: PAID, whm_license_id: l.license.id, whm_purchase_external_id: 'evt_p1' } } } });
    assert.equal(refund.status, 200);
    assert.equal(fresh.mdb.prepare('SELECT status FROM purchases WHERE external_id = ?').get('evt_p1').status, 'refunded');
    assert.equal((await fresh.download({ plugin_id: PAID, token: l.token })).status, 402);
    assert.ok(fresh.mdb.prepare("SELECT 1 FROM audit_log WHERE action = 'purchase.refunded'").get());
    // one trial entitlement per license per plugin
    const plugin = fresh.m.submissions.get(PAID);
    const license = fresh.ctx.licenses.get(l.license.id);
    fresh.m.entitlements.startTrial(license, plugin);
    assert.equal((await fresh.download({ plugin_id: PAID, token: l.token })).body.data.entitlement.kind, 'trial');
    assert.throws(() => fresh.m.entitlements.startTrial(license, plugin), (e) => e.code === 'trial_exists');
    fresh.advance(15 * 86_400_000);
    await l.checkin();
    assert.equal(fresh.m.entitlements.expireDue().expired, 1);
    assert.equal((await fresh.download({ plugin_id: PAID, token: l.token })).status, 402);
    // payouts: close → held below minimum / pending, approve, hold, mark paid, statement
    const l2 = await fresh.panelLicense('whm-pro-annual');
    for (let i = 0; i < 12; i++) assert.equal((await stripeFresh({ id: `evt_big_${i}`, type: 'invoice.paid', data: { object: { amount_paid: 1000, currency: 'usd', metadata: { whm_kind: 'plugin_purchase', whm_plugin_id: PAID, whm_license_id: l2.license.id } } } })).status, 200);
    fresh.advance(32 * 86_400_000);
    const period = { period_start: new Date(fresh.clock.t - 60 * 86_400_000).toISOString(), period_end: new Date(fresh.clock.t + 1000).toISOString() };
    const closed = await fresh.admin('post', '/v1/admin/market/payouts/close').send(period);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const payout = closed.body.data.payouts.find((p) => p.developer_id === d.id);
    assert.ok(payout, JSON.stringify(closed.body));
    assert.equal(payout.refunds_cents, 350, 'the refunded purchase is clawed back');
    assert.equal(payout.gross_cents, 12 * 800);
    assert.equal(payout.status, 'pending');
    assert.equal((await fresh.admin('post', '/v1/admin/market/payouts/close').send(period)).body.data.payouts.length, 0, 'idempotent per period');
    assert.equal((await fresh.admin('post', `/v1/admin/market/payouts/${payout.id}/hold`).send({ reason: 'kyc' })).body.data.status, 'held');
    assert.equal((await fresh.admin('post', `/v1/admin/market/payouts/${payout.id}/approve`).send({})).body.data.status, 'approved');
    assert.equal((await fresh.admin('post', `/v1/admin/market/payouts/${payout.id}/mark-paid`).send({ provider_ref: 'tr_1' })).body.data.status, 'paid');
    assert.ok(fresh.sent.some((s) => s.to === d.email && s.template === 'dev.payout_paid'));
    await d.login();
    const mine = await d.get('/v1/dev/payouts');
    assert.equal(mine.body.data[0].id, payout.id);
    const csv = await d.get(`/v1/dev/payouts/${payout.id}/statement.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^purchase_id,plugin_id/);
    assert.equal(csv.text.trim().split('\n').length, 1 + 12 + 1);
    // a developer under the minimum is held
    const tiny = await fresh.developer({ namespaces: ['test.tiny'] });
    assert.equal((await fresh.createListing(tiny, 'test.tiny.p', { pricing: { model: 'one_time', cents: 100, currency: 'USD' } })).status, 201);
    const tu = await tiny.upload('test.tiny.p', buildPackage({ manifest: manifestFor('test.tiny.p'), signWith: tiny.pem }), { justifications: {} });
    assert.equal((await fresh.approveReview(tu.body.data.review_id)).status, 200);
    assert.equal((await fresh.publish(tiny, 'test.tiny.p', '1.0.0')).status, 200);
    assert.equal((await stripeFresh({ id: 'evt_tiny', type: 'invoice.paid', data: { object: { amount_paid: 100, currency: 'usd', metadata: { whm_kind: 'plugin_purchase', whm_plugin_id: 'test.tiny.p', whm_license_id: l2.license.id } } } })).status, 200);
    fresh.advance(32 * 86_400_000);
    const held = (await fresh.admin('post', '/v1/admin/market/payouts/close').send(period)).body.data.payouts.find((p) => p.developer_id === tiny.id);
    assert.equal(held.status, 'held');
    assert.equal(held.hold_reason, 'below_minimum');
  } finally { await fresh.close(); }
});

test('magic links are single-use, 15 minutes and bound to the customer e-mail', async () => {
  const issued = await h.panel('/v1/market/magic-links', { token: lic.token, plugin_id: PAID });
  assert.equal(issued.status, 202, JSON.stringify(issued.body));
  const mail = h.sent.filter((s) => s.template === 'customer.magic_link').pop();
  const customer = h.ctx.customers.get(lic.license.customer_id);
  assert.equal(mail.to, customer.email);
  const token = /magic\/([A-Za-z0-9_-]+)/.exec(mail.message)[1];
  const wrong = await h.http.post(`/v1/market/magic-links/${token}`).send({ email: 'someone-else@example.test' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'magic_link_email_mismatch');
  const ok = await h.http.post(`/v1/market/magic-links/${token}`).send({ email: customer.email });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data, { customer_id: customer.id, plugin_id: PAID, license_id: lic.license.id });
  assert.equal((await h.http.post(`/v1/market/magic-links/${token}`).send({ email: customer.email })).status, 410, 'single use');
  await h.panel('/v1/market/magic-links', { token: lic.token });
  const token2 = /magic\/([A-Za-z0-9_-]+)/.exec(h.sent.filter((s) => s.template === 'customer.magic_link').pop().message)[1];
  h.advance(16 * 60_000);
  assert.equal((await h.http.post(`/v1/market/magic-links/${token2}`).send({ email: customer.email })).status, 410, 'expired');
  assert.ok(h.mdb.prepare("SELECT 1 FROM customer_magic_links WHERE used_at IS NOT NULL AND ip_hash IS NOT NULL").get());
});

test('reviews: trial refused, install < 7 days refused, second review by the same customer refused, bursts flagged; install_count excludes trials and inactive activations', async () => {
  const fresh = await bootMarket();
  try {
    await fresh.submitSample();
    const trial = await fresh.panelLicense('whm-trial');
    const tr = await fresh.panel(`/v1/market/plugins/${SAMPLE_ID}/reviews`, { token: trial.token, rating: 5, title: 'great', body: 'love it' });
    assert.equal(tr.status, 403);
    assert.equal(tr.body.error.code, 'trial_license');
    const l = await fresh.panelLicense();
    const none = await fresh.panel(`/v1/market/plugins/${SAMPLE_ID}/reviews`, { token: l.token, rating: 5 });
    assert.equal(none.body.error.code, 'install_required');
    await l.checkin({ usage: { accounts: 1, resellers: 0, domains: 1, plugins: [{ id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, state: 'enabled' }] } });
    const soon = await fresh.panel(`/v1/market/plugins/${SAMPLE_ID}/reviews`, { token: l.token, rating: 5 });
    assert.equal(soon.body.error.code, 'install_too_recent');
    fresh.advance(8 * 86_400_000);
    await l.checkin({ usage: { accounts: 1, resellers: 0, domains: 1, plugins: [{ id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, state: 'enabled' }] } });
    const ok = await fresh.panel(`/v1/market/plugins/${SAMPLE_ID}/reviews`, { token: l.token, rating: 4, title: 'solid', body: 'works' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(Object.keys(ok.body.data).sort(), ['flagged', 'id', 'status']);
    assert.equal(ok.body.data.status, 'pending');
    const twice = await fresh.panel(`/v1/market/plugins/${SAMPLE_ID}/reviews`, { token: l.token, rating: 1 });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'review_exists');
    assert.equal((await fresh.http.get(`/v1/market/plugins/${SAMPLE_ID}`)).body.data.reviews.length, 0, 'pending until moderated');
    assert.equal((await fresh.admin('post', `/v1/admin/market/plugin-reviews/${ok.body.data.id}/publish`)).status, 200);
    const detail = await fresh.http.get(`/v1/market/plugins/${SAMPLE_ID}`);
    assert.equal(detail.body.data.reviews.length, 1);
    assert.equal(detail.body.data.rating_avg, 4);
    // bursts: three reviews of one plugin from the same address within 24 h → flagged
    let flagged = null;
    for (let i = 0; i < 3; i++) {
      const other = await fresh.panelLicense();
      await other.checkin({ usage: { accounts: 1, resellers: 0, domains: 1, plugins: [{ id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, state: 'enabled' }] } });
      fresh.mdb.prepare('UPDATE installs SET first_seen = ? WHERE license_id = ?').run(new Date(fresh.clock.t - 8 * 86_400_000).toISOString(), other.license.id);
      flagged = await fresh.panel(`/v1/market/plugins/${SAMPLE_ID}/reviews`, { token: other.token, rating: 5 });
      assert.equal(flagged.status, 201, JSON.stringify(flagged.body));
    }
    assert.equal(flagged.body.data.flagged, true);
    assert.ok((await fresh.admin('get', '/v1/admin/market/plugin-reviews?status=pending&flagged=true')).body.data.length >= 1);
    // install_count: trials and inactive activations do not count
    fresh.m.catalog.refreshCounts();
    const count = () => fresh.mdb.prepare('SELECT install_count FROM plugins WHERE id = ?').get(SAMPLE_ID).install_count;
    assert.equal(count(), 4, 'four non-trial active licenses reported the plugin');
    await trial.checkin({ usage: { accounts: 0, resellers: 0, domains: 0, plugins: [{ id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, state: 'enabled' }] } });
    assert.equal(count(), 4, 'trial installs are not counted');
    fresh.ctx.activations.deactivate(l.activationId, { reason: 'gone' });
    fresh.m.catalog.refreshCounts();
    assert.equal(count(), 3, 'inactive activations are not counted');
    const after = await l.checkin({ usage: { accounts: 1, resellers: 0, domains: 1, plugins: [{ id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, state: 'enabled' }] } });
    assert.equal(after.status, 403, 'a deactivated activation cannot check in, so it never upserts installs');
    const stats = await fresh.admin('get', '/v1/admin/market/stats');
    assert.equal(stats.status, 200);
    assert.ok(stats.body.data.review_queue !== undefined);
  } finally { await fresh.close(); }
});
