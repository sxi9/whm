import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSafeFetch, classifyAddress, isForbiddenAddress } from '../shared/safe-fetch.js';

// A fake https.request: records options, answers with a scripted response.
function fakeRequest(script) {
  const calls = [];
  const request = (options, onResponse) => {
    calls.push(options);
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const r = script(options, calls.length);
      if (r instanceof Error) { setImmediate(() => req.emit('error', r)); return; }
      if (r === 'hang') return;
      const res = new EventEmitter();
      res.statusCode = r.status ?? 200;
      res.headers = r.headers || {};
      res.destroy = () => { res.destroyed = true; };
      res.resume = () => {};
      onResponse(res);
      setImmediate(() => {
        for (const chunk of r.chunks || [Buffer.from(r.body || '')]) { if (res.destroyed) return; res.emit('data', Buffer.from(chunk)); }
        res.emit('end');
      });
    };
    return req;
  };
  request.calls = calls;
  return request;
}

const lookupTable = (table) => async (host) => {
  const v = table[host];
  if (!v) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
  return (Array.isArray(v) ? v : [v]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('address classification', () => {
  const cases = { '127.0.0.1': 'loopback', '127.9.9.9': 'loopback', '10.0.0.1': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '172.32.0.1': 'public', '192.168.1.1': 'private', '100.64.0.1': 'private', '169.254.169.254': 'link-local', '224.0.0.1': 'multicast', '0.0.0.0': 'unspecified', '240.0.0.1': 'reserved', '8.8.8.8': 'public', '93.184.216.34': 'public', '::1': 'loopback', '::': 'unspecified', 'fc00::1': 'ula', 'fd12:3456::1': 'ula', 'fe80::1': 'link-local', 'ff02::1': 'multicast', '::ffff:10.0.0.1': 'private', '::ffff:8.8.8.8': 'public', '2001:db8::1': 'reserved', '2606:4700::1111': 'public', 'nope': 'invalid' };
  for (const [ip, cls] of Object.entries(cases)) assert.equal(classifyAddress(ip), cls, ip);
  assert.equal(isForbiddenAddress('8.8.8.8', { own: ['8.8.8.8'] }), 'own-address');
  assert.equal(isForbiddenAddress('8.8.8.8', { own: [] }), null);
});

test('refusal matrix: loopback, private, metadata, ULA, ::1, own address, redirect, port, body cap, rebinding resolver, scheme, credentials', async () => {
  const request = fakeRequest(() => ({ status: 200, body: 'whm-dev-verify=abc' }));
  const fetch = createSafeFetch({
    request,
    own: () => ['203.0.113.9'],
    lookup: lookupTable({
      'loop.example': '127.0.0.1', 'priv.example': '10.0.0.1', 'meta.example': '169.254.169.254', 'ula.example': 'fc00::1', 'six.example': '::1',
      'self.example': '203.0.113.9', 'mixed.example': ['93.184.216.34', '10.0.0.1'], 'ok.example': '93.184.216.34', 'v6ok.example': '2606:4700::1111',
    }),
  });
  const refused = async (url, opts, reason) => {
    await assert.rejects(fetch(url, opts), (e) => { assert.equal(e.code, 'evidence_target_refused', url); assert.equal(e.fields?.reason, reason, `${url}: ${e.message}`); return true; });
  };
  await refused('https://loop.example/.well-known/whm-developer.txt', {}, 'loopback');
  await refused('https://priv.example/x', {}, 'private');
  await refused('https://meta.example/latest/meta-data', {}, 'link-local');
  await refused('https://ula.example/x', {}, 'ula');
  await refused('https://six.example/x', {}, 'loopback');
  await refused('https://self.example/x', {}, 'own-address');
  await refused('https://mixed.example/x', {}, 'private', 'any private answer in the set refuses');
  await refused('https://127.0.0.1/x', {}, 'loopback');
  await refused('https://[::1]/x', {}, 'loopback');
  await refused('https://ok.example:8443/x', {}, 'port');
  await refused('http://ok.example/x', {}, 'scheme');
  await refused('https://user:pw@ok.example/x', {}, 'credentials-in-url');
  await refused('not a url', {}, 'invalid-url');
  await refused('https://missing.example/x', {}, 'dns-failure');
  assert.equal(request.calls.length, 0, 'nothing was connected');

  const res = await fetch('https://ok.example/.well-known/whm-developer.txt');
  assert.equal(res.status, 200);
  assert.equal(res.text(), 'whm-dev-verify=abc');
  const opts = request.calls.at(-1);
  assert.equal(opts.host, '93.184.216.34', 'connects to the resolved address');
  assert.equal(opts.servername, 'ok.example', 'with the original SNI');
  assert.equal(opts.headers.host, 'ok.example');
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.port, 443);
  assert.ok(!('cookie' in opts.headers) && !('authorization' in opts.headers));
  const v6 = await fetch('https://v6ok.example/x');
  assert.equal(v6.address, '2606:4700::1111');

  const redirecting = createSafeFetch({ request: fakeRequest(() => ({ status: 302, headers: { location: 'https://10.0.0.1/' } })), own: () => [], lookup: lookupTable({ 'ok.example': '93.184.216.34' }) });
  await assert.rejects(redirecting('https://ok.example/x'), (e) => e.fields.reason === 'redirect');
  const big = createSafeFetch({ request: fakeRequest(() => ({ status: 200, chunks: [Buffer.alloc(3000), Buffer.alloc(3000)] })), own: () => [], lookup: lookupTable({ 'ok.example': '93.184.216.34' }) });
  await assert.rejects(big('https://ok.example/x'), (e) => e.fields.reason === 'body-too-large');
  const okBig = await big('https://ok.example/x', { maxBytes: 10_000 });
  assert.equal(okBig.body.length, 6000);
  const hanging = createSafeFetch({ request: fakeRequest(() => 'hang'), own: () => [], lookup: lookupTable({ 'ok.example': '93.184.216.34' }) });
  await assert.rejects(hanging('https://ok.example/x', { timeoutMs: 20 }), (e) => e.fields.reason === 'timeout');
  const failing = createSafeFetch({ request: fakeRequest(() => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), own: () => [], lookup: lookupTable({ 'ok.example': '93.184.216.34' }) });
  await assert.rejects(failing('https://ok.example/x'), (e) => e.fields.reason === 'connect-error');

  // DNS rebinding: the resolver answers public first and private afterwards; the connection goes to the checked address and the name is never resolved again.
  let n = 0;
  const rebinding = fakeRequest(() => ({ status: 200, body: 'ok' }));
  const rb = createSafeFetch({ request: rebinding, own: () => [], lookup: async () => [{ address: n++ === 0 ? '93.184.216.34' : '10.0.0.1', family: 4 }] });
  await rb('https://rebind.example/x');
  assert.equal(rebinding.calls[0].host, '93.184.216.34');
  assert.equal(n, 1);
  const pinned = await new Promise((resolve) => rebinding.calls[0].lookup('rebind.example', {}, (_e, addr) => resolve(addr)));
  assert.equal(pinned, '93.184.216.34', 'the socket lookup is pinned to the checked address');
  await assert.rejects(rb('https://rebind.example/x'), (e) => e.fields.reason === 'private');
});

test('safeResolveTxt uses the injected resolver with a cap of 10 records and refuses bad names', async () => {
  const resolver = { resolveTxt: async (name) => (name === '_whm-dev.acme.net' ? Array.from({ length: 12 }, (_, i) => [`whm-dev-verify=`, String(i)]) : (() => { const e = new Error('x'); e.code = 'ENODATA'; throw e; })()) };
  const f = createSafeFetch({ resolver });
  const records = await f.safeResolveTxt('_whm-dev.acme.net');
  assert.equal(records.length, 10);
  assert.equal(records[0], 'whm-dev-verify=0');
  assert.deepEqual(await f.safeResolveTxt('_whm-dev.none.net'), []);
  await assert.rejects(f.safeResolveTxt('bad name!'), (e) => e.fields.reason === 'invalid-name');
  const slow = createSafeFetch({ resolver: { resolveTxt: () => new Promise(() => {}) } });
  await assert.rejects(slow.safeResolveTxt('acme.net', { timeoutMs: 20 }), (e) => e.fields.reason === 'dns-timeout');
});

test('the hub exposes safeFetch and the PSL on ctx', async () => {
  const { bootHub } = await import('./support.js');
  const h = await bootHub();
  try {
    assert.equal(typeof h.ctx.safeFetch, 'function');
    assert.equal(typeof h.ctx.safeFetch.safeResolveTxt, 'function');
    assert.equal(h.ctx.psl.registrableDomain('plugins.acme.net'), 'acme.net');
    assert.equal(h.ctx.psl.registrableDomain('acme.github.io'), 'acme.github.io');
    assert.equal(h.ctx.psl.isPublicSuffix('github.io'), true);
    assert.equal(h.ctx.psl.isPublicSuffix('co.uk'), true);
    assert.equal(h.ctx.psl.registrableDomain('co.uk'), null);
    assert.equal(h.ctx.psl.registrableDomain('com'), null);
    assert.equal(h.ctx.psl.registrableDomain('bücher.example'), 'xn--bcher-kva.example');
    assert.ok(h.ctx.psl.size > 5000);
  } finally {
    await h.close();
  }
});
