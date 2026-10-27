import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { bootMarket, buildPackage, tarEntries, manifestFor, justify, pack, GOLDEN, SAMPLE_ID, SAMPLE_MANIFEST, DEV_PEM, DEV_KID } from './market-support.js';

let h; let dev; let other;
before(async () => {
  h = await bootMarket();
  dev = await h.sampleDeveloper();
  other = await h.developer({ namespaces: ['test.other'] });
  assert.equal((await h.createListing(dev, SAMPLE_ID, { name: 'Sample Notes' })).status, 201);
  assert.equal((await h.createListing(other, 'test.other.thing')).status, 201);
});
after(() => h.close());

const id = 'test.other.thing';
const upload = (buf, opts = {}) => other.upload(id, buf, { justifications: {}, ...opts });

test('the golden sample package from scripts/build-plugin.js --sign --dev passes and records the digest, files and dev signature', async () => {
  const res = await dev.upload(SAMPLE_ID, GOLDEN(), { justifications: justify(SAMPLE_MANIFEST), changelog: '# 1.1.0\n- initial' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const v = res.body.data;
  assert.equal(v.status, 'in_review');
  assert.equal(v.risk, 'high', 'accounts:write marks the version high-risk');
  assert.equal(v.dev_kid, DEV_KID);
  assert.equal(v.upload_sha256, pack.sha256(GOLDEN()));
  assert.equal(v.changelog_md, '# 1.1.0\n- initial');
  assert.deepEqual(v.scan_report.rejects, []);
  const files = h.mdb.prepare('SELECT path FROM plugin_files WHERE version_id = ? ORDER BY path').all(v.id).map((f) => f.path);
  assert.deepEqual(files, pack.listPackage(GOLDEN()).map((e) => e.name).sort());
  // package_digest is the host rule over the stored root (DEV-SIGNATURE.json included)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-golden-'));
  pack.unpack(GOLDEN(), tmp);
  assert.equal(v.package_digest, pack.packageDigest(pack.packageRoot(tmp)).toString('hex'));
  fs.rmSync(tmp, { recursive: true, force: true });
  const detail = await dev.get(`/v1/dev/plugins/${SAMPLE_ID}/versions/${SAMPLE_MANIFEST.version}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.manifest.id, SAMPLE_ID);
  assert.equal(detail.body.data.review.state, 'open');
  // the same bytes again → immutable
  const again = await dev.upload(SAMPLE_ID, GOLDEN(), { justifications: justify(SAMPLE_MANIFEST) });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'version_exists');
});

test('refusals: missing/invalid/tampered DEV-SIGNATURE, wrong or foreign key, size, versions, engines, links, root SIGNATURE.json, forbidden file types', async () => {
  const m = manifestFor(id);
  const expect = async (buf, status, code, label) => {
    const res = await upload(buf);
    assert.equal(res.status, status, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, code, label);
  };
  await expect(buildPackage({ manifest: m, signWith: null }), 422, 'dev_signature_missing', 'missing');
  await expect(buildPackage({ manifest: m, signWith: null, files: { 'DEV-SIGNATURE.json': '{"kid":"x"}' } }), 422, 'invalid_signature', 'invalid signature file');
  await expect(buildPackage({ manifest: m, signWith: other.pem, kid: 'deadbeef' }), 403, 'dev_signature_invalid', 'unknown kid');
  await expect(buildPackage({ manifest: m, signWith: DEV_PEM }), 403, 'dev_signature_invalid', 'another developer\'s key');
  await expect(buildPackage({ manifest: m, signWith: other.pem, extraSignatureFile: { kid: 'x', alg: 'ed25519', sig: 'AA==' } }), 422, 'reserved_file', 'root SIGNATURE.json');
  // tampered after signing: rebuild with the signature of a different content
  const good = buildPackage({ manifest: m, signWith: other.pem });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-tamper-'));
  pack.unpack(good, tmp);
  fs.writeFileSync(path.join(tmp, 'main.js'), 'module.exports = { evil: true };');
  await expect(pack.packDirectory(tmp, { exclude: [] }), 422, 'dev_signature_invalid', 'tampered');
  fs.rmSync(tmp, { recursive: true, force: true });
  const eng = await upload(buildPackage({ manifest: { ...m, version: '1.0.1', engines: { whm: '^9.0.0' } }, signWith: other.pem }));
  assert.equal(eng.status, 201);
  assert.equal(eng.body.data.status, 'scan_failed');
  assert.ok(eng.body.data.scan_report.rejects.some((r) => r.rule === 'engines'));
  await expect(buildPackage({ manifest: { ...m, id: 'test.other.different' }, signWith: other.pem }), 422, 'id_mismatch', 'id mismatch');
  await expect(buildPackage({ manifest: { ...m, version: 'not-semver' }, signWith: other.pem }), 422, 'invalid_manifest', 'bad version');
  await expect(Buffer.from('not a gzip'), 422, 'invalid_package', 'garbage');
  await expect(zlib.gzipSync(Buffer.alloc(1024)), 422, 'invalid_package', 'gzip without plugin.json');
  // tar with a symlink and with an absolute name
  const tar = tarEntries;
  await expect(tar([{ name: 'plugin.json', data: JSON.stringify(m) }, { name: 'main.js', data: 'x' }, { name: 'evil', type: '2', link: '/etc/passwd' }]), 422, 'invalid_package', 'symlink');
  await expect(tar([{ name: '/plugin.json', data: JSON.stringify(m) }, { name: 'main.js', data: 'x' }]), 422, 'invalid_package', 'absolute');
  await expect(tar([{ name: '../plugin.json', data: JSON.stringify(m) }, { name: 'main.js', data: 'x' }]), 422, 'invalid_package', 'dot-dot');
  // size overflow (hub limit) → 413
  const big = await upload(Buffer.alloc(h.m.cfg.max_package_bytes + 1));
  assert.equal(big.status, 413);
  // duplicate / lower version than a published one on the channel
  const seed = await upload(buildPackage({ manifest: { ...m, version: '2.0.0' }, signWith: other.pem }));
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
  assert.equal((await h.approveReview(seed.body.data.review_id)).status, 200);
  assert.equal((await h.publish(other, id, '2.0.0')).status, 200);
  const lower = await upload(buildPackage({ manifest: { ...m, version: '1.9.9' }, signWith: other.pem }));
  assert.equal(lower.status, 422);
  assert.equal(lower.body.error.code, 'version_not_greater');
  const betaLower = await upload(buildPackage({ manifest: { ...m, version: '1.9.8' }, signWith: other.pem }), { channel: 'beta' });
  assert.equal(betaLower.status, 201, 'the beta channel has no published version yet');
  // a .sh / .node entry → scan reject
  const sh = await upload(buildPackage({ manifest: { ...m, version: '2.1.0' }, signWith: other.pem, files: { 'tools/run.sh': '#!/bin/sh\n', 'native.node': 'x' } }));
  assert.equal(sh.body.data.status, 'scan_failed');
  assert.deepEqual(sh.body.data.scan_report.rejects.map((r) => r.file).sort(), ['native.node', 'tools/run.sh']);
});

test('a wrapper directory is stripped: digest, plugin_files and the repacked file are identical to the unwrapped upload', async () => {
  const m = manifestFor('test.other.wrap');
  const w = await h.developer({ namespaces: ['test.wrap'] });
  assert.equal((await h.createListing(w, 'test.wrap.a')).status, 201);
  assert.equal((await h.createListing(w, 'test.wrap.b')).status, 201);
  const plain = buildPackage({ manifest: { ...m, id: 'test.wrap.a' }, signWith: w.pem, files: { 'lib/x.js': 'module.exports = 1;\n' } });
  const wrapped = buildPackage({ manifest: { ...m, id: 'test.wrap.b' }, signWith: w.pem, files: { 'lib/x.js': 'module.exports = 1;\n' }, wrapper: 'package-root' });
  assert.ok(pack.listPackage(wrapped).every((e) => e.name.startsWith('package-root/')));
  const a = await w.upload('test.wrap.a', plain, { justifications: {} });
  const b = await w.upload('test.wrap.b', wrapped, { justifications: {} });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const filesOf = (vid) => h.mdb.prepare('SELECT path, sha256 FROM plugin_files WHERE version_id = ? ORDER BY path').all(vid).filter((f) => !['plugin.json', 'DEV-SIGNATURE.json'].includes(f.path));
  assert.deepEqual(filesOf(b.body.data.id), filesOf(a.body.data.id));
  assert.ok(filesOf(b.body.data.id).every((f) => !f.path.startsWith('package-root/')));
  assert.equal((await h.approveReview(a.body.data.review_id)).status, 200);
  assert.equal((await h.approveReview(b.body.data.review_id)).status, 200);
  const va = h.m.submissions.version('test.wrap.a', '1.0.0');
  const vb = h.m.submissions.version('test.wrap.b', '1.0.0');
  const names = (f) => pack.listPackage(fs.readFileSync(f)).map((e) => e.name);
  assert.deepEqual(names(vb.package_file), names(va.package_file));
  assert.ok(!names(vb.package_file).some((n) => n.includes('package-root')));
});

test('upload limit: 10 per day per developer', async () => {
  const hub = await bootMarket({ config: { marketplace: { rate_limits: { upload: { max: 10 } } } } });
  try {
    const d = await hub.developer({ namespaces: ['test.quota'] });
    assert.equal((await hub.createListing(d, 'test.quota.p')).status, 201);
    let last;
    for (let i = 1; i <= 11; i++) last = await d.upload('test.quota.p', buildPackage({ manifest: manifestFor('test.quota.p', { version: `1.0.${i}` }), signWith: d.pem }), { justifications: {} });
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'rate_limited');
  } finally { await hub.close(); }
});
