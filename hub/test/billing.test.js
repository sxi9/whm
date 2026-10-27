import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootHub, DAY } from './support.js';
import { addMonths } from '../license/services/licenses.js';
import { verifyProviderSignature, normalizeEvent } from '../license/services/billing.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

function stripe(body, secret = 'whsec_test', t = Math.floor(h.clock.t / 1000)) {
  const raw = JSON.stringify(body);
  return h.http.post('/v1/admin/billing/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`).send(raw);
}
function whmcs(body, secret = 'whmcs_test') {
  const raw = JSON.stringify(body);
  return h.http.post('/v1/admin/billing/webhooks/whmcs').set('Content-Type', 'application/json').set('X-WHMCS-Signature', crypto.createHmac('sha256', secret).update(raw).digest('hex')).send(raw);
}
function paddle(body, secret = 'pdl_test', t = Math.floor(h.clock.t / 1000)) {
  const raw = JSON.stringify(body);
  return h.http.post('/v1/admin/billing/webhooks/paddle').set('Content-Type', 'application/json').set('Paddle-Signature', `ts=${t};h1=${crypto.createHmac('sha256', secret).update(`${t}:${raw}`).digest('hex')}`).send(raw);
}

test('signature verification per provider', () => {
  const raw = '{"a":1}';
  const t = 1700000000;
  const sig = crypto.createHmac('sha256', 's').update(`${t}.${raw}`).digest('hex');
  assert.equal(verifyProviderSignature('stripe', raw, { 'stripe-signature': `t=${t},v1=${sig}` }, 's', { now: t }), true);
  assert.equal(verifyProviderSignature('stripe', raw, { 'stripe-signature': `t=${t},v1=${sig}` }, 's', { now: t + 400 }), false);
  assert.equal(verifyProviderSignature('stripe', raw, { 'stripe-signature': `t=${t},v1=${sig}` }, 'other', { now: t }), false);
  assert.equal(verifyProviderSignature('stripe', raw, {}, 's', { now: t }), false);
  assert.equal(verifyProviderSignature('whmcs', raw, { 'x-whmcs-signature': crypto.createHmac('sha256', 's').update(raw).digest('hex') }, 's'), true);
  assert.equal(verifyProviderSignature('paddle', raw, { 'paddle-signature': `ts=${t};h1=${crypto.createHmac('sha256', 's').update(`${t}:${raw}`).digest('hex')}` }, 's', { now: t }), true);
  assert.equal(verifyProviderSignature('stripe', raw, { 'stripe-signature': 'x' }, undefined), false, 'no secret configured → never valid');
});

test('an unsigned or badly signed webhook is 401 and leaves no billing row', async () => {
  const res = await h.http.post('/v1/admin/billing/webhooks/stripe').set('Content-Type', 'application/json').send('{"id":"evt_x","type":"invoice.paid"}');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_signature');
  assert.equal((await stripe({ id: 'evt_bad', type: 'invoice.paid' }, 'wrong')).status, 401);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM billing_events').get().n, 0);
  assert.equal((await h.http.post('/v1/admin/billing/webhooks/square').send({})).status, 422);
});

test('stripe invoice.paid renews by external_ref; duplicates are idempotent on external_id', async () => {
  const { license } = h.issue('whm-pro-monthly', { external_ref: 'sub_123' });
  const before = license.expires_at;
  const res = await stripe({ id: 'evt_1', type: 'invoice.paid', data: { object: { subscription: 'sub_123', metadata: { whm_term_months: '1' } } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.duplicate, false);
  assert.match(res.body.data.result, /^renew:/);
  assert.equal(h.ctx.licenses.get(license.id).expires_at, addMonths(before, 1));
  const again = await stripe({ id: 'evt_1', type: 'invoice.paid', data: { object: { subscription: 'sub_123' } } });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.duplicate, true);
  assert.equal(h.ctx.licenses.get(license.id).expires_at, addMonths(before, 1), 'no double renewal');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE external_id = 'evt_1'").get().n, 1);
});

test('each source maps its events to renew / suspend (after grace) / revoke', async () => {
  const sub = h.issue('whm-solo-monthly', { external_ref: 'whmcs:77' });
  assert.equal((await whmcs({ event: 'InvoiceCancelled', invoiceid: 9001, serviceid: 77 })).status, 200);
  let lic = h.ctx.licenses.get(sub.license.id);
  assert.equal(lic.status, 'active', '§16.7: a cancellation suspends after the grace period, not at once');
  assert.equal(new Date(lic.suspend_after).getTime(), new Date(lic.expires_at).getTime() + lic.grace_days * DAY);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'license.suspend_scheduled' AND target = ?").get(lic.id).n, 1);
  // a payment before the term ends cancels the pending suspension
  assert.equal((await whmcs({ event: 'InvoicePaid', invoiceid: 9002, serviceid: 77 })).body.data.result.startsWith('renew:'), true);
  lic = h.ctx.licenses.get(sub.license.id);
  assert.equal(lic.suspend_after, null);
  assert.equal(lic.status, 'active');
  assert.equal((await whmcs({ event: 'InvoiceCancelled', invoiceid: 9004, serviceid: 77 })).status, 200);
  lic = h.ctx.licenses.get(sub.license.id);
  const t0 = h.clock.t;
  h.clock.t = new Date(lic.suspend_after).getTime() - 1000;
  assert.deepEqual((await h.ctx.scheduler.run('expire-licenses')).result.suspended, 0, 'not yet due');
  assert.equal(h.ctx.licenses.get(sub.license.id).status, 'active');
  h.clock.t = new Date(lic.suspend_after).getTime() + 1000;
  assert.equal((await h.ctx.scheduler.run('expire-licenses')).result.suspended, 1);
  assert.equal(h.ctx.licenses.get(sub.license.id).status, 'suspended');
  assert.equal(h.ctx.licenses.get(sub.license.id).suspend_after, null);
  h.clock.t = t0;
  assert.equal((await whmcs({ event: 'InvoicePaid', invoiceid: 9005, serviceid: 77 })).body.data.result.startsWith('renew:'), true);
  assert.equal(h.ctx.licenses.get(sub.license.id).status, 'suspended', 'a renewal does not lift a suspension by itself');
  assert.equal((await whmcs({ event: 'InvoiceRefunded', invoiceid: 9003, serviceid: 77 })).status, 200);
  assert.equal(h.ctx.licenses.get(sub.license.id).status, 'revoked');
  const pad = h.issue('whm-pro-annual', { external_ref: 'pdl_sub_1' });
  assert.equal((await paddle({ event_id: 'ntf_1', event_type: 'subscription.canceled', data: { subscription_id: 'pdl_sub_1' } })).status, 200);
  assert.equal(h.ctx.licenses.get(pad.license.id).status, 'active');
  assert.ok(h.ctx.licenses.get(pad.license.id).suspend_after > h.ctx.licenses.get(pad.license.id).expires_at);
  const lapsed = h.issue('whm-solo-monthly', { external_ref: 'pdl_sub_old', starts_at: new Date(h.clock.t - 60 * DAY).toISOString() });
  assert.equal(h.ctx.licenses.statusAt(h.ctx.licenses.get(lapsed.license.id)), 'expired');
  assert.equal((await paddle({ event_id: 'ntf_old', event_type: 'subscription.deleted', data: { subscription_id: 'pdl_sub_old' } })).status, 200);
  assert.equal(h.ctx.licenses.get(lapsed.license.id).status, 'suspended', 'grace already over → suspended at once');
  assert.equal((await paddle({ event_id: 'ntf_2', event_type: 'adjustment.created', data: { subscription_id: 'pdl_sub_1' } })).status, 200);
  assert.equal(h.ctx.licenses.get(pad.license.id).status, 'revoked');
  const st = h.issue('whm-pro-annual', { external_ref: 'cus_55' });
  await stripe({ id: 'evt_dispute', type: 'charge.dispute.created', data: { object: { customer: 'cus_55' } } });
  assert.equal(h.ctx.licenses.get(st.license.id).status, 'revoked');
  const unknown = await stripe({ id: 'evt_unknown', type: 'customer.updated', data: { object: { customer: 'cus_55' } } });
  assert.equal(unknown.body.data.result, 'ignored:unknown_event');
  const noLicense = await stripe({ id: 'evt_nolic', type: 'invoice.paid', data: { object: { subscription: 'sub_none' } } });
  assert.equal(noLicense.body.data.result, 'ignored:no_license');
});

test('whm_kind routing: plugin_purchase events never touch the license and reach the billing hooks', async () => {
  const seen = [];
  h.ctx.hooks.billing.push((source, event, meta) => { seen.push({ source, type: event.event_type, kind: meta?.whm_kind }); return { handled: meta?.whm_kind === 'plugin_purchase' }; });
  const { license } = h.issue('whm-pro-monthly', { external_ref: 'sub_plugin' });
  const before = h.ctx.licenses.get(license.id).expires_at;
  const res = await stripe({ id: 'evt_plugin', type: 'invoice.paid', data: { object: { subscription: 'sub_plugin', metadata: { whm_kind: 'plugin_purchase', whm_plugin_id: 'net.acme.cache-boost', whm_external_ref: 'sub_plugin' } } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.result, 'skipped:plugin_purchase');
  assert.equal(res.body.data.whm_kind, 'plugin_purchase');
  assert.equal(h.ctx.licenses.get(license.id).expires_at, before, 'not a renewal');
  const lic = await stripe({ id: 'evt_license', type: 'invoice.paid', data: { object: { subscription: 'sub_plugin', metadata: { whm_kind: 'license' } } } });
  assert.match(lic.body.data.result, /^renew:/);
  assert.deepEqual(seen.map((s) => s.kind), ['plugin_purchase', 'license']);
  assert.equal(seen[0].source, 'stripe');
  const dup = await stripe({ id: 'evt_plugin', type: 'invoice.paid', data: { object: { metadata: { whm_kind: 'plugin_purchase' } } } });
  assert.equal(dup.body.data.duplicate, true);
  assert.equal(seen.length, 2, 'hooks do not run for duplicates');
  h.ctx.hooks.billing.length = 0;
});

test('normalizeEvent extracts ids, refs and metadata per provider', () => {
  assert.deepEqual(normalizeEvent('stripe', { id: 'evt_9', type: 'invoice.paid', data: { object: { subscription: 'sub_9', metadata: { whm_kind: 'license', whm_term_months: '12' } } } }), { external_id: 'evt_9', event_type: 'invoice.paid', external_ref: 'sub_9', meta: { whm_kind: 'license', whm_term_months: '12' }, term_months: 12 });
  assert.equal(normalizeEvent('whmcs', { event: 'InvoicePaid', invoiceid: 5, serviceid: 8 }).external_id, 'InvoicePaid:5');
  assert.equal(normalizeEvent('whmcs', { event: 'InvoicePaid', invoiceid: 5, serviceid: 8 }).external_ref, 'whmcs:8');
  assert.equal(normalizeEvent('paddle', { event_id: 'e', event_type: 't', data: { id: 'txn', custom_data: { whm_external_ref: 'lic-ref' } } }).external_ref, 'lic-ref');
  assert.throws(() => normalizeEvent('square', {}), /Unknown billing source/);
});

test('the billing event log is readable by admins and the audit log records every event', async () => {
  const list = await h.admin('get', '/v1/admin/billing/events?source=stripe');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 3);
  assert.ok(list.body.data.every((e) => e.source === 'stripe' && !('payload_json' in e)));
  const audit = await h.admin('get', '/v1/admin/audit?action=billing.event');
  assert.ok(audit.body.data.length >= list.body.data.length);
  void DAY;
});
