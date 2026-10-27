import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootMarket } from './market-support.js';
import * as ns from '../marketplace/lib/namespace.js';
import psl from '../shared/psl.js';

let h;
before(async () => { h = await bootMarket({ config: { marketplace: { reserved_namespaces: ['com.vendorbrand'] } } }); });
after(() => h.close());

test('normalisation, domain mapping, coverage and conflicts', () => {
  assert.equal(ns.normalize('Net.Acme'), 'net.acme');
  assert.equal(ns.normalize('net.bücher'), 'net.xn--bcher-kva');
  assert.equal(ns.domainOf('net.acme.plugins'), 'plugins.acme.net');
  assert.equal(ns.covers('net.acme', 'net.acme.cache-boost'), true);
  assert.equal(ns.covers('net.acme', 'net.acme-evil.x'), false);
  assert.throws(() => ns.normalize('acme'), (e) => e.code === 'invalid_namespace');
  assert.throws(() => ns.normalize('net.ac me'), (e) => e.code === 'invalid_namespace');
  assert.deepEqual(ns.conflicts('net.acme', ['net.acme.sub', 'net.other']), ['net.acme.sub']);
  assert.deepEqual(ns.conflicts('net.acme.sub', ['net.acme']), ['net.acme']);
  assert.deepEqual(ns.conflicts('net.acme-evil', ['net.acme']), []);
  assert.equal(ns.evidenceHostAllowed('net.acme', 'acme.net', psl), true);
  assert.equal(ns.evidenceHostAllowed('net.acme.plugins', 'plugins.acme.net', psl), true);
  assert.equal(ns.evidenceHostAllowed('net.acme.plugins', 'acme.net', psl), true);
  assert.equal(ns.evidenceHostAllowed('net.acme', 'other.net', psl), false);
  assert.equal(ns.evidenceHostAllowed('com.google', 'acme.net', psl), false);
  assert.equal(ns.isReserved('net.whm'), true);
  assert.equal(ns.isReserved('net.whm.sub'), true);
  assert.equal(ns.isReserved('com.cpanel'), true);
  assert.equal(ns.isReserved('net.whm.server-monitoring', { bundledIds: ['net.whm.server-monitoring'] }), true);
  assert.equal(ns.isReserved('net.acme'), false);
});

test('PSL rule: io.github, com, uk.co cannot be claimed; io.github.acme neither; net.acme can', async () => {
  const dev = await h.developer({ key: null });
  for (const bad of ['io.github', 'com', 'uk.co', 'io.github.acme']) {
    const res = await dev.post('/v1/dev/namespaces', { ns: bad });
    assert.ok([422].includes(res.status), `${bad}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(['namespace_reserved', 'invalid_namespace'].includes(res.body.error.code), `${bad} → ${res.body.error.code}`);
  }
  for (const reserved of ['net.whm', 'com.cpanel', 'net.whm.server-monitoring', 'net.whm.wp-toolkit.extra', 'com.vendorbrand']) {
    const res = await dev.post('/v1/dev/namespaces', { ns: reserved });
    assert.equal(res.body.error.code, 'namespace_reserved', reserved);
  }
  const ok = await dev.post('/v1/dev/namespaces', { ns: 'net.acme' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.domain, 'acme.net');
});

test('IDNA and homoglyph claims normalise and conflict; prefix/extension conflicts are 409 namespace_conflict', async () => {
  const a = await h.developer({ key: null });
  const b = await h.developer({ key: null });
  const idna = await a.post('/v1/dev/namespaces', { ns: 'net.bücher' });
  assert.equal(idna.status, 201);
  assert.equal(idna.body.data.ns, 'net.xn--bcher-kva');
  const homoglyph = await b.post('/v1/dev/namespaces', { ns: 'net.bücher' });
  assert.equal(homoglyph.status, 409);
  assert.equal(homoglyph.body.error.code, 'namespace_conflict');
  assert.equal((await a.post('/v1/dev/namespaces', { ns: 'net.acme2' })).status, 201);
  const same = await b.post('/v1/dev/namespaces', { ns: 'net.acme2' });
  assert.equal(same.body.error.code, 'namespace_conflict');
  const ext = await b.post('/v1/dev/namespaces', { ns: 'net.acme2.sub' });
  assert.equal(ext.body.error.code, 'namespace_conflict');
  assert.deepEqual(ext.body.error.conflicts, ['net.acme2']);
  assert.equal((await b.post('/v1/dev/namespaces', { ns: 'net.acme2-evil' })).status, 201, 'a different label is not a conflict');
  assert.ok(h.mdb.prepare("SELECT 1 FROM audit_log WHERE action = 'developer.namespace.conflict' AND target = 'net.acme2'").get(), 'conflict logged for the reviewer');
  // Admin reassign after a dispute moves the namespace.
  const re = await h.admin('post', `/v1/admin/market/developers/${b.id}/namespaces/net.acme2/reassign`).send({});
  assert.equal(re.status, 200);
  assert.equal(re.body.data.previous_developer_id, a.id);
  assert.deepEqual(h.m.developers.publicView(b.row()).namespaces.sort(), ['net.acme2', 'net.acme2-evil']);
  assert.equal(h.m.developers.publicView(a.row()).namespaces.includes('net.acme2'), false);
});

test('evidence per rule: TXT on the namespace domain passes, on other.net fails, com.google with evidence on acme.net fails', async () => {
  const txt = new Map();
  const fetchStub = Object.assign(async (url) => ({ status: 404, text: () => '' }), { safeResolveTxt: async (name) => txt.get(name) || [] });
  const hub = await bootMarket({ fetch: fetchStub });
  try {
    const dev = await hub.developer({ key: null });
    assert.equal((await dev.post('/v1/dev/namespaces', { ns: 'net.acme' })).status, 201);
    const ev = await dev.post('/v1/dev/verification', { method: 'dns_txt', ns: 'net.acme' });
    assert.equal(ev.status, 201);
    const token = ev.body.data.instructions.value;
    txt.set('_whm-dev.acme.net', [token]);
    const passed = await dev.post(`/v1/dev/verification/${ev.body.data.id}/recheck`);
    assert.equal(passed.status, 200, JSON.stringify(passed.body));
    assert.equal(passed.body.data.result, 'passed');
    // Evidence on another host fails even when the record exists there.
    const other = await dev.post('/v1/dev/verification', { method: 'dns_txt', ns: 'net.acme', domain: 'other.net' });
    txt.set('_whm-dev.other.net', [other.body.data.instructions.value]);
    hub.advance(61_000);
    const failed = await dev.post(`/v1/dev/verification/${other.body.data.id}/recheck`);
    assert.equal(failed.body.data.result, 'failed');
    assert.match(failed.body.data.result_detail, /evidence_host_not_allowed/);
    // com.google claimed with evidence on acme.net fails.
    assert.equal((await dev.post('/v1/dev/namespaces', { ns: 'com.google' })).status, 201);
    const g = await dev.post('/v1/dev/verification', { method: 'dns_txt', ns: 'com.google', domain: 'acme.net' });
    txt.set('_whm-dev.acme.net', [token, g.body.data.instructions.value]);
    hub.advance(61_000);
    const gres = await dev.post(`/v1/dev/verification/${g.body.data.id}/recheck`);
    assert.equal(gres.body.data.result, 'failed');
    // well-known on the registrable parent of a deeper namespace passes.
    assert.equal((await dev.post('/v1/dev/namespaces', { ns: 'net.acme.plugins' })).status, 201, 'extending your own namespace is allowed');
    const wk = await dev.post('/v1/dev/verification', { method: 'well_known', ns: 'net.acme.plugins', domain: 'acme.net' });
    const wkToken = wk.body.data.instructions.content;
    const stub2 = Object.assign(async (url) => (url === 'https://acme.net/.well-known/whm-developer.txt' ? { status: 200, text: () => `${wkToken}\n` } : { status: 404, text: () => '' }), { safeResolveTxt: fetchStub.safeResolveTxt });
    hub.ctx.safeFetch = stub2;
    hub.advance(61_000);
    const wkres = await dev.post(`/v1/dev/verification/${wk.body.data.id}/recheck`);
    assert.equal(wkres.body.data.result, 'passed', JSON.stringify(wkres.body));
    // Monthly re-check: a vanished record drops the developer back to pending.
    hub.m.developers.approve(dev.id, { by: 'test' });
    txt.set('_whm-dev.acme.net', []);
    hub.mdb.prepare('UPDATE developer_namespaces SET last_check_at = NULL').run();
    const monthly = await hub.m.verification.monthlyRecheck();
    assert.ok(monthly.failed >= 1);
    assert.equal(dev.row().status, 'pending');
  } finally {
    await hub.close();
  }
});
