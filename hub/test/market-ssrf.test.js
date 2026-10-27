import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bootMarket } from './market-support.js';
import { createSafeFetch } from '../shared/safe-fetch.js';

// A fake https.request that answers from `answers[host]` without a network.
function fakeRequest(answers) {
  return (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const a = answers[opts.servername] || { status: 404, body: '' };
      const res = new EventEmitter();
      res.statusCode = a.status;
      res.headers = a.headers || {};
      res.resume = () => {};
      res.destroy = () => {};
      process.nextTick(() => { cb(res); if (a.body) res.emit('data', Buffer.from(a.body)); res.emit('end'); });
    };
    return req;
  };
}

const hubs = [];
after(async () => { for (const h of hubs) await h.close(); });

async function evidenceHub({ lookup, answers = {}, own = () => ['203.0.113.50'] }) {
  const fetch = createSafeFetch({ lookup, request: fakeRequest(answers), own });
  fetch.safeResolveTxt = async () => [];
  const h = await bootMarket({ fetch });
  hubs.push(h);
  const dev = await h.developer({ key: null });
  assert.equal((await dev.post('/v1/dev/namespaces', { ns: 'net.acme' })).status, 201);
  const ev = await dev.post('/v1/dev/verification', { method: 'well_known', ns: 'net.acme' });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  return { h, dev, ev: ev.body.data, token: ev.body.data.instructions.content };
}

test('evidence domains resolving to loopback, private, link-local, ULA, ::1 or the hub itself are refused with evidence_target_refused', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', 'fc00::1', '::1', '203.0.113.50']) {
    const { h, dev, ev } = await evidenceHub({ lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    const res = await dev.post(`/v1/dev/verification/${ev.id}/recheck`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.result, 'failed', address);
    assert.equal(res.body.data.code, 'evidence_target_refused', address);
    assert.match(res.body.data.result_detail, /evidence_target_refused/);
    assert.ok(h.mdb.prepare("SELECT 1 FROM audit_log WHERE action = 'developer.verification.recheck' AND result = 'error:evidence_target_refused'").get());
  }
});

test('a rebinding resolver (public then private), a redirect, a non-443 port and a body over 4 KiB are refused; a clean answer passes', async () => {
  const rebinding = await evidenceHub({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.1.1.1', family: 4 }] });
  assert.equal((await rebinding.dev.post(`/v1/dev/verification/${rebinding.ev.id}/recheck`)).body.data.code, 'evidence_target_refused', 'any private answer poisons the lookup');
  const redirect = await evidenceHub({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], answers: { 'acme.net': { status: 302, headers: { location: 'https://10.0.0.5/x' } } } });
  const r = await redirect.dev.post(`/v1/dev/verification/${redirect.ev.id}/recheck`);
  assert.equal(r.body.data.code, 'evidence_target_refused');
  assert.match(r.body.data.result_detail, /redirect/);
  const big = await evidenceHub({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], answers: { 'acme.net': { status: 200, body: 'x'.repeat(5000) } } });
  const b = await big.dev.post(`/v1/dev/verification/${big.ev.id}/recheck`);
  assert.equal(b.body.data.code, 'evidence_target_refused');
  assert.match(b.body.data.result_detail, /body-too-large/);
  const fetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest({}), own: () => [] });
  await assert.rejects(fetch('https://acme.net:8443/.well-known/whm-developer.txt'), (e) => e.code === 'evidence_target_refused' && /port/.test(e.message));
  await assert.rejects(fetch('http://acme.net/.well-known/whm-developer.txt'), (e) => e.code === 'evidence_target_refused' && /scheme/.test(e.message));
  const clean = await evidenceHub({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  clean.h.ctx.safeFetch = Object.assign(createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest({ 'acme.net': { status: 200, body: `${clean.token}\n` } }), own: () => [] }), { safeResolveTxt: async () => [] });
  const ok = await clean.dev.post(`/v1/dev/verification/${clean.ev.id}/recheck`);
  assert.equal(ok.body.data.result, 'passed', JSON.stringify(ok.body));
});

test('recheck is limited to 5 per hour per developer (6th → 429) and 1 per minute per domain', async () => {
  const { h, dev, ev } = await evidenceHub({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  for (let i = 0; i < 5; i++) {
    h.advance(61_000);
    assert.equal((await dev.post(`/v1/dev/verification/${ev.id}/recheck`)).status, 200, `recheck ${i + 1}`);
  }
  h.advance(61_000);
  const sixth = await dev.post(`/v1/dev/verification/${ev.id}/recheck`);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error.code, 'rate_limited');
  h.advance(3600_000);
  assert.equal((await dev.post(`/v1/dev/verification/${ev.id}/recheck`)).status, 200, 'the hourly window moved');
  const quick = await dev.post(`/v1/dev/verification/${ev.id}/recheck`);
  assert.equal(quick.status, 429, 'same domain within a minute');
});

test('GitHub organisation method: OAuth callback through safe-fetch, admin membership passes, only com.github.<org> is provable', async () => {
  const answers = {
    'github.com': { status: 200, body: JSON.stringify({ access_token: 'gho_test' }) },
    'api.github.com': { status: 200, body: JSON.stringify({ login: 'octo', state: 'active', role: 'admin' }) },
  };
  const fetch = createSafeFetch({ lookup: async () => [{ address: '140.82.112.3', family: 4 }], request: fakeRequest(answers), own: () => [] });
  fetch.safeResolveTxt = async () => [];
  const h = await bootMarket({ fetch, config: { marketplace: { github_oauth: { client_id: 'cid', client_secret: 'sec' } } } });
  hubs.push(h);
  const dev = await h.developer({ key: null });
  assert.equal((await dev.post('/v1/dev/namespaces', { ns: 'com.github.acme' })).status, 201);
  const ev = await dev.post('/v1/dev/verification', { method: 'github_org', ns: 'com.github.acme', org: 'acme' });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  const start = await dev.get(`/v1/dev/verification/github/start?id=${ev.body.data.id}`);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const url = new URL(start.body.data.url);
  assert.equal(url.host, 'github.com');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  const state = url.searchParams.get('state');
  assert.equal((await dev.get(`/v1/dev/verification/github/callback?code=abc&state=${ev.body.data.id}.wrong`)).body.error.code, 'oauth_state_invalid');
  const cb = await dev.get(`/v1/dev/verification/github/callback?code=abc&state=${state}`);
  assert.equal(cb.status, 200, JSON.stringify(cb.body));
  assert.equal(cb.body.data.result, 'passed');
  assert.deepEqual(cb.body.data.evidence, { org: 'acme', login: 'octo' }, 'the access token never leaves the hub');
  // the method proves com.github.<org> only
  assert.equal((await dev.post('/v1/dev/namespaces', { ns: 'net.acme' })).status, 201);
  const wrong = await dev.post('/v1/dev/verification', { method: 'github_org', ns: 'net.acme', org: 'acme' });
  const st2 = new URL((await dev.get(`/v1/dev/verification/github/start?id=${wrong.body.data.id}`)).body.data.url).searchParams.get('state');
  const cb2 = await dev.get(`/v1/dev/verification/github/callback?code=abc&state=${st2}`);
  assert.equal(cb2.body.data.result, 'failed');
  assert.match(cb2.body.data.result_detail, /com\.github\.acme only/);
});
