import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { bootMarket, buildPackage, manifestFor, pack, KIDS } from './market-support.js';
import { pubOf, privOf } from './fixtures/index.js';
import { unifiedDiff } from '../marketplace/services/review.js';

let h; let dev;
before(async () => {
  h = await bootMarket();
  dev = await h.developer({ namespaces: ['test.review'] });
});
after(() => h.close());

const id = 'test.review.p';
const upload = (version, files, permissions = []) => dev.upload(id, buildPackage({ manifest: manifestFor(id, { version, permissions }), signWith: dev.pem, files }), { justifications: Object.fromEntries(permissions.map((p) => [p, `Required because the plugin needs ${p} for its feature`])) });

test('review detail diffs against the previous published version and highlights new scopes; reasons shape', async () => {
  assert.equal((await h.createListing(dev, id)).status, 201);
  const v1 = await upload('1.0.0', { 'main.js': 'module.exports = { activate() { return 1; } };\n', 'README.md': 'v1\n' });
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  const d1 = await h.admin('get', `/v1/admin/market/reviews/${v1.body.data.review_id}`);
  assert.equal(d1.status, 200);
  assert.equal(d1.body.data.diff.base_version_id, null);
  assert.ok(d1.body.data.diff.files.every((f) => f.change === 'added'));
  assert.equal((await h.approveReview(v1.body.data.review_id)).status, 200);
  assert.equal((await h.publish(dev, id, '1.0.0')).status, 200);
  const v2 = await upload('1.1.0', { 'main.js': 'module.exports = { activate() { return 2; } };\n', 'lib/new.js': 'module.exports = 1;\n' }, ['accounts:read']);
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  const queue = await h.admin('get', '/v1/admin/market/reviews');
  assert.ok(queue.body.data.some((r) => r.version_id === v2.body.data.id && r.plugin_id === id));
  const d2 = await h.admin('get', `/v1/admin/market/reviews/${v2.body.data.review_id}`);
  assert.equal(d2.body.data.diff.base_version_id, v1.body.data.id);
  const changes = Object.fromEntries(d2.body.data.diff.files.map((f) => [f.path, f.change]));
  assert.equal(changes['main.js'], 'modified');
  assert.equal(changes['lib/new.js'], 'added');
  assert.equal(changes['README.md'], 'removed');
  assert.match(d2.body.data.diff.patch, /-module\.exports = \{ activate\(\) \{ return 1; \} \};/);
  assert.match(d2.body.data.diff.patch, /\+module\.exports = \{ activate\(\) \{ return 2; \} \};/);
  assert.deepEqual(d2.body.data.permissions, [{ scope: 'accounts:read', description: 'Read hosting accounts (ctx.api.accounts.list / get)', justification: 'Required because the plugin needs accounts:read for its feature', added: true }]);
  assert.equal(d2.body.data.requires_two_reviewers, false);
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  // request changes → reasons stored with { code, path, text }; invalid code → 422
  const bad = await h.admin('post', `/v1/admin/market/reviews/${v2.body.data.review_id}/request-changes`).send({ reasons: [{ code: 'nope', text: 'x' }] });
  assert.equal(bad.status, 422);
  const rc = await h.admin('post', `/v1/admin/market/reviews/${v2.body.data.review_id}/request-changes`).send({ reasons: [{ code: 'undeclared_permission', path: 'main.js:1', text: 'reads accounts without saying why' }], notes: 'see path' });
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.deepEqual(rc.body.data.reasons, [{ code: 'undeclared_permission', path: 'main.js:1', text: 'reads accounts without saying why' }]);
  assert.equal(h.m.submissions.version(id, '1.1.0').status, 'changes_requested');
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.submission_reviewed' && /changes_requested/.test(s.message)));
  assert.equal((await h.admin('post', `/v1/admin/market/reviews/${v2.body.data.review_id}/approve`).send({})).body.error.code, 'review_closed');
  // uploaded bytes are immutable: the fix is a new version
  const v3 = await upload('1.1.1', { 'main.js': 'module.exports = { activate() { return 3; } };\n' }, ['accounts:read']);
  const rej = await h.admin('post', `/v1/admin/market/reviews/${v3.body.data.review_id}/reject`).send({ reasons: [{ code: 'policy', text: 'no' }] });
  assert.equal(rej.body.data.state, 'rejected');
  assert.equal(h.m.submissions.version(id, '1.1.1').status, 'rejected');
  const audit = h.mdb.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(`${id}@1.1.1`).map((r) => r.action);
  assert.ok(audit.includes('review.rejected'));
});

test('approve writes SIGNATURE.json with the active plugin kid, standard base64 with padding, byte-equal to pack.js and the host rule', async () => {
  const v = await upload('2.0.0', { 'main.js': 'module.exports = { activate() {} };\n' });
  assert.equal(v.status, 201);
  const ap = await h.approveReview(v.body.data.review_id);
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.data.state, 'approved');
  assert.equal(ap.body.data.signed.kid, KIDS.pluginA);
  const row = h.m.submissions.version(id, '2.0.0');
  assert.equal(row.status, 'approved');
  assert.equal(row.mkt_kid, KIDS.pluginA);
  assert.ok(fs.existsSync(row.package_file));
  assert.equal(path.basename(row.package_file), `2.0.0-${KIDS.pluginA}.whmplugin`);
  const buf = fs.readFileSync(row.package_file);
  assert.equal(pack.sha256(buf), row.package_sha256);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-signed-'));
  pack.unpack(buf, tmp);
  const root = pack.packageRoot(tmp);
  assert.equal(root, tmp, 'no wrapper');
  const sig = JSON.parse(fs.readFileSync(path.join(root, 'SIGNATURE.json'), 'utf8'));
  assert.deepEqual(Object.keys(sig).sort(), ['alg', 'kid', 'sig']);
  assert.equal(sig.alg, 'ed25519');
  assert.match(sig.sig, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(sig.sig.length % 4, 0, 'padded base64');
  assert.equal(sig.sig.length, 88, '64-byte Ed25519 signature in base64');
  const digest = pack.packageDigest(root);
  assert.equal(digest.toString('hex'), row.package_digest, 'the host digest of the served file is the reviewed digest');
  assert.equal(sig.sig, crypto.sign(null, digest, crypto.createPrivateKey(privOf(KIDS.pluginA))).toString('base64'), 'byte-for-byte what pack.js sign() emits');
  assert.equal(pack.verify(digest, sig.sig, pubOf(KIDS.pluginA)), true);
  assert.deepEqual(pack.verifySignatureFile(root, 'SIGNATURE.json', pubOf(KIDS.pluginA)), { ok: true, kid: KIDS.pluginA });
  assert.equal(pack.verifySignatureFile(root, 'DEV-SIGNATURE.json', pack.publicPem(dev.pem)).ok, true, 'the developer signature is still inside and covered');
  assert.equal(row.mkt_signature, sig.sig);
  assert.equal(h.mdb.prepare('SELECT COUNT(*) AS n FROM plugin_version_signatures WHERE version_id = ?').get(row.id).n, 1);
  // Deterministic repack: signing again yields identical bytes.
  const again = h.m.signing.signVersion(row.id);
  assert.equal(again.package_sha256, row.package_sha256);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cross-purpose refusal: the license kid cannot sign a package, the plugin kid cannot sign a response', async () => {
  const v = h.m.submissions.version(id, '2.0.0');
  assert.throws(() => h.m.signing.signVersion(v.id, { kid: KIDS.licenseA }), (e) => e.code === 'key_purpose_mismatch');
  assert.throws(() => h.ctx.keys.sign(Buffer.from('x'), { kid: KIDS.licenseA, purpose: 'plugin', encoding: 'base64' }), (e) => e.code === 'key_purpose_mismatch');
  assert.throws(() => h.ctx.keys.sign(Buffer.from('x'), { kid: KIDS.pluginA, purpose: 'license', encoding: 'base64url' }), (e) => e.code === 'key_purpose_mismatch');
  assert.equal(h.ctx.licenses.verifySigned(Buffer.from('{}'), `kid=${KIDS.pluginA},sig=${h.ctx.keys.sign(Buffer.from('{}'), { kid: KIDS.pluginA, purpose: 'plugin', encoding: 'base64url' })}`), false, 'a plugin-key signature never verifies a hub response');
});

test('two-reviewer gate for high-risk versions', async () => {
  const hub = await bootMarket({ config: { marketplace: { review: { require_two_reviewers_for_high_risk: true } } } });
  try {
    const d = await hub.developer({ namespaces: ['test.two'] });
    assert.equal((await hub.createListing(d, 'test.two.p')).status, 201);
    const low = await d.upload('test.two.p', buildPackage({ manifest: manifestFor('test.two.p'), signWith: d.pem }), { justifications: {} });
    assert.equal(low.body.data.risk, 'normal');
    assert.equal((await hub.approveReview(low.body.data.review_id)).body.data.state, 'approved', 'normal risk needs one reviewer');
    const high = await d.upload('test.two.p', buildPackage({ manifest: manifestFor('test.two.p', { version: '1.1.0', permissions: ['backups:restore'] }), signWith: d.pem }), { justifications: { 'backups:restore': 'Restores backups on request from the operator UI' } });
    assert.equal(high.body.data.risk, 'high');
    const detail = await hub.admin('get', `/v1/admin/market/reviews/${high.body.data.review_id}`);
    assert.equal(detail.body.data.requires_two_reviewers, true);
    const first = await hub.approveReview(high.body.data.review_id);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.pending_second_reviewer, true);
    assert.equal(first.body.data.state, 'open');
    assert.equal(hub.m.submissions.version('test.two.p', '1.1.0').status, 'in_review');
    assert.equal((await hub.approveReview(high.body.data.review_id)).body.error.code, 'already_approved');
    const second = hub.marketKey(['market:review']);
    const done = await hub.approveReview(high.body.data.review_id, { key: second });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.state, 'approved');
    assert.equal(done.body.data.approvals.length, 2);
    assert.equal(hub.m.submissions.version('test.two.p', '1.1.0').mkt_kid, KIDS.pluginA);
    // market:* scopes work; a key without them is refused; read keys cannot approve
    const reader = hub.marketKey(['market:read']);
    assert.equal((await hub.asKey(reader)('get', '/v1/admin/market/reviews')).status, 200);
    assert.equal((await hub.asKey(reader)('post', `/v1/admin/market/reviews/${high.body.data.review_id}/approve`).send({})).body.error.code, 'insufficient_scope');
    assert.equal((await hub.http.get('/v1/admin/market/reviews')).status, 401);
  } finally { await hub.close(); }
});
