import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootMarket, totpCode, pack, DEV_PEM, DEV_KID, KIDS, GOLDEN, SAMPLE_ID, buildPackage, manifestFor, justify } from './market-support.js';
import { pubOf } from './fixtures/index.js';

let h;
before(async () => { h = await bootMarket(); });
after(() => h.close());

test('register → e-mail verify → login → profile → TOTP → namespace claim', async () => {
  const email = 'alice@acme.test';
  const reg = await h.http.post('/v1/dev/register').send({ email, password: 'Correct-Horse-Battery-9', display_name: 'Acme Hosting' });
  assert.equal(reg.status, 202);
  assert.equal(reg.body.data.status, 'pending');
  const mail = h.sent.find((s) => s.to === email && s.template === 'dev.email_verify');
  assert.ok(mail, 'verification mail sent');
  const token = /verify-email\/([A-Za-z0-9_-]+)/.exec(mail.message)[1];
  const beforeVerify = await h.http.post('/v1/dev/login').send({ email, password: 'Correct-Horse-Battery-9' });
  assert.equal(beforeVerify.body.error.code, 'email_unverified');
  assert.equal((await h.http.post('/v1/dev/verify-email').send({ token })).status, 200);
  assert.equal((await h.http.post('/v1/dev/verify-email').send({ token })).status, 410, 'single use');
  const agent = (await import('supertest')).default.agent(h.ctx.app);
  const login = await agent.post('/v1/dev/login').send({ email, password: 'Correct-Horse-Battery-9' });
  assert.equal(login.status, 200);
  const csrf = login.body.data.csrfToken;
  assert.equal(login.body.data.developer.slug, 'acme-hosting');
  assert.equal((await agent.patch('/v1/dev/profile').send({ company: 'Acme' })).body.error.code, 'csrf_failed', 'cookie sessions need the CSRF token');
  const profile = await agent.patch('/v1/dev/profile').set('X-CSRF-Token', csrf).send({ company: 'Acme', website: 'https://acme.test' });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.company, 'Acme');
  // Namespace claims need TOTP first (totp_required), then a step-up.
  const noTotp = await agent.post('/v1/dev/namespaces').set('X-CSRF-Token', csrf).send({ ns: 'test.acme' });
  assert.equal(noTotp.body.error.code, 'totp_required');
  const start = await agent.post('/v1/dev/2fa/start').set('X-CSRF-Token', csrf).send({});
  assert.equal(start.status, 200);
  assert.ok(start.body.data.uri.startsWith('otpauth://'));
  const confirm = await agent.post('/v1/dev/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: totpCode(start.body.data.secret) });
  assert.equal(confirm.status, 200);
  const claim = await agent.post('/v1/dev/namespaces').set('X-CSRF-Token', csrf).send({ ns: 'test.acme' });
  assert.equal(claim.status, 201, JSON.stringify(claim.body));
  assert.deepEqual(claim.body.data, { ns: 'test.acme', domain: 'acme.test', status: 'claimed', verified_at: null });
  const me = await agent.get('/v1/dev/me');
  assert.deepEqual(me.body.data.developer.namespaces, ['test.acme']);
  assert.equal(me.body.data.developer.totp_enabled, true);
  // Evidence: dns_txt instructions carry the token; the row starts pending.
  const ev = await agent.post('/v1/dev/verification').set('X-CSRF-Token', csrf).send({ method: 'dns_txt', ns: 'test.acme' });
  assert.equal(ev.status, 201);
  assert.equal(ev.body.data.result, 'pending');
  assert.equal(ev.body.data.instructions.record, '_whm-dev.acme.test');
  assert.ok(h.sent.some((s) => s.to === email && s.template === 'dev.verification_received'));
});

test('upload rule: never-verified pending → 403; re-verification pending uploads but cannot publish; verified publishes', async () => {
  const never = await h.developer({ verified: false, namespaces: ['test.never'] });
  const listing = await h.createListing(never, 'test.never.thing');
  assert.equal(listing.status, 201, 'a draft listing is allowed under an owned namespace');
  const up = await never.upload('test.never.thing', buildPackage({ manifest: manifestFor('test.never.thing'), signWith: never.pem }));
  assert.equal(up.status, 403);
  assert.equal(up.body.error.code, 'developer_not_verified');

  const dev = await h.developer({ namespaces: ['test.rev'] });
  assert.equal((await h.createListing(dev, 'test.rev.thing')).status, 201);
  // Drop back to pending after verification (re-verification trigger keeps verified_at).
  h.m.developers.triggerReverification(dev.id, 'email_changed');
  assert.equal(dev.row().status, 'pending');
  assert.ok(dev.row().verified_at);
  const up2 = await dev.upload('test.rev.thing', buildPackage({ manifest: manifestFor('test.rev.thing'), signWith: dev.pem }));
  assert.equal(up2.status, 201, JSON.stringify(up2.body));
  assert.equal(up2.body.data.status, 'in_review');
  const approved = await h.approveReview(up2.body.data.review_id);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const pub = await h.publish(dev, 'test.rev.thing', '1.0.0');
  assert.equal(pub.status, 403);
  assert.equal(pub.body.error.code, 'developer_not_verified');
  h.m.developers.approve(dev.id, { by: 'test' });
  const pub2 = await h.publish(dev, 'test.rev.thing', '1.0.0');
  assert.equal(pub2.status, 200, JSON.stringify(pub2.body));
  assert.equal(pub2.body.data.status, 'published');
  assert.equal(h.mdb.prepare("SELECT status FROM plugins WHERE id = 'test.rev.thing'").get().status, 'listed');
});

test('approve / reject / suspend / reinstate / re-verify transitions write mails and audit rows', async () => {
  const dev = await h.developer({ verified: false, namespaces: ['test.trans'], loggedIn: false, key: null });
  const admin = h.admin;
  const queue = await admin('get', '/v1/admin/market/verifications?status=pending');
  assert.ok(queue.body.data.some((q) => q.developer.id === dev.id));
  const rej = await admin('post', `/v1/admin/market/verifications/${dev.id}/reject`).send({ code: 'evidence_failed', text: 'no TXT record' });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.data.status, 'rejected');
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.rejected'));
  assert.equal((await admin('post', `/v1/admin/market/verifications/${dev.id}/reject`).send({ code: 'bogus' })).status, 422);
  const app = await admin('post', `/v1/admin/market/verifications/${dev.id}/approve`).send({ note: 'ok' });
  assert.equal(app.body.data.status, 'verified');
  assert.ok(app.body.data.reverify_due_at);
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.verified'));
  const sus = await admin('post', `/v1/admin/market/developers/${dev.id}/suspend`).send({ reason: 'abuse' });
  assert.equal(sus.body.data.status, 'suspended');
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.suspended'));
  const rein = await admin('post', `/v1/admin/market/developers/${dev.id}/reinstate`).send({});
  assert.equal(rein.body.data.status, 'verified');
  const rev = await admin('post', `/v1/admin/market/developers/${dev.id}/reverify`).send({ reason: 'manual' });
  assert.equal(rev.body.data.status, 'pending');
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.reverify_due'));
  const actions = h.mdb.prepare('SELECT action FROM audit_log WHERE target = ? ORDER BY id').all(dev.id).map((r) => r.action);
  for (const a of ['developer.rejected', 'developer.verified', 'developer.suspended', 'developer.pending']) assert.ok(actions.includes(a), `${a} audited`);
  const hist = await admin('get', `/v1/admin/market/developers/${dev.id}`);
  assert.equal(hist.status, 200);
  assert.ok(hist.body.data.history.audit.length >= 4);
  // The reverify_due job drops verified developers whose date passed.
  h.m.developers.approve(dev.id, { by: 'test' });
  h.mdb.prepare('UPDATE developers SET reverify_due_at = ? WHERE id = ?').run(new Date(h.clock.t - 1000).toISOString(), dev.id);
  assert.equal(h.m.developers.reverifyDue().triggered, 1);
  assert.equal(dev.row().status, 'pending');
});

test('signing keys: Ed25519 PEM only, kid per §16.4, proof of possession, kid conflicts, revoked keys refused', async () => {
  const dev = await h.developer({ namespaces: ['test.keys'], key: null });
  const challenge = (await dev.post('/v1/dev/keys')).body.data.challenge;
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  const rsaSig = crypto.sign('sha256', Buffer.from(challenge, 'base64url'), rsa.privateKey).toString('base64');
  const bad = await dev.post(`/v1/dev/keys/${challenge}`, { public_key_pem: rsaPem, sig: rsaSig.slice(0, 100) });
  assert.equal(bad.body.error.code, 'invalid_public_key');
  const wrongSig = await dev.post(`/v1/dev/keys/${challenge}`, { public_key_pem: pack.publicPem(DEV_PEM), sig: Buffer.alloc(64).toString('base64') });
  assert.equal(wrongSig.body.error.code, 'challenge_signature_invalid');
  const sig = crypto.sign(null, Buffer.from(challenge, 'base64url'), crypto.createPrivateKey(DEV_PEM)).toString('base64');
  const ok = await dev.post(`/v1/dev/keys/${challenge}`, { public_key_pem: pack.publicPem(DEV_PEM), label: 'ci', sig });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.kid, DEV_KID);
  assert.equal(ok.body.data.kid, crypto.createHash('sha256').update(crypto.createPublicKey(DEV_PEM).export({ type: 'spki', format: 'der' }).subarray(-32)).digest('hex').slice(0, 8));
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.key_added'));
  assert.equal((await dev.post(`/v1/dev/keys/${challenge}`, { public_key_pem: pack.publicPem(DEV_PEM), sig })).status, 404, 'challenge consumed');
  // The hub's own plugin key and another developer's key collide.
  const other = await h.developer({ namespaces: ['test.other'], key: null });
  const dup = await h.registerKey(other, DEV_PEM);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'kid_conflict');
  const hubPriv = (await import('./fixtures/index.js')).privOf(KIDS.pluginA);
  const hubDup = await h.registerKey(other, hubPriv);
  assert.equal(hubDup.body.error.code, 'kid_conflict', 'cannot register the hub signing key');
  assert.equal(pack.kidOf(pubOf(KIDS.pluginA)), KIDS.pluginA);
  // Revoked key → uploads signed with it are refused.
  const rev = await dev.post(`/v1/dev/keys/${DEV_KID}/revoke`, { reason: 'rotated' });
  assert.equal(rev.status, 200);
  assert.equal((await h.createListing(dev, 'test.keys.thing')).status, 201);
  const up = await dev.upload('test.keys.thing', buildPackage({ manifest: manifestFor('test.keys.thing'), signWith: DEV_PEM }));
  assert.equal(up.status, 403);
  assert.equal(up.body.error.code, 'dev_signature_invalid');
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.key_revoked'));
});
