import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootMarket, pack, KIDS, REPO, GOLDEN, SAMPLE_ID, SAMPLE_MANIFEST } from './market-support.js';
import { pubOf } from './fixtures/index.js';
import { packageDigest as hostPackageDigest } from '../../server/src/services/plugins.js';
import { createTestApp } from '../../server/test/support/app.js';

let h; let panel; let csrf; let row; let signedBytes;
before(async () => {
  h = await bootMarket();
  const out = await h.submitSample();
  row = h.m.submissions.version(SAMPLE_ID, SAMPLE_MANIFEST.version);
  signedBytes = fs.readFileSync(row.package_file);
  assert.equal(out.published.status, 'published');
  panel = await createTestApp();
  csrf = await panel.login();
});
after(async () => { await panel?.close(); await h.close(); });

test('the hub digest is the host digest: packageDigest(root) of the served file equals plugin_versions.package_digest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-parity-'));
  pack.unpack(signedBytes, tmp);
  const root = pack.packageRoot(tmp);
  assert.equal(hostPackageDigest(root).toString('hex'), row.package_digest);
  assert.equal(pack.packageDigest(root).toString('hex'), hostPackageDigest(root).toString('hex'));
  const sig = JSON.parse(fs.readFileSync(path.join(root, 'SIGNATURE.json'), 'utf8'));
  assert.equal(pack.verify(hostPackageDigest(root), sig.sig, pubOf(KIDS.pluginA)), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('approve → repack → sign → install on the real panel host: signed: true, signer: <kid>; unsigned copy refused under require_signature', async () => {
  const keysDir = path.join(panel.ctx.config.dataDir, 'plugin-keys');
  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(path.join(keysDir, `${KIDS.pluginA}.pub`), pubOf(KIDS.pluginA));
  const install = (buf) => panel.http.post('/api/plugins/manage/install').set('X-CSRF-Token', csrf).set('Content-Type', 'application/gzip').send(buf);
  const ok = await install(signedBytes);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.plugin.id, SAMPLE_ID);
  assert.equal(ok.body.data.plugin.signed, true);
  assert.equal(ok.body.data.plugin.signer, KIDS.pluginA);
  assert.deepEqual(ok.body.data.warnings, ['in-process']);
  assert.equal(ok.body.data.plugin.version, SAMPLE_MANIFEST.version);
  const detail = await panel.http.get(`/api/plugins/manage/${SAMPLE_ID}`);
  assert.equal(detail.status, 200);
  // A tampered copy of the served package fails the host signature check.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-parity-t-'));
  pack.unpack(signedBytes, tmp);
  fs.appendFileSync(path.join(tmp, 'main.js'), '\n// tampered\n');
  const tampered = await install(pack.packDirectory(tmp, { exclude: [] }));
  assert.equal(tampered.status, 422);
  assert.equal(tampered.body.error.code, 'invalid_signature');
  fs.rmSync(tmp, { recursive: true, force: true });
  // require_signature on: the unsigned developer upload (no SIGNATURE.json) is refused, the hub package still installs.
  panel.ctx.settings.set('plugins.require_signature', true);
  const unsigned = await install(GOLDEN());
  assert.equal(unsigned.status, 422);
  assert.equal(unsigned.body.error.code, 'unsigned_package');
  assert.equal((await install(signedBytes)).status, 201);
  panel.ctx.settings.set('plugins.require_signature', false);
  await panel.http.delete(`/api/plugins/manage/${SAMPLE_ID}?purge=true`).set('X-CSRF-Token', csrf);
});

test('bundled { dir } install stays exempt from require_signature', async () => {
  panel.ctx.settings.set('plugins.require_signature', true);
  try {
    const res = await panel.http.post('/api/plugins/manage/install').set('X-CSRF-Token', csrf).send({ dir: path.join(REPO, 'plugins/bundled/net.whm.server-monitoring'), source: 'bundled' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.plugin.source, 'bundled');
  } finally {
    panel.ctx.settings.set('plugins.require_signature', false);
  }
});
