'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMockHost } = require(path.join(__dirname, '..', '..', '..', 'sdk', 'mock-host'));
const manifest = require('../plugin.json');
const mod = require('../main');

const NOW = Date.UTC(2026, 0, 1);
const accounts = [{ username: 'alice', owner: 'root', domain: 'alice.test' }, { username: 'bob', owner: 'resell1', domain: 'bob.test' }];
const reseller = { id: 3, username: 'resell1', role: 'reseller' };
const INSPECT = (a) => ({ username: a.username, path: a.path, version: '6.5.2', siteUrl: 'https://alice.test', coreUpdates: [{ version: '6.6' }], plugins: [{ name: 'akismet', status: 'active', version: '5.3', update: 'available', update_version: '5.4' }], themes: [{ name: 'twentytwentyfour', status: 'active', version: '1.1', update: 'none' }], maintenance: false, admins: [{ user_login: 'admin' }], errors: {} });

function host(extra = {}) {
  const ops = {
    'web.wp.detect': { installed: true, version: '2.10.0' },
    'web.wp.discover': ({ usernames }) => ({ installs: usernames.flatMap((u) => (u === 'alice' ? [{ username: 'alice', home: '/home/alice', path: '/home/alice/public_html', relative: 'public_html', version: '6.5.2', dbName: 'alice_wp', tablePrefix: 'wp_' }, { username: 'alice', home: '/home/alice', path: '/home/alice/public_html/blog', relative: 'public_html/blog', version: '6.4.0', dbName: 'alice_blog', tablePrefix: 'b_' }] : u === 'bob' ? [{ username: 'bob', home: '/home/bob', path: '/home/bob/public_html', relative: 'public_html', version: '6.5.2', dbName: 'bob_wp', tablePrefix: 'wp_' }] : [])), missing: [] }),
    'web.wp.inspect': INSPECT,
    ...extra,
  };
  return createMockHost({ manifest, accounts, now: NOW, agentOps: ops });
}

test('discovery records sites per account and the cron follows the setting', async () => {
  const h = host();
  await h.load(mod);
  assert.equal(h.state.cron[0].expr, '0 */6 * * *');
  const r = await h.callRoute('POST', '/discover', { body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { accounts: 2, sites: 3, added: 3, updated: 0, removed: 0 });
  const again = await h.callRoute('POST', '/discover', { body: {} });
  assert.deepEqual(again.body.data, { accounts: 2, sites: 3, added: 0, updated: 3, removed: 0 });
  const status = await h.callRoute('GET', '/status');
  assert.equal(status.body.data.sites, 3);
  assert.equal(status.body.data.wpcli.version, '2.10.0');
  const sites = await h.callRoute('GET', '/sites');
  assert.equal(sites.body.data.length, 3);
  assert.equal(sites.body.data[0].pluginUpdates, null, 'not inspected yet');
  const bg = await h.callRoute('POST', '/discover', { body: { background: true } });
  assert.equal(bg.status, 202);
  await h.flush();
  assert.equal((await h.ctx.jobs.status(bg.body.data.jobId)).status, 'done');
});

test('resellers only see, discover and manage sites of the accounts they own', async () => {
  const h = host();
  await h.load(mod);
  const r = await h.callRoute('POST', '/discover', { body: {}, user: reseller });
  assert.equal(r.body.data.sites, 1);
  const sites = await h.callRoute('GET', '/sites', { user: reseller });
  assert.equal(sites.body.data.length, 1);
  assert.equal(sites.body.data[0].username, 'bob');
  await h.callRoute('POST', '/discover', { body: {} });
  const all = await h.callRoute('GET', '/sites');
  const alice = all.body.data.find((s) => s.username === 'alice');
  const denied = await h.callRoute('GET', `/sites/${alice.id}`, { user: reseller });
  assert.equal(denied.status, 403);
  const user = await h.callRoute('GET', '/sites', { user: { id: 9, username: 'u', role: 'user' } });
  assert.equal(user.status, 403);
});

test('site detail inspects through WP-CLI once and caches it; updates run as a job and are audited', async () => {
  let inspections = 0;
  const updates = [];
  const h = host({ 'web.wp.inspect': (a) => { inspections++; return INSPECT(a); }, 'web.wp.update': (a) => { updates.push(a); return { output: 'Success: Updated 1 of 1 plugins.', databaseUpdated: null }; } });
  await h.load(mod);
  await h.callRoute('POST', '/discover', { body: {} });
  const [site] = (await h.callRoute('GET', '/sites')).body.data;
  const d = await h.callRoute('GET', `/sites/${site.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.data.coreUpdate, '6.6');
  assert.equal(d.body.data.pluginUpdates, 1);
  await h.callRoute('GET', `/sites/${site.id}`);
  assert.equal(inspections, 1, 'the second read is served from the cache');
  await h.callRoute('GET', `/sites/${site.id}`, { query: { fresh: '1' } });
  assert.equal(inspections, 2);
  const bad = await h.callRoute('POST', `/sites/${site.id}/update`, { body: { kind: 'plugin', name: '../x' } });
  assert.equal(bad.status, 400);
  const r = await h.callRoute('POST', `/sites/${site.id}/update`, { body: { kind: 'plugin', name: 'akismet' } });
  assert.equal(r.status, 202);
  await h.flush();
  const job = await h.ctx.jobs.status(r.body.data.jobId);
  assert.equal(job.status, 'done');
  assert.deepEqual(updates, [{ username: 'alice', path: '/home/alice/public_html', kind: 'plugin', name: 'akismet', all: false }]);
  assert.ok(h.state.audit.some((a) => a.action === 'plugin:net.whm.wp-toolkit:update'));
  const unknown = await h.callRoute('GET', '/sites/nope');
  assert.equal(unknown.status, 404);
});

test('maintenance mode and hardening go through the web.wp ops with audit rows', async () => {
  const calls = [];
  const h = host({
    'web.wp.maintenance': (a) => { calls.push(['maintenance', a]); return { enabled: a.enabled }; },
    'web.wp.harden': { checks: [{ id: 'config-perms', ok: false }, { id: 'debug-off', ok: true }], score: 1, total: 2 },
    'web.wp.hardenfix': (a) => { calls.push(['fix', a]); return { applied: a.fixes, failed: {} }; },
  });
  await h.load(mod);
  await h.callRoute('POST', '/discover', { body: {} });
  const [site] = (await h.callRoute('GET', '/sites')).body.data;
  const m = await h.callRoute('POST', `/sites/${site.id}/maintenance`, { body: { enabled: true } });
  assert.deepEqual(m.body.data, { enabled: true });
  const checks = await h.callRoute('GET', `/sites/${site.id}/harden`);
  assert.equal(checks.body.data.score, 1);
  const none = await h.callRoute('POST', `/sites/${site.id}/harden`, { body: { fixes: ['rm-rf'] } });
  assert.equal(none.status, 400);
  const fix = await h.callRoute('POST', `/sites/${site.id}/harden`, { body: { fixes: ['config-perms', 'bogus'] } });
  assert.deepEqual(fix.body.data.applied, ['config-perms']);
  assert.deepEqual(calls[1][1].fixes, ['config-perms']);
  assert.equal(h.state.audit.filter((a) => /maintenance|harden/.test(a.action)).length, 2);
  const del = await h.callRoute('DELETE', `/sites/${site.id}`);
  assert.deepEqual(del.body.data, { removed: true });
});

test('a missing WP-CLI surfaces as a 501 on site actions while status still answers', async () => {
  const h = host({ 'web.wp.detect': () => { throw new h.ctx.errors.PluginError('WP-CLI (wp) is not installed', { code: 'CAPABILITY_MISSING', status: 501 }); }, 'web.wp.inspect': () => { throw new h.ctx.errors.PluginError('WP-CLI (wp) is not installed', { code: 'CAPABILITY_MISSING', status: 501 }); } });
  await h.load(mod);
  const s = await h.callRoute('GET', '/status');
  assert.equal(s.status, 200);
  assert.match(s.body.data.errors.wpcli, /not installed/);
  assert.ok(s.body.data.install.steps[0].includes('wp-cli.phar'));
  await h.callRoute('POST', '/discover', { body: {} });
  const [site] = (await h.callRoute('GET', '/sites')).body.data;
  const d = await h.callRoute('GET', `/sites/${site.id}`);
  assert.equal(d.status, 501);
  assert.equal(d.body.error.code, 'CAPABILITY_MISSING');
});
