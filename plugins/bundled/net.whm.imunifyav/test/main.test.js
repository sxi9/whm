'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMockHost, PluginError } = require(path.join(__dirname, '..', '..', '..', 'sdk', 'mock-host'));
const manifest = require('../plugin.json');
const mod = require('../main');

const NOW = Date.UTC(2026, 0, 1);
const accounts = [{ username: 'alice', owner: 'root' }, { username: 'bob', owner: 'resell1' }];
const missing = () => { throw new PluginError('clamscan is not installed', { code: 'BINARY_NOT_FOUND', status: 501 }); };

function host(agentOps, opts = {}) {
  return createMockHost({ manifest, accounts, now: NOW, agentOps, ...opts });
}

test('status reports both scanners, picks ImunifyAV when installed and ships install instructions otherwise', async () => {
  const none = host({ 'sec.imunify.detect': { installed: false, version: null }, 'sec.clamav.detect': { installed: false } });
  await none.load(mod);
  const r = await none.callRoute('GET', '/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.scanner, null);
  assert.ok(r.body.data.install.steps.some((s) => /imav-deploy\.sh/.test(s)));
  const im = host({ 'sec.imunify.detect': { installed: true, version: '7.5.1' }, 'sec.clamav.detect': { installed: true, version: '1.0.5' }, 'sec.imunify.status': { ok: true, status: 'stopped' } });
  await im.load(mod);
  const s = await im.callRoute('GET', '/status');
  assert.equal(s.body.data.scanner, 'imunifyav');
  assert.equal(s.body.data.imunifyStatus.status, 'stopped');
});

test('POST /scan starts an ImunifyAV on-demand scan when the CLI exists', async () => {
  const calls = [];
  const h = host({ 'sec.imunify.detect': { installed: true, version: '7' }, 'sec.clamav.detect': { installed: false }, 'sec.imunify.scan': (a) => { calls.push(a); return { started: true, path: a.path }; } });
  await h.load(mod);
  const r = await h.callRoute('POST', '/scan', { body: { path: '/home/alice' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.data.scanner, 'imunifyav');
  assert.deepEqual(calls, [{ path: '/home/alice' }]);
  assert.equal(h.state.audit[0].action, 'plugin:net.whm.imunifyav:scan.imunify');
});

test('without ImunifyAV, POST /scan queues the ClamAV job which records findings, notifies and audits', async () => {
  const scanned = [];
  const h = host({
    'sec.imunify.detect': { installed: false }, 'sec.clamav.detect': { installed: true, version: '1.0.5', databaseAgeSec: 100 },
    'sec.clamav.scan': ({ usernames }) => { scanned.push(usernames[0]); return usernames[0] === 'bob' ? { infected: [{ file: '/home/bob/public_html/x.php', signature: 'Php.Malware.Agent-1' }], errors: [] } : { infected: [], errors: [{ file: '/home/alice/locked', error: 'Permission denied' }] }; },
  });
  await h.load(mod);
  const r = await h.callRoute('POST', '/scan', { body: {} });
  assert.equal(r.status, 202);
  assert.equal(r.body.data.scanner, 'clamav');
  await h.flush();
  const job = await h.ctx.jobs.status(r.body.data.jobId);
  assert.equal(job.status, 'done');
  assert.deepEqual(scanned, ['alice', 'bob']);
  assert.equal(job.result.infected, 1);
  assert.equal(job.result.errors, 1);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].severity, 'critical');
  const findings = await h.callRoute('GET', '/findings');
  assert.equal(findings.body.data.length, 1);
  assert.equal(findings.body.data[0].username, 'bob');
  const results = await h.callRoute('GET', '/results');
  assert.equal(results.body.data.scanner, 'clamav');
  assert.equal(results.body.data.items[0].signature, 'Php.Malware.Agent-1');
  const scans = await h.callRoute('GET', '/scans');
  assert.equal(scans.body.data[0].status, 'done');
  assert.ok(h.state.audit.some((a) => a.action === 'plugin:net.whm.imunifyav:scan.clamav'));
  const q = await h.callRoute('GET', '/quarantine');
  assert.deepEqual(q.body.data.items, []);
  const cleared = await h.callRoute('DELETE', '/findings');
  assert.equal(cleared.body.data.removed, 1);
});

test('no scanner at all answers 501 CAPABILITY_MISSING with the vendor instructions', async () => {
  const h = host({ 'sec.imunify.detect': { installed: false }, 'sec.clamav.detect': { installed: false } });
  await h.load(mod);
  const r = await h.callRoute('POST', '/scan', { body: {} });
  assert.equal(r.status, 501);
  assert.equal(r.body.error.code, 'CAPABILITY_MISSING');
  assert.ok(r.body.error.details.install.steps.length > 0);
  const job = await h.runJob('clamscan', { force: true });
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'CAPABILITY_MISSING');
});

test('the scheduled ClamAV job is skipped while ImunifyAV is installed and is bound to the cron setting', async () => {
  const h = host({ 'sec.imunify.detect': { installed: true, version: '7' }, 'sec.clamav.detect': { installed: true } });
  await h.load(mod);
  assert.equal(h.state.cron[0].expr, '0 3 * * 0');
  const job = await h.runJob('clamscan', {});
  assert.deepEqual(job.result, { skipped: true, reason: 'imunifyav-installed' });
  await h.ctx.settings.set('scanCron', '30 1 * * *');
  assert.equal(h.state.cron[0].expr, '30 1 * * *');
  const user = await h.callRoute('GET', '/status', { user: { id: 3, username: 'resell1', role: 'reseller' } });
  assert.equal(user.status, 403, 'scanner control is root only');
});

test('ImunifyAV results are listed with the account derived from the path', async () => {
  const h = host({ 'sec.imunify.detect': { installed: true }, 'sec.clamav.detect': { installed: false }, 'sec.imunify.results': { total: 1, items: [{ id: '1', file: '/home/alice/public_html/bad.php', signature: 'SMW-INJ-1', status: 'found', user: null, quarantined: false }] }, 'sec.imunify.quarantine': { items: [{ id: '2', file: '/home/bob/q.php', quarantined: true }] } });
  await h.load(mod);
  const r = await h.callRoute('GET', '/results', { query: { limit: '5' } });
  assert.equal(r.body.data.items[0].username, 'alice');
  const q = await h.callRoute('GET', '/quarantine');
  assert.equal(q.body.data.items.length, 1);
  assert.equal(mod.__test.ownerOf('/home2/carol/x'), 'carol');
  assert.equal(mod.__test.ownerOf('/var/www/x'), null);
});
