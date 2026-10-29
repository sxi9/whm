import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { authenticator } from 'otplib';
import { bootHub } from './support.js';
import { encodeQr, qrSvgPath } from '../ui/src/lib/qr.js';

// Portal TOTP everywhere (U4): enrolment with secret + otpauth URI, login that
// asks for the code once enabled, step-up on a fresh code, the per-account
// wrong-code budget, and hub.require_totp_for_admins forcing vendor and
// reseller admins to enrol at their first login before anything but
// /v1/portal/* answers.

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

// A code generated within the last 15 s of its 30 s step could expire between
// generate() and verify(); wait for the next step instead.
function freshTotpStep() {
  const left = 30_000 - (Date.now() % 30_000);
  return left < 15_000 ? new Promise((resolve) => setTimeout(resolve, left + 50)) : Promise.resolve();
}

let counter = 0;
async function createUser(role, { reseller = false } = {}) {
  const n = ++counter;
  const password = `Portal-Pass-${n}-abcd`;
  const rs = reseller ? h.ctx.resellers.create({ name: `Tenant ${n}`, email: `tenant${n}@reseller.test` }) : null;
  const user = await h.ctx.portalUsers.create({ email: `u${n}@${reseller ? 'reseller' : 'vendor'}.test`, password, role, reseller_id: rs?.id ?? null });
  return { ...user, password, reseller: rs };
}

async function signIn(user, totp) {
  const agent = request.agent(h.ctx.app);
  const res = await agent.post('/v1/portal/login').send({ email: user.email, password: user.password, ...(totp ? { totp } : {}) });
  return { agent, res, csrf: res.body.data?.csrfToken };
}

async function enrol(agent, csrf) {
  const start = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({});
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const { secret, uri } = start.body.data;
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.ok(uri.includes(`secret=${secret}`));
  const confirm = await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  return { secret, start: start.body.data, confirm: confirm.body.data };
}

test('migration 001d seeds the policy on and the portal reports it', () => {
  const row = h.db.prepare("SELECT value_json FROM vendor_settings WHERE key = 'hub.require_totp_for_admins'").get();
  assert.equal(row.value_json, 'true');
  assert.deepEqual(h.ctx.portalUsers.settings(), { require_totp_for_admins: true, enforced_roles: ['vendor_admin', 'reseller_admin'] });
  for (const col of ['totp_enrolled_at', 'totp_failures', 'totp_locked_until']) assert.ok(h.db.prepare('PRAGMA table_info(portal_users)').all().some((c) => c.name === col), col);
});

test('a vendor admin must enrol at the first login: only /v1/portal/* answers until the code is confirmed', async () => {
  await freshTotpStep();
  const admin = await createUser('vendor_admin');
  const { agent, res, csrf } = await signIn(admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.totp_enrol_required, true);
  assert.equal(res.body.data.user.totp_enrol_required, true);
  const me = await agent.get('/v1/portal/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.totp_enrol_required, true);
  for (const [method, url] of [['get', '/v1/admin/licenses'], ['get', '/v1/admin/reports/dashboard'], ['get', '/v1/admin/market/stats'], ['get', '/v1/portal/users'], ['get', '/v1/portal/settings']]) {
    const r = await agent[method](url);
    assert.equal(r.status, 403, `${url}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'totp_enrol_required', url);
  }
  const off = await agent.patch('/v1/portal/settings').set('X-CSRF-Token', csrf).send({ require_totp_for_admins: false });
  assert.equal(off.body.error.code, 'totp_enrol_required', 'the rule cannot be switched off by an admin who has not enrolled');
  const noCsrf = await agent.post('/v1/portal/2fa/enroll').send({});
  assert.equal(noCsrf.body.error.code, 'csrf_failed');
  const start = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({});
  assert.equal(start.status, 200);
  assert.equal(start.body.data.required, true);
  assert.equal(start.body.data.reenrol, false);
  assert.equal((await agent.get('/v1/admin/licenses')).status, 403, 'an unconfirmed secret does not open the portal');
  assert.equal((await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: '000000' })).body.error.code, 'totp_invalid');
  const confirm = await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(start.body.data.secret) });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.data.totp_enabled, true);
  assert.equal(confirm.body.data.totp_enrol_required, false);
  assert.ok(confirm.body.data.totp_enrolled_at);
  assert.equal((await agent.get('/v1/portal/me')).body.data.totp_enrol_required, false);
  assert.equal((await agent.get('/v1/admin/licenses')).status, 200, 'the same session is open once the code is confirmed');
  assert.equal((await agent.get('/v1/portal/settings')).body.data.require_totp_for_admins, true);
  assert.equal((await agent.post('/v1/admin/signing-keys').set('X-CSRF-Token', csrf).send({ purpose: 'plugin' })).status, 201, 'enrolment counts as a fresh step-up');
  const audit = h.db.prepare("SELECT args FROM audit_log WHERE action = 'portal.login' AND principal = ? ORDER BY id DESC LIMIT 1").get(`portal:${admin.id}`);
  assert.ok(String(audit.args).includes('totp_enrol_required'));
});

test('enrolled: login requires the code, a wrong code is refused, step-up re-arms the session', async () => {
  await freshTotpStep();
  const admin = await createUser('vendor_admin');
  const first = await signIn(admin);
  const { secret } = await enrol(first.agent, first.csrf);

  const noCode = await signIn(admin);
  assert.equal(noCode.res.status, 401);
  assert.equal(noCode.res.body.error.code, 'totp_required');
  const wrong = await signIn(admin, '123456');
  assert.equal(wrong.res.status, 401);
  assert.equal(wrong.res.body.error.code, 'unauthorized');
  assert.equal(h.db.prepare('SELECT totp_failures FROM portal_users WHERE id = ?').get(admin.id).totp_failures, 1, 'a wrong login code spends the TOTP budget');
  const { agent, res, csrf } = await signIn(admin, authenticator.generate(secret));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.totp_enrol_required, false);
  assert.ok(res.body.data.totp_verified_at, 'a TOTP login counts as a step-up');
  assert.equal(h.db.prepare('SELECT totp_failures FROM portal_users WHERE id = ?').get(admin.id).totp_failures, 0, 'a right code resets the budget');

  h.advance(6 * 60_000);
  const stale = await agent.post('/v1/portal/users').set('X-CSRF-Token', csrf).send({ email: `n${++counter}@vendor.test`, password: 'New-Pass-12345', role: 'vendor_support' });
  assert.equal(stale.body.error.code, 'totp_stepup_required');
  const bad = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: '000000' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'totp_invalid');
  assert.equal((await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: 'abcdef' })).status, 422, 'zod rejects a non-numeric code');
  const good = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) });
  assert.equal(good.status, 200);
  assert.ok(good.body.data.totp_verified_at);
  const created = await agent.post('/v1/portal/users').set('X-CSRF-Token', csrf).send({ email: `n${++counter}@vendor.test`, password: 'New-Pass-12345', role: 'vendor_support' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.totp_enrol_required, false, 'support staff are not forced to enrol');
});

test('five wrong codes pause TOTP for the account (429) until the window lapses', async () => {
  await freshTotpStep();
  const admin = await createUser('vendor_admin');
  const first = await signIn(admin);
  const { secret } = await enrol(first.agent, first.csrf);
  const { agent, csrf } = await signIn(admin, authenticator.generate(secret));
  h.advance(6 * 60_000);
  for (let i = 0; i < 4; i++) assert.equal((await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: '000000' })).body.error.code, 'totp_invalid');
  const fifth = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: '000000' });
  assert.equal(fifth.body.error.code, 'totp_invalid');
  const locked = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) });
  assert.equal(locked.status, 429, JSON.stringify(locked.body));
  assert.equal(locked.body.error.code, 'totp_rate_limited');
  const loginLocked = await signIn(admin, authenticator.generate(secret));
  assert.equal(loginLocked.res.status, 429, 'the budget is per account: a new login attempt is paused as well');
  assert.equal((await agent.post('/v1/portal/2fa/disable').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) })).status, 429, 'disabling 2FA shares the budget');
  h.advance(15 * 60_000 + 1000);
  const again = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(h.db.prepare('SELECT totp_failures, totp_locked_until FROM portal_users WHERE id = ?').get(admin.id), { totp_failures: 0, totp_locked_until: null });
});

test('reseller admins are forced too, reseller staff and vendor support are not', async () => {
  await freshTotpStep();
  const rsAdmin = await createUser('reseller_admin', { reseller: true });
  const forced = await signIn(rsAdmin);
  assert.equal(forced.res.status, 200, JSON.stringify(forced.res.body));
  assert.equal(forced.res.body.data.totp_enrol_required, true);
  const refused = await forced.agent.get('/v1/reseller/licenses');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'totp_enrol_required');
  await enrol(forced.agent, forced.csrf);
  assert.equal((await forced.agent.get('/v1/reseller/licenses')).status, 200);

  const staff = await createUser('reseller_staff', { reseller: true });
  const s = await signIn(staff);
  assert.equal(s.res.body.data.totp_enrol_required, false);
  assert.equal((await s.agent.get('/v1/reseller/licenses')).status, 200);

  const support = await createUser('vendor_support');
  const sp = await signIn(support);
  assert.equal(sp.res.body.data.totp_enrol_required, false);
  assert.equal((await sp.agent.get('/v1/admin/licenses')).status, 200);
});

test('the vendor setting switches the rule off and on, live for open sessions, through a stepped-up admin', async () => {
  await freshTotpStep();
  const owner = await createUser('vendor_admin');
  const first = await signIn(owner);
  const { secret } = await enrol(first.agent, first.csrf);
  const { agent, csrf } = await signIn(owner, authenticator.generate(secret));
  assert.equal((await agent.patch('/v1/portal/settings').set('X-CSRF-Token', csrf).send({ require_totp_for_admins: 'no' })).status, 422);
  assert.equal((await agent.patch('/v1/portal/settings').set('X-CSRF-Token', csrf).send({ require_totp_for_admins: false, other: 1 })).status, 422);
  const off = await agent.patch('/v1/portal/settings').set('X-CSRF-Token', csrf).send({ require_totp_for_admins: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.data.require_totp_for_admins, false);
  assert.equal(h.db.prepare("SELECT updated_by FROM vendor_settings WHERE key = 'hub.require_totp_for_admins'").get().updated_by, `portal:${owner.id}`);
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'portal.settings_update' AND principal = ?").get(`portal:${owner.id}`));

  const other = await createUser('vendor_admin');
  const relaxed = await signIn(other);
  assert.equal(relaxed.res.body.data.totp_enrol_required, false);
  assert.equal((await relaxed.agent.get('/v1/admin/licenses')).status, 200);

  // Back on: the open session of the admin without an authenticator is blocked at once.
  h.advance(6 * 60_000);
  assert.equal((await agent.patch('/v1/portal/settings').set('X-CSRF-Token', csrf).send({ require_totp_for_admins: true })).body.error.code, 'totp_stepup_required');
  await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) });
  assert.equal((await agent.patch('/v1/portal/settings').set('X-CSRF-Token', csrf).send({ require_totp_for_admins: true })).body.data.require_totp_for_admins, true);
  const blocked = await relaxed.agent.get('/v1/admin/licenses');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'totp_enrol_required');
  assert.equal((await relaxed.agent.get('/v1/portal/me')).body.data.totp_enrol_required, true);
  // The enrolled owner is never affected.
  assert.equal((await agent.get('/v1/admin/licenses')).status, 200);
  // API keys are a second factor of their owner and keep working.
  assert.equal((await h.admin('get', '/v1/admin/licenses')).status, 200);
});

test('the enrolment QR encoder produces a stable, well-formed symbol for an otpauth URI', () => {
  const uri = 'otpauth://totp/WHM%20Hub:admin%40vendor.test?secret=JBSWY3DPEHPK3PXP&issuer=WHM%20Hub';
  const q = encodeQr(uri);
  assert.deepEqual({ version: q.version, size: q.size, mask: q.mask, ecl: q.ecl }, { version: 6, size: 41, mask: 2, ecl: 'M' });
  assert.equal(q.size, q.version * 4 + 17);
  const rows = q.modules.map((r) => r.map((m) => (m ? '1' : '0')).join(''));
  assert.equal(rows.length, q.size);
  assert.ok(rows.every((r) => r.length === q.size));
  assert.equal(crypto.createHash('sha256').update(rows.join('\n')).digest('hex'), 'b44db3c6c6093a32704551a8d0df845baca5aa714aec21b2f41408daca7e1199', 'golden symbol (verified with an independent decoder)');
  // Finder patterns in three corners, timing row/column alternating between them.
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (let y = 0; y < 7; y++) {
    assert.equal(rows[y].slice(0, 7), finder[y]);
    assert.equal(rows[y].slice(q.size - 7), finder[y]);
    assert.equal(rows[q.size - 7 + y].slice(0, 7), finder[y]);
  }
  for (let i = 8; i < q.size - 8; i++) assert.equal(rows[6][i], i % 2 === 0 ? '1' : '0');
  const small = encodeQr('a', { ecl: 'L', boostEcl: false });
  assert.deepEqual({ version: small.version, size: small.size, ecl: small.ecl }, { version: 1, size: 21, ecl: 'L' });
  assert.throws(() => encodeQr('x'.repeat(3000)), /too long/);
  const path = qrSvgPath(small.modules, 4);
  assert.match(path, /^M4 4h1v1h-1z/);
  assert.equal((path.match(/M/g) || []).length, small.modules.flat().filter(Boolean).length);
});
