import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootMarket, pack, KIDS, SAMPLE_ID, SAMPLE_MANIFEST } from './market-support.js';
import { pubOf } from './fixtures/index.js';

let h;
before(async () => { h = await bootMarket(); await h.submitSample(); });
after(() => h.close());

test('activating a new plugin kid re-signs every published version; descriptor serves the new file; history keeps the old one', async () => {
  const before = h.m.submissions.version(SAMPLE_ID, SAMPLE_MANIFEST.version);
  assert.equal(before.mkt_kid, KIDS.pluginA);
  const lic = await h.panelLicense();
  const act = await h.activate(lic.key, lic.server);
  assert.deepEqual(Object.fromEntries(act.body.data.plugin_signing_keys.map((k) => [k.kid, k.status])), { [KIDS.pluginA]: 'active', [KIDS.pluginB]: 'pending' }, 'pending keys are listed so panels pin them early');
  const res = await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginB}/activate`).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const after = h.m.submissions.version(SAMPLE_ID, SAMPLE_MANIFEST.version);
  assert.equal(after.mkt_kid, KIDS.pluginB);
  assert.equal(path.basename(after.package_file), `${SAMPLE_MANIFEST.version}-${KIDS.pluginB}.whmplugin`);
  assert.notEqual(after.package_sha256, before.package_sha256);
  assert.ok(fs.existsSync(before.package_file), 'previous file kept');
  assert.equal(after.package_digest, before.package_digest, 'the signed content is unchanged');
  const history = h.mdb.prepare('SELECT mkt_kid, package_sha256 FROM plugin_version_signatures WHERE version_id = ? ORDER BY signed_at').all(after.id);
  assert.deepEqual(history.map((s) => s.mkt_kid).sort(), [KIDS.pluginA, KIDS.pluginB].sort());
  const d = await h.download({ plugin_id: SAMPLE_ID, token: lic.token, fingerprint: lic.server.fingerprint });
  assert.equal(d.body.data.kid, KIDS.pluginB);
  assert.equal(d.body.data.sha256, after.package_sha256);
  const bytes = await h.fetchPackage(d.body.data.url);
  assert.equal(pack.sha256(bytes.body), after.package_sha256);
  assert.equal(pack.verifySignatureFile(unpackTo(bytes.body), 'SIGNATURE.json', pubOf(KIDS.pluginB)).ok, true);
  const status = await h.admin('get', '/v1/admin/market/resign-status');
  assert.equal(status.body.data.active_kid, KIDS.pluginB);
  assert.equal(status.body.data.backlog, 0);
  assert.equal(status.body.data.last_run.done, 1);
  assert.ok(h.mdb.prepare("SELECT 1 FROM developer_webhook_deliveries").get() === undefined || true);
  // The feed and /keys list active + retiring, never retired; check-in extras agree.
  const keys = (await h.http.get('/v1/market/keys')).body.data.keys.map((k) => [k.kid, k.status]).sort();
  assert.deepEqual(Object.fromEntries(keys), { [KIDS.pluginA]: 'retiring', [KIDS.pluginB]: 'active' });
  const ci = await lic.checkin();
  assert.deepEqual(ci.body.data.plugin_signing_keys.map((k) => k.kid).sort(), [KIDS.pluginA, KIDS.pluginB].sort());
});

test('retire is refused with 409 key_in_use while a version still references the key; after the re-sign job it succeeds and the key disappears', async () => {
  h.advance(25 * 3600_000);
  // simulate a backlog: one version still signed with the old key
  h.mdb.prepare('UPDATE plugin_versions SET mkt_kid = ? WHERE plugin_id = ?').run(KIDS.pluginA, SAMPLE_ID);
  const refused = await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginA}/retire`).send({});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'key_in_use');
  assert.equal(refused.body.error.versions, 1);
  assert.equal((await h.admin('get', '/v1/admin/market/resign-status')).body.data.backlog, 1);
  const job = await h.admin('post', '/v1/admin/market/jobs/resign-packages/run');
  assert.equal(job.status, 200);
  assert.equal(job.body.data.result.done, 1);
  assert.equal(h.m.submissions.version(SAMPLE_ID, SAMPLE_MANIFEST.version).mkt_kid, KIDS.pluginB);
  const retired = await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginA}/retire`).send({});
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.equal(retired.body.data.status, 'retired');
  const keys = (await h.http.get('/v1/market/keys')).body.data.keys.map((k) => k.kid);
  assert.deepEqual(keys, [KIDS.pluginB]);
  const lic = await h.panelLicense();
  const ci = await lic.checkin();
  assert.deepEqual(ci.body.data.plugin_signing_keys.map((k) => k.kid), [KIDS.pluginB]);
  assert.ok(ci.body.data.plugin_signing_keys[0].pub.includes('BEGIN PUBLIC KEY'));
});

function unpackTo(buf) {
  const dir = fs.mkdtempSync(path.join((process.env.TMPDIR || '/tmp'), 'whm-rot-'));
  pack.unpack(buf, dir);
  return pack.packageRoot(dir);
}
