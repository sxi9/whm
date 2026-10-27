import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootMarket, buildPackage, manifestFor, pack, KIDS, DEV_PEM, SAMPLE_ID, SAMPLE_MANIFEST } from './market-support.js';

let h; let dev; let lic;
const PAID = 'net.whm.paid-thing';
before(async () => {
  h = await bootMarket();
  ({ dev } = await h.submitSample());
  assert.equal((await h.createListing(dev, PAID, { name: 'Paid Thing', pricing: { model: 'one_time', cents: 2900, currency: 'USD' }, category_id: 'cat_backups' })).status, 201);
  const up = await dev.upload(PAID, buildPackage({ manifest: manifestFor(PAID, { name: 'Paid Thing' }), signWith: DEV_PEM }), { justifications: {} });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await h.approveReview(up.body.data.review_id)).status, 200);
  assert.equal((await h.publish(dev, PAID, '1.0.0')).status, 200);
  lic = await h.panelLicense('whm-pro-annual');
});
after(() => h.close());

test('catalog: search, category filter, pagination, detail with compatibility, versions, categories, keys', async () => {
  const all = await h.http.get('/v1/market/catalog');
  assert.equal(all.status, 200);
  assert.equal(all.body.meta.total, 2);
  assert.ok(all.headers.etag);
  assert.equal((await h.http.get('/v1/market/catalog').set('If-None-Match', all.headers.etag)).status, 304);
  const sample = all.body.data.find((p) => p.id === SAMPLE_ID);
  assert.deepEqual(Object.keys(sample).sort(), ['category', 'developer', 'featured', 'icon_url', 'id', 'install_count', 'latest', 'name', 'pricing', 'rating_avg', 'rating_count', 'slug', 'summary', 'updated_at']);
  assert.equal(sample.developer.verified, true);
  assert.equal(sample.latest.version, SAMPLE_MANIFEST.version);
  assert.equal((await h.http.get('/v1/market/catalog?q=paid')).body.meta.total, 1);
  assert.equal((await h.http.get('/v1/market/catalog?category=backups')).body.data[0].id, PAID);
  const page = await h.http.get('/v1/market/catalog?pageSize=1&page=2&sort=name&dir=asc');
  assert.equal(page.body.data.length, 1);
  assert.deepEqual(page.body.meta, { page: 2, pageSize: 1, total: 2 });
  assert.equal((await h.http.get('/v1/market/catalog?sort=bogus')).status, 422);
  const cats = await h.http.get('/v1/market/categories');
  assert.equal(cats.body.data.find((c) => c.slug === 'backups').count, 1);
  const detail = await h.http.get(`/v1/market/plugins/${SAMPLE_ID}?host=1.0.0`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.compatibility.compatible, true);
  assert.equal((await h.http.get(`/v1/market/plugins/${SAMPLE_ID}?host=0.9.0`)).body.data.compatibility.compatible, false);
  assert.ok(detail.body.data.permissions.find((p) => p.scope === 'accounts:write').description);
  assert.ok(detail.body.data.permissions.every((p) => p.justification));
  assert.equal(detail.body.data.versions.stable.kid, KIDS.pluginA);
  const versions = await h.http.get(`/v1/market/plugins/${SAMPLE_ID}/versions`);
  assert.deepEqual(Object.keys(versions.body.data[0]).sort(), ['channel', 'engines_whm', 'kid', 'package_bytes', 'package_sha256', 'permissions', 'published_at', 'version']);
  assert.equal((await h.http.get('/v1/market/plugins/net.whm.nope')).status, 404);
  const keys = await h.http.get('/v1/market/keys');
  assert.deepEqual(Object.fromEntries(keys.body.data.keys.map((k) => [k.kid, `${k.purpose}:${k.status}`])), { [KIDS.pluginA]: 'plugin:active', [KIDS.pluginB]: 'plugin:pending' });
});

test('free download: signed descriptor, URL bound to the activation, single use, expiry, downloads row', async () => {
  const res = await h.download({ plugin_id: SAMPLE_ID, token: lic.token, fingerprint: lic.server.fingerprint, panel_version: '1.0.0', host_api: '1.0.0' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.kid, KIDS.pluginA);
  assert.equal(d.version, SAMPLE_MANIFEST.version);
  assert.deepEqual(d.entitlement, { kind: 'free', status: 'active' });
  assert.equal(res.body.meta.nonce, res.whmNonce);
  const row = h.mdb.prepare('SELECT * FROM downloads ORDER BY ts DESC LIMIT 1').get();
  assert.equal(row.license_id, lic.license.id);
  assert.equal(row.activation_id, lic.activationId);
  assert.equal(row.fetched_at, null);
  const u = new URL(d.url);
  assert.equal(u.origin, 'https://hub.test');
  // altered dl id or exp → 403; wrong sig → 403
  const tamperedId = await h.http.get(`${u.pathname.replace(/[A-Z0-9]$/, (c) => (c === 'A' ? 'B' : 'A'))}${u.search}`);
  assert.equal(tamperedId.status, 403);
  const exp = Number(u.searchParams.get('exp'));
  assert.equal((await h.http.get(`${u.pathname}?exp=${exp + 1}&sig=${u.searchParams.get('sig')}`)).body.error.code, 'download_signature_invalid');
  const bytes = await h.fetchPackage(d.url);
  assert.equal(bytes.status, 200, bytes.text);
  assert.equal(bytes.headers['x-checksum-sha256'], d.sha256);
  assert.equal(pack.sha256(bytes.body), d.sha256);
  assert.equal(bytes.body.length, d.bytes);
  const again = await h.fetchPackage(d.url);
  assert.equal(again.status, 410, 'single use');
  assert.equal(JSON.parse(again.body.toString()).error.code, 'download_consumed');
  assert.ok(h.mdb.prepare('SELECT fetched_at FROM downloads WHERE id = ?').get(row.id).fetched_at);
  // expiry
  const res2 = await h.download({ plugin_id: SAMPLE_ID, token: lic.token, fingerprint: lic.server.fingerprint });
  h.advance(16 * 60_000);
  const expired = await h.fetchPackage(res2.body.data.url);
  assert.equal(expired.status, 410);
  assert.equal(JSON.parse(expired.body.toString()).error.code, 'download_expired');
  assert.ok(h.m.distribution.purge().purged >= 0);
  // explicit version and unknown version
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, token: lic.token })).status, 200);
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, version: '9.9.9', token: lic.token })).status, 404);
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, token: lic.token, host_api: '0.5.0' })).body.error.code, 'incompatible_host');
});

test('paid plugin: 402 with pricing + buy_url, marketplace_paid 403, trial free-only, entitlement grant → 200, refund → 402', async () => {
  const paid = await h.download({ plugin_id: PAID, token: lic.token });
  assert.equal(paid.status, 402);
  assert.equal(paid.body.error.code, 'entitlement_required');
  assert.deepEqual(paid.body.error.pricing, { model: 'one_time', cents: 2900, currency: 'USD' });
  assert.match(paid.body.error.buy_url, /^https:\/\/hub\.test\/buy\//);
  const solo = await h.panelLicense('whm-solo-annual');
  const feat = await h.download({ plugin_id: PAID, token: solo.token });
  assert.equal(feat.status, 403);
  assert.equal(feat.body.error.code, 'feature_required');
  assert.equal(feat.body.error.feature, 'marketplace_paid');
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, token: solo.token })).status, 200, 'free plugins are fine on solo');
  const trial = await h.panelLicense('whm-trial');
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, token: trial.token })).status, 200);
  assert.equal((await h.download({ plugin_id: PAID, token: trial.token })).body.error.code, 'feature_required', 'trials download free plugins only');
  const grant = await h.admin('post', '/v1/admin/market/entitlements').send({ license_id: lic.license.id, plugin_id: PAID, kind: 'one_time' });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const ok = await h.download({ plugin_id: PAID, token: lic.token });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data.entitlement, { kind: 'one_time', status: 'active' });
  assert.equal((await h.admin('post', `/v1/admin/market/entitlements/${grant.body.data.id}/cancel`).send({})).status, 200);
  assert.equal((await h.download({ plugin_id: PAID, token: lic.token })).status, 402);
  // bundled with an edition
  assert.equal((await h.admin('patch', `/v1/admin/market/plugins/${PAID}`).send({ bundled_editions: ['pro'] })).status, 200);
  assert.deepEqual((await h.download({ plugin_id: PAID, token: lic.token })).body.data.entitlement, { kind: 'one_time', status: 'active' });
  assert.equal((await h.admin('patch', `/v1/admin/market/plugins/${PAID}`).send({ bundled_editions: [] })).status, 200);
});

test('live rows win over a valid token: revoked license, transferred activation, fingerprint mismatch → 403', async () => {
  const a = await h.panelLicense('whm-pro-annual');
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, token: a.token, fingerprint: a.server.fingerprint })).status, 200);
  const wrongFp = await h.download({ plugin_id: SAMPLE_ID, token: a.token, fingerprint: h.fp('other').fingerprint });
  assert.equal(wrongFp.status, 403);
  assert.equal(wrongFp.body.error.code, 'fingerprint_mismatch');
  h.ctx.activations.deactivate(a.activationId, { reason: 'moved', status: 'transferred' });
  const transferred = await h.download({ plugin_id: SAMPLE_ID, token: a.token });
  assert.equal(transferred.status, 403);
  assert.equal(transferred.body.error.code, 'activation_inactive');
  const b = await h.panelLicense('whm-pro-annual');
  h.ctx.licenses.revoke(b.license.id, { reason: 'chargeback' });
  assert.ok(h.ctx.licenses.verifyToken(b.token).ok, 'the token itself is still valid');
  const revoked = await h.download({ plugin_id: SAMPLE_ID, token: b.token });
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.error.code, 'license_inactive');
  const bad = await h.download({ plugin_id: SAMPLE_ID, token: `${b.token.slice(0, -2)}AA` });
  assert.equal(bad.status, 401);
});

test('yanked → 410 for a new license but 200 for a license with an installs row; revoked → 410 always; download rate limit', async () => {
  const yank = await dev.post(`/v1/dev/plugins/${SAMPLE_ID}/versions/${SAMPLE_MANIFEST.version}/yank`, { reason: 'bug' });
  assert.equal(yank.status, 200, JSON.stringify(yank.body));
  assert.equal((await h.http.get('/v1/market/catalog')).body.data.some((p) => p.id === SAMPLE_ID), false, 'hidden from the catalog');
  const fresh = await h.panelLicense('whm-pro-annual');
  const y = await h.download({ plugin_id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, token: fresh.token });
  assert.equal(y.status, 410);
  assert.equal(y.body.error.code, 'version_yanked');
  assert.equal(y.body.error.reason, 'bug');
  // a license that reported the install through check-in may re-download
  const ci = await lic.checkin({ usage: { accounts: 1, resellers: 0, domains: 1, plugins: [{ id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, state: 'enabled' }] } });
  assert.equal(ci.status, 200, JSON.stringify(ci.body));
  assert.equal(h.mdb.prepare('SELECT COUNT(*) AS n FROM installs WHERE license_id = ? AND plugin_id = ?').get(lic.license.id, SAMPLE_ID).n, 1);
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, token: lic.token })).status, 200);
  const rv = await h.admin('post', '/v1/admin/market/revocations').send({ plugin_id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, severity: 'warning', action: 'disable', reason: 'vuln' });
  assert.equal(rv.status, 201, JSON.stringify(rv.body));
  const r = await h.download({ plugin_id: SAMPLE_ID, version: SAMPLE_MANIFEST.version, token: lic.token });
  assert.equal(r.status, 410);
  assert.equal(r.body.error.code, 'version_revoked');
  assert.equal(r.body.error.reason, 'vuln');
  const limited = await bootMarket({ config: { marketplace: { rate_limits: { download: { max: 2 } } } } });
  try {
    await limited.submitSample();
    const l = await limited.panelLicense();
    for (let i = 0; i < 2; i++) assert.equal((await limited.download({ plugin_id: SAMPLE_ID, token: l.token })).status, 200);
    const third = await limited.download({ plugin_id: SAMPLE_ID, token: l.token });
    assert.equal(third.status, 429);
    assert.equal(third.body.meta.nonce, third.whmNonce, 'the 429 is signed and echoes the nonce');
  } finally { await limited.close(); }
});
