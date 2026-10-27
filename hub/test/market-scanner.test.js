import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootMarket, buildPackage, manifestFor } from './market-support.js';
import { skeleton, damerauLevenshtein, scanSource, fileTypeAllowed } from '../marketplace/lib/scanner-rules.js';

let h; let dev; let n = 0;
before(async () => {
  h = await bootMarket();
  dev = await h.developer({ namespaces: ['test.scan'] });
});
after(() => h.close());

async function scan({ files = {}, permissions = [], justifications, name, manifest = {} } = {}) {
  const id = `test.scan.p${++n}`;
  assert.equal((await h.createListing(dev, id, { name: name || `Scan ${n}` })).status, 201);
  const res = await dev.upload(id, buildPackage({ manifest: manifestFor(id, { permissions, name: name || `Scan ${n}`, ...manifest }), signWith: dev.pem, files }), { justifications: justifications ?? Object.fromEntries(permissions.map((p) => [p, `This scope is required because the plugin uses it for ${p}`])) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}
const rejects = (v) => v.scan_report.rejects.map((r) => r.rule);
const flags = (v) => v.scan_report.flags.map((r) => r.rule);

test('a fixture per reject rule', async () => {
  const cases = [
    ['child_process', "const cp = require('child_process');", 'require_outside_allowlist'],
    ['node:fs', "const fs = require('node:fs');", 'require_outside_allowlist'],
    ['dynamic require', 'const x = require(name);', 'dynamic_require'],
    ['eval', "eval('1');", 'forbidden_identifier'],
    ['new Function', "const f = new Function('return 1');", 'function_constructor'],
    ['Function(', "const f = Function('return 1');", 'function_constructor'],
    ['constructor.constructor', 'const F = ({}).constructor.constructor;', 'constructor_chain'],
    ["x['constructor']['constructor']", "const F = x['constructor']['constructor'];", 'computed_constructor'],
    ['template constructor', 'const F = x[`constructor`];', 'computed_constructor'],
    ['Reflect.get', "Reflect.get(a, 'b');", 'forbidden_identifier'],
    ['process', 'process.exit(1);', 'forbidden_identifier'],
    ['globalThis', 'globalThis.x = 1;', 'forbidden_identifier'],
    ['WebAssembly', 'WebAssembly.instantiate(b);', 'forbidden_identifier'],
    ['import()', "import('x');", 'dynamic_import'],
    ['unicode escape identifier', 'const \\u0065val = 1;', 'identifier_escape'],
    ['escaped property', 'a.\\u0063onstructor;', 'identifier_escape'],
    ['secret literal', "const k = 'AKIAABCDEFGHIJKLMNOP';", 'secret'],
    ['private key', '-----BEGIN PRIVATE KEY-----\\nabc', 'secret'],
    ['password literal', "const password = 'hunter2hunter';", 'secret'],
  ];
  for (const [label, src, rule] of cases) {
    const v = await scan({ files: { 'main.js': `${src}\nmodule.exports = { activate() {} };\n` } });
    assert.equal(v.status, 'scan_failed', label);
    assert.ok(rejects(v).includes(rule), `${label}: ${JSON.stringify(v.scan_report.rejects)}`);
  }
  // a .cjs / .json entry point
  const cjs = await scan({ files: { 'main.cjs': 'module.exports = {};' }, manifest: { main: 'main.cjs' } });
  assert.ok(rejects(cjs).includes('entry_point') || rejects(cjs).includes('manifest'), JSON.stringify(cjs.scan_report.rejects));
  // file types
  const types = await scan({ files: { 'bin/tool': '#!/bin/sh', 'x.mjs': 'export const a = 1;', 'lib.so': 'x', 'w.wasm': 'x' } });
  assert.deepEqual(types.scan_report.rejects.filter((r) => r.rule === 'file_type').map((r) => r.file).sort(), ['bin/tool', 'lib.so', 'w.wasm', 'x.mjs']);
  // missing or short permission justification
  const just = await scan({ permissions: ['accounts:read'], justifications: { 'accounts:read': 'short' } });
  assert.ok(rejects(just).includes('permission_justification'));
  // minified bundle over 1 MiB without a source map
  const big = 'var a=1;'.repeat(140_000);
  const min = await scan({ files: { 'bundle.js': big } });
  assert.ok(rejects(min).includes('minified_bundle'));
  const mapped = await scan({ files: { 'bundle.js': big, 'bundle.js.map': '{}' } });
  assert.ok(!rejects(mapped).includes('minified_bundle'));
});

test('flag rules: undeclared fetch host and undeclared agent op; declared ones are clean; high-risk marking', async () => {
  const undeclared = await scan({ files: { 'main.js': "module.exports = { async activate(ctx) { await ctx.net.fetch('https://api.example.net/x'); await ctx.agent.op('web.wp.update', {}); } };\n" } });
  assert.equal(undeclared.status, 'in_review');
  assert.deepEqual([...new Set(flags(undeclared))].sort(), ['undeclared_agent_op', 'undeclared_fetch']);
  assert.equal(undeclared.risk, 'normal');
  const declared = await scan({ permissions: ['net:outbound:api.example.net', 'agent:op:web.wp.update'], files: { 'main.js': "module.exports = { async activate(ctx) { await ctx.net.fetch('https://api.example.net/x'); await ctx.agent.op('web.wp.update', {}); } };\n" } });
  assert.equal(declared.status, 'in_review');
  assert.deepEqual(flags(declared), []);
  assert.equal(declared.risk, 'high');
  assert.equal(scanSource("fetch('https://a.b/')", { scopes: [], matchesNetScope: () => false }).length, 2);
  assert.equal(fileTypeAllowed('LICENSE'), true);
  assert.equal(fileTypeAllowed('README.md'), true);
  assert.equal(fileTypeAllowed('run'), false);
});

test('typosquat on skeleton forms: Greek Alpha, WP-Toolkit, a draft of another developer; exact listed match rejects', async () => {
  assert.equal(skeleton('ImunifyΑV'), 'imunifyav');
  assert.equal(skeleton('WP-Toolkit'), 'wptoolkit');
  assert.equal(skeleton('Sаmple Nоtes'), 'samplenotes');
  assert.equal(damerauLevenshtein('wptoolkit', 'wptoolkti'), 1);
  const greek = await scan({ name: 'ImunifyΑV' });
  assert.equal(greek.status, 'scan_failed');
  assert.ok(greek.scan_report.rejects.some((r) => r.rule === 'typosquat' && /brand imunify|bundled/.test(r.detail)), JSON.stringify(greek.scan_report.rejects));
  const wp = await scan({ name: 'WP Toolkitt' });
  assert.ok(flags(wp).includes('typosquat') || rejects(wp).includes('typosquat'), JSON.stringify(wp.scan_report));
  // a draft listing of another developer with a similar name → flag
  const otherDev = await h.developer({ namespaces: ['test.draft'] });
  assert.equal((await h.createListing(otherDev, 'test.draft.cache-boost', { name: 'Cache Boost' })).status, 201);
  const near = await scan({ name: 'Cache Boosts' });
  assert.equal(near.status, 'in_review');
  assert.ok(near.scan_report.flags.some((f) => f.rule === 'typosquat' && /test\.draft\.cache-boost/.test(f.detail)));
});

test('AV hook: a failing command rejects, a passing one does not, missing config skips', async () => {
  const bad = await bootMarket({ config: { marketplace: { scan: { av_command: ['/bin/false'] } } } });
  try {
    const d = await bad.developer({ namespaces: ['test.av'] });
    assert.equal((await bad.createListing(d, 'test.av.p')).status, 201);
    const v = (await d.upload('test.av.p', buildPackage({ manifest: manifestFor('test.av.p'), signWith: d.pem }), { justifications: {} })).body.data;
    assert.equal(v.status, 'scan_failed');
    assert.ok(rejects(v).includes('av'));
    assert.equal(v.scan_report.av.ran, true);
  } finally { await bad.close(); }
  const good = await bootMarket({ config: { marketplace: { scan: { av_command: ['/bin/true'] } } } });
  try {
    const d = await good.developer({ namespaces: ['test.av'] });
    assert.equal((await good.createListing(d, 'test.av.p')).status, 201);
    const v = (await d.upload('test.av.p', buildPackage({ manifest: manifestFor('test.av.p'), signWith: d.pem }), { justifications: {} })).body.data;
    assert.equal(v.status, 'in_review');
    assert.deepEqual(v.scan_report.av, { ran: true, infected: false });
  } finally { await good.close(); }
  const none = await scan({});
  assert.deepEqual(none.scan_report.av, { ran: false });
});
